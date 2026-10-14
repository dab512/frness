import assert from "node:assert/strict";
import { join } from "node:path";
import { canonicalJson } from "../../packages/abi/src/json.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { createExecutionBackend } from "../../plugins/execution/src/backend.js";
import { BudgetLedger } from "../../plugins/execution/src/budget.js";
import { EffectBridge } from "../../plugins/execution/src/effect-adapter.js";
import { ExecutionService } from "../../plugins/execution/src/ingress.js";
import { DurableOutbox } from "../../plugins/execution/src/outbox.js";
import { RepositoryBridge } from "../../plugins/execution/src/repository.js";
import { AssemblyLinker } from "../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type {
  Assembly,
  ExecutionContext,
  InvocationRequest,
  Json,
  ObjectRef,
  ObjectStore,
  PackageManifest,
  ReducerModule,
} from "../../specs/fractal-harness/contracts.js";
import { buildRuntime, buildServerModule } from "../../tools/build-runtime.mjs";

export async function repositoryRig(
  directory: string,
  cut?: () => Promise<void>,
  reuse = false,
  maxSteps?: number,
) {
  const distribution = join(directory, "distribution");
  if (!reuse)
    await buildRuntime(distribution, {
      packages: [
        async (meta, lookup) => ({
          manifest: {
            format: 1,
            packageId: "test.repository",
            version: "1.0.0",
            hostAbi: "fractal.host.v1",
            dependencies: [meta("Type"), lookup("std.storage", "Repository")],
            reload: {
              snapshotType: meta("NullSnapshot"),
              serverEntry: "reload",
              clientEntry: null,
            },
            exports: Object.fromEntries(
              ["activate", "parent", "suite", "reload"].map((name) => [
                name,
                { path: "server.mjs", exportName: name, environment: "server" as const },
              ]),
            ),
            definitions: [
              { name: "Json", metaType: meta("Type"), value: { schema: {}, references: {} } },
              {
                name: "Text",
                metaType: meta("Type"),
                value: { schema: { type: "string" }, references: {} },
              },
              {
                name: "Run",
                metaType: meta("Contract"),
                value: {
                  operations: {
                    run: { input: { local: "Json" }, output: { local: "Json" }, errorCodes: [] },
                  },
                  conformanceSuite: { local: "Suite" },
                  allowedEffects: [],
                },
              },
              {
                name: "Suite",
                metaType: meta("ConformanceSuite"),
                value: { entry: "suite", targetContract: { local: "Run" } },
              },
              {
                name: "Parent",
                metaType: meta("Implementation"),
                value: {
                  contracts: [{ local: "Run" }],
                  configurationType: { ...meta("NullSnapshot") },
                  stateType: { ...meta("NullSnapshot") },
                  entry: "parent",
                  abi: "reducer.v1",
                  requiredCapabilities: [],
                  slots: [
                    {
                      name: "repository",
                      accepts: { ...lookup("std.storage", "Repository") },
                      collection: "single",
                      min: 1,
                      max: 1,
                    },
                  ],
                },
              },
            ],
          } satisfies PackageManifest,
          files: { "server.mjs": await buildServerModule("tests/fixtures/repository/parent.ts") },
          activations: ["activate"],
        }),
      ],
    });
  const generation = await bootstrap({ directory: distribution });
  const registry = new DefinitionRegistry({
    ...generation.description,
    availableAbis: generation.abiIds(),
  });
  const ref = (owner: string, name: string) => {
    const found = registry
      .definitions()
      .find((item) => item.ref.packageId === owner && item.ref.name === name)?.ref;
    assert.ok(found);
    return found;
  };
  const linker = new AssemblyLinker(registry, ref("std.meta", "Assembly"), ["repository"]);
  const assembly: Assembly = linker.validate({
    assemblyId: "repository",
    revision: "v1",
    profile: "durable.v1",
    rootInstanceId: "parent",
    instances: [
      {
        instanceId: "parent",
        implementation: ref("test.repository", "Parent"),
        configuration: null,
        stateNamespaceId: "domain",
        scopeId: "scope",
      },
      {
        instanceId: "repo",
        implementation: ref("std.storage", "LocalRepository"),
        configuration: { binding: "main" },
        stateNamespaceId: "repo",
        scopeId: "scope",
      },
    ],
    bindings: [{ parentInstanceId: "parent", slot: "repository", childInstanceId: "repo" }],
  });
  const context: ExecutionContext = {
    principalId: "test",
    scopeId: "scope",
    ownerInstanceId: "execution",
    assemblyRevision: "v1",
    grants: ["repository"],
  };
  const dataContext = { ...context, ownerInstanceId: "parent", grants: [] };
  const store = new SqliteObjectStore({
    path: join(directory, "host.sqlite"),
    storeId: "local",
    validate: (type, value) => registry.validate(type, value),
    project: (_, value) => value,
  });
  store.registerNamespace("runtime", "execution", "scope");
  store.registerNamespace("domain", "parent", "scope");
  store.registerNamespace("foreign", "foreign", "other-scope");
  const object: ObjectRef = {
    storeId: "local",
    namespaceId: "domain",
    objectId: "record",
    type: ref("test.repository", "Text"),
  };
  const calls = { read: 0, commit: 0 };
  const native: ObjectStore = {
    async read(...args) {
      calls.read++;
      return store.read(...args);
    },
    async commit(...args) {
      calls.commit++;
      return store.commit(...args);
    },
  };
  const repository = new RepositoryBridge({
    registry,
    contract: ref("std.storage", "Repository"),
    store: () => native,
    grants: () => [],
    ...(cut ? { cut: async () => cut() } : {}),
  });
  const common = {
    store,
    context,
    storeId: "local",
    namespaceId: "runtime",
    types: (name: string) => ref("std.execution", name),
  };
  const bridge = new EffectBridge({
    registry,
    adapter: () => {
      throw new Error("No external effect is expected");
    },
    account: () => "none",
    policy: () => ({ strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null }),
  });
  const ledger = maxSteps === undefined ? undefined : new BudgetLedger(common);
  if (ledger)
    await ledger.create("root", null, {
      unit: "test",
      limit: 0,
      maxSteps: maxSteps!,
      maxDepth: 4,
      maxConcurrentEffects: 1,
    });
  const outbox = new DurableOutbox({
    ...common,
    bridge,
    runnerEpoch: "repository-test",
    ...(ledger ? { budget: { ledger, scope: () => "root" } } : {}),
  });
  const assemblies = new Map([[assembly.revision, assembly]]);
  const runtime = new ExecutionService({
    ...common,
    registry,
    assembly: (revision) => {
      const found = assemblies.get(revision);
      if (!found) throw new Error("Pinned assembly unavailable");
      return found;
    },
    repository,
    outbox,
    reducer: (implementation) => {
      const definition = registry.get(implementation).value as { entry: string };
      return generation.getExport(implementation.digest, definition.entry) as ReducerModule;
    },
  });
  const backend = () =>
    createExecutionBackend({ runtime, outbox, store, context, project: (_, value) => value });
  const request = (key: string, operation: string, input: Json): InvocationRequest => ({
    targetInstanceId: "parent",
    assemblyRevision: "v1",
    operation: { contract: ref("test.repository", "Run"), operation: "run" },
    input: { operation, input },
    idempotencyKey: key,
  });
  const commitInput: Json = {
    batch: {
      commitKey: "repo",
      readSet: [],
      writes: [{ kind: "create", object: JSON.parse(JSON.stringify(object)), value: "new value" }],
      events: [],
    },
  };
  return {
    distribution,
    generation,
    registry,
    ref,
    assembly,
    registerAssembly(value: Assembly) {
      const validated = linker.validate(value);
      if (assemblies.has(value.revision)) throw new Error("Assembly revision is immutable");
      for (const instance of value.instances)
        store.registerNamespace(instance.stateNamespaceId, instance.instanceId, instance.scopeId);
      assemblies.set(value.revision, validated);
    },
    store,
    runtime,
    repository,
    context,
    dataContext,
    object,
    calls,
    backend,
    request,
    commitInput,
    types: common.types,
    async repositoryInvocation() {
      const subscription = store.subscribe(context, "runtime");
      try {
        const records = subscription.snapshot().records;
        const request = records.find(
          (record) =>
            record.object.type.name === "Request" &&
            (record.value as { targetInstanceId: string }).targetInstanceId === "repo",
        )!;
        const receipt = records.find(
          (record) =>
            record.object.type.name === "Receipt" &&
            canonicalJson((record.value as unknown as { request: ObjectRef }).request) ===
              canonicalJson(request.object),
        )!;
        return (receipt.value as unknown as { invocation: ObjectRef }).invocation;
      } finally {
        subscription.close();
      }
    },
    async close() {
      store.close();
      await generation.close();
    },
  };
}
