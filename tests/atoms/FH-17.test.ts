import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acceptCandidate,
  makeCandidate,
  verificationFeedback,
} from "../../plugins/agent/src/verification.js";
import { createAgentRig } from "../support/agent-rig.js";

test("AT-017 configured verifier policy cannot omit or replace the actual acceptance binding", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-agent-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await createAgentRig(directory, 100, "Action");
  t.after(() => rig.close());
  await assert.rejects(rig.run("normal", "agent"), { code: "REDUCER_EXECUTION_FAILED" });
  assert.deepEqual(await rig.counts(), { actions: 0, checks: 0 });
});

test("AT-017 durable agent tool candidate reject fix accept uses matching verifier evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await createAgentRig(directory, 100);
  t.after(() => rig.close());
  const receipt = await rig.run("normal", "agent");
  const result = await rig.runtime.snapshot(receipt.invocation);
  assert.equal(result.phase, "succeeded");
  const accepted = result.result as unknown as {
    candidate: { value: number; digest: string };
    verifications: { candidateDigest: string; verdict: string }[];
  };
  assert.equal(accepted.candidate.value, 42);
  assert.equal(accepted.verifications.length, 1);
  assert.equal(accepted.verifications[0]!.candidateDigest, accepted.candidate.digest);
  assert.equal(accepted.verifications[0]!.verdict, "accept");
  assert.deepEqual(await rig.counts(), { actions: 1, checks: 2 });
  assert.deepEqual((await rig.state(receipt.invocation)).task.constraints, [
    "keep this constraint",
    "and its order",
  ]);
  assert.equal((await rig.state(receipt.invocation)).candidate.value, 42);
  const nested = await rig.run("nested", "tool");
  const wrapped = await rig.runtime.snapshot(nested.invocation);
  assert.equal(wrapped.phase, "succeeded");
  assert.equal((wrapped.result as { ok: boolean }).ok, true);
  assert.equal(
    (wrapped.result as unknown as { value: { candidate: { value: number } } }).value.candidate
      .value,
    42,
  );
  assert.deepEqual(await rig.counts(), { actions: 2, checks: 4 });
});

test("AT-017 a verifier response for another digest never accepts a candidate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-agent-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await createAgentRig(directory, 30);
  t.after(() => rig.close());
  const receipt = await rig.run("mismatch", "agent");
  const snapshot = await rig.runtime.snapshot(receipt.invocation);
  assert.equal(snapshot.phase, "failed");
  assert.equal(snapshot.result, null);
  assert.equal(snapshot.error?.code, "BUDGET_EXCEEDED");
  assert.equal((await rig.counts()).actions, 1);
  assert.equal((await rig.state(receipt.invocation)).candidate.value, 42);
  assert.ok(
    (await rig.state(receipt.invocation)).feedback.includes(
      "Verification refers to another candidate digest",
    ),
  );
});

test("AT-017 user input resumes context while preserving the original goal and constraints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-agent-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await createAgentRig(directory, 100);
  t.after(() => rig.close());
  const receipt = await rig.run("input", "agent");
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).waitingReason, "input");
  const state = await rig.state(receipt.invocation);
  await assert.rejects(
    rig.runtime.provideInput(receipt.invocation, state.pending, { text: "" }, "invalid"),
  );
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).waitingReason, "input");
  await rig.runtime.provideInput(
    receipt.invocation,
    state.pending,
    { text: "extra context" },
    "reply",
  );
  assert.deepEqual(await rig.run("input", "agent"), receipt);
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
  const after = await rig.state(receipt.invocation);
  assert.equal(after.task.goal, "input");
  assert.deepEqual(after.task.constraints, state.task.constraints);
  assert.ok(after.feedback.some((value) => value.includes("extra context")));
});

test("AT-017 common step budget stops repeated decisions and retains task and progress", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-agent-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await createAgentRig(directory, 15);
  t.after(() => rig.close());
  const receipt = await rig.run("repeat", "agent");
  const snapshot = await rig.runtime.snapshot(receipt.invocation);
  assert.equal(snapshot.phase, "failed");
  assert.equal(snapshot.error?.code, "BUDGET_EXCEEDED");
  assert.deepEqual(await rig.counts(), { actions: 1, checks: 0 });
  assert.equal((await rig.state(receipt.invocation)).task.goal, "repeat");
  const before = await rig.counts();
  await rig.runtime.snapshot(receipt.invocation);
  await rig.backend.idle();
  assert.deepEqual(await rig.counts(), before);
});

test("AT-017 accepted results require complete evidence for the exact immutable candidate", () => {
  const type = {
    packageId: "test.agent",
    packageVersion: "1.0.0",
    digest: "sha256:fixture",
    name: "Answer",
  };
  const verifier = { ...type, name: "Verifier" };
  const candidate = makeCandidate(42, type, []);
  const evidence = {
    candidateDigest: candidate.digest,
    verifier,
    verdict: "accept" as const,
    feedback: [],
    evidence: [],
  };
  assert.equal(acceptCandidate(candidate, [evidence], [verifier]).candidate.value, 42);
  assert.throws(() => acceptCandidate({ ...candidate, value: 43 }, [evidence], [verifier]), {
    code: "VERIFICATION_REQUIRED",
  });
  for (const actual of [
    [],
    [evidence, evidence],
    [{ ...evidence, candidateDigest: "wrong" }],
    [{ ...evidence, verifier: { ...verifier, digest: "sha256:other" } }],
    [{ ...evidence, verdict: "inconclusive" as const }],
    [{ ...evidence, verdict: "reject" as const, feedback: ["wrong"] }],
  ]) {
    assert.ok(verificationFeedback(candidate, actual, [verifier]).length);
    assert.throws(() => acceptCandidate(candidate, actual, [verifier]), {
      code: "VERIFICATION_REQUIRED",
    });
  }
});
