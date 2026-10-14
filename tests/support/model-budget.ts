import assert from "node:assert/strict";
import type { startDaemon } from "../../apps/daemon/src/main.js";
import { createExecutionBackend } from "../../plugins/execution/src/backend.js";
import { BudgetLedger } from "../../plugins/execution/src/budget.js";
import { EffectBridge } from "../../plugins/execution/src/effect-adapter.js";
import { ExecutionService } from "../../plugins/execution/src/ingress.js";
import { DurableOutbox } from "../../plugins/execution/src/outbox.js";
import { modelEffectAdapter } from "../../plugins/llm/src/effect.js";
import { generate } from "../../plugins/llm/src/generate.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import type { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type {
  Assembly,
  ExecutionContext,
  InvocationRequest,
  TypeRef,
} from "../../specs/fractal-harness/contracts.js";

export async function modelBudgetCheck(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  source: Assembly,
  request: InvocationRequest,
  types: (name: string) => TypeRef,
) {
  const store = daemon.service("storage") as SqliteObjectStore;
  const context: ExecutionContext = {
    principalId: "local",
    scopeId: "scope",
    ownerInstanceId: "budget-execution",
    assemblyRevision: "budget-v1",
    grants: ["network", "credential"],
  };
  store.registerNamespace("budget-runtime", context.ownerInstanceId, context.scopeId);
  const assembly: Assembly = {
    ...source,
    revision: "budget-v1",
    instances: source.instances.map((item) =>
      item.instanceId === "generate"
        ? { ...item, configuration: { providerInstanceId: "provider", maxUnits: 2 } }
        : item,
    ),
  };
  const registry = new DefinitionRegistry({
    ...daemon.generation.description,
    availableAbis: daemon.generation.abiIds(),
  });
  const common = { store, context, storeId: "local", namespaceId: "budget-runtime", types };
  const ledger = new BudgetLedger(common);
  await ledger.create("model-budget", null, {
    unit: "request-credit",
    limit: 2,
    maxSteps: 10,
    maxDepth: 2,
    maxConcurrentEffects: 1,
  });
  const bridge = new EffectBridge({
    registry,
    adapter: () =>
      modelEffectAdapter({
        validate: (type, value) => registry.validate(type, value),
        credential: () => "test-model-token",
      }),
    account: () => "model-account",
    policy: () => ({ strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null }),
  });
  const outbox = new DurableOutbox({
    ...common,
    bridge,
    runnerEpoch: "budget-test",
    budget: { ledger, scope: () => "model-budget" },
  });
  const runtime = new ExecutionService({
    ...common,
    registry,
    assembly: () => assembly,
    reducer: () => generate,
    outbox,
  });
  const backend = createExecutionBackend({
    runtime,
    outbox,
    store,
    context,
    project: (_, value) => value,
  });
  const first = await backend.invoke({
    ...request,
    assemblyRevision: "budget-v1",
    idempotencyKey: "budget-first",
  });
  await backend.idle();
  assert.equal((await runtime.snapshot(first.invocation)).phase, "succeeded");
  assert.deepEqual(
    await ledger.snapshot("model-budget"),
    { spent: 0, reserved: 2, limit: 2 },
    "unknown model usage must retain its shared reservation",
  );
  const intents = await outbox.intents();
  assert.equal(intents.length, 1);
  const intent = (await store.read(context, intents[0]!)).value as unknown as {
    attempt: Parameters<SqliteObjectStore["read"]>[1];
  };
  const attempt = (await store.read(context, intent.attempt)).value as unknown as {
    result: { object: Parameters<SqliteObjectStore["read"]>[1]; revision: string };
  };
  const completion = (await store.read(context, attempt.result.object, attempt.result.revision))
    .value as unknown as { outcome: { evidence: unknown } };
  assert.deepEqual(completion.outcome.evidence, { provisional: [{ kind: "text", delta: "42" }] });
  const second = await backend.invoke({
    ...request,
    assemblyRevision: "budget-v1",
    idempotencyKey: "budget-second",
  });
  await backend.idle();
  const rejected = await runtime.snapshot(second.invocation);
  assert.equal(rejected.phase, "failed");
  assert.equal(rejected.error?.code, "BUDGET_EXCEEDED");
  assert.equal(
    (await outbox.intents()).length,
    1,
    "denied request must not create another physical attempt",
  );
}
