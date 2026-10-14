import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

export async function writeJson(path, value) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, target);
}

export function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export async function plan() {
  return readJson("specs/fractal-harness/plan.json");
}
