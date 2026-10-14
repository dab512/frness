import type { BootstrapRegistrationHost } from "../../../packages/abi/src/bootstrap.js";
import type {
  Json,
  ReducerModule,
  ReloadParticipant,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type {
  AgentTask,
  Candidate,
  ContextBundle,
  ToolCall,
} from "../../../specs/fractal-harness/standard-contracts.js";

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const complete = (state: Json, output: unknown) => ({
  state,
  commands: [{ kind: "complete" as const, output: json(output) }],
});
let snapshotType: TypeRef;
export function activate(host: BootstrapRegistrationHost) {
  snapshotType = host.snapshotType;
  return () => {};
}
export const context: ReducerModule = {
  initialize: () => null,
  reduce(state, event) {
    const input = (event.value as { input: Json }).input as unknown as {
      task: AgentTask;
      observations: unknown[];
      feedback: string[];
    };
    return complete(state, {
      messages: [
        {
          role: "system",
          content: JSON.stringify({ observations: input.observations, feedback: input.feedback }),
          toolCallId: null,
        },
      ],
      sources: input.task.sources,
      omittedSources: [],
    });
  },
};
export const decide: ReducerModule = {
  initialize: () => null,
  reduce(state, event, configuration) {
    const input = (event.value as { input: Json }).input as unknown as {
      task: AgentTask;
      context: ContextBundle;
    };
    const data = JSON.parse(input.context.messages[0]!.content) as {
      observations: unknown[];
      feedback: string[];
    };
    if (
      input.task.goal === "input" &&
      !data.feedback.some((item) => item.startsWith("User input:"))
    )
      return complete(state, {
        kind: "needInput",
        question: "Please provide context",
        inputType: (configuration as { userInputType: Json }).userInputType,
      });
    if (input.task.goal === "repeat" || !data.observations.length)
      return complete(state, {
        kind: "actions",
        calls: [{ id: "once", name: "fixture", arguments: "42" }],
      });
    return complete(state, { kind: "candidate", value: data.feedback.length ? 42 : 41 });
  },
};
export const action: ReducerModule = {
  initialize: () => null,
  reduce(state, event) {
    const call = (event.value as { input: Json }).input as unknown as ToolCall;
    return complete(state, {
      callId: call.id,
      ok: true,
      value: "tool observation",
      errorCode: null,
      sources: [],
    });
  },
};
export const accept: ReducerModule = {
  initialize: () => null,
  reduce(state, event, configuration) {
    const input = (event.value as { input: Json }).input as unknown as {
      task: AgentTask;
      candidate: Candidate;
    };
    return complete(state, [
      {
        candidateDigest:
          input.task.goal === "mismatch" ? "wrong-candidate" : input.candidate.digest,
        verifier: (configuration as { verifier: Json }).verifier,
        verdict: input.candidate.value === 42 ? "accept" : "reject",
        feedback: input.candidate.value === 42 ? [] : ["Use 42"],
        evidence: [],
      },
    ]);
  },
};
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
