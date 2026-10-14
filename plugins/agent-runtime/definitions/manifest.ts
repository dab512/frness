import type {
  DefinitionRef,
  JsonSchema,
  PackageManifest,
} from "../../../packages/abi/src/index.js";

const string = { type: "string", minLength: 1 };
const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ref = object({ packageId: string, packageVersion: string, digest: string, name: string });
const objectRef = object({ storeId: string, namespaceId: string, objectId: string, type: ref });
const versioned = object({ object: objectRef, revision: string });
const nullableString = { type: ["string", "null"] };
const error = object({
  code: string,
  message: { type: "string" },
  details: {},
  retryable: { type: "boolean" },
});
const schemas: Readonly<Record<string, JsonSchema>> = {
  Json: {},
  Text: { type: "string" },
  Configuration: object({ workspace: string }),
  ConfigurationSnapshot: object({ adapter: ref, configuration: {} }),
  Workspace: object({ path: string }),
  Session: object({
    adapter: ref,
    configuration: versioned,
    workspace: versioned,
    nativeHandle: nullableString,
    metadata: {},
    activeTurnId: nullableString,
    eventCursor: nullableString,
  }),
  Request: object({
    targetInstanceId: string,
    assemblyRevision: string,
    operation: object({ contract: ref, operation: string }),
    input: {},
    idempotencyKey: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[\\u0000-\\u007f]+$",
    },
  }),
  Receipt: object({ request: objectRef, invocation: objectRef }),
  RunInput: object(
    { prompt: { type: "string" }, session: { anyOf: [objectRef, { type: "null" }] } },
    ["prompt"],
  ),
  ResumeInput: object({ session: objectRef }),
  InterruptInput: object({ turn: objectRef }),
  Turn: object({
    request: objectRef,
    session: objectRef,
    phase: { enum: ["queued", "running", "completed", "failed", "cancelled", "unknown"] },
    text: { type: "string" },
    result: nullableString,
    error: { anyOf: [error, { type: "null" }] },
  }),
  Action: object({
    request: objectRef,
    phase: { enum: ["succeeded", "failed"] },
    result: {},
    error: { anyOf: [error, { type: "null" }] },
  }),
  Event: object({ session: objectRef, turn: objectRef, event: {} }),
  EventLog: object({ sequence: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
  TurnIndex: object({ turns: { type: "array", items: objectRef, maxItems: 10000 } }),
  GateInput: object({
    session: versioned,
    clientTurnId: string,
    prompt: { type: "string" },
    sources: { type: "array", items: versioned },
  }),
  GateDecision: {
    anyOf: [object({ kind: { const: "allow" } }), object({ kind: { const: "deny" }, error })],
  },
  ObservedEvent: object({
    session: objectRef,
    event: object({ object: objectRef, revision: string, value: {} }),
  }),
};
export function agentRuntimeManifest(
  meta: (name: string) => DefinitionRef,
  lookup: (packageId: string, name: string) => DefinitionRef,
): PackageManifest {
  const local = (name: string) => ({ local: name });
  const contracts = [
    {
      name: "Runner",
      operations: {
        run: {
          input: local("RunInput"),
          output: local("Text"),
          errorCodes: ["SESSION_BUSY", "PINNED_DEPENDENCY_MISSING"],
        },
        resume: {
          input: local("ResumeInput"),
          output: local("Session"),
          errorCodes: ["UNSUPPORTED_OPERATION"],
        },
        interrupt: { input: local("InterruptInput"), output: local("Json"), errorCodes: [] },
      },
    },
    {
      name: "ProviderTransport",
      operations: { run: { input: local("RunInput"), output: local("Text"), errorCodes: [] } },
    },
    {
      name: "LaunchGate",
      operations: {
        check: { input: local("GateInput"), output: local("GateDecision"), errorCodes: [] },
      },
    },
    {
      name: "EventObserver",
      operations: {
        observe: { input: local("ObservedEvent"), output: meta("NullSnapshot"), errorCodes: [] },
      },
    },
  ];
  return {
    format: 1,
    packageId: "std.agent-runtime",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type"), lookup("std.api", "Backend"), lookup("std.store-sqlite", "Store")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "factory", "suite", "reload"].map((name) => [
        name,
        { path: "server.mjs", exportName: name, environment: "server" as const },
      ]),
    ),
    definitions: [
      ...Object.entries(schemas).map(([name, schema]) => ({
        name,
        metaType: meta("Type"),
        value: { schema, references: {} },
      })),
      ...contracts.map(({ name, operations }) => ({
        name,
        metaType: meta("Contract"),
        value: {
          operations: JSON.parse(JSON.stringify(operations)),
          conformanceSuite: local(`${name}Suite`),
          allowedEffects: [],
        },
      })),
      ...contracts.map(({ name }) => ({
        name: `${name}Suite`,
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local(name) },
      })),
      {
        name: "Backend",
        metaType: meta("Implementation"),
        value: {
          contracts: [{ ...lookup("std.api", "Backend") }, local("Runner")],
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
            {
              name: "transport",
              accepts: local("ProviderTransport"),
              collection: "single",
              min: 1,
              max: 1,
            },
            {
              name: "launch.policy",
              accepts: local("LaunchGate"),
              collection: "single",
              min: 0,
              max: 1,
            },
            {
              name: "events.observers",
              accepts: local("EventObserver"),
              collection: "keyed",
              min: 0,
              max: 1000,
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
