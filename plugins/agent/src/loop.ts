import { canonicalJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  DefinitionRef,
  InputReceivedValue,
  Json,
  ProtocolError,
  ReducerModule,
  ReducerResult,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type {
  AgentTask,
  Candidate,
  ContextBundle,
  Decision,
  ToolCall,
  ToolObservation,
  Verification,
} from "../../../specs/fractal-harness/standard-contracts.js";
import { acceptCandidate, makeCandidate, verificationFeedback } from "./verification.js";

interface RunState {
  task: AgentTask;
  phase:
    | "buildingContext"
    | "deciding"
    | "acting"
    | "checking"
    | "remembering"
    | "awaitingInput"
    | "done";
  iteration: number;
  pending: string;
  context: ContextBundle | null;
  observations: ToolObservation[];
  feedback: string[];
  calls: readonly ToolCall[];
  callIndex: number;
  seenCalls: Record<string, { call: ToolCall; observation: ToolObservation }>;
  candidate: Candidate | null;
  verifications: readonly Verification[];
  warnings: string[];
}
interface Configuration {
  requiredVerifiers: readonly DefinitionRef[];
  remember: boolean;
  blockedInputType: TypeRef;
}
const json = (value: unknown): Json => JSON.parse(canonicalJson(value));
const fail = (state: RunState, code: string): ReducerResult => ({
  state: json(state),
  commands: [
    {
      kind: "fail",
      error: { code, message: "Agent could not advance safely", details: null, retryable: false },
    },
  ],
});
function child(
  state: RunState,
  slot: string,
  operation: string,
  input: unknown,
  suffix: string,
): ReducerResult {
  const pending = `${state.iteration}/${suffix}`;
  return {
    state: json({ ...state, pending }),
    commands: [{ kind: "callChild", commandId: pending, slot, operation, input: json(input) }],
  };
}
function context(state: RunState): ReducerResult {
  if (!Number.isSafeInteger(state.iteration)) return fail(state, "BUDGET_EXCEEDED");
  return child(
    { ...state, phase: "buildingContext" },
    "context",
    "build",
    { task: state.task, observations: state.observations, feedback: state.feedback },
    "context",
  );
}
function actions(state: RunState): ReducerResult {
  let next = state;
  while (next.callIndex < next.calls.length) {
    const call = next.calls[next.callIndex]!;
    const old = Object.hasOwn(next.seenCalls, call.id) ? next.seenCalls[call.id] : undefined;
    if (!old)
      return child(
        { ...next, phase: "acting" },
        "actions",
        "invoke",
        call,
        `tool/${next.callIndex}`,
      );
    if (canonicalJson(old.call) !== canonicalJson(call)) return fail(next, "IDEMPOTENCY_CONFLICT");
    next = {
      ...next,
      observations: [...next.observations, old.observation],
      callIndex: next.callIndex + 1,
    };
  }
  return context({ ...next, iteration: next.iteration + 1 });
}
function complete(state: RunState, configuration: Configuration): ReducerResult {
  if (!state.candidate) return fail(state, "VERIFICATION_REQUIRED");
  try {
    const accepted = acceptCandidate(
      state.candidate,
      state.verifications,
      configuration.requiredVerifiers,
      state.warnings,
    );
    return {
      state: json({ ...state, phase: "done", pending: "" }),
      commands: [{ kind: "complete", output: json(accepted) }],
    };
  } catch {
    return fail(state, "VERIFICATION_REQUIRED");
  }
}

/** Durable progress lives in execution.State; all I/O is expressed as child commands. */
export function createAgentReducer(
  validate: (type: TypeRef, value: unknown) => void,
  requiredVerifiers: readonly DefinitionRef[],
  resolveType: (type: TypeRef) => void,
): ReducerModule {
  return {
    initialize(input, configuration) {
      const task = input as unknown as AgentTask;
      const config = configuration as unknown as Configuration;
      resolveType(task.outputType);
      if (
        requiredVerifiers.length === 0 ||
        canonicalJson(config.requiredVerifiers.map(definitionKey).sort()) !==
          canonicalJson(requiredVerifiers.map(definitionKey).sort())
      )
        throw new Error("Required verifier set must match the pinned acceptance subtree");
      return json({
        task,
        phase: "buildingContext",
        iteration: 0,
        pending: "",
        context: null,
        observations: [],
        feedback: [],
        calls: [],
        callIndex: 0,
        seenCalls: {},
        candidate: null,
        verifications: [],
        warnings: [],
      } satisfies RunState);
    },
    reduce(input, event, configuration) {
      const state = input as unknown as RunState;
      const config = { ...(configuration as unknown as Configuration), requiredVerifiers };
      if (event.type.name === "InputReceived") return context(state);
      if (event.type.name === "InputProvided" && state.phase === "awaitingInput") {
        const reply = (event.value as { input: Json }).input;
        return context({
          ...state,
          iteration: state.iteration + 1,
          feedback: [...state.feedback, `User input: ${canonicalJson(reply)}`],
        });
      }
      if (!["ChildCompleted", "ChildFailed"].includes(event.type.name))
        return { state: input, commands: [] };
      const delivery = event.value as unknown as {
        commandId: string;
        output: unknown;
        error: ProtocolError;
      };
      if (delivery.commandId !== state.pending) return { state: input, commands: [] };
      if (event.type.name === "ChildFailed") {
        if (state.phase === "remembering")
          return complete(
            { ...state, warnings: [...state.warnings, "Accepted result was not remembered"] },
            config,
          );
        return { state: input, commands: [{ kind: "fail", error: delivery.error }] };
      }
      if (state.phase === "buildingContext") {
        const bundle = delivery.output as ContextBundle;
        return child(
          { ...state, phase: "deciding", context: bundle },
          "decide",
          "decide",
          { task: state.task, context: bundle },
          "decide",
        );
      }
      if (state.phase === "deciding") {
        const decision = delivery.output as Decision;
        if (decision.kind === "actions") {
          if (
            !decision.calls.length ||
            new Set(decision.calls.map((call) => call.id)).size !== decision.calls.length
          )
            return fail(state, "INVALID_INPUT");
          return actions({ ...state, calls: decision.calls, callIndex: 0 });
        }
        if (decision.kind === "candidate") {
          try {
            validate(state.task.outputType, decision.value);
          } catch {
            return fail(state, "INVALID_OUTPUT");
          }
          const sources = [...state.task.sources, ...(state.context?.sources ?? [])].filter(
            (source, index, all) =>
              all.findIndex((item) => canonicalJson(item) === canonicalJson(source)) === index,
          );
          const candidate = makeCandidate(decision.value, state.task.outputType, sources);
          return child(
            { ...state, phase: "checking", candidate, verifications: [] },
            "accept",
            "check",
            { task: state.task, candidate },
            "accept",
          );
        }
        const question = decision.kind === "needInput" ? decision.question : decision.reason;
        const inputType =
          decision.kind === "needInput" ? decision.inputType : config.blockedInputType;
        const commandId = `${state.iteration}/input`;
        return {
          state: json({
            ...state,
            phase: "awaitingInput",
            pending: commandId,
            feedback: [...state.feedback, question],
          }),
          commands: [{ kind: "awaitInput", commandId, inputType }],
        };
      }
      if (state.phase === "acting") {
        const call = state.calls[state.callIndex]!;
        const observation = delivery.output as ToolObservation;
        if (observation.callId !== call.id) return fail(state, "INVALID_OUTPUT");
        return actions({
          ...state,
          callIndex: state.callIndex + 1,
          observations: [...state.observations, observation],
          seenCalls: { ...state.seenCalls, [call.id]: { call, observation } },
        });
      }
      if (state.phase === "checking") {
        if (!state.candidate) return fail(state, "VERIFICATION_REQUIRED");
        const verifications = delivery.output as readonly Verification[];
        const feedback = verificationFeedback(
          state.candidate,
          verifications,
          config.requiredVerifiers,
        );
        const checked = { ...state, verifications };
        if (feedback.length)
          return context({
            ...checked,
            iteration: state.iteration + 1,
            feedback: [...state.feedback, ...feedback],
          });
        if (config.remember)
          return child(
            { ...checked, phase: "remembering" },
            "remember",
            "remember",
            acceptCandidate(state.candidate, verifications, config.requiredVerifiers),
            "remember",
          );
        return complete(checked, config);
      }
      if (state.phase === "remembering") return complete(state, config);
      return { state: input, commands: [] };
    },
  };
}

export const llmDecide: ReducerModule = {
  initialize: () => null,
  reduce(state, event, configuration) {
    if (event.type.name === "InputReceived") {
      const input = (event.value as unknown as InputReceivedValue).input as unknown as {
        task: AgentTask;
        context: ContextBundle;
      };
      const config = configuration as unknown as { decisionType: TypeRef; maxOutputTokens: number };
      return {
        state,
        commands: [
          {
            kind: "callChild",
            commandId: "decide",
            slot: "llm",
            operation: "generate",
            input: json({
              messages: [
                {
                  role: "system",
                  content: canonicalJson({
                    goal: input.task.goal,
                    constraints: input.task.constraints,
                  }),
                  toolCallId: null,
                },
                ...input.context.messages,
              ],
              tools: [],
              outputType: config.decisionType,
              maxOutputTokens: config.maxOutputTokens,
            }),
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
            output: (event.value as { output: { structured: Json } }).output.structured,
          },
        ],
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
