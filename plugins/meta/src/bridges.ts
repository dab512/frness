import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { DefinitionRef, ReloadParticipant } from "../../../specs/fractal-harness/contracts.js";

let snapshotType: DefinitionRef | undefined;
function methods(value: unknown, names: readonly string[]): void {
  if (!value || (typeof value !== "object" && typeof value !== "function"))
    throw Object.assign(new Error("Invalid ABI export"), { code: "INVALID_OUTPUT" });
  for (const name of names)
    if (typeof (value as Record<string, unknown>)[name] !== "function")
      throw Object.assign(new Error(`Missing ABI method ${name}`), { code: "INVALID_OUTPUT" });
}
function register(
  host: BootstrapRegistrationHost,
  id: string,
  names: readonly string[],
): () => void {
  snapshotType = host.snapshotType;
  host.registerAbi(id, { validateExport: (value) => methods(value, names) });
  return () => {};
}
export const activateStore = (host: BootstrapRegistrationHost) =>
  register(host, "store.v1", ["read", "commit"]);
export const activateReducer = (host: BootstrapRegistrationHost) =>
  register(host, "reducer.v1", ["initialize", "reduce"]);
export const activateEffectAdapter = (host: BootstrapRegistrationHost) =>
  register(host, "effect-adapter.v1", ["execute", "reconcile"]);
export function activateReactDescriptor(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  host.registerAbi("react-view.v1", {
    validateExport(value) {
      if (typeof value !== "function")
        throw Object.assign(new Error("Invalid view export"), { code: "INVALID_OUTPUT" });
    },
  });
  return () => {};
}
export const activateReactView = activateReactDescriptor;
export const reload: ReloadParticipant = {
  async capture() {
    if (!snapshotType) throw new Error("Bridge not activated");
    return { type: snapshotType, value: null };
  },
  async restore(snapshot) {
    if (snapshot.value !== null) throw new Error("Invalid bridge snapshot");
  },
  async ready() {},
  async dispose() {},
};
