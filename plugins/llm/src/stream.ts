import { assertJson, freezeJson } from "../../../packages/abi/src/json.js";
import type { TypeRef } from "../../../specs/fractal-harness/contracts.js";
import type {
  ModelCompletion,
  ModelRequest,
} from "../../../specs/fractal-harness/standard-contracts.js";
import { validateModelShape } from "./validation.js";

export const modelError = (code: string) => Object.assign(new Error(code), { code });
export type ModelChunk =
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "final"; readonly completion: ModelCompletion };
export type ValidateModelValue = (type: TypeRef, value: unknown) => void;

export function validateRequest(request: ModelRequest): void {
  assertJson(request);
  validateModelShape("ModelRequest", request, "INVALID_INPUT");
  if (
    !Array.isArray(request.messages) ||
    request.messages.length === 0 ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens <= 0 ||
    !Array.isArray(request.tools)
  )
    throw modelError("INVALID_INPUT");
  for (const message of request.messages) {
    if (
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      typeof message.content !== "string" ||
      (message.role === "tool"
        ? typeof message.toolCallId !== "string" || !message.toolCallId
        : message.toolCallId !== null)
    )
      throw modelError("INVALID_INPUT");
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (!tool.name || names.has(tool.name) || typeof tool.description !== "string")
      throw modelError("INVALID_INPUT");
    names.add(tool.name);
    // Nominal references are resolved by the composition root, never inferred from shape.
    assertJson(tool.inputType);
    assertJson(tool.outputType);
  }
}

function validateCompletion(
  request: ModelRequest,
  value: ModelCompletion,
  validate: ValidateModelValue,
): void {
  assertJson(value);
  validateModelShape("ModelCompletion", value, "INVALID_OUTPUT");
  if (
    typeof value.text !== "string" ||
    !Array.isArray(value.toolCalls) ||
    !["stop", "tool_calls"].includes(value.finish) ||
    (value.finish === "stop" ? value.toolCalls.length !== 0 : value.toolCalls.length === 0) ||
    (!value.text && value.structured === null && value.toolCalls.length === 0)
  )
    throw modelError("INVALID_OUTPUT");
  if (
    value.usage !== null &&
    (!value.usage ||
      !Number.isSafeInteger(value.usage.inputTokens) ||
      value.usage.inputTokens < 0 ||
      !Number.isSafeInteger(value.usage.outputTokens) ||
      value.usage.outputTokens < 0)
  )
    throw modelError("INVALID_OUTPUT");
  if (request.outputType !== null) {
    if (value.structured === null) throw modelError("INVALID_OUTPUT");
    validate(request.outputType, value.structured);
  } else if (value.structured !== null) throw modelError("INVALID_OUTPUT");
  const ids = new Set<string>();
  for (const call of value.toolCalls) {
    const tool = request.tools.find((item) => item.name === call.name);
    if (!tool || !call.id || ids.has(call.id)) throw modelError("INVALID_OUTPUT");
    ids.add(call.id);
    validate(tool.inputType, call.arguments);
  }
}

/** Provisional chunks are data. This module has no tool execution capability. */
export class ModelStream {
  #completion: ModelCompletion | undefined;
  #invalid = false;
  constructor(
    readonly request: ModelRequest,
    readonly validate: ValidateModelValue,
    readonly provisional: (chunk: Extract<ModelChunk, { kind: "text" }>) => Promise<void>,
  ) {}
  async push(input: unknown): Promise<void> {
    try {
      assertJson(input);
      const chunk = input as unknown as ModelChunk;
      if (this.#completion || this.#invalid || !chunk) throw modelError("INVALID_OUTPUT");
      if (
        chunk.kind === "text" &&
        typeof chunk.delta === "string" &&
        Object.keys(chunk).length === 2
      ) {
        await this.provisional(freezeJson(structuredClone(chunk)));
        return;
      }
      if (chunk.kind !== "final" || Object.keys(chunk).length !== 2)
        throw modelError("INCOMPLETE_RESPONSE");
      validateCompletion(this.request, chunk.completion, this.validate);
      this.#completion = freezeJson(structuredClone(chunk.completion));
    } catch (error) {
      this.#invalid = true;
      throw error;
    }
  }
  finish(): ModelCompletion {
    if (!this.#completion || this.#invalid) throw modelError("INCOMPLETE_RESPONSE");
    return structuredClone(this.#completion);
  }
}
