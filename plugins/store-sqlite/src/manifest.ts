import type { DefinitionRef, PackageManifest } from "../../../packages/abi/src/index.js";

export function storageManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: "std.store-sqlite",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "factory", "suite", "reload"].map((name) => [
        name,
        { path: "server.mjs", exportName: name, environment: "server" as const },
      ]),
    ),
    definitions: [
      { name: "Json", metaType: meta("Type"), value: { schema: {}, references: {} } },
      {
        name: "Configuration",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["file", "storeId"],
            properties: {
              file: { type: "string", minLength: 1 },
              storeId: { type: "string", minLength: 1 },
            },
          },
          references: {},
        },
      },
      {
        name: "Store",
        metaType: meta("Contract"),
        value: {
          operations: {
            read: { input: local("Json"), output: local("Json"), errorCodes: [] },
            commit: { input: local("Json"), output: local("Json"), errorCodes: [] },
          },
          conformanceSuite: local("StoreSuite"),
          allowedEffects: [],
        },
      },
      {
        name: "StoreSuite",
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local("Store") },
      },
      {
        name: "Storage",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Store")],
          configurationType: local("Configuration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [],
          entry: "factory",
          abi: "factory.v1",
          requiredCapabilities: ["data.directory", "native.sqlite"],
        },
      },
    ],
  };
}
