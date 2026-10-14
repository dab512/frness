import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { namespaceGrant } from "../../plugins/store-sqlite/src/access.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type { ExecutionContext } from "../../specs/fractal-harness/contracts.js";

test("AT-018 explicit repository read grants never confer write or cross-scope access", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-grants-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SqliteObjectStore({
    path: join(directory, "store.sqlite"),
    storeId: "local",
    validate: () => {},
    project: (_, value) => value,
  });
  t.after(() => store.close());
  store.registerNamespace("memory", "remember", "scope-A");
  const owner: ExecutionContext = {
    principalId: "user",
    ownerInstanceId: "remember",
    scopeId: "scope-A",
    assemblyRevision: "v1",
    grants: [],
  };
  const object = {
    storeId: "local",
    namespaceId: "memory",
    objectId: "knowledge",
    type: {
      packageId: "fixture",
      packageVersion: "1.0.0",
      digest: "sha256:fixture",
      name: "Knowledge",
    },
  };
  await store.commit(owner, {
    commitKey: "create",
    readSet: [],
    events: [],
    writes: [{ kind: "create", object, value: "accepted fact" }],
  });
  const reader = { ...owner, ownerInstanceId: "recall" };
  await assert.rejects(store.read(reader, object), { code: "CAPABILITY_DENIED" });
  const granted = { ...reader, grants: [namespaceGrant("local", "memory", "read")] };
  const record = await store.read(granted, object);
  assert.equal(record.value, "accepted fact");
  const subscription = store.subscribe(granted, "memory");
  assert.equal(subscription.snapshot().records.length, 1);
  subscription.close();
  await assert.rejects(
    store.commit(granted, {
      commitKey: "overwrite",
      readSet: [],
      events: [],
      writes: [{ kind: "replace", object, expectedRevision: record.revision, value: "bad" }],
    }),
    { code: "CAPABILITY_DENIED" },
  );
  await assert.rejects(store.read({ ...granted, scopeId: "scope-B" }, object), {
    code: "CAPABILITY_DENIED",
  });
  assert.notEqual(
    namespaceGrant("local", "x/read", "read"),
    namespaceGrant("local/x", "read", "read"),
  );
});
