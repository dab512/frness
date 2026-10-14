import type { DefinitionRef, Json, PackageManifest } from "../../../packages/abi/src/index.js";

export function writerManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  const impl = (
    entry: string,
    contract: string,
    config: string,
    abi: string,
    slots: Json[] = [],
  ) => ({
    entry,
    contracts: [local(contract)],
    configurationType: local(config),
    stateType: local("Empty"),
    abi,
    slots,
    requiredCapabilities: [],
  });
  return {
    format: 1,
    packageId: "test.writer",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["writer", "parent", "suite", "reload"].map((name) => [
        name,
        { path: "server.mjs", exportName: name, environment: "server" as const },
      ]),
    ),
    definitions: [
      {
        name: "Empty",
        metaType: meta("Type"),
        value: {
          schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
          references: {},
        },
      },
      {
        name: "Config",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["endpoint"],
            properties: { endpoint: { type: "string" } },
          },
          references: {},
        },
      },
      {
        name: "Input",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["text", "mode"],
            properties: {
              text: { type: "string" },
              mode: { enum: ["success", "lost-reply", "hold"] },
            },
          },
          references: {},
        },
      },
      {
        name: "Output",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["externalId"],
            properties: { externalId: { type: "string", minLength: 1 } },
          },
          references: {},
        },
      },
      ...["Write", "Run"].map((name) => ({
        name,
        metaType: meta("Contract"),
        value: {
          operations: { run: { input: local("Input"), output: local("Output"), errorCodes: [] } },
          conformanceSuite: local(`${name}Suite`),
          allowedEffects: name === "Run" ? [local("Write")] : [],
        },
      })),
      ...["Write", "Run"].map((name) => ({
        name: `${name}Suite`,
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local(name) },
      })),
      {
        name: "Writer",
        metaType: meta("Implementation"),
        value: impl("writer", "Write", "Config", "effect-adapter.v1"),
      },
      {
        name: "Parent",
        metaType: meta("Implementation"),
        value: impl("parent", "Run", "Empty", "reducer.v1", [
          { name: "effect", accepts: local("Write"), collection: "single", min: 1, max: 1 },
        ]),
      },
      {
        name: "Root",
        metaType: meta("Implementation"),
        value: impl("parent", "Run", "Empty", "reducer.v1", [
          { name: "parent", accepts: local("Run"), collection: "single", min: 1, max: 1 },
          { name: "sibling", accepts: local("Write"), collection: "single", min: 1, max: 1 },
        ]),
      },
    ],
  };
}
