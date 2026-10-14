import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DaemonProfile, startDaemon } from "../../apps/daemon/src/main.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import type { CliRuntime } from "../../plugins/agent-runtime/src/runtime.js";
import type { Assembly } from "../../specs/fractal-harness/contracts.js";
import { buildCli } from "../../tools/build-cli.mjs";

export async function cliProfile(
  directory: string,
  provider: "codex" | "claude" = "codex",
  options: { readonly addons?: boolean; readonly maxRuns?: number } = {},
) {
  const distribution = join(directory, "distribution");
  await buildCli(distribution, { addons: options.addons ?? false });
  const generation = await bootstrap({ directory: distribution });
  const ref = (packageId: string, name: string) => {
    const found = generation.description.definitions.find(
      (item) => item.ref.packageId === packageId && item.ref.name === name,
    )?.ref;
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  };
  const capabilities = [
    "credential",
    "data.directory",
    "native.sqlite",
    "local.subject",
    "process",
  ];
  let services: Assembly = {
    assemblyId: "cli",
    revision: "v1",
    profile: "durable.v1",
    rootInstanceId: "api",
    instances: [
      {
        instanceId: "api",
        implementation: ref("std.api", "HttpServer"),
        configuration: { port: 0, credentialBinding: "api-token", origins: [] },
        stateNamespaceId: "api",
        scopeId: "scope",
      },
      {
        instanceId: "cli",
        implementation: ref("std.agent-runtime", "Backend"),
        configuration: { workspace: directory },
        stateNamespaceId: "cli",
        scopeId: "scope",
      },
      {
        instanceId: "storage",
        implementation: ref("std.store-sqlite", "Storage"),
        configuration: { file: "cli.sqlite", storeId: "cli" },
        stateNamespaceId: "storage",
        scopeId: "scope",
      },
      {
        instanceId: "provider",
        implementation: ref(`std.agent-${provider}`, "Transport"),
        configuration: {
          executable: fileURLToPath(
            new URL(`../fixtures/agent-runner/${provider}`, import.meta.url),
          ),
        },
        stateNamespaceId: "provider",
        scopeId: "scope",
      },
    ],
    bindings: [
      { parentInstanceId: "api", slot: "backend", childInstanceId: "cli" },
      { parentInstanceId: "cli", slot: "store", childInstanceId: "storage" },
      { parentInstanceId: "cli", slot: "transport", childInstanceId: "provider" },
    ],
  };
  if (options.addons)
    services = {
      ...services,
      instances: [
        ...services.instances,
        {
          instanceId: "usage",
          implementation: ref("std.agent-usage", "Observer"),
          configuration: {
            mappings: [
              {
                eventType: { ...ref(`std.agent-${provider}`, "Event") },
                selectorPath: ["type"],
                selectorValue: provider === "codex" ? "turn.completed" : "result",
                amountPath: ["usage", "input_tokens"],
                unit: "input-token",
              },
            ],
          },
          stateNamespaceId: "usage",
          scopeId: "scope",
        },
        {
          instanceId: "gate",
          implementation: ref("std.agent-limits", "Gate"),
          configuration: { maxRuns: options.maxRuns ?? 1 },
          stateNamespaceId: "limits",
          scopeId: "scope",
        },
        ...["usage", "limits"].map((name) => ({
          instanceId: `${name}-storage`,
          implementation: ref("std.store-sqlite", "Storage"),
          configuration: { file: `${name}.sqlite`, storeId: name },
          stateNamespaceId: `${name}-storage`,
          scopeId: "scope",
        })),
      ],
      bindings: [
        ...services.bindings,
        {
          parentInstanceId: "cli",
          slot: "events.observers",
          key: "usage",
          childInstanceId: "usage",
        },
        { parentInstanceId: "cli", slot: "launch.policy", childInstanceId: "gate" },
        { parentInstanceId: "usage", slot: "store", childInstanceId: "usage-storage" },
        { parentInstanceId: "gate", slot: "store", childInstanceId: "limits-storage" },
      ],
    };
  const profile: DaemonProfile = {
    bootstrapDirectory: distribution,
    dataDirectory: join(directory, "data"),
    services,
    principalId: "local",
    grants: {
      api: capabilities,
      cli: capabilities.filter((item) => item !== "credential"),
      storage: ["data.directory", "native.sqlite"],
      provider: ["process"],
      ...(options.addons
        ? {
            usage: ["local.subject", "data.directory", "native.sqlite"],
            gate: ["local.subject", "data.directory", "native.sqlite"],
            "usage-storage": ["data.directory", "native.sqlite"],
            "limits-storage": ["data.directory", "native.sqlite"],
          }
        : {}),
    },
    credentials: { "api-token": { environment: "FRNESS_API_TOKEN", instances: ["api"] } },
  };
  const token = "cli-only-test-authorization";
  const daemon = await startDaemon(profile, { FRNESS_API_TOKEN: token });
  const runtime = (daemon.service("cli") as { runtime: CliRuntime }).runtime;
  await generation.close();
  return { daemon, runtime, profile, token, ref, url: (daemon.value as { url: string }).url };
}
