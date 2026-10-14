import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { failure, plan, readJson, root, writeJson } from "./project.mjs";

const [command, atomId] = process.argv.slice(2);
const definition = await plan();
const atom = definition.atoms.find((entry) => entry.id === atomId);
if (command !== "init" && !atom) throw failure("UNKNOWN_ATOM", atomId ?? "missing ID");
const timestamp = new Date().toISOString();
if (command === "init") {
  try {
    await readJson("implementation-status.json");
    throw failure("STATUS_ALREADY_EXISTS", "Refusing to overwrite existing progress");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeJson("implementation-status.json", {
    format: 1,
    updatedAt: timestamp,
    atoms: Object.fromEntries(
      definition.atoms.map((entry) => [
        entry.id,
        {
          status: "not_started",
          startedAt: null,
          completedAt: null,
          evidence: [],
          blocker: null,
        },
      ]),
    ),
  });
} else {
  const progress = await readJson("implementation-status.json");
  for (const dependency of atom.dependsOn) {
    if (progress.atoms[dependency]?.status !== "done") {
      throw failure("DEPENDENCY_NOT_DONE", dependency);
    }
  }
  const current = progress.atoms[atomId];
  if (command === "begin") {
    if (current.status === "done") throw failure("ATOM_ALREADY_DONE", atomId);
    current.status = "in_progress";
    current.startedAt ??= timestamp;
  } else if (command === "done") {
    const evidencePath = `verification/${atomId}.json`;
    const evidence = JSON.parse(await readFile(resolve(root, evidencePath), "utf8"));
    if (evidence.atomId !== atomId || evidence.passed !== true || evidence.checks.length !== 5) {
      throw failure("EVIDENCE_INVALID", evidencePath);
    }
    if (evidence.checks.some((entry) => entry.exitCode !== 0)) {
      throw failure("EVIDENCE_FAILED", evidencePath);
    }
    current.status = "done";
    current.completedAt = timestamp;
    current.evidence = [evidencePath];
    current.blocker = null;
  } else throw failure("UNKNOWN_PROGRESS_COMMAND", command ?? "missing command");
  progress.updatedAt = timestamp;
  await writeJson("implementation-status.json", progress);
}
console.log(
  command === "init" ? "Progress initialized without completed atoms." : `${atomId}: ${command}`,
);
