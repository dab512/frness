import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../../apps/daemon/src/main.js";

test("AT-031 CLI-005 a killed owner never respawns a CLI with an unknown active turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const start = (mode: string) => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const child = fork(
      fileURLToPath(new URL("../fixtures/agent-runner/worker.ts", import.meta.url)),
      [directory, mode],
      {
        env: environment,
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const messages: Record<string, unknown>[] = [];
    const waiters: {
      predicate: (message: Record<string, unknown>) => boolean;
      resolve: (value: Record<string, unknown>) => void;
    }[] = [];
    child.on("message", (message) => {
      const value = message as Record<string, unknown>;
      messages.push(value);
      for (const waiter of waiters.splice(0))
        if (waiter.predicate(value)) waiter.resolve(value);
        else waiters.push(waiter);
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const wait = (predicate: (message: Record<string, unknown>) => boolean) => {
      const ready = messages.find(predicate);
      return ready
        ? Promise.resolve(ready)
        : Promise.race([
            new Promise<Record<string, unknown>>((resolve) => waiters.push({ predicate, resolve })),
            once(child, "exit").then(() => {
              throw new Error(stderr || "Worker exited");
            }),
          ]);
    };
    const kill = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, "exit");
        child.kill("SIGKILL");
        await done;
      }
    };
    t.after(kill);
    return { child, wait, kill };
  };
  const first = start("run");
  await first.wait((message) => message.accepted === true);
  const running = await first.wait((message) => message.running === true);
  const pid = running.pid as number;
  t.after(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  });
  await first.kill();
  const second = start("recover");
  const recovered = await second.wait((message) => message.recovered === true);
  assert.equal(recovered.phase, "unknown");
  assert.ok((recovered.session as { activeTurnId: string | null }).activeTurnId);
  process.kill(pid, 0);
  const closed = once(second.child, "exit");
  second.child.send("close");
  assert.equal((await closed)[0], 0);
});

import { claudeTransport } from "../../plugins/agent-runtime/adapters/claude.js";
import { codexTransport } from "../../plugins/agent-runtime/adapters/codex.js";
import { ObserverSlot } from "../../plugins/agent-runtime/src/observer-slot.js";
import { JsonLines, startCliProcess } from "../../plugins/agent-runtime/src/process.js";
import { replayCliTurn } from "../../plugins/agent-runtime/src/replay.js";
import { CliRuntime } from "../../plugins/agent-runtime/src/runtime.js";
import type { TransportEvent } from "../../plugins/agent-runtime/src/transport.js";
import type { UsageObserver } from "../../plugins/agent-usage/src/observer.js";

test("AT-031 CLI-009 CLI-012 observer replacement drains across an active turn and replay never spawns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-reload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await cliProfile(directory);
  t.after(() => rig.daemon.close());
  const oldEvents: string[] = [];
  const newEvents: string[] = [];
  const slot = new ObserverSlot({
    async observe(input) {
      oldEvents.push(input.event.object.objectId);
    },
  });
  let ready: ((pid: number) => void) | undefined;
  const running = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const runtime = new CliRuntime({
    ...rig.runtime.options,
    observers: [
      slot,
      {
        async observe(input) {
          const envelope = input.event.value as unknown as {
            event: { kind: string; value?: { type?: string; pid?: number } };
          };
          if (envelope.event.kind === "provider" && envelope.event.value?.type === "test.ready")
            ready!(envelope.event.value.pid!);
        },
      },
    ],
  });
  const receipt = await runtime.invoke({
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "run" },
    input: { prompt: "hold-then-answer" },
    idempotencyKey: "reload-observer",
  });
  const pid = await running;
  t.after(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  });
  await slot.replace({
    async observe(input) {
      newEvents.push(input.event.object.objectId);
    },
  });
  process.kill(pid, 0);
  process.kill(pid, "SIGUSR1");
  await runtime.idle();
  await runtime.observersIdle();
  assert.ok(oldEvents.length);
  assert.ok(newEvents.length);
  assert.equal(
    oldEvents.some((event) => newEvents.includes(event)),
    false,
  );
  const replay = await replayCliTurn(
    runtime.read.bind(runtime),
    runtime.options.types,
    receipt.invocation,
  );
  assert.equal(replay.result, "hold-then-answer");
  assert.equal(replay.externalCalls, 0);
  assert.equal(replay.productionWrites, 0);
  await assert.rejects(
    runtime.invoke({
      targetInstanceId: "cli",
      assemblyRevision: "v1",
      operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "fork" },
      input: {},
      idempotencyKey: "unsupported-fork",
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "UNSUPPORTED_OPERATION",
  );
});

import type { InvocationRequest, ObjectRef } from "../../specs/fractal-harness/contracts.js";
import { cliProfile } from "../support/cli-profile.js";

