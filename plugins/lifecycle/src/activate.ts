import { canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  Assembly,
  DefinitionRef,
  ExecutionContext,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
} from "../../../specs/fractal-harness/contracts.js";
import { type StagedAssembly, type StageOptions, stageAssembly } from "./install.js";

export interface LifecycleState {
  active: string;
  assemblies: Record<string, Assembly>;
  disabled: string[];
  packages: Record<string, { digest: string; directory: string }>;
  pins: Record<string, string[]>;
}
export const packageKey = (ref: Pick<DefinitionRef, "packageId" | "packageVersion">): string =>
  JSON.stringify([ref.packageId, ref.packageVersion]);
export const assemblyKey = (assembly: Assembly): string =>
  JSON.stringify([assembly.assemblyId, assembly.revision]);
export function stateValue(state: LifecycleState): Json {
  return JSON.parse(canonicalJson(state)) as Json;
}

export class LifecycleManager {
  #staged = new WeakSet<StagedAssembly>();
  #retained = new Set<StagedAssembly>();
  #current: StagedAssembly | undefined;
  constructor(
    readonly store: ObjectStore,
    readonly context: ExecutionContext,
    readonly head: ObjectRef,
  ) {}
  async state(): Promise<{ record: ObjectRecord; value: LifecycleState } | undefined> {
    try {
      const record = await this.store.read(this.context, this.head);
      return { record, value: record.value as unknown as LifecycleState };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }
  async knownPackages(): Promise<ReadonlyMap<string, string>> {
    const state = await this.state();
    return new Map(
      Object.entries(state?.value.packages ?? {}).map(([key, value]) => [key, value.digest]),
    );
  }
  async stage(options: Omit<StageOptions, "knownPackages">): Promise<StagedAssembly> {
    const candidate = await stageAssembly({
      ...options,
      knownPackages: await this.knownPackages(),
    });
    this.#staged.add(candidate);
    this.#retained.add(candidate);
    return candidate;
  }
  async close(): Promise<void> {
    for (const candidate of this.#retained) await candidate.generation.close();
    this.#retained.clear();
    this.#staged = new WeakSet();
    this.#current = undefined;
  }
  async activate(
    candidate: StagedAssembly,
    expectedRevision: string | null,
    commitKey: string,
  ): Promise<void> {
    if (!this.#staged.has(candidate))
      throw Object.assign(new Error("Candidate is not staged"), { code: "CAPABILITY_DENIED" });
    const previous = await this.state();
    if ((previous?.record.revision ?? null) !== expectedRevision)
      throw Object.assign(new Error("Active assembly changed"), { code: "REVISION_CONFLICT" });
    const value: LifecycleState = previous?.value ?? {
      active: "",
      assemblies: {},
      disabled: [],
      packages: {},
      pins: {},
    };
    const key = assemblyKey(candidate.assembly);
    const existing = value.assemblies[key];
    if (existing && canonicalJson(existing) !== canonicalJson(candidate.assembly))
      throw Object.assign(new Error("Assembly revision is immutable"), {
        code: "DEFINITION_CONFLICT",
      });
    for (const owner of candidate.generation.description.packages) {
      const id = JSON.stringify([owner.source.packageId, owner.source.version]);
      if (value.packages[id] && value.packages[id]?.digest !== owner.digest)
        throw Object.assign(new Error("Published package version is immutable"), {
          code: "DEFINITION_CONFLICT",
        });
      value.packages[id] = { digest: owner.digest, directory: candidate.directory };
    }
    value.assemblies[key] = candidate.assembly;
    value.active = key;
    await this.store.commit(this.context, {
      commitKey,
      readSet: [],
      events: [],
      writes: [
        previous
          ? {
              kind: "replace",
              object: this.head,
              expectedRevision: previous.record.revision,
              value: stateValue(value),
            }
          : { kind: "create", object: this.head, value: stateValue(value) },
      ],
    });
    this.#current = candidate;
    this.#staged.delete(candidate);
  }
  async disable(packageId: string, commitKey: string): Promise<void> {
    const state = await this.state();
    if (!state)
      throw Object.assign(new Error("Lifecycle is not initialized"), { code: "NOT_FOUND" });
    if (!state.value.disabled.includes(packageId)) state.value.disabled.push(packageId);
    await this.store.commit(this.context, {
      commitKey,
      readSet: [],
      events: [],
      writes: [
        {
          kind: "replace",
          object: this.head,
          expectedRevision: state.record.revision,
          value: stateValue(state.value),
        },
      ],
    });
  }
  async assertEnabled(ref: DefinitionRef): Promise<void> {
    const state = await this.state();
    if (state?.value.disabled.includes(ref.packageId))
      throw Object.assign(new Error("Package is disabled"), { code: "PLUGIN_DISABLED" });
    if (state?.value.packages[packageKey(ref)]?.digest !== ref.digest)
      throw Object.assign(new Error("Pinned package is missing"), {
        code: "PINNED_DEPENDENCY_MISSING",
      });
  }
  get current(): StagedAssembly | undefined {
    return this.#current;
  }
}
