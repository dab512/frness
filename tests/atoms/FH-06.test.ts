import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Assembly, PackageManifest } from "../../packages/abi/src/index.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { LifecycleManager } from "../../plugins/lifecycle/src/activate.js";
import { lifecycleManifest } from "../../plugins/lifecycle/src/definitions.js";
import { purge } from "../../plugins/lifecycle/src/retention.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type { ExecutionContext, ObjectRef } from "../../specs/fractal-harness/contracts.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";

test("AT-006 staged assemblies activate atomically, failed candidates preserve data and referenced artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const distribution = join(directory, "distribution");
  const reload =
    "export const reload={capture:async()=>({type:null,value:null}),restore:async()=>{},ready:async()=>{},dispose:async()=>{}};";
  await buildBootstrap(distribution, {
    packages: [
      (meta) => ({ manifest: lifecycleManifest(meta), files: { "server.mjs": reload } }),
      (meta) => {
        const local = (name: string) => ({ local: name });
        const manifest: PackageManifest = {
          format: 1,
          packageId: "test.feature",
          version: "1.0.0",
          hostAbi: "fractal.host.v1",
          dependencies: [meta("Type")],
          reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
          exports: {
            reducer: { path: "server.mjs", exportName: "reducer", environment: "server" },
            suite: { path: "server.mjs", exportName: "suite", environment: "server" },
            reload: { path: "server.mjs", exportName: "reload", environment: "server" },
          },
          definitions: [
            {
              name: "Empty",
              metaType: meta("Type"),
              value: {
                schema: {
                  type: "object",
                  properties: {},
                  required: [],
                  additionalProperties: false,
                },
                references: {},
              },
            },
            {
              name: "Echo",
              metaType: meta("Contract"),
              value: {
                operations: {
                  run: { input: local("Empty"), output: local("Empty"), errorCodes: [] },
                },
                conformanceSuite: local("Suite"),
                allowedEffects: [],
              },
            },
            {
              name: "Suite",
              metaType: meta("ConformanceSuite"),
              value: { entry: "suite", targetContract: local("Echo") },
            },
            {
              name: "Root",
              metaType: meta("Implementation"),
              value: {
                contracts: [local("Echo")],
                configurationType: local("Empty"),
                stateType: local("Empty"),
                slots: [],
                entry: "reducer",
                abi: "reducer.v1",
                requiredCapabilities: [],
              },
            },
          ],
        };
        return {
          manifest,
          files: {
            "server.mjs": `${reload} export const reducer={initialize:()=>({}),reduce:()=>({})}; export function suite(){return true;}`,
          },
        };
      },
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  t.after(() => generation.close());
  const registry = new DefinitionRegistry({
    ...generation.description,
    availableAbis: generation.abiIds(),
  });
  const find = (packageId: string, name: string) => {
    const ref = registry
      .definitions()
      .find(
        (definition) => definition.ref.packageId === packageId && definition.ref.name === name,
      )?.ref;
    assert.ok(ref);
    return ref;
  };
  const store = new SqliteObjectStore({
    path: join(directory, "db"),
    storeId: "local",
    validate: (type, value) => registry.validate(type, value),
  });
  t.after(() => store.close());
  store.registerNamespace("lifecycle", "lifecycle", "system");
  store.registerNamespace("data", "feature", "project");
  const context: ExecutionContext = {
    principalId: "admin",
    ownerInstanceId: "lifecycle",
    scopeId: "system",
    assemblyRevision: "boot",
    grants: [],
  };
  const head: ObjectRef = {
    storeId: "local",
    namespaceId: "lifecycle",
    objectId: "head",
    type: find("std.lifecycle", "State"),
  };
  const manager = new LifecycleManager(store, context, head);
  t.after(() => manager.close());
  const root = find("test.feature", "Root");
  const assembly = (revision: string): Assembly => ({
    assemblyId: "app",
    revision,
    rootInstanceId: "root",
    profile: "durable.v1",
    instances: [
      {
        instanceId: "root",
        implementation: root,
        configuration: {},
        stateNamespaceId: "data",
        scopeId: "project",
      },
    ],
    bindings: [],
  });
  let suiteCalls = 0;
  const stage = async (value: Assembly) => {
    const candidate = await manager.stage({
      directory: distribution,
      assembly: value,
      grants: [],
      conformance: async () => {
        const module = await import(
          pathToFileURL(join(distribution, "test.feature/server.mjs")).href
        );
        assert.equal(module.suite(), true);
        suiteCalls++;
      },
    });
    t.after(() => candidate.generation.close());
    return candidate;
  };
  const a = await stage(assembly("A"));
  await manager.activate(a, null, "activate-A");
  const data = {
    ...head,
    namespaceId: "data",
    objectId: "preserved",
    type: find("test.feature", "Empty"),
  };
  const dataContext = { ...context, ownerInstanceId: "feature", scopeId: "project" };
  await store.commit(dataContext, {
    commitKey: "data",
    readSet: [],
    events: [],
    writes: [{ kind: "create", object: data, value: {} }],
  });
  const dataRevision = (await store.read(dataContext, data)).revision;
  const b = await stage(assembly("B"));
  const previous = (await manager.state())!;
  await assert.rejects(
    manager.activate(b, "stale", "stale"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "REVISION_CONFLICT",
  );
  assert.equal(manager.current, a);
  await manager.activate(b, previous.record.revision, "activate-B");
  const malformed = assembly("C");
  await assert.rejects(stage({ ...malformed, rootInstanceId: "missing" }));
  const manifestPath = join(distribution, "test.feature/manifest.json");
  const manifestBytes = await readFile(manifestPath);
  await writeFile(manifestPath, "{}");
  await assert.rejects(
    stage(assembly("C")),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DIGEST_MISMATCH",
  );
  await writeFile(manifestPath, manifestBytes);
  assert.equal((await manager.state())!.value.active, '["app","B"]');
  assert.equal(suiteCalls, 2);
  await manager.disable(root.packageId, "disable-feature");
  await assert.rejects(
    manager.assertEnabled(root),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "PLUGIN_DISABLED",
  );
  assert.equal((await store.read(dataContext, data)).revision, dataRevision);
  await assert.rejects(
    purge(manager, root, "purge"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "LIVE_REFERENCES",
  );
  assert.equal(manager.current, b);
});
