import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { DefinitionRef, ReloadParticipant } from "../../../specs/fractal-harness/contracts.js";
import { validateDescription } from "./validation.js";

export { AssemblyLinker } from "./linker.js";
export { DefinitionRegistry } from "./registry.js";

let snapshotType: DefinitionRef | undefined;

export function activateMeta(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  host.registerValidator("meta.v1", validateDescription);
  return () => {};
}

export const reload: ReloadParticipant = {
  async capture() {
    if (!snapshotType) throw new Error("Meta package has not been activated");
    return { type: snapshotType, value: null };
  },
  async restore(snapshot) {
    if (snapshot.value !== null) throw new Error("Invalid stateless snapshot");
  },
  async ready() {},
  async dispose() {},
};
