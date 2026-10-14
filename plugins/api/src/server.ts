import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TextDecoder } from "node:util";
import { assertJson } from "../../../packages/abi/src/json.js";
import type { InvocationReceipt } from "../../../specs/fractal-harness/contracts.js";
import {
  type ApiBackend,
  errorStatus,
  invalid,
  invocationRequest,
  objectRef,
  protocolError,
  subscriptionRequest,
} from "./protocol.js";

export interface ApiServerOptions {
  readonly token: string;
  readonly backend: ApiBackend;
  readonly port?: number;
  readonly origins?: readonly string[];
  readonly pollIntervalMs?: number;
  readonly afterAccept?: (receipt: InvocationReceipt) => Promise<void>;
}
export async function createApiServer(options: ApiServerOptions) {
  if (!options.token || options.token.length < 16) invalid("Local bearer credential is required");
  if (
    ["invoke", "read", "subscribe"].some(
      (name) => typeof (options.backend as unknown as Record<string, unknown>)[name] !== "function",
    )
  )
    throw Object.assign(new Error("Invalid API backend"), { code: "INVALID_OUTPUT" });
  const credentialHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const streams = new Set<ServerResponse>();
  const allowed = new Set(options.origins ?? []);
  let url = "";
  function authorize(request: IncomingMessage): void {
    if (!request.headers.origin || !allowed.has(request.headers.origin))
      throw Object.assign(new Error(), { code: "CAPABILITY_DENIED" });
    const supplied = createHash("sha256")
      .update(request.headers.authorization ?? "")
      .digest();
    if (!timingSafeEqual(supplied, credentialHash))
      throw Object.assign(new Error(), { code: "CAPABILITY_DENIED" });
  }
  function send(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed) return;
    assertJson(value);
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(JSON.stringify(value));
  }
  async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) invalid("Request is too large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      return invalid("Malformed JSON");
    }
  }
  const server = createServer((request, response) => {
    void (async () => {
      const origin = request.headers.origin;
      if (origin && allowed.has(origin)) response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        if (!origin || !allowed.has(origin))
          throw Object.assign(new Error(), { code: "CAPABILITY_DENIED" });
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, last-event-id",
        });
        response.end();
        return;
      }
      authorize(request);
      const target = new URL(request.url ?? "/", url);
      if (request.method === "POST" && target.pathname === "/v1/invoke") {
        const input = invocationRequest(await body(request));
        const receipt = await options.backend.invoke(input);
        await options.afterAccept?.(receipt);
        send(response, 202, receipt);
        return;
      }
      if (request.method === "GET" && target.pathname === "/v1/objects/read") {
        let value: unknown;
        try {
          value = JSON.parse(target.searchParams.get("ref") ?? "");
        } catch {
          invalid();
        }
        send(
          response,
          200,
          await options.backend.read(
            objectRef(value),
            target.searchParams.get("revision") ?? undefined,
          ),
        );
        return;
      }
      if (request.method === "POST" && target.pathname === "/v1/subscriptions") {
        const subscription = options.backend.subscribe(subscriptionRequest(await body(request)));
        try {
          send(response, 200, subscription.snapshot());
        } finally {
          subscription.close();
        }
        return;
      }
      if (request.method === "GET" && target.pathname === "/v1/events") {
        const namespaceId = target.searchParams.get("namespaceId");
        if (!namespaceId) invalid();
        const header = request.headers["last-event-id"];
        const cursor = typeof header === "string" ? header : target.searchParams.get("cursor");
        if (!cursor) invalid();
        const subscription = options.backend.subscribe(namespaceId);
        let current = cursor;
        let initial: ReturnType<typeof subscription.catchUp>;
        try {
          initial = subscription.catchUp(current);
        } catch (error) {
          subscription.close();
          throw error;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
        });
        streams.add(response);
        let stopped = false;
        let blocked = false;
        const emit = (events: ReturnType<typeof subscription.catchUp>) => {
          for (const event of events) {
            const accepted = response.write(
              `event: change\nid: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`,
            );
            current = event.cursor;
            if (!accepted) {
              blocked = true;
              break;
            }
          }
        };
        emit(initial);
        if (!initial.length) response.write(": connected\n\n");
        const timer = setInterval(() => {
          if (stopped || blocked) return;
          try {
            emit(subscription.catchUp(current));
          } catch (error) {
            response.write(`event: error\ndata: ${JSON.stringify(protocolError(error))}\n\n`);
            response.end();
          }
        }, options.pollIntervalMs ?? 25);
        response.on("drain", () => {
          blocked = false;
        });
        response.on("close", () => {
          stopped = true;
          clearInterval(timer);
          subscription.close();
          streams.delete(response);
        });
        return;
      }
      throw Object.assign(new Error(), { code: "NOT_FOUND" });
    })().catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const value = protocolError(error);
      send(response, errorStatus(value), value);
    });
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("API address unavailable");
  url = `http://127.0.0.1:${address.port}`;
  allowed.add(url);
  let closed = false;
  return {
    url,
    server,
    async close() {
      if (closed) return;
      closed = true;
      for (const response of streams) response.end();
      const finished = once(server, "close");
      server.close();
      server.closeIdleConnections();
      await finished;
    },
  };
}
