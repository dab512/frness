import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type {
  ExecutionContext,
  Json,
  ObjectStore,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { ApiSubscription } from "../../api/src/protocol.js";
import {
  CliRuntime,
  type CliRuntimeOptions,
  type EventObserver,
  type ProviderBinding,
} from "./runtime.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const config = context.instance.configuration as { workspace: string };
    const subject = context.capability("local.subject") as {
      principalId: string;
      grants: string[];
    };
    const store = context.child("store") as ObjectStore & {
      storeId: string;
      registerNamespace(id: string, owner: string, scope: string): void;
      subscribe(context: ExecutionContext, namespace: string): ApiSubscription;
      project(type: TypeRef, value: Json): Json;
    };
    const execution: ExecutionContext = {
      principalId: subject.principalId,
      scopeId: context.instance.scopeId,
      ownerInstanceId: context.instance.instanceId,
      assemblyRevision: context.assemblyRevision,
      grants: subject.grants,
    };
    store.registerNamespace(
      context.instance.stateNamespaceId,
      context.instance.instanceId,
      context.instance.scopeId,
    );
    const gates = context.children("launch.policy") as NonNullable<CliRuntimeOptions["gate"]>[];
    const runtime = new CliRuntime({
      store,
      context: execution,
      storeId: store.storeId,
      namespaceId: context.instance.stateNamespaceId,
      instanceId: context.instance.instanceId,
      assemblyRevision: context.assemblyRevision,
      workspace: config.workspace,
      types: (name) => ({ ...context.implementation, name }),
      provider: context.child("transport") as ProviderBinding,
      validate: (type, value) => context.registry.validate(type, value),
      ...(gates[0] ? { gate: gates[0] } : {}),
      observers: context.children("events.observers") as EventObserver[],
    });
    await runtime.recover();
    return {
      value: {
        invoke: runtime.invoke.bind(runtime),
        read: async (ref: Parameters<CliRuntime["read"]>[0], revision?: string) => {
          const record = await runtime.read(ref, revision);
          return { ...record, value: store.project(record.object.type, record.value) };
        },
        subscribe: (namespace: string) => store.subscribe(execution, namespace),
        idle: () => runtime.idle(),
        runtime,
      },
      dispose: async () => {
        await runtime.idle();
        await runtime.observersIdle();
      },
    };
  },
};
export function suite(subject: unknown): void {
  if (!subject || typeof (subject as NativeFactory).create !== "function")
    throw Object.assign(new Error("Invalid CLI backend factory"), { code: "CONTRACT_MISMATCH" });
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
