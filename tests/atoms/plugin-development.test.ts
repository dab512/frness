import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { workspaceLease } from "../../apps/cli/src/lease.js";
import { selfhost } from "../../apps/cli/src/selfhost.js";
import { codexTransport } from "../../plugins/agent-runtime/adapters/codex.js";

const exec = promisify(execFile);
const executable = resolve("tests/fixtures/agent-runner/codex");
async function cli(args: string[]) {
  return exec(process.execPath, ["--import", "tsx", "apps/cli/src/plugins.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, FRNESS_AGENT_EXECUTABLE: executable },
  });
}
function notes(workspace: string, file: string) {
  const db = new Database(join(workspace, ".frness/selfhost/data", file), { readonly: true });
  try {
    return (
      db.prepare("SELECT value FROM revisions WHERE object_id LIKE 'Note/%'").all() as {
        value: string;
      }[]
    ).map((item) => JSON.parse(item.value));
  } finally {
    db.close();
  }
}
test("agent SDK scaffold, recursive plugin tree, immutable reload, rollback and durable state", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-plugin-development-"));
  const id = `test-${Date.now()}`;
  const directory = resolve("extensions", id);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cli(["scaffold", id]);
  const original = await readFile(join(directory, "extension.ts"), "utf8");
  await assert.rejects(cli(["scaffold", id]));
  assert.equal(await readFile(join(directory, "extension.ts"), "utf8"), original);
  const source = join(directory, "tree.ts");
  await writeFile(
    source,
    `import base from './extension.js';
export default {...base, extend(input) {
 const p = base.extend(input);
 const parent = p.services.instances.find(x=>x.instanceId==='${id}');
 const store = p.services.instances.find(x=>x.instanceId==='${id}-store');
 return {...p, grants: {...p.grants, child:['local.subject'], 'child-store':['native.sqlite','data.directory']}, services: {...p.services,
 instances: [...p.services.instances, {...parent, instanceId:'child',stateNamespaceId:'child',configuration:{label:'child'}}, {...store,instanceId:'child-store',stateNamespaceId:'child-store',configuration:{file:'child.sqlite',storeId:'child'}}],
 bindings: [...p.services.bindings,{parentInstanceId:'${id}',slot:'children',key:'child',childInstanceId:'child'},{parentInstanceId:'child',slot:'store',childInstanceId:'child-store'}]}};
}};`,
  );
  await cli(["install", source, workspace]);
  const activePath = join(workspace, ".frness/plugins/active.json");
  const first = await readFile(activePath, "utf8");
  assert.equal(
    (await selfhost({ workspace, provider: "codex", prompt: "first" })).phase,
    "completed",
  );
  assert.equal(notes(workspace, `${id}.sqlite`).length, 1);
  assert.equal(notes(workspace, "child.sqlite")[0].label, "child");
  const modulePath = join(directory, "module.ts");
  const moduleSource = await readFile(modulePath, "utf8");
  await writeFile(
    modulePath,
    moduleSource.replace(
      "const label = (context.instance.configuration as { label: string }).label;",
      'const label = "v2";',
    ),
  );
  assert.notEqual(await readFile(modulePath, "utf8"), moduleSource);
  // Editing source cannot change the installed immutable generation.
  await selfhost({ workspace, provider: "codex", prompt: "still-v1" });
  assert.ok(notes(workspace, `${id}.sqlite`).every((item) => item.label === id));
  await assert.rejects(cli(["install", source, workspace]), /DEFINITION_CONFLICT/);
  assert.equal(await readFile(activePath, "utf8"), first);
  const manifestPath = join(directory, "manifest.ts");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace('version: "0.1.0"', 'version: "0.1.1"'),
  );
  await cli(["install", source, workspace]);
  assert.notEqual(await readFile(activePath, "utf8"), first);
  await selfhost({ workspace, provider: "codex", prompt: "v2" });
  assert.deepEqual(
    notes(workspace, `${id}.sqlite`)
      .map((item) => item.label)
      .sort(),
    [id, id, "v2"].sort(),
  );
  const second = await readFile(activePath, "utf8");
  await writeFile(modulePath, "invalid typescript !!!");
  await assert.rejects(cli(["install", source, workspace]));
  assert.equal(await readFile(activePath, "utf8"), second);
  assert.equal(
    (await selfhost({ workspace, provider: "codex", prompt: "after-rollback" })).phase,
    "completed",
  );
});
test("workspace writer lease prevents competing execution and reload", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-plugin-lock-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const release = await workspaceLease(workspace);
  await assert.rejects(
    selfhost({ workspace, provider: "codex", prompt: "must-not-spawn", executable }),
    /WORKSPACE_BUSY/,
  );
  await release();
  assert.equal(
    (await selfhost({ workspace, provider: "codex", prompt: "hello", executable })).phase,
    "completed",
  );
});

test("plugin requests queue under the writer lease and activate only after a successful turn", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "frness-plugin-request-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const source = resolve("extensions/turn-note/extension.ts");
  const release = await workspaceLease(workspace);
  try {
    await cli(["request", source, workspace]);
  } finally {
    await release();
  }
  const env = process.env.FRNESS_AGENT_EXECUTABLE;
  process.env.FRNESS_AGENT_EXECUTABLE = executable;
  try {
    const result = await selfhost({ workspace, provider: "codex", prompt: "hello", executable });
    assert.equal(result.phase, "completed");
    assert.equal(result.pluginUpdate?.ok, true);
    assert.equal(
      JSON.parse(await readFile(join(workspace, ".frness/plugins/last-update.json"), "utf8")).ok,
      true,
    );
    await selfhost({ workspace, provider: "codex", prompt: "use-installed-plugin" });
    assert.equal(notes(workspace, "turn-note.sqlite").length, 1);
    await cli(["request", join(workspace, "missing.ts"), workspace]);
    const failed = await selfhost({ workspace, provider: "codex", prompt: "bad-candidate" });
    assert.equal(failed.phase, "completed");
    assert.equal(failed.pluginUpdate?.ok, false);
    assert.equal(
      (await selfhost({ workspace, provider: "codex", prompt: "still-works" })).phase,
      "completed",
    );
  } finally {
    if (env === undefined) delete process.env.FRNESS_AGENT_EXECUTABLE;
    else process.env.FRNESS_AGENT_EXECUTABLE = env;
  }
});

test("explicit provider mode removes prompts without removing the workspace sandbox", () => {
  const input = { prompt: "hello", cwd: process.cwd(), nativeHandle: null };
  const normal = codexTransport().plan(input);
  assert.equal(normal.args.includes("--ask-for-approval"), false);
  const selected = codexTransport({ mode: "workspace" }).plan(input);
  assert.equal(selected.args[selected.args.indexOf("--ask-for-approval") + 1], "never");
  assert.equal(selected.args[selected.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(selected.args.includes("danger-full-access"), false);
  assert.equal(codexTransport().capabilities.permissions, false);
});
