import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon } from "../../apps/daemon/src/main.js";
import { createModelProvider, httpModelTransport } from "../../plugins/llm/src/provider.js";
import { ModelStream } from "../../plugins/llm/src/stream.js";
import type { InvocationReceipt, ObjectStore } from "../../specs/fractal-harness/contracts.js";
import type {
  ModelCompletion,
  ModelRequest,
} from "../../specs/fractal-harness/standard-contracts.js";
import { modelBudgetCheck } from "../support/model-budget.js";
import { modelProfile } from "../support/model-profile.js";

const request: ModelRequest = {
  messages: [{ role: "user", content: "6 * 7?", toolCallId: null }],
  tools: [],
  outputType: null,
  maxOutputTokens: 100,
};
const answer: ModelCompletion = {
  text: "42",
  structured: null,
  toolCalls: [],
  finish: "stop",
  usage: null,
};
const validate = () => {};

test("AT-015 HTTP framing rejects truncation, malformed UTF-8 and records after final", async (t) => {
  const configuration = {
    endpoint: "http://localhost/model",
    model: "test",
    credentialBinding: "test",
    decoder: "frness.model.ndjson.v1" as const,
  };
  const final = `${JSON.stringify({ kind: "final", completion: answer })}\n`;
  for (const [name, records, ok] of [
    [
      "valid Unicode fragments",
      `${JSON.stringify({ kind: "text", delta: "Привет 🌲" })}\n${final}`,
      true,
    ],
    ["no final", '{"kind":"text","delta":"42"}\n', false],
    ["missing newline", final.trim(), false],
    ["length marker", '{"kind":"length"}\n', false],
    ["malformed JSON", '{"kind":\n', false],
    ["event after final", `${final}{"kind":"text","delta":"late"}\n`, false],
  ] as const)
    await t.test(name, async () => {
      const bytes = new TextEncoder().encode(records);
      const transport: typeof fetch = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      const provider = createModelProvider({
        credential: () => "test",
        validate,
        transport: (input) => httpModelTransport(input, transport),
      });
      if (ok) assert.deepEqual(await provider.generate(request, configuration), answer);
      else await assert.rejects(provider.generate(request, configuration));
    });
  const invalidUtf8: typeof fetch = async () =>
    new Response(Uint8Array.of(0xff, 0x0a), {
      headers: { "content-type": "application/x-ndjson" },
    });
  const provider = createModelProvider({
    credential: () => "test",
    validate,
    transport: (input) => httpModelTransport(input, invalidUtf8),
  });
  await assert.rejects(provider.generate(request, configuration));
});

