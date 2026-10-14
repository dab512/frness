import type { DefinitionRef } from "./index.js";

export function definitionKey(ref: DefinitionRef): string {
  return JSON.stringify([ref.packageId, ref.packageVersion, ref.digest, ref.name]);
}
