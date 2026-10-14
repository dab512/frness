import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  AttemptRecord,
  EffectDefinition,
  EffectOutcome,
  InvocationRequest,
  ObjectRef,
  ReservationRecord,
} from "../../specs/fractal-harness/contracts.js";
import { startRemote } from "../fixtures/remote.js";
import { createWriterRig } from "../fixtures/writer/rig.js";

test("AT-010 scoped invocation keys and pinned native retry windows preserve original identity", async (t) => {
  for (const elapsed of [10, 60, 61])
    await t.test(`native window at ${elapsed}s`, async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "frness-retry-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const remote = await startRemote(join(directory, "remote.sqlite"));
      caseTest.after(() => remote.close());
      const rig = await createWriterRig(directory, remote.endpoint, {
        strategy: "idempotency-key",
        maxAttempts: 2,
        idempotencyValidUntil: "2026-01-01T00:01:00.000Z",
      });
      caseTest.after(() => rig.close());
      const request: InvocationRequest = {
        targetInstanceId: "parent",
        assemblyRevision: "v1",
        operation: { contract: rig.ref("Run"), operation: "run" },
        input: { text: "hello", mode: "lost-reply" },
        idempotencyKey: "same-key",
      };
      const receipt = await rig.runtime.submit(request);
      assert.deepEqual(await rig.runtime.submit(request), receipt);
      const code = (expected: string) => (error: unknown) =>
        error instanceof Error && "code" in error && error.code === expected;
      await assert.rejects(
        rig.runtime.submit({ ...request, input: { text: "changed", mode: "lost-reply" } }),
        code("IDEMPOTENCY_CONFLICT"),
      );
      rig.assemblies.set("v2", rig.linker.validate({ ...rig.assembly, revision: "v2" }));
      await assert.rejects(
        rig.runtime.submit({ ...request, assemblyRevision: "v2" }),
        code("IDEMPOTENCY_CONFLICT"),
      );
      assert.deepEqual(await rig.runtime.submit(request), receipt);
      const other = await rig.runtime.submit({ ...request, targetInstanceId: "root" });
      assert.notDeepEqual(other, receipt);
      for (const key of ["", "x".repeat(129), "ключ"])
        await assert.rejects(
          rig.runtime.submit({ ...request, idempotencyKey: key }),
          code("INVALID_INPUT"),
        );
      await rig.runtime.step(receipt.invocation, "input");
      await rig.outbox.pump(rig.runtime);
      const originalRef = (await rig.outbox.intents())[0]!;
      assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
      const original = (await rig.store.read(rig.context, originalRef)).value as unknown as {
        effect: ObjectRef;
        attempt: ObjectRef;
        reservation: ObjectRef;
      };
      const effect = (await rig.store.read(rig.context, original.effect))
        .value as unknown as EffectDefinition;
      const recordedTime =
        elapsed === 10
          ? "2026-01-01T00:00:10.000Z"
          : elapsed === 60
            ? "2026-01-01T00:01:00.000Z"
            : "2026-01-01T00:01:01.000Z";
      const retryRef = await rig.outbox.retry(originalRef, recordedTime);
      if (elapsed >= 60) {
        assert.equal(retryRef, undefined);
        assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
        return;
      }
      assert.ok(retryRef);
      await rig.outbox.pump(rig.runtime);
      const retried = (await rig.store.read(rig.context, retryRef)).value as unknown as {
        effect: ObjectRef;
        attempt: ObjectRef;
        reservation: ObjectRef;
      };
      assert.deepEqual(retried.effect, original.effect);
      const attempt = (await rig.store.read(rig.context, retried.attempt))
        .value as unknown as AttemptRecord;
      const originalAttempt = (await rig.store.read(rig.context, original.attempt))
        .value as unknown as AttemptRecord;
      assert.notEqual(attempt.attemptId, originalAttempt.attemptId);
      assert.equal(originalAttempt.state, "unknown");
      assert.deepEqual((await rig.store.read(rig.context, original.effect)).value, effect);
      assert.equal(
        (
          (await rig.store.read(rig.context, original.reservation))
            .value as unknown as ReservationRecord
        ).status,
        "reserved",
      );
      assert.deepEqual(await remote.counts(), { calls: 2, changes: 1 });
      assert.equal((await rig.runtime.snapshot(receipt.invocation)).waitingReason, "indeterminate");
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
      assert.equal(proof.attemptId, originalAttempt.attemptId);
      await rig.outbox.complete(originalRef, {
        kind: "completed",
        value: proof.value,
        actualUnits: proof.actualUnits,
        evidence: { ...proof },
      });
      await rig.outbox.pump(rig.runtime);
      assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
      assert.deepEqual((await rig.runtime.snapshot(receipt.invocation)).unresolvedEffectIds, []);
      assert.deepEqual(await remote.counts(), { calls: 2, changes: 1 });
      assert.equal(await rig.outbox.retry(originalRef, "2026-01-01T00:00:11Z"), undefined);
    });
});