test("AT-015 invalid finals and invalid inputs fail closed before any tool can run", async (t) => {
  const type = {
    packageId: "fixture",
    packageVersion: "1.0.0",
    digest: "sha256:fixture",
    name: "Number",
  };
  const validateNumber = (_: unknown, value: unknown) => {
    if (typeof value !== "number")
      throw Object.assign(new Error("INVALID_OUTPUT"), { code: "INVALID_OUTPUT" });
  };
  const withTools = {
    ...request,
    tools: [{ name: "number", description: "test", inputType: type, outputType: type }],
  };
  const cases: readonly [string, ModelRequest, unknown][] = [
    ["empty completion", request, { ...answer, text: "" }],
    ["unknown finish", request, { ...answer, finish: "length" }],
    ["negative usage", request, { ...answer, usage: { inputTokens: -1, outputTokens: 1 } }],
    ["unknown fields", request, { ...answer, unexpected: true }],
    [
      "wrong structured type",
      { ...request, outputType: type },
      { ...answer, structured: "number?" },
    ],
    ["structured not requested", request, { ...answer, structured: 42 }],
    [
      "tool without tool finish",
      withTools,
      { ...answer, toolCalls: [{ id: "call", name: "number", arguments: 1 }] },
    ],
    ["no calls on tool finish", withTools, { ...answer, finish: "tool_calls" }],
    [
      "unknown tool",
      withTools,
      { ...answer, finish: "tool_calls", toolCalls: [{ id: "call", name: "other", arguments: 1 }] },
    ],
    [
      "bad tool arguments",
      withTools,
      {
        ...answer,
        finish: "tool_calls",
        toolCalls: [{ id: "call", name: "number", arguments: "bad" }],
      },
    ],
    [
      "duplicate tool calls",
      withTools,
      {
        ...answer,
        finish: "tool_calls",
        toolCalls: [
          { id: "call", name: "number", arguments: 1 },
          { id: "call", name: "number", arguments: 1 },
        ],
      },
    ],
  ];
  for (const [name, input, completion] of cases)
    await t.test(name, async () => {
      const stream = new ModelStream(input, validateNumber, async () => {});
      await assert.rejects(stream.push({ kind: "final", completion }), { code: "INVALID_OUTPUT" });
      assert.throws(() => stream.finish(), { code: "INCOMPLETE_RESPONSE" });
    });
  let calls = 0;
  const provider = createModelProvider({
    credential: () => "test",
    validate: validateNumber,
    transport: async function* () {
      calls++;
      yield { kind: "final", completion: answer };
    },
  });
  for (const input of [
    { ...request, messages: [] },
    { ...request, maxOutputTokens: 0 },
    { ...withTools, tools: [...withTools.tools, ...withTools.tools] },
    { ...request, messages: [{ role: "tool", content: "x", toolCallId: null }] },
  ])
    await assert.rejects(
      provider.generate(input as ModelRequest, {
        endpoint: "http://localhost/model",
        model: "test",
        credentialBinding: "test",
        decoder: "frness.model.ndjson.v1",
      }),
      { code: "INVALID_INPUT" },
    );
  assert.equal(calls, 0);
  const success = new ModelStream(withTools, validateNumber, async () => {});
  const toolAnswer = {
    ...answer,
    text: "",
    finish: "tool_calls" as const,
    toolCalls: [{ id: "call", name: "number", arguments: 42 }],
  };
  await success.push({ kind: "final", completion: toolAnswer });
  assert.deepEqual(success.finish(), toolAnswer);
});

