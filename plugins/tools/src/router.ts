import { assertJson, canonicalJson, freezeJson } from "../../../packages/abi/src/json.js";
import type { TypeRef } from "../../../specs/fractal-harness/contracts.js";
import type {
  ToolCall,
  ToolObservation,
  ToolSpec,
} from "../../../specs/fractal-harness/standard-contracts.js";
import { validateToolShape } from "./validation.js";

export interface ToolBinding {
  readonly spec: ToolSpec;
  invoke(call: ToolCall): Promise<ToolObservation>;
}
export const toolError = (code: string) => Object.assign(new Error(code), { code });
export const failedObservation = (callId: string, errorCode: string): ToolObservation => ({
  callId,
  ok: false,
  value: null,
  errorCode,
  sources: [],
});
export function validateCall(
  call: ToolCall,
  specs: readonly ToolSpec[],
  validate: (type: TypeRef, value: unknown) => void,
): ToolSpec {
  assertJson(call);
  validateToolShape("ToolCall", call, "INVALID_INPUT");
  if (
    !call ||
    typeof call.id !== "string" ||
    !call.id ||
    typeof call.name !== "string" ||
    Object.keys(call).sort().join(",") !== "arguments,id,name"
  )
    throw toolError("INVALID_INPUT");
  const spec = specs.find((item) => item.name === call.name);
  if (!spec) throw toolError("INVALID_INPUT");
  try {
    validate(spec.inputType, call.arguments);
  } catch {
    throw toolError("INVALID_INPUT");
  }
  return spec;
}
export function validateObservation(
  call: ToolCall,
  spec: ToolSpec,
  result: ToolObservation,
  validate: (type: TypeRef, value: unknown) => void,
): void {
  assertJson(result);
  validateToolShape("ToolObservation", result, "INVALID_OUTPUT");
  if (
    !result ||
    result.callId !== call.id ||
    typeof result.ok !== "boolean" ||
    !Array.isArray(result.sources) ||
    Object.keys(result).sort().join(",") !== "callId,errorCode,ok,sources,value" ||
    (result.ok
      ? result.errorCode !== null
      : result.value !== null || typeof result.errorCode !== "string" || !result.errorCode)
  )
    throw toolError("INVALID_OUTPUT");
  if (result.ok) validate(spec.outputType, result.value);
}

/** One router belongs to one parent run. Durable invocation receipts belong to execution. */
export class ToolRouter {
  #calls = new Map<string, { digest: string; result: Promise<ToolObservation> }>();
  constructor(
    readonly options: {
      readonly bindings: readonly ToolBinding[];
      readonly validate: (type: TypeRef, value: unknown) => void;
    },
  ) {
    for (const binding of options.bindings)
      validateToolShape("ToolSpec", binding.spec, "INVALID_INPUT");
    const names = options.bindings.map((binding) => binding.spec.name);
    if (new Set(names).size !== names.length) throw toolError("INVALID_INPUT");
  }
  invoke(input: ToolCall): Promise<ToolObservation> {
    assertJson(input);
    if (!input || typeof input.id !== "string" || !input.id) throw toolError("INVALID_INPUT");
    const call = freezeJson(structuredClone(input));
    let spec: ToolSpec;
    try {
      spec = validateCall(
        call,
        this.options.bindings.map((binding) => binding.spec),
        this.options.validate,
      );
    } catch {
      return Promise.resolve(failedObservation(call.id, "INVALID_INPUT"));
    }
    const digest = canonicalJson(call);
    const old = this.#calls.get(call.id);
    if (old)
      return old.digest === digest
        ? old.result.then((result) => structuredClone(result))
        : Promise.resolve(failedObservation(call.id, "IDEMPOTENCY_CONFLICT"));
    const binding = this.options.bindings.find((item) => item.spec.name === spec.name)!;
    const result = Promise.resolve().then(async () => {
      try {
        const result = await binding.invoke(call);
        try {
          validateObservation(call, spec, result, this.options.validate);
        } catch {
          return failedObservation(call.id, "INVALID_OUTPUT");
        }
        return structuredClone(result);
      } catch {
        return failedObservation(call.id, "TOOL_OUTCOME_UNKNOWN");
      }
    });
    this.#calls.set(call.id, { digest, result });
    return result.then((value) => structuredClone(value));
  }
  async invokeAll(calls: readonly ToolCall[]): Promise<readonly ToolObservation[]> {
    const values: ToolObservation[] = [];
    for (const call of calls) values.push(await this.invoke(call));
    return values;
  }
}
