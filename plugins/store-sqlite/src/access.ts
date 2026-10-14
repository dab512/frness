import { assertJson } from "../../../packages/abi/src/json.js";
import type { Json } from "../../../specs/fractal-harness/contracts.js";

function isObject(value: Json): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Schema projection capability: callers must supply a resolved schema, never raw credentials. */
export function redact(value: Json, schema: Json): Json {
  assertJson(value);
  assertJson(schema);
  function project(current: Json, shape: Json): Json | undefined {
    if (!isObject(shape)) return structuredClone(current);
    if (shape["x-sensitive"] === true) return undefined;
    // Unresolved references or combinators cannot safely certify a field as public.
    if (shape.$ref || shape.allOf || shape.anyOf || shape.oneOf || shape.if) return undefined;
    if (Array.isArray(current)) {
      return current.map((item) => project(item, shape.items ?? {}) ?? null);
    }
    if (current && typeof current === "object") {
      const properties = shape.properties;
      const result: Record<string, Json> = {};
      for (const [key, child] of Object.entries(current)) {
        const property = properties && isObject(properties) ? properties[key] : undefined;
        const projected = project(child, property ?? shape.additionalProperties ?? {});
        if (projected !== undefined) result[key] = projected;
      }
      return result;
    }
    return current;
  }
  return project(value, schema) ?? null;
}
