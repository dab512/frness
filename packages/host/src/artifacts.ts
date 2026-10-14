import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HostError, hasCode } from "./errors.js";

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checkRelativePath(path: string): void {
  if (
    !path ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new HostError("INVALID_INPUT", `Invalid relative artifact path: ${path}`);
  }
}

export async function safeArtifactPath(base: string, relative: string): Promise<string> {
  checkRelativePath(relative);
  let current = base;
  for (const part of relative.split("/")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new HostError("INVALID_INPUT", "Artifact symlinks are forbidden");
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        throw new HostError("BOOTSTRAP_PACKAGE_MISSING", `Missing artifact: ${relative}`);
      throw error;
    }
  }
  return current;
}

export async function readArtifactFiles(
  directory: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  async function collect(relative: string): Promise<void> {
    if (relative) checkRelativePath(relative);
    const path = relative ? join(directory, relative) : directory;
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new HostError("INVALID_INPUT", "Artifact symlinks are forbidden");
    if (info.isDirectory()) {
      for (const entry of await readdir(path))
        await collect(relative ? `${relative}/${entry}` : entry);
    } else if (info.isFile()) {
      if (!relative) throw new HostError("INVALID_INPUT", "Artifact root must be a directory");
      if (relative !== "package.digest") files.set(relative, await readFile(path));
    } else throw new HostError("INVALID_INPUT", "Only regular files and directories are allowed");
  }
  await collect("");
  return files;
}

export function digestFiles(files: ReadonlyMap<string, Uint8Array>): string {
  const entries = [...files.keys()]
    .sort()
    .map((path) => [path, sha256(files.get(path) ?? new Uint8Array())]);
  return `sha256:${sha256(JSON.stringify(entries))}`;
}

export async function computeArtifactDigest(directory: string): Promise<string> {
  return digestFiles(await readArtifactFiles(directory));
}
