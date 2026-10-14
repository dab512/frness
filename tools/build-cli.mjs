import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { limitsManifest } from "../plugins/agent-limits/src/manifest.ts";
import { providerManifest } from "../plugins/agent-runtime/adapters/manifest.ts";
import { agentRuntimeManifest } from "../plugins/agent-runtime/definitions/manifest.ts";
import { usageManifest } from "../plugins/agent-usage/src/manifest.ts";
import { apiManifest } from "../plugins/api/src/manifest.ts";
import { storageManifest } from "../plugins/store-sqlite/src/manifest.ts";
import { buildBootstrap } from "./build-bootstrap.mjs";
import { buildServerModule } from "./build-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function buildCli(directory, options = {}) {
  return buildBootstrap(directory, {
    packages: [
      async (meta) => ({
        manifest: apiManifest(meta),
        files: { "server.mjs": await buildServerModule("plugins/api/src/module.ts") },
        activations: ["activate"],
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
        manifest: agentRuntimeManifest(meta, lookup),
        files: { "server.mjs": await buildServerModule("plugins/agent-runtime/src/module.ts") },
        activations: ["activate"],
      }),
      ...["codex", "claude"].map((provider) => async (meta, lookup) => ({
        manifest: providerManifest(provider, meta, lookup),
        files: {
          "server.mjs": await buildServerModule(
            `plugins/agent-runtime/adapters/${provider}-module.ts`,
          ),
        },
        activations: ["activate"],
      })),
      ...(options.addons
        ? [
            async (meta, lookup) => ({
              manifest: usageManifest(meta, lookup),
              files: { "server.mjs": await buildServerModule("plugins/agent-usage/src/module.ts") },
              activations: ["activate"],
            }),
            async (meta, lookup) => ({
              manifest: limitsManifest(meta, lookup),
              files: {
                "server.mjs": await buildServerModule("plugins/agent-limits/src/module.ts"),
              },
              activations: ["activate"],
            }),
          ]
        : []),
      ...(options.packages ?? []),
    ],
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? ".frness/cli");
  const lock = await buildCli(directory);
  process.stdout.write(`${JSON.stringify({ directory, packages: lock.packages.length })}\n`);
}
