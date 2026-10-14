import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BootstrapRegistrationHost } from "../../abi/src/bootstrap.js";
import { freezeJson } from "../../abi/src/json.js";
import { digestFiles, readArtifactFiles, safeArtifactPath } from "./artifacts.js";
import { HostError, hasCode } from "./errors.js";
import { BootstrapGeneration } from "./generation.js";
import { resolvePackages, type SourcePackage } from "./references.js";
import { parseBootLock, parseJson, parseManifest } from "./validation.js";

export interface BootstrapOptions {
  readonly directory: string;
  readonly importModule?: (path: string) => Promise<Record<string, unknown>>;
  readonly knownPackages?: ReadonlyMap<string, string>;
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapGeneration> {
  let raw: string;
  try {
    raw = await readFile(resolve(options.directory, "boot-lock.json"), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new HostError("BOOTSTRAP_PACKAGE_MISSING", "boot-lock.json is missing");
    }
    throw error;
  }
  const lock = parseBootLock(parseJson(raw));
  const verified: { directory: string; digest: string; files: ReadonlyMap<string, Uint8Array> }[] =
    [];
  for (const entry of lock.packages) {
    const directory = await safeArtifactPath(options.directory, entry.artifactPath);
    const files = await readArtifactFiles(directory);
    if (digestFiles(files) !== entry.digest)
      throw new HostError("DIGEST_MISMATCH", entry.artifactPath);
    try {
      const copy = (await readFile(resolve(directory, "package.digest"), "utf8")).trim();
      if (copy !== entry.digest)
        throw new HostError("DIGEST_MISMATCH", "Invalid package.digest copy");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    verified.push({ directory, digest: entry.digest, files });
  }
  const packages: SourcePackage[] = verified.map((artifact) => {
    const bytes = artifact.files.get("manifest.json");
    if (!bytes) throw new HostError("BOOTSTRAP_PACKAGE_MISSING", "manifest.json is missing");
    const source = freezeJson(
      parseManifest(parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
    );
    const known = options.knownPackages?.get(JSON.stringify([source.packageId, source.version]));
    if (known && known !== artifact.digest)
      throw new HostError("DEFINITION_CONFLICT", "Existing package identity has different content");
    for (const entry of Object.values(source.exports))
      if (!artifact.files.has(entry.path))
        throw new HostError("PINNED_DEPENDENCY_MISSING", `Missing export file ${entry.path}`);
    return { digest: artifact.digest, source };
  });
  const description = resolvePackages(packages);
  for (const activation of lock.activations) {
    const owner = description.packages.find((item) => item.digest === activation.packageDigest);
    if (!owner?.source.exports[activation.exportName])
      throw new HostError("PINNED_DEPENDENCY_MISSING", "Missing activation descriptor");
  }
  const generation = new BootstrapGeneration(randomUUID(), description);
  const importModule =
    options.importModule ??
    ((path: string) =>
      import(`${pathToFileURL(path).href}?generation=${generation.generationId}`) as Promise<
        Record<string, unknown>
      >);
  const modules = new Map<string, Record<string, unknown>>();
  async function exported(packageDigest: string, entryName: string): Promise<unknown> {
    const artifact = verified.find((item) => item.digest === packageDigest);
    const owner = description.packages.find((item) => item.digest === packageDigest);
    const entry = owner?.source.exports[entryName];
    if (!artifact || !entry)
      throw new HostError("PINNED_DEPENDENCY_MISSING", "Missing export descriptor");
    if (entry.environment !== "server")
      throw new HostError("CAPABILITY_DENIED", "Client code cannot execute in the server");
    const key = `${packageDigest}/${entry.path}`;
    let module = modules.get(key);
    if (!module) {
      const path = await safeArtifactPath(artifact.directory, entry.path);
      module = await importModule(path);
      modules.set(key, module);
      for (const [name, descriptor] of Object.entries(owner.source.exports))
        if (descriptor.environment === "server" && descriptor.path === entry.path)
          generation.retainExport(packageDigest, name, module[descriptor.exportName]);
    }
    return module[entry.exportName];
  }
  try {
    for (const activation of lock.activations) {
      const owner = description.packages.find((item) => item.digest === activation.packageDigest);
      const descriptor = owner?.source.exports[activation.exportName];
      if (!owner || !descriptor)
        throw new HostError("PINNED_DEPENDENCY_MISSING", "Missing activation");
      if (descriptor.environment === "client") continue;
      const value = await exported(activation.packageDigest, activation.exportName);
      if (typeof value !== "function")
        throw new HostError("INVALID_OUTPUT", "Activation must be callable");
      const scope = generation.registration(owner.snapshotType);
      try {
        const cleanup: unknown = await (value as (host: BootstrapRegistrationHost) => unknown)(
          scope.host,
        );
        if (typeof cleanup !== "function")
          throw new HostError("INVALID_OUTPUT", "Activation must return cleanup");
        generation.retainCleanup(cleanup as () => void | Promise<void>);
      } finally {
        scope.seal();
      }
    }
    const checks = generation.validate();
    for (const check of checks) {
      const owner = description.packages.find((item) => item.digest === check.packageDigest);
      const descriptor = owner?.source.exports[check.entry];
      if (!descriptor)
        throw new HostError("PINNED_DEPENDENCY_MISSING", "Unknown implementation export");
      if (descriptor.environment === "server")
        generation.validateExport(check.abi, await exported(check.packageDigest, check.entry));
    }
    for (const owner of description.packages) {
      const entry = owner.source.reload.serverEntry;
      if (!entry) continue;
      const participant = await exported(owner.digest, entry);
      if (
        !participant ||
        typeof participant !== "object" ||
        ["capture", "restore", "ready", "dispose"].some(
          (method) => typeof (participant as Record<string, unknown>)[method] !== "function",
        )
      )
        throw new HostError("INVALID_OUTPUT", "Invalid reload participant");
    }
    generation.publish();
    return generation;
  } catch (error) {
    await generation.close();
    if (error instanceof Error && "code" in error) throw error;
    throw new HostError("DEPENDENCY_UNAVAILABLE", "Bootstrap activation failed", { cause: error });
  }
}

export class BootstrapManager {
  active: BootstrapGeneration | null = null;
  #knownPackages = new Map<string, string>();
  async load(options: BootstrapOptions): Promise<BootstrapGeneration> {
    const candidate = await bootstrap({ ...options, knownPackages: this.#knownPackages });
    for (const owner of candidate.description.packages)
      this.#knownPackages.set(
        JSON.stringify([owner.source.packageId, owner.source.version]),
        owner.digest,
      );
    this.active = candidate;
    return candidate;
  }
}
