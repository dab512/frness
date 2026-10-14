import assert from "node:assert/strict";
import { join } from "node:path";
import type { CapabilityBoundExport } from "../../packages/abi/src/factory.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { agentManifest } from "../../plugins/agent/definitions/manifest.js";
import { createExecutionBackend } from "../../plugins/execution/src/backend.js";
import { BudgetLedger } from "../../plugins/execution/src/budget.js";
import { EffectBridge } from "../../plugins/execution/src/effect-adapter.js";
import { ExecutionService } from "../../plugins/execution/src/ingress.js";
import { DurableOutbox } from "../../plugins/execution/src/outbox.js";
import { llmManifest } from "../../plugins/llm/definitions/manifest.js";
import { AssemblyLinker } from "../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import { toolsManifest } from "../../plugins/tools/definitions/manifest.js";
import type {
  Assembly,
  DefinitionRef,
  ExecutionContext,
  Json,
  ObjectRef,
  PackageManifest,
  ReducerModule,
} from "../../specs/fractal-harness/contracts.js";
import type { AgentTask, Candidate } from "../../specs/fractal-harness/standard-contracts.js";
import { buildRuntime, buildServerModule } from "../../tools/build-runtime.mjs";

export async function createAgentRig(
  directory: string,
  maxSteps: number,
  declaredVerifier = "Verifier",
) {
  const distribution = join(directory, "distribution");
  await buildRuntime(distribution, {
    packages: [
      async (meta) => ({
        manifest: toolsManifest(meta),
        files: { "server.mjs": await buildServerModule("plugins/tools/src/module.ts") },
        activations: ["activate"],
      }),
      async (meta) => ({
        manifest: llmManifest(meta),
        files: { "server.mjs": await buildServerModule("plugins/llm/src/module.ts") },
        activations: ["activate"],
      }),
      async (meta, lookup) => ({
        manifest: agentManifest(meta, lookup),
        files: { "server.mjs": await buildServerModule("plugins/agent/src/module.ts") },
        activations: ["activate"],
      }),
      async (meta, lookup) => ({
        manifest: {
          format: 1,
          packageId: "test.agent",
          version: "1.0.0",
          hostAbi: "fractal.host.v1",
          dependencies: [meta("Type"), lookup("std.agent", "Run"), lookup("std.tools", "Invoke")],
          reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
          exports: Object.fromEntries(
            ["activate", "context", "decide", "action", "accept", "reload"].map((entry) => [
              entry,
              { path: "server.mjs", exportName: entry, environment: "server" as const },
            ]),
          ),
          definitions: [
            {
              name: "Answer",
              metaType: meta("Type"),
              value: { schema: { type: "integer" }, references: {} },
            },
            {
              name: "Configuration",
              metaType: meta("Type"),
              value: { schema: { type: "object", additionalProperties: true }, references: {} },
            },
            ...[
              ["Context", "std.agent", "Context", "context"],
              ["Decision", "std.agent", "Decide", "decide"],
              ["Action", "std.tools", "Invoke", "action"],
              ["Verifier", "std.agent", "Accept", "accept"],
            ].map(([name, owner, contract, entry]) => ({
              name: name!,
              metaType: meta("Implementation"),
              value: {
                contracts: [{ ...lookup(owner!, contract!) }],
                configurationType: { local: "Configuration" },
                stateType: { ...meta("NullSnapshot") },
                slots: [],
                entry: entry!,
                abi: "reducer.v1",
                requiredCapabilities: [],
              },
            })),
          ],
        } satisfies PackageManifest,
        files: { "server.mjs": await buildServerModule("tests/fixtures/agent/scripted.ts") },
        activations: ["activate"],
      }),
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  const registry = new DefinitionRegistry({
    ...generation.description,
    availableAbis: generation.abiIds(),
  });
  const ref = (owner: string, name: string): DefinitionRef => {
    const found = registry
      .definitions()
      .find((item) => item.ref.packageId === owner && item.ref.name === name)?.ref;
    assert.ok(found);
    return found;
  };
  const instance = (id: string, owner: string, name: string, configuration: Json) => ({
    instanceId: id,
    implementation: ref(owner, name),
    configuration,
    stateNamespaceId: id,
    scopeId: "scope",
  });
  const assembly: Assembly = new AssemblyLinker(registry, ref("std.meta", "Assembly")).validate({
    assemblyId: "agent",
    revision: "v1",
    profile: "durable.v1",
    rootInstanceId: "tool",
    instances: [
      instance("tool", "std.agent", "AgentTool", null),
      instance("agent", "std.agent", "Loop", {
        requiredVerifiers: [{ ...ref("test.agent", declaredVerifier) }],
        remember: false,
        blockedInputType: { ...ref("std.agent", "UserInput") },
      }),
      instance("context", "test.agent", "Context", {}),
      instance("decide", "test.agent", "Decision", {
        userInputType: { ...ref("std.agent", "UserInput") },
      }),
      instance("actions", "test.agent", "Action", {}),
      instance("accept", "test.agent", "Verifier", {
        verifier: { ...ref("test.agent", "Verifier") },
      }),
    ],
    bindings: [
      { parentInstanceId: "tool", slot: "agent", childInstanceId: "agent" },
      ...["context", "decide", "actions", "accept"].map((slot) => ({
        parentInstanceId: "agent",
        slot,
        childInstanceId: slot,
      })),
    ],
  });
  const context: ExecutionContext = {
    principalId: "test",
    scopeId: "scope",
    ownerInstanceId: "execution",
    assemblyRevision: "v1",
    grants: [],
  };
  const store = new SqliteObjectStore({
    path: join(directory, "agent.sqlite"),
    storeId: "local",
    validate: (type, value) => registry.validate(type, value),
    project: (_, value) => value,
  });
  store.registerNamespace("runtime", "execution", "scope");
  const common = {
    store,
    context,
    storeId: "local",
    namespaceId: "runtime",
    types: (name: string) => ref("std.execution", name),
  };
  const ledger = new BudgetLedger(common);
  await ledger.create("root", null, {
    unit: "test",
    limit: 100,
    maxSteps,
    maxDepth: 10,
    maxConcurrentEffects: 1,
  });
  const bridge = new EffectBridge({
    registry,
    adapter: () => {
      throw new Error("This fixture must never dispatch a live effect");
    },
    account: () => "test",
    policy: () => ({ strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null }),
  });
  const outbox = new DurableOutbox({
    ...common,
    bridge,
    runnerEpoch: "agent-test",
    budget: { ledger, scope: () => "root" },
  });
  const runtime = new ExecutionService({
    ...common,
    registry,
    assembly: () => assembly,
    outbox,
    reducer: (ref, instanceId) => {
      const implementation = registry.get(ref).value as { entry: string };
      const value = generation.getExport(ref.digest, implementation.entry) as ReducerModule &
        Partial<CapabilityBoundExport>;
      return typeof value.bindCapabilities === "function"
        ? (value.bindCapabilities({
            registry,
            component: {
              instance: assembly.instances.find((item) => item.instanceId === instanceId)!,
              assembly,
            },
            capability: () => {
              throw new Error("Pure fixture cannot request capabilities");
            },
          }) as ReducerModule)
        : value;
    },
  });
  const backend = createExecutionBackend({
    runtime,
    outbox,
    store,
    context,
    project: (_, value) => value,
  });
  return {
    runtime,
    backend,
    store,
    context,
    ref,
    async run(goal: string, target: "agent" | "tool") {
      const task: AgentTask = {
        goal,
        constraints: ["keep this constraint", "and its order"],
        sources: [],
        outputType: ref("test.agent", "Answer"),
      };
      const receipt = await backend.invoke({
        targetInstanceId: target,
        assemblyRevision: "v1",
        operation: {
          contract: ref(
            target === "agent" ? "std.agent" : "std.tools",
            target === "agent" ? "Run" : "Invoke",
          ),
          operation: target === "agent" ? "run" : "invoke",
        },
        input: JSON.parse(
          JSON.stringify(target === "agent" ? task : { id: goal, name: "agent", arguments: task }),
        ),
        idempotencyKey: goal,
      });
      await backend.idle();
      return receipt;
    },
    async counts() {
      const subscription = store.subscribe(context, "runtime");
      try {
        const records = subscription
          .snapshot()
          .records.filter((item) => item.object.type.name === "Request");
        const requests = records.map((item) => item.value as { targetInstanceId: string });
        return {
          actions: requests.filter((item) => item.targetInstanceId === "actions").length,
          checks: requests.filter((item) => item.targetInstanceId === "accept").length,
        };
      } finally {
        subscription.close();
      }
    },
    async state(invocation: ObjectRef) {
      const record = await store.read(context, {
        ...invocation,
        objectId: `State/${invocation.objectId}`,
        type: ref("std.execution", "State"),
      });
      return (
        record.value as unknown as {
          state: {
            task: AgentTask;
            candidate: Candidate;
            pending: string;
            feedback: string[];
            phase: string;
          };
        }
      ).state;
    },
    async close() {
      store.close();
      await generation.close();
    },
  };
}
