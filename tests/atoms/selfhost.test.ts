import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { selfhost, selfhostCli } from "../../apps/cli/src/selfhost.js";
import { usageManifest } from "../../plugins/agent-usage/src/manifest.js";
import { buildServerModule } from "../../tools/build-runtime.mjs";

const executable = fileURLToPath(new URL("../fixtures/agent-runner/codex", import.meta.url));
test("minimal selfhost persists and continues a native session, without optional packages", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-selfhost-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let output = "";
  const first = await selfhost({
    workspace,
    provider: "codex",
    prompt: "hello",
    executable,
    output: (text) => {
      output += text;
    },
  });
  assert.equal(first.phase, "completed");
  assert.equal(output, first.text);
  assert.ok(first.text.length);
  assert.deepEqual(
    JSON.parse(await readFile(join(workspace, ".frness/selfhost/last-run.json"), "utf8")).session,
    first.session,
  );
  const next = await selfhost({
    workspace,
    provider: "codex",
    prompt: "next",
    executable,
    session: first.session,
  });
  assert.equal(next.phase, "completed");
  assert.deepEqual(next.session, first.session);
  const builds = join(workspace, ".frness/selfhost/builds");
  for (const build of await readdir(builds)) {
    const lock = JSON.parse(await readFile(join(builds, build, "boot-lock.json"), "utf8"));
    const packages = lock.packages.map((item: { artifactPath: string }) => item.artifactPath);
    assert.ok(packages.includes("std.agent-codex"));
    for (const excluded of [
      "std.agent-claude",
      "std.agent-limits",
      "std.agent-usage",
      "std.execution",
      "std.llm",
    ])
      assert.ok(!packages.includes(excluded));
  }
});
test("minimal selfhost reports missing binary and validates arguments before execution", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-selfhost-failure-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await selfhost({
    workspace,
    provider: "codex",
    prompt: "hello",
    executable: "/does-not-exist/frness",
  });
  assert.notEqual(result.phase, "completed");
  await assert.rejects(
    selfhostCli(["--provider", "wrong", "--prompt-file", "irrelevant"]),
    /Invalid provider/,
  );
  await assert.rejects(selfhostCli(["--unknown", "value"]), /Invalid selfhost arguments/);
});

test("minimal selfhost interrupts only its own active turn", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-selfhost-cancel-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1500);
  t.after(() => clearTimeout(timer));
  const result = await selfhost({
    workspace,
    provider: "codex",
    prompt: "hold",
    executable,
    signal: abort.signal,
  });
  assert.equal(result.phase, "cancelled");
});

test("selfhost extension adds metadata, logic and its own storage without host edits", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-selfhost-extension-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await selfhost({
    workspace,
    provider: "codex",
    executable,
    prompt: "extension",
    extension: {
      packages: [
        async (meta, lookup) => ({
          manifest: usageManifest(meta, lookup),
          files: { "server.mjs": await buildServerModule("plugins/agent-usage/src/module.ts") },
          activations: ["activate"],
        }),
      ],
      extend({ profile, ref }) {
        return {
          ...profile,
          grants: {
            ...profile.grants,
            observer: ["local.subject"],
            "observer-store": ["native.sqlite", "data.directory"],
          },
          services: {
            ...profile.services,
            instances: [
              ...profile.services.instances,
              {
                instanceId: "observer",
                implementation: ref("std.agent-usage", "Observer"),
                configuration: {
                  mappings: [
                    {
                      eventType: { ...ref("std.agent-codex", "Event") },
                      selectorPath: ["type"],
                      selectorValue: "turn.completed",
                      amountPath: ["usage", "input_tokens"],
                      unit: "input-token",
                    },
                  ],
                },
                stateNamespaceId: "observer",
                scopeId: "local",
              },
              {
                instanceId: "observer-store",
                implementation: ref("std.store-sqlite", "Storage"),
                configuration: { file: "observer.sqlite", storeId: "observer" },
                stateNamespaceId: "observer-store",
                scopeId: "local",
              },
            ],
            bindings: [
              ...profile.services.bindings,
              {
                parentInstanceId: "cli",
                slot: "events.observers",
                key: "example",
                childInstanceId: "observer",
              },
              { parentInstanceId: "observer", slot: "store", childInstanceId: "observer-store" },
            ],
          },
        };
      },
    },
  });
  assert.equal(result.phase, "completed");
  const db = new Database(join(workspace, ".frness/selfhost/data/observer.sqlite"), {
    readonly: true,
  });
  try {
    const samples = db
      .prepare("SELECT value FROM revisions WHERE namespace = ? AND object_id LIKE ?")
      .all("observer", "Sample/%") as { value: string }[];
    assert.equal(samples.length, 1);
    assert.equal(JSON.parse(samples[0]!.value).amount, 10);
  } finally {
    db.close();
  }
});
