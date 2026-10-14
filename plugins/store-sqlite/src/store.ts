import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { assertJson, canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  CommitBatch,
  CommitReceipt,
  ExecutionContext,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  TypeRef,
  VersionedObjectRef,
} from "../../../specs/fractal-harness/contracts.js";

interface Namespace {
  owner: string;
  scope: string;
}
interface Head {
  revision: string;
  type_ref: string;
  deleted: number;
}
interface RevisionRow extends Head {
  value: string;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

export interface SqliteStoreOptions {
  readonly path: string;
  readonly storeId: string;
  readonly validate: (type: TypeRef, value: unknown) => void;
}

export class SqliteObjectStore implements ObjectStore {
  readonly storeId: string;
  #db: Database.Database;
  #validate: SqliteStoreOptions["validate"];

  constructor(options: SqliteStoreOptions) {
    this.storeId = options.storeId;
    this.#validate = options.validate;
    this.#db = new Database(options.path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("synchronous = FULL");
    this.#db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    const identity = this.#db.prepare("SELECT value FROM metadata WHERE key='storeId'").get() as
      | { value: string }
      | undefined;
    if (identity && identity.value !== this.storeId) {
      this.#db.close();
      fail("DEFINITION_CONFLICT", "Store identity cannot change");
    }
    this.#db
      .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('storeId',?)")
      .run(this.storeId);
  }

  registerNamespace(id: string, owner: string, scope: string): void {
    const existing = this.#db.prepare("SELECT owner,scope FROM namespaces WHERE id=?").get(id) as
      | Namespace
      | undefined;
    if (existing && (existing.owner !== owner || existing.scope !== scope))
      fail("DEFINITION_CONFLICT", "Namespace has a different owner");
    this.#db
      .prepare("INSERT OR IGNORE INTO namespaces(id,owner,scope) VALUES(?,?,?)")
      .run(id, owner, scope);
  }

  #authorize(context: ExecutionContext, ref: ObjectRef): void {
    if (ref.storeId !== this.storeId) fail("CAPABILITY_DENIED", "Store is not accessible");
    const namespace = this.#db
      .prepare("SELECT owner,scope FROM namespaces WHERE id=?")
      .get(ref.namespaceId) as Namespace | undefined;
    if (
      !namespace ||
      namespace.owner !== context.ownerInstanceId ||
      namespace.scope !== context.scopeId
    )
      fail("CAPABILITY_DENIED", "Namespace is not accessible");
  }

