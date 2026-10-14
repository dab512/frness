import { assertJson, freezeJson } from "../../../packages/abi/src/json.js";
import type { Json, TypeRef } from "../../../specs/fractal-harness/contracts.js";
import type { ModelRequest } from "../../../specs/fractal-harness/standard-contracts.js";
import {
  type ModelChunk,
  ModelStream,
  modelError,
  type ValidateModelValue,
  validateRequest,
} from "./stream.js";
import { validateModelShape } from "./validation.js";

export interface ModelConfiguration {
  readonly endpoint: string;
  readonly model: string;
  readonly credentialBinding: string;
  readonly decoder: "frness.model.ndjson.v1";
}
export interface ModelTransportInput {
  readonly configuration: ModelConfiguration;
  readonly request: ModelRequest;
  readonly credential: string;
}
export interface ModelProviderOptions {
  readonly validate: ValidateModelValue;
  readonly credential: (binding: string) => string;
  readonly resolveType?: (type: TypeRef) => void;
  readonly transport?: (input: ModelTransportInput) => AsyncIterable<unknown>;
  readonly provisional?: (chunk: Extract<ModelChunk, { kind: "text" }>) => Promise<void>;
}
function configuration(value: unknown): ModelConfiguration {
  try {
    assertJson(value);
    validateModelShape("ProviderConfiguration", value, "MODEL_CONFIGURATION_MISSING");
    const config = value as unknown as ModelConfiguration;
    const endpoint = new URL(config.endpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      !config.model ||
      !config.credentialBinding ||
      config.decoder !== "frness.model.ndjson.v1"
    )
      throw new Error();
    return freezeJson(structuredClone(config));
  } catch {
    throw modelError("MODEL_CONFIGURATION_MISSING");
  }
}

/** Explicit gateway protocol; credentials exist only during the transport call. No retries. */
export function createModelProvider(options: ModelProviderOptions) {
  return {
    async generate(input: ModelRequest, configInput: Json) {
      const request = freezeJson(structuredClone(input));
      validateRequest(request);
      for (const type of [
        ...request.tools.flatMap((tool) => [tool.inputType, tool.outputType]),
        ...(request.outputType ? [request.outputType] : []),
      ])
        options.resolveType?.(type);
      const config = configuration(configInput);
      let credential: string;
      try {
        credential = options.credential(config.credentialBinding);
        if (!credential || /[\r\n]/.test(credential)) throw new Error();
      } catch {
        throw modelError("MODEL_CONFIGURATION_MISSING");
      }
      const stream = new ModelStream(
        request,
        options.validate,
        options.provisional ?? (async () => {}),
      );
      try {
        for await (const chunk of (options.transport ?? httpModelTransport)({
          configuration: config,
          request,
          credential,
        }))
          await stream.push(chunk);
        return stream.finish();
      } catch (error) {
        // After entering transport these codes cannot prove a zero-cost rejection.
        if (
          error instanceof Error &&
          "code" in error &&
          ["INVALID_INPUT", "MODEL_CONFIGURATION_MISSING"].includes(String(error.code))
        )
          throw modelError("INCOMPLETE_RESPONSE");
        throw error;
      }
    },
  };
}

export async function* httpModelTransport(
  input: ModelTransportInput,
  transport: typeof fetch = fetch,
): AsyncIterable<unknown> {
  const controller = new AbortController();
  try {
    const response = await transport(input.configuration.endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.credential}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify({
        protocol: input.configuration.decoder,
        model: input.configuration.model,
        request: input.request,
      }),
    });
    if (
      !response.ok ||
      !response.body ||
      response.headers.get("content-type")?.split(";")[0] !== "application/x-ndjson"
    )
      throw modelError("MODEL_TRANSPORT_FAILED");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true });
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        if (Buffer.byteLength(line) > 1024 * 1024) throw modelError("INVALID_OUTPUT");
        pending = pending.slice(newline + 1);
        if (line.trim()) yield JSON.parse(line);
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw modelError("INVALID_OUTPUT");
    }
    pending += decoder.decode();
    if (pending.trim()) throw modelError("INCOMPLETE_RESPONSE");
  } finally {
    controller.abort();
  }
}
