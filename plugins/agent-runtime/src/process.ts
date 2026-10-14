import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { assertJson } from "../../../packages/abi/src/json.js";
import type { Json } from "../../../specs/fractal-harness/contracts.js";

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
/** Framing is independent of provider semantics and optional policy/usage plugins. */
export class JsonLines {
  #parts: Uint8Array[] = [];
  #bytes = 0;
  constructor(readonly maxFrameBytes = 1024 * 1024) {}
  #append(bytes: Uint8Array): void {
    if (this.#bytes + bytes.byteLength > this.maxFrameBytes)
      throw failure("PROTOCOL_FRAME_TOO_LARGE");
    if (bytes.byteLength) {
      this.#parts.push(bytes);
      this.#bytes += bytes.byteLength;
    }
  }
  #line(): Json | undefined {
    const bytes = Buffer.concat(this.#parts, this.#bytes);
    this.#parts = [];
    this.#bytes = 0;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      if (!text) return undefined;
      const value: unknown = JSON.parse(text);
      assertJson(value);
      return value as Json;
    } catch {
      throw failure("INVALID_PROTOCOL");
    }
  }
  push(chunk: Uint8Array): Json[] {
    const values: Json[] = [];
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index++)
      if (chunk[index] === 10) {
        this.#append(chunk.subarray(start, index));
        const value = this.#line();
        if (value !== undefined) values.push(value);
        start = index + 1;
      }
    this.#append(chunk.subarray(start));
    return values;
  }
  finish(): Json[] {
    if (!this.#bytes) return [];
    const value = this.#line();
    return value === undefined ? [] : [value];
  }
}
export interface CliProcessSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly keepInputOpen?: boolean;
}
export interface CliProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly errorCode: string | null;
  readonly started: boolean;
}
export interface CliProcessHandle {
  readonly pid: number | undefined;
  readonly done: Promise<CliProcessExit>;
  send(text: string): Promise<void>;
  interrupt(signal?: NodeJS.Signals): Promise<void>;
}
export function processEnvironment(
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "SystemRoot",
    "COMSPEC",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return { ...environment, ...extra };
}
export function startCliProcess(
  spec: CliProcessSpec,
  onFrame: (frame: Json) => Promise<void>,
): CliProcessHandle {
  const child: ChildProcessWithoutNullStreams = spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd,
    env: processEnvironment(spec.environment),
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new JsonLines();
  let queue = Promise.resolve();
  let closed = false;
  let started = false;
  let errorCode: string | null = null;
  const signal = (value: NodeJS.Signals) => {
    if (closed || !child.pid) return;
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-child.pid, value);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const fail = (error: unknown) => {
    errorCode =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "PROCESS_IO_FAILED";
    signal("SIGTERM");
  };
  child.on("spawn", () => {
    started = true;
  });
  child.on("error", (error) => {
    errorCode =
      "code" in error && error.code === "ENOENT" ? "EXECUTABLE_NOT_FOUND" : "PROCESS_SPAWN_FAILED";
  });
  child.stderr.on("data", () => {});
  child.stdin.on("error", (error) => {
    if (!("code" in error && error.code === "EPIPE")) fail(error);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    child.stdout.pause();
    try {
      const frames = decoder.push(chunk);
      queue = queue
        .then(async () => {
          for (const frame of frames) await onFrame(frame);
        })
        .catch(fail)
        .finally(() => {
          if (!closed) child.stdout.resume();
        });
    } catch (error) {
      fail(error);
      child.stdout.resume();
    }
  });
  const done = new Promise<CliProcessExit>((resolve) => {
    child.on("close", (code, exitSignal) => {
      closed = true;
      void queue
        .then(async () => {
          if (!errorCode) for (const frame of decoder.finish()) await onFrame(frame);
        })
        .catch(fail)
        .finally(() => resolve({ code, signal: exitSignal, errorCode, started }));
    });
  });
  if (spec.keepInputOpen) child.stdin.write(spec.input);
  else child.stdin.end(spec.input);
  return {
    pid: child.pid,
    done,
    async send(text) {
      if (closed || child.stdin.destroyed || child.stdin.writableEnded)
        throw failure("PROCESS_INPUT_CLOSED");
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(text, (error) => (error ? reject(error) : resolve())),
      );
    },
    async interrupt(value = "SIGINT") {
      signal(value);
      await done;
    },
  };
}
