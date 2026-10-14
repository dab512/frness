import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = async (path: string) => JSON.parse(await readFile(resolve(root, path), "utf8"));

test("AT-000 all planned workspaces exist with unique identities", async () => {
  const layout = await json("workspace-layout.json");
  const names = new Set<string>();
  for (const workspace of layout.workspaces) {
    const manifest = await json(`${workspace.path}/package.json`);
    assert.equal(manifest.name, workspace.name);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.private, true);
    assert.equal(names.has(manifest.name), false);
    names.add(manifest.name);
  }
  assert.equal(names.size, 22);
});

test("AT-000 toolchain and strict compiler settings are fixed", async () => {
  const manifest = await json("package.json");
  const settings = await json("tsconfig.base.json");
  const toolchain = await json("toolchain.json");
  assert.equal(Number(process.versions.node.split(".")[0]), toolchain.nodeMajor);
  assert.equal(manifest.devDependencies.typescript, toolchain.typescript);
  assert.equal(manifest.devDependencies.tsx, toolchain.tsx);
  assert.equal(settings.compilerOptions.strict, true);
  assert.equal(settings.compilerOptions.noUncheckedIndexedAccess, true);
  assert.equal(settings.compilerOptions.exactOptionalPropertyTypes, true);
});

test("AT-000 verification fails closed on unknown atoms", () => {
  const result = spawnSync(process.execPath, ["tools/verify.mjs", "--atom", "FH-unknown"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNKNOWN_ATOM/);
});

test("AT-000 unimplemented stages cannot silently verify", async () => {
  const progress = await json("implementation-status.json");
  const pending = Object.entries(progress.atoms).find(
    ([, entry]) => (entry as { status: string }).status === "not_started",
  );
  if (!pending) return;
  const result = spawnSync(process.execPath, ["tools/verify.mjs", "--atom", pending[0]], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEPENDENCY_NOT_DONE|ATOM_TEST_MISSING/);
});

test("AT-000 acceptance without the product adapter is a failure, not a skip", () => {
  const environment = { ...process.env };
  delete environment.FRACTAL_SUT_MODULE;
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "specs/fractal-harness/tests/acceptance.test.mjs"],
    {
      cwd: root,
      env: environment,
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /IMPLEMENTATION_MISSING/);
});

test("AT-000 progress has one valid status entry per plan atom", async () => {
  const plan = await json("specs/fractal-harness/plan.json");
  const progress = await json("implementation-status.json");
  assert.deepEqual(
    Object.keys(progress.atoms).sort(),
    plan.atoms.map((atom: { id: string }) => atom.id).sort(),
  );
  for (const entry of Object.values(progress.atoms)) {
    const status = entry as { status: string; evidence: string[] };
    assert.ok(["not_started", "in_progress", "done", "blocked"].includes(status.status));
    if (status.status === "done") assert.ok(status.evidence.length > 0);
  }
});
