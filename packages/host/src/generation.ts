import type {
  AbiAdapter,
  BootstrapDescription,
  BootstrapRegistrationHost,
  ExportValidation,
} from "../../abi/src/bootstrap.js";
import type { DefinitionRef } from "../../abi/src/index.js";
import { HostError } from "./errors.js";

export type Cleanup = () => void | Promise<void>;
export class BootstrapGeneration {
  readonly generationId: string;
  readonly description: BootstrapDescription;
  readonly cleanupErrors: unknown[] = [];
  #validators = new Map<
    string,
    (description: BootstrapDescription) => readonly ExportValidation[] | undefined
  >();
  #abis = new Map<string, AbiAdapter>();
  #cleanups: Cleanup[] = [];
  #closed = false;
  #published = false;

  constructor(generationId: string, description: BootstrapDescription) {
    this.generationId = generationId;
    this.description = description;
  }

  registration(snapshotType: DefinitionRef): {
    readonly host: BootstrapRegistrationHost;
    readonly seal: () => void;
  } {
    if (this.#published || this.#closed)
      throw new HostError("CAPABILITY_DENIED", "Generation cannot accept registrations");
    let sealed = false;
    const allowed = () => {
      if (sealed || this.#closed || this.#published)
        throw new HostError("CAPABILITY_DENIED", "Registration scope is closed");
    };
    return {
      host: Object.freeze({
        snapshotType,
        registerValidator: (
          id: string,
          validator: (description: BootstrapDescription) => readonly ExportValidation[] | undefined,
        ) => {
          allowed();
          if (this.#validators.has(id))
            throw new HostError("DEFINITION_CONFLICT", `Duplicate validator ${id}`);
          this.#validators.set(id, validator);
        },
        registerAbi: (id: string, adapter: AbiAdapter) => {
          allowed();
          if (this.#abis.has(id)) throw new HostError("DEFINITION_CONFLICT", `Duplicate ABI ${id}`);
          this.#abis.set(id, adapter);
        },
      }),
      seal: () => {
        sealed = true;
      },
    };
  }

  retainCleanup(cleanup: Cleanup): void {
    this.#cleanups.push(cleanup);
  }
  hasAbi(id: string): boolean {
    return !this.#closed && this.#abis.has(id);
  }
  abiIds(): readonly string[] {
    return Object.freeze([...this.#abis.keys()].sort());
  }
  publish(): void {
    this.#published = true;
  }
  validate(): readonly ExportValidation[] {
    const validator = this.#validators.get("meta.v1");
    if (!validator) throw new HostError("UNKNOWN_ABI", "meta.v1 validator not registered");
    return (
      validator(
        Object.freeze({
          ...this.description,
          availableAbis: Object.freeze([...this.#abis.keys()]),
        }),
      ) ?? []
    );
  }
  validateExport(abi: string, value: unknown): void {
    const adapter = this.#abis.get(abi);
    if (!adapter) throw new HostError("UNKNOWN_ABI", abi);
    adapter.validateExport(value);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const cleanup of this.#cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        this.cleanupErrors.push(error);
      }
    }
    this.#cleanups = [];
    this.#validators.clear();
    this.#abis.clear();
  }
}
