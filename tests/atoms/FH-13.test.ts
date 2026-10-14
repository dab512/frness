import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReplayService } from "../../plugins/execution/src/replay.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type {
  ExecutionContext,
  InvocationRequest,
  ReducerModule,
  TypeRef,
} from "../../specs/fractal-harness/contracts.js";
import { startRemote } from "../fixtures/remote.js";
import { createWriterRig } from "../fixtures/writer/rig.js";

test("AT-013 replay validates a pinned trace in scratch SQLite without live calls or writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = await startRemote(join(directory, "remote.sqlite"));
  t.after(() => remote.close());
  const rig = await createWriterRig(directory, remote.endpoint, {
    strategy: "non-retryable",
    maxAttempts: 1,
    idempotencyValidUntil: null,
  });
  t.after(() => rig.close());
  const request: InvocationRequest = {
    targetInstanceId: "parent",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("Run"), operation: "run" },
    input: { text: "hello", mode: "success" },
    idempotencyKey: "replay",
  };
  const receipt = await rig.runtime.submit(request);
  await rig.runtime.step(receipt.invocation, "input");
  await rig.outbox.pump(rig.runtime);
  const snapshot = await rig.runtime.snapshot(receipt.invocation);
  const module = (await import(new URL("../fixtures/writer/server.mjs", import.meta.url).href)) as {
    parent: ReducerModule;
  };
  const options = {
    read: rig.store.read.bind(rig.store),
    context: rig.context,
    types: (name: string) => rig.ref(name, "std.execution"),
    registry: rig.registry,
    reducer: () => module.parent,
    createScratch: async (path: string, type: TypeRef) => {
      const store = new SqliteObjectStore({
        path,
        storeId: "scratch",
        validate: (type, value) => rig.registry.validate(type, value),
      });
      store.registerNamespace("replay", "replay", "scratch");
      const context: ExecutionContext = {
        principalId: "replay",
        scopeId: "scratch",
        ownerInstanceId: "replay",
        assemblyRevision: "v1",
        grants: [],
      };
      return {
        store,
        context,
        frame: { storeId: "scratch", namespaceId: "replay", objectId: "frame", type },
        dispose: () => store.close(),
      };
    },
  };
  const before = await readFile(join(directory, "host.sqlite-wal"));
  const replay = await new ReplayService(options).run(
    receipt.invocation,
    join(directory, "scratch.sqlite"),
  );
  assert.deepEqual(replay.result, snapshot.result);
  assert.equal(replay.externalCalls, 0);
  assert.equal(replay.productionWrites, 0);
  assert.equal(replay.transitions, 2);
  assert.deepEqual(await readFile(join(directory, "host.sqlite-wal")), before);
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
  const diverged = new ReplayService({
    ...options,
    reducer: () => ({
      initialize: module.parent.initialize,
      reduce: (state, event, config) => {
        const next = module.parent.reduce(state, event, config);
        return {
          ...next,
          commands: next.commands.map((command) =>
            command.kind === "effect"
              ? { ...command, input: { text: "different", mode: "success" } }
              : command,
          ),
        };
      },
    }),
  });
  await assert.rejects(
    diverged.run(receipt.invocation, join(directory, "divergence.sqlite")),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "REPLAY_DIVERGENCE",
  );
  assert.deepEqual(await readFile(join(directory, "host.sqlite-wal")), before);
  const missing = new ReplayService({
    ...options,
    reducer: () => {
      throw Object.assign(new Error("Pinned artifact removed"), {
        code: "PINNED_DEPENDENCY_MISSING",
      });
    },
  });
  await assert.rejects(
    missing.run(receipt.invocation, join(directory, "missing.sqlite")),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "PINNED_DEPENDENCY_MISSING",
  );
  const waiting = await rig.runtime.submit({ ...request, idempotencyKey: "resume" });
  await rig.runtime.controls.apply(waiting.invocation, "pause", "pause");
  const resumed = await rig.runtime.resume(waiting.invocation, "resume");
  assert.equal(resumed.ref.objectId, waiting.invocation.objectId);
  assert.equal(resumed.control, "running");
  rig.assemblies.delete("v1");
  await assert.rejects(
    rig.runtime.resume(waiting.invocation, "missing-pinned"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "PINNED_DEPENDENCY_MISSING",
  );
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
});
