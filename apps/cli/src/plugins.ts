import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startDaemon } from "../../daemon/src/main.js";
import { workspaceLease } from "./lease.js";
import { prepareSelfhost, type SelfhostExtension } from "./selfhost.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export async function scaffoldPlugin(id: string) {
  if (!/^[a-z][a-z0-9-]{0,48}$/.test(id)) throw new Error("Plugin id must be a lowercase slug");
  const directory = join(root, "extensions", id);
  await mkdir(directory, { recursive: true });
  for (const name of ["manifest.ts", "module.ts", "extension.ts"]) {
    const source = await readFile(join(root, "tools/plugin-template", name), "utf8");
    await writeFile(join(directory, name), source.replaceAll("TEMPLATE", id), { flag: "wx" });
  }
  return join(directory, "extension.ts");
}
async function identities(directory: string) {
  const lock = JSON.parse(await readFile(join(directory, "boot-lock.json"), "utf8"));
  return Promise.all(
    lock.packages.map(async (item: { artifactPath: string; digest: string }) => {
      const manifest = JSON.parse(
        await readFile(join(directory, item.artifactPath, "manifest.json"), "utf8"),
      );
      return { key: JSON.stringify([manifest.packageId, manifest.version]), digest: item.digest };
    }),
  );
}
export async function activePlugin(workspace: string) {
  try {
    return JSON.parse(
      await readFile(join(resolve(workspace), ".frness/plugins/active.json"), "utf8"),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function installPlugin(
  workspace: string,
  source: string,
  executables: Partial<Record<"codex" | "claude", string>> = {},
) {
  const release = await workspaceLease(workspace);
  try {
    const previous = await activePlugin(workspace);
    const known = new Map<string, string>(Object.entries(previous?.knownPackages ?? {}));
    if (previous)
      for (const profile of Object.values(previous.profiles) as Awaited<
        ReturnType<typeof prepareSelfhost>
      >[]) {
        for (const item of await identities(profile.bootstrapDirectory))
          known.set(item.key, item.digest);
      }
    const extension = (await import(pathToFileURL(resolve(source)).href))
      .default as SelfhostExtension;
    if (!extension || !Array.isArray(extension.packages) || typeof extension.extend !== "function")
      throw new Error("Invalid SelfhostExtension");
    const profiles = {} as Record<"codex" | "claude", Awaited<ReturnType<typeof prepareSelfhost>>>;
    // No active invocation may share these stores: desktop serializes install and run.
    for (const provider of ["codex", "claude"] as const) {
      const profile = await prepareSelfhost({
        workspace,
        provider,
        prompt: "",
        extension,
        ...(executables[provider] ? { executable: executables[provider] } : {}),
      });
      for (const item of await identities(profile.bootstrapDirectory))
        if (known.has(item.key) && known.get(item.key) !== item.digest)
          throw new Error("DEFINITION_CONFLICT: bump package version when changing bytes");
      for (const item of await identities(profile.bootstrapDirectory))
        known.set(item.key, item.digest);
      const candidate = await startDaemon(profile);
      await candidate.close();
      profiles[provider] = profile;
    }
    const result = {
      revision: randomUUID(),
      source: resolve(source),
      profiles,
      knownPackages: Object.fromEntries(known),
    };
    const target = join(resolve(workspace), ".frness/plugins/active.json");
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${result.revision}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return result;
  } finally {
    await release();
  }
}
export async function requestPlugin(workspace: string, source: string) {
  const path = join(resolve(workspace), ".frness/plugins/pending.json");
  await mkdir(dirname(path), { recursive: true });
  const request = { requestId: randomUUID(), source: resolve(source) };
  const temporary = `${path}.${request.requestId}.tmp`;
  await writeFile(temporary, JSON.stringify(request), { mode: 0o600 });
  await rename(temporary, path);
  return request;
}
export async function applyPendingPlugin(workspace: string) {
  const directory = join(resolve(workspace), ".frness/plugins");
  const processing = join(directory, `processing-${randomUUID()}.json`);
  try {
    await rename(join(directory, "pending.json"), processing);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let receipt;
  try {
    const request = JSON.parse(await readFile(processing, "utf8"));
    const result = await installPlugin(
      workspace,
      request.source,
      process.env.FRNESS_AGENT_EXECUTABLE
        ? {
            codex: process.env.FRNESS_AGENT_EXECUTABLE,
            claude: process.env.FRNESS_AGENT_EXECUTABLE,
          }
        : {},
    );
    receipt = {
      ok: true as const,
      requestId: request.requestId,
      source: result.source,
      revision: result.revision,
      assembly: result.profiles.codex.services,
    };
  } catch (error) {
    receipt = {
      ok: false as const,
      message: error instanceof Error ? error.message : "Plugin install failed",
    };
  }
  await writeFile(processing, JSON.stringify(receipt));
  await rename(processing, join(directory, "last-update.json"));
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, value, workspace = process.cwd()] = process.argv.slice(2);
    if (command === "scaffold" && value) console.log(await scaffoldPlugin(value));
    else if (command === "install" && value)
      console.log(
        JSON.stringify(
          await installPlugin(
            workspace,
            value,
            process.env.FRNESS_AGENT_EXECUTABLE
              ? {
                  codex: process.env.FRNESS_AGENT_EXECUTABLE,
                  claude: process.env.FRNESS_AGENT_EXECUTABLE,
                }
              : {},
          ),
        ),
      );
    else if (command === "request" && value)
      console.log(JSON.stringify(await requestPlugin(workspace, value)));
    else if (command === "status")
      console.log(JSON.stringify(await activePlugin(value ?? process.cwd())));
    else
      throw new Error(
        "Usage: npm run plugin -- scaffold ID | install EXTENSION [WORKSPACE] | request EXTENSION [WORKSPACE] | status [WORKSPACE]",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
