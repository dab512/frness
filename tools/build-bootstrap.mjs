import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { computeArtifactDigest } from "../packages/host/src/artifacts.ts";
import { parseManifest } from "../packages/host/src/validation.ts";
import { seedManifest } from "../plugins/meta/seed/schemas.ts";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function bundle(entry, platform) {
  const result = await build({
    absWorkingDir: project,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform,
    target: "es2022",
    write: false,
    banner:
      platform === "node"
        ? {
            js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
          }
        : {},
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("No bootstrap bundle produced");
  return output.contents;
}

export async function buildBootstrap(directory, options = {}) {
  const meta = parseManifest(options.metaManifest ?? seedManifest());
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length !== 0)
    throw Object.assign(
      new Error("Build into a fresh directory; published artifacts are immutable"),
      { code: "ARTIFACT_DESTINATION_NOT_EMPTY" },
    );
  const lock = { format: 1, hostAbi: "fractal.host.v1", packages: [], activations: [] };
  async function writePackage(manifest, files) {
    const target = resolve(directory, manifest.packageId);
    await mkdir(target, { recursive: true });
    await writeFile(resolve(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const [path, bytes] of Object.entries(files))
      await writeFile(resolve(target, path), bytes);
    const digest = await computeArtifactDigest(target);
    await writeFile(resolve(target, "package.digest"), `${digest}\n`);
    lock.packages.push({ artifactPath: manifest.packageId, digest });
    return digest;
  }
  const metaDigest = await writePackage(meta, {
    "server.mjs": await bundle("plugins/meta/src/server.ts", "node"),
  });
  lock.activations.push({ packageDigest: metaDigest, exportName: "activateMeta" });
  const ref = (name) => ({
    packageId: meta.packageId,
    packageVersion: meta.version,
    digest: metaDigest,
    name,
  });
  const server = await bundle("plugins/meta/src/bridges.ts", "node");
  const client = await bundle("plugins/meta/src/bridges.ts", "browser");
  for (const [suffix, activation] of [
    ["store", "activateStore"],
    ["reducer", "activateReducer"],
    ["effect", "activateEffectAdapter"],
    ["react", "activateReactDescriptor"],
  ]) {
    const isReact = suffix === "react";
    const manifest = {
      format: 1,
      packageId: `std.bridge.${suffix}`,
      version: "1.0.0",
      hostAbi: "fractal.host.v1",
      reload: {
        snapshotType: ref("NullSnapshot"),
        serverEntry: "reload",
        clientEntry: isReact ? "reloadClient" : null,
      },
      dependencies: [ref("Type")],
      definitions: [],
      exports: {
        [activation]: { path: "server.mjs", exportName: activation, environment: "server" },
        reload: { path: "server.mjs", exportName: "reload", environment: "server" },
        ...(isReact
          ? {
              activateReactView: {
                path: "client.mjs",
                exportName: "activateReactView",
                environment: "client",
              },
              reloadClient: { path: "client.mjs", exportName: "reload", environment: "client" },
            }
          : {}),
      },
    };
    const digest = await writePackage(manifest, {
      "server.mjs": server,
      ...(isReact ? { "client.mjs": client } : {}),
    });
    lock.activations.push({ packageDigest: digest, exportName: activation });
    if (isReact) lock.activations.push({ packageDigest: digest, exportName: "activateReactView" });
  }
  for (const factory of options.packages ?? []) {
    const artifact = await factory(ref);
    await writePackage(parseManifest(artifact.manifest), artifact.files);
  }
  await writeFile(resolve(directory, "boot-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const target = resolve(project, process.argv[2] ?? ".frness/bootstrap");
  const lock = await buildBootstrap(target);
  console.log(JSON.stringify({ directory: target, packages: lock.packages.length }, null, 2));
}
