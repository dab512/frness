import type { BootLock, PackageManifest } from "../packages/abi/src/index.js";
export function buildBootstrap(
  directory: string,
  options?: { readonly metaManifest?: PackageManifest },
): Promise<BootLock>;
