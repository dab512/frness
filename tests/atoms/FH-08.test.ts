import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { EffectBridge } from "../../plugins/execution/src/effect-adapter.js";
import { AssemblyLinker } from "../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import type {
  Assembly,
  DefinitionRef,
  EffectAdapter,
  ReducerCommand,
} from "../../specs/fractal-harness/contracts.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";
import { startRemote } from "../fixtures/remote.js";
import { writerManifest } from "../fixtures/writer/manifest.js";

test("AT-008 connected effect boundary records remote side effects and classifies lost replies as unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-effect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let remote = await startRemote(join(directory, "remote.sqlite"));
  t.after(() => remote.close());
  const distribution = join(directory, "distribution");
  await buildBootstrap(distribution, {
    packages: [
      async (meta) => ({
        manifest: writerManifest(meta),
        files: {
          "server.mjs": await readFile(
            new URL("../fixtures/writer/server.mjs", import.meta.url),
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
  const ref = (name: string, packageId = "test.writer"): DefinitionRef => {
    const found = registry
      .definitions()
      .find((item) => item.ref.packageId === packageId && item.ref.name === name)?.ref;
    assert.ok(found);
    return found;
  };
  const assembly: Assembly = new AssemblyLinker(registry, ref("Assembly", "std.meta")).validate({
    assemblyId: "effects",
    revision: "v1",
    rootInstanceId: "root",
    profile: "durable.v1",
    instances: [
      {
        instanceId: "root",
        implementation: ref("Root"),
        configuration: {},
        stateNamespaceId: "root",
        scopeId: "scope",
      },
      {
        instanceId: "parent",
        implementation: ref("Parent"),
        configuration: {},
        stateNamespaceId: "parent",
        scopeId: "scope",
      },
      ...["connected", "sibling"].map((instanceId) => ({
        instanceId,
        implementation: ref("Writer"),
        configuration: { endpoint: remote.endpoint },
        stateNamespaceId: instanceId,
        scopeId: "scope",
      })),
    ],
    bindings: [
      { parentInstanceId: "root", slot: "parent", childInstanceId: "parent" },
      { parentInstanceId: "root", slot: "sibling", childInstanceId: "sibling" },
      { parentInstanceId: "parent", slot: "effect", childInstanceId: "connected" },
    ],
  });
  const module = (await import(
    pathToFileURL(join(distribution, "test.writer/server.mjs")).href
  )) as { writer: EffectAdapter };
  const bridge = new EffectBridge({
    registry,
    adapter: () => module.writer,
    account: () => "test-account",
    policy: () => ({ strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null }),
  });
  const command: Extract<ReducerCommand, { kind: "effect" }> = {
    kind: "effect",
    commandId: "write",
    adapterInstanceId: "connected",
    operation: { contract: ref("Write"), operation: "run" },
    input: { text: "hello", mode: "success" },
    maxUnits: 0,
  };
  const effect = bridge.prepare({
    assembly,
    parentInstanceId: "parent",
    invocationId: "invocation",
    operation: { contract: ref("Run"), operation: "run" },
    command,
    grants: [],
  });
  const outcome = await bridge.execute(effect, "attempt", "epoch");
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
  assert.throws(
    () =>
      bridge.prepare({
        assembly,
        parentInstanceId: "parent",
        invocationId: "invocation",
        operation: { contract: ref("Run"), operation: "run" },
        command: { ...command, adapterInstanceId: "sibling" },
        grants: [],
      }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CAPABILITY_DENIED",
  );
  const lost = bridge.prepare({
    assembly,
    parentInstanceId: "parent",
    invocationId: "lost",
    operation: { contract: ref("Run"), operation: "run" },
    command: { ...command, input: { text: "hello", mode: "lost-reply" } },
    grants: [],
  });
  assert.equal((await bridge.execute(lost, "lost-attempt", "epoch")).kind, "unknown");
  assert.deepEqual(await remote.counts(), { calls: 2, changes: 2 });
  assert.equal((await bridge.reconcile(lost, "lost-attempt")).kind, "unknown");
  assert.deepEqual(await remote.counts(), { calls: 2, changes: 2 });
  const throwing = new EffectBridge({
    ...bridge.options,
    adapter: () => ({
      execute: async () => {
        throw new Error("secret credential");
      },
      reconcile: async () => {
        throw new Error("secret credential");
      },
    }),
  });
  const thrown = await throwing.execute(effect, "throw", "epoch");
  assert.equal(thrown.kind, "unknown");
  assert.equal(JSON.stringify(thrown).includes("credential"), false);
  const invalid = new EffectBridge({
    ...bridge.options,
    adapter: () => ({
      execute: async () => ({
        kind: "completed",
        value: { wrong: true },
        actualUnits: 0,
        evidence: null,
      }),
      reconcile: module.writer.reconcile,
    }),
  });
  assert.equal((await invalid.execute(effect, "invalid", "epoch")).kind, "unknown");
  assert.deepEqual(await remote.counts(), { calls: 2, changes: 2 });
  await remote.close();
  remote = await startRemote(join(directory, "remote.sqlite"));
  assert.deepEqual(await remote.counts(), { calls: 2, changes: 2 });
});