test("AT-015 single-call daemon uses scoped credentials and one actual HTTP request; restart preserves its receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer(async (incoming, outgoing) => {
    calls++;
    assert.equal(incoming.headers.authorization, "Bearer test-model-token");
    let body = "";
    for await (const chunk of incoming) body += chunk.toString();
    const sent = JSON.parse(body);
    assert.equal(sent.model, "test-model");
    assert.deepEqual(sent.request, request);
    outgoing.writeHead(200, { "content-type": "application/x-ndjson" });
    outgoing.write(`${JSON.stringify({ kind: "text", delta: "42" })}\n`);
    outgoing.end(`${JSON.stringify({ kind: "final", completion: answer })}\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const rig = await modelProfile(directory, `http://127.0.0.1:${address.port}/model`);
  const input = {
    targetInstanceId: "generate",
    assemblyRevision: "v1",
    operation: { contract: rig.ref("std.llm", "Generate"), operation: "generate" },
    input: request,
    idempotencyKey: "single-call",
  };
  let receipt: InvocationReceipt | undefined;
  for (let restart = 0; restart < 2; restart++) {
    const daemon = await rig.start();
    try {
      const url = (daemon.value as { url: string }).url;
      const response = await fetch(`${url}/v1/invoke`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-api-token-for-local-fixture",
          origin: url,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
      const accepted = (await response.json()) as InvocationReceipt;
      if (receipt) assert.deepEqual(accepted, receipt);
      else receipt = accepted;
      await (daemon.service("execution") as { idle(): Promise<void> }).idle();
      const record = await (
        daemon.service("execution") as {
          read(ref: unknown): Promise<{ value: { phase: string; result: unknown } }>;
        }
      ).read(accepted.invocation);
      assert.equal(record.value.phase, "succeeded");
      assert.deepEqual(record.value.result, answer);
      assert.equal(calls, 1);
      if (restart === 1) {
        await modelBudgetCheck(
          daemon,
          rig.profile.application!,
          { ...input, input: JSON.parse(JSON.stringify(request)) },
          (name) => rig.ref("std.execution", name),
        );
        assert.equal(calls, 2, "shared budget must prevent a third physical model call");
      }
    } finally {
      await daemon.close();
    }
  }
  const denied = await startDaemon(
    {
      ...rig.profile,
      credentials: {
        ...rig.profile.credentials,
        model: { environment: "TEST_MODEL", instances: ["api"] },
      },
    },
    { TEST_API: "test-api-token-for-local-fixture", TEST_MODEL: "test-model-token" },
  );
  try {
    const backend = denied.service("execution") as {
      invoke(input: unknown): Promise<InvocationReceipt>;
      idle(): Promise<void>;
      read(ref: unknown): Promise<{
        value: { phase: string; error: { code: string }; unresolvedEffectIds: string[] };
      }>;
    };
    const accepted = await backend.invoke({ ...input, idempotencyKey: "denied-credential" });
    await backend.idle();
    const record = await backend.read(accepted.invocation);
    assert.equal(record.value.phase, "failed");
    const raw = await (denied.service("storage") as ObjectStore).read(
      {
        principalId: "local",
        scopeId: "scope",
        ownerInstanceId: "execution",
        assemblyRevision: "v1",
        grants: [],
      },
      accepted.invocation,
    );
    assert.equal((raw.value as { error: { code: string } }).error.code, "DEPENDENCY_UNAVAILABLE");
    assert.deepEqual(record.value.unresolvedEffectIds, []);
    assert.equal(calls, 2, "wrong instance cannot resolve or use another instance's credential");
  } finally {
    await denied.close();
  }
  const bytes = await readFile(join(directory, "data/model.sqlite"));
  assert.equal(bytes.includes(Buffer.from("test-model-token")), false);
  assert.equal(bytes.includes(Buffer.from("test-api-token-for-local-fixture")), false);
});

test("AT-015 only a validated final marker publishes a completion", async () => {
  const provisional: unknown[] = [];
  const stream = new ModelStream(request, validate, async (chunk) => {
    provisional.push(chunk);
  });
  await stream.push({ kind: "text", delta: "42" });
  assert.throws(() => stream.finish(), { code: "INCOMPLETE_RESPONSE" });
  await stream.push({ kind: "final", completion: answer });
  assert.deepEqual(stream.finish(), answer);
  assert.equal(provisional.length, 1);
  await assert.rejects(stream.push({ kind: "final", completion: answer }), {
    code: "INVALID_OUTPUT",
  });
});

test("AT-015 missing configuration or credential produces zero provider calls", async () => {
  let calls = 0;
  const provider = createModelProvider({
    validate,
    credential: () => {
      throw new Error("unavailable");
    },
    transport: async function* () {
      calls++;
      yield { kind: "final", completion: answer };
    },
  });
  for (const configuration of [
    {},
    {
      endpoint: "http://localhost/model",
      model: "test",
      credentialBinding: "absent",
      decoder: "frness.model.ndjson.v1",
    },
  ]) {
    await assert.rejects(provider.generate(request, configuration), {
      code: "DEPENDENCY_UNAVAILABLE",
    });
  }
  assert.equal(calls, 0);
  const charged = createModelProvider({
    validate,
    credential: () => "test",
    transport: async function* () {
      calls++;
      throw Object.assign(new Error("Remote dependency failed after request"), {
        code: "DEPENDENCY_UNAVAILABLE",
      });
    },
  });
  await assert.rejects(
    charged.generate(request, {
      endpoint: "http://localhost/model",
      model: "test",
      credentialBinding: "test",
      decoder: "frness.model.ndjson.v1",
    }),
    { code: "INCOMPLETE_RESPONSE" },
  );
  assert.equal(calls, 1);
});

test("AT-015 partial or complete tool JSON without final never becomes executable output", async () => {
  for (const delta of [
    '{"name":"write","arguments":',
    '{"name":"write","arguments":{"path":"x"}}',
  ]) {
    const provider = createModelProvider({
      validate,
      credential: () => "test",
      transport: async function* () {
        yield { kind: "text", delta };
      },
    });
    await assert.rejects(
      provider.generate(request, {
        endpoint: "http://localhost/model",
        model: "test",
        credentialBinding: "test",
        decoder: "frness.model.ndjson.v1",
      }),
      { code: "INCOMPLETE_RESPONSE" },
    );
  }
});
