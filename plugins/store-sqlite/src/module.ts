import { resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { NativeFactory } from "../../../packages/abi/src/factory.js";
import type {
  DefinitionRef,
  Json,
  ReloadParticipant,
} from "../../../specs/fractal-harness/contracts.js";
import { redact } from "./access.js";
import { SqliteObjectStore } from "./store.js";

let snapshotType: DefinitionRef;
export function activate(host: BootstrapRegistrationHost): () => void {
  snapshotType = host.snapshotType;
  return () => {};
}
export const factory: NativeFactory = {
  async create(context) {
    const configuration = context.instance.configuration as unknown as {
      file: string;
      storeId: string;
    };
    const root = context.capability("data.directory") as string;
    const path = resolve(root, configuration.file);
    if (!path.startsWith(`${resolve(root)}${sep}`))
      throw Object.assign(new Error("Database is outside data directory"), {
        code: "CAPABILITY_DENIED",
      });
    const store = new SqliteObjectStore({
      path,
      storeId: configuration.storeId,
      database: context.capability("native.sqlite") as typeof Database,
      validate: (type, value) => context.registry.validate(type, value),
      project: (type, value) =>
        redact(value, (context.registry.get(type).value as { schema: Json }).schema),
    });
    return { value: store, dispose: () => store.close() };
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
