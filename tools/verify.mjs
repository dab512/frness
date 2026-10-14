import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { failure, plan, readJson, root, writeJson } from "./project.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--atom")
  throw failure("INVALID_ARGUMENTS", "Use --atom FH-XX");
const atomId = args[1];
const definition = await plan();
const atom = definition.atoms.find((entry) => entry.id === atomId);
if (!atom) throw failure("UNKNOWN_ATOM", atomId);
const gate = (await readJson("specs/fractal-harness/atomic-gates.json")).gates.find(
  (entry) => entry.atomId === atomId,
);
if (!gate) throw failure("ATOM_GATE_MISSING", atomId);
const progress = await readJson("implementation-status.json");
for (const dependency of atom.dependsOn) {
  if (progress.atoms[dependency]?.status !== "done")
    throw failure("DEPENDENCY_NOT_DONE", dependency);
}
const testFile = `tests/atoms/${atomId}.test.ts`;
try {
  await access(resolve(root, testFile));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  throw failure("ATOM_TEST_MISSING", testFile);
}
const testSource = await readFile(resolve(root, testFile), "utf8");
if (!testSource.includes(gate.testId)) throw failure("ATOM_GATE_ID_MISSING", gate.testId);
const commands = [
  ["lint", ["run", "lint"]],
  ["types", ["run", "typecheck"]],
  ["specification", ["run", "spec:check"]],
  ["boundaries", ["run", "check:boundaries"]],
  ["atomic", ["run", "test:atom", "--", testFile]],
];
const checks = [];
const directory = resolve(root, "artifacts/verification", atomId);
await mkdir(directory, { recursive: true });
for (const [name, argv] of commands) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", argv, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  await writeFile(resolve(directory, `${name}.log`), log);
  checks.push({ name, command: ["npm", ...argv], exitCode: result.status ?? 1 });
  process.stdout.write(log);
  if (result.status !== 0) break;
}
const passed = checks.length === commands.length && checks.every((entry) => entry.exitCode === 0);
await writeJson(`verification/${atomId}.json`, {
  format: 1,
  atomId,
  gateId: gate.testId,
  checkedAt: new Date().toISOString(),
  node: process.version,
  passed,
  checks,
});
if (!passed) process.exitCode = 1;
