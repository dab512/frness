import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { invocationRequest, objectRef, protocolError } from "../../../plugins/api/src/protocol.js";

function argumentsMap(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined || result.has(name.slice(2)))
      throw Object.assign(new Error("Invalid CLI arguments"), { code: "INVALID_INPUT" });
    result.set(name.slice(2), value);
  }
  return result;
}
export async function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const command = args[0];
  const flags = argumentsMap(args.slice(1));
  const known = new Set([
    "endpoint",
    "instance",
    "assembly-revision",
    "contract",
    "contract-file",
    "operation",
    "input-file",
    "key",
    "ref-file",
    "namespace",
    "cursor",
  ]);
  if (
    [...flags.keys()].some((name) => !known.has(name)) ||
    (flags.has("contract") && flags.has("contract-file"))
  )
    throw Object.assign(new Error("Unknown or conflicting CLI flag"), { code: "INVALID_INPUT" });
  const endpoint = new URL(
    flags.get("endpoint") ?? environment.FRNESS_URL ?? "http://127.0.0.1:7600",
  );
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  )
    throw Object.assign(new Error(), { code: "INVALID_INPUT" });
  const token = environment.FRNESS_API_TOKEN;
  if (!token) throw Object.assign(new Error(), { code: "CAPABILITY_DENIED" });
  const headers = {
    authorization: `Bearer ${token}`,
    origin: endpoint.origin,
    "content-type": "application/json",
  };
  const required = (name: string) => {
    const value = flags.get(name);
    if (!value) throw Object.assign(new Error(`Missing --${name}`), { code: "INVALID_INPUT" });
    return value;
  };
  let response: Response;
  if (command === "invoke") {
    const request = invocationRequest({
      targetInstanceId: required("instance"),
      assemblyRevision: required("assembly-revision"),
      operation: {
        contract: JSON.parse(
          flags.get("contract") ?? (await readFile(required("contract-file"), "utf8")),
        ),
        operation: required("operation"),
      },
      input: JSON.parse(await readFile(required("input-file"), "utf8")),
      idempotencyKey: required("key"),
    });
    response = await fetch(new URL("/v1/invoke", endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
  } else if (command === "inspect") {
    const ref = objectRef(JSON.parse(await readFile(required("ref-file"), "utf8")));
    response = await fetch(
      new URL(`/v1/objects/read?ref=${encodeURIComponent(JSON.stringify(ref))}`, endpoint),
      { headers },
    );
  } else if (command === "observe") {
    response = await fetch(
      new URL(
        `/v1/events?namespaceId=${encodeURIComponent(required("namespace"))}&cursor=${encodeURIComponent(required("cursor"))}`,
        endpoint,
      ),
      { headers },
    );
    if (response.ok && response.body) {
      for await (const chunk of response.body) process.stdout.write(chunk);
      return undefined;
    }
  } else throw Object.assign(new Error("Unknown command"), { code: "INVALID_INPUT" });
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    const error = value as { code?: string };
    throw Object.assign(new Error("API rejected the operation"), {
      code: error.code ?? "DEPENDENCY_UNAVAILABLE",
    });
  }
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(protocolError(error))}\n`);
    process.exitCode = 1;
  }
}
