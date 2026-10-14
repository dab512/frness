import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

const text = { type: "string" };
const nonempty = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ref = object({
  packageId: nonempty,
  packageVersion: nonempty,
  digest: nonempty,
  name: nonempty,
});
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
export const modelSchemas: Readonly<Record<string, JsonSchema>> = {
  ModelRequest: object({
    messages: {
      ...array(
        object({
          role: { enum: ["system", "user", "assistant", "tool"] },
          content: text,
          toolCallId: { type: ["string", "null"] },
        }),
      ),
      minItems: 1,
    },
    tools: array(object({ name: nonempty, description: text, inputType: ref, outputType: ref })),
    outputType: { anyOf: [ref, { type: "null" }] },
    maxOutputTokens: { ...integer, minimum: 1 },
  }),
  ModelCompletion: object({
    text,
    structured: {},
    toolCalls: array(object({ id: nonempty, name: nonempty, arguments: {} })),
    finish: { enum: ["stop", "tool_calls"] },
    usage: { anyOf: [object({ inputTokens: integer, outputTokens: integer }), { type: "null" }] },
  }),
  ProviderConfiguration: object({
    endpoint: nonempty,
    model: nonempty,
    credentialBinding: nonempty,
    decoder: { const: "frness.model.ndjson.v1" },
  }),
  GenerateConfiguration: object({ providerInstanceId: nonempty, maxUnits: integer }),
  ProvisionalChunk: object({ kind: { const: "text" }, delta: text }),
};
export function llmManifest(meta: (name: string) => DefinitionRef): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: "std.llm",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "generate", "http", "suite", "reload"].map((name) => [
        name,
        { path: "server.mjs", exportName: name, environment: "server" as const },
      ]),
    ),
    definitions: [
      ...Object.entries(modelSchemas).map(([name, schema]) => ({
        name,
        metaType: meta("Type"),
        value: { schema, references: {} },
      })),
      {
        name: "Generate",
        metaType: meta("Contract"),
        value: {
          operations: {
            generate: {
              input: local("ModelRequest"),
              output: local("ModelCompletion"),
              errorCodes: ["MODEL_CONFIGURATION_MISSING", "INCOMPLETE_RESPONSE", "INVALID_OUTPUT"],
            },
          },
          allowedEffects: [local("Generate")],
          conformanceSuite: local("GenerateSuite"),
        },
      },
      {
        name: "GenerateSuite",
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local("Generate") },
      },
      {
        name: "SingleCall",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Generate")],
          configurationType: local("GenerateConfiguration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [
            { name: "provider", accepts: local("Generate"), collection: "single", min: 1, max: 1 },
          ],
          entry: "generate",
          abi: "reducer.v1",
          requiredCapabilities: [],
        },
      },
      {
        name: "HttpProvider",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Generate")],
          configurationType: local("ProviderConfiguration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [],
          entry: "http",
          abi: "effect-adapter.v1",
          requiredCapabilities: ["credential", "network"],
        },
      },
    ],
  };
}
