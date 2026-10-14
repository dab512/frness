import type {
  Assembly,
  ContractRef,
  ImplementationDefinition,
} from "../../../packages/abi/src/index.js";
import { bootstrap } from "../../../packages/host/src/bootstrap.js";
import type { BootstrapGeneration } from "../../../packages/host/src/generation.js";
import { AssemblyLinker } from "../../meta/src/linker.js";
import { DefinitionRegistry } from "../../meta/src/registry.js";

export interface StagedAssembly {
  readonly generation: BootstrapGeneration;
  readonly registry: DefinitionRegistry;
  readonly assembly: Assembly;
  readonly directory: string;
}
export interface StageOptions {
  readonly directory: string;
  readonly assembly: Assembly;
  readonly grants: readonly string[];
  readonly knownPackages: ReadonlyMap<string, string>;
  readonly conformance: (
    contract: ContractRef,
    instanceId: string,
    candidate: StagedAssembly,
  ) => Promise<void>;
}

export async function stageAssembly(options: StageOptions): Promise<StagedAssembly> {
  const generation = await bootstrap({
    directory: options.directory,
    knownPackages: options.knownPackages,
  });
  try {
    const registry = new DefinitionRegistry({
      ...generation.description,
      availableAbis: generation.abiIds(),
    });
    const assemblyType = registry
      .definitions()
      .find(
        (definition) =>
          definition.ref.packageId === "std.meta" && definition.ref.name === "Assembly",
      )?.ref;
    if (!assemblyType)
      throw Object.assign(new Error("Missing assembly metatype"), {
        code: "PINNED_DEPENDENCY_MISSING",
      });
    const assembly = new AssemblyLinker(registry, assemblyType, options.grants).validate(
      options.assembly,
    );
    const candidate = Object.freeze({
      generation,
      registry,
      assembly,
      directory: options.directory,
    });
    for (const instance of assembly.instances) {
      const implementation = registry.get(instance.implementation)
        .value as unknown as ImplementationDefinition;
      for (const contract of implementation.contracts)
        await options.conformance(contract, instance.instanceId, candidate);
    }
    return candidate;
  } catch (error) {
    await generation.close();
    throw error;
  }
}
