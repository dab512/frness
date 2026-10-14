import type { DefinitionRef, PackageManifest } from "../../../packages/abi/src/index.js";

export function providerManifest(
  provider: "codex" | "claude",
  meta: (name: string) => DefinitionRef,
  lookup: (packageId: string, name: string) => DefinitionRef,
): PackageManifest {
  const local = (name: string) => ({ local: name });
  return {
    format: 1,
    packageId: `std.agent-${provider}`,
    version: "1.0.1",
    hostAbi: "fractal.host.v1",
    dependencies: [meta("Type"), lookup("std.agent-runtime", "ProviderTransport")],
    reload: { snapshotType: meta("NullSnapshot"), serverEntry: "reload", clientEntry: null },
    exports: Object.fromEntries(
      ["activate", "factory", "suite", "reload"].map((name) => [
        name,
        { path: "server.mjs", exportName: name, environment: "server" as const },
      ]),
    ),
    definitions: [
      {
        name: "Event",
        metaType: meta("Type"),
        value: { schema: { type: "object", additionalProperties: true }, references: {} },
      },
      {
        name: "Configuration",
        metaType: meta("Type"),
        value: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              executable: { type: "string", minLength: 1 },
              model: { type: "string", minLength: 1 },
              ...(provider === "codex"
                ? { sandbox: { enum: ["read-only", "workspace-write"] } }
                : {}),
              environmentBindings: {
                type: "object",
                additionalProperties: { type: "string", minLength: 1 },
              },
            },
          },
          references: {},
        },
      },
      {
        name: "Transport",
        metaType: meta("Implementation"),
        value: {
          contracts: [{ ...lookup("std.agent-runtime", "ProviderTransport") }],
          configurationType: local("Configuration"),
          stateType: { ...meta("NullSnapshot") },
          slots: [],
          entry: "factory",
          abi: "factory.v1",
          requiredCapabilities: ["process"],
        },
      },
    ],
  };
}
