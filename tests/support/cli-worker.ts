import { fork } from "node:child_process";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export function startCliWorker(t: TestContext, directory: string, mode: string) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = fork(
    fileURLToPath(new URL("../fixtures/agent-runner/worker.ts", import.meta.url)),
    [directory, mode],
    { env: environment, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    predicate: (value: Record<string, unknown>) => boolean;
    resolve: (value: Record<string, unknown>) => void;
  }[] = [];
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("message", (message) => {
    const value = message as Record<string, unknown>;
    messages.push(value);
    for (const waiter of waiters.splice(0))
      if (waiter.predicate(value)) waiter.resolve(value);
      else waiters.push(waiter);
  });
  const wait = (
    predicate: (value: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    const value = messages.find(predicate);
    return value
      ? Promise.resolve(value)
      : Promise.race([
          new Promise<Record<string, unknown>>((resolve) => waiters.push({ predicate, resolve })),
          once(child, "exit").then(() => {
            throw new Error(stderr || "CLI worker exited");
          }),
        ]);
  };
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  };
  t.after(kill);
  return { child, wait, kill };
}
