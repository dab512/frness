import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";

const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!["--workspace", "--extension"].includes(key) || !value || flags.has(key))
    throw new Error("Usage: npm run desktop -- [--workspace path] [--extension path]");
  flags.set(key, resolve(value));
}
const environment = {
  ...process.env,
  FRNESS_NODE: process.execPath,
  ...(flags.has("--workspace") ? { FRNESS_WORKSPACE: flags.get("--workspace") } : {}),
  ...(flags.has("--extension") ? { FRNESS_EXTENSION: flags.get("--extension") } : {}),
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [resolve("apps/web/desktop/main.mjs")], {
  stdio: "inherit",
  env: environment,
});
child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
