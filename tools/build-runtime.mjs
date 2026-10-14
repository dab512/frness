import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { apiManifest } from "../plugins/api/src/manifest.ts";
import { backendManifest } from "../plugins/execution/definitions/backend.ts";
import { executionManifest } from "../plugins/execution/definitions/manifest.ts";
import { storageManifest } from "../plugins/store-sqlite/src/manifest.ts";
import { buildBootstrap } from "./build-bootstrap.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function buildServerModule(entry) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    write: false,
    banner: {
      js: "import { createRequire as __frnessCreateRequire } from 'node:module'; const require = __frnessCreateRequire(import.meta.url);",
    },
  });
  if (!result.outputFiles[0]) throw new Error("No server module was built");
  return result.outputFiles[0].contents;
}
export async function buildRuntime(directory, options = {}) {
  return buildBootstrap(directory, {
    packages: [
      async (meta) => ({
        manifest: apiManifest(meta),
        files: { "server.mjs": await buildServerModule("plugins/api/src/module.ts") },
        activations: ["activate"],
      }),
      (meta) => ({
        manifest: executionManifest(meta),
        files: {
          "server.mjs": `export const reload={async capture(){return {type:${JSON.stringify(meta("NullSnapshot"))},value:null}},async restore(){},async ready(){},async dispose(){}};`,
        },
      }),
      async (meta) => ({
        manifest: storageManifest(meta),
        files: {
          "server.mjs": await buildServerModule("plugins/store-sqlite/src/module.ts"),
          "schema.sql": await readFile(resolve(root, "plugins/store-sqlite/src/schema.sql")),
        },
        activations: ["activate"],
      }),
      async (meta, lookup) => ({
        manifest: backendManifest(meta, lookup),
        files: { "server.mjs": await buildServerModule("plugins/execution/src/module.ts") },
        activations: ["activate"],
      }),
      ...(options.packages ?? []),
    ],
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? ".frness/runtime");
  const lock = await buildRuntime(directory);
  process.stdout.write(`${JSON.stringify({ directory, packages: lock.packages.length })}\n`);
}
