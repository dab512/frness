import type {
  CommitBatch,
  Json,
  ObjectRef,
  RecordWrite,
  ReservationRecord,
} from "../../../specs/fractal-harness/contracts.js";

/** Optional extension port. Execution coordinates commits without choosing a ledger implementation. */
export interface ReservationPlan {
  readonly budgetId: string;
  readonly reservation: ReservationRecord;
  readonly reservationRef: ObjectRef;
  readonly attemptRef: ObjectRef;
}
export interface BudgetPort {
  plan(
    requests: readonly ReservationPlan[],
    step?: { readonly budgetId: string; readonly eventId: string; readonly depth: number },
  ): Promise<{
    writes: RecordWrite[];
    readSet: CommitBatch["readSet"];
    reservations: readonly ReservationRecord[];
  }>;
  settlement(
    reservation: ObjectRef,
    actual: number | null,
    evidence: Json,
  ): Promise<{ writes: RecordWrite[]; readSet: CommitBatch["readSet"]; invalid: boolean }>;
  dispatchGuard(reservation: ObjectRef): Promise<CommitBatch["readSet"]>;
}
