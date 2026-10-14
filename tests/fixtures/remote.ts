import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

export async function startRemote(path: string) {
  const child = fork(fileURLToPath(new URL("./remote-server.mjs", import.meta.url)), [path], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: [],
  });
  const ready = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error("Remote exited before readiness");
    }),
  ]);
  const message = ready[0] as { port: number };
  if (!message.port) throw new Error("Invalid remote readiness");
  const endpoint = `http://127.0.0.1:${message.port}`;
  return {
    child,
    endpoint,
    async counts(): Promise<{ calls: number; changes: number }> {
      return (await (await fetch(`${endpoint}/counts`)).json()) as {
        calls: number;
        changes: number;
      };
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}
