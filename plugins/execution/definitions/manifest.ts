import type { DefinitionRef, PackageManifest } from "../../../packages/abi/src/index.js";
import { executionSchemas } from "./schemas.js";

export function executionManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  return {
    format: 1,
    packageId: "std.execution",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: { reload: { path: "server.mjs", exportName: "reload", environment: "server" } },
    definitions: Object.entries(executionSchemas).map(([name, schema]) => ({
      name,
      metaType: meta("Type"),
      value: { schema, references: {} },
    })),
  };
}
