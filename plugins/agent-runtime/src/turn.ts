import type { Json } from "../../../specs/fractal-harness/contracts.js";
import { type CliProcessHandle, startCliProcess } from "./process.js";
import type { AgentTransport, TransportEvent, TransportInput } from "./transport.js";

export interface TurnOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "unknown";
  readonly text: string;
  readonly nativeHandle: string | null;
  readonly errorCode: string | null;
}
export function startTurn(
  transport: AgentTransport,
  input: TransportInput,
  onEvent: (event: TransportEvent) => Promise<void>,
) {
  const decode = transport.decoder();
  let handle = input.nativeHandle;
  let terminal: Extract<TransportEvent, { kind: "terminal" }> | undefined;
  let cancelled = false;
  let process: CliProcessHandle;
  process = startCliProcess(transport.plan(input), async (frame: Json) => {
    for (const event of decode(frame)) {
      if (event.kind === "session") handle = event.handle;
      if (event.kind === "terminal") {
        if (terminal && JSON.stringify(terminal) !== JSON.stringify(event))
          throw Object.assign(new Error("Conflicting terminal"), { code: "EVENT_CONFLICT" });
        if (terminal) continue;
        terminal = event;
      }
      await onEvent(event);
    }
  });
  const done = process.done.then((exit): TurnOutcome => {
    if (cancelled)
      return {
        status: "cancelled",
        text: terminal?.result ?? "",
        nativeHandle: handle,
        errorCode: null,
      };
    if (exit.errorCode)
      return {
        status: exit.started ? "unknown" : "failed",
        text: "",
        nativeHandle: handle,
        errorCode: exit.errorCode,
      };
    if (terminal && (exit.code === 0 || terminal.status === "failed"))
      return {
        status: terminal.status,
        text: terminal.result,
        nativeHandle: handle,
        errorCode: terminal.errorCode,
      };
    return { status: "unknown", text: "", nativeHandle: handle, errorCode: "MISSING_TERMINAL" };
  });
  return {
    pid: process.pid,
    done,
    async interrupt() {
      cancelled = true;
      await process.interrupt();
    },
    async close() {
      cancelled = true;
      await process.interrupt("SIGTERM");
    },
  };
}
