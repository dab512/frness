import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Assembly, PackageManifest } from "../../packages/abi/src/index.js";
import { computeArtifactDigest } from "../../packages/host/src/artifacts.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { resolvePackages } from "../../packages/host/src/references.js";
import { AssemblyLinker } from "../../plugins/meta/src/linker.js";
import { DefinitionRegistry } from "../../plugins/meta/src/registry.js";
import { buildBootstrap } from "../../tools/build-bootstrap.mjs";

test("AT-003 nominal linking rejects invalid compositions before execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frness-linker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildBootstrap(directory);
  const generation = await bootstrap({ directory });
  t.after(() => generation.close());
  const meta = (name: string) => {
    const definition = generation.description.definitions.find((entry) => entry.name === name);
    assert.ok(definition);
    return definition.ref;
  };
  const local = (name: string) => ({ local: name });
  const implementation = (contract: string, slots: unknown[] = []) => ({
    contracts: [local(contract)],
    configurationType: local("Empty"),
    stateType: local("Empty"),
    slots,
    entry: "noop",
    abi: "reducer.v1",
    requiredCapabilities: [],
  });
  const source = {
    format: 1,
    packageId: "test.linker",
    version: "1.0.0",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: {
      noop: { path: "logic.mjs", exportName: "noop", environment: "server" },
      suite: { path: "logic.mjs", exportName: "suite", environment: "server" },
      reload: { path: "logic.mjs", exportName: "reload", environment: "server" },
    },
    definitions: [
      {
        name: "Empty",
        metaType: meta("Type"),
        value: {
          schema: { type: "object", properties: {}, additionalProperties: false, required: [] },
          references: {},
        },
      },
      {
        name: "Text",
        metaType: meta("Type"),
        value: { schema: { type: "string" }, references: {} },
      },
      ...["Echo", "Other"].map((name) => ({
        name,
        metaType: meta("Contract"),
        value: {
          operations: { run: { input: local("Text"), output: local("Text"), errorCodes: [] } },
          conformanceSuite: local(`${name}Suite`),
          allowedEffects: [],
        },
      })),
      ...["Echo", "Other"].map((name) => ({
        name: `${name}Suite`,
        metaType: meta("ConformanceSuite"),
        value: { entry: "suite", targetContract: local(name) },
      })),
      {
        name: "Root",
        metaType: meta("Implementation"),
        value: implementation("Echo", [
          { name: "body", accepts: local("Echo"), collection: "single", min: 1, max: 1 },
          { name: "other", accepts: local("Echo"), collection: "single", min: 0, max: 1 },
        ]),
      },
      { name: "Child", metaType: meta("Implementation"), value: implementation("Echo") },
      { name: "Wrong", metaType: meta("Implementation"), value: implementation("Other") },
      {
        name: "Recursive",
        metaType: meta("Implementation"),
        value: implementation("Echo", [
          { name: "next", accepts: local("Echo"), collection: "single", min: 0, max: 1 },
        ]),
      },
      {
        name: "Ordered",
        metaType: meta("Implementation"),
        value: implementation("Echo", [
          { name: "items", accepts: local("Echo"), collection: "ordered", min: 0, max: 3 },
        ]),
      },
      {
        name: "Keyed",
        metaType: meta("Implementation"),
        value: implementation("Echo", [
          { name: "items", accepts: local("Echo"), collection: "keyed", min: 0, max: 3 },
        ]),
      },
      {
        name: "Restricted",
        metaType: meta("Implementation"),
        value: { ...implementation("Echo"), requiredCapabilities: ["secure.read"] },
      },
    ],
  } as unknown as PackageManifest;
  const path = join(directory, source.packageId);
  await mkdir(path);
  await writeFile(join(path, "manifest.json"), JSON.stringify(source));
  await writeFile(
    join(path, "logic.mjs"),
    'throw new Error("Linking must not execute implementation code");',
  );
  const digest = await computeArtifactDigest(path);
  const description = resolvePackages([...generation.description.packages, { digest, source }]);
  const registry = new DefinitionRegistry({ ...description, availableAbis: generation.abiIds() });
  const ref = (name: string) => ({
    packageId: source.packageId,
    packageVersion: source.version,
    digest,
    name,
  });
  const linker = new AssemblyLinker(registry, meta("Assembly"));
  const assembly: Assembly = {
    assemblyId: "a1",
    revision: "rev1",
    rootInstanceId: "root",
    profile: "volatile.v1",
    instances: [
      {
        instanceId: "root",
        implementation: ref("Root"),
        configuration: {},
        stateNamespaceId: "ns-root",
        scopeId: "scope",
      },
      {
        instanceId: "child",
        implementation: ref("Child"),
        configuration: {},
        stateNamespaceId: "ns-child",
        scopeId: "scope",
      },
    ],
    bindings: [{ parentInstanceId: "root", slot: "body", childInstanceId: "child" }],
  };
  assert.deepEqual(linker.validate(assembly), assembly);
  const error = (expected: string) => (caught: unknown) =>
    caught instanceof Error && "code" in caught && caught.code === expected;
  const wrong = structuredClone(assembly);
  (wrong.instances as Array<Assembly["instances"][number]>)[1] = {
    ...assembly.instances[1]!,
    implementation: ref("Wrong"),
  };
  assert.throws(() => linker.validate(wrong), error("CONTRACT_MISMATCH"));
  const doubled = {
    ...assembly,
    bindings: [
      ...assembly.bindings,
      { parentInstanceId: "root", slot: "other", childInstanceId: "child" },
    ],
  };
  assert.throws(() => linker.validate(doubled), error("MULTIPLE_OWNERS"));
  assert.throws(() => linker.validate({ ...assembly, bindings: [] }), error("SLOT_CARDINALITY"));
  assert.throws(
    () =>
      linker.validate({ ...assembly, bindings: [{ ...assembly.bindings[0]!, slot: "missing" }] }),
    error("UNKNOWN_SLOT"),
  );
  assert.throws(
    () =>
      linker.validate({
        ...assembly,
        instances: [
          ...assembly.instances,
          { ...assembly.instances[1]!, instanceId: "orphan", stateNamespaceId: "ns-orphan" },
        ],
      }),
    error("UNREACHABLE_INSTANCE"),
  );
  const cycle: Assembly = {
    ...assembly,
    instances: assembly.instances.map((instance) => ({
      ...instance,
      implementation: ref("Recursive"),
    })),
    bindings: [
      { parentInstanceId: "root", slot: "next", childInstanceId: "child" },
      { parentInstanceId: "child", slot: "next", childInstanceId: "root" },
    ],
  };
  assert.throws(() => linker.validate(cycle), error("OWNERSHIP_CYCLE"));
  const container = (kind: string): Assembly => ({
    ...assembly,
    instances: [
      { ...assembly.instances[0]!, implementation: ref(kind) },
      assembly.instances[1]!,
      { ...assembly.instances[1]!, instanceId: "child2", stateNamespaceId: "ns-child2" },
    ],
    bindings: [],
  });
  const ordered = {
    ...container("Ordered"),
    bindings: [
      { parentInstanceId: "root", slot: "items", childInstanceId: "child2", order: 1 },
      { parentInstanceId: "root", slot: "items", childInstanceId: "child", order: 0 },
    ],
  };
  assert.deepEqual(linker.validate(ordered), ordered);
  for (const order of [0, 2])
    assert.throws(
      () =>
        linker.validate({
          ...ordered,
          bindings: [{ ...ordered.bindings[0]!, order }, ordered.bindings[1]!],
        }),
      error("DUPLICATE_SLOT_ORDER"),
    );
  const keyed = {
    ...container("Keyed"),
    bindings: [
      { parentInstanceId: "root", slot: "items", childInstanceId: "child", key: "first" },
      { parentInstanceId: "root", slot: "items", childInstanceId: "child2", key: "second" },
    ],
  };
  assert.deepEqual(linker.validate(keyed), keyed);
  assert.throws(
    () =>
      linker.validate({
        ...keyed,
        bindings: [keyed.bindings[0]!, { ...keyed.bindings[1]!, key: "first" }],
      }),
    error("DUPLICATE_SLOT_KEY"),
  );
  const restricted = {
    ...assembly,
    rootInstanceId: "restricted",
    instances: [
      { ...assembly.instances[0]!, instanceId: "restricted", implementation: ref("Restricted") },
    ],
    bindings: [],
  };
  assert.throws(() => linker.validate(restricted), error("CAPABILITY_DENIED"));
  assert.deepEqual(
    new AssemblyLinker(registry, meta("Assembly"), ["secure.read"]).validate(restricted),
    restricted,
  );
  const deep: Assembly = {
    ...assembly,
    rootInstanceId: "n0",
    instances: Array.from({ length: 34 }, (_, index) => ({
      instanceId: `n${index}`,
      implementation: ref("Recursive"),
      configuration: {},
      stateNamespaceId: `ns${index}`,
      scopeId: "scope",
    })),
    bindings: Array.from({ length: 33 }, (_, index) => ({
      parentInstanceId: `n${index}`,
      slot: "next",
      childInstanceId: `n${index + 1}`,
    })),
  };
  assert.throws(() => linker.validate(deep), error("INVALID_INPUT"));
});
