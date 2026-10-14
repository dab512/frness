import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../apps/daemon/src/main.js";
import { ReplayService } from "../../plugins/execution/src/replay.js";
import { RepositoryUnavailable } from "../../plugins/execution/src/repository.js";
import { SqliteObjectStore } from "../../plugins/store-sqlite/src/store.js";
import type { CommitBatch, Json, ObjectStore } from "../../specs/fractal-harness/contracts.js";
import { repositoryRig } from "../support/repository-rig.js";

interface RepositoryWorkerMessage {
  point: string;
  revision: string;
  phase?: string;
  commits?: number;
  changes?: number;
}

test("AT-018 a repository leaf can be replaced by a reducer subtree with the same contract", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-repository-composite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await repositoryRig(directory);
  t.after(() => rig.close());
  rig.registerAssembly({
    ...rig.assembly,
    revision: "v2",
    instances: [
      ...rig.assembly.instances,
      {
        instanceId: "proxy",
        implementation: rig.ref("std.storage", "Proxy"),
        configuration: null,
        stateNamespaceId: "proxy",
        scopeId: "scope",
      },
    ],
    bindings: [
      { parentInstanceId: "parent", slot: "repository", childInstanceId: "proxy" },
      { parentInstanceId: "proxy", slot: "backend", childInstanceId: "repo" },
    ],
  });
  const backend = rig.backend();
  const request = rig.request("composite", "commit", rig.commitInput);
  const receipt = await backend.invoke({ ...request, assemblyRevision: "v2" });
  await backend.idle();
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
  assert.equal(rig.calls.commit, 1);
  assert.equal((await rig.store.read(rig.dataContext, rig.object)).value, "new value");
});

test("AT-018 repository mutation is denied before I/O when the shared step budget is exhausted", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-repository-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await repositoryRig(directory, undefined, false, 1);
  t.after(() => rig.close());
  const backend = rig.backend();
  const receipt = await backend.invoke(rig.request("limited", "commit", rig.commitInput));
  await backend.idle();
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).error?.code, "BUDGET_EXCEEDED");
  assert.equal(rig.calls.commit, 0);
  await assert.rejects(rig.store.read(rig.dataContext, rig.object), { code: "NOT_FOUND" });
});

test("AT-018 an already dispatched repository receipt survives exhausted step quota during recovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-repository-late-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failOnce = true;
  const rig = await repositoryRig(
    directory,
    async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Crash cut after commit");
      }
    },
    false,
    2,
  );
  t.after(() => rig.close());
  const request = rig.request("late", "commit", rig.commitInput);
  const first = rig.backend();
  const receipt = await first.invoke(request);
  await assert.rejects(first.idle(), { code: "REPOSITORY_UNAVAILABLE" });
  const recovered = rig.backend();
  assert.deepEqual(await recovered.invoke(request), receipt);
  await recovered.idle();
  assert.equal((await rig.runtime.snapshot(await rig.repositoryInvocation())).phase, "succeeded");
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).error?.code, "BUDGET_EXCEEDED");
  assert.equal(rig.calls.commit, 2);
  assert.equal((await rig.store.read(rig.dataContext, rig.object)).value, "new value");
});

test("AT-018 SIGKILL after repository commit recovers the original revision with one mutation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-repository-kill-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const start = (mode: string) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = fork(
      new URL("../fixtures/repository/worker.ts", import.meta.url),
      [directory, mode],
      {
        execArgv: ["--import", "tsx"],
        env: environment,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let errors = "";
    child.stderr!.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const message = new Promise<RepositoryWorkerMessage>((resolve, reject) => {
      child.once("message", (value) => resolve(value as RepositoryWorkerMessage));
      child.once("exit", () => reject(new Error(errors || "Worker exited before its checkpoint")));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    });
    return { child, message };
  };
  const first = start("fresh");
  const checkpoint = await first.message;
  assert.equal(checkpoint.point, "afterIO");
  const died = once(first.child, "exit");
  first.child.kill("SIGKILL");
  assert.equal((await died)[1], "SIGKILL");
  const second = start("recover");
  const exited = once(second.child, "exit");
  const result = await second.message;
  assert.equal(result.point, "done");
  assert.equal(result.phase, "succeeded");
  assert.equal(result.revision, checkpoint.revision);
  assert.equal(result.commits, 1);
  assert.equal(result.changes, 1);
  assert.equal((await exited)[0], 0);
});

