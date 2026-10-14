import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { failure, readJson, root, writeJson } from "./project.mjs";

const layout = await readJson("workspace-layout.json");
const names = new Set();
const paths = new Set();
for (const entry of layout.workspaces) {
  if (!/^(packages|plugins|apps)\/[a-z][a-z0-9-]*$/.test(entry.path)) {
    throw failure("INVALID_WORKSPACE_PATH", entry.path);
  }
  if (names.has(entry.name) || paths.has(entry.path)) {
    throw failure("DUPLICATE_WORKSPACE", entry.path);
  }
  names.add(entry.name);
  paths.add(entry.path);
  const directory = resolve(root, entry.path);
  await mkdir(directory, { recursive: true });
  try {
    await access(resolve(directory, "package.json"));
    const current = await readJson(`${entry.path}/package.json`);
    if (current.name !== entry.name) throw failure("WORKSPACE_CONFLICT", entry.path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeJson(`${entry.path}/package.json`, {
      name: entry.name,
      version: "0.1.0",
      private: true,
      type: "module",
    });
  }
}
console.log(`Workspace skeleton ready: ${names.size} packages; no product implementation added.`);
