import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileTools } from "../../plugins/tools/src/files.js";
import { ToolRouter } from "../../plugins/tools/src/router.js";
import type { InvocationReceipt, Json } from "../../specs/fractal-harness/contracts.js";
import type { ToolCall, ToolObservation } from "../../specs/fractal-harness/standard-contracts.js";
import { toolsProfile } from "../support/tools-profile.js";

test("AT-016 metadata-composed tools and a pure nested subagent run through the same Invoke contract", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-tool-daemon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "root");
  const files = await FileTools.open(root, "read-write");
  await writeFile(join(root, "a.txt"), "before");
  await writeFile(join(directory, "outside"), "private");
  await symlink(directory, join(root, "escape"));
  const rig = await toolsProfile(directory, root);
  const daemon = await rig.start();
  t.after(() => daemon.close());
  const backend = daemon.service("execution") as {
    invoke(input: unknown): Promise<InvocationReceipt>;
    idle(): Promise<void>;
    read(ref: unknown): Promise<{ value: { phase: string; result: ToolObservation } }>;
  };
  const run = async (call: ToolCall) => {
    const receipt = await backend.invoke({
      targetInstanceId: "router",
      assemblyRevision: "v1",
      operation: { contract: rig.ref("std.tools", "Invoke"), operation: "invoke" },
      input: call,
      idempotencyKey: call.id,
    });
    await backend.idle();
    const record = await backend.read(receipt.invocation);
    assert.equal(record.value.phase, "succeeded");
    return record.value.result;
  };
  const before = await run({ id: "read", name: "read", arguments: { path: "a.txt" } });
  assert.equal(before.ok, true);
  const digest = (before.value as { contentDigest: string }).contentDigest;
  const written = await run({
    id: "write",
    name: "write",
    arguments: { path: "a.txt", expectedContentDigest: digest, newContent: "after" },
  });
  assert.equal(written.ok, true);
  assert.equal((written.value as { content: string }).content, "after");
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after");
  const nested = await run({ id: "nested", name: "nested", arguments: "42" });
  assert.deepEqual(nested, {
    callId: "nested",
    ok: true,
    value: "nested:42",
    errorCode: null,
    sources: [],
  });
  for (const [id, name, args, code] of [
    ["unknown", "absent", {}, "INVALID_INPUT"],
    ["bad", "write", { path: "a.txt" }, "INVALID_INPUT"],
    ["escape", "read", { path: "escape/outside" }, "CAPABILITY_DENIED"],
    ["parent", "read", { path: "../outside" }, "CAPABILITY_DENIED"],
  ] as const) {
    const observation = await run({ id, name, arguments: args as Json });
    assert.equal(observation.ok, false);
    assert.equal(observation.errorCode, code);
  }
  assert.equal((await files.read({ path: "a.txt" })).content, "after");
  assert.equal(await readFile(join(directory, "outside"), "utf8"), "private");
});

