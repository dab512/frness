import {
  type AgentTransport,
  printCapabilities,
  providerData,
  providerObject,
  type TransportEvent,
} from "../src/transport.js";

export interface CodexConfiguration {
  readonly executable?: string;
  readonly model?: string;
  readonly sandbox?: "read-only" | "workspace-write";
  readonly environment?: Readonly<Record<string, string>>;
}
export function codexTransport(configuration: CodexConfiguration = {}): AgentTransport {
  return {
    capabilities: printCapabilities,
    plan(input) {
      const args = [
        "--sandbox",
        configuration.sandbox ?? "workspace-write",
        "exec",
        ...(input.nativeHandle ? ["resume"] : []),
        "--json",
        ...(configuration.model ? ["--model", configuration.model] : []),
        ...(input.nativeHandle ? [input.nativeHandle] : []),
        "-",
      ];
      return {
        executable: configuration.executable ?? "codex",
        args,
        cwd: input.cwd,
        input: input.prompt,
        ...(configuration.environment ? { environment: configuration.environment } : {}),
      };
    },
    decoder() {
      let answer = "";
      return (value) => {
        const frame = providerObject(value);
        const events: TransportEvent[] = [{ kind: "provider", value: providerData(value) }];
        if (frame.type === "thread.started" && typeof frame.thread_id === "string")
          events.push({ kind: "session", handle: frame.thread_id });
        if (
          frame.type === "item.completed" &&
          frame.item &&
          typeof frame.item === "object" &&
          !Array.isArray(frame.item)
        ) {
          const item = providerObject(frame.item);
          if (item.type === "agent_message" && typeof item.text === "string") {
            answer = item.text;
            events.push({ kind: "text", delta: item.text });
          }
        }
        if (frame.type === "turn.completed")
          events.push({ kind: "terminal", status: "completed", result: answer, errorCode: null });
        if (frame.type === "turn.failed")
          events.push({
            kind: "terminal",
            status: "failed",
            result: "",
            errorCode: "PROVIDER_FAILED",
          });
        return events;
      };
    },
  };
}