test("AT-031 CLI-007 unsupported permission operations fail before transport and usage remains unknown", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-unknown-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await cliProfile(directory, "codex", { addons: true, maxRuns: 5 });
  t.after(() => rig.daemon.close());
  const request: InvocationRequest = {
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "respondPermission" },
    input: {},
    idempotencyKey: "permission",
  };
  await assert.rejects(
    rig.runtime.invoke(request),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "UNSUPPORTED_OPERATION",
  );
  const receipt = await rig.runtime.invoke({
    ...request,
    operation: { ...request.operation, operation: "run" },
    input: { prompt: "unknown-usage" },
    idempotencyKey: "unknown-usage",
  });
  await rig.runtime.idle();
  await rig.runtime.observersIdle();
  const turn = (await rig.runtime.read(receipt.invocation)).value as unknown as {
    session: ObjectRef;
    phase: string;
  };
  assert.equal(turn.phase, "completed");
  const usage = rig.daemon.service("usage") as UsageObserver;
  assert.equal(
    ((await usage.summary(turn.session, "input-token")) as { total: number | null }).total,
    null,
  );
  const replay = await replayCliTurn(
    rig.runtime.read.bind(rig.runtime),
    rig.runtime.options.types,
    receipt.invocation,
  );
  for (const record of replay.events) await usage.observe({ session: turn.session, event: record });
  assert.equal(
    ((await usage.summary(turn.session, "input-token")) as { total: number | null }).total,
    null,
  );
});

import { startCliWorker } from "../support/cli-worker.js";

test("AT-031 CLI-005 each launch and publication crash cut recovers without repeating the prompt", async (t) => {
  for (const point of [
    "after_accept",
    "before_spawn",
    "after_spawn",
    "before_event_commit",
    "after_terminal_commit",
  ])
    await t.test(point, async (caseTest) => {
      const directory = await mkdtemp(join(tmpdir(), "frness-cli-cut-"));
      caseTest.after(() => rm(directory, { recursive: true, force: true }));
      const first = startCliWorker(caseTest, directory, point);
      const barrier = await first.wait((value) => value.barrier === point);
      const pid = barrier.pid as number | null;
      if (pid)
        caseTest.after(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        });
      await first.kill();
      const next = startCliWorker(caseTest, directory, "recover");
      const recovered = await next.wait((value) => value.recovered === true);
      assert.equal(
        recovered.phase,
        point === "after_accept"
          ? "failed"
          : point === "after_terminal_commit"
            ? "completed"
            : "unknown",
      );
      const active = (recovered.session as { activeTurnId: string | null }).activeTurnId;
      assert.equal(active === null, ["after_accept", "after_terminal_commit"].includes(point));
      const exited = once(next.child, "exit");
      next.child.send("close");
      assert.equal((await exited)[0], 0);
    });
});

test("AT-031 CLI-011 installed usage and limits plugins own their storage and can be detached", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-addons-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await cliProfile(directory, "codex", { addons: true });
  t.after(() => rig.daemon.close());
  const usage = rig.daemon.service("usage") as UsageObserver;
  const request: InvocationRequest = {
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "run" },
    input: { prompt: "first" },
    idempotencyKey: "first",
  };
  const receipt = await rig.runtime.invoke(request);
  await rig.runtime.idle();
  await rig.runtime.observersIdle();
  const turn = (await rig.runtime.read(receipt.invocation)).value as unknown as {
    session: ObjectRef;
    phase: string;
  };
  assert.equal(turn.phase, "completed");
  assert.equal(((await usage.summary(turn.session, "input-token")) as { total: number }).total, 10);
  const second = await rig.runtime.invoke({ ...request, idempotencyKey: "denied" });
  await rig.runtime.idle();
  assert.equal(
    ((await rig.runtime.read(second.invocation)).value as { error: { code: string } }).error.code,
    "ADMISSION_LIMIT_REACHED",
  );
  const digest = rig.daemon.generation.description.packages.find(
    (item) => item.source.packageId === "std.agent-runtime",
  )!.digest;
  await rig.daemon.close();
  const detached = new Set(["usage", "gate", "usage-storage", "limits-storage"]);
  const next = await startDaemon(
    {
      ...rig.profile,
      services: {
        ...rig.profile.services,
        instances: rig.profile.services.instances.filter(
          (instance) => !detached.has(instance.instanceId),
        ),
        bindings: rig.profile.services.bindings.filter(
          (binding) =>
            !detached.has(binding.parentInstanceId) && !detached.has(binding.childInstanceId),
        ),
      },
    },
    { FRNESS_API_TOKEN: rig.token },
  );
  t.after(() => next.close());
  const runtime = (next.service("cli") as { runtime: CliRuntime }).runtime;
  const unrestricted = await runtime.invoke({ ...request, idempotencyKey: "without-policy" });
  await runtime.idle();
  assert.equal(
    ((await runtime.read(unrestricted.invocation)).value as { phase: string }).phase,
    "completed",
  );
  assert.equal(
    next.generation.description.packages.find(
      (item) => item.source.packageId === "std.agent-runtime",
    )!.digest,
    digest,
  );
  await next.close();
  const restored = await startDaemon(rig.profile, { FRNESS_API_TOKEN: rig.token });
  t.after(() => restored.close());
  assert.equal(
    (
      (await (restored.service("usage") as UsageObserver).summary(turn.session, "input-token")) as {
        total: number;
      }
    ).total,
    10,
  );
});

