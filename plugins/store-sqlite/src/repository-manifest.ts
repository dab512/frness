import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

const text = { type: "string", minLength: 1 };
const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ref = object({ packageId: text, packageVersion: text, digest: text, name: text });
const objectRef = object({ storeId: text, namespaceId: text, objectId: text, type: ref });
const versioned = object({ object: objectRef, revision: text });
const writes = {
  type: "array",
  maxItems: 1000,
  items: {
    anyOf: [
      object({ kind: { const: "create" }, object: objectRef, value: {}, revision: text }, [
        "kind",
        "object",
        "value",
      ]),
      object(
        {
          kind: { const: "replace" },
          object: objectRef,
          expectedRevision: text,
          value: {},
          revision: text,
        },
        ["kind", "object", "expectedRevision", "value"],
      ),
      object(
        { kind: { const: "tombstone" }, object: objectRef, expectedRevision: text, revision: text },
        ["kind", "object", "expectedRevision"],
      ),
    ],
  },
};
export function repositoryManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  const schemas: Readonly<Record<string, JsonSchema>> = {
    Configuration: object({ binding: text }),
    Read: object({ object: objectRef, revision: text }, ["object"]),
    Record: object({ object: objectRef, revision: text, value: {} }),
    Commit: object({
      batch: object({
        commitKey: text,
        readSet: { type: "array", items: versioned },
        writes,
        events: { type: "array", items: object({ eventId: text, type: ref, value: {} }) },
      }),
    }),
    Receipt: object({ commitId: text, records: { type: "array", items: versioned }, cursor: text }),
  };
  return {
    format: 1,
    packageId: "std.storage",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "repository", "proxy", "suite", "reload"].map((entry) => [
        entry,
        { path: "server.mjs", exportName: entry, environment: "server" as const },
      ]),
    ),
    definitions: [
      ...Object.entries(schemas).map(([name, schema]) => ({
        name,
        metaType: meta("Type"),
        value: { schema, references: {} },
      })),
      {
        name: "Repository",
        metaType: meta("Contract"),
        value: {
          operations: {
            read: {
              input: local("Read"),
              output: local("Record"),
              errorCodes: ["NOT_FOUND", "CAPABILITY_DENIED"],
            },
            commit: {
              input: local("Commit"),
              output: local("Receipt"),
              errorCodes: ["REVISION_CONFLICT", "CAPABILITY_DENIED"],
            },
          },
          allowedEffects: [],
          conformanceSuite: local("RepositorySuite"),
        },
      },
      {
        name: "RepositorySuite",
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local("Repository") },
      },
      {
        name: "LocalRepository",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Repository")],
          configurationType: local("Configuration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [],
          entry: "repository",
          abi: "store.v1",
          requiredCapabilities: ["repository"],
        },
      },
      {
        name: "Proxy",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Repository")],
          configurationType: { ...meta("NullSnapshot") },
          stateType: { ...meta("NullSnapshot") },
          entry: "proxy",
          abi: "reducer.v1",
          requiredCapabilities: [],
          slots: [
            { name: "backend", accepts: local("Repository"), collection: "single", min: 1, max: 1 },
          ],
        },
      },
    ],
  };
}
