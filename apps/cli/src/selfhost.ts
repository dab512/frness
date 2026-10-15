import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import { bootstrap } from "../../../packages/host/src/bootstrap.js";
import type { ApiBackend } from "../../../plugins/api/src/protocol.js";
import { objectRef } from "../../../plugins/api/src/protocol.js";
import type { DefinitionRef, ObjectRef } from "../../../specs/fractal-harness/contracts.js";
import { buildCli } from "../../../tools/build-cli.mjs";
import { type DaemonProfile, startDaemon } from "../../daemon/src/main.js";
import { workspaceLease } from "./lease.js";

export interface SelfhostExtension {
  packages: NonNullable<Parameters<typeof buildCli>[1]>["packages"];
  extend(input: {
    profile: DaemonProfile;
    ref: (packageId: string, name: string) => DefinitionRef;
  }): DaemonProfile;
}
export interface SelfhostOptions {
  workspace: string;
  provider: "codex" | "claude";
  prompt: string;
  executable?: string;
  mode?: "default" | "workspace";
  extension?: SelfhostExtension;
  session?: ObjectRef;
  signal?: AbortSignal;
  output?: (text: string) => void;
  profile?: DaemonProfile;
}
export async function prepareSelfhost(options: SelfhostOptions): Promise<DaemonProfile> {
  const workspace = resolve(options.workspace);
  const directory = join(workspace, ".frness", "selfhost");
  await mkdir(join(directory, "builds"), { recursive: true });
  const distribution = await mkdtemp(join(directory, "builds", "run-"));
  await buildCli(distribution, {
    providers: [options.provider],
    ...(options.extension?.packages ? { packages: options.extension.packages } : {}),
  });
  const generation = await bootstrap({ directory: distribution });
  const ref = (packageId: string, name: string) => {
    const result = generation.description.definitions.find(
      (entry) => entry.ref.packageId === packageId && entry.ref.name === name,
    )?.ref;
    if (!result) throw new Error(`Missing definition ${packageId}/${name}`);
    return result;
  };
  let profile: DaemonProfile;
  try {
    profile = {
      bootstrapDirectory: distribution,
      dataDirectory: join(directory, "data"),
      principalId: "local",
      credentials: {},
      grants: {
        cli: ["local.subject"],
        storage: ["native.sqlite", "data.directory"],
        provider: ["process"],
      },
      services: {
        assemblyId: "selfhost",
        revision: "pending",
        profile: "durable.v1",
        rootInstanceId: "cli",
        instances: [
          {
            instanceId: "cli",
            implementation: ref("std.agent-runtime", "Backend"),
            configuration: { workspace },
            stateNamespaceId: "cli",
            scopeId: "local",
          },
          {
            instanceId: "storage",
            implementation: ref("std.store-sqlite", "Storage"),
            configuration: { file: "cli.sqlite", storeId: "cli" },
            stateNamespaceId: "storage",
            scopeId: "local",
          },
          {
            instanceId: "provider",
            implementation: ref(`std.agent-${options.provider}`, "Transport"),
            configuration: {
              ...(options.executable ? { executable: options.executable } : {}),
              ...(options.mode && options.provider === "codex" ? { mode: options.mode } : {}),
            },
            stateNamespaceId: "provider",
            scopeId: "local",
          },
        ],
        bindings: [
          { parentInstanceId: "cli", slot: "store", childInstanceId: "storage" },
          { parentInstanceId: "cli", slot: "transport", childInstanceId: "provider" },
        ],
      },
    };
    if (options.extension) profile = options.extension.extend({ profile, ref });
    profile = {
      ...profile,
      services: {
        ...profile.services,
        revision: createHash("sha256").update(canonicalJson(profile.services)).digest("hex"),
      },
    };
  } finally {
    await generation.close();
  }
  return profile;
}
export async function selfhost(options: SelfhostOptions) {
  const release = await workspaceLease(options.workspace);
  let result;
  try {
    result = await runSelfhost(options);
  } finally {
    await release();
  }
  const { applyPendingPlugin } = await import("./plugins.js");
  const pluginUpdate =
    result.phase === "completed" ? await applyPendingPlugin(options.workspace) : null;
  return { ...result, pluginUpdate };
}
async function runSelfhost(options: SelfhostOptions) {
  let installed: DaemonProfile | undefined;
  if (!options.extension && !options.profile) {
    try {
      installed = JSON.parse(
        await readFile(join(resolve(options.workspace), ".frness/plugins/active.json"), "utf8"),
      ).profiles[options.provider];
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (options.mode && options.provider !== "codex" && options.mode !== "default")
    throw new Error("Unsupported provider mode");
  let profile = options.profile ?? installed ?? (await prepareSelfhost(options));
  if ((options.mode && options.provider === "codex") || options.executable) {
    const services = {
      ...profile.services,
      instances: profile.services.instances.map((item) =>
        item.instanceId === "provider"
          ? {
              ...item,
              configuration: {
                ...(item.configuration as Record<string, string>),
                ...(options.mode && options.provider === "codex" ? { mode: options.mode } : {}),
                ...(options.executable ? { executable: options.executable } : {}),
              },
            }
          : item,
      ),
    };
    profile = {
      ...profile,
      services: {
        ...services,
        revision: createHash("sha256").update(canonicalJson(services)).digest("hex"),
      },
    };
  }
  const directory = join(resolve(options.workspace), ".frness", "selfhost");
  const implementation = profile.services.instances.find(
    (item) => item.instanceId === "cli",
  )!.implementation;
  const ref = (_packageId: string, name: string) => ({ ...implementation, name });
  const daemon = await startDaemon(profile);
  const backend = daemon.value as ApiBackend & { idle(): Promise<void> };
  try {
    options.signal?.throwIfAborted();
    const receipt = await backend.invoke({
      targetInstanceId: "cli",
      assemblyRevision: profile.services.revision,
      operation: { contract: ref("std.agent-runtime", "Runner"), operation: "run" },
      input: JSON.parse(
        JSON.stringify({
          prompt: options.prompt,
          ...(options.session ? { session: options.session } : {}),
        }),
      ),
      idempotencyKey: randomUUID(),
    });
    let interrupted = false;
    let emitted = "";
    for (;;) {
      if (options.signal?.aborted && !interrupted) {
        interrupted = true;
        await backend.invoke({
          targetInstanceId: "cli",
          assemblyRevision: profile.services.revision,
          operation: { contract: ref("std.agent-runtime", "Runner"), operation: "interrupt" },
          input: JSON.parse(JSON.stringify({ turn: receipt.invocation })),
          idempotencyKey: randomUUID(),
        });
      }
      const turn = (await backend.read(receipt.invocation)).value as unknown as {
        phase: string;
        text: string;
        result: string | null;
        session: ObjectRef;
      };
      const text = turn.result ?? turn.text;
      if (text.startsWith(emitted)) options.output?.(text.slice(emitted.length));
      emitted = text;
      if (!["queued", "running"].includes(turn.phase)) {
        await backend.idle();
        const result = { receipt, session: turn.session, phase: turn.phase, text };
        const temporary = join(directory, `result-${randomUUID()}.json`);
        await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, join(directory, "last-run.json"));
        return result;
      }
      await setTimeout(25);
    }
  } finally {
    await daemon.close();
  }
}

export async function selfhostCli(args: string[]) {
  const flags = new Map<string, string>();
  const allowed = new Set([
    "workspace",
    "provider",
    "prompt-file",
    "executable",
    "extension",
    "session-file",
    "mode",
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    const value = args[i + 1];
    if (
      !args[i]?.startsWith("--") ||
      !key ||
      !allowed.has(key) ||
      flags.has(key) ||
      value === undefined
    )
      throw new Error("Invalid selfhost arguments");
    flags.set(key, value);
  }
  const provider = flags.get("provider") ?? "codex";
  if (provider !== "codex" && provider !== "claude") throw new Error("Invalid provider");
  const mode = flags.get("mode");
  if (mode && !["default", "workspace"].includes(mode)) throw new Error("Invalid provider mode");
  const promptFile = flags.get("prompt-file");
  if (!promptFile) throw new Error("--prompt-file is required");
  const extensionPath = flags.get("extension");
  const extension = extensionPath
    ? ((await import(pathToFileURL(resolve(extensionPath)).href)).default as SelfhostExtension)
    : undefined;
  const sessionFile = flags.get("session-file");
  const session = sessionFile
    ? objectRef(JSON.parse(await readFile(sessionFile, "utf8")).session)
    : undefined;
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.on("SIGINT", interrupt);
  try {
    const result = await selfhost({
      workspace: flags.get("workspace") ?? process.cwd(),
      provider,
      ...(mode ? { mode: mode as "default" | "workspace" } : {}),
      prompt: await readFile(promptFile, "utf8"),
      ...(extension ? { extension } : {}),
      ...(session ? { session } : {}),
      ...(flags.get("executable") ? { executable: flags.get("executable")! } : {}),
      signal: abort.signal,
      output: (text) => process.stdout.write(text),
    });
    process.stderr.write(`\nFRNESS: ${result.phase}; .frness/selfhost/last-run.json\n`);
    if (result.pluginUpdate)
      process.stderr.write(
        `Plugins: ${result.pluginUpdate.ok ? result.pluginUpdate.revision : result.pluginUpdate.message}\n`,
      );
    if (result.phase !== "completed" || result.pluginUpdate?.ok === false) process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await selfhostCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Selfhost failed"}\n`);
    process.exitCode = 1;
  }
}
