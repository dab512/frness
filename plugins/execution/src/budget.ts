import { randomUUID } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  AttemptRecord,
  BudgetSnapshot,
  BudgetSpec,
  CommitBatch,
  ExecutionContext,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  ProtocolError,
  RecordWrite,
  ReservationRecord,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { executionError } from "./reducer.js";

interface Scope {
  budgetId: string;
  parentId: string | null;
  spec: BudgetSpec;
  entries: { reservation: ObjectRef; attempt: ObjectRef }[];
  stepIds: string[];
  blockedError: ProtocolError | null;
}
export interface BudgetOptions {
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly types: (name: string) => TypeRef;
}
export interface ReservationPlan {
  readonly budgetId: string;
  readonly reservation: ReservationRecord;
  readonly reservationRef: ObjectRef;
  readonly attemptRef: ObjectRef;
}
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
function safe(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function add(a: number, b: number): number {
  const sum = a + b;
  if (!safe(sum))
    throw executionError("INVALID_USAGE", "Budget arithmetic exceeded safe integer range");
  return sum;
}

export class BudgetLedger {
  constructor(readonly options: BudgetOptions) {}
  #ref(type: string, id: string): ObjectRef {
    return {
      storeId: this.options.storeId,
      namespaceId: this.options.namespaceId,
      objectId: `${type}/${id}`,
      type: this.options.types(type),
    };
  }
  attemptRef(id: string): ObjectRef {
    return this.#ref("Attempt", id);
  }
  #read(ref: ObjectRef): Promise<ObjectRecord> {
    return this.options.store.read(this.options.context, ref);
  }
  #replace(record: ObjectRecord, value: unknown): RecordWrite {
    return {
      kind: "replace",
      object: record.object,
      expectedRevision: record.revision,
      value: json(value),
    };
  }
  async #chain(budgetId: string): Promise<{ record: ObjectRecord; scope: Scope }[]> {
    const chain: { record: ObjectRecord; scope: Scope }[] = [];
    const seen = new Set<string>();
    let id: string | null = budgetId;
    while (id !== null) {
      if (seen.has(id) || chain.length > 32)
        throw executionError("INVALID_INPUT", "Invalid budget lineage");
      seen.add(id);
      const record = await this.#read(this.#ref("BudgetScope", id));
      const scope = record.value as unknown as Scope;
      chain.push({ record, scope });
      id = scope.parentId;
    }
    if (chain.some((entry) => entry.scope.spec.unit !== chain[0]?.scope.spec.unit))
      throw executionError("INVALID_INPUT", "Budget units must match ancestors");
    return chain;
  }
  async create(budgetId: string, parentId: string | null, spec: BudgetSpec): Promise<void> {
    if (
      !budgetId ||
      !spec.unit ||
      ![spec.limit, spec.maxSteps, spec.maxDepth, spec.maxConcurrentEffects].every(safe)
    )
      throw executionError("INVALID_INPUT", "Budget requires safe nonnegative limits");
    const chain = parentId === null ? [] : await this.#chain(parentId);
    if (
      chain.some((entry) => entry.scope.spec.unit !== spec.unit) ||
      chain.some((entry) => entry.scope.budgetId === budgetId)
    )
      throw executionError("INVALID_INPUT", "Invalid budget parent or unit");
    const value: Scope = {
      budgetId,
      parentId,
      spec: structuredClone(spec),
      entries: [],
      stepIds: [],
      blockedError: null,
    };
    await this.options.store.commit(this.options.context, {
      commitKey: `budget/create/${budgetId}`,
      readSet: chain.map((entry) => ({
        object: entry.record.object,
        revision: entry.record.revision,
      })),
      events: [],
      writes: [{ kind: "create", object: this.#ref("BudgetScope", budgetId), value: json(value) }],
    });
  }
  async #totals(scope: Scope): Promise<{
    snapshot: BudgetSnapshot;
    concurrency: number;
    readSet: { object: ObjectRef; revision: string }[];
  }> {
    let reserved = 0;
    let spent = 0;
    let concurrency = 0;
    const seen = new Set<string>();
    const readSet: { object: ObjectRef; revision: string }[] = [];
    for (const entry of scope.entries) {
      const reservationRecord = await this.#read(entry.reservation);
      const reservation = reservationRecord.value as unknown as ReservationRecord;
      if (seen.has(reservation.attemptId)) continue;
      seen.add(reservation.attemptId);
      const attemptRecord = await this.#read(entry.attempt);
      const attempt = attemptRecord.value as unknown as AttemptRecord;
      if (
        attempt.attemptId !== reservation.attemptId ||
        attempt.reservationId !== reservation.reservationId ||
        reservation.unit !== scope.spec.unit
      )
        throw executionError("INVALID_USAGE", "Budget entry identity or unit changed");
      readSet.push(
        { object: reservationRecord.object, revision: reservationRecord.revision },
        { object: attemptRecord.object, revision: attemptRecord.revision },
      );
      if (reservation.status === "reserved") reserved = add(reserved, reservation.maxUnits);
      else {
        if (reservation.actualUnits === null || !safe(reservation.actualUnits))
          throw executionError("INVALID_USAGE", "Settled reservation has invalid actual units");
        spent = add(spent, reservation.actualUnits);
      }
      if (["dispatched", "unknown"].includes(attempt.state)) concurrency++;
    }
    return { snapshot: { reserved, spent, limit: scope.spec.limit }, concurrency, readSet };
  }
  async snapshot(budgetId: string): Promise<BudgetSnapshot> {
    const scope = (await this.#chain(budgetId))[0]!.scope;
    return (await this.#totals(scope)).snapshot;
  }
  async plan(
    requests: readonly ReservationPlan[],
    step?: { readonly budgetId: string; readonly eventId: string; readonly depth: number },
  ): Promise<{
    writes: RecordWrite[];
    readSet: CommitBatch["readSet"];
    reservations: readonly ReservationRecord[];
  }> {
    const changed = new Map<string, { record: ObjectRecord; scope: Scope }>();
    const touched = new Set<string>();
    const reads = new Map<string, { object: ObjectRef; revision: string }>();
    const reservations: ReservationRecord[] = [];
    const pending = new Map<string, number>();
    const load = async (id: string) => {
      const chain = await this.#chain(id);
      for (const entry of chain) {
        if (!changed.has(entry.scope.budgetId)) changed.set(entry.scope.budgetId, entry);
        reads.set(canonicalJson(entry.record.object), {
          object: entry.record.object,
          revision: entry.record.revision,
        });
      }
      return chain.map((entry) => changed.get(entry.scope.budgetId)!);
    };
    if (step) {
      if (!safe(step.depth) || !step.eventId)
        throw executionError("INVALID_INPUT", "Step identity and depth are required");
      for (const { scope } of await load(step.budgetId)) {
        if (scope.blockedError)
          throw executionError("INVALID_USAGE", "Scope is blocked by invalid usage");
        if (scope.stepIds.includes(step.eventId)) continue;
        if (scope.stepIds.length >= scope.spec.maxSteps || step.depth > scope.spec.maxDepth)
          throw executionError("BUDGET_EXCEEDED", "Step or depth limit reached");
        scope.stepIds.push(step.eventId);
        touched.add(scope.budgetId);
      }
    }
    for (const request of requests) {
      if (!safe(request.reservation.maxUnits))
        throw executionError("INVALID_INPUT", "Reservation units must be a safe integer");
      const chain = await load(request.budgetId);
      const reservation = {
        ...structuredClone(request.reservation),
        unit: chain[0]!.scope.spec.unit,
        ancestorBudgetIds: chain.map((entry) => entry.scope.budgetId),
      };
      for (const { scope } of chain) {
        if (scope.blockedError)
          throw executionError("INVALID_USAGE", "Scope is blocked by invalid usage");
        const totals = await this.#totals({
          ...scope,
          entries: scope.entries.filter(
            (entry) =>
              !requests.some(
                (planned) =>
                  canonicalJson(planned.reservationRef) === canonicalJson(entry.reservation),
              ),
          ),
        });
        for (const read of totals.readSet) reads.set(canonicalJson(read.object), read);
        const requested = add(pending.get(scope.budgetId) ?? 0, reservation.maxUnits);
        if (add(add(totals.snapshot.reserved, totals.snapshot.spent), requested) > scope.spec.limit)
          throw executionError("BUDGET_EXCEEDED", "Ancestor budget cannot reserve this attempt");
        pending.set(scope.budgetId, requested);
        if (
          scope.entries.some(
            (entry) => canonicalJson(entry.reservation) === canonicalJson(request.reservationRef),
          )
        )
          throw executionError("INVALID_INPUT", "Attempt already has a reservation in scope");
        scope.entries.push({ reservation: request.reservationRef, attempt: request.attemptRef });
        touched.add(scope.budgetId);
      }
      reservations.push(reservation);
    }
    return {
      writes: [...changed.values()]
        .filter((entry) => touched.has(entry.scope.budgetId))
        .map((entry) => this.#replace(entry.record, entry.scope)),
      readSet: [...reads.values()],
      reservations,
    };
  }
  async reserve(budgetId: string, attempt: AttemptRecord, maxUnits: number): Promise<ObjectRef> {
    const reservationRef = this.#ref("Reservation", attempt.reservationId);
    const attemptRef = this.attemptRef(attempt.attemptId);
    const reservation: ReservationRecord = {
      reservationId: attempt.reservationId,
      attemptId: attempt.attemptId,
      ancestorBudgetIds: [],
      unit: "pending",
      maxUnits,
      actualUnits: null,
      status: "reserved",
    };
    for (let retry = 0; retry < 32; retry++) {
      const plan = await this.plan([{ budgetId, reservation, reservationRef, attemptRef }]);
      try {
        await this.options.store.commit(this.options.context, {
          commitKey: `budget/reserve/${attempt.attemptId}`,
          readSet: plan.readSet,
          events: [],
          writes: [
            ...plan.writes,
            { kind: "create", object: reservationRef, value: json(plan.reservations[0]) },
            { kind: "create", object: attemptRef, value: json(attempt) },
          ],
        });
        return reservationRef;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "REVISION_CONFLICT"))
          throw error;
      }
    }
    throw executionError("REVISION_CONFLICT", "Budget admission did not converge");
  }
  async settlement(
    reservationRef: ObjectRef,
    actual: number | null,
    evidence: Json,
  ): Promise<{ writes: RecordWrite[]; readSet: CommitBatch["readSet"]; invalid: boolean }> {
    const record = await this.#read(reservationRef);
    const reservation = record.value as unknown as ReservationRecord;
    if (actual === null)
      return {
        writes: [],
        readSet: [{ object: record.object, revision: record.revision }],
        invalid: false,
      };
    if (!safe(actual) || actual > reservation.maxUnits) {
      const error: ProtocolError = {
        code: "INVALID_USAGE",
        message: "Usage receipt violates the declared maximum",
        details: null,
        retryable: false,
      };
      const writes: RecordWrite[] = [];
      for (const id of reservation.ancestorBudgetIds) {
        const scopeRecord = await this.#read(this.#ref("BudgetScope", id));
        const scope = scopeRecord.value as unknown as Scope;
        writes.push(this.#replace(scopeRecord, { ...scope, blockedError: error }));
      }
      writes.push({
        kind: "create",
        object: this.#ref("UsageAnomaly", randomUUID()),
        value: json({
          reservation: reservationRef,
          actual: Number.isFinite(actual) ? actual : String(actual),
          evidence,
          error,
        }),
      });
      return {
        writes,
        readSet: [{ object: record.object, revision: record.revision }],
        invalid: true,
      };
    }
    if (reservation.status === "settled") {
      if (reservation.actualUnits !== actual)
        throw executionError("COMPLETION_CONFLICT", "Usage was already settled differently");
      return { writes: [], readSet: [], invalid: false };
    }
    return {
      writes: [this.#replace(record, { ...reservation, actualUnits: actual, status: "settled" })],
      readSet: [],
      invalid: false,
    };
  }
  async settle(reservationRef: ObjectRef, actual: number | null, evidence: Json): Promise<void> {
    const plan = await this.settlement(reservationRef, actual, evidence);
    if (plan.writes.length)
      await this.options.store.commit(this.options.context, {
        commitKey: `budget/settle/${reservationRef.objectId}/${canonicalJson(actual !== null && !Number.isFinite(actual) ? String(actual) : actual)}`,
        readSet: plan.readSet,
        events: [],
        writes: plan.writes,
      });
    if (plan.invalid)
      throw executionError("INVALID_USAGE", "Usage receipt blocked affected scopes");
  }
  async dispatchGuard(reservationRef: ObjectRef): Promise<CommitBatch["readSet"]> {
    const reservationRecord = await this.#read(reservationRef);
    const reservation = reservationRecord.value as unknown as ReservationRecord;
    const reads = new Map<string, { object: ObjectRef; revision: string }>();
    reads.set(canonicalJson(reservationRef), {
      object: reservationRef,
      revision: reservationRecord.revision,
    });
    for (const id of reservation.ancestorBudgetIds) {
      const scopeRecord = await this.#read(this.#ref("BudgetScope", id));
      const scope = scopeRecord.value as unknown as Scope;
      if (scope.blockedError)
        throw executionError("INVALID_USAGE", "Scope is blocked by invalid usage");
      const totals = await this.#totals(scope);
      if (totals.concurrency >= scope.spec.maxConcurrentEffects)
        throw executionError("BUDGET_EXCEEDED", "Concurrent physical attempt limit reached");
      reads.set(canonicalJson(scopeRecord.object), {
        object: scopeRecord.object,
        revision: scopeRecord.revision,
      });
      for (const read of totals.readSet) reads.set(canonicalJson(read.object), read);
    }
    return [...reads.values()];
  }
  async step(budgetId: string, eventId: string, depth: number): Promise<void> {
    const plan = await this.plan([], { budgetId, eventId, depth });
    if (!plan.writes.length) return;
    await this.options.store.commit(this.options.context, {
      commitKey: `budget/step/${budgetId}/${eventId}`,
      readSet: plan.readSet,
      events: [],
      writes: plan.writes,
    });
  }
}
