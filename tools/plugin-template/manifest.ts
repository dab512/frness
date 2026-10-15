import type { DefinitionRef, PackageManifest } from "../../packages/abi/src/index.js";
export function manifest(
  meta: (name: string) => DefinitionRef,
  lookup: (id: string, name: string) => DefinitionRef,
): PackageManifest {
  return {
    format: 1,
    packageId: "local.TEMPLATE",
    version: "0.1.0",
    hostAbi: "fractal.host.v1",
    dependencies: [
      meta("Type"),
      lookup("std.agent-runtime", "EventObserver"),
      lookup("std.store-sqlite", "Store"),
    ],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "factory", "suite", "reload"].map((name) => [
        name,
        { path: "server.mjs", exportName: name, environment: "server" as const },
      ]),
    ),
    definitions: [
      {
        name: "Configuration",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            additionalProperties: false,
          },
          references: {},
        },
      },
      {
        name: "Note",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            properties: {
              sourceId: { type: "string" },
              sourceRevision: { type: "string" },
              phase: { type: "string" },
              label: { type: "string" },
            },
            required: ["sourceId", "sourceRevision", "phase", "label"],
            additionalProperties: false,
          },
          references: {},
        },
      },
      {
        name: "Observer",
        metaType: meta("Implementation"),
        value: {
          contracts: [{ ...lookup("std.agent-runtime", "EventObserver") }],
          configurationType: { local: "Configuration" },
          stateType: { ...meta("NullSnapshot") },
          entry: "factory",
          abi: "factory.v1",
          requiredCapabilities: ["local.subject"],
          slots: [
            {
              name: "store",
              accepts: { ...lookup("std.store-sqlite", "Store") },
              collection: "single",
              min: 1,
              max: 1,
            },
            {
              name: "children",
              accepts: { ...lookup("std.agent-runtime", "EventObserver") },
              collection: "keyed",
              min: 0,
              max: 32,
            },
          ],
        },
      },
    ],
  };
}
