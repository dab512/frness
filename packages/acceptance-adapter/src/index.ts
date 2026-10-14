import type { AcceptanceHarness } from "../../../specs/fractal-harness/acceptance-api.js";

/** Wiring only: the daemon supplies the product API, tests never substitute storage or execution. */
export function adaptAcceptanceHarness(api: AcceptanceHarness): AcceptanceHarness {
  const required = [
    "fixture",
    "validateAssembly",
    "invoke",
    "pump",
    "snapshot",
    "read",
    "commit",
    "crashAt",
    "recover",
    "effectCounts",
    "replay",
    "runBudgetRace",
    "close",
  ] as const;
  for (const name of required)
    if (typeof api[name] !== "function")
      throw Object.assign(new Error(`Missing product API: ${name}`), {
        code: "IMPLEMENTATION_MISSING",
      });
  return Object.freeze({
    fixture: api.fixture.bind(api),
    validateAssembly: api.validateAssembly.bind(api),
    invoke: api.invoke.bind(api),
    pump: api.pump.bind(api),
    snapshot: api.snapshot.bind(api),
    read: api.read.bind(api),
    commit: api.commit.bind(api),
    crashAt: api.crashAt.bind(api),
    recover: api.recover.bind(api),
    effectCounts: api.effectCounts.bind(api),
    replay: api.replay.bind(api),
    runBudgetRace: api.runBudgetRace.bind(api),
    close: api.close.bind(api),
  });
}
