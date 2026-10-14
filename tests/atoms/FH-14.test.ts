import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApiServer } from "../../plugins/api/src/server.js";
import { createExecutionBackend } from "../../plugins/execution/src/backend.js";
import type {
  InvocationReceipt,
  InvocationRequest,
} from "../../specs/fractal-harness/contracts.js";
import { startRemote } from "../fixtures/remote.js";
import { createWriterRig } from "../fixtures/writer/rig.js";
import { daemonCheck } from "../support/daemon-check.js";

test(
  "AT-014 daemon plugin factories survive restart without repeating an accepted operation",
  daemonCheck,
);

test("AT-014 API and CLI share durable receipts; SSE reconnect and disconnect never repeat accepted work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-api-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = await startRemote(join(directory, "remote.sqlite"));
  t.after(() => remote.close());
  const rig = await createWriterRig(directory, remote.endpoint, {
    strategy: "non-retryable",
    maxAttempts: 1,
    idempotencyValidUntil: null,
  });
  t.after(() => rig.close());
  const backend = createExecutionBackend({
    runtime: rig.runtime,
    outbox: rig.outbox,
    store: rig.store,
    context: rig.context,
    project: rig.project,
  });
  const token = "local-test-credential-not-for-production";
  let accept: ((receipt: InvocationReceipt) => void) | undefined;
  let release: (() => void) | undefined;
  const accepted = new Promise<InvocationReceipt>((resolve) => {
    accept = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstReceipt = true;
  const api = await createApiServer({
    token,
    backend,
    port: 0,
    afterAccept: async (receipt) => {
      if (firstReceipt) {
        firstReceipt = false;
        accept!(receipt);
        await barrier;
      }
    },
  });
  t.after(() => api.close());
  const headers = {
    authorization: `Bearer ${token}`,
    origin: api.url,
    "content-type": "application/json",
  };
  const request: InvocationRequest = {
    targetInstanceId: "parent",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("Run"), operation: "run" },
    input: { text: "hello", mode: "success" },
    idempotencyKey: "api-cli",
  };
  for (const bad of [
    { ...headers, authorization: "Bearer invalid" },
    { ...headers, origin: "https://untrusted.example" },
    { origin: api.url, "content-type": "application/json" },
  ]) {
    const denied = await fetch(`${api.url}/v1/invoke`, {
      method: "POST",
      headers: bad,
      body: JSON.stringify(request),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      code: "CAPABILITY_DENIED",
      message: "Request is not authorized",
      details: null,
      retryable: false,
    });
  }
  assert.deepEqual(await remote.counts(), { calls: 0, changes: 0 });
  const subscription = await fetch(`${api.url}/v1/subscriptions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ namespaceId: "runtime" }),
  });
  assert.equal(subscription.status, 200);
  const snapshot = (await subscription.json()) as { cursor: string };
  const timeout = new AbortController();
  const response = fetch(`${api.url}/v1/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: timeout.signal,
  });
  const receipt = await accepted;
  timeout.abort();
  await assert.rejects(response);
  release!();
  const contractFile = join(directory, "contract.json");
  const inputFile = join(directory, "input.json");
  await writeFile(contractFile, JSON.stringify(request.operation.contract));
  await writeFile(inputFile, JSON.stringify(request.input));
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "apps/cli/src/main.ts",
      "invoke",
      "--endpoint",
      api.url,
      "--instance",
      "parent",
      "--assembly-revision",
      "v1",
      "--contract-file",
      contractFile,
      "--operation",
      "run",
      "--input-file",
      inputFile,
      "--key",
      "api-cli",
    ],
    { env: { ...process.env, FRNESS_API_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const [exit] = await once(child, "exit");
  assert.equal(exit, 0, errors);
  assert.deepEqual(JSON.parse(output), receipt);
  await backend.idle();
  const read = await fetch(
    `${api.url}/v1/objects/read?ref=${encodeURIComponent(JSON.stringify(receipt.invocation))}`,
    { headers },
  );
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { value: { phase: string } }).value.phase, "succeeded");
  const controller = new AbortController();
  const stream = await fetch(
    `${api.url}/v1/events?namespaceId=runtime&cursor=${encodeURIComponent(snapshot.cursor)}`,
    { headers, signal: controller.signal },
  );
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const first = await reader.read();
  assert.ok(first.value);
  const text = new TextDecoder().decode(first.value);
  assert.match(text, /event: change/);
  const cursor = text.match(/^id: (.+)$/m)?.[1];
  assert.ok(cursor);
  controller.abort();
  await reader.cancel().catch(() => {});
  const reconnect = new AbortController();
  const resumed = await fetch(`${api.url}/v1/events?namespaceId=runtime`, {
    headers: { ...headers, "last-event-id": cursor },
    signal: reconnect.signal,
  });
  assert.equal(resumed.status, 200);
  reconnect.abort();
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
  const repeated = await fetch(`${api.url}/v1/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  assert.deepEqual(await repeated.json(), receipt);
  await backend.idle();
  assert.deepEqual(await remote.counts(), { calls: 1, changes: 1 });
});
