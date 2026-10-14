import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { computeArtifactDigest } from "../../packages/host/src/artifacts.js";
import { BootstrapManager, bootstrap } from "../../packages/host/src/bootstrap.js";
import { seedManifest } from "../../plugins/meta/seed/schemas.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";

const code = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;

test("AT-001 missing seed fails before importing any module", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-boot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let imports = 0;
  await assert.rejects(
    bootstrap({
      directory,
      importModule: async () => {
        imports++;
        return {};
      },
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "BOOTSTRAP_PACKAGE_MISSING",
  );
  assert.equal(imports, 0);
});

test("AT-001 valid distribution self-validates and registers the four technical bridges", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-valid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = await buildBootstrap(directory);
  const before = await readFile(join(directory, "std.meta/manifest.json"), "utf8");
  const generation = await bootstrap({ directory });
  t.after(() => generation.close());
  assert.deepEqual(generation.abiIds(), [
    "effect-adapter.v1",
    "react-view.v1",
    "reducer.v1",
    "store.v1",
  ]);
  assert.equal(generation.description.definitions.length, 9);
  for (const definition of generation.description.definitions) {
    assert.equal(definition.metaType.name, "Type");
    assert.equal(definition.metaType.digest, lock.packages[0]?.digest);
    assert.equal("local" in definition.metaType, false);
  }
  assert.equal(await readFile(join(directory, "std.meta/manifest.json"), "utf8"), before);
  assert.equal(await computeArtifactDigest(join(directory, "std.meta")), lock.packages[0]?.digest);
  assert.throws(
    () => generation.registration(generation.description.definitions[0]!.ref),
    code("CAPABILITY_DENIED"),
  );
});

test("AT-001 path traversal and symlinks fail before importing code", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-paths-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const digest = `sha256:${"a".repeat(64)}`;
  for (const artifactPath of ["../outside", "/absolute", "a/./b", "C:/escape"]) {
    await writeFile(
      join(directory, "boot-lock.json"),
      JSON.stringify({
        format: 1,
        hostAbi: "fractal.host.v1",
        packages: [{ artifactPath, digest }],
        activations: [{ packageDigest: digest, exportName: "activateMeta" }],
      }),
    );
    await assert.rejects(bootstrap({ directory }), code("INVALID_INPUT"));
  }
  await mkdir(join(directory, "real"));
  await symlink(join(directory, "real"), join(directory, "link"), "dir");
  await writeFile(
    join(directory, "boot-lock.json"),
    JSON.stringify({
      format: 1,
      hostAbi: "fractal.host.v1",
      packages: [{ artifactPath: "link", digest }],
      activations: [{ packageDigest: digest, exportName: "activateMeta" }],
    }),
  );
  await assert.rejects(bootstrap({ directory }), code("INVALID_INPUT"));
});

test("AT-001 unmarked literal local values remain unchanged", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-literal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = seedManifest();
  const extra = {
    name: "Literal",
    metaType: { local: "Type" },
    value: {
      schema: {
        type: "object",
        additionalProperties: true,
        default: { local: "literal-not-a-reference", $ref: "https://literal.invalid" },
      },
      references: {},
    },
  };
  await buildBootstrap(directory, {
    metaManifest: { ...source, definitions: [...source.definitions, extra] },
  });
  const generation = await bootstrap({ directory });
  t.after(() => generation.close());
  const literal = generation.description.definitions.find(
    (definition) => definition.name === "Literal",
  );
  assert.deepEqual((literal?.value as { schema: { default: unknown } }).schema.default, {
    local: "literal-not-a-reference",
    $ref: "https://literal.invalid",
  });
});

test("AT-001 all package digests are checked before the first import", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-all-digests-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildBootstrap(directory);
  await writeFile(join(directory, "std.bridge.react/server.mjs"), "changed");
  let imports = 0;
  await assert.rejects(
    bootstrap({
      directory,
      importModule: async () => {
        imports++;
        return {};
      },
    }),
    code("DIGEST_MISMATCH"),
  );
  assert.equal(imports, 0);
});

test("AT-001 distribution build never overwrites published artifact bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-immutable-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await buildBootstrap(directory);
  await assert.rejects(buildBootstrap(directory), code("ARTIFACT_DESTINATION_NOT_EMPTY"));
  assert.equal(await computeArtifactDigest(join(directory, "std.meta")), first.packages[0]?.digest);
});

