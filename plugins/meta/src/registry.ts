import type {
  BootstrapDescription,
  ResolvedDefinition,
  ResolvedPackage,
} from "../../../packages/abi/src/bootstrap.js";
import type { DefinitionRef } from "../../../packages/abi/src/index.js";
import { assertJson, canonicalJson, freezeJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import { createSchemaEngine, validateDescription } from "./validation.js";

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const packageKey = (owner: ResolvedPackage) =>
  JSON.stringify([owner.source.packageId, owner.source.version]);

export class DefinitionRegistry {
  #packages = new Map<string, ResolvedPackage>();
  #definitions = new Map<string, ResolvedDefinition>();
  #engine: ReturnType<typeof createSchemaEngine>;
  #availableAbis: readonly string[];

  constructor(description: BootstrapDescription) {
    this.#availableAbis = Object.freeze([...(description.availableAbis ?? [])]);
    this.#engine = createSchemaEngine(description.definitions);
    this.install(description);
  }

  install(description: BootstrapDescription): void {
    const packages = new Map(this.#packages);
    for (const owner of description.packages) {
      const key = packageKey(owner);
      const existing = packages.get(key);
      if (existing) {
        if (
          existing.digest !== owner.digest ||
          canonicalJson(existing.definitions) !== canonicalJson(owner.definitions)
        )
          fail("DEFINITION_CONFLICT", `Conflicting package ${owner.source.packageId}`);
      } else packages.set(key, owner);
      for (const definition of owner.definitions) {
        if (
          definition.ref.packageId !== owner.source.packageId ||
          definition.ref.packageVersion !== owner.source.version ||
          definition.ref.digest !== owner.digest ||
          definition.ref.name !== definition.name
        )
          fail("DEFINITION_CONFLICT", "Definition identity does not match its package");
      }
    }
    const candidate: BootstrapDescription = freezeJson({
      packages: [...packages.values()],
      definitions: [...packages.values()].flatMap((owner) => owner.definitions),
      availableAbis: this.#availableAbis,
    });
    validateDescription(candidate);
    const engine = createSchemaEngine(candidate.definitions);
    const definitions = new Map(
      candidate.definitions.map((definition) => [definitionKey(definition.ref), definition]),
    );
    if (definitions.size !== candidate.definitions.length)
      fail("DEFINITION_CONFLICT", "Duplicate definition identity");
    this.#engine = engine;
    this.#definitions = definitions;
    this.#packages = packages;
  }

  get(ref: DefinitionRef): ResolvedDefinition {
    const definition = this.#definitions.get(definitionKey(ref));
    if (!definition) fail("PINNED_DEPENDENCY_MISSING", `Unknown definition ${ref.name}`);
    return definition;
  }

  definitions(): readonly ResolvedDefinition[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  validate(ref: DefinitionRef, value: unknown): void {
    assertJson(value);
    const definition = this.get(ref);
    if (definition.metaType.packageId !== "std.meta" || definition.metaType.name !== "Type")
      fail("INVALID_INPUT", "Reference is not a Type");
    const validator = this.#engine.getSchema(
      `urn:frness:${encodeURIComponent(definitionKey(ref))}`,
    );
    if (!validator || !validator(value))
      fail("INVALID_INPUT", this.#engine.errorsText(validator?.errors));
  }
}
