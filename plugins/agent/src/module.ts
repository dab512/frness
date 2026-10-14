import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type { CapabilityBoundExport } from "../../../packages/abi/src/factory.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  DefinitionRef,
  ImplementationDefinition,
  InputReceivedValue,
  Json,
  ProtocolError,
  ReducerModule,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { ToolCall } from "../../../specs/fractal-harness/standard-contracts.js";
import { createAgentReducer } from "./loop.js";

export { llmDecide } from "./loop.js";

let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost) {
  snapshotType = host.snapshotType;
  return () => {};
}
export const run: ReducerModule & CapabilityBoundExport = {
  initialize() {
    throw new Error("Agent schemas must be bound before execution");
  },
  reduce() {
    throw new Error("Agent schemas must be bound before execution");
  },
  bindCapabilities(context) {
    if (!context.component) throw new Error("Pinned composition is required");
    const { assembly, instance } = context.component;
    const own = context.registry.get(instance.implementation)
      .value as unknown as ImplementationDefinition;
    const acceptContract = own.slots.find((slot) => slot.name === "accept")?.accepts;
    if (!acceptContract) throw new Error("Acceptance contract is not declared");
    const policy = (id: string): readonly DefinitionRef[] => {
      const node = assembly.instances.find((item) => item.instanceId === id)!;
      const definition = context.registry.get(node.implementation)
        .value as unknown as ImplementationDefinition;
      const slots = definition.slots
        .filter((slot) => definitionKey(slot.accepts) === definitionKey(acceptContract))
        .map((slot) => slot.name);
      const children = assembly.bindings
        .filter((item) => item.parentInstanceId === id && slots.includes(item.slot))
        .flatMap((item) => policy(item.childInstanceId));
      const exportsAccept = definition.contracts.some(
        (ref) => definitionKey(ref) === definitionKey(acceptContract),
      );
      return children.length ? children : exportsAccept ? [node.implementation] : [];
    };
    const accept = assembly.bindings.find(
      (binding) => binding.parentInstanceId === instance.instanceId && binding.slot === "accept",
    );
    if (!accept) throw new Error("Required acceptance binding is missing");
    const required = policy(accept.childInstanceId);
    if (new Set(required.map(definitionKey)).size !== required.length)
      throw new Error("Required verifier implementations must have distinct pinned refs");
    const typeMeta = context.registry.get(own.configurationType).metaType;
    return createAgentReducer(
      (type, value) => context.registry.validate(type, value),
      required,
      (type) => {
        if (definitionKey(context.registry.get(type).metaType) !== definitionKey(typeMeta))
          throw new Error("Task outputType must refer to a registered Type");
      },
    );
  },
};
export const agentTool: ReducerModule = {
  initialize(input) {
    return (input as unknown as ToolCall).id;
  },
  reduce(state, event) {
    if (event.type.name === "InputReceived") {
      const call = (event.value as unknown as InputReceivedValue).input as unknown as ToolCall;
      return {
        state,
        commands: [
          {
            kind: "callChild",
            commandId: "agent",
            slot: "agent",
            operation: "run",
            input: call.arguments,
          },
        ],
      };
    }
    if (event.type.name === "ChildCompleted")
      return {
        state,
        commands: [
          {
            kind: "complete",
            output: {
              callId: state,
              ok: true,
              value: (event.value as { output: Json }).output,
              errorCode: null,
              sources: [],
            },
          },
        ],
      };
    if (event.type.name === "ChildFailed")
      return {
        state,
        commands: [
          {
            kind: "complete",
            output: {
              callId: state,
              ok: false,
              value: null,
              errorCode: (event.value as unknown as { error: ProtocolError }).error.code,
              sources: [],
            },
          },
        ],
      };
    return { state, commands: [] };
  },
};
export function suite(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid agent export");
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
