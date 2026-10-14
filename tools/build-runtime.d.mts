import type { BootLock } from "../packages/abi/src/index.js";
import type { buildBootstrap } from "./build-bootstrap.mjs";
export function buildServerModule(entry: string): Promise<Uint8Array>;
export function buildRuntime(
  directory: string,
  options?: { readonly packages?: NonNullable<Parameters<typeof buildBootstrap>[1]>["packages"] },
): Promise<BootLock>;
