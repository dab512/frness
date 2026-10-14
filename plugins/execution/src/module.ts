import { randomUUID } from "node:crypto";
import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type {
  Assembly,
  DefinitionRef,
  EffectAdapter,
  ExecutionContext,
  Json,
  ObjectStore,
  ReducerModule,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { ApiSubscription } from "../../api/src/protocol.js";
import { createExecutionBackend } from "./backend.js";
import { EffectBridge } from "./effect-adapter.js";
import { ExecutionService } from "./ingress.js";
import { DurableOutbox } from "./outbox.js";
import { RepositoryBridge } from "./repository.js";

let snapshotType: DefinitionRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const configuration = context.instance.configuration as unknown as {
      executionType: TypeRef;
      repositoryContract?: DefinitionRef;
    };
    const assembly = context.capability("profile.application") as Assembly;
    const subject = context.capability("local.subject") as {
      principalId: string;
      grants: readonly string[];
      instanceGrants: Readonly<Record<string, readonly string[]>>;
    };
    const store = context.child("store") as ObjectStore & {
      storeId: string;
      registerNamespace(id: string, owner: string, scope: string): void;
      subscribe(context: ExecutionContext, namespace: string): ApiSubscription;
      project(type: TypeRef, value: Json): Json;
    };
    const executionContext: ExecutionContext = {
      principalId: subject.principalId,
      scopeId: context.instance.scopeId,
      ownerInstanceId: context.instance.instanceId,
      assemblyRevision: assembly.revision,
      grants: subject.grants,
    };
    store.registerNamespace(
      context.instance.stateNamespaceId,
      context.instance.instanceId,
      context.instance.scopeId,
    );
    for (const instance of assembly.instances)
      store.registerNamespace(instance.stateNamespaceId, instance.instanceId, instance.scopeId);
    const types = (name: string): TypeRef => ({ ...configuration.executionType, name });
    const bridge = new EffectBridge({
      registry: context.registry,
      adapter: (ref, instanceId) => context.exported(ref, instanceId) as EffectAdapter,
      account: (instance) => `local:${instance.instanceId}`,
      policy: () => ({ strategy: "non-retryable", maxAttempts: 1, idempotencyValidUntil: null }),
    });
    const outbox = new DurableOutbox({
      store,
      context: executionContext,
      storeId: store.storeId,
      namespaceId: context.instance.stateNamespaceId,
      types,
      bridge,
      runnerEpoch: randomUUID(),
    });
    const runtime = new ExecutionService({
      store,
      context: executionContext,
      storeId: store.storeId,
      namespaceId: context.instance.stateNamespaceId,
      types,
      registry: context.registry,
      assembly: (revision) => {
        if (revision !== assembly.revision)
          throw Object.assign(new Error("Pinned assembly missing"), {
            code: "PINNED_DEPENDENCY_MISSING",
          });
        return assembly;
      },
      reducer: (ref, instanceId) => context.exported(ref, instanceId) as ReducerModule,
      ...(configuration.repositoryContract
        ? {
            repository: new RepositoryBridge({
              registry: context.registry,
              contract: configuration.repositoryContract,
              store: (instance) =>
                context.exported(instance.implementation, instance.instanceId) as ObjectStore,
              grants: (instance) => subject.instanceGrants[instance.instanceId] ?? [],
            }),
          }
        : {}),
      outbox,
    });
    const backend = createExecutionBackend({
      runtime,
      outbox,
      store,
      context: executionContext,
      project: (type, value) => store.project(type, value),
    });
    return { value: backend, dispose: () => backend.idle() };
  },
};
export function suite(subject: unknown): void {
  if (!subject || typeof (subject as NativeFactory).create !== "function")
    throw Object.assign(new Error("Factory conformance failed"), { code: "CONTRACT_MISMATCH" });
}
export const reload: ReloadParticipant = {
  async capture() {
    return { type: snapshotType, value: null };
  },
  async restore(snapshot) {
    if (snapshot.value !== null) throw new Error("Unexpected snapshot");
  },
  async ready() {},
  async dispose() {},
};
