import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type {
  CommitBatch,
  ExecutionContext,
  ObjectRef,
  TypeRef,
} from "../../specs/fractal-harness/contracts.js";

test("AT-004 SQLite CAS, batch rollback, idempotency and revision history survive restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schema = {
    type: "object",
    properties: { count: { type: "integer", minimum: 0 } },
    required: ["count"],
    additionalProperties: false,
  };
  const type: TypeRef = {
    packageId: "test.store",
    packageVersion: "1.0.0",
    name: "Document",
    digest: `sha256:${createHash("sha256").update(JSON.stringify(schema)).digest("hex")}`,
  };
  const validator = new Ajv2020({
    strict: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  }).compile(schema);
  const validate = (_type: TypeRef, value: unknown) => {
    if (!validator(value))
      throw Object.assign(new Error("Invalid document"), { code: "INVALID_INPUT" });
  };
  const path = join(directory, "store.sqlite");
  let store = new SqliteObjectStore({ path, storeId: "local", validate });
  t.after(() => store.close());
  store.registerNamespace("ns", "owner", "scope");
  const context: ExecutionContext = {
    principalId: "test",
    scopeId: "scope",
    ownerInstanceId: "owner",
    assemblyRevision: "assembly1",
    grants: [],
  };
  const object: ObjectRef = { storeId: "local", namespaceId: "ns", objectId: "a", type };
  const created = await store.commit(context, {
    commitKey: "create-a",
    readSet: [],
    writes: [{ kind: "create", object, value: { count: 0 } }],
    events: [],
  });
  const revision = created.records[0]!.revision;
  const update = (key: string, count: number): CommitBatch => ({
    commitKey: key,
    readSet: [],
    writes: [{ kind: "replace", object, expectedRevision: revision, value: { count } }],
    events: [],
  });
  const results = await Promise.allSettled([
    store.commit(context, update("one", 1)),
    store.commit(context, update("two", 2)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(rejected.reason.code, "REVISION_CONFLICT");
  const current = await store.read(context, object);
  assert.deepEqual((await store.read(context, object, revision)).value, { count: 0 });
  const other = { ...object, objectId: "b" };
  await assert.rejects(
    store.commit(context, {
      commitKey: "bad-batch",
      readSet: [],
      writes: [
        { kind: "create", object: other, value: { count: 7 } },
        { kind: "replace", object, expectedRevision: "stale", value: { count: 8 } },
      ],
      events: [],
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "REVISION_CONFLICT",
  );
  await assert.rejects(
    store.read(context, other),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "NOT_FOUND",
  );
  assert.equal((await store.read(context, object)).revision, current.revision);
  const repeat = {
    commitKey: "stable",
    readSet: [],
    writes: [
      {
        kind: "replace" as const,
        object,
        expectedRevision: current.revision,
        value: { count: 10 },
      },
    ],
    events: [],
  };
  const receipt = await store.commit(context, repeat);
  assert.deepEqual(await store.commit(context, repeat), receipt);
  await assert.rejects(
    store.commit(context, { ...repeat, writes: [{ ...repeat.writes[0]!, value: { count: 11 } }] }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "IDEMPOTENCY_CONFLICT",
  );
  store.close();
  store = new SqliteObjectStore({ path, storeId: "local", validate });
  assert.deepEqual((await store.read(context, object)).value, { count: 10 });
  assert.deepEqual(await store.commit(context, repeat), receipt);
  await assert.rejects(
    store.commit(context, {
      commitKey: "invalid-event",
      readSet: [],
      writes: [],
      events: [{ eventId: "invalid", type, value: { count: "0" } }],
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_INPUT",
  );
  const event = { eventId: "event-1", type, value: { count: 1 } };
  await store.commit(context, { commitKey: "event-a", readSet: [], writes: [], events: [event] });
  await store.commit(context, { commitKey: "event-b", readSet: [], writes: [], events: [event] });
  await assert.rejects(
    store.commit(context, {
      commitKey: "event-c",
      readSet: [],
      writes: [{ kind: "create", object: other, value: { count: 5 } }],
      events: [{ ...event, value: { count: 2 } }],
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EVENT_CONFLICT",
  );
  await assert.rejects(
    store.read(context, other),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "NOT_FOUND",
  );
});
