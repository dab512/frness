import type { JsonSchema } from "../../../packages/abi/src/index.js";

const string = { type: "string", minLength: 1 };
const json = {};
export const object = (
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const list = (items: JsonSchema): JsonSchema => ({ type: "array", items, maxItems: 1000 });
export const definitionRef = object({
  packageId: string,
  packageVersion: string,
  digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
  name: string,
});
export const objectRef = object({
  storeId: string,
  namespaceId: string,
  objectId: string,
  type: definitionRef,
});
export const operationRef = object({ contract: definitionRef, operation: string });
export const error = object({
  code: string,
  message: { type: "string" },
  details: json,
  retryable: { type: "boolean" },
});
const nullableError = { anyOf: [error, { type: "null" }] };
export const command: JsonSchema = {
  anyOf: [
    object(
      {
        kind: { const: "callChild" },
        commandId: string,
        slot: string,
        childKey: string,
        childOrder: { type: "integer", minimum: 0 },
        operation: string,
        input: json,
      },
      ["kind", "commandId", "slot", "operation", "input"],
    ),
    object({
      kind: { const: "effect" },
      commandId: string,
      adapterInstanceId: string,
      operation: operationRef,
      input: json,
      maxUnits: { type: "number", minimum: 0 },
    }),
    object({ kind: { const: "awaitInput" }, commandId: string, inputType: definitionRef }),
    object({ kind: { const: "complete" }, output: json }),
    object({ kind: { const: "fail" }, error }),
  ],
};
const event = object({ eventId: string, type: definitionRef, value: json });

export const executionSchemas: Readonly<Record<string, JsonSchema>> = {
  Command: command,
  Request: object({
    targetInstanceId: string,
    assemblyRevision: string,
    operation: operationRef,
    input: json,
    idempotencyKey: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[\\u0000-\\u007f]+$",
    },
  }),
  Invocation: object({
    ref: objectRef,
    phase: { enum: ["queued", "active", "waiting", "succeeded", "failed", "cancelled"] },
    control: { enum: ["running", "paused", "cancel_requested"] },
    waitingReason: { enum: ["effect", "child", "input", "indeterminate", null] },
    unresolvedEffectIds: { ...list(string), uniqueItems: true },
    result: json,
    error: nullableError,
  }),
  State: object({
    invocation: objectRef,
    request: objectRef,
    implementation: definitionRef,
    configuration: json,
    state: json,
    steps: { type: "integer", minimum: 0 },
    pendingCommands: { ...list(string), uniqueItems: true },
    issuedCommands: { ...list(string), uniqueItems: true },
    parentInvocation: { anyOf: [objectRef, { type: "null" }] },
    depth: { type: "integer", minimum: 0 },
  }),
  InputReceived: object({ invocation: objectRef, operation: operationRef, input: json }),
  ChildCompleted: object({ commandId: string, output: json }),
  ChildFailed: object({ commandId: string, error }),
  Inbox: object({
    invocation: objectRef,
    event,
    consumed: { type: "boolean" },
    error: nullableError,
  }),
  Commands: object({ invocation: objectRef, eventId: string, commands: list(command) }),
  ChildLink: object({
    parent: objectRef,
    commandId: string,
    child: objectRef,
    delivered: { type: "boolean" },
  }),
  Receipt: object({ request: objectRef, invocation: objectRef }),
};
