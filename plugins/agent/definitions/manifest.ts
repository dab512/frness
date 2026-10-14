import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

const text = { type: "string" };
const name = { type: "string", minLength: 1 };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const ref = object({ packageId: name, packageVersion: name, digest: name, name });
const versioned = object({
  object: object({ storeId: name, namespaceId: name, objectId: name, type: ref }),
  revision: name,
});
const task = object({
  goal: name,
  constraints: array(text),
  sources: array(versioned),
  outputType: ref,
});
const call = object({ id: name, name, arguments: {} });
const candidate = object({ value: {}, type: ref, sources: array(versioned), digest: name });
const verification = object({
  candidateDigest: name,
  verifier: ref,
  verdict: { enum: ["accept", "revise", "reject", "inconclusive"] },
  feedback: array(text),
  evidence: array(versioned),
});
const observation = object({
  callId: name,
  ok: { type: "boolean" },
  value: {},
  errorCode: { type: ["string", "null"] },
  sources: array(versioned),
});
const context = object({
  messages: array(
    object({
      role: { enum: ["system", "user", "assistant", "tool"] },
      content: text,
      toolCallId: { type: ["string", "null"] },
    }),
  ),
  sources: array(versioned),
  omittedSources: array(versioned),
});
const accepted = object({ candidate, verifications: array(verification), warnings: array(text) });
const schemas: Readonly<Record<string, JsonSchema>> = {
  AgentTask: task,
  ToolState: text,
  Candidate: candidate,
  Verification: verification,
  Verifications: array(verification),
  AcceptedResult: accepted,
  ContextBundle: context,
  ContextInput: object({ task, observations: array(observation), feedback: array(text) }),
  DecideInput: object({ task, context }),
  AcceptInput: object({ task, candidate }),
  RememberOutput: array(versioned),
  UserInput: object({ text: name }),
  Decision: {
    oneOf: [
      object({ kind: { const: "actions" }, calls: { ...array(call), minItems: 1 } }),
      object({ kind: { const: "candidate" }, value: {} }),
      object({ kind: { const: "needInput" }, question: name, inputType: ref }),
      object({ kind: { const: "blocked" }, reason: name }),
    ],
  },
  Configuration: object({
    requiredVerifiers: { ...array(ref), minItems: 1, uniqueItems: true },
    remember: { type: "boolean" },
    blockedInputType: ref,
  }),
  LlmConfiguration: object({ decisionType: ref, maxOutputTokens: { ...integer, minimum: 1 } }),
  State: object({
    task,
    phase: {
      enum: [
        "buildingContext",
        "deciding",
        "acting",
        "checking",
        "remembering",
        "awaitingInput",
        "done",
      ],
    },
    iteration: integer,
    pending: text,
    context: { anyOf: [context, { type: "null" }] },
    observations: array(observation),
    feedback: array(text),
    calls: array(call),
    callIndex: integer,
    seenCalls: { type: "object", additionalProperties: object({ call, observation }) },
    candidate: { anyOf: [candidate, { type: "null" }] },
    verifications: array(verification),
    warnings: array(text),
  }),
};
export function agentManifest(
  meta: (name: string) => DefinitionRef,
  lookup: (packageId: string, name: string) => DefinitionRef,
): PackageManifest {
  const local = (name: string) => ({ local: name });
  const contracts = [
    ["Run", "run", "AgentTask", "AcceptedResult"],
    ["Context", "build", "ContextInput", "ContextBundle"],
    ["Decide", "decide", "DecideInput", "Decision"],
    ["Accept", "check", "AcceptInput", "Verifications"],
    ["Remember", "remember", "AcceptedResult", "RememberOutput"],
  ] as const;
  const slot = (name: string, accepts: unknown, min = 1) => ({
    name,
    accepts,
    collection: "single",
    min,
    max: 1,
  });
  return {
    format: 1,
    packageId: "std.agent",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type"), lookup("std.tools", "Invoke"), lookup("std.llm", "Generate")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "run", "llmDecide", "agentTool", "suite", "reload"].map((entry) => [
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
      ...contracts.flatMap(([name, operation, input, output]) => [
        {
          name,
          metaType: meta("Contract"),
          value: {
            operations: {
              [operation]: {
                input: local(input),
                output: local(output),
                errorCodes: ["BUDGET_EXCEEDED", "VERIFICATION_REQUIRED", "INVALID_OUTPUT"],
              },
            },
            conformanceSuite: local(`${name}Suite`),
            allowedEffects: [],
          },
        },
        {
          name: `${name}Suite`,
          metaType: meta("ConformanceSuite"),
          value: { targetContract: local(name), entry: "suite" },
        },
      ]),
      {
        name: "Loop",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Run")],
          configurationType: local("Configuration"),
          stateType: local("State"),
          entry: "run",
          abi: "reducer.v1",
          requiredCapabilities: [],
          slots: JSON.parse(
            JSON.stringify([
              slot("context", local("Context")),
              slot("decide", local("Decide")),
              slot("actions", lookup("std.tools", "Invoke")),
              slot("accept", local("Accept")),
              slot("remember", local("Remember"), 0),
            ]),
          ),
        },
      },
      {
        name: "LlmDecision",
        metaType: meta("Implementation"),
        value: {
          contracts: [local("Decide")],
          configurationType: local("LlmConfiguration"),
          stateType: { ...meta("NullSnapshot") },
          entry: "llmDecide",
          abi: "reducer.v1",
          requiredCapabilities: [],
          slots: JSON.parse(JSON.stringify([slot("llm", lookup("std.llm", "Generate"))])),
        },
      },
      {
        name: "AgentTool",
        metaType: meta("Implementation"),
        value: {
          contracts: [{ ...lookup("std.tools", "Invoke") }],
          configurationType: { ...meta("NullSnapshot") },
          stateType: local("ToolState"),
          entry: "agentTool",
          abi: "reducer.v1",
          requiredCapabilities: [],
          slots: JSON.parse(JSON.stringify([slot("agent", local("Run"))])),
        },
      },
    ],
  };
}
