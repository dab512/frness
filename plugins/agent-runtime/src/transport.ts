import type { Json } from "../../../specs/fractal-harness/contracts.js";
import type { AgentBackendCapabilities } from "../../../specs/fractal-harness/standard-contracts.js";
import type { CliProcessSpec } from "./process.js";

export interface TransportInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly nativeHandle: string | null;
}
export type TransportEvent =
  | { readonly kind: "session"; readonly handle: string }
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "provider"; readonly value: Json }
  | {
      readonly kind: "terminal";
      readonly status: "completed" | "failed";
      readonly result: string;
      readonly errorCode: string | null;
    };
export interface AgentTransport {
  readonly capabilities: AgentBackendCapabilities;
  plan(input: TransportInput): CliProcessSpec;
  decoder(): (frame: Json) => readonly TransportEvent[];
}
export const printCapabilities: AgentBackendCapabilities = Object.freeze({
  streaming: true,
  resume: true,
  reconcileTurn: false,
  permissions: false,
  interrupt: "turn",
  nativeFork: false,
});
export function providerObject(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("Invalid provider frame"), { code: "INVALID_PROTOCOL" });
  return value as Record<string, Json>;
}
export function providerData(value: Json): Json {
  if (Array.isArray(value)) return value.map(providerData);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !new Set([
              "authorization",
              "api_key",
              "apikey",
              "access_token",
              "refresh_token",
              "id_token",
              "secret",
              "credentials",
            ]).has(key.toLowerCase()),
        )
        .map(([key, child]) => [key, providerData(child)]),
    );
  return value;
}
