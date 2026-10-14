import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PackageManifest } from "../../packages/abi/src/index.js";
import { computeArtifactDigest } from "../../packages/host/src/artifacts.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { resolvePackages } from "../../packages/host/src/references.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";

test("AT-002 new types validate values without coercion or removing fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildBootstrap(directory);
  const generation = await bootstrap({ directory });
  t.after(() => generation.close());
  const type = generation.description.definitions.find((entry) => entry.name === "Type");
  const snapshot = generation.description.definitions.find(
    (entry) => entry.name === "NullSnapshot",
  );
  assert.ok(type && snapshot);
  const source: PackageManifest = {
    format: 1,
    packageId: "test.documents",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    reload: { snapshotType: snapshot.ref, serverEntry: null, clientEntry: null },
    dependencies: [type.ref],
    exports: {},
    definitions: [
      {
        name: "Document",
        metaType: type.ref,
        value: {
          schema: {
            type: "object",
            properties: { count: { type: "integer", minimum: 0 } },
            required: ["count"],
            additionalProperties: false,
          },
          references: {},
        },
      },
    ],
  };
  const fixture = join(directory, "test.documents");
  await mkdir(fixture);
  await writeFile(join(fixture, "manifest.json"), JSON.stringify(source));
  const digest = await computeArtifactDigest(fixture);
  const registry = new DefinitionRegistry(generation.description);
  registry.install(resolvePackages([...generation.description.packages, { digest, source }]));
  const reference = {
    packageId: source.packageId,
    packageVersion: source.version,
    digest,
    name: "Document",
  };
  registry.validate(reference, { count: 0 });
  for (const value of [{ count: "0" }, { count: 0, extra: true }, { count: null }]) {
    const before = structuredClone(value);
    assert.throws(
      () => registry.validate(reference, value),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_INPUT",
    );
    assert.deepEqual(value, before);
  }
  assert.equal(registry.get(reference).name, "Document");
  const installed = registry.definitions();
  registry.install(resolvePackages([...generation.description.packages, { digest, source }]));
  assert.deepEqual(registry.definitions(), installed);
  const conflictSource = {
    ...source,
    definitions: [
      { ...source.definitions[0]!, value: { schema: { type: "string" }, references: {} } },
    ],
  };
  await writeFile(join(fixture, "manifest.json"), JSON.stringify(conflictSource));
  const conflictDigest = await computeArtifactDigest(fixture);
  assert.throws(
    () =>
      registry.install(
        resolvePackages([
          ...generation.description.packages,
          { digest: conflictDigest, source: conflictSource },
        ]),
      ),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "DEFINITION_CONFLICT",
  );
  assert.deepEqual(registry.definitions(), installed);
  registry.validate(reference, { count: 1 });
  assert.throws(
    () => registry.get({ ...reference, name: "Unknown" }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "PINNED_DEPENDENCY_MISSING",
  );
  const invalidSource: PackageManifest = {
    ...source,
    packageId: "test.invalid",
    definitions: [
      { name: "Valid", metaType: type.ref, value: { schema: { type: "string" }, references: {} } },
      {
        name: "Invalid",
        metaType: type.ref,
        value: { schema: { type: "string", misspelledKeyword: true }, references: {} },
      },
    ],
  };
  const invalidPath = join(directory, "test.invalid");
  await mkdir(invalidPath);
  await writeFile(join(invalidPath, "manifest.json"), JSON.stringify(invalidSource));
  const invalidDigest = await computeArtifactDigest(invalidPath);
  assert.throws(
    () =>
      registry.install(
        resolvePackages([
          ...generation.description.packages,
          { digest: invalidDigest, source: invalidSource },
        ]),
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_INPUT",
  );
  assert.deepEqual(registry.definitions(), installed);
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), () => 1]) {
    assert.throws(
      () => registry.validate(reference, value),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "NON_JSON_VALUE",
    );
  }
  let getterCalls = 0;
  const array: unknown[] = [];
  Object.defineProperty(array, "0", {
    get() {
      getterCalls++;
      return 1;
    },
    enumerable: true,
  });
  assert.throws(
    () => registry.validate(reference, array),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "NON_JSON_VALUE",
  );
  assert.equal(getterCalls, 0);
});
