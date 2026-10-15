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
        ["TEMPLATE"]: ["local.subject"],
        "TEMPLATE-store": ["data.directory", "native.sqlite"],
      },
      services: {
        ...profile.services,
        instances: [
          ...profile.services.instances,
          {
            instanceId: "TEMPLATE",
            implementation: ref("local.TEMPLATE", "Observer"),
            configuration: { label: "TEMPLATE" },
            stateNamespaceId: "TEMPLATE",
            scopeId: "local",
          },
          {
            instanceId: "TEMPLATE-store",
            implementation: ref("std.store-sqlite", "Storage"),
            configuration: { file: "TEMPLATE.sqlite", storeId: "TEMPLATE" },
            stateNamespaceId: "TEMPLATE-store",
            scopeId: "local",
          },
        ],
        bindings: [
          ...profile.services.bindings,
          {
            parentInstanceId: "cli",
            slot: "events.observers",
            key: "TEMPLATE",
            childInstanceId: "TEMPLATE",
          },
          { parentInstanceId: "TEMPLATE", slot: "store", childInstanceId: "TEMPLATE-store" },
        ],
      },
    };
  },
} satisfies SelfhostExtension;
