import type { DefinitionRecord, DefinitionRef, Json, PackageManifest } from "./index.js";

export interface ResolvedDefinition extends DefinitionRecord {
  readonly ref: DefinitionRef;
}
export interface ResolvedPackage {
  readonly digest: string;
  readonly source: PackageManifest;
  readonly definitions: readonly ResolvedDefinition[];
  readonly snapshotType: DefinitionRef;
}
export interface BootstrapDescription {
  readonly packages: readonly ResolvedPackage[];
  readonly definitions: readonly ResolvedDefinition[];
  readonly availableAbis?: readonly string[];
}
export interface ExportValidation {
  readonly packageDigest: string;
  readonly entry: string;
  readonly abi: string;
}
export interface AbiAdapter {
  validateExport(value: unknown): void;
}
export interface BootstrapRegistrationHost {
  readonly snapshotType: DefinitionRef;
  registerValidator(
    id: string,
    validator: (description: BootstrapDescription) => readonly ExportValidation[] | undefined,
  ): void;
  registerAbi(id: string, adapter: AbiAdapter): void;
}
export interface StatelessSnapshot {
  readonly type: DefinitionRef;
  readonly value: Json;
}
