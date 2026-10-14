import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { redact } from "../../plugins/store-sqlite/src/access.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import { SubscriptionReplica } from "../../plugins/store-sqlite/src/subscriptions.js";
import type { ExecutionContext, ObjectRef } from "../../specs/fractal-harness/contracts.js";

test("AT-005 isolated subscriptions converge after gaps, duplicates and expiry without secret payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-observe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 0;
  const schema = {
    properties: {
      secret: { "x-sensitive": true },
      nested: { properties: { token: { "x-sensitive": true }, visible: {} } },
    },
  };
  const store = new SqliteObjectStore({
    path: join(directory, "db"),
    storeId: "local",
    validate: () => {},
    project: (_type, value) => redact(value, schema),
    cursorLifetimeMs: 100,
    now: () => now,
  });
  t.after(() => store.close());
  store.registerNamespace("a", "owner-a", "scope");
  store.registerNamespace("b", "owner-b", "scope");
  const context: ExecutionContext = {
    principalId: "me",
    scopeId: "scope",
    ownerInstanceId: "owner-a",
    assemblyRevision: "v1",
    grants: [],
  };
  const other = { ...context, ownerInstanceId: "owner-b" };
  const object: ObjectRef = {
    storeId: "local",
    namespaceId: "a",
    objectId: "doc",
    type: {
      packageId: "test",
      packageVersion: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`,
      name: "Doc",
    },
  };
  const denied = (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "CAPABILITY_DENIED";
  await assert.rejects(store.read(other, object), denied);
  assert.throws(() => store.subscribe(context, "b"), denied);
  const a = store.subscribe(context, "a");
  const b = store.subscribe(other, "b");
  const snapshot = a.snapshot();
  const replica = new SubscriptionReplica();
  replica.reset(snapshot);
  let revision = "";
  for (let count = 1; count <= 3; count++) {
    const receipt = await store.commit(context, {
      commitKey: `write-${count}`,
      readSet: [],
      writes: [
        revision
          ? {
              kind: "replace",
              object,
              expectedRevision: revision,
              value: { count, secret: "credential", nested: { token: "hidden", visible: "ok" } },
            }
          : {
              kind: "create",
              object,
              value: { count, secret: "credential", nested: { token: "hidden", visible: "ok" } },
            },
      ],
      events: [],
    });
    revision = receipt.records[0]!.revision;
  }
  const events = a.catchUp(snapshot.cursor);
  assert.equal(events.length, 3);
  assert.equal(JSON.stringify(events).includes("credential"), false);
  assert.equal(JSON.stringify(events).includes("hidden"), false);
  assert.equal(b.catchUp(b.snapshot().cursor).length, 0);
  assert.throws(() => b.catchUp(snapshot.cursor), denied);
  assert.equal(replica.apply(events[1]!), "gap");
  assert.equal(replica.cursor, snapshot.cursor);
  for (const event of a.catchUp(replica.cursor)) assert.equal(replica.apply(event), "applied");
  assert.equal(replica.apply(events[2]!), "duplicate");
  assert.throws(
    () => replica.apply({ ...events[2]!, value: null }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "EVENT_CONFLICT",
  );
  assert.equal(replica.records.length, 1);
  assert.deepEqual(replica.records[0]!.value, { count: 3, nested: { visible: "ok" } });
  now = 101;
  assert.throws(
    () => a.catchUp(replica.cursor),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "CURSOR_EXPIRED",
  );
  replica.reset(a.snapshot());
  assert.equal(replica.records[0]!.revision, revision);
  assert.equal(replica.apply(events[0]!), "gap");
  a.close();
  assert.throws(
    () => a.snapshot(),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "SUBSCRIPTION_CLOSED",
  );
});
