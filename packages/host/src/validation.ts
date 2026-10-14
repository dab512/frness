import type {
  BootLock,
  DefinitionRef,
  Json,
  PackageManifest,
  SourceDefinitionRef,
} from "../../abi/src/index.js";
import { assertJson } from "../../abi/src/json.js";
import { checkRelativePath } from "./artifacts.js";
import { HostError } from "./errors.js";

export const digestPattern = /^sha256:[0-9a-f]{64}$/;
export const namePattern = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError("INVALID_INPUT", "Expected an object");
  return value as Record<string, unknown>;
}

export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HostError("INVALID_INPUT", `Expected exactly: ${keys.join(", ")}`);
  }
}

export function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new HostError("INVALID_INPUT", "Expected a nonempty string");
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HostError("INVALID_INPUT", "Expected an array");
  return value;
}

export function parseJson(bytes: string): unknown {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new HostError("INVALID_INPUT", "Invalid JSON", { cause: error });
  }
}

export function parseBootLock(value: unknown): BootLock {
  const lock = record(value);
  exact(lock, ["format", "hostAbi", "packages", "activations"]);
  if (lock.format !== 1) throw new HostError("INVALID_INPUT", "Unknown lock format");
  if (lock.hostAbi !== "fractal.host.v1")
    throw new HostError("UNKNOWN_ABI", "Incompatible host ABI");
  const paths = new Set<string>();
  const digests = new Set<string>();
  const packages = array(lock.packages).map((item) => {
    const entry = record(item);
    exact(entry, ["artifactPath", "digest"]);
    const artifactPath = text(entry.artifactPath);
    checkRelativePath(artifactPath);
    const digest = text(entry.digest);
    if (!digestPattern.test(digest) || paths.has(artifactPath) || digests.has(digest))
      throw new HostError("INVALID_INPUT", "Duplicate or invalid package lock entry");
    paths.add(artifactPath);
    digests.add(digest);
    return { artifactPath, digest };
  });
  const seen = new Set<string>();
  const activations = array(lock.activations).map((item) => {
    const entry = record(item);
    exact(entry, ["packageDigest", "exportName"]);
    const packageDigest = text(entry.packageDigest);
    const exportName = text(entry.exportName);
    const key = `${packageDigest}/${exportName}`;
    if (!digests.has(packageDigest) || !namePattern.test(exportName) || seen.has(key))
      throw new HostError("INVALID_INPUT", "Invalid activation lock entry");
    seen.add(key);
    return { packageDigest, exportName };
  });
  if (!packages.length || !activations.length)
    throw new HostError("INVALID_INPUT", "Bootstrap lock cannot be empty");
  return { format: 1, hostAbi: "fractal.host.v1", packages, activations };
}

export function parseDefinitionRef(value: unknown): DefinitionRef {
  const ref = record(value);
  exact(ref, ["packageId", "packageVersion", "digest", "name"]);
  const { packageId, packageVersion } = packageIdentity(ref.packageId, ref.packageVersion);
  const digest = text(ref.digest);
  const name = text(ref.name);
  if (!digestPattern.test(digest) || !namePattern.test(name)) {
    throw new HostError("INVALID_INPUT", "Invalid exact definition reference");
  }
  return { packageId, packageVersion, digest, name };
}

function packageIdentity(
  id: unknown,
  version: unknown,
): { packageId: string; packageVersion: string } {
  const packageId = text(id);
  const packageVersion = text(version);
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(packageId) ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      packageVersion,
    )
  )
    throw new HostError("INVALID_INPUT", "Invalid package identity");
  const versionCore = packageVersion.split("+")[0] ?? "";
  const prerelease = versionCore.split("-").slice(1).join("-");
  const build = packageVersion.split("+")[1];
  if (
    (prerelease &&
      prerelease
        .split(".")
        .some(
          (part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")),
        )) ||
    (build && build.split(".").some((part) => !part))
  )
    throw new HostError("INVALID_INPUT", "Invalid semver identifiers");
  return { packageId, packageVersion };
}

export function parseSourceRef(value: unknown): SourceDefinitionRef {
  const ref = record(value);
  if (Object.hasOwn(ref, "local")) {
    exact(ref, ["local"]);
    const local = text(ref.local);
    if (!namePattern.test(local)) throw new HostError("INVALID_INPUT", "Invalid local reference");
    return { local };
  }
  return parseDefinitionRef(value);
}

export function parseManifest(value: unknown): PackageManifest {
  assertJson(value);
  const manifest = record(value);
  exact(manifest, [
    "format",
    "packageId",
    "version",
    "hostAbi",
    "reload",
    "dependencies",
    "definitions",
    "exports",
  ]);
  if (manifest.format !== 1) throw new HostError("INVALID_INPUT", "Unknown manifest format");
  if (manifest.hostAbi !== "fractal.host.v1")
    throw new HostError("UNKNOWN_ABI", "Incompatible manifest ABI");
  const identity = packageIdentity(manifest.packageId, manifest.version);
  const names = new Set<string>();
  const definitions = array(manifest.definitions).map((item) => {
    const definition = record(item);
    exact(definition, ["name", "metaType", "value"]);
    const name = text(definition.name);
    if (!namePattern.test(name) || names.has(name))
      throw new HostError("DEFINITION_CONFLICT", "Duplicate or invalid definition name");
    names.add(name);
    return { name, metaType: parseSourceRef(definition.metaType), value: definition.value as Json };
  });
  const exports = Object.fromEntries(
    Object.entries(record(manifest.exports)).map(([key, value]) => {
      const entry = record(value);
      exact(entry, ["path", "exportName", "environment"]);
      const path = text(entry.path);
      const exportName = text(entry.exportName);
      checkRelativePath(path);
      if (
        !namePattern.test(key) ||
        !namePattern.test(exportName) ||
        (entry.environment !== "server" && entry.environment !== "client")
      )
        throw new HostError("INVALID_INPUT", "Invalid export descriptor");
      return [key, { path, exportName, environment: entry.environment }];
    }),
  ) as PackageManifest["exports"];
  const reload = record(manifest.reload);
  exact(reload, ["snapshotType", "serverEntry", "clientEntry"]);
  for (const environment of ["server", "client"] as const) {
    const name = reload[`${environment}Entry`];
    const present = Object.values(exports).some((entry) => entry.environment === environment);
    if (name !== null && (typeof name !== "string" || exports[name]?.environment !== environment))
      throw new HostError("INVALID_INPUT", "Invalid reload entry");
    if (present && name === null)
      throw new HostError("INVALID_INPUT", "Missing reload participant");
  }
  return {
    format: 1,
    packageId: identity.packageId,
    version: identity.packageVersion,
    hostAbi: "fractal.host.v1",
    reload: {
      snapshotType: parseSourceRef(reload.snapshotType),
      serverEntry: reload.serverEntry as string | null,
      clientEntry: reload.clientEntry as string | null,
    },
    dependencies: array(manifest.dependencies).map(parseDefinitionRef),
    definitions,
    exports,
  };
}
