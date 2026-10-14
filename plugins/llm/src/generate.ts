import type {
  Json,
  OperationRef,
  ProtocolError,
  ReducerModule,
} from "../../../specs/fractal-harness/contracts.js";

/** One reducer command, one provider effect; session/project concepts are absent. */
export const generate: ReducerModule = {
  initialize: () => null,
  reduce(state, event, config) {
    if (event.type.name === "EffectCompleted")
      return {
        state,
        commands: [{ kind: "complete", output: (event.value as { output: Json }).output }],
      };
    if (event.type.name === "EffectFailed")
      return {
        state,
        commands: [
          { kind: "fail", error: (event.value as unknown as { error: ProtocolError }).error },
        ],
      };
    if (event.type.name !== "InputReceived") return { state, commands: [] };
    const configuration = config as { providerInstanceId: string; maxUnits: number };
    const input = event.value as unknown as { operation: OperationRef; input: Json };
    return {
      state,
      commands: [
        {
          kind: "effect",
          commandId: "generate",
          adapterInstanceId: configuration.providerInstanceId,
          operation: { contract: input.operation.contract, operation: "generate" },
          input: input.input,
          maxUnits: configuration.maxUnits,
        },
      ],
    };
  },
};
