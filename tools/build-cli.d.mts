import type { BootLock } from "../packages/abi/src/index.js";
import type { buildBootstrap } from "./build-bootstrap.mjs";
export function buildCli(
  directory: string,
  options?: {
    readonly packages?: NonNullable<Parameters<typeof buildBootstrap>[1]>["packages"];
    readonly addons?: boolean;
  },
): Promise<BootLock>;
