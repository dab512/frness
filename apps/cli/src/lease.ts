import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
export async function workspaceLease(workspace: string) {
  const directory = join(resolve(workspace), ".frness/selfhost");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "writer.lock");
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    await writeFile(path, identity, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        "WORKSPACE_BUSY: active run/install or unreconciled writer.lock; do not repeat unknown effects",
      );
    throw error;
  }
  return async () => {
    if ((await readFile(path, "utf8")) !== identity) throw new Error("Writer lease changed");
    await unlink(path);
  };
}
