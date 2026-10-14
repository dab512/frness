async function request(path, effect, attemptId) {
  const response = await fetch(`${effect.adapterConfiguration.endpoint}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      remoteKey: effect.remoteKey,
      nativeKey: effect.policy.strategy === "idempotency-key",
      attemptId,
      ...effect.input,
    }),
  });
  if (!response.ok) throw new Error("Remote protocol failure");
  return response.json();
}
export const writer = {
  execute: ({ effect, attemptId }) => request("execute", effect, attemptId),
  reconcile: ({ effect, attemptId }) => request("reconcile", effect, attemptId),
};
export const parent = {
  initialize: () => ({ outputs: {} }),
  reduce(state, event, config) {
    if (event.type.name === "EffectCompleted") {
      const outputs = { ...state.outputs, [event.value.commandId]: event.value.output };
      return {
        state: { outputs },
        commands:
          Object.keys(outputs).length === (config.commandCount ?? 1)
            ? [{ kind: "complete", output: event.value.output }]
            : [],
      };
    }
    if (event.type.name === "EffectFailed")
      return { state, commands: [{ kind: "fail", error: event.value.error }] };
    if (event.type.name === "InputProvided")
      return { state, commands: [{ kind: "complete", output: { externalId: event.value.input } }] };
    if (config.mode === "await")
      return {
        state,
        commands: [
          {
            kind: "awaitInput",
            commandId: "answer",
            inputType: { ...event.value.operation.contract, name: "TextAnswer" },
          },
        ],
      };
    return {
      state,
      commands: [
        {
          kind: "effect",
          commandId: "write",
          adapterInstanceId: "connected",
          operation: {
            contract: { ...event.value.operation.contract, name: "Write" },
            operation: "run",
          },
          input: event.value.input,
          maxUnits: config.maxUnits ?? 0,
        },
      ].flatMap((command) =>
        Array.from({ length: config.commandCount ?? 1 }, (_, index) => ({
          ...command,
          commandId:
            (config.commandCount ?? 1) === 1 ? command.commandId : `${command.commandId}-${index}`,
        })),
      ),
    };
  },
};
export const root = {
  initialize: () => ({ outputs: {} }),
  reduce(state, event) {
    if (event.type.name === "ChildCompleted")
      return { state, commands: [{ kind: "complete", output: event.value.output }] };
    if (event.type.name === "ChildFailed")
      return { state, commands: [{ kind: "fail", error: event.value.error }] };
    return {
      state,
      commands: [
        {
          kind: "callChild",
          commandId: "child",
          slot: "parent",
          operation: "run",
          input: event.value.input,
        },
      ],
    };
  },
};
export function suite() {
  return true;
}
export const reload = {
  async capture() {
    return { type: null, value: null };
  },
  async restore() {},
  async ready() {},
  async dispose() {},
};
