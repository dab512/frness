import type {
  ExecutionContext,
  InvocationRequest,
  Json,
  ObjectRef,
  ObjectStore,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { ApiBackend, ApiSubscription } from "../../api/src/protocol.js";
import type { ExecutionService } from "./ingress.js";
import type { DurableOutbox } from "./outbox.js";

export interface ExecutionBackendOptions {
  readonly runtime: ExecutionService;
  readonly outbox: DurableOutbox;
  readonly store: ObjectStore & {
    subscribe(context: ExecutionContext, namespaceId: string): ApiSubscription;
  };
  readonly context: ExecutionContext;
  readonly project: (type: TypeRef, value: Json) => Json;
}
export function createExecutionBackend(
  options: ExecutionBackendOptions,
): ApiBackend & { idle(): Promise<void> } {
  let ingress = Promise.resolve();
  let work = Promise.resolve();
  let failure: unknown;
  const wake = () => {
    work = work
      .then(async () => {
        await options.outbox.recover();
        for (;;) {
          const before = await options.runtime.workflow();
          for (const invocation of before.invocations) {
            for (const id of invocation.inboxIds) await options.runtime.step(invocation.ref, id);
            for (const child of await options.runtime.pendingChildren(invocation.ref)) {
              const receipt = await options.runtime.startChild(
                invocation.ref,
                child.inboxId,
                child.commandId,
              );
              const snapshot = await options.runtime.snapshot(receipt.invocation);
              if (["succeeded", "failed", "cancelled"].includes(snapshot.phase))
                await options.runtime.deliverChild(
                  invocation.ref,
                  child.commandId,
                  receipt.invocation,
                );
            }
          }
          await options.outbox.pump(options.runtime);
          if ((await options.runtime.workflow()).signature === before.signature) return;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      })
      .catch((error) => {
        failure = error;
      });
  };
  return {
    async invoke(request: InvocationRequest) {
      const accepted = ingress.then(() => options.runtime.submit(request));
      ingress = accepted.then(
        () => {},
        () => {},
      );
      const receipt = await accepted;
      wake();
      return receipt;
    },
    async read(ref, revision) {
      const record = await options.store.read(options.context, ref, revision);
      return { ...record, value: options.project(record.object.type, record.value) };
    },
    subscribe: (namespaceId) => options.store.subscribe(options.context, namespaceId),
    async idle() {
      await work;
      if (failure) throw failure;
    },
  };
}
