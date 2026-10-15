import { fileURLToPath } from "node:url";
import type { SelfhostExtension } from "../../apps/cli/src/selfhost.js";
import { buildServerModule } from "../../tools/build-runtime.mjs";
import { manifest } from "./manifest.js";
export default {
  packages: [
    async (meta, lookup) => ({
      manifest: manifest(meta, lookup),
      files: {
        "server.mjs": await buildServerModule(
          fileURLToPath(new URL("./module.ts", import.meta.url)),
        ),
      },
      activations: ["activate"],
    }),
  ],
  extend({ profile, ref }) {
    return {
      ...profile,
      grants: {
        ...profile.grants,
        "turn-note": ["local.subject"],
        "turn-note-store": ["data.directory", "native.sqlite"],
      },
      services: {
        ...profile.services,
        instances: [
          ...profile.services.instances,
          {
            instanceId: "turn-note",
            implementation: ref("local.turn-note", "Observer"),
            configuration: { label: "turn-note" },
            stateNamespaceId: "turn-note",
            scopeId: "local",
          },
          {
            instanceId: "turn-note-store",
            implementation: ref("std.store-sqlite", "Storage"),
            configuration: { file: "turn-note.sqlite", storeId: "turn-note" },
            stateNamespaceId: "turn-note-store",
            scopeId: "local",
          },
        ],
        bindings: [
          ...profile.services.bindings,
          {
            parentInstanceId: "cli",
            slot: "events.observers",
            key: "turn-note",
            childInstanceId: "turn-note",
          },
          { parentInstanceId: "turn-note", slot: "store", childInstanceId: "turn-note-store" },
        ],
      },
    };
  },
} satisfies SelfhostExtension;
