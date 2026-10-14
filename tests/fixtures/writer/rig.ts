import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrap } from "../../../packages/host/src/bootstrap.js";
import { executionManifest } from "../../../plugins/execution/definitions/manifest.js";
import { BudgetLedger } from "../../../plugins/execution/src/budget.js";
import { EffectBridge } from "../../../plugins/execution/src/effect-adapter.js";
import { ExecutionService } from "../../../plugins/execution/src/ingress.js";
import type { CrashCut } from "../../../plugins/execution/src/outbox.js";
import { DurableOutbox } from "../../../plugins/execution/src/outbox.js";
import { AssemblyLinker } from "../../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../../plugins/meta/src/registry.js";
import { SqliteObjectStore } from "../../../plugins/store-sqlite/src/store.js";
import type {
  Assembly,
  BudgetSpec,
  DefinitionRef,
  EffectAdapter,
  ExecutionContext,
  ReducerModule,
  RetryPolicy,
} from "../../../specs/fractal-harness/contracts.js";
import { buildBootstrap } from "../../../tools/build-bootstrap.mjs";
import { writerManifest } from "./manifest.js";

export async function createWriterRig(
  directory: string,
  endpoint: string,
  policy: RetryPolicy,
  options: {
    readonly budget?: BudgetSpec;
    readonly maxUnits?: number;
    readonly commandCount?: number;
    readonly awaitInput?: boolean;
    readonly onCut?: (point: CrashCut) => Promise<void>;
  } = {},
) {
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
        manifest: writerManifest(meta),
        files: { "server.mjs": await readFile(new URL("./server.mjs", import.meta.url), "utf8") },
      }),
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  const registry = new DefinitionRegistry({
    ...generation.description,
    availableAbis: generation.abiIds(),
  });
  const ref = (name: string, packageId = "test.writer"): DefinitionRef => {
    const found = registry
      .definitions()
      .find((item) => item.ref.packageId === packageId && item.ref.name === name)?.ref;
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  };
  const linker = new AssemblyLinker(registry, ref("Assembly", "std.meta"));
  const assembly: Assembly = linker.validate({
    assemblyId: "writer",
    revision: "v1",
    profile: "durable.v1",
    rootInstanceId: "root",
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
        configuration: {
          ...(options.maxUnits !== undefined ? { maxUnits: options.maxUnits } : {}),
          ...(options.commandCount !== undefined ? { commandCount: options.commandCount } : {}),
          ...(options.awaitInput ? { mode: "await" } : {}),
        },
        stateNamespaceId: "parent",
        scopeId: "scope",
      },
      ...["connected", "sibling"].map((instanceId) => ({
        instanceId,
        implementation: ref("Writer"),
        configuration: { endpoint },
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
  const assemblies = new Map([["v1", assembly]]);
  const context: ExecutionContext = {
    principalId: "test",
    scopeId: "scope",
    ownerInstanceId: "execution",
    assemblyRevision: "v1",
    grants: [],
  };
  const store = new SqliteObjectStore({
    path: join(directory, "host.sqlite"),
    storeId: "local",
    validate: (type, value) => registry.validate(type, value),
  });
  store.registerNamespace("runtime", "execution", "scope");
  const module = (await import(
    pathToFileURL(join(distribution, "test.writer/server.mjs")).href
  )) as { writer: EffectAdapter; parent: ReducerModule; root: ReducerModule };
  const bridge = new EffectBridge({
    registry,
    adapter: () => module.writer,
    account: () => "test-account",
    policy: () => policy,
  });
  const ledger = options.budget
    ? new BudgetLedger({
        store,
        context,
        storeId: "local",
        namespaceId: "runtime",
        types: (name) => ref(name, "std.execution"),
      })
    : undefined;
  if (ledger && options.budget) await ledger.create("root", null, options.budget);
  const outbox = new DurableOutbox({
    store,
    context,
    storeId: "local",
    namespaceId: "runtime",
    types: (name) => ref(name, "std.execution"),
    bridge,
    runnerEpoch: "test-epoch",
    ...(options.onCut ? { cut: options.onCut } : {}),
    ...(ledger ? { budget: { ledger, scope: () => "root" } } : {}),
  });
  const runtime = new ExecutionService({
    store,
    context,
    storeId: "local",
    namespaceId: "runtime",
    registry,
    types: (name) => ref(name, "std.execution"),
    assembly: (revision) => {
      const found = assemblies.get(revision);
      if (!found) throw new Error("Missing pinned assembly");
      return found;
    },
    reducer: (implementation) => (implementation.name === "Root" ? module.root : module.parent),
    outbox,
  });
  return {
    runtime,
    outbox,
    store,
    context,
    bridge,
    ref,
    assemblies,
    assembly,
    linker,
    registry,
    ledger,
    async close() {
      store.close();
      await generation.close();
    },
  };
}
