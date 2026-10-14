import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { assertJson, canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  CommitBatch,
  CommitReceipt,
  ExecutionContext,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  TypeRef,
  VersionedObjectRef,
} from "../../../specs/fractal-harness/contracts.js";
import { namespaceGrant } from "./access.js";
import type { StorageSubscription } from "./subscriptions.js";

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
  readonly database?: typeof Database;
  readonly project?: (type: TypeRef, value: Json) => Json;
  readonly cursorLifetimeMs?: number;
  readonly now?: () => number;
}

export class SqliteObjectStore implements ObjectStore {
  readonly storeId: string;
  #db: Database.Database;
  #validate: SqliteStoreOptions["validate"];
  #project: NonNullable<SqliteStoreOptions["project"]>;
  #now: () => number;
  #cursorLifetime: number;

  constructor(options: SqliteStoreOptions) {
    this.storeId = options.storeId;
    this.#validate = options.validate;
    this.#project =
      options.project ?? (() => fail("CAPABILITY_DENIED", "Projection capability is unavailable"));
    this.#now = options.now ?? Date.now;
    this.#cursorLifetime = options.cursorLifetimeMs ?? 86400000;
    if (!Number.isFinite(this.#cursorLifetime) || this.#cursorLifetime <= 0)
      fail("INVALID_INPUT", "Cursor lifetime must be positive");
    const connect =
      options.database ?? (createRequire(import.meta.url)("better-sqlite3") as typeof Database);
    this.#db = new connect(options.path);
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

  #authorize(
    context: ExecutionContext,
    ref: ObjectRef,
    permission: "read" | "write" = "write",
  ): void {
    if (ref.storeId !== this.storeId) fail("CAPABILITY_DENIED", "Store is not accessible");
    const namespace = this.#db
      .prepare("SELECT owner,scope FROM namespaces WHERE id=?")
      .get(ref.namespaceId) as Namespace | undefined;
    if (
      !namespace ||
      (namespace.owner !== context.ownerInstanceId &&
        !context.grants.includes(namespaceGrant(this.storeId, ref.namespaceId, permission))) ||
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
    this.#authorize(context, ref, "read");
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

  project(type: TypeRef, value: Json): Json {
    const projected = this.#project(type, value);
    assertJson(projected);
    return structuredClone(projected);
  }
  subscribe(input: ExecutionContext, namespaceId: string): StorageSubscription {
    const context = structuredClone(input);
    const authorize = () =>
      this.#authorize(
        context,
        {
          storeId: this.storeId,
          namespaceId,
          objectId: "",
          type: {} as TypeRef,
        },
        "read",
      );
    authorize();
    let closed = false;
    const check = () => {
      if (closed) fail("SUBSCRIPTION_CLOSED", "Subscription is closed");
      authorize();
    };
    const cursor = (sequence: number): string => {
      const token = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO subscription_cursors(token,namespace,sequence,principal,owner,scope,issued_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          token,
          namespaceId,
          sequence,
          context.principalId,
          context.ownerInstanceId,
          context.scopeId,
          this.#now(),
        );
      return token;
    };
    const record = (objectId: string, row: RevisionRow): ObjectRecord => {
      const type = JSON.parse(row.type_ref) as TypeRef;
      const value = this.#project(type, JSON.parse(row.value) as Json);
      assertJson(value);
      return {
        object: { storeId: this.storeId, namespaceId, objectId, type },
        revision: row.revision,
        value,
      };
    };
    return {
      snapshot: () => {
        check();
        return this.#db
          .transaction(() => {
            const rows = this.#db
              .prepare(
                "SELECT h.object_id,r.* FROM heads h JOIN revisions r ON h.namespace=r.namespace AND h.object_id=r.object_id AND h.revision=r.revision WHERE h.namespace=? AND h.deleted=0 ORDER BY h.object_id",
              )
              .all(namespaceId) as (RevisionRow & { object_id: string })[];
            const sequence = (
              this.#db
                .prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM changes")
                .get() as { sequence: number }
            ).sequence;
            return {
              cursor: cursor(sequence),
              records: rows.map((row) => record(row.object_id, row)),
            };
          })
          .immediate();
      },
      catchUp: (token) => {
        check();
        return this.#db
          .transaction(() => {
            const from = this.#db
              .prepare("SELECT * FROM subscription_cursors WHERE token=?")
              .get(token) as
              | {
                  namespace: string;
                  sequence: number;
                  principal: string;
                  owner: string;
                  scope: string;
                  issued_at: number;
                }
              | undefined;
            if (
              !from ||
              from.namespace !== namespaceId ||
              from.principal !== context.principalId ||
              from.owner !== context.ownerInstanceId ||
              from.scope !== context.scopeId
            )
              fail("CAPABILITY_DENIED", "Cursor is not accessible");
            if (this.#now() - from.issued_at > this.#cursorLifetime)
              fail("CURSOR_EXPIRED", "Cursor has expired");
            const rows = this.#db
              .prepare(
                "SELECT c.sequence,c.event_id,c.object_id,r.* FROM changes c JOIN revisions r ON c.namespace=r.namespace AND c.object_id=r.object_id AND c.revision=r.revision WHERE c.namespace=? AND c.sequence>? ORDER BY c.sequence",
              )
              .all(namespaceId, from.sequence) as (RevisionRow & {
              sequence: number;
              event_id: string;
              object_id: string;
            })[];
            let previousCursor = token;
            return rows.map((row) => {
              const nextCursor = cursor(row.sequence);
              const event = {
                eventId: row.event_id,
                previousCursor,
                cursor: nextCursor,
                value: JSON.parse(
                  canonicalJson({ record: record(row.object_id, row), deleted: row.deleted === 1 }),
                ) as Json,
              };
              previousCursor = nextCursor;
              return event;
            });
          })
          .immediate();
      },
      close: () => {
        closed = true;
      },
    };
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
      if (
        write.revision !== undefined &&
        (typeof write.revision !== "string" || !write.revision || write.revision.length > 256)
      )
        fail("INVALID_INPUT", "Planned revision must be a bounded opaque ID");
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
    for (const reference of batch.readSet) this.#authorize(context, reference.object, "read");
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
          if (
            write.revision !== undefined &&
            this.#db
              .prepare("SELECT 1 FROM revisions WHERE namespace=? AND object_id=? AND revision=?")
              .get(write.object.namespaceId, write.object.objectId, write.revision)
          )
            fail("REVISION_CONFLICT", "Planned revision is already immutable");
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
          const revision = write.revision ?? randomUUID();
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
