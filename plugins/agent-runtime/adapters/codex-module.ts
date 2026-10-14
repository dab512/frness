import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type { ReloadParticipant, TypeRef } from "../../../specs/fractal-harness/contracts.js";
import { type CodexConfiguration, codexTransport } from "./codex.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const config = context.instance.configuration as unknown as CodexConfiguration & {
      environmentBindings?: Record<string, string>;
    };
    const environment: Record<string, string> = {};
    for (const [name, binding] of Object.entries(config.environmentBindings ?? {}))
      environment[name] = (context.capability("credential") as (binding: string) => string)(
        binding,
      );
    const transport = codexTransport({ ...config, environment });
    return {
      value: {
        implementation: context.instance.implementation,
        eventType: { ...context.implementation, name: "Event" },
        configuration: context.instance.configuration,
        transport,
      },
      dispose() {},
    };
  },
};
export function suite(subject: unknown): void {
  if (!subject || typeof (subject as NativeFactory).create !== "function")
    throw Object.assign(new Error("Invalid provider factory"), { code: "CONTRACT_MISMATCH" });
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
