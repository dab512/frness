import type { Json, JsonSchema, PackageManifest } from "../../../packages/abi/src/index.js";

const string: JsonSchema = { type: "string", minLength: 1 };
const integer: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const anyJson: JsonSchema = {};
const ref: JsonSchema = {
  type: "object",
  "x-definition-ref": true,
  additionalProperties: false,
  required: ["packageId", "packageVersion", "digest", "name"],
  properties: {
    packageId: string,
    packageVersion: string,
    digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    name: string,
  },
};
const list = (items: JsonSchema, uniqueItems = false): JsonSchema => ({
  type: "array",
  items,
  uniqueItems,
});
const map = (values: JsonSchema): JsonSchema => ({ type: "object", additionalProperties: values });
const object = (
  properties: Record<string, Json>,
  required = Object.keys(properties),
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const operation = object({ input: ref, output: ref, errorCodes: list(string, true) });
const slot = object({
  name: string,
  accepts: ref,
  collection: { enum: ["single", "ordered", "keyed"] },
  min: integer,
  max: integer,
});
const instance = object({
  instanceId: string,
  implementation: ref,
  configuration: anyJson,
  stateNamespaceId: string,
  scopeId: string,
});
const binding = object(
  { parentInstanceId: string, slot: string, childInstanceId: string, order: integer, key: string },
  ["parentInstanceId", "slot", "childInstanceId"],
);

export const seedSchemas: Readonly<Record<string, JsonSchema>> = {
  Type: object({ schema: { type: "object", additionalProperties: true }, references: map(ref) }),
  Contract: object({
    operations: { ...map(operation), minProperties: 1 },
    conformanceSuite: ref,
    allowedEffects: list(ref, true),
  }),
  Implementation: object({
    contracts: list(ref, true),
    configurationType: ref,
    stateType: ref,
    slots: list(slot),
    entry: string,
    abi: string,
    requiredCapabilities: list(string, true),
  }),
  Slot: slot,
  Instance: instance,
  Binding: binding,
  Assembly: object({
    assemblyId: string,
    revision: string,
    rootInstanceId: string,
    profile: { enum: ["volatile.v1", "durable.v1"] },
    instances: list(instance),
    bindings: list(binding),
  }),
  ConformanceSuite: object({ entry: string, targetContract: ref }),
  NullSnapshot: { type: "null" },
};

export function seedManifest(): PackageManifest {
  return {
    format: 1,
    packageId: "std.meta",
    version: "1.0.1",
    hostAbi: "fractal.host.v1",
    reload: { snapshotType: { local: "NullSnapshot" }, serverEntry: "reload", clientEntry: null },
    dependencies: [],
    definitions: Object.entries(seedSchemas).map(([name, schema]) => ({
      name,
      metaType: { local: "Type" },
      value: { schema, references: {} },
    })),
    exports: {
      DefinitionRegistry: {
        path: "server.mjs",
        exportName: "DefinitionRegistry",
        environment: "server",
      },
      AssemblyLinker: { path: "server.mjs", exportName: "AssemblyLinker", environment: "server" },
      activateMeta: { path: "server.mjs", exportName: "activateMeta", environment: "server" },
      reload: { path: "server.mjs", exportName: "reload", environment: "server" },
    },
  };
}