test("AT-031 CLI-006 interrupt during a pending launch cannot start a late process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-pending-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await cliProfile(directory);
  t.after(() => rig.daemon.close());
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.after(() => release!());
  const runtime = new CliRuntime({
    ...rig.runtime.options,
    gate: {
      async check() {
        entered!();
        await gate;
        return { kind: "allow" };
      },
    },
  });
  const receipt = await runtime.invoke({
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "run" },
    input: { prompt: "pending" },
    idempotencyKey: "pending",
  });
  await ready;
  const stopped = runtime.interrupt(receipt.invocation);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    ((await runtime.read(receipt.invocation)).value as { phase: string }).phase,
    "cancelled",
  );
  await stopped;
  release!();
  await runtime.idle();
  assert.equal(
    ((await runtime.read(receipt.invocation)).value as { phase: string }).phase,
    "cancelled",
  );
});

test("AT-031 CLI-012 optional gates deny before spawn and observer failures preserve the terminal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-extensions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await cliProfile(directory);
  t.after(() => rig.daemon.close());
  const marker = join(directory, "spawn.log");
  const provider = {
    ...rig.runtime.options.provider,
    transport: codexTransport({
      executable: fileURLToPath(new URL("../fixtures/agent-runner/codex", import.meta.url)),
      environment: { CLI_MARKER: marker },
    }),
  };
  const denied = new CliRuntime({
    ...rig.runtime.options,
    provider,
    gate: {
      async check() {
        return {
          kind: "deny",
          error: {
            code: "TEST_POLICY_DENIED",
            message: "Denied by test policy",
            details: null,
            retryable: false,
          },
        };
      },
    },
  });
  const request: InvocationRequest = {
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "run" },
    input: { prompt: "answer" },
    idempotencyKey: "gate-denies",
  };
  const receipt = await denied.invoke(request);
  await denied.idle();
  assert.equal(
    ((await denied.read(receipt.invocation)).value as { phase: string }).phase,
    "failed",
  );
  await assert.rejects(readFile(marker));
  const observed: string[] = [];
  const failingObserver = new CliRuntime({
    ...rig.runtime.options,
    provider,
    observers: [
      {
        async observe(input) {
          observed.push((input.event.value as unknown as { event: { kind: string } }).event.kind);
          throw new Error("Observer failure");
        },
      },
    ],
  });
  const completed = await failingObserver.invoke({ ...request, idempotencyKey: "observer-fails" });
  await failingObserver.idle();
  await failingObserver.observersIdle();
  assert.equal(
    ((await failingObserver.read(completed.invocation)).value as { phase: string }).phase,
    "completed",
  );
  assert.ok(observed.includes("terminal"));
  assert.equal((await readFile(marker, "utf8")).trim(), "spawn");
});

