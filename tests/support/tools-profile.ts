import assert from "node:assert/strict";
import { join } from "node:path";
import { type DaemonProfile, startDaemon } from "../../apps/daemon/src/main.js";
import type {
  ComponentInstance,
  DefinitionRef,
  Json,
  PackageManifest,
} from "../../packages/abi/src/index.js";
import { bootstrap } from "../../packages/host/src/bootstrap.js";
import { toolsManifest } from "../../plugins/tools/definitions/manifest.js";
import { buildRuntime, buildServerModule } from "../../tools/build-runtime.mjs";

export async function toolsProfile(directory: string, root: string) {
  const distribution = join(directory, "tools-distribution");
  await buildRuntime(distribution, {
    packages: [
      async (meta) => ({
        manifest: toolsManifest(meta),
        files: { "server.mjs": await buildServerModule("plugins/tools/src/module.ts") },
        activations: ["activate"],
      }),
      (meta, lookup) => ({
        manifest: {
          format: 1,
          packageId: "test.tool-subagent",
          version: "1.0.0",
          hostAbi: "fractal.host.v1",
          dependencies: [meta("Type"), lookup("std.tools", "Invoke")],
          reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
          exports: Object.fromEntries(
            ["invoke", "reload"].map((entry) => [
              entry,
              { path: "server.mjs", exportName: entry, environment: "server" as const },
            ]),
          ),
          definitions: [
            {
              name: "Text",
              metaType: meta("Type"),
              value: { schema: { type: "string" }, references: {} },
            },
            {
              name: "Nested",
              metaType: meta("Implementation"),
              value: {
                contracts: [{ ...lookup("std.tools", "Invoke") }],
                configurationType: { ...meta("NullSnapshot") },
                stateType: { ...meta("NullSnapshot") },
                slots: [],
                entry: "invoke",
                abi: "reducer.v1",
                requiredCapabilities: [],
              },
            },
          ],
        } satisfies PackageManifest,
        files: {
          "server.mjs": `export const invoke={initialize:()=>null,reduce(state,event){const call=event.value.input;return {state,commands:[{kind:"complete",output:{callId:call.id,ok:true,value:"nested:"+call.arguments,errorCode:null,sources:[]}}]}}}; export const reload={async capture(){return {type:${JSON.stringify(meta("NullSnapshot"))},value:null}},async restore(){},async ready(){},async dispose(){}};`,
        },
      }),
    ],
  });
  const generation = await bootstrap({ directory: distribution });
  const ref = (packageId: string, name: string): DefinitionRef => {
    const found = generation.description.definitions.find(
      (item) => item.ref.packageId === packageId && item.ref.name === name,
    )?.ref;
    assert.ok(found);
    return found;
  };
  const instance = (
    id: string,
    packageId: string,
    name: string,
    configuration: Json,
  ): ComponentInstance => ({
    instanceId: id,
    implementation: ref(packageId, name),
    configuration,
    stateNamespaceId: id,
    scopeId: "scope",
  });
  const spec = (name: string, input: DefinitionRef, output: DefinitionRef) => ({
    name,
    description: name,
    inputType: { ...input },
    outputType: { ...output },
  });
  const tools = [
    spec("read", ref("std.tools", "ReadInput"), ref("std.tools", "FileValue")),
    spec("write", ref("std.tools", "WriteInput"), ref("std.tools", "FileValue")),
    spec("nested", ref("test.tool-subagent", "Text"), ref("test.tool-subagent", "Text")),
  ];
  const profile: DaemonProfile = {
    bootstrapDirectory: distribution,
    dataDirectory: join(directory, "tool-data"),
    principalId: "local",
    credentials: { api: { environment: "TEST_API", instances: ["api"] } },
    filesystems: {
      workspace: { root, access: "read-write", instances: ["read-effect", "write-effect"] },
    },
    grants: {
      api: ["credential"],
      execution: ["profile.application", "local.subject"],
      storage: ["native.sqlite", "data.directory"],
      "read-effect": ["filesystem.root"],
      "write-effect": ["filesystem.root"],
    },
    services: {
      assemblyId: "services",
      revision: "v1",
      profile: "durable.v1",
      rootInstanceId: "api",
      instances: [
        instance("api", "std.api", "HttpServer", {
          port: 0,
          credentialBinding: "api",
          origins: [],
        }),
        instance("execution", "std.execution-backend", "Backend", {
          executionType: { ...ref("std.execution", "Request") },
        }),
        instance("storage", "std.store-sqlite", "Storage", {
          file: "tools.sqlite",
          storeId: "local",
        }),
      ],
      bindings: [
        { parentInstanceId: "api", slot: "backend", childInstanceId: "execution" },
        { parentInstanceId: "execution", slot: "store", childInstanceId: "storage" },
      ],
    },
    application: {
      assemblyId: "tools",
      revision: "v1",
      profile: "durable.v1",
      rootInstanceId: "router",
      instances: [
        instance("router", "std.tools", "Router", { tools }),
        instance("read", "std.tools", "SingleTool", { adapterInstanceId: "read-effect" }),
        instance("write", "std.tools", "SingleTool", { adapterInstanceId: "write-effect" }),
        instance("read-effect", "std.tools", "ReadFile", { filesystemBinding: "workspace" }),
        instance("write-effect", "std.tools", "WriteFile", { filesystemBinding: "workspace" }),
        instance("nested", "test.tool-subagent", "Nested", null),
      ],
      bindings: [
        ...["read", "write", "nested"].map((key) => ({
          parentInstanceId: "router",
          slot: "tools",
          key,
          childInstanceId: key,
        })),
        ...["read", "write"].map((id) => ({
          parentInstanceId: id,
          slot: "adapter",
          childInstanceId: `${id}-effect`,
        })),
      ],
    },
  };
  await generation.close();
  return {
    profile,
    ref,
    start: () => startDaemon(profile, { TEST_API: "tool-profile-test-token" }),
  };
}
