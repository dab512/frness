import type {
  InputReceivedValue,
  Json,
  ProtocolError,
  ReducerModule,
} from "../../../specs/fractal-harness/contracts.js";
import type {
  ToolCall,
  ToolObservation,
  ToolSpec,
} from "../../../specs/fractal-harness/standard-contracts.js";
import { failedObservation, validateCall, validateObservation } from "./router.js";

export function createRouterReducer(validate: Parameters<typeof validateCall>[2]): ReducerModule {
  return {
    initialize: () => null,
    reduce(state, event, configuration) {
      const specs = (configuration as unknown as { tools: readonly ToolSpec[] }).tools;
      if (event.type.name === "InputReceived") {
        const call = (event.value as unknown as { input: ToolCall }).input;
        try {
          validateCall(call, specs, validate);
        } catch {
          return {
            state,
            commands: [
              {
                kind: "complete",
                output: failedObservation(call.id, "INVALID_INPUT") as unknown as Json,
              },
            ],
          };
        }
        return {
          state: call as unknown as Json,
          commands: [
            {
              kind: "callChild",
              commandId: "invoke",
              slot: "tools",
              childKey: call.name,
              operation: "invoke",
              input: call as unknown as Json,
            },
          ],
        };
      }
      const call = state as unknown as ToolCall;
      if (event.type.name === "ChildCompleted") {
        const observation = (event.value as unknown as { output: ToolObservation }).output;
        try {
          validateObservation(
            call,
            specs.find((item) => item.name === call.name)!,
            observation,
            validate,
          );
        } catch {
          return {
            state,
            commands: [
              {
                kind: "complete",
                output: failedObservation(call.id, "INVALID_OUTPUT") as unknown as Json,
              },
            ],
          };
        }
        return { state, commands: [{ kind: "complete", output: observation as unknown as Json }] };
      }
      if (event.type.name === "ChildFailed")
        return {
          state,
          commands: [
            {
              kind: "complete",
              output: failedObservation(call.id, "TOOL_OUTCOME_UNKNOWN") as unknown as Json,
            },
          ],
        };
      return { state, commands: [] };
    },
  };
}

export const singleTool: ReducerModule = {
  initialize: () => null,
  reduce(state, event, configuration) {
    if (event.type.name === "InputReceived") {
      const input = event.value as unknown as InputReceivedValue;
      const config = configuration as { adapterInstanceId: string };
      return {
        state,
        commands: [
          {
            kind: "effect",
            commandId: "invoke",
            adapterInstanceId: config.adapterInstanceId,
            operation: { contract: input.operation.contract, operation: "invoke" },
            input: input.input,
            maxUnits: 0,
          },
        ],
      };
    }
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
    return { state, commands: [] };
  },
};