test("AT-031 CLI-001 CLI-004 CLI-009 minimal CLI assembly stores its own entities and resumes without managed execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rig = await cliProfile(directory);
  t.after(() => rig.daemon.close());
  assert.equal(
    rig.daemon.generation.description.packages.some((item) =>
      ["std.execution", "std.llm", "std.agent-usage", "std.agent-limits"].includes(
        item.source.packageId,
      ),
    ),
    false,
  );
  const request: InvocationRequest = {
    targetInstanceId: "cli",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.agent-runtime", "Runner"), operation: "run" },
    input: { prompt: "answer" },
    idempotencyKey: "first",
  };
  const headers = {
    authorization: `Bearer ${rig.token}`,
    origin: rig.url,
    "content-type": "application/json",
  };
  const response = await fetch(`${rig.url}/v1/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 202);
  const receipt = (await response.json()) as { request: ObjectRef; invocation: ObjectRef };
  await rig.runtime.idle();
  const turn = (await rig.runtime.read(receipt.invocation)).value as unknown as {
    phase: string;
    result: string;
    session: ObjectRef;
  };
  assert.equal(turn.phase, "completed");
  assert.equal(turn.result, "answer");
  assert.equal("usage" in turn, false);
  const session = await rig.runtime.resume(turn.session);
  assert.equal(session.nativeHandle, "native-codex-session");
  const repeat = await rig.runtime.invoke(request);
  assert.deepEqual(repeat, receipt);
  const next = await rig.runtime.invoke({
    ...request,
    input: { prompt: "next", session: { ...turn.session, type: { ...turn.session.type } } },
    idempotencyKey: "next",
  });
  await rig.runtime.idle();
  assert.equal(
    ((await rig.runtime.read(next.invocation)).value as { result: string }).result,
    "next",
  );
  assert.equal((await rig.runtime.resume(turn.session)).nativeHandle, session.nativeHandle);
});

import { startTurn } from "../../plugins/agent-runtime/src/turn.js";

test("AT-031 CLI-001 CLI-008 CLI-011 adapters return streamed results without usage or limits in the core", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = (name: string) =>
    fileURLToPath(new URL(`../fixtures/agent-runner/${name}`, import.meta.url));
  for (const transport of [
    codexTransport({ executable: executable("codex") }),
    claudeTransport({ executable: executable("claude") }),
  ]) {
    const events: TransportEvent[] = [];
    const turn = startTurn(
      transport,
      { prompt: "Ответ 🌲", cwd: directory, nativeHandle: null },
      async (event) => {
        events.push(event);
      },
    );
    const result = await turn.done;
    assert.equal(result.status, "completed");
    assert.equal(result.text, "Ответ 🌲");
    assert.ok(result.nativeHandle);
    assert.equal("usage" in result, false);
    assert.equal("limits" in transport.capabilities, false);
    assert.equal(JSON.stringify(events).includes("must-be-redacted"), false);
    assert.ok(
      events.some(
        (event) =>
          event.kind === "provider" && JSON.stringify(event.value).includes("input_tokens"),
      ),
    );
    const resumed = startTurn(
      transport,
      { prompt: "next", cwd: directory, nativeHandle: result.nativeHandle },
      async () => {},
    );
    assert.equal((await resumed.done).nativeHandle, result.nativeHandle);
  }
  assert.equal(
    (
      await startTurn(
        codexTransport({ executable: executable("codex") }),
        { prompt: "missing-final", cwd: directory, nativeHandle: null },
        async () => {},
      ).done
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await startTurn(
        claudeTransport({ executable: executable("claude") }),
        { prompt: "fail", cwd: directory, nativeHandle: null },
        async () => {},
      ).done
    ).status,
    "failed",
  );
});

test("AT-031 CLI-003 process transport handles byte-fragmented frames and keeps prompts out of shell", async (t) => {
  const decoder = new JsonLines();
  const encoded = new TextEncoder().encode('{"text":"🌲"}\n{"x":1}\n');
  const frames = [...encoded].flatMap((byte) => decoder.push(Uint8Array.of(byte)));
  assert.deepEqual(frames, [{ text: "🌲" }, { x: 1 }]);
  assert.deepEqual(decoder.finish(), []);
  assert.throws(() => new JsonLines().push(new TextEncoder().encode("{bad}\n")));
  assert.throws(() => new JsonLines(10).push(new TextEncoder().encode('{"text":"too long"}')));
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "prompt.txt");
  const injected = join(directory, "must-not-exist");
  const prompt = `literal $(touch ${injected}) and \`touch ${injected}\`\nnext line`;
  const received: unknown[] = [];
  const process = startCliProcess(
    {
      executable: globalThis.process.execPath,
      args: [
        fileURLToPath(new URL("../fixtures/agent-runner/process.mjs", import.meta.url)),
        "success",
        marker,
      ],
      cwd: directory,
      input: prompt,
    },
    async (frame) => {
      received.push(frame);
    },
  );
  const exit = await process.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.errorCode, null);
  assert.deepEqual((received[0] as { prompt: string }).prompt, prompt);
  assert.equal(await readFile(marker, "utf8"), prompt);
  await assert.rejects(readFile(injected));
});

test("AT-031 CLI-002 CLI-006 process handles cannot interrupt a replacement run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cli-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let ready: (() => void) | undefined;
  const marker = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const first = startCliProcess(
    {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("../fixtures/agent-runner/process.mjs", import.meta.url)),
        "hold",
      ],
      cwd: directory,
      input: "prompt",
    },
    async (frame) => {
      if ((frame as { kind?: string }).kind === "ready") ready!();
    },
  );
  await marker;
  await first.interrupt();
  assert.equal((await first.done).code, 0);
  const next = startCliProcess(
    {
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("../fixtures/agent-runner/process.mjs", import.meta.url)),
        "success",
      ],
      cwd: directory,
      input: "next",
    },
    async () => {},
  );
  await first.interrupt();
  assert.equal((await next.done).code, 0);
  const missing = startCliProcess(
    { executable: join(directory, "missing"), args: [], cwd: directory, input: "" },
    async () => {},
  );
  assert.equal((await missing.done).errorCode, "EXECUTABLE_NOT_FOUND");
});
