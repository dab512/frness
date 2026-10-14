import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { BootstrapDescription } from "../../../packages/abi/src/bootstrap.js";
import type {
  CapabilityBoundExport,
  DefinitionReader,
  FactoryContext,
  NativeFactory,
  NativeService,
} from "../../../packages/abi/src/factory.js";
import type {
  Assembly,
  DefinitionRef,
  ImplementationDefinition,
} from "../../../packages/abi/src/index.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import { bootstrap } from "../../../packages/host/src/bootstrap.js";
import { protocolError } from "../../../plugins/api/src/protocol.js";
import type { AssemblyLinker } from "../../../plugins/meta/src/linker.js";
import type { DefinitionRegistry } from "../../../plugins/meta/src/registry.js";

export interface DaemonProfile {
  readonly bootstrapDirectory: string;
  readonly dataDirectory: string;
  readonly services: Assembly;
  readonly application?: Assembly;
  readonly principalId: string;
  readonly grants: Readonly<Record<string, readonly string[]>>;
  readonly credentials: Readonly<
    Record<string, { readonly environment: string; readonly instances: readonly string[] }>
  >;
  readonly filesystems?: Readonly<
    Record<
      string,
      {
        readonly root: string;
        readonly access: "read" | "read-write";
        readonly instances: readonly string[];
      }
    >
  >;
}
export async function startDaemon(
  profile: DaemonProfile,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const generation = await bootstrap({ directory: profile.bootstrapDirectory });
  const cleanup: NativeService[] = [];
  try {
    const meta = generation.description.packages[0];
    if (!meta) throw new Error("Missing meta package");
    const Registry = generation.getExport(meta.digest, "DefinitionRegistry") as new (
      description: BootstrapDescription,
    ) => DefinitionRegistry;
    const Linker = generation.getExport(meta.digest, "AssemblyLinker") as typeof AssemblyLinker;
    const registry: DefinitionReader = new Registry({
      ...generation.description,
      availableAbis: generation.abiIds(),
    });
    const assemblyType = meta.definitions.find((definition) => definition.name === "Assembly")!.ref;
    const grants = [...new Set(Object.values(profile.grants).flat())];
    const services = new Linker(registry as DefinitionRegistry, assemblyType, grants).validate(
      profile.services,
    );
    const application = profile.application
      ? new Linker(registry as DefinitionRegistry, assemblyType, grants).validate(
          profile.application,
        )
      : undefined;
    await mkdir(profile.dataDirectory, { recursive: true });
    const instances = new Map<string, NativeService>();
    const implementation = (ref: DefinitionRef) =>
      registry.get(ref).value as unknown as ImplementationDefinition;
    const capability = (id: string, name: string): unknown => {
      if (!(profile.grants[id] ?? []).includes(name))
        throw Object.assign(new Error("Capability is not granted"), { code: "CAPABILITY_DENIED" });
      if (name === "native.sqlite") return Database;
      if (name === "data.directory") return resolve(profile.dataDirectory);
      if (name === "profile.application") return application;
      if (name === "local.subject") return { principalId: profile.principalId, grants };
      if (name === "network") return fetch;
      if (name === "filesystem.root")
        return (binding: string) => {
          const source = profile.filesystems?.[binding];
          if (!source?.instances.includes(id) || !["read", "read-write"].includes(source.access))
            throw Object.assign(new Error("Filesystem binding unavailable"), {
              code: "CAPABILITY_DENIED",
            });
          return { root: source.root, access: source.access };
        };
      if (name === "credential")
        return (binding: string) => {
          const source = profile.credentials[binding];
          const value = source?.instances.includes(id)
            ? environment[source.environment]
            : undefined;
          if (!value)
            throw Object.assign(new Error("Credential binding unavailable"), {
              code: "CAPABILITY_DENIED",
            });
          return value;
        };
      throw Object.assign(new Error("Unknown capability"), { code: "CAPABILITY_DENIED" });
    };
    const boundExports = new Map<string, unknown>();
    const exported = (ref: DefinitionRef, instanceId?: string) => {
      const definition = implementation(ref);
      const value = generation.getExport(ref.digest, definition.entry);
      if (instanceId === undefined) return value;
      const instance = application?.instances.find((item) => item.instanceId === instanceId);
      if (
        !instance ||
        definitionKey(instance.implementation) !== definitionKey(ref) ||
        definition.requiredCapabilities.some(
          (name) => !(profile.grants[instanceId] ?? []).includes(name),
        )
      )
        throw Object.assign(new Error("Application capability missing"), {
          code: "CAPABILITY_DENIED",
        });
      const key = JSON.stringify([instanceId, definitionKey(ref)]);
      if (boundExports.has(key)) return boundExports.get(key);
      const decorator = value as Partial<CapabilityBoundExport>;
      const bound =
        typeof decorator.bindCapabilities === "function"
          ? decorator.bindCapabilities({
              registry,
              capability: (name) => capability(instanceId, name),
            })
          : value;
      generation.validateExport(definition.abi, bound);
      boundExports.set(key, bound);
      return bound;
    };
    const instantiate = async (id: string): Promise<NativeService> => {
      const existing = instances.get(id);
      if (existing) return existing;
      const instance = services.instances.find((instance) => instance.instanceId === id)!;
      const definition = implementation(instance.implementation);
      const effective = profile.grants[id] ?? [];
      if (definition.requiredCapabilities.some((name) => !effective.includes(name)))
        throw Object.assign(new Error("Service capability missing"), { code: "CAPABILITY_DENIED" });
      const children = services.bindings.filter((binding) => binding.parentInstanceId === id);
      for (const binding of children) await instantiate(binding.childInstanceId);
      const context: FactoryContext = {
        instance,
        assemblyRevision: services.revision,
        registry,
        implementation: instance.implementation,
        exported,
        child(slot) {
          const bindings = children.filter((binding) => binding.slot === slot);
          if (bindings.length !== 1)
            throw Object.assign(new Error("Expected a single child service"), {
              code: "SLOT_CARDINALITY",
            });
          return instances.get(bindings[0]!.childInstanceId)!.value;
        },
        children(slot) {
          if (!definition.slots.some((entry) => entry.name === slot))
            throw Object.assign(new Error("Unknown slot"), { code: "UNKNOWN_SLOT" });
          return children
            .filter((binding) => binding.slot === slot)
            .map((binding) => instances.get(binding.childInstanceId)!.value);
        },
        capability: (name) => capability(id, name),
      };
      const factory = exported(instance.implementation) as NativeFactory;
      if (definition.abi !== "factory.v1")
        throw Object.assign(new Error("Service does not expose a factory"), {
          code: "UNKNOWN_ABI",
        });
      const service = await factory.create(context);
      if (!service || typeof service.dispose !== "function")
        throw Object.assign(new Error("Invalid native service"), { code: "INVALID_OUTPUT" });
      instances.set(id, service);
      cleanup.push(service);
      return service;
    };
    const root = await instantiate(services.rootInstanceId);
    let closed = false;
    return {
      value: root.value,
      generation,
      service(id: string): unknown {
        const service = instances.get(id);
        if (!service)
          throw Object.assign(new Error("Service is not installed"), { code: "NOT_FOUND" });
        return service.value;
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const service of cleanup.reverse()) await service.dispose();
        await generation.close();
      },
    };
  } catch (error) {
    for (const service of cleanup.reverse()) await service.dispose();
    await generation.close();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.argv[2];
    if (!path) throw Object.assign(new Error("Profile file required"), { code: "INVALID_INPUT" });
    const profile = JSON.parse(await readFile(resolve(path), "utf8")) as DaemonProfile;
    const daemon = await startDaemon(profile);
    process.stdout.write(
      `${JSON.stringify({ ready: true, url: (daemon.value as { url: string }).url })}\n`,
    );
    const stop = () => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(protocolError(error))}\n`);
    process.exitCode = 1;
  }
}
