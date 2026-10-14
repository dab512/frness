import type { JsonSchema } from "../../../packages/abi/src/index.js";
import { definitionRef, error, object, objectRef, operationRef } from "./schemas.js";

const string = { type: "string", minLength: 1 };
const nonnegative = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const versioned = object({ object: objectRef, revision: string });
const units = { anyOf: [nonnegative, { type: "null" }] };
const outcome = {
  anyOf: [
    object({ kind: { const: "completed" }, value: {}, actualUnits: units, evidence: {} }),
    object({ kind: { const: "failed_known" }, error, actualUnits: units, evidence: {} }),
    object({ kind: { const: "unknown" }, reason: { type: "string" }, evidence: {} }),
  ],
};
export const effectSchemas: Readonly<Record<string, JsonSchema>> = {
  Effect: object({
    effectId: string,
    invocationId: string,
    adapterInstanceId: string,
    adapter: definitionRef,
    adapterConfiguration: {},
    accountRef: string,
    operation: operationRef,
    input: {},
    inputDigest: string,
    remoteKey: string,
    policy: object({
      strategy: { enum: ["read-only", "idempotency-key", "reconcile", "non-retryable"] },
      maxAttempts: { type: "integer", minimum: 1 },
      idempotencyValidUntil: { type: ["string", "null"] },
    }),
  }),
  Attempt: object({
    attemptId: string,
    effectId: string,
    runnerEpoch: string,
    state: { enum: ["prepared", "dispatched", "completed", "failed_known", "unknown"] },
    reservationId: string,
    result: { anyOf: [versioned, { type: "null" }] },
  }),
  Reservation: object({
    reservationId: string,
    attemptId: string,
    ancestorBudgetIds: { type: "array", items: string, uniqueItems: true },
    unit: string,
    maxUnits: nonnegative,
    actualUnits: units,
    status: { enum: ["reserved", "settled"] },
  }),
  Completion: object({ effectId: string, attemptId: string, outcome }),
  Resolution: object({
    effectId: string,
    result: versioned,
    businessResultDigest: string,
    deliveredEventId: string,
  }),
  EffectCompleted: object({ commandId: string, output: {} }),
  EffectFailed: object({ commandId: string, error }),
  Outbox: object({
    invocation: objectRef,
    commandId: string,
    effect: objectRef,
    attempt: objectRef,
    reservation: objectRef,
    status: { enum: ["prepared", "dispatched", "unknown", "resolved"] },
  }),
  OutboxIndex: object({ objects: { type: "array", items: objectRef, maxItems: 10000 } }),
};
