import { canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  ObjectRecord,
  SubscriptionEvent,
  SubscriptionSnapshot,
} from "../../../specs/fractal-harness/contracts.js";

export interface StorageSubscription {
  snapshot(): SubscriptionSnapshot;
  catchUp(cursor: string): readonly SubscriptionEvent[];
  close(): void;
}

/** Local delivery state. A gap never advances the cursor; the caller fetches catchUp(cursor). */
export class SubscriptionReplica {
  #cursor = "";
  #records = new Map<string, ObjectRecord>();
  #seen = new Map<string, string>();
  get cursor(): string {
    return this.#cursor;
  }
  get records(): readonly ObjectRecord[] {
    return structuredClone([...this.#records.values()]);
  }
  reset(snapshot: SubscriptionSnapshot): void {
    // Only use reset for initial attach or a confirmed CURSOR_EXPIRED, never a late response.
    this.#cursor = snapshot.cursor;
    this.#seen.clear();
    this.#records.clear();
    for (const record of snapshot.records)
      this.#records.set(this.#key(record), structuredClone(record));
  }
  #key(record: ObjectRecord): string {
    return canonicalJson([
      record.object.storeId,
      record.object.namespaceId,
      record.object.objectId,
    ]);
  }
  apply(event: SubscriptionEvent): "applied" | "duplicate" | "gap" {
    const payload = canonicalJson(event.value);
    const previous = this.#seen.get(event.eventId);
    if (previous !== undefined) {
      if (previous !== payload)
        throw Object.assign(new Error("Conflicting event payload"), { code: "EVENT_CONFLICT" });
      return "duplicate";
    }
    if (event.previousCursor !== this.#cursor) return "gap";
    const change = event.value as unknown as { record: ObjectRecord; deleted: boolean };
    if (
      !change ||
      typeof change.deleted !== "boolean" ||
      !change.record?.object ||
      !change.record.revision
    )
      throw Object.assign(new Error("Invalid storage change"), { code: "INVALID_INPUT" });
    const key = this.#key(change.record);
    if (change.deleted) this.#records.delete(key);
    else this.#records.set(key, structuredClone(change.record));
    this.#seen.set(event.eventId, payload);
    this.#cursor = event.cursor;
    return "applied";
  }
}
