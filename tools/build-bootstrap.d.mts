import type { BootLock, DefinitionRef, PackageManifest } from "../packages/abi/src/index.js";

interface PackageArtifact {
  readonly manifest: PackageManifest;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly activations?: readonly string[];
}
type PackageFactory = (
  meta: (name: string) => DefinitionRef,
  lookup: (packageId: string, name: string) => DefinitionRef,
) => PackageArtifact | Promise<PackageArtifact>;
export function buildBootstrap(
  directory: string,
  options?: {
    readonly metaManifest?: PackageManifest;
    readonly packages?: readonly PackageFactory[];
  },
): Promise<BootLock>;
