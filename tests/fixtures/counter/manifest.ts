import type { DefinitionRef, PackageManifest } from "../../../packages/abi/src/index.js";

export function counterManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: "test.counter",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: {
      counter: { path: "server.mjs", exportName: "counter", environment: "server" },
      suite: { path: "server.mjs", exportName: "suite", environment: "server" },
      reload: { path: "server.mjs", exportName: "reload", environment: "server" },
    },
    definitions: [
      {
        name: "Config",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["mode"],
            properties: {
              mode: { enum: ["counter", "child", "parent", "throw", "mixed", "invalid-init"] },
            },
          },
          references: {},
        },
      },
      {
        name: "State",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["count"],
            properties: { count: { type: "integer" } },
          },
          references: {},
        },
      },
      {
        name: "Number",
        metaType: meta("Type"),
        value: { schema: { type: "integer" }, references: {} },
      },
      {
        name: "Counter",
        metaType: meta("Contract"),
        value: {
          operations: { run: { input: local("Number"), output: local("Number"), errorCodes: [] } },
          conformanceSuite: local("Suite"),
          allowedEffects: [],
        },
      },
      {
        name: "Suite",
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local("Counter") },
      },
      {
        name: "Reducer",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Counter")],
          configurationType: local("Config"),
          stateType: local("State"),
          slots: [
            { name: "body", accepts: local("Counter"), collection: "single", min: 0, max: 1 },
            { name: "extras", accepts: local("Counter"), collection: "ordered", min: 0, max: 10 },
          ],
          entry: "counter",
          abi: "reducer.v1",
          requiredCapabilities: [],
        },
      },
    ],
  };
}