test("AT-018 repository child retries a committed local mutation through its durable commit receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-repository-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failOnce = true;
  const rig = await repositoryRig(directory, async () => {
    if (failOnce) {
      failOnce = false;
      throw new RepositoryUnavailable();
    }
  });
  t.after(() => rig.close());
  const subscription = rig.store.subscribe(rig.dataContext, "domain");
  t.after(() => subscription.close());
  const before = subscription.snapshot();
  const first = rig.backend();
  const request = rig.request("write", "commit", rig.commitInput);
  const receipt = await first.invoke(request);
  await assert.rejects(first.idle(), { code: "REPOSITORY_UNAVAILABLE" });
  assert.equal((await rig.store.read(rig.dataContext, rig.object)).value, "new value");
  assert.equal(rig.calls.commit, 1);
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "waiting");
  const recovered = rig.backend();
  assert.deepEqual(await recovered.invoke(request), receipt);
  await recovered.idle();
  assert.equal((await rig.runtime.snapshot(receipt.invocation)).phase, "succeeded");
  assert.equal(rig.calls.commit, 2);
  assert.equal(subscription.catchUp(before.cursor).length, 1);
  const read = await recovered.invoke(
    rig.request("read", "read", { object: JSON.parse(JSON.stringify(rig.object)) }),
  );
  await recovered.idle();
  assert.equal(
    ((await rig.runtime.snapshot(read.invocation)).result as { value: string }).value,
    "new value",
  );
  const denied = await recovered.invoke(
    rig.request("foreign", "read", {
      object: { ...JSON.parse(JSON.stringify(rig.object)), namespaceId: "foreign" },
    }),
  );
  await recovered.idle();
  assert.equal((await rig.runtime.snapshot(denied.invocation)).error?.code, "CAPABILITY_DENIED");
  const nativeCalls = { ...rig.calls };
  const invalid = await recovered.invoke(
    rig.request("spoof", "read", {
      object: JSON.parse(JSON.stringify(rig.object)),
      context: { ownerInstanceId: "foreign" },
    }),
  );
  await recovered.idle();
  assert.equal((await rig.runtime.snapshot(invalid.invocation)).phase, "failed");
  assert.deepEqual(rig.calls, nativeCalls);
  const malformedKey = await recovered.invoke(
    rig.request("wrong-key", "commit", {
      batch: {
        ...((rig.commitInput as unknown as { batch: CommitBatch }).batch as unknown as Record<
          string,
          Json
        >),
        commitKey: "another-key",
      },
    }),
  );
  await recovered.idle();
  assert.equal((await rig.runtime.snapshot(malformedKey.invocation)).error?.code, "INVALID_INPUT");
  assert.deepEqual(rig.calls, nativeCalls);
  const unicodeRequest = rig.request("unicode-command", "read", {
    object: JSON.parse(JSON.stringify(rig.object)),
  });
  const unicode = await recovered.invoke({
    ...unicodeRequest,
    input: {
      ...(unicodeRequest.input as Record<string, Json>),
      commandId: `вложенный/${"x".repeat(256)}`,
    },
  });
  await recovered.idle();
  assert.equal((await rig.runtime.snapshot(unicode.invocation)).phase, "succeeded");
});

