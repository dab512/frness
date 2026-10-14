import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

export function lifecycleManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const string = { type: "string", minLength: 1 };
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["active", "assemblies", "disabled", "packages", "pins"],
    properties: {
      active: string,
      assemblies: { type: "object", additionalProperties: { $ref: "type:Assembly" } },
      disabled: { type: "array", items: string, uniqueItems: true },
      packages: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["digest", "directory"],
          properties: {
            digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            directory: string,
          },
        },
      },
      pins: {
        type: "object",
        additionalProperties: { type: "array", items: string, uniqueItems: true },
      },
    },
  };
  return {
    format: 1,
    packageId: "std.lifecycle",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type"), meta("Assembly")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: { reload: { path: "server.mjs", exportName: "reload", environment: "server" } },
    definitions: [
      {
        name: "State",
        metaType: meta("Type"),
        value: { schema, references: { Assembly: { ...meta("Assembly") } } },
      },
    ],
  };
}
