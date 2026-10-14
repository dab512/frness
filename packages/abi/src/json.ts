export function assertJson(value: unknown, maxDepth = 64): void {
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (depth > maxDepth)
      throw Object.assign(new Error("JSON depth limit exceeded"), { code: "PAYLOAD_TOO_LARGE" });
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number" && Number.isFinite(current)) return;
    if (typeof current !== "object")
      throw Object.assign(new Error("Non-JSON value"), { code: "NON_JSON_VALUE" });
    const prototype = Object.getPrototypeOf(current);
    if (
      (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) ||
      ancestors.has(current)
    ) {
      throw Object.assign(new Error("Non-JSON object or cycle"), { code: "NON_JSON_VALUE" });
    }
    ancestors.add(current);
    if (Array.isArray(current)) {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const key of Reflect.ownKeys(current)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)
          throw Object.assign(new Error("Non-JSON array properties"), { code: "NON_JSON_VALUE" });
      }
      for (let index = 0; index < current.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
          throw Object.assign(new Error("JSON array accessors and holes forbidden"), {
            code: "NON_JSON_VALUE",
          });
        visit(descriptor.value, depth + 1);
      }
    } else {
      if (Reflect.ownKeys(current).length !== Object.keys(current).length)
        throw Object.assign(new Error("Non-JSON keys"), { code: "NON_JSON_VALUE" });
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
        if (!Object.hasOwn(descriptor, "value"))
          throw Object.assign(new Error("JSON accessors forbidden"), { code: "NON_JSON_VALUE" });
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(current);
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
    throw Object.assign(new Error("JSON size limit exceeded"), { code: "PAYLOAD_TOO_LARGE" });
}

export function freezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  assertJson(value);
  function sorted(current: unknown): unknown {
    if (Array.isArray(current)) return current.map(sorted);
    if (current && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, sorted(child)]),
      );
    }
    return current;
  }
  return JSON.stringify(sorted(value));
}
