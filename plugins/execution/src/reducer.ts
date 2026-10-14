import { assertJson, freezeJson } from "../../../packages/abi/src/json.js";
import type {
  Json,
  ReducerCommand,
  ReducerEvent,
  ReducerModule,
  ReducerResult,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";

export function executionError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export interface ReducerValidation {
  readonly validate: (type: TypeRef, value: unknown) => void;
  readonly stateType: TypeRef;
  readonly outputType: TypeRef;
  readonly commandType: TypeRef;
}
function validateOutput(value: unknown, type: TypeRef, validation: ReducerValidation): void {
  try {
    assertJson(value);
    validation.validate(type, value);
  } catch {
    throw executionError("INVALID_OUTPUT", "Reducer output failed validation");
  }
}
export function initialize(
  module: ReducerModule,
  input: Json,
  config: Json,
  validation: ReducerValidation,
): Json {
  let state: Json;
  try {
    state = module.initialize(
      freezeJson(structuredClone(input)),
      freezeJson(structuredClone(config)),
    );
  } catch {
    throw executionError("REDUCER_EXECUTION_FAILED", "Reducer initialize failed");
  }
  validateOutput(state, validation.stateType, validation);
  return structuredClone(state);
}
export function transition(
  module: ReducerModule,
  state: Json,
  event: ReducerEvent,
  config: Json,
  validation: ReducerValidation,
): ReducerResult {
  let result: ReducerResult;
  try {
    result = module.reduce(
      freezeJson(structuredClone(state)),
      freezeJson(structuredClone(event)),
      freezeJson(structuredClone(config)),
    );
  } catch {
    throw executionError("REDUCER_EXECUTION_FAILED", "Reducer execution failed");
  }
  try {
    assertJson(result);
    if (
      !result ||
      !Array.isArray(result.commands) ||
      Object.keys(result).sort().join(",") !== "commands,state"
    )
      throw new Error("Invalid result envelope");
  } catch {
    throw executionError("INVALID_OUTPUT", "Reducer result is not a valid JSON envelope");
  }
  validateOutput(result.state, validation.stateType, validation);
  for (const command of result.commands)
    validateOutput(command, validation.commandType, validation);
  validateCommands(result.commands);
  for (const command of result.commands)
    if (command.kind === "complete")
      validateOutput(command.output, validation.outputType, validation);
  return structuredClone(result);
}
export function validateCommands(commands: readonly ReducerCommand[]): void {
  if (
    commands.length > 1000 ||
    (commands.length > 1 &&
      commands.some((command) => command.kind === "complete" || command.kind === "fail"))
  )
    throw executionError("INVALID_COMMAND_BATCH", "Terminal command must be the only command");
  const ids = commands.flatMap((command) => ("commandId" in command ? [command.commandId] : []));
  if (new Set(ids).size !== ids.length)
    throw executionError("INVALID_COMMAND_BATCH", "Duplicate command identity");
}
