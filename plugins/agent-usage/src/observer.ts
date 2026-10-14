import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  ExecutionContext,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { EventObserver } from "../../agent-runtime/src/runtime.js";

export interface UsageMapping {
  readonly eventType: TypeRef;
  readonly selectorPath: readonly string[];
  readonly selectorValue: string;
  readonly amountPath: readonly string[];
  readonly unit: string;
}
export interface UsageOptions {
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly types: (name: string) => TypeRef;
  readonly mappings: readonly UsageMapping[];
}
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function at(value: Json, path: readonly string[]): Json | undefined {
  let current: Json | undefined = value;
  for (const key of path) {
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    current = (current as { readonly [key: string]: Json })[key];
  }
  return current;
}
export class UsageObserver implements EventObserver {
  #queue = Promise.resolve();
  constructor(readonly options: UsageOptions) {}
  #ref(type: string, id: string): ObjectRef {
    return {
      storeId: this.options.storeId,
      namespaceId: this.options.namespaceId,
      objectId: `${type}/${id}`,
      type: this.options.types(type),
    };
  }
  async #maybe(ref: ObjectRef): Promise<ObjectRecord | undefined> {
    try {
      return await this.options.store.read(this.options.context, ref);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }
  observe(input: { readonly session: ObjectRef; readonly event: ObjectRecord }): Promise<void> {
    const work = this.#queue.then(() => this.#consume(input));
    this.#queue = work.catch(() => {});
    return work;
  }
  async #consume(input: {
    readonly session: ObjectRef;
    readonly event: ObjectRecord;
  }): Promise<void> {
    const envelope = input.event.value as unknown as {
      event: { kind: string; type?: TypeRef; value?: Json };
    };
    if (
      envelope.event.kind !== "provider" ||
      !envelope.event.type ||
      envelope.event.value === undefined
    )
      return;
    for (const mapping of this.options.mappings) {
      if (
        definitionKey(mapping.eventType) !== definitionKey(envelope.event.type) ||
        at(envelope.event.value, mapping.selectorPath) !== mapping.selectorValue
      )
        continue;
      const source = { object: input.event.object, revision: input.event.revision };
      const id = hash([source, mapping]);
      const sampleRef = this.#ref("Sample", id);
      const raw = at(envelope.event.value, mapping.amountPath);
      const amount = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
      const sample = { source, session: input.session, unit: mapping.unit, amount };
      const previous = await this.#maybe(sampleRef);
      if (previous) {
        if (canonicalJson(previous.value) !== canonicalJson(sample))
          throw Object.assign(new Error("Usage event conflict"), { code: "EVENT_CONFLICT" });
        continue;
      }
      const summaryRef = this.#ref("Summary", hash([input.session, mapping.unit]));
      const summary = await this.#maybe(summaryRef);
      const total = summary ? (summary.value as { total: number | null }).total : 0;
      const next =
        amount === null || total === null || !Number.isSafeInteger(total + amount)
          ? null
          : total + amount;
      await this.options.store.commit(this.options.context, {
        commitKey: `usage/${id}`,
        readSet: [],
        events: [],
        writes: [
          { kind: "create", object: sampleRef, value: json(sample) },
          summary
            ? {
                kind: "replace",
                object: summaryRef,
                expectedRevision: summary.revision,
                value: json({ session: input.session, unit: mapping.unit, total: next }),
              }
            : {
                kind: "create",
                object: summaryRef,
                value: json({ session: input.session, unit: mapping.unit, total: next }),
              },
        ],
      });
    }
  }
  async summary(session: ObjectRef, unit: string): Promise<Json | undefined> {
    return (await this.#maybe(this.#ref("Summary", hash([session, unit]))))?.value;
  }
}
