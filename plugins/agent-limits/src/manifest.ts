import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

const string = { type: "string", minLength: 1 };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ref = object({ packageId: string, packageVersion: string, digest: string, name: string });
const objectRef = object({ storeId: string, namespaceId: string, objectId: string, type: ref });
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
export function limitsManifest(
  meta: (name: string) => DefinitionRef,
  lookup: (packageId: string, name: string) => DefinitionRef,
): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: "std.agent-limits",
    version: "1.0.1",
    hostAbi: "fractal.host.v1",
    dependencies: [
      meta("Type"),
      lookup("std.agent-runtime", "LaunchGate"),
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
        value: { schema: object({ maxRuns: integer }), references: {} },
      },
      {
        name: "State",
        metaType: meta("Type"),
        value: { schema: object({ admitted: integer }), references: {} },
      },
      {
        name: "Reservation",
        metaType: meta("Type"),
        value: {
          schema: object({
            session: objectRef,
            clientTurnId: string,
            decision: { $ref: "type:Decision" },
          }),
          references: { Decision: { ...lookup("std.agent-runtime", "GateDecision") } },
        },
      },
      {
        name: "Gate",
        metaType: meta("Implementation"),
        value: {
          contracts: [{ ...lookup("std.agent-runtime", "LaunchGate") }],
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
          requiredCapabilities: ["local.subject"],
        },
      },
    ],
  };
}
