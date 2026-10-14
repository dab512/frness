import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeTransport } from "../../plugins/agent-runtime/adapters/claude.js";
import { codexTransport } from "../../plugins/agent-runtime/adapters/codex.js";
import { JsonLines, startCliProcess } from "../../plugins/agent-runtime/src/process.js";
import type { TransportEvent } from "../../plugins/agent-runtime/src/transport.js";
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
