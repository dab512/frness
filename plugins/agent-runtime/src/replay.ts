import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import type { ObjectRecord, ObjectRef, TypeRef } from "../../../specs/fractal-harness/contracts.js";
import type { AgentRuntimeEvent } from "../../../specs/fractal-harness/standard-contracts.js";

/** Optional recorded-boundary replay. The read capability cannot start a process or mutate state. */
export async function replayCliTurn(
  read: (ref: ObjectRef) => Promise<ObjectRecord>,
  types: (name: string) => TypeRef,
  turn: ObjectRef,
): Promise<{
  result: string | null;
  events: readonly ObjectRecord[];
  externalCalls: 0;
  productionWrites: 0;
}> {
  const snapshot = (await read(turn)).value as { phase: string; result: string | null };
  if (["queued", "running"].includes(snapshot.phase))
    throw Object.assign(new Error("Turn is not a stable replay source"), {
      code: "REPLAY_UNAVAILABLE",
    });
  const log = (
    await read({
      ...turn,
      objectId: `EventLog/${turn.objectId.slice("Turn/".length)}`,
      type: types("EventLog"),
    })
  ).value as { sequence: number };
  const events: ObjectRecord[] = [];
  let result: string | null = null;
  let terminal = false;
  for (let sequence = 0; sequence < log.sequence; sequence++) {
    const id = createHash("sha256")
      .update(canonicalJson([turn.objectId, sequence]))
      .digest("hex");
    const record = await read({ ...turn, objectId: `Event/${id}`, type: types("Event") });
    const event = (record.value as unknown as { event: AgentRuntimeEvent }).event;
    if (terminal)
      throw Object.assign(new Error("Events follow terminal"), { code: "REPLAY_DIVERGENCE" });
    if (event.kind === "terminal") {
      terminal = true;
      result = typeof event.result === "string" ? event.result : null;
    }
    events.push(record);
  }
  if (!terminal || result !== snapshot.result)
    throw Object.assign(new Error("Recorded terminal does not match"), {
      code: "REPLAY_DIVERGENCE",
    });
  return { result, events, externalCalls: 0, productionWrites: 0 };
}
