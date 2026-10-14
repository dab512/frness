import type {
  BootstrapDescription,
  ResolvedDefinition,
  ResolvedPackage,
} from "../../abi/src/bootstrap.js";
import type {
  DefinitionRef,
  Json,
  PackageManifest,
  SourceDefinitionRecord,
  SourceDefinitionRef,
} from "../../abi/src/index.js";
import { freezeJson } from "../../abi/src/json.js";
import { definitionKey } from "../../abi/src/references.js";
import { HostError } from "./errors.js";
import { parseSourceRef, record } from "./validation.js";

export interface SourcePackage {
  readonly digest: string;
  readonly source: PackageManifest;
}
export const seedMarkers: Readonly<Record<string, readonly string[]>> = {
  Type: ["references.*"],
  Contract: ["allowedEffects[]", "conformanceSuite", "operations.*.input", "operations.*.output"],
  Implementation: ["configurationType", "contracts[]", "slots[].accepts", "stateType"],
  Slot: ["accepts"],
  Instance: ["implementation"],
  Binding: [],
  Assembly: ["instances[].implementation"],
  ConformanceSuite: ["targetContract"],
};
const seedRequired: Readonly<Record<string, readonly string[]>> = {
  Type: ["schema", "references"],
  Contract: ["operations", "conformanceSuite", "allowedEffects"],
  Implementation: [
    "contracts",
    "configurationType",
    "stateType",
    "slots",
    "entry",
    "abi",
    "requiredCapabilities",
  ],
  Slot: ["name", "accepts", "collection", "min", "max"],
  Instance: ["instanceId", "implementation", "configuration", "stateNamespaceId", "scopeId"],
  Binding: ["parentInstanceId", "slot", "childInstanceId"],
  Assembly: ["assemblyId", "revision", "rootInstanceId", "profile", "instances", "bindings"],
  ConformanceSuite: ["entry", "targetContract"],
};

function schemaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function markerPaths(schema: unknown, prefix = ""): string[] {
  const node = schemaObject(schema);
  if (node["x-definition-ref"] === true) return [prefix];
  const result: string[] = [];
  for (const [key, child] of Object.entries(schemaObject(node.properties)))
    result.push(...markerPaths(child, prefix ? `${prefix}.${key}` : key));
  if (node.items && !Array.isArray(node.items))
    result.push(...markerPaths(node.items, `${prefix}[]`));
  if (node.additionalProperties && typeof node.additionalProperties === "object")
    result.push(...markerPaths(node.additionalProperties, prefix ? `${prefix}.*` : "*"));
  return result.sort();
}

