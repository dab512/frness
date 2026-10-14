import type { EffectAdapter, Json } from "../../../specs/fractal-harness/contracts.js";
import type { ModelRequest } from "../../../specs/fractal-harness/standard-contracts.js";
import { createModelProvider, type ModelProviderOptions } from "./provider.js";

/** The composition root injects scoped capabilities; neither credentials nor clients are persisted. */
export function modelEffectAdapter(options: ModelProviderOptions): EffectAdapter {
  return {
    async execute({ effect }) {
      const provisional: Json[] = [];
      const provider = createModelProvider({
        ...options,
        provisional: async (chunk) => {
          provisional.push({ kind: chunk.kind, delta: chunk.delta });
          await options.provisional?.(chunk);
        },
      });
      try {
        const value = await provider.generate(
          effect.input as unknown as ModelRequest,
          effect.adapterConfiguration,
        );
        return {
          kind: "completed",
          value: value as unknown as Json,
          actualUnits: null,
          evidence: { provisional },
        };
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["DEPENDENCY_UNAVAILABLE", "INVALID_INPUT"].includes(String(error.code))
        ) {
          return {
            kind: "failed_known",
            error: {
              code: String(error.code),
              message: "Model request was rejected before transport",
              details: null,
              retryable: false,
            },
            actualUnits: 0,
            evidence: null,
          };
        }
        // Even an invalid/truncated response may have incurred a provider charge.
        return {
          kind: "unknown",
          reason: "Model call has no validated authoritative completion",
          evidence: { provisional },
        };
      }
    },
    async reconcile() {
      return {
        kind: "unknown",
        reason: "This provider has no reconciliation protocol",
        evidence: null,
      };
    },
  };
}
