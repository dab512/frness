import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type { DefinitionRef, ReloadParticipant } from "../../../specs/fractal-harness/contracts.js";
import type { ApiBackend } from "./protocol.js";
import { createApiServer } from "./server.js";

let snapshotType: DefinitionRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  host.registerAbi("factory.v1", {
    validateExport(value) {
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as { create?: unknown }).create !== "function"
      )
        throw Object.assign(new Error("Invalid native factory"), { code: "INVALID_OUTPUT" });
    },
  });
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const configuration = context.instance.configuration as unknown as {
      port: number;
      origins: string[];
      credentialBinding: string;
    };
    const credential = context.capability("credential") as (binding: string) => string;
    const backend = context.child("backend") as ApiBackend;
    const api = await createApiServer({
      token: credential(configuration.credentialBinding),
      port: configuration.port,
      origins: configuration.origins,
      backend,
    });
    return { value: api, dispose: () => api.close() };
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
