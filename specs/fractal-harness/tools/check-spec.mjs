import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, AstBuilder, GherkinClassicTokenMatcher } from "@cucumber/gherkin";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documents = ["README.md", "ARCHITECTURE.md", "BOOTSTRAP.md", "CONTRACTS.md", "STANDARD-PLUGINS.md", "RUNTIME.md", "UI-AND-DATA.md", "REVIEW.md", "PLAN.md", "HANDOFF.md", "TESTING.md", "tests/FIXTURES.md"];
const texts = new Map();
for (const name of documents) {
  const text = await readFile(resolve(root, name), "utf8");
  texts.set(name, text);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^[a-z]+:\/\//i.test(target) || target.startsWith("/")) continue;
    await access(resolve(root, dirname(name), target));
  }
}
const known = new Set();
for (const text of [texts.get("TESTING.md"), texts.get("BOOTSTRAP.md")]) {
  for (const match of text.matchAll(/^\|\s*`?((?:META|STORE|AG|OPS|BOOT)-\d{3})`?\s*\|/gm)) known.add(match[1]);
}
let scenarioCount = 0;
let expandedCount = 0;
for (const name of ["tests/runtime.feature", "tests/ui.feature"]) {
  let id = 0;
  const text = await readFile(resolve(root, name), "utf8");
  const parser = new Parser(new AstBuilder(() => `${name}:${id++}`), new GherkinClassicTokenMatcher());
  const document = parser.parse(text);
  assert.ok(document.feature, `${name}: missing Feature`);
  for (const child of document.feature.children) {
    if (!child.scenario) continue;
    const scenario = child.scenario;
    const tags = scenario.tags.map((tag) => tag.name.slice(1));
    assert.ok(tags.some((tag) => /^(RT|UI)-\d{3}$/.test(tag)), `${name}: missing scenario ID`);
    for (const tag of tags) if (/^(RT|UI)-\d{3}$/.test(tag)) known.add(tag);
    assert.ok(scenario.steps.some((step) => step.keyword.trim() === "Then"), `${name}: no oracle`);
    scenarioCount++;
    if (scenario.examples.length) {
      for (const example of scenario.examples) expandedCount += example.tableBody.length;
    } else expandedCount++;
  }
}
const plan = JSON.parse(await readFile(resolve(root, "plan.json"), "utf8"));
assert.equal(plan.format, 1);
assert.equal(plan.atoms.length, 30);
const atoms = new Map(plan.atoms.map((atom) => [atom.id, atom]));
assert.equal(atoms.size, plan.atoms.length, "duplicate atom ID");
const gateFile = JSON.parse(await readFile(resolve(root, "atomic-gates.json"), "utf8"));
assert.equal(gateFile.gates.length, atoms.size);
const gateAtoms = new Set();
const gateIds = new Set();
for (const gate of gateFile.gates) {
  assert.ok(atoms.has(gate.atomId), `gate for unknown atom ${gate.atomId}`);
  assert.ok(!gateAtoms.has(gate.atomId) && !gateIds.has(gate.testId), "duplicate atomic gate");
  assert.ok(gate.given && gate.when && gate.then, `incomplete atomic gate ${gate.atomId}`);
  gateAtoms.add(gate.atomId);
  gateIds.add(gate.testId);
}
const visited = new Set();
const visiting = new Set();
function visit(id) {
  assert.ok(atoms.has(id), `unknown dependency ${id}`);
  assert.ok(!visiting.has(id), `dependency cycle at ${id}`);
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of atoms.get(id).dependsOn) visit(dependency);
  visiting.delete(id);
  visited.add(id);
}
function expand(spec) {
  const match = spec.match(/^([A-Z]+)-(\d{3})\.\.\1-(\d{3})$/);
  if (!match) return [spec];
  const result = [];
  for (let n = Number(match[2]); n <= Number(match[3]); n++) result.push(`${match[1]}-${String(n).padStart(3, "0")}`);
  assert.ok(result.length > 0, `empty range ${spec}`);
  return result;
}
const covered = new Set();
for (const atom of plan.atoms) {
  visit(atom.id);
  assert.ok(atom.files.length && atom.steps.length && atom.tests.length && atom.done, `incomplete atom ${atom.id}`);
  for (const spec of atom.tests) for (const id of expand(spec)) {
    assert.ok(known.has(id), `${atom.id}: unknown test ${id}`);
    covered.add(id);
  }
}
for (const id of known) assert.ok(covered.has(id), `test not assigned to any atom: ${id}`);
const acceptance = await readFile(resolve(root, "tests/acceptance.test.mjs"), "utf8");
const executableTests = [...acceptance.matchAll(/^test\("([^"]+)"/gm)];
assert.equal(executableTests.length, 14);
for (const match of executableTests) for (const id of match[1].match(/[A-Z]+-\d{3}/g) ?? []) assert.ok(known.has(id), `unknown executable test ID ${id}`);
assert.ok(acceptance.includes("IMPLEMENTATION_MISSING"));
assert.ok(!/\b(?:test\.skip|test\.todo|test\.only)\b/.test(acceptance), "disabled or focused acceptance test");
console.log(JSON.stringify({ status: "specification-valid", documents: documents.length, atoms: atoms.size, atomicGates: gateIds.size, testGroups: known.size, gherkinScenarios: scenarioCount, expandedGherkinCases: expandedCount, executableContractTests: executableTests.length, productAcceptance: "not-run-no-implementation" }, null, 2));