test("AT-001 missing local references fail before activation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-local-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = seedManifest();
  await buildBootstrap(directory, {
    metaManifest: { ...source, reload: { ...source.reload, snapshotType: { local: "missing" } } },
  });
  let imports = 0;
  await assert.rejects(
    bootstrap({
      directory,
      importModule: async () => {
        imports++;
        return {};
      },
    }),
    code("PINNED_DEPENDENCY_MISSING"),
  );
  assert.equal(imports, 0);
});

test("AT-001 strict schema compilation rejects unused invalid types", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-invalid-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = seedManifest();
  await buildBootstrap(directory, {
    metaManifest: {
      ...source,
      definitions: [
        ...source.definitions,
        {
          name: "InvalidUnusedType",
          metaType: { local: "Type" },
          value: { schema: { type: "string", misspelledKeyword: true }, references: {} },
        },
      ],
    },
  });
  await assert.rejects(bootstrap({ directory }), code("INVALID_INPUT"));
});

test("AT-001 server never imports client-only activation code", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildBootstrap(directory);
  const generation = await bootstrap({
    directory,
    importModule: async (path) => {
      assert.equal(path.endsWith("client.mjs"), false);
      return import(`${pathToFileURL(path).href}?test=client-boundary`);
    },
  });
  await generation.close();
  assert.equal(generation.hasAbi("store.v1"), false);
  await generation.close();
});

test("AT-001 failed candidate leaves the prior generation published and cleans up in reverse order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildBootstrap(directory);
  const manager = new BootstrapManager();
  const original = await manager.load({ directory });
  t.after(() => original.close());
  const events: string[] = [];
  await assert.rejects(
    manager.load({
      directory,
      importModule: async (path) => {
        const imported = await import(`${pathToFileURL(path).href}?test=rollback`);
        if (path.includes("std.bridge.effect"))
          return {
            ...imported,
            activateEffectAdapter() {
              throw new Error("original-activation-error");
            },
          };
        const result: Record<string, unknown> = { ...imported };
        for (const name of ["activateMeta", "activateStore", "activateReducer"]) {
          if (typeof imported[name] !== "function") continue;
          result[name] = (host: unknown) => {
            const cleanup = imported[name](host);
            return async () => {
              events.push(name);
              await cleanup();
              if (name === "activateStore") throw new Error("cleanup-error");
            };
          };
        }
        return result;
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "DEPENDENCY_UNAVAILABLE" &&
      error.cause instanceof Error &&
      error.cause.message === "original-activation-error",
  );
  assert.equal(manager.active, original);
  assert.deepEqual(events, ["activateReducer", "activateStore", "activateMeta"]);
  assert.equal(original.hasAbi("store.v1"), true);
});

test("AT-001 package identity cannot change bytes in an existing manager", async (t) => {
  const first = await mkdtemp(join(tmpdir(), "frness-identity-a-"));
  const second = await mkdtemp(join(tmpdir(), "frness-identity-b-"));
  t.after(async () => {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  });
  await buildBootstrap(first);
  const source = seedManifest();
  await buildBootstrap(second, {
    metaManifest: {
      ...source,
      definitions: [
        ...source.definitions,
        {
          name: "NewType",
          metaType: { local: "Type" },
          value: { schema: { type: "string" }, references: {} },
        },
      ],
    },
  });
  const manager = new BootstrapManager();
  const previous = await manager.load({ directory: first });
  t.after(() => previous.close());
  let imports = 0;
  await assert.rejects(
    manager.load({
      directory: second,
      importModule: async () => {
        imports++;
        return {};
      },
    }),
    code("DEFINITION_CONFLICT"),
  );
  assert.equal(imports, 0);
  assert.equal(manager.active, previous);
});

test("AT-001 wrong digest wins over an invalid manifest and imports no code", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "pkg"));
  await writeFile(join(directory, "pkg/manifest.json"), "not-json");
  const digest = await computeArtifactDigest(join(directory, "pkg"));
  await writeFile(join(directory, "pkg/manifest.json"), "changed-invalid-json");
  await writeFile(
    join(directory, "boot-lock.json"),
    JSON.stringify({
      format: 1,
      hostAbi: "fractal.host.v1",
      packages: [{ artifactPath: "pkg", digest }],
      activations: [{ packageDigest: digest, exportName: "activateMeta" }],
    }),
  );
  let imports = 0;
  await assert.rejects(
    bootstrap({
      directory,
      importModule: async () => {
        imports++;
        return {};
      },
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DIGEST_MISMATCH",
  );
  assert.equal(imports, 0);
});
