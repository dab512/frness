import type { DefinitionRef } from "../../../specs/fractal-harness/contracts.js";
import { LifecycleManager, packageKey, stateValue } from "./activate.js";

/** Removal is logical first: physical artifacts are collected only after durable references disappear. */
export async function purge(
  manager: LifecycleManager,
  ref: DefinitionRef,
  commitKey: string,
): Promise<void> {
  const state = await manager.state();
  if (!state) throw Object.assign(new Error("Lifecycle is not initialized"), { code: "NOT_FOUND" });
  const key = packageKey(ref);
  const referenced =
    Object.values(state.value.assemblies).some((assembly) =>
      assembly.instances.some((instance) => packageKey(instance.implementation) === key),
    ) || Object.values(state.value.pins).some((digests) => digests.includes(ref.digest));
  if (referenced)
    throw Object.assign(new Error("Package has durable references"), { code: "LIVE_REFERENCES" });
  delete state.value.packages[key];
  await manager.store.commit(manager.context, {
    commitKey,
    readSet: [],
    events: [],
    writes: [
      {
        kind: "replace",
        object: manager.head,
        expectedRevision: state.record.revision,
        value: stateValue(state.value),
      },
    ],
  });
}
