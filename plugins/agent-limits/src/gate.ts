import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  ExecutionContext,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type {
  AgentLaunchDecision,
  AgentTurnInput,
} from "../../../specs/fractal-harness/standard-contracts.js";

export interface GateOptions {
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly types: (name: string) => TypeRef;
  readonly maxRuns: number;
}
export class AdmissionGate {
  #queue = Promise.resolve();
  constructor(readonly options: GateOptions) {
    if (!Number.isSafeInteger(options.maxRuns) || options.maxRuns < 0)
      throw Object.assign(new Error("Invalid admission policy"), { code: "INVALID_INPUT" });
  }
  #ref(type: string, id: string): ObjectRef {
    return {
      storeId: this.options.storeId,
      namespaceId: this.options.namespaceId,
      objectId: `${type}/${id}`,
      type: this.options.types(type),
    };
  }
  async #maybe(ref: ObjectRef): Promise<ObjectRecord | undefined> {
    try {
      return await this.options.store.read(this.options.context, ref);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }
  check(input: AgentTurnInput): Promise<AgentLaunchDecision> {
    const work = this.#queue.then(() => this.#check(input));
    this.#queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async #check(input: AgentTurnInput): Promise<AgentLaunchDecision> {
    const id = createHash("sha256")
      .update(canonicalJson([input.session.object, input.clientTurnId]))
      .digest("hex");
    const reservationRef = this.#ref("Reservation", id);
    const previous = await this.#maybe(reservationRef);
    if (previous) return (previous.value as unknown as { decision: AgentLaunchDecision }).decision;
    const stateRef = this.#ref("State", "admissions");
    const state = await this.#maybe(stateRef);
    const admitted = state ? (state.value as { admitted: number }).admitted : 0;
    const decision: AgentLaunchDecision =
      admitted < this.options.maxRuns
        ? { kind: "allow" }
        : {
            kind: "deny",
            error: {
              code: "ADMISSION_LIMIT_REACHED",
              message: "Launch policy has reached its admitted-run limit",
              details: null,
              retryable: false,
            },
          };
    const value = JSON.parse(
      canonicalJson({ session: input.session.object, clientTurnId: input.clientTurnId, decision }),
    ) as Json;
    const writes: import("../../../specs/fractal-harness/contracts.js").RecordWrite[] = [
      { kind: "create", object: reservationRef, value },
    ];
    if (decision.kind === "allow")
      writes.push(
        state
          ? {
              kind: "replace",
              object: stateRef,
              expectedRevision: state.revision,
              value: { admitted: admitted + 1 },
            }
          : { kind: "create", object: stateRef, value: { admitted: 1 } },
      );
    await this.options.store.commit(this.options.context, {
      commitKey: `admission/${id}`,
      readSet: [],
      events: [],
      writes,
    });
    return decision;
  }
}
