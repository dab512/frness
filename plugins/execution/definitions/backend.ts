import type { DefinitionRef, PackageManifest } from "../../../packages/abi/src/index.js";
import { definitionRef } from "./schemas.js";

export function backendManifest(
  meta: (name: string) => DefinitionRef,
  lookup: (packageId: string, name: string) => DefinitionRef,
): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: "std.execution-backend",
    version: "1.0.2",
    hostAbi: "fractal.host.v1",
    dependencies: [
      meta("Type"),
      lookup("std.api", "Backend"),
      lookup("std.store-sqlite", "Store"),
      lookup("std.execution", "Request"),
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
            additionalProperties: false,
            required: ["executionType"],
            properties: { executionType: definitionRef },
          },
          references: {},
        },
      },
      {
        name: "Backend",
        metaType: meta("Implementation"),
        value: {
          contracts: [{ ...lookup("std.api", "Backend") }],
          configurationType: local("Configuration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [
            {
              name: "store",
              accepts: { ...lookup("std.store-sqlite", "Store") },
              collection: "single",
              min: 1,
              max: 1,
            },
          ],
          entry: "factory",
          abi: "factory.v1",
          requiredCapabilities: ["profile.application", "local.subject"],
        },
      },
    ],
  };
}
