import { assertJson } from "../../../packages/abi/src/json.js";
import type {
  DefinitionRef,
  InvocationReceipt,
  InvocationRequest,
  ObjectRecord,
  ObjectRef,
  ProtocolError,
  SubscriptionEvent,
  SubscriptionSnapshot,
} from "../../../specs/fractal-harness/contracts.js";

export interface ApiSubscription {
  snapshot(): SubscriptionSnapshot;
  catchUp(cursor: string): readonly SubscriptionEvent[];
  close(): void;
}
export interface ApiBackend {
  invoke(request: InvocationRequest): Promise<InvocationReceipt>;
  read(ref: ObjectRef, revision?: string): Promise<ObjectRecord>;
  subscribe(namespaceId: string): ApiSubscription;
}
export function invalid(message = "Invalid request"): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT" });
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) invalid();
  return input;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024) invalid();
  return value;
}
export function definitionRef(value: unknown): DefinitionRef {
  const input = record(value, ["packageId", "packageVersion", "digest", "name"]);
  const ref = {
    packageId: string(input.packageId),
    packageVersion: string(input.packageVersion),
    digest: string(input.digest),
    name: string(input.name),
  };
  if (!/^sha256:[0-9a-f]{64}$/.test(ref.digest)) invalid();
  return ref;
}
export function objectRef(value: unknown): ObjectRef {
  const input = record(value, ["storeId", "namespaceId", "objectId", "type"]);
  return {
    storeId: string(input.storeId),
    namespaceId: string(input.namespaceId),
    objectId: string(input.objectId),
    type: definitionRef(input.type),
  };
}
export function invocationRequest(value: unknown): InvocationRequest {
  assertJson(value);
  const input = record(value, [
    "targetInstanceId",
    "assemblyRevision",
    "operation",
    "input",
    "idempotencyKey",
  ]);
  const operation = record(input.operation, ["contract", "operation"]);
  if (!Object.hasOwn(input, "input")) invalid();
  return {
    targetInstanceId: string(input.targetInstanceId),
    assemblyRevision: string(input.assemblyRevision),
    operation: {
      contract: definitionRef(operation.contract),
      operation: string(operation.operation),
    },
    input: input.input as InvocationRequest["input"],
    idempotencyKey: string(input.idempotencyKey),
  };
}
export function subscriptionRequest(value: unknown): string {
  return string(record(value, ["namespaceId"]).namespaceId);
}
const messages: Readonly<Record<string, string>> = {
  INVALID_INPUT: "Invalid request",
  CAPABILITY_DENIED: "Request is not authorized",
  NOT_FOUND: "Object was not found",
  REVISION_CONFLICT: "Revision changed",
  IDEMPOTENCY_CONFLICT: "Key already has a different payload",
  CURSOR_EXPIRED: "Subscription cursor expired",
  DEPENDENCY_UNAVAILABLE: "Service is temporarily unavailable",
};
export function protocolError(error: unknown): ProtocolError {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "DEPENDENCY_UNAVAILABLE";
  return {
    code,
    message: messages[code] ?? "Operation rejected",
    details: null,
    retryable: code === "DEPENDENCY_UNAVAILABLE",
  };
}
export function errorStatus(error: ProtocolError): number {
  return (
    (
      {
        INVALID_INPUT: 400,
        CAPABILITY_DENIED: 403,
        NOT_FOUND: 404,
        REVISION_CONFLICT: 409,
        IDEMPOTENCY_CONFLICT: 409,
        DEPENDENCY_UNAVAILABLE: 503,
      } as Record<string, number>
    )[error.code] ?? 422
  );
}
