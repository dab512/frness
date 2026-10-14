import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import type { InvocationRequest } from "../../specs/fractal-harness/contracts.js";
import { buildRuntime } from "../../tools/build-runtime.mjs";
import { startRemote } from "../fixtures/remote.js";
import { writerManifest } from "../fixtures/writer/manifest.js";

export async function daemonCheck(t: TestContext): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "frness-daemon-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = await startRemote(join(directory, "remote.sqlite"));
  t.after(() => remote.close());
  const distribution = join(directory, "distribution");
  await buildRuntime(distribution, {
    packages: [
      async (meta) => ({
        manifest: writerManifest(meta),
        files: {
          "server.mjs": await readFile(
            new URL("../fixtures/writer/server.mjs", import.meta.url),
            "utf8",
          ),
        },
      }),
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  const ref = (packageId: string, name: string) => {
    const found = generation.description.definitions.find(
      (item) => item.ref.packageId === packageId && item.ref.name === name,
    )?.ref;
    assert.ok(found);
    return found;
  };
  const services = {
    assemblyId: "services",
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
        instanceId: "execution",
        implementation: ref("std.execution-backend", "Backend"),
        configuration: { executionType: ref("std.execution", "Request") },
        stateNamespaceId: "runtime",
        scopeId: "scope",
      },
      {
        instanceId: "storage",
        implementation: ref("std.store-sqlite", "Storage"),
        configuration: { file: "data.sqlite", storeId: "local" },
        stateNamespaceId: "storage",
        scopeId: "scope",
      },
    ],
    bindings: [
      { parentInstanceId: "api", slot: "backend", childInstanceId: "execution" },
      { parentInstanceId: "execution", slot: "store", childInstanceId: "storage" },
    ],
  };
  const application = {
    assemblyId: "writer",
    revision: "v1",
    profile: "durable.v1",
    rootInstanceId: "root",
    instances: [
      {
        instanceId: "root",
        implementation: ref("test.writer", "Root"),
        configuration: {},
        stateNamespaceId: "root",
        scopeId: "scope",
      },
      {
        instanceId: "parent",
        implementation: ref("test.writer", "Parent"),
        configuration: {},
        stateNamespaceId: "parent",
        scopeId: "scope",
      },
      ...["connected", "sibling"].map((instanceId) => ({
        instanceId,
        implementation: ref("test.writer", "Writer"),
        configuration: { endpoint: remote.endpoint },
        stateNamespaceId: instanceId,
        scopeId: "scope",
      })),
    ],
    bindings: [
      { parentInstanceId: "root", slot: "parent", childInstanceId: "parent" },
      { parentInstanceId: "root", slot: "sibling", childInstanceId: "sibling" },
      { parentInstanceId: "parent", slot: "effect", childInstanceId: "connected" },
    ],
  };
  const capabilities = [
    "credential",
    "data.directory",
    "native.sqlite",
    "profile.application",
    "local.subject",
  ];
  const profile = {
    bootstrapDirectory: distribution,
    dataDirectory: join(directory, "data"),
    services,
    application,
    principalId: "local",
    grants: {
      api: capabilities,
      execution: capabilities.filter((value) => value !== "credential"),
      storage: ["data.directory", "native.sqlite"],
    },
    credentials: { "api-token": { environment: "FRNESS_API_TOKEN", instances: ["api"] } },
  };
  const profilePath = join(directory, "profile.json");
  await writeFile(profilePath, JSON.stringify(profile));
  await generation.close();
  const token = "test-only-daemon-authentication";
  const start = async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "apps/daemon/src/main.ts", profilePath],
      { env: { ...process.env, FRNESS_API_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\n")) {
          try {
            const data = JSON.parse(output.split("\n")[0]!);
            assert.equal(data.ready, true);
            resolve(data.url);
          } catch (error) {
            reject(error);
          }
        }
      });
      child.on("exit", () => reject(new Error(errors)));
    });
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGTERM");
        const [code] = await closed;
        assert.equal(code, 0, errors);
      }
    };
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "exit");
        child.kill("SIGKILL");
        await closed;
      }
    });
    return { url: await ready, stop };
  };
  const first = await start();
  const request: InvocationRequest = {
    targetInstanceId: "parent",
    assemblyRevision: "v1",
    operation: { contract: ref("test.writer", "Run"), operation: "run" },
    input: { text: "hello", mode: "success" },
    idempotencyKey: "persist-across-daemon",
  };
  const invoke = async (url: string) => {
    const response = await fetch(`${url}/v1/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: url,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 202);
    return response.json();
  };
  const receipt = await invoke(first.url);
  await first.stop();
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
  const second = await start();
  assert.deepEqual(await invoke(second.url), receipt);
  await second.stop();
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
}
