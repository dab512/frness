import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type {
  InputReceivedValue,
  Json,
  ProtocolError,
  ReducerModule,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost) {
  snapshotType = host.snapshotType;
  return () => {};
}
export const parent: ReducerModule = {
  initialize: () => null,
  reduce(state, event) {
    if (event.type.name === "InputReceived") {
      const input = (event.value as unknown as InputReceivedValue).input as {
        commandId?: string;
        operation: string;
        input: Json;
      };
      return {
        state,
        commands: [
          {
            kind: "callChild",
            commandId: input.commandId ?? "repo",
            slot: "repository",
            operation: input.operation,
            input: input.input,
          },
        ],
      };
    }
    if (event.type.name === "ChildCompleted")
      return {
        state,
        commands: [{ kind: "complete", output: (event.value as { output: Json }).output }],
      };
    if (event.type.name === "ChildFailed")
      return {
        state,
        commands: [
          { kind: "fail", error: (event.value as unknown as { error: ProtocolError }).error },
        ],
      };
    return { state, commands: [] };
  },
};
export const reload = {
  async capture() {
    return { type: snapshotType, value: null };
  },
  async restore() {},
  async ready() {},
  async dispose() {},
};
export function suite(value: unknown) {
  if (
    !value ||
    typeof (value as ReducerModule).initialize !== "function" ||
    typeof (value as ReducerModule).reduce !== "function"
  )
    throw new Error("Invalid fixture reducer");
}
