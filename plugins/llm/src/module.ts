import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { CapabilityBoundExport } from "../../../packages/abi/src/factory.js";
import type {
  EffectAdapter,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { modelEffectAdapter } from "./effect.js";
import { httpModelTransport } from "./provider.js";

export { generate } from "./generate.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}

/** An unbound export cannot obtain credentials or issue a model request. */
export const http: EffectAdapter & CapabilityBoundExport = {
  async execute() {
    return {
      kind: "unknown",
      reason: "Scoped provider capabilities are unavailable",
      evidence: null,
    };
  },
  async reconcile() {
    return { kind: "unknown", reason: "Provider cannot reconcile", evidence: null };
  },
  bindCapabilities(context) {
    const credential = context.capability("credential") as (binding: string) => string;
    const network = context.capability("network") as typeof fetch;
    return modelEffectAdapter({
      credential,
      resolveType: (type) => {
        context.registry.get(type);
      },
      validate: (type, value) => context.registry.validate(type, value),
      transport: (input) => httpModelTransport(input, network),
    });
  },
};
export function suite(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("Invalid model implementation");
}
// Null state: all invocation data belongs to the execution journal, never this module.
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
