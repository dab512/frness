import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type {
  ExecutionContext,
  ObjectStore,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { type UsageMapping, UsageObserver } from "./observer.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const config = context.instance.configuration as unknown as { mappings: UsageMapping[] };
    const subject = context.capability("local.subject") as {
      principalId: string;
      grants: string[];
    };
    const store = context.child("store") as ObjectStore & {
      storeId: string;
      registerNamespace(id: string, owner: string, scope: string): void;
    };
    const owner: ExecutionContext = {
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
    return {
      value: new UsageObserver({
        store,
        context: owner,
        storeId: store.storeId,
        namespaceId: context.instance.stateNamespaceId,
        types: (name) => ({ ...context.implementation, name }),
        mappings: config.mappings,
      }),
      dispose() {},
    };
  },
};
export function suite(subject: unknown): void {
  if (!subject || typeof (subject as NativeFactory).create !== "function")
    throw Object.assign(new Error("Invalid observer factory"), { code: "CONTRACT_MISMATCH" });
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
