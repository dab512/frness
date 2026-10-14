import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { CapabilityBoundExport } from "../../../packages/abi/src/factory.js";
import type {
  InputReceivedValue,
  Json,
  ObjectStore,
  ProtocolError,
  ReducerModule,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost) {
  snapshotType = host.snapshotType;
  return () => {};
}
export const repository: ObjectStore & CapabilityBoundExport = {
  async read() {
    throw new Error("Repository capability is not bound");
  },
  async commit() {
    throw new Error("Repository capability is not bound");
  },
  bindCapabilities(context) {
    if (!context.component) throw new Error("Repository component metadata is missing");
    const configuration = context.component.instance.configuration as { binding: string };
    return (context.capability("repository") as (binding: string) => ObjectStore)(
      configuration.binding,
    );
  },
};
export const proxy: ReducerModule = {
  initialize: () => null,
  reduce(state, event) {
    if (event.type.name === "InputReceived") {
      const request = event.value as unknown as InputReceivedValue;
      const input =
        request.operation.operation === "commit"
          ? {
              batch: {
                ...((request.input as { batch: Json }).batch as Record<string, Json>),
                commitKey: "forward",
              },
            }
          : request.input;
      return {
        state,
        commands: [
          {
            kind: "callChild",
            commandId: "forward",
            slot: "backend",
            operation: request.operation.operation,
            input,
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
export function suite(value: unknown) {
  if (
    !value ||
    !(
      (typeof (value as ObjectStore).read === "function" &&
        typeof (value as ObjectStore).commit === "function") ||
      (typeof (value as ReducerModule).initialize === "function" &&
        typeof (value as ReducerModule).reduce === "function")
    )
  )
    throw new Error("Invalid repository export");
}
export const reload: ReloadParticipant = {
  async capture() {
    return { type: snapshotType, value: null };
  },
  async restore(snapshot) {
    if (snapshot.value !== null) throw new Error("Invalid snapshot");
  },
  async ready() {},
  async dispose() {},
};