export function resolvePackages(packages: readonly SourcePackage[]): BootstrapDescription {
  const raw = new Map<
    string,
    {
      readonly definition: SourceDefinitionRecord;
      readonly owner: SourcePackage;
      readonly ref: DefinitionRef;
    }
  >();
  const identities = new Map<string, string>();
  for (const owner of packages) {
    const identity = JSON.stringify([owner.source.packageId, owner.source.version]);
    const existing = identities.get(identity);
    if (existing && existing !== owner.digest)
      throw new HostError("DEFINITION_CONFLICT", "Package identity has different bytes");
    identities.set(identity, owner.digest);
    for (const definition of owner.source.definitions) {
      const ref = {
        packageId: owner.source.packageId,
        packageVersion: owner.source.version,
        digest: owner.digest,
        name: definition.name,
      };
      if (raw.has(definitionKey(ref)))
        throw new HostError("DEFINITION_CONFLICT", "Duplicate definition");
      raw.set(definitionKey(ref), { definition, owner, ref });
    }
  }
  const first = packages[0];
  if (!first || first.source.packageId !== "std.meta")
    throw new HostError("BOOTSTRAP_PACKAGE_MISSING", "First package must contain the meta seed");
  for (const [name, expected] of Object.entries(seedMarkers)) {
    const definition = first.source.definitions.find((entry) => entry.name === name);
    if (
      !definition ||
      !Object.hasOwn(definition.metaType, "local") ||
      (definition.metaType as { local: string }).local !== "Type"
    )
      throw new HostError("INVALID_INPUT", `Missing or invalid seed type ${name}`);
    const value = record(definition.value);
    if (
      !Object.hasOwn(value, "schema") ||
      !Object.hasOwn(value, "references") ||
      Object.keys(value).length !== 2
    )
      throw new HostError("INVALID_INPUT", "Invalid TypeDefinition seed");
    if (JSON.stringify(markerPaths(value.schema)) !== JSON.stringify([...expected].sort()))
      throw new HostError("INVALID_INPUT", `Seed marker mismatch: ${name}`);
    const schema = record(value.schema);
    const required = schema.required;
    if (
      schema.type !== "object" ||
      schema.additionalProperties !== false ||
      !Array.isArray(required) ||
      JSON.stringify([...required].sort()) !==
        JSON.stringify([...(seedRequired[name] ?? [])].sort())
    )
      throw new HostError("INVALID_INPUT", `Seed grammar mismatch: ${name}`);
  }

  function resolveRef(input: SourceDefinitionRef, owner: SourcePackage): DefinitionRef {
    const ref =
      "local" in input
        ? {
            packageId: owner.source.packageId,
            packageVersion: owner.source.version,
            digest: owner.digest,
            name: input.local,
          }
        : input;
    if (!raw.has(definitionKey(ref)))
      throw new HostError("PINNED_DEPENDENCY_MISSING", `Unknown definition ${ref.name}`);
    if (
      ref.digest !== owner.digest &&
      !owner.source.dependencies.some(
        (dependency) =>
          dependency.digest === ref.digest &&
          dependency.packageId === ref.packageId &&
          dependency.packageVersion === ref.packageVersion,
      )
    )
      throw new HostError("PINNED_DEPENDENCY_MISSING", "Undeclared external package dependency");
    return ref;
  }

  for (const [index, owner] of packages.entries()) {
    for (const dependency of owner.source.dependencies) {
      const earlier = packages.findIndex(
        (candidate) =>
          candidate.digest === dependency.digest &&
          candidate.source.packageId === dependency.packageId &&
          candidate.source.version === dependency.packageVersion,
      );
      if (earlier < 0 || earlier >= index || !raw.has(definitionKey(dependency)))
        throw new HostError("PINNED_DEPENDENCY_MISSING", "Dependency must precede its package");
    }
  }

  function resolveValue(value: Json, schema: unknown, owner: SourcePackage): Json {
    const node = schemaObject(schema);
    if (node["x-definition-ref"] === true) return { ...resolveRef(parseSourceRef(value), owner) };
    if (Array.isArray(value) && node.items)
      return value.map((child) => resolveValue(child, node.items, owner));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const properties = schemaObject(node.properties);
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          resolveValue(child, properties[key] ?? node.additionalProperties, owner),
        ]),
      );
    }
    return value;
  }

  const resolvedPackages: ResolvedPackage[] = packages.map((owner) => {
    const definitions: ResolvedDefinition[] = owner.source.definitions.map((definition) => {
      const metaType = resolveRef(definition.metaType, owner);
      const meta = raw.get(definitionKey(metaType));
      if (!meta) throw new HostError("PINNED_DEPENDENCY_MISSING", "Missing meta type");
      const metaValue = record(meta.definition.value);
      if (!metaValue.schema || typeof metaValue.schema !== "object")
        throw new HostError("INVALID_INPUT", "Meta type must describe a schema");
      const value = resolveValue(definition.value, metaValue.schema, owner);
      const ref = {
        packageId: owner.source.packageId,
        packageVersion: owner.source.version,
        digest: owner.digest,
        name: definition.name,
      };
      return { ref, name: definition.name, metaType, value };
    });
    return {
      ...owner,
      definitions,
      snapshotType: resolveRef(owner.source.reload.snapshotType, owner),
    };
  });
  return freezeJson({
    packages: resolvedPackages,
    definitions: resolvedPackages.flatMap((owner) => owner.definitions),
  });
}
