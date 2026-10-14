import type { DefinitionRef, PackageManifest } from "../../../packages/abi/src/index.js";

export function apiManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: "std.api",
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
            required: ["port", "credentialBinding", "origins"],
            properties: {
              port: { type: "integer", minimum: 0, maximum: 65535 },
              credentialBinding: { type: "string", minLength: 1 },
              origins: { type: "array", items: { type: "string" } },
            },
          },
          references: {},
        },
      },
      ...["Backend", "Server"].map((name) => ({
        name,
        metaType: meta("Contract"),
        value: {
          operations: { invoke: { input: local("Json"), output: local("Json"), errorCodes: [] } },
          conformanceSuite: local(`${name}Suite`),
          allowedEffects: [],
        },
      })),
      ...["Backend", "Server"].map((name) => ({
        name: `${name}Suite`,
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local(name) },
      })),
      {
        name: "HttpServer",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Server")],
          configurationType: local("Configuration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [
            { name: "backend", accepts: local("Backend"), collection: "single", min: 1, max: 1 },
          ],
          entry: "factory",
          abi: "factory.v1",
          requiredCapabilities: ["credential"],
        },
      },
    ],
  };
}
