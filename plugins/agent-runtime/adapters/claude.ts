import {
  type AgentTransport,
  printCapabilities,
  providerData,
  providerObject,
  type TransportEvent,
} from "../src/transport.js";

export interface ClaudeConfiguration {
  readonly executable?: string;
  readonly model?: string;
  readonly environment?: Readonly<Record<string, string>>;
}
export function claudeTransport(configuration: ClaudeConfiguration = {}): AgentTransport {
  return {
    capabilities: printCapabilities,
    plan(input) {
      return {
        executable: configuration.executable ?? "claude",
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--permission-mode",
          "default",
          ...(configuration.model ? ["--model", configuration.model] : []),
          ...(input.nativeHandle ? ["--resume", input.nativeHandle] : []),
        ],
        cwd: input.cwd,
        input: input.prompt,
        ...(configuration.environment ? { environment: configuration.environment } : {}),
      };
    },
    decoder() {
      return (value) => {
        const frame = providerObject(value);
        const events: TransportEvent[] = [{ kind: "provider", value: providerData(value) }];
        if (
          frame.type === "system" &&
          frame.subtype === "init" &&
          typeof frame.session_id === "string"
        )
          events.push({ kind: "session", handle: frame.session_id });
        if (
          frame.type === "stream_event" &&
          frame.event &&
          typeof frame.event === "object" &&
          !Array.isArray(frame.event)
        ) {
          const event = providerObject(frame.event);
          if (event.delta && typeof event.delta === "object" && !Array.isArray(event.delta)) {
            const delta = providerObject(event.delta);
            if (delta.type === "text_delta" && typeof delta.text === "string")
              events.push({ kind: "text", delta: delta.text });
          }
        }
        if (frame.type === "result")
          events.push({
            kind: "terminal",
            status: frame.is_error === true ? "failed" : "completed",
            result: typeof frame.result === "string" ? frame.result : "",
            errorCode: frame.is_error === true ? "PROVIDER_FAILED" : null,
          });
        return events;
      };
    },
  };
}
