import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type {
  ExecutionContext,
  ObjectStore,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { AdmissionGate } from "./gate.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const config = context.instance.configuration as { maxRuns: number };
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
      value: new AdmissionGate({
        store,
        context: owner,
        storeId: store.storeId,
        namespaceId: context.instance.stateNamespaceId,
        types: (name) => ({ ...context.implementation, name }),
        maxRuns: config.maxRuns,
      }),
      dispose() {},
    };
  },
};
export function suite(subject: unknown): void {
  if (!subject || typeof (subject as NativeFactory).create !== "function")
    throw Object.assign(new Error("Invalid policy factory"), { code: "CONTRACT_MISMATCH" });
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
