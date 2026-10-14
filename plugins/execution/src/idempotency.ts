import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  ExecutionContext,
  InvocationRequest,
} from "../../../specs/fractal-harness/contracts.js";
import { executionError } from "./reducer.js";

export function invocationIdentity(
  context: ExecutionContext,
  request: InvocationRequest,
): { id: string; bodyDigest: string } {
  if (!/^[\x00-\x7f]{1,128}$/.test(request.idempotencyKey))
    throw executionError("INVALID_INPUT", "Invocation key must contain 1 to 128 ASCII characters");
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  return {
    id: hash([
      context.principalId,
      context.scopeId,
      request.targetInstanceId,
      request.operation,
      request.idempotencyKey,
    ]),
    bodyDigest: `sha256:${hash({ target: request.targetInstanceId, operation: request.operation, input: request.input, assemblyRevision: request.assemblyRevision })}`,
  };
}