test("AT-018 native daemon composes repository capabilities without reducer I/O", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-native-repository-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await repositoryRig(directory);
  t.after(() => rig.close());
  const instance = (
    id: string,
    owner: string,
    name: string,
    configuration: Json,
    namespace = id,
  ) => ({
    instanceId: id,
    implementation: rig.ref(owner, name),
    configuration,
    stateNamespaceId: namespace,
    scopeId: "scope",
  });
  const daemon = await startDaemon(
    {
      bootstrapDirectory: rig.distribution,
      dataDirectory: join(directory, "native-data"),
      principalId: "test",
      application: rig.assembly,
      credentials: { api: { environment: "TEST_API", instances: ["api"] } },
      repositories: { main: { serviceId: "storage", instances: ["repo"] } },
      grants: {
        api: ["credential"],
        execution: ["local.subject", "profile.application"],
        storage: ["native.sqlite", "data.directory"],
        repo: ["repository"],
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
          instance(
            "execution",
            "std.execution-backend",
            "Backend",
            {
              executionType: { ...rig.types("Request") },
              repositoryContract: { ...rig.ref("std.storage", "Repository") },
            },
            "runtime",
          ),
          instance("storage", "std.store-sqlite", "Storage", {
            file: "native.sqlite",
            storeId: "local",
          }),
        ],
        bindings: [
          { parentInstanceId: "api", slot: "backend", childInstanceId: "execution" },
          { parentInstanceId: "execution", slot: "store", childInstanceId: "storage" },
        ],
      },
    },
    { TEST_API: "native-repository-test-token" },
  );
  t.after(() => daemon.close());
  const backend = daemon.service("execution") as {
    invoke(input: unknown): Promise<{ invocation: Parameters<ObjectStore["read"]>[1] }>;
    idle(): Promise<void>;
    read(ref: unknown): Promise<{ value: { phase: string; result: unknown } }>;
  };
  const write = await backend.invoke(rig.request("write", "commit", rig.commitInput));
  await backend.idle();
  assert.equal((await backend.read(write.invocation)).value.phase, "succeeded");
  const read = await backend.invoke(
    rig.request("read", "read", { object: JSON.parse(JSON.stringify(rig.object)) }),
  );
  await backend.idle();
  const result = await backend.read(read.invocation);
  assert.equal(result.value.phase, "succeeded");
  assert.equal((result.value.result as { value: string }).value, "new value");
});

test("AT-018 replay of a repository result never reads live domain data or issues a commit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-repository-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await repositoryRig(directory);
  t.after(() => rig.close());
  const backend = rig.backend();
  await backend.invoke(rig.request("commit", "commit", rig.commitInput));
  await backend.idle();
  const invocation = await rig.repositoryInvocation();
  const bytes = await readFile(join(directory, "host.sqlite-wal"));
  const calls = { ...rig.calls };
  const replay = new ReplayService({
    context: rig.context,
    types: rig.types,
    registry: rig.registry,
    read: async (context, ref, revision) => {
      assert.equal(ref.namespaceId, "runtime", "replay cannot read current domain records");
      return rig.store.read(context, ref, revision);
    },
    reducer: () => {
      throw new Error("Repository replay must not request a reducer export");
    },
    repositoryExport: (ref) => rig.generation.getExport(ref.digest, "repository") as ObjectStore,
    createScratch: async (path, type) => {
      const store = new SqliteObjectStore({
        path,
        storeId: "scratch",
        validate: (type, value) => rig.registry.validate(type, value),
      });
      const context = { ...rig.context, ownerInstanceId: "scratch" };
      store.registerNamespace("scratch", "scratch", context.scopeId);
      return {
        store,
        context,
        frame: { storeId: "scratch", namespaceId: "scratch", objectId: "frame", type },
        dispose: () => store.close(),
      };
    },
  });
  const result = await replay.run(invocation, join(directory, "scratch.sqlite"));
  assert.equal(result.transitions, 1);
  assert.equal(result.externalCalls, 0);
  assert.equal(result.productionWrites, 0);
  assert.deepEqual(rig.calls, calls);
  assert.deepEqual(await readFile(join(directory, "host.sqlite-wal")), bytes);
});
