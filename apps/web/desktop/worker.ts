import { pathToFileURL } from "node:url";
import type { ObjectRef } from "../../../specs/fractal-harness/contracts.js";
import { type SelfhostExtension, selfhost } from "../../cli/src/selfhost.js";

const abort = new AbortController();
let started = false;
process.on("message", async (message: unknown) => {
  const input = message as {
    kind: string;
    workspace: string;
    provider: "codex" | "claude";
    prompt: string;
    session?: ObjectRef;
    extension?: string;
    executable?: string;
  };
  if (input.kind === "stop") {
    abort.abort();
    return;
  }
  if (input.kind !== "run" || started) return;
  started = true;
  try {
    const extension = input.extension
      ? ((await import(pathToFileURL(input.extension).href)).default as SelfhostExtension)
      : undefined;
    const result = await selfhost({
      workspace: input.workspace,
      provider: input.provider,
      prompt: input.prompt,
      ...(input.session ? { session: input.session } : {}),
      ...(input.executable ? { executable: input.executable } : {}),
      ...(extension ? { extension } : {}),
      signal: abort.signal,
      output: (text) => process.send?.({ kind: "text", text }),
    });
    process.send?.({ kind: "done", result });
  } catch (error) {
    process.send?.({
      kind: "error",
      cancelled: abort.signal.aborted,
      message: error instanceof Error ? error.message : "Запуск не удался",
    });
  } finally {
    process.disconnect?.();
  }
});