  #head(ref: ObjectRef): Head | undefined {
    const head = this.#db
      .prepare("SELECT revision,type_ref,deleted FROM heads WHERE namespace=? AND object_id=?")
      .get(ref.namespaceId, ref.objectId) as Head | undefined;
    if (head && head.type_ref !== canonicalJson(ref.type))
      fail("UNSUPPORTED_SCHEMA_VERSION", "Object type cannot change");
    return head;
  }

  async read(context: ExecutionContext, ref: ObjectRef, revision?: string): Promise<ObjectRecord> {
    this.#authorize(context, ref);
    const head = this.#head(ref);
    if (!head || (revision === undefined && head.deleted))
      fail("NOT_FOUND", "Object does not exist");
    const selected = revision ?? head.revision;
    const row = this.#db
      .prepare(
        "SELECT revision,type_ref,value,deleted FROM revisions WHERE namespace=? AND object_id=? AND revision=?",
      )
      .get(ref.namespaceId, ref.objectId, selected) as RevisionRow | undefined;
    if (!row || row.deleted) fail("SNAPSHOT_UNAVAILABLE", "Requested revision is unavailable");
    return { object: structuredClone(ref), revision: row.revision, value: JSON.parse(row.value) };
  }

  async commit(context: ExecutionContext, input: CommitBatch): Promise<CommitReceipt> {
    assertJson(input, 64, 10 * 1024 * 1024);
    const batch = structuredClone(input);
    if (typeof batch.commitKey !== "string" || !batch.commitKey)
      fail("INVALID_INPUT", "Commit key is required");
    if (batch.writes.length > 1000) fail("PAYLOAD_TOO_LARGE", "Excessive commit batch");
    const ids = new Set<string>();
    for (const write of batch.writes) {
      this.#authorize(context, write.object);
      const key = JSON.stringify([write.object.namespaceId, write.object.objectId]);
      if (ids.has(key)) fail("INVALID_INPUT", "One object cannot be written twice in a batch");
      ids.add(key);
      if (write.kind !== "create" && !write.expectedRevision)
        fail("INVALID_INPUT", "Expected revision is required");
      if (write.kind !== "tombstone") {
        assertJson(write.value);
        const result: unknown = this.#validate(write.object.type, write.value);
        if (result !== undefined)
          fail("INVALID_OUTPUT", "Schema capability must validate synchronously or throw");
      }
    }
    for (const reference of batch.readSet) this.#authorize(context, reference.object);
    for (const event of batch.events) {
      if (!event.eventId) fail("INVALID_INPUT", "Event ID is required");
      assertJson(event.value);
      const result: unknown = this.#validate(event.type, event.value);
      if (result !== undefined)
        fail("INVALID_OUTPUT", "Schema capability must validate synchronously or throw");
    }
    const scopeKey = canonicalJson([
      this.storeId,
      context.principalId,
      context.scopeId,
      context.ownerInstanceId,
      batch.commitKey,
    ]);
    const payload = canonicalJson(batch, 10 * 1024 * 1024);
    return this.#db
      .transaction((): CommitReceipt => {
        const previous = this.#db
          .prepare("SELECT payload,receipt FROM commits WHERE key=?")
          .get(scopeKey) as { payload: string; receipt: string } | undefined;
        if (previous) {
          if (previous.payload !== payload)
            fail("IDEMPOTENCY_CONFLICT", "Commit key has a different payload");
          return JSON.parse(previous.receipt) as CommitReceipt;
        }
        for (const reference of batch.readSet) {
          if (this.#head(reference.object)?.revision !== reference.revision)
            fail("REVISION_CONFLICT", "Read set changed");
        }
        for (const write of batch.writes) {
          const current = this.#head(write.object);
          if (write.kind === "create") {
            if (current) fail("OBJECT_EXISTS", "Object already exists");
          } else if (!current || current.revision !== write.expectedRevision)
            fail("REVISION_CONFLICT", "Expected revision changed");
        }
        for (const event of batch.events) {
          const eventPayload = canonicalJson({
            type: event.type,
            value: event.value,
            owner: context.ownerInstanceId,
            scope: context.scopeId,
          });
          const existing = this.#db
            .prepare("SELECT payload FROM events WHERE id=?")
            .get(event.eventId) as { payload: string } | undefined;
          if (existing && existing.payload !== eventPayload)
            fail("EVENT_CONFLICT", "Event identity has conflicting data");
        }
        const records: VersionedObjectRef[] = [];
        for (const write of batch.writes) {
          const revision = randomUUID();
          const deleted = write.kind === "tombstone" ? 1 : 0;
          const value = write.kind === "tombstone" ? "null" : canonicalJson(write.value);
          const type = canonicalJson(write.object.type);
          this.#db
            .prepare(
              "INSERT INTO revisions(namespace,object_id,revision,type_ref,value,deleted) VALUES(?,?,?,?,?,?)",
            )
            .run(write.object.namespaceId, write.object.objectId, revision, type, value, deleted);
          this.#db
            .prepare(
              "INSERT INTO heads(namespace,object_id,revision,type_ref,deleted) VALUES(?,?,?,?,?) ON CONFLICT(namespace,object_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted",
            )
            .run(write.object.namespaceId, write.object.objectId, revision, type, deleted);
          const eventId = randomUUID();
          this.#db
            .prepare(
              "INSERT INTO changes(event_id,namespace,object_id,revision,value) VALUES(?,?,?,?,?)",
            )
            .run(
              eventId,
              write.object.namespaceId,
              write.object.objectId,
              revision,
              canonicalJson({ object: write.object, revision, deleted: deleted === 1 }),
            );
          records.push({ object: write.object, revision });
        }
        for (const event of batch.events) {
          const eventPayload = canonicalJson({
            type: event.type,
            value: event.value,
            owner: context.ownerInstanceId,
            scope: context.scopeId,
          });
          this.#db
            .prepare("INSERT OR IGNORE INTO events(id,payload) VALUES(?,?)")
            .run(event.eventId, eventPayload);
        }
        const sequence = (
          this.#db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes").get() as {
            sequence: number;
          }
        ).sequence;
        const cursor = randomUUID();
        this.#db
          .prepare("INSERT INTO cursors(token,sequence,principal,owner,scope) VALUES(?,?,?,?,?)")
          .run(cursor, sequence, context.principalId, context.ownerInstanceId, context.scopeId);
        const receipt: CommitReceipt = { commitId: randomUUID(), records, cursor };
        this.#db
          .prepare("INSERT INTO commits(key,payload,receipt) VALUES(?,?,?)")
          .run(scopeKey, payload, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }

  close(): void {
    if (this.#db.open) this.#db.close();
  }
}
