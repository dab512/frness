export const counter = {
  initialize(_input, config) {
    if (config.mode === "invalid-init") return { count: "wrong" };
    return { count: 0 };
  },
  reduce(state, event, config) {
    if (config.mode === "throw") throw new Error("poison");
    if (config.mode === "mixed")
      return {
        state,
        commands: [
          { kind: "complete", output: 0 },
          { kind: "awaitInput", commandId: "wait", inputType: event.type },
        ],
      };
    if (config.mode === "parent") {
      if (event.type.name === "ChildCompleted")
        return { state, commands: [{ kind: "complete", output: event.value.output }] };
      return {
        state,
        commands: [
          {
            kind: "callChild",
            commandId: "child",
            slot: "body",
            operation: "run",
            input: event.value.input,
          },
        ],
      };
    }
    const count = state.count + event.value.input;
    return {
      state: { count },
      commands: config.mode === "child" ? [{ kind: "complete", output: count }] : [],
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
