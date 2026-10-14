import type { AttemptRecord, EffectDefinition } from "../../../specs/fractal-harness/contracts.js";
import { executionError } from "./reducer.js";

export type RetryDecision = {
  readonly kind: "retry" | "reconcile" | "hold";
  readonly reason: string;
};
/** The caller supplies recorded time; the policy never reads a live clock. */
export function evaluateRetry(
  effect: EffectDefinition,
  attempts: readonly AttemptRecord[],
  now: string,
): RetryDecision {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp))
    throw executionError("INVALID_INPUT", "Retry requires recorded valid time");
  if (!attempts.length || attempts.some((attempt) => attempt.effectId !== effect.effectId))
    throw executionError("INVALID_INPUT", "Attempts do not belong to effect");
  if (attempts.some((attempt) => ["prepared", "dispatched", "completed"].includes(attempt.state)))
    return { kind: "hold", reason: "An attempt is pending or has completed" };
  if (effect.policy.strategy === "reconcile")
    return { kind: "reconcile", reason: "Only reading prior evidence is allowed" };
  if (effect.policy.strategy === "non-retryable")
    return { kind: "hold", reason: "Pinned effect cannot be retried" };
  if (attempts.length >= effect.policy.maxAttempts)
    return { kind: "hold", reason: "Maximum physical attempts reached" };
  if (
    effect.policy.strategy === "idempotency-key" &&
    (effect.policy.idempotencyValidUntil === null ||
      timestamp >= Date.parse(effect.policy.idempotencyValidUntil))
  )
    return { kind: "hold", reason: "Native idempotency window is unavailable or expired" };
  return { kind: "retry", reason: "Pinned policy permits a new physical attempt" };
}
