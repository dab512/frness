import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type {
  CommitBatch,
  ExecutionContext,
  ObjectRef,
} from "../../specs/fractal-harness/contracts.js";

test("AT-004 planned revisions allow atomic references and cannot rewrite history", async (t) => {
  const store = new SqliteObjectStore({ path: ":memory:", storeId: "local", validate: () => {} });
  t.after(() => store.close());
  store.registerNamespace("ns", "owner", "scope");
  const context: ExecutionContext = {
    principalId: "me",
    scopeId: "scope",
    ownerInstanceId: "owner",
    assemblyRevision: "v1",
    grants: [],
  };
  const source: ObjectRef = {
    storeId: "local",
    namespaceId: "ns",
    objectId: "source",
    type: {
      packageId: "test",
      packageVersion: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`,
      name: "Record",
    },
  };
  const pointer = { ...source, objectId: "pointer" };
  const batch: CommitBatch = {
    commitKey: "atomic-reference",
    readSet: [],
    events: [],
    writes: [
      { kind: "create", object: source, revision: "planned-revision", value: { count: 1 } },
      {
        kind: "create",
        object: pointer,
        value: {
          source: { object: { ...source, type: { ...source.type } }, revision: "planned-revision" },
        },
      },
    ],
  };
  const receipt = await store.commit(context, batch);
  assert.equal((await store.read(context, source)).revision, "planned-revision");
  assert.deepEqual(await store.commit(context, batch), receipt);
  const pointerBefore = await store.read(context, pointer);
  await assert.rejects(
    store.commit(context, {
      commitKey: "rewrite",
      readSet: [],
      events: [],
      writes: [
        { kind: "replace", object: pointer, expectedRevision: pointerBefore.revision, value: null },
        {
          kind: "replace",
          object: source,
          expectedRevision: "planned-revision",
          revision: "planned-revision",
          value: { count: 9 },
        },
      ],
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "REVISION_CONFLICT",
  );
  assert.deepEqual(await store.read(context, pointer), pointerBefore);
  assert.deepEqual((await store.read(context, source, "planned-revision")).value, { count: 1 });
});
