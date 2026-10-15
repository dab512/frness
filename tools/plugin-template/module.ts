import { createHash } from "node:crypto";
import type { BootstrapRegistrationHost } from "../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../packages/abi/src/factory.js";
import { canonicalJson } from "../../packages/abi/src/json.js";
import type { EventObserver } from "../../plugins/agent-runtime/src/runtime.js";
import type {
  ExecutionContext,
  ObjectStore,
  ReloadParticipant,
  TypeRef,
} from "../../specs/fractal-harness/contracts.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost) {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const store = context.child("store") as ObjectStore & {
      storeId: string;
      registerNamespace(id: string, owner: string, scope: string): void;
    };
    const subject = context.capability("local.subject") as {
      principalId: string;
      grants: string[];
    };
    const owner: ExecutionContext = {
      principalId: subject.principalId,
      grants: subject.grants,
      scopeId: context.instance.scopeId,
      ownerInstanceId: context.instance.instanceId,
      assemblyRevision: context.assemblyRevision,
    };
    const type = { ...context.implementation, name: "Note" };
    const label = (context.instance.configuration as { label: string }).label;
    const children = context.children("children") as EventObserver[];
    store.registerNamespace(
      context.instance.stateNamespaceId,
      context.instance.instanceId,
      context.instance.scopeId,
    );
    let pending = Promise.resolve();
    const observer: EventObserver = {
      observe(input) {
        const work = pending.then(async () => {
          const event = (input.event.value as { event: { kind: string; status?: string } }).event;
          if (event.kind === "terminal") {
            const id = createHash("sha256")
              .update(canonicalJson([type, input.event.object, input.event.revision]))
              .digest("hex");
            const value = {
              sourceId: input.event.object.objectId,
              sourceRevision: input.event.revision,
              phase: event.status ?? "unknown",
              label,
            };
            await store.commit(owner, {
              commitKey: `note/${id}`,
              readSet: [],
              events: [],
              writes: [
                {
                  kind: "create",
                  object: {
                    storeId: store.storeId,
                    namespaceId: context.instance.stateNamespaceId,
                    objectId: `Note/${id}`,
                    type,
                  },
                  value,
                },
              ],
            });
          }
          for (const child of children) await child.observe(input);
        });
        pending = work.catch(() => {});
        return work;
      },
    };
    return { value: observer, dispose: () => pending };
  },
};
export function suite(subject: unknown) {
  if (!subject || typeof (subject as NativeFactory).create !== "function")
    throw new Error("Invalid factory");
}
export const reload: ReloadParticipant = {
  async capture() {
    return { type: snapshotType, value: null };
  },
  async restore(snapshot) {
    if (snapshot.value !== null) throw new Error("Invalid snapshot");
  },
  async ready() {},
  async dispose() {},
};
