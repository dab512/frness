import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrap } from "../../../packages/host/src/bootstrap.js";
import { EffectBridge } from "../../../plugins/execution/src/effect-adapter.js";
import { ExecutionService } from "../../../plugins/execution/src/ingress.js";
import { DurableOutbox } from "../../../plugins/execution/src/outbox.js";
import { AssemblyLinker } from "../../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../../plugins/meta/src/registry.js";
import { SqliteObjectStore } from "../../../plugins/store-sqlite/src/store.js";
import type {
  Assembly,
  AttemptRecord,
  DefinitionRef,
  EffectAdapter,
  EffectOutcome,
  ExecutionContext,
  ObjectRef,
  ReducerModule,
} from "../../../specs/fractal-harness/contracts.js";

const directory = process.argv[2]!;
const generation = await bootstrap({ directory: join(directory, "distribution") });
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
const assembly: Assembly = new AssemblyLinker(registry, ref("Assembly", "std.meta")).validate(
  JSON.parse(await readFile(join(directory, "assembly.json"), "utf8")),
);
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
  pathToFileURL(join(directory, "distribution/test.writer/server.mjs")).href
)) as { writer: EffectAdapter; parent: ReducerModule };
let crash: string | null = process.argv[3] ?? null;
const cut = async (point: string) => {
  if (point !== crash) return;
  crash = null;
  process.send?.({ barrier: point });
  await new Promise<void>(() => {});
};
const bridge = new EffectBridge({
  registry,
  adapter: () => module.writer,
  account: () => "test-account",
  policy: () => ({ strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null }),
});
const outbox = new DurableOutbox({
  store,
  context,
  storeId: "local",
  namespaceId: "runtime",
  types: (name) => ref(name, "std.execution"),
  bridge,
  runnerEpoch: randomUUID(),
  cut,
});
const runtime = new ExecutionService({
  store,
  context,
  storeId: "local",
  namespaceId: "runtime",
  registry,
  types: (name) => ref(name, "std.execution"),
  assembly: () => assembly,
  reducer: () => module.parent,
  outbox,
  cut,
});
process.on("message", async (message) => {
  if (message !== "pump") return;
  try {
    const receipt = await runtime.submit({
      targetInstanceId: "parent",
      assemblyRevision: "v1",
      operation: { contract: ref("Run"), operation: "run" },
      input: { text: "hello", mode: "success" },
      idempotencyKey: "write-1",
    });
    await outbox.recover();
    await runtime.step(receipt.invocation, "input");
    await outbox.pump(runtime);
    await outbox.pump(runtime);
    let duplicatesChecked = 0;
    for (const outboxRef of await outbox.intents()) {
      const intent = (await store.read(context, outboxRef)).value as unknown as {
        attempt: ObjectRef;
      };
      const attempt = (await store.read(context, intent.attempt)).value as unknown as AttemptRecord;
      if (!attempt.result) continue;
      const completion = await store.read(context, attempt.result.object, attempt.result.revision);
      const outcome = (completion.value as unknown as { outcome: EffectOutcome }).outcome;
      await outbox.complete(outboxRef, outcome);
      await outbox.complete(outboxRef, outcome);
      if (outcome.kind === "completed")
        await assert.rejects(
          outbox.complete(outboxRef, { ...outcome, value: { externalId: "conflicting" } }),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "COMPLETION_CONFLICT",
        );
      duplicatesChecked++;
    }
    const snapshot = await runtime.snapshot(receipt.invocation);
    process.send?.({
      result: snapshot,
      state: await runtime.state(receipt.invocation),
      duplicatesChecked,
    });
  } catch (error) {
    process.send?.({
      error:
        error instanceof Error
          ? {
              message: error.message,
              code: "code" in error ? error.code : null,
              stack: error.stack,
            }
          : String(error),
    });
  }
});
process.send?.({ ready: true });
