import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InvocationControl } from "../../plugins/execution/src/control.js";
import type { CrashCut } from "../../plugins/execution/src/outbox.js";
import type {
  AttemptRecord,
  InvocationRequest,
  ObjectRef,
  ReservationRecord,
} from "../../specs/fractal-harness/contracts.js";
import { startRemote } from "../fixtures/remote.js";
import { createWriterRig } from "../fixtures/writer/rig.js";

test("AT-012 root control fences descendant dispatch in both cancel commit orders", async (t) => {
  for (const order of ["cancel-first", "dispatch-first"])
    await t.test(order, async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "frness-control-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const remote = await startRemote(join(directory, "remote.sqlite"));
      caseTest.after(() => remote.close());
      let onCut: (point: CrashCut) => Promise<void> = async () => {};
      const rig = await createWriterRig(
        directory,
        remote.endpoint,
        { strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null },
        { commandCount: 2, onCut: (point) => onCut(point) },
      );
      caseTest.after(() => rig.close());
      const control: InvocationControl = rig.outbox.control;
      const request: InvocationRequest = {
        targetInstanceId: "root",
        assemblyRevision: "v1",
        operation: { contract: rig.ref("Run"), operation: "run" },
        input: { text: "hello", mode: "success" },
        idempotencyKey: "root",
      };
      const root = await rig.runtime.submit(request);
      await rig.runtime.step(root.invocation, "input");
      const child = await rig.runtime.startChild(root.invocation, "input", "child");
      await rig.runtime.step(child.invocation, "input");
      const intents = await rig.outbox.intents();
      assert.equal(intents.length, 2);
      let release: (() => void) | undefined;
      let arrived: (() => void) | undefined;
      const marker = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      onCut = async (point) => {
        if (point === "after_dispatch_commit_before_transport") {
          arrived!();
          await gate;
        }
      };
      let first: Promise<void> | undefined;
      if (order === "dispatch-first") {
        first = rig.outbox.dispatch(intents[0]!);
        await marker;
      }
      await control.apply(root.invocation, "cancel", "cancel-root");
      const before = await rig.runtime.snapshot(root.invocation);
      assert.equal(before.phase, "cancelled");
      assert.equal(before.unresolvedEffectIds.length, order === "dispatch-first" ? 1 : 0);
      release!();
      if (first) await first;
      await rig.outbox.pump(rig.runtime);
      assert.equal((await rig.runtime.snapshot(root.invocation)).phase, "cancelled");
      assert.equal((await rig.runtime.snapshot(child.invocation)).phase, "cancelled");
      assert.deepEqual((await rig.runtime.snapshot(root.invocation)).unresolvedEffectIds, []);
      assert.deepEqual(await remote.counts(), {
        calls: order === "dispatch-first" ? 1 : 0,
        changes: order === "dispatch-first" ? 1 : 0,
      });
      for (const ref of intents) {
        const intent = (await rig.store.read(rig.context, ref)).value as unknown as {
          attempt: ObjectRef;
          reservation: ObjectRef;
        };
        const attempt = (await rig.store.read(rig.context, intent.attempt))
          .value as unknown as AttemptRecord;
        assert.ok(["completed", "failed_known"].includes(attempt.state));
        assert.equal(
          (
            (await rig.store.read(rig.context, intent.reservation))
              .value as unknown as ReservationRecord
          ).actualUnits,
          0,
        );
      }
      await control.apply(root.invocation, "resume", "resume-terminal");
      assert.equal((await rig.runtime.snapshot(root.invocation)).phase, "cancelled");
      assert.deepEqual(await remote.counts(), {
        calls: order === "dispatch-first" ? 1 : 0,
        changes: order === "dispatch-first" ? 1 : 0,
      });
    });
});

test("AT-012 pause stores late receipts and resumes pinned work; input validates before consuming wait", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-pause-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = await startRemote(join(directory, "remote.sqlite"));
  t.after(() => remote.close());
  let pauseAfterMarker: (() => Promise<void>) | undefined;
  const rig = await createWriterRig(
    directory,
    remote.endpoint,
    {
      strategy: "non-retryable",
      maxAttempts: 1,
      idempotencyValidUntil: null,
    },
    {
      onCut: async (point) => {
        if (point === "after_dispatch_commit_before_transport") await pauseAfterMarker?.();
      },
    },
  );
  t.after(() => rig.close());
  const request: InvocationRequest = {
    targetInstanceId: "parent",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("Run"), operation: "run" },
    input: { text: "hello", mode: "success" },
    idempotencyKey: "paused",
  };
  const receipt = await rig.runtime.submit(request);
  pauseAfterMarker = async () => {
    await rig.outbox.control.apply(receipt.invocation, "pause", "pause-after-marker");
  };
  await rig.runtime.step(receipt.invocation, "input");
  await rig.outbox.control.apply(receipt.invocation, "pause", "pause-1");
  await rig.outbox.pump(rig.runtime);
  assert.deepEqual(await remote.counts(), { calls: 0, changes: 0 });
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).control, "paused");
  await rig.outbox.control.apply(receipt.invocation, "resume", "resume-1");
  await rig.outbox.pump(rig.runtime);
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).control, "paused");
  assert.equal((await rig.runtime.inbox(receipt.invocation, "effect:write")).consumed, false);
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
  const beforeStatus = await rig.store.read(rig.context, receipt.invocation);
  await rig.runtime.snapshot(receipt.invocation);
  assert.deepEqual(await rig.store.read(rig.context, receipt.invocation), beforeStatus);
  pauseAfterMarker = undefined;
  await rig.outbox.control.apply(receipt.invocation, "resume", "resume-2");
  await rig.outbox.pump(rig.runtime);
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
  const inputDirectory = await mkdtemp(join(tmpdir(), "frness-input-"));
  t.after(() => rm(inputDirectory, { recursive: true, force: true }));
  const inputRig = await createWriterRig(
    inputDirectory,
    remote.endpoint,
    { strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null },
    { awaitInput: true },
  );
  t.after(() => inputRig.close());
  const waiting = await inputRig.runtime.submit({
    ...request,
    operation: { contract: inputRig.ref("Run"), operation: "run" },
  });
  await inputRig.runtime.step(waiting.invocation, "input");
  assert.equal((await inputRig.runtime.snapshot(waiting.invocation)).waitingReason, "input");
  await assert.rejects(
    inputRig.runtime.provideInput(waiting.invocation, "answer", 42, "answer-key"),
  );
  assert.equal((await inputRig.runtime.snapshot(waiting.invocation)).waitingReason, "input");
  const accepted = await inputRig.runtime.provideInput(
    waiting.invocation,
    "answer",
    "accepted",
    "answer-key",
  );
  assert.deepEqual(
    await inputRig.runtime.provideInput(waiting.invocation, "answer", "accepted", "answer-key"),
    accepted,
  );
  await assert.rejects(
    inputRig.runtime.provideInput(waiting.invocation, "answer", "changed", "answer-key"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await inputRig.runtime.step(waiting.invocation, "input:answer");
  assert.equal((await inputRig.runtime.snapshot(waiting.invocation)).phase, "succeeded");
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
});