test("AT-016 tool routing validates before dispatch and file writes require read-back", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "root");
  const files = await FileTools.open(root, "read-write");
  await writeFile(join(root, "a.txt"), "before");
  await writeFile(join(directory, "outside"), "private");
  await symlink(directory, join(root, "escape"));
  await symlink(join(directory, "outside"), join(root, "link"));
  const before = await files.read({ path: "a.txt" });
  const written = await files.write({
    path: "a.txt",
    expectedContentDigest: before.contentDigest,
    newContent: "after",
  });
  assert.equal(written.content, "after");
  assert.deepEqual(await files.read({ path: "a.txt" }), written);
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after");
  await assert.rejects(
    files.write({
      path: "a.txt",
      expectedContentDigest: before.contentDigest,
      newContent: "stale",
    }),
    { code: "REVISION_CONFLICT" },
  );
  for (const path of [
    "../outside",
    join(directory, "outside"),
    "escape/outside",
    "link",
    "a.txt/../../outside",
  ]) {
    await assert.rejects(files.read({ path }), { code: "CAPABILITY_DENIED" });
    await assert.rejects(files.write({ path, expectedContentDigest: null, newContent: "bad" }), {
      code: "CAPABILITY_DENIED",
    });
  }
  assert.equal(await readFile(join(directory, "outside"), "utf8"), "private");
  let dispatched = 0;
  const type = {
    packageId: "test.tools",
    packageVersion: "1.0.0",
    digest: "sha256:fixture",
    name: "Text",
  };
  const router = new ToolRouter({
    validate: (_, value) => {
      if (typeof value !== "string") throw new Error("Invalid string");
    },
    bindings: [
      {
        spec: { name: "echo", description: "Nested child", inputType: type, outputType: type },
        invoke: async (call) => {
          dispatched++;
          return { callId: call.id, ok: true, value: call.arguments, errorCode: null, sources: [] };
        },
      },
    ],
  });
  for (const call of [
    { id: "a", name: "missing", arguments: "x" },
    { id: "b", name: "echo", arguments: 42 },
  ]) {
    assert.deepEqual(await router.invoke(call), {
      callId: call.id,
      ok: false,
      value: null,
      errorCode: "INVALID_INPUT",
      sources: [],
    });
  }
  assert.equal(dispatched, 0);
  assert.deepEqual(await router.invoke({ id: "c", name: "echo", arguments: "42" }), {
    callId: "c",
    ok: true,
    value: "42",
    errorCode: null,
    sources: [],
  });
  assert.equal(dispatched, 1);
  const duplicate = { id: "d", name: "echo", arguments: "same" };
  const concurrent = await Promise.all([router.invoke(duplicate), router.invoke(duplicate)]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(dispatched, 2);
  assert.equal(
    (await router.invoke({ ...duplicate, arguments: "changed" })).errorCode,
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(dispatched, 2);
  const created = await files.write({
    path: "created.txt",
    expectedContentDigest: null,
    newContent: "Привет 🌲",
  });
  assert.deepEqual(await files.read({ path: "created.txt" }), created);
  await assert.rejects(
    files.write({ path: "created.txt", expectedContentDigest: null, newContent: "replace" }),
    { code: "REVISION_CONFLICT" },
  );
  const readonly = await FileTools.open(root, "read");
  await assert.rejects(
    readonly.write({
      path: "a.txt",
      expectedContentDigest: written.contentDigest,
      newContent: "bad",
    }),
    { code: "CAPABILITY_DENIED" },
  );
  let getterRead = false;
  const hostile = Object.defineProperty({ id: "hostile", name: "echo" }, "arguments", {
    enumerable: true,
    get() {
      getterRead = true;
      return "bad";
    },
  });
  assert.throws(() => router.invoke(hostile as ToolCall));
  assert.equal(getterRead, false);
});

test("AT-016 router validates outputs and dispatches groups in declared order", async () => {
  const type = {
    packageId: "test.tools",
    packageVersion: "1.0.0",
    digest: "sha256:fixture",
    name: "Text",
  };
  const order: string[] = [];
  const spec = { name: "echo", description: "echo", inputType: type, outputType: type };
  const router = new ToolRouter({
    validate: (_, value) => {
      if (typeof value !== "string") throw new Error("Invalid string");
    },
    bindings: [
      {
        spec,
        invoke: async (call) => {
          order.push(`start:${call.id}`);
          await Promise.resolve();
          order.push(`end:${call.id}`);
          return {
            callId: call.id,
            ok: true,
            value: call.id === "bad" ? 42 : call.arguments,
            errorCode: null,
            sources: [],
          };
        },
      },
    ],
  });
  const observations = await router.invokeAll([
    { id: "first", name: "echo", arguments: "x" },
    { id: "bad", name: "echo", arguments: "y" },
  ]);
  assert.deepEqual(order, ["start:first", "end:first", "start:bad", "end:bad"]);
  assert.equal(observations[0]!.ok, true);
  assert.equal(observations[1]!.errorCode, "INVALID_OUTPUT");
  assert.throws(
    () =>
      new ToolRouter({
        validate: () => {},
        bindings: [
          { spec, invoke: async () => observations[0]! },
          { spec, invoke: async () => observations[0]! },
        ],
      }),
    { code: "INVALID_INPUT" },
  );
});
