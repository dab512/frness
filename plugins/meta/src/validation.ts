import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  BootstrapDescription,
  ExportValidation,
  ResolvedDefinition,
} from "../../../packages/abi/src/bootstrap.js";
import type { DefinitionRef, Json, JsonSchema } from "../../../packages/abi/src/index.js";
import { assertJson } from "../../../packages/abi/src/json.js";

export function definitionKey(ref: DefinitionRef): string {
  return JSON.stringify([ref.packageId, ref.packageVersion, ref.digest, ref.name]);
}

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT" });
}

function dataObject(value: Json | undefined): { readonly [key: string]: Json } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected metadata object");
  return value as { readonly [key: string]: Json };
}

export function createSchemaEngine(definitions: readonly ResolvedDefinition[]) {
  const engine = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  engine.addKeyword({ keyword: "x-definition-ref", valid: true });
  engine.addKeyword({ keyword: "x-sensitive", valid: true });
  const seedTypes = new Set(
    definitions
      .filter((entry) => entry.ref.packageId === "std.meta" && entry.name === "Type")
      .map((entry) => definitionKey(entry.ref)),
  );
  if (seedTypes.size === 0) fail("Missing meta.Type");
  for (const definition of definitions) {
    if (!seedTypes.has(definitionKey(definition.metaType))) continue;
    const type = dataObject(definition.value);
    const references = dataObject(type.references);
    const schema = structuredClone(dataObject(type.schema)) as Record<string, Json>;
    function resolveAliases(value: Json): Json {
      if (Array.isArray(value)) return value.map(resolveAliases);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => {
            if (["default", "const", "enum", "examples"].includes(key)) return [key, child];
            if (key !== "$ref" || typeof child !== "string") return [key, resolveAliases(child)];
            if (child.startsWith("#")) return [key, child];
            if (!child.startsWith("type:")) fail("External schema references forbidden");
            const target = references[child.slice(5)];
            if (!target || typeof target !== "object" || Array.isArray(target))
              fail("Missing schema alias");
            return [
              key,
              `urn:frness:${encodeURIComponent(definitionKey(target as unknown as DefinitionRef))}`,
            ];
          }),
        );
      }
      return value;
    }
    const normalized = resolveAliases(schema) as Record<string, Json>;
    normalized.$id = `urn:frness:${encodeURIComponent(definitionKey(definition.ref))}`;
    try {
      engine.addSchema(normalized);
    } catch (error) {
      fail(`Invalid schema ${definition.name}: ${String(error)}`);
    }
  }
  for (const definition of definitions) {
    if (!seedTypes.has(definitionKey(definition.metaType))) continue;
    try {
      engine.getSchema(`urn:frness:${encodeURIComponent(definitionKey(definition.ref))}`);
    } catch (error) {
      fail(`Invalid schema ${definition.name}: ${String(error)}`);
    }
  }
  return engine;
}

export function validateDescription(
  description: BootstrapDescription,
): readonly ExportValidation[] {
  const engine = createSchemaEngine(description.definitions);
  const checks: ExportValidation[] = [];
  for (const definition of description.definitions) {
    assertJson(definition.value);
    const validator = engine.getSchema(
      `urn:frness:${encodeURIComponent(definitionKey(definition.metaType))}`,
    );
    if (!validator || !validator(definition.value))
      fail(`Invalid definition ${definition.name}: ${engine.errorsText(validator?.errors)}`);
    if (definition.metaType.packageId === "std.meta" && definition.metaType.name === "Type") {
      const type = dataObject(definition.value);
      if (!engine.validateSchema(type.schema as JsonSchema))
        fail(`Invalid JSON schema ${definition.name}`);
    }
    if (
      definition.metaType.packageId === "std.meta" &&
      definition.metaType.name === "Implementation"
    ) {
      const value = dataObject(definition.value);
      const abi = value.abi;
      const entry = value.entry;
      if (typeof abi !== "string" || !description.availableAbis?.includes(abi))
        throw Object.assign(new Error(`Unknown ABI ${String(abi)}`), { code: "UNKNOWN_ABI" });
      if (typeof entry !== "string") fail("Invalid implementation entry");
      checks.push({ packageDigest: definition.ref.digest, entry, abi });
    }
  }
  for (const owner of description.packages) {
    const snapshot = description.definitions.find(
      (definition) => definitionKey(definition.ref) === definitionKey(owner.snapshotType),
    );
    if (
      !snapshot ||
      snapshot.metaType.packageId !== "std.meta" ||
      snapshot.metaType.name !== "Type"
    )
      fail("Reload snapshot must reference a Type");
  }
  return checks;
}
