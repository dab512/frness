import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetLedger } from "../../plugins/execution/src/budget.js";
import type {
  AttemptRecord,
  BudgetSpec,
  EffectOutcome,
  InvocationRequest,
  ObjectRef,
  ReservationRecord,
} from "../../specs/fractal-harness/contracts.js";
import { startRemote } from "../fixtures/remote.js";
import { createWriterRig } from "../fixtures/writer/rig.js";

test("AT-011 a retry allocates a second reservation and never releases unknown usage implicitly", async (t) => {
  for (const limit of [100, 200])
    await t.test(`limit ${limit}`, async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "frness-budget-retry-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const remote = await startRemote(join(directory, "remote.sqlite"), { actualUnits: 40 });
      caseTest.after(() => remote.close());
      const rig = await createWriterRig(
        directory,
        remote.endpoint,
        {
          strategy: "idempotency-key",
          maxAttempts: 2,
          idempotencyValidUntil: "2026-01-01T00:01:00Z",
        },
        {
          maxUnits: 60,
          budget: {
            unit: "test-credit",
            limit,
            maxSteps: 10,
            maxDepth: 3,
            maxConcurrentEffects: 2,
          },
        },
      );
      caseTest.after(() => rig.close());
      const request: InvocationRequest = {
        targetInstanceId: "parent",
        assemblyRevision: "v1",
        operation: { contract: rig.ref("Run"), operation: "run" },
        input: { text: "hello", mode: "lost-reply" },
        idempotencyKey: "unknown",
      };
      const receipt = await rig.runtime.submit(request);
      await rig.runtime.step(receipt.invocation, "input");
      await rig.outbox.pump(rig.runtime);
      const originalRef = (await rig.outbox.intents())[0]!;
      assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 60, spent: 0, limit });
      if (limit === 100) {
        await assert.rejects(
          rig.outbox.retry(originalRef, "2026-01-01T00:00:10Z"),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "BUDGET_EXCEEDED",
        );
        assert.equal((await rig.outbox.intents()).length, 1);
        assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
        return;
      }
      const retryRef = await rig.outbox.retry(originalRef, "2026-01-01T00:00:10Z");
      assert.ok(retryRef);
      assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 120, spent: 0, limit });
      await rig.outbox.pump(rig.runtime);
      assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 60, spent: 40, limit });
      assert.equal((await rig.runtime.snapshot(receipt.invocation)).waitingReason, "indeterminate");
      const retryIntent = (await rig.store.read(rig.context, retryRef)).value as unknown as {
        attempt: ObjectRef;
      };
      const attempt = (await rig.store.read(rig.context, retryIntent.attempt))
        .value as unknown as AttemptRecord;
      assert.ok(attempt.result);
      const outcome = (
        (await rig.store.read(rig.context, attempt.result.object, attempt.result.revision))
          .value as unknown as { outcome: EffectOutcome }
      ).outcome;
      const proof = (
        outcome.evidence as unknown as {
          originalReceipt: {
            attemptId: string;
            value: { externalId: string };
            actualUnits: number;
          };
        }
      ).originalReceipt;
      await rig.outbox.complete(originalRef, {
        kind: "completed",
        value: proof.value,
        actualUnits: proof.actualUnits,
        evidence: { ...proof },
      });
      await rig.outbox.pump(rig.runtime);
      assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 0, spent: 80, limit });
      assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
      assert.deepEqual(await remote.counts(), { calls: 2, changes: 1 });
    });
});

test("AT-011 actual dispatch holds its reservation and commits authoritative settlement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-budget-live-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = await startRemote(join(directory, "remote.sqlite"), { actualUnits: 40 });
  t.after(() => remote.close());
  const rig = await createWriterRig(
    directory,
    remote.endpoint,
    { strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null },
    {
      maxUnits: 60,
      budget: {
        unit: "test-credit",
        limit: 100,
        maxSteps: 10,
        maxDepth: 3,
        maxConcurrentEffects: 1,
      },
    },
  );
  t.after(() => rig.close());
  const request: InvocationRequest = {
    targetInstanceId: "parent",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("Run"), operation: "run" },
    input: { text: "hello", mode: "hold" },
    idempotencyKey: "held",
  };
  const receipt = await rig.runtime.submit(request);
  await rig.runtime.step(receipt.invocation, "input");
  const rejected = await rig.runtime.submit({ ...request, idempotencyKey: "exceeds-root" });
  await rig.runtime.step(rejected.invocation, "input");
  assert.equal((await rig.runtime.snapshot(rejected.invocation)).error?.code, "BUDGET_EXCEEDED");
  const accepted = once(remote.child, "message");
  const dispatched = rig.outbox.dispatch((await rig.outbox.intents())[0]!);
  const [message] = await accepted;
  assert.equal(message.point, "remote_accepted");
  assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 60, spent: 0, limit: 100 });
  remote.child.send("release");
  await dispatched;
  await rig.outbox.pump(rig.runtime);
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
  assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 0, spent: 40, limit: 100 });
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
});

