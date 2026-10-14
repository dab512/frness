import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const modulePath = process.env.FRACTAL_SUT_MODULE;
if (!modulePath) {
  throw new Error("IMPLEMENTATION_MISSING: set FRACTAL_SUT_MODULE to packages/acceptance-adapter/dist/index.js. These tests must not be skipped.");
}
const { createAcceptanceHarness } = await import(pathToFileURL(resolve(modulePath)).href);
assert.equal(typeof createAcceptanceHarness, "function");

async function rig(t) {
  const directory = await mkdtemp(join(tmpdir(), "fractal-acceptance-"));
  const harness = await createAcceptanceHarness({ directory, bootstrap: "standard" });
  t.after(async () => {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  });
  return harness;
}
function value(outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.value;
}
function error(outcome, code) {
  assert.equal(outcome.ok, false, JSON.stringify(outcome));
  assert.equal(outcome.error.code, code);
}
function batch(key, writes, readSet = []) {
  return { commitKey: key, writes, readSet, events: [] };
}

test("META-001 missing bootstrap fails before initialization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fractal-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    createAcceptanceHarness({ directory, bootstrap: "missing" }),
    (failure) => failure.code === "BOOTSTRAP_PACKAGE_MISSING",
  );
});

test("META-002 local references resolve after hashing", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("documents");
  const ref = f.definitions.Document;
  assert.match(ref.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ref.packageVersion, "1.0.0");
  assert.equal("local" in ref, false);
  const again = await h.fixture("documents");
  assert.deepEqual(again.definitions.Document, ref);
});

test("META-003 similar shape does not satisfy a different contract", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("composite");
  const assembly = structuredClone(f.assembly);
  assembly.instances[1].implementation = f.definitions.IncompatibleChild;
  error(await h.validateAssembly(assembly), "CONTRACT_MISMATCH");
});

test("META-004 one child cannot have two owners", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("composite");
  const assembly = structuredClone(f.assembly);
  assembly.bindings.push({ parentInstanceId: assembly.rootInstanceId, slot: "other", childInstanceId: assembly.instances[1].instanceId });
  error(await h.validateAssembly(assembly), "MULTIPLE_OWNERS");
});

test("META-005 an unknown slot fails before code runs", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("composite");
  const assembly = structuredClone(f.assembly);
  assembly.bindings[0].slot = "not-declared";
  error(await h.validateAssembly(assembly), "UNKNOWN_SLOT");
  assert.deepEqual(await h.effectCounts(), { calls: 0, changes: 0 });
});

test("STORE-001 concurrent CAS accepts exactly one writer", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("documents");
  const initial = await h.read(f.object);
  const results = await Promise.all([1, 2].map((count) => h.commit(batch(`cas-${count}`, [
    { kind: "replace", object: f.object, expectedRevision: initial.revision, value: { count } },
  ]))));
  assert.equal(results.filter((x) => x.ok).length, 1);
  error(results.find((x) => !x.ok), "REVISION_CONFLICT");
  const current = await h.read(f.object);
  assert.notEqual(current.revision, initial.revision);
  assert.ok([1, 2].includes(current.value.count));
  assert.deepEqual((await h.read(f.object, initial.revision)).value, { count: 0 });
});

test("STORE-002 a failed CAS rolls back the whole batch", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("documents");
  const initial = await h.read(f.object);
  const second = { ...f.object, objectId: "document-second" };
  error(await h.commit(batch("atomic-failure", [
    { kind: "create", object: second, value: { count: 1 } },
    { kind: "replace", object: f.object, expectedRevision: "stale", value: { count: 9 } },
  ])), "REVISION_CONFLICT");
  assert.equal((await h.read(f.object)).revision, initial.revision);
  await assert.rejects(h.read(second), (failure) => failure.code === "NOT_FOUND");
});

test("STORE-003 an idempotent commit is checked before CAS", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("documents");
  const initial = await h.read(f.object);
  const request = batch("stable-key", [{ kind: "replace", object: f.object, expectedRevision: initial.revision, value: { count: 1 } }]);
  const first = value(await h.commit(request));
  assert.deepEqual(value(await h.commit(request)), first);
  const changed = structuredClone(request);
  changed.writes[0].value.count = 2;
  error(await h.commit(changed), "IDEMPOTENCY_CONFLICT");
  assert.deepEqual((await h.read(f.object)).value, { count: 1 });
});

test("STORE-004 schema validation never silently strips fields", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("documents");
  const initial = await h.read(f.object);
  error(await h.commit(batch("invalid-shape", [{ kind: "replace", object: f.object, expectedRevision: initial.revision, value: { count: 1, extra: true } }])), "INVALID_INPUT");
  assert.equal((await h.read(f.object)).revision, initial.revision);
});

test("RT-002 RT-003 ingress duplicate reuses Invocation, changed body conflicts", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("writer");
  const first = value(await h.invoke(f.request));
  assert.deepEqual(value(await h.invoke(f.request)), first);
  error(await h.invoke({ ...f.request, input: { text: "different" } }), "IDEMPOTENCY_CONFLICT");
  await h.pump();
  assert.deepEqual(await h.effectCounts(), { calls: 1, changes: 1 });
});

test("RT-006 unknown write is not retried after restart", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("writer");
  await h.crashAt("after_remote_accept_before_receipt");
  const receipt = value(await h.invoke(f.request));
  await h.pump();
  await h.recover();
  await h.pump();
  const state = await h.snapshot(receipt.invocation);
  assert.equal(state.phase, "waiting");
  assert.equal(state.waitingReason, "indeterminate");
  assert.equal(state.unresolvedEffectIds.length, 1);
  assert.deepEqual(await h.effectCounts(), { calls: 1, changes: 1 });
});

test("RT-008 stored receipt is consumed without another transport call", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("writer");
  await h.crashAt("after_receipt_commit_before_reduce");
  const receipt = value(await h.invoke(f.request));
  await h.pump();
  await h.recover();
  await h.pump();
  assert.equal((await h.snapshot(receipt.invocation)).phase, "succeeded");
  assert.deepEqual(await h.effectCounts(), { calls: 1, changes: 1 });
});

test("RT-011 concurrent children cannot oversubscribe the root budget", async (t) => {
  const h = await rig(t);
  await h.fixture("budget-tree");
  const result = await h.runBudgetRace({ limit: 100, reservations: [60, 60] });
  assert.equal(result.admitted, 1);
  assert.deepEqual(result.rejectedCodes, ["BUDGET_EXCEEDED"]);
  assert.deepEqual(result.root, { reserved: 60, spent: 0, limit: 100 });
});

test("RT-017 replay performs no external calls and no production writes", async (t) => {
  const h = await rig(t);
  const f = await h.fixture("writer");
  const receipt = value(await h.invoke(f.request));
  await h.pump();
  const before = await h.snapshot(receipt.invocation);
  const replay = await h.replay(receipt.invocation);
  assert.deepEqual(replay.result, before.result);
  assert.equal(replay.externalCalls, 0);
  assert.equal(replay.productionWrites, 0);
  assert.deepEqual(await h.snapshot(receipt.invocation), before);
  assert.deepEqual(await h.effectCounts(), { calls: 1, changes: 1 });
});
