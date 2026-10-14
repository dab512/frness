import assert from "node:assert/strict";
import { join } from "node:path";
import { type DaemonProfile, startDaemon } from "../../apps/daemon/src/main.js";
import type { ComponentInstance, DefinitionRef, Json } from "../../packages/abi/src/index.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { llmManifest } from "../../plugins/llm/definitions/manifest.js";
import { buildRuntime, buildServerModule } from "../../tools/build-runtime.mjs";

export async function modelProfile(directory: string, endpoint: string) {
  const distribution = join(directory, "distribution");
  await buildRuntime(distribution, {
    packages: [
      async (meta) => ({
        manifest: llmManifest(meta),
        files: { "server.mjs": await buildServerModule("plugins/llm/src/module.ts") },
        activations: ["activate"],
      }),
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  const ref = (packageId: string, name: string): DefinitionRef => {
    const found = generation.description.definitions.find(
      (item) => item.ref.packageId === packageId && item.ref.name === name,
    )?.ref;
    assert.ok(found);
    return found;
  };
  const instance = (
    id: string,
    packageId: string,
    name: string,
    configuration: Json,
  ): ComponentInstance => ({
    instanceId: id,
    implementation: ref(packageId, name),
    configuration,
    stateNamespaceId: id,
    scopeId: "scope",
  });
  const profile: DaemonProfile = {
    bootstrapDirectory: distribution,
    dataDirectory: join(directory, "data"),
    principalId: "local",
    credentials: {
      api: { environment: "TEST_API", instances: ["api"] },
      model: { environment: "TEST_MODEL", instances: ["provider"] },
    },
    grants: {
      api: ["credential"],
      execution: ["profile.application", "local.subject"],
      storage: ["native.sqlite", "data.directory"],
      provider: ["credential", "network"],
    },
    services: {
      assemblyId: "services",
      revision: "v1",
      profile: "durable.v1",
      rootInstanceId: "api",
      instances: [
        instance("api", "std.api", "HttpServer", {
          port: 0,
          credentialBinding: "api",
          origins: [],
        }),
        instance("execution", "std.execution-backend", "Backend", {
          executionType: { ...ref("std.execution", "Request") },
        }),
        instance("storage", "std.store-sqlite", "Storage", {
          file: "model.sqlite",
          storeId: "local",
        }),
      ],
      bindings: [
        { parentInstanceId: "api", slot: "backend", childInstanceId: "execution" },
        { parentInstanceId: "execution", slot: "store", childInstanceId: "storage" },
      ],
    },
    application: {
      assemblyId: "single-call",
      revision: "v1",
      profile: "durable.v1",
      rootInstanceId: "generate",
      instances: [
        instance("generate", "std.llm", "SingleCall", {
          providerInstanceId: "provider",
          maxUnits: 0,
        }),
        instance("provider", "std.llm", "HttpProvider", {
          endpoint,
          model: "test-model",
          credentialBinding: "model",
          decoder: "frness.model.ndjson.v1",
        }),
      ],
      bindings: [{ parentInstanceId: "generate", slot: "provider", childInstanceId: "provider" }],
    },
  };
  await generation.close();
  return {
    ref,
    profile,
    start: (
      environment: NodeJS.ProcessEnv = {
        TEST_API: "test-api-token-for-local-fixture",
        TEST_MODEL: "test-model-token",
      },
    ) => startDaemon(profile, environment),
  };
}
