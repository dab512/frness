import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { executionManifest } from "../../plugins/execution/definitions/manifest.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";
import { startRemote } from "../fixtures/remote.js";
import { writerManifest } from "../fixtures/writer/manifest.js";

test("AT-009 real process kills at T2-T5 preserve receipts and never resend uncertain effects", async (t) => {
  for (const point of [
    "before_prepare_commit",
    "after_prepare_commit",
    "after_dispatch_commit_before_transport",
    "after_remote_accept_before_receipt",
    "after_receipt_commit_before_reduce",
    "after_reduce_commit",
  ]) {
    await t.test(point, async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "frness-crash-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const remote = await startRemote(join(directory, "remote.sqlite"));
      caseTest.after(() => remote.close());
      const distribution = join(directory, "distribution");
      await buildBootstrap(distribution, {
        packages: [
          (meta) => ({
            manifest: executionManifest(meta),
            files: {
              "server.mjs":
                "export const reload={async capture(){return {type:null,value:null}},async restore(){},async ready(){},async dispose(){}}",
            },
          }),
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
      const ref = (name: string) => {
        const found = generation.description.definitions.find(
          (item) => item.ref.packageId === "test.writer" && item.ref.name === name,
        )?.ref;
        assert.ok(found);
        return found;
      };
      await writeFile(
        join(directory, "assembly.json"),
        JSON.stringify({
          assemblyId: "writer",
          revision: "v1",
          profile: "durable.v1",
          rootInstanceId: "root",
          instances: [
            {
              instanceId: "root",
              implementation: ref("Root"),
              configuration: {},
              stateNamespaceId: "root",
              scopeId: "scope",
            },
            {
              instanceId: "parent",
              implementation: ref("Parent"),
              configuration: {},
              stateNamespaceId: "parent",
              scopeId: "scope",
            },
            ...["connected", "sibling"].map((instanceId) => ({
              instanceId,
              implementation: ref("Writer"),
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
        }),
      );
      await generation.close();
      const start = async (crash?: string) => {
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        const child = fork(
          fileURLToPath(new URL("../fixtures/writer/worker.ts", import.meta.url)),
          [directory, ...(crash ? [crash] : [])],
          {
            env: environment,
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        const stop = async () => {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        };
        caseTest.after(stop);
        const next = async () => {
          const [message] = await Promise.race([
            once(child, "message"),
            once(child, "exit").then(() => {
              throw new Error(`Worker exited: ${stderr}`);
            }),
          ]);
          if (message.error) throw new Error(JSON.stringify(message.error));
          return message;
        };
        assert.equal((await next()).ready, true);
        return { child, next, stop };
      };
      const first = await start(point);
      const barrier = first.next();
      first.child.send("pump");
      assert.equal((await barrier).barrier, point);
      await first.stop();
      const countsAtCrash = await remote.counts();
      const second = await start();
      const result = second.next();
      second.child.send("pump");
      const recovered = await result;
      const unknown = [
        "after_dispatch_commit_before_transport",
        "after_remote_accept_before_receipt",
      ].includes(point);
      assert.equal(recovered.result.phase, unknown ? "waiting" : "succeeded");
      assert.equal(recovered.result.waitingReason, unknown ? "indeterminate" : null);
      assert.equal(recovered.duplicatesChecked, unknown ? 0 : 1);
      const counts = await remote.counts();
      assert.deepEqual(counts, {
        calls: point === "after_dispatch_commit_before_transport" ? 0 : 1,
        changes: point === "after_dispatch_commit_before_transport" ? 0 : 1,
      });
      if (unknown) assert.deepEqual(counts, countsAtCrash);
      const duplicate = second.next();
      second.child.send("pump");
      assert.deepEqual((await duplicate).result, recovered.result);
      assert.deepEqual(await remote.counts(), counts);
      await second.stop();
    });
  }
});
