import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { executionManifest } from "../../plugins/execution/definitions/manifest.js";
import { ExecutionService } from "../../plugins/execution/src/ingress.js";
import { AssemblyLinker } from "../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type {
  Assembly,
  DefinitionRef,
  ExecutionContext,
  InvocationRequest,
  ReducerModule,
} from "../../specs/fractal-harness/contracts.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";
import { counterManifest } from "../fixtures/counter/manifest.js";

test("AT-007 per-invocation state, pure child calls and poison consumption are atomic", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-execution-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const distribution = join(directory, "distribution");
  await buildBootstrap(distribution, {
    packages: [
      (meta) => ({
        manifest: executionManifest(meta),
        files: {
          "server.mjs":
            "export const reload={async capture(){return {type:null,value:null}},async restore(){},async ready(){},async dispose(){}}",
        },
      }),
      async (meta) => ({
        manifest: counterManifest(meta),
        files: {
          "server.mjs": await readFile(
            new URL("../fixtures/counter/server.mjs", import.meta.url),
            "utf8",
          ),
        },
      }),
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  t.after(() => generation.close());
  const registry = new DefinitionRegistry({
    ...generation.description,
    availableAbis: generation.abiIds(),
  });
  const ref = (packageId: string, name: string): DefinitionRef => {
    const found = registry
      .definitions()
      .find((item) => item.ref.packageId === packageId && item.ref.name === name)?.ref;
    assert.ok(found);
    return found;
  };
  const context: ExecutionContext = {
    principalId: "me",
    scopeId: "project",
    ownerInstanceId: "execution",
    assemblyRevision: "v1",
    grants: [],
  };
  const store = new SqliteObjectStore({
    path: join(directory, "db"),
    storeId: "local",
    validate: (type, value) => registry.validate(type, value),
  });
  t.after(() => store.close());
  store.registerNamespace("runtime", "execution", "project");
  const module = (await import(
    pathToFileURL(join(distribution, "test.counter/server.mjs")).href
  )) as { counter: ReducerModule };
  const modes = ["counter", "parent", "child", "throw", "mixed", "invalid-init"];
  const assembly: Assembly = {
    assemblyId: "test",
    revision: "v1",
    profile: "durable.v1",
    rootInstanceId: "parent",
    instances: modes.map((mode) => ({
      instanceId: mode,
      implementation: ref("test.counter", "Reducer"),
      configuration: { mode },
      stateNamespaceId: `data-${mode}`,
      scopeId: "project",
    })),
    bindings: [
      { parentInstanceId: "parent", slot: "body", childInstanceId: "child" },
      ...["counter", "throw", "mixed", "invalid-init"].map((childInstanceId, order) => ({
        parentInstanceId: "parent",
        slot: "extras",
        childInstanceId,
        order,
      })),
    ],
  };
  const pinnedAssembly = new AssemblyLinker(registry, ref("std.meta", "Assembly")).validate(
    assembly,
  );
  const runtime = new ExecutionService({
    store,
    context,
    storeId: "local",
    namespaceId: "runtime",
    registry,
    types: (name) => ref("std.execution", name),
    assembly: (revision) => {
      assert.equal(revision, "v1");
      return pinnedAssembly;
    },
    reducer: () => module.counter,
  });
  const request = (targetInstanceId: string, key: string): InvocationRequest => ({
    targetInstanceId,
    assemblyRevision: "v1",
    operation: { contract: ref("test.counter", "Counter"), operation: "run" },
    input: 1,
    idempotencyKey: key,
  });
  const a = await runtime.submit(request("counter", "a"));
  const b = await runtime.submit(request("counter", "b"));
  await runtime.step(a.invocation, "input");
  assert.deepEqual(await runtime.state(a.invocation), { count: 1 });
  assert.deepEqual(await runtime.state(b.invocation), { count: 0 });
  await runtime.step(a.invocation, "input");
  assert.deepEqual(await runtime.state(a.invocation), { count: 1 });
  const hasCode = (code: string) => (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
  await assert.rejects(
    runtime.submit(request("invalid-init", "invalid")),
    hasCode("INVALID_OUTPUT"),
  );
  for (const [mode, code] of [
    ["throw", "REDUCER_EXECUTION_FAILED"],
    ["mixed", "INVALID_COMMAND_BATCH"],
  ]) {
    const receipt = await runtime.submit(request(mode!, mode!));
    await runtime.step(receipt.invocation, "input");
    const snapshot = await runtime.snapshot(receipt.invocation);
    assert.equal(snapshot.phase, "failed");
    assert.equal(snapshot.error?.code, code);
    assert.deepEqual(await runtime.state(receipt.invocation), { count: 0 });
    assert.equal((await runtime.inbox(receipt.invocation, "input")).consumed, true);
    assert.deepEqual(await runtime.commands(receipt.invocation, "input"), []);
    await runtime.step(receipt.invocation, "input");
    assert.equal((await runtime.snapshot(receipt.invocation)).phase, "failed");
  }
  const parent = await runtime.submit(request("parent", "parent"));
  await runtime.step(parent.invocation, "input");
  const child = await runtime.startChild(parent.invocation, "input", "child");
  await runtime.step(child.invocation, "input");
  await runtime.deliverChild(parent.invocation, "child", child.invocation);
  await runtime.step(parent.invocation, "child:child");
  assert.equal((await runtime.snapshot(parent.invocation)).result, 1);
  assert.equal((await runtime.snapshot(parent.invocation)).phase, "succeeded");
});
