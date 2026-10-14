import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

const text = { type: "string" };
const name = { type: "string", minLength: 1 };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ref = object({ packageId: name, packageVersion: name, digest: name, name });
const versioned = object({
  object: object({ storeId: name, namespaceId: name, objectId: name, type: ref }),
  revision: name,
});
const spec = object({ name, description: text, inputType: ref, outputType: ref });
export const toolSchemas: Readonly<Record<string, JsonSchema>> = {
  ToolSpec: spec,
  ToolCall: object({ id: name, name, arguments: {} }),
  ToolObservation: object({
    callId: name,
    ok: { type: "boolean" },
    value: {},
    errorCode: { type: ["string", "null"] },
    sources: { type: "array", items: versioned },
  }),
  RouterConfiguration: object({ tools: { type: "array", items: spec } }),
  SingleToolConfiguration: object({ adapterInstanceId: name }),
  FileConfiguration: object({ filesystemBinding: name }),
  ReadInput: object({ path: name }),
  WriteInput: object({
    path: name,
    expectedContentDigest: {
      anyOf: [{ type: "string", pattern: "^sha256:[0-9a-f]{64}$" }, { type: "null" }],
    },
    newContent: text,
  }),
  FileValue: object({ path: name, content: text, contentDigest: name }),
};
export function toolsManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  const implementation = (entry: string, config: string, abi: string, slots: unknown[] = []) =>
    JSON.parse(
      JSON.stringify({
        contracts: [local("Invoke")],
        configurationType: local(config),
        stateType: local("State"),
        entry,
        abi,
        slots,
        requiredCapabilities: abi === "effect-adapter.v1" ? ["filesystem.root"] : [],
      }),
    );
  return {
    format: 1,
    packageId: "std.tools",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "router", "singleTool", "readFile", "writeFile", "suite", "reload"].map(
        (entry) => [
          entry,
          { path: "server.mjs", exportName: entry, environment: "server" as const },
        ],
      ),
    ),
    definitions: [
      ...Object.entries({ ...toolSchemas, State: {} }).map(([name, schema]) => ({
        name,
        metaType: meta("Type"),
        value: { schema, references: {} },
      })),
      {
        name: "Invoke",
        metaType: meta("Contract"),
        value: {
          operations: {
            invoke: {
              input: local("ToolCall"),
              output: local("ToolObservation"),
              errorCodes: ["CAPABILITY_DENIED", "REVISION_CONFLICT"],
            },
          },
          allowedEffects: [local("Invoke")],
          conformanceSuite: local("InvokeSuite"),
        },
      },
      {
        name: "InvokeSuite",
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local("Invoke") },
      },
      {
        name: "Router",
        metaType: meta("Implementation"),
        value: implementation("router", "RouterConfiguration", "reducer.v1", [
          { name: "tools", accepts: local("Invoke"), collection: "keyed", min: 0, max: 1000 },
        ]),
      },
      {
        name: "SingleTool",
        metaType: meta("Implementation"),
        value: implementation("singleTool", "SingleToolConfiguration", "reducer.v1", [
          { name: "adapter", accepts: local("Invoke"), collection: "single", min: 1, max: 1 },
        ]),
      },
      ...["ReadFile", "WriteFile"].map((name) => ({
        name,
        metaType: meta("Implementation"),
        value: implementation(
          name === "ReadFile" ? "readFile" : "writeFile",
          "FileConfiguration",
          "effect-adapter.v1",
        ),
      })),
    ],
  };
}