test("AT-011 invalid numeric usage preserves external evidence and blocks the whole budget scope", async (t) => {
  for (const actualUnits of [61, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    await t.test(String(actualUnits), async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "frness-invalid-usage-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const remote = await startRemote(join(directory, "remote.sqlite"), { actualUnits });
      caseTest.after(() => remote.close());
      const rig = await createWriterRig(
        directory,
        remote.endpoint,
        { strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null },
        {
          maxUnits: 60,
          budget: {
            unit: "test-credit",
            limit: 100,
            maxSteps: 10,
            maxDepth: 3,
            maxConcurrentEffects: 1,
          },
        },
      );
      caseTest.after(() => rig.close());
      const request: InvocationRequest = {
        targetInstanceId: "parent",
        assemblyRevision: "v1",
        operation: { contract: rig.ref("Run"), operation: "run" },
        input: { text: "hello", mode: "success" },
        idempotencyKey: "bad-usage",
      };
      const receipt = await rig.runtime.submit(request);
      await rig.runtime.step(receipt.invocation, "input");
      await assert.rejects(
        rig.outbox.pump(rig.runtime),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "INVALID_USAGE",
      );
      assert.deepEqual(await rig.ledger!.snapshot("root"), { reserved: 60, spent: 0, limit: 100 });
      assert.equal((await rig.runtime.snapshot(receipt.invocation)).error?.code, "INVALID_USAGE");
      const next = await rig.runtime.submit({ ...request, idempotencyKey: "blocked-next" });
      await rig.runtime.step(next.invocation, "input");
      assert.equal((await rig.runtime.snapshot(next.invocation)).error?.code, "INVALID_USAGE");
      assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
    });
});

test("AT-011 ancestor budgets charge each physical attempt once and retain unknown reservations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await createWriterRig(directory, "http://127.0.0.1:1", {
    strategy: "non-retryable",
    maxAttempts: 1,
    idempotencyValidUntil: null,
  });
  t.after(() => rig.close());
  const ledger = new BudgetLedger({
    store: rig.store,
    context: rig.context,
    storeId: "local",
    namespaceId: "runtime",
    types: (name) => rig.ref(name, "std.execution"),
  });
  const spec: BudgetSpec = {
    unit: "test-credit",
    limit: 100,
    maxSteps: 10,
    maxDepth: 3,
    maxConcurrentEffects: 1,
  };
  await ledger.create("root", null, spec);
  await ledger.create("middle", "root", spec);
  await ledger.create("left", "middle", spec);
  await ledger.create("right", "root", spec);
  const allocate = (budgetId: string, id: string, maxUnits: number) =>
    ledger.reserve(
      budgetId,
      {
        attemptId: id,
        effectId: id,
        runnerEpoch: "epoch",
        state: "prepared",
        reservationId: `reservation-${id}`,
        result: null,
      },
      maxUnits,
    );
  const race = await Promise.allSettled([
    allocate("left", "one", 60),
    allocate("right", "two", 60),
  ]);
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = race.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.equal(rejected.reason.code, "BUDGET_EXCEEDED");
  const admitted = race.find((result) => result.status === "fulfilled");
  assert.ok(admitted?.status === "fulfilled");
  const reservation = admitted.value;
  assert.deepEqual(await ledger.snapshot("root"), { reserved: 60, spent: 0, limit: 100 });
  const recorded = (await rig.store.read(rig.context, reservation))
    .value as unknown as ReservationRecord;
  for (const ancestor of recorded.ancestorBudgetIds)
    assert.deepEqual(await ledger.snapshot(ancestor), { reserved: 60, spent: 0, limit: 100 });
  await ledger.settle(reservation, null, { outcome: "unknown" });
  assert.equal((await ledger.snapshot("root")).reserved, 60);
  await assert.rejects(
    allocate("left", "retry-too-large", 60),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "BUDGET_EXCEEDED",
  );
  await ledger.settle(reservation, 40, { receipt: "authoritative" });
  assert.deepEqual(await ledger.snapshot("root"), { reserved: 0, spent: 40, limit: 100 });
  await ledger.settle(reservation, 40, { receipt: "duplicate" });
  const next = await allocate("left", "retry", 60);
  for (const id of ["root", "middle", "left"])
    assert.equal((await ledger.snapshot(id)).reserved, 60);
  assert.deepEqual(await ledger.snapshot("root"), { reserved: 60, spent: 40, limit: 100 });
  await assert.rejects(
    ledger.settle(next, 61, { rawUnits: 61 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_USAGE",
  );
  assert.equal(
    ((await rig.store.read(rig.context, next)).value as unknown as ReservationRecord).status,
    "reserved",
  );
  await assert.rejects(
    allocate("left", "blocked", 0),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_USAGE",
  );
  await assert.rejects(ledger.create("mismatch", "root", { ...spec, unit: "model-call" }));
  await ledger.create("concurrency", null, { ...spec, limit: 1000 });
  const first = await allocate("concurrency", "physical-a", 0);
  const second = await allocate("concurrency", "physical-b", 0);
  const dispatch = async (ref: typeof first) => {
    const guard = await ledger.dispatchGuard(ref);
    const reservation = (await rig.store.read(rig.context, ref))
      .value as unknown as ReservationRecord;
    const record = await rig.store.read(rig.context, ledger.attemptRef(reservation.attemptId));
    const attempt = record.value as unknown as AttemptRecord;
    await rig.store.commit(rig.context, {
      commitKey: `dispatch/${attempt.attemptId}`,
      readSet: guard,
      events: [],
      writes: [
        {
          kind: "replace",
          object: record.object,
          expectedRevision: record.revision,
          value: { ...attempt, state: "dispatched", result: null },
        },
      ],
    });
  };
  await dispatch(first);
  await assert.rejects(
    dispatch(second),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "BUDGET_EXCEEDED",
  );
  for (let step = 0; step < 10; step++) await ledger.step("concurrency", `step-${step}`, 0);
  await assert.rejects(
    ledger.step("concurrency", "step-10", 0),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "BUDGET_EXCEEDED",
  );
  await ledger.step("concurrency", "step-0", 0);
  await assert.rejects(ledger.step("concurrency", "too-deep", 4));
});
