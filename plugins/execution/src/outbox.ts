import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import type {
  Assembly,
  AttemptRecord,
  CommitBatch,
  EffectDefinition,
  EffectOutcome,
  EffectResolutionRecord,
  ExecutionContext,
  InvocationRequest,
  InvocationSnapshot,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  RecordWrite,
  ReducerCommand,
  ReducerEvent,
  ReservationRecord,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type { BudgetPort, ReservationPlan } from "./budget-port.js";
import { InvocationControl } from "./control.js";
import type { EffectBridge } from "./effect-adapter.js";
import type { ExecutionService } from "./ingress.js";
import { executionError } from "./reducer.js";
import { evaluateRetry } from "./retry.js";

export type CrashCut =
  | "before_prepare_commit"
  | "after_prepare_commit"
  | "after_dispatch_commit_before_transport"
  | "after_remote_accept_before_receipt"
  | "after_receipt_commit_before_reduce"
  | "after_reduce_commit";
export interface OutboxOptions {
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly types: (name: string) => TypeRef;
  readonly bridge: EffectBridge;
  readonly runnerEpoch: string;
  readonly budget?: {
    readonly ledger: BudgetPort;
    readonly scope: (invocation: ObjectRef) => string;
  };
  readonly cut?: (point: CrashCut) => Promise<void>;
}
interface OutboxIntent {
  invocation: ObjectRef;
  commandId: string;
  effect: ObjectRef;
  attempt: ObjectRef;
  reservation: ObjectRef;
  status: "prepared" | "dispatched" | "unknown" | "resolved";
}
interface RuntimeState {
  pendingCommands: string[];
  inboxIds: string[];
  pendingKinds: Record<string, string>;
  readonly [key: string]: unknown;
}
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const terminal = (snapshot: InvocationSnapshot): boolean =>
  ["succeeded", "failed", "cancelled"].includes(snapshot.phase);

export class DurableOutbox {
  readonly bridge: EffectBridge;
  readonly control: InvocationControl;
  constructor(readonly options: OutboxOptions) {
    this.bridge = options.bridge;
    this.control = new InvocationControl({
      ...options,
      cancelPrepared: (root) => this.cancelPrepared(root),
    });
  }
  #ref(type: string, id: string): ObjectRef {
    return {
      storeId: this.options.storeId,
      namespaceId: this.options.namespaceId,
      objectId: `${type}/${id}`,
      type: this.options.types(type),
    };
  }
  #associated(type: string, invocation: ObjectRef, suffix = ""): ObjectRef {
    return this.#ref(type, `${invocation.objectId}${suffix ? `/${suffix}` : ""}`);
  }
  #read(ref: ObjectRef): Promise<ObjectRecord> {
    return this.options.store.read(this.options.context, ref);
  }
  async #maybe(ref: ObjectRef): Promise<ObjectRecord | undefined> {
    try {
      return await this.#read(ref);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }
  #replace(record: ObjectRecord, value: unknown): RecordWrite {
    return {
      kind: "replace",
      object: record.object,
      expectedRevision: record.revision,
      value: json(value),
    };
  }
  async intents(): Promise<readonly ObjectRef[]> {
    const index = await this.#maybe(this.#ref("OutboxIndex", "index"));
    return index ? (index.value as unknown as { objects: ObjectRef[] }).objects : [];
  }
  validate(
    assembly: Assembly,
    request: InvocationRequest,
    invocation: ObjectRef,
    command: Extract<ReducerCommand, { kind: "effect" }>,
  ): EffectDefinition {
    if (command.maxUnits !== 0 && !this.options.budget)
      throw executionError("CAPABILITY_DENIED", "Positive reservations require a budget ledger");
    return this.bridge.prepare({
      assembly,
      parentInstanceId: request.targetInstanceId,
      invocationId: invocation.objectId,
      operation: request.operation,
      command,
      grants: this.options.context.grants,
    });
  }
  async prepare(
    assembly: Assembly,
    request: InvocationRequest,
    invocation: ObjectRef,
    commands: readonly ReducerCommand[],
    step?: { readonly eventId: string; readonly depth: number },
  ): Promise<{ writes: RecordWrite[]; readSet: CommitBatch["readSet"] }> {
    const effects = commands.filter(
      (command): command is Extract<ReducerCommand, { kind: "effect" }> =>
        command.kind === "effect",
    );
    const budget = this.options.budget;
    if (!effects.length)
      return budget && step
        ? budget.ledger.plan([], { ...step, budgetId: budget.scope(invocation) })
        : { writes: [], readSet: [] };
    const indexRef = this.#ref("OutboxIndex", "index");
    const index = await this.#maybe(indexRef);
    const objects = index ? (index.value as unknown as { objects: ObjectRef[] }).objects : [];
    const writes: RecordWrite[] = [];
    const requests: ReservationPlan[] = [];
    for (const command of effects) {
      if (command.maxUnits !== 0 && !budget)
        throw executionError("CAPABILITY_DENIED", "Positive reservations require a budget ledger");
      const effect = this.validate(assembly, request, invocation, command);
      const attemptId = `${effect.effectId}/attempt/1`;
      const reservationId = `${attemptId}/reservation`;
      const outboxRef = this.#associated("Outbox", invocation, command.commandId);
      const intent: OutboxIntent = {
        invocation,
        commandId: command.commandId,
        effect: this.#ref("Effect", effect.effectId),
        attempt: this.#ref("Attempt", attemptId),
        reservation: this.#ref("Reservation", reservationId),
        status: "prepared",
      };
      const attempt: AttemptRecord = {
        attemptId,
        effectId: effect.effectId,
        runnerEpoch: this.options.runnerEpoch,
        state: "prepared",
        reservationId,
        result: null,
      };
      const reservation: ReservationRecord = {
        reservationId,
        attemptId,
        ancestorBudgetIds: [],
        unit: "model-call",
        maxUnits: command.maxUnits,
        actualUnits: null,
        status: "reserved",
      };
      writes.push(
        { kind: "create", object: intent.effect, value: json(effect) },
        { kind: "create", object: intent.attempt, value: json(attempt) },
        { kind: "create", object: intent.reservation, value: json(reservation) },
        { kind: "create", object: outboxRef, value: json(intent) },
      );
      objects.push(outboxRef);
      if (budget)
        requests.push({
          budgetId: budget.scope(invocation),
          reservation,
          reservationRef: intent.reservation,
          attemptRef: intent.attempt,
        });
    }
    writes.push(
      index
        ? this.#replace(index, { objects })
        : { kind: "create", object: indexRef, value: json({ objects }) },
    );
    if (!budget) return { writes, readSet: [] };
    const plan = await budget.ledger.plan(
      requests,
      step ? { ...step, budgetId: budget.scope(invocation) } : undefined,
    );
    for (const [index, reservation] of plan.reservations.entries()) {
      const ref = requests[index]!.reservationRef;
      const write = writes.find((write) => write.object.objectId === ref.objectId);
      if (write && write.kind === "create")
        writes[writes.indexOf(write)] = { ...write, value: json(reservation) };
    }
    return { writes: [...writes, ...plan.writes], readSet: plan.readSet };
  }
  async dispatch(ref: ObjectRef): Promise<void> {
    const outboxRecord = await this.#read(ref);
    const intent = outboxRecord.value as unknown as OutboxIntent;
    if (intent.status !== "prepared") return;
    const attemptRecord = await this.#read(intent.attempt);
    const attempt = attemptRecord.value as unknown as AttemptRecord;
    const invocationRecord = await this.#read(intent.invocation);
    const snapshot = invocationRecord.value as unknown as InvocationSnapshot;
    if (attempt.state !== "prepared" || snapshot.control !== "running" || terminal(snapshot))
      return;
    const controls = await this.control.guard(intent.invocation);
    if (!controls.allowed) return;
    const reservationRecord = await this.#read(intent.reservation);
    const effectRecord = await this.#read(intent.effect);
    const effect = effectRecord.value as unknown as EffectDefinition;
    const budgetGuards =
      (await this.options.budget?.ledger.dispatchGuard(intent.reservation)) ?? [];
    await this.options.store.commit(this.options.context, {
      commitKey: `dispatch/${attempt.attemptId}`,
      readSet: [
        { object: effectRecord.object, revision: effectRecord.revision },
        { object: reservationRecord.object, revision: reservationRecord.revision },
        ...budgetGuards,
        ...controls.readSet,
      ],
      events: [],
      writes: [
        this.#replace(attemptRecord, {
          ...attempt,
          state: "dispatched",
          runnerEpoch: this.options.runnerEpoch,
        }),
        this.#replace(outboxRecord, { ...intent, status: "dispatched" }),
        ...controls.records.map((entry) =>
          this.#replace(entry.record, {
            ...entry.snapshot,
            unresolvedEffectIds: [
              ...new Set([...entry.snapshot.unresolvedEffectIds, effect.effectId]),
            ],
          }),
        ),
      ],
    });
    await this.options.cut?.("after_dispatch_commit_before_transport");
    const outcome = await this.bridge.execute(effect, attempt.attemptId, this.options.runnerEpoch);
    await this.options.cut?.("after_remote_accept_before_receipt");
    await this.complete(ref, outcome);
    await this.options.cut?.("after_receipt_commit_before_reduce");
  }
  async complete(
    ref: ObjectRef,
    outcome: EffectOutcome,
    cancellation?: { readonly readSet: CommitBatch["readSet"] },
  ): Promise<void> {
    const outboxRecord = await this.#read(ref);
    const intent = outboxRecord.value as unknown as OutboxIntent;
    const attemptRecord = await this.#read(intent.attempt);
    const attempt = attemptRecord.value as unknown as AttemptRecord;
    const completionRef = this.#ref("Completion", attempt.attemptId);
    this.bridge.options.registry.validate(this.options.types("Completion"), {
      effectId: attempt.effectId,
      attemptId: attempt.attemptId,
      outcome,
    });
    const prior = await this.#maybe(completionRef);
    if (prior) {
      if (
        canonicalJson(prior.value) !==
        canonicalJson({ effectId: attempt.effectId, attemptId: attempt.attemptId, outcome })
      )
        throw executionError("COMPLETION_CONFLICT", "Attempt already has a different receipt");
      return;
    }
    if (
      cancellation &&
      attempt.state === "prepared" &&
      !(await this.control.guard(intent.invocation)).records.some(
        (entry) => entry.snapshot.control === "cancel_requested",
      )
    )
      throw executionError(
        "CAPABILITY_DENIED",
        "Prepared cancellation has no committed control boundary",
      );
    if (
      !["dispatched", "unknown"].includes(attempt.state) &&
      !(cancellation && attempt.state === "prepared")
    )
      throw executionError("INVALID_INPUT", "Attempt has not been dispatched");
    const invocationRecord = await this.#read(intent.invocation);
    const snapshot = invocationRecord.value as unknown as InvocationSnapshot;
    const settlement = this.options.budget
      ? await this.options.budget.ledger.settlement(
          intent.reservation,
          outcome.kind === "unknown"
            ? outcome.reason === "INVALID_USAGE"
              ? Number.NaN
              : null
            : outcome.actualUnits,
          json(outcome),
        )
      : undefined;
    if (settlement?.invalid) {
      await this.options.store.commit(this.options.context, {
        commitKey: `invalid-usage/${attempt.attemptId}`,
        readSet: settlement.readSet,
        events: [],
        writes: [
          ...settlement.writes,
          this.#replace(attemptRecord, { ...attempt, state: "unknown" }),
          this.#replace(outboxRecord, { ...intent, status: "unknown" }),
          this.#replace(invocationRecord, {
            ...snapshot,
            ...(!terminal(snapshot) ? { phase: "waiting", waitingReason: "indeterminate" } : {}),
            error: {
              code: "INVALID_USAGE",
              message: "Adapter usage violated its declared bound",
              details: null,
              retryable: false,
            },
          }),
        ],
      });
      throw executionError("INVALID_USAGE", "Usage receipt blocked further dispatch");
    }
    if (outcome.kind === "unknown") {
      if (attempt.state === "unknown" && intent.status === "unknown") return;
      await this.options.store.commit(this.options.context, {
        commitKey: `unknown/${attempt.attemptId}`,
        readSet: [],
        events: [],
        writes: [
          this.#replace(attemptRecord, { ...attempt, state: "unknown" }),
          this.#replace(outboxRecord, { ...intent, status: "unknown" }),
          this.#replace(
            invocationRecord,
            terminal(snapshot)
              ? snapshot
              : { ...snapshot, phase: "waiting", waitingReason: "indeterminate" },
          ),
        ],
      });
      return;
    }
    const completionRevision = randomUUID();
    const result = { object: completionRef, revision: completionRevision };
    const businessResultDigest = digest(
      outcome.kind === "completed"
        ? { kind: outcome.kind, value: outcome.value }
        : { kind: outcome.kind, error: outcome.error },
    );
    const resolutionRef = this.#ref("Resolution", attempt.effectId);
    const existingResolution = await this.#maybe(resolutionRef);
    if (
      existingResolution &&
      (existingResolution.value as unknown as EffectResolutionRecord).businessResultDigest !==
        businessResultDigest
    )
      throw executionError("COMPLETION_CONFLICT", "Logical effect has a different business result");
    const reservationRecord = await this.#read(intent.reservation);
    const reservation = reservationRecord.value as unknown as ReservationRecord;
    const stateRecord = await this.#read(this.#associated("State", intent.invocation));
    const state = stateRecord.value as unknown as RuntimeState;
    const unresolved = await this.#unresolved(intent.invocation, attempt.attemptId);
    const event: ReducerEvent = {
      eventId: digest([attempt.effectId, "resolved"]),
      type: this.options.types(outcome.kind === "completed" ? "EffectCompleted" : "EffectFailed"),
      value: json(
        outcome.kind === "completed"
          ? { commandId: intent.commandId, output: outcome.value }
          : { commandId: intent.commandId, error: outcome.error },
      ),
    };
    const writes: RecordWrite[] = [
      {
        kind: "create",
        object: completionRef,
        revision: completionRevision,
        value: json({ effectId: attempt.effectId, attemptId: attempt.attemptId, outcome }),
      },
      this.#replace(attemptRecord, {
        ...attempt,
        state: outcome.kind === "completed" ? "completed" : "failed_known",
        result,
      }),
      this.#replace(outboxRecord, { ...intent, status: "resolved" }),
      ...(settlement
        ? settlement.writes
        : [
            this.#replace(
              reservationRecord,
              outcome.actualUnits === null
                ? reservation
                : { ...reservation, actualUnits: outcome.actualUnits, status: "settled" },
            ),
          ]),
      this.#replace(invocationRecord, {
        ...snapshot,
        unresolvedEffectIds: unresolved.ids,
        ...(!terminal(snapshot) && unresolved.ids.length
          ? { phase: "waiting", waitingReason: "indeterminate" }
          : {}),
      }),
    ];
    if (!existingResolution) {
      writes.push(
        {
          kind: "create",
          object: resolutionRef,
          value: json({
            effectId: attempt.effectId,
            result,
            businessResultDigest,
            deliveredEventId: event.eventId,
          }),
        },
        this.#replace(stateRecord, {
          ...state,
          pendingCommands: state.pendingCommands.filter((id) => id !== intent.commandId),
          pendingKinds: Object.fromEntries(
            Object.entries(state.pendingKinds).filter(([id]) => id !== intent.commandId),
          ),
          inboxIds: [...state.inboxIds, `effect:${intent.commandId}`],
        }),
        {
          kind: "create",
          object: this.#associated("Inbox", intent.invocation, `effect:${intent.commandId}`),
          value: json({
            invocation: intent.invocation,
            event,
            consumed: terminal(snapshot),
            error: null,
          }),
        },
      );
    }
    const ancestorFence = await this.control.guard(intent.invocation);
    const ancestorReads = [...ancestorFence.readSet];
    for (const entry of ancestorFence.records.slice(1)) {
      const remaining = await this.#unresolved(entry.record.object, attempt.attemptId);
      ancestorReads.push(...remaining.readSet);
      writes.push(
        this.#replace(entry.record, { ...entry.snapshot, unresolvedEffectIds: remaining.ids }),
      );
    }
    await this.options.store.commit(this.options.context, {
      commitKey: `receipt/${attempt.attemptId}`,
      readSet: [
        ...unresolved.readSet,
        ...ancestorReads,
        ...(settlement?.readSet ?? []),
        ...(cancellation?.readSet ?? []),
      ],
      events: existingResolution ? [] : [event],
      writes,
    });
  }
  async recover(): Promise<void> {
    for (const ref of await this.intents()) {
      const intent = (await this.#read(ref)).value as unknown as OutboxIntent;
      const attempt = (await this.#read(intent.attempt)).value as unknown as AttemptRecord;
      if (attempt.state === "dispatched" && attempt.runnerEpoch !== this.options.runnerEpoch)
        await this.complete(ref, {
          kind: "unknown",
          reason: "Previous runner ended without durable receipt",
          evidence: null,
        });
    }
  }
  async #unresolved(
    invocation: ObjectRef,
    resolvedAttemptId: string,
  ): Promise<{ ids: string[]; readSet: CommitBatch["readSet"] }> {
    const ids = new Set<string>();
    const readSet: { object: ObjectRef; revision: string }[] = [];
    for (const ref of await this.intents()) {
      const intent = (await this.#read(ref)).value as unknown as OutboxIntent;
      const lineage = await this.control.guard(intent.invocation);
      if (!lineage.records.some((entry) => entry.record.object.objectId === invocation.objectId))
        continue;
      readSet.push(...lineage.readSet);
      const record = await this.#read(intent.attempt);
      const attempt = record.value as unknown as AttemptRecord;
      readSet.push({ object: record.object, revision: record.revision });
      if (
        attempt.attemptId !== resolvedAttemptId &&
        ["dispatched", "unknown"].includes(attempt.state)
      )
        ids.add(attempt.effectId);
    }
    return { ids: [...ids], readSet };
  }
  async cancelPrepared(root: ObjectRef): Promise<void> {
    for (const ref of await this.intents()) {
      const intent = (await this.#read(ref)).value as unknown as OutboxIntent;
      const fence = await this.control.guard(intent.invocation);
      const boundary = fence.records.find(
        (entry) =>
          entry.record.object.objectId === root.objectId &&
          entry.snapshot.control === "cancel_requested",
      );
      if (!boundary) continue;
      const attempt = (await this.#read(intent.attempt)).value as unknown as AttemptRecord;
      if (attempt.state !== "prepared") continue;
      await this.complete(
        ref,
        {
          kind: "failed_known",
          error: {
            code: "CANCELLED_BEFORE_DISPATCH",
            message: "Committed control prevents dispatch",
            details: null,
            retryable: false,
          },
          actualUnits: 0,
          evidence: json({
            control: { object: boundary.record.object, revision: boundary.record.revision },
          }),
        },
        { readSet: fence.readSet },
      );
    }
  }
  async retry(ref: ObjectRef, now: string): Promise<ObjectRef | undefined> {
    const originalRecord = await this.#read(ref);
    const original = originalRecord.value as unknown as OutboxIntent;
    const effectRecord = await this.#read(original.effect);
    const effect = effectRecord.value as unknown as EffectDefinition;
    const index = await this.#read(this.#ref("OutboxIndex", "index"));
    const objects = (index.value as unknown as { objects: ObjectRef[] }).objects;
    const attempts: AttemptRecord[] = [];
    const readSet: { object: ObjectRef; revision: string }[] = [
      { object: effectRecord.object, revision: effectRecord.revision },
    ];
    for (const object of objects) {
      const intent = (await this.#read(object)).value as unknown as OutboxIntent;
      if (canonicalJson(intent.effect) !== canonicalJson(original.effect)) continue;
      const record = await this.#read(intent.attempt);
      attempts.push(record.value as unknown as AttemptRecord);
      readSet.push({ object: record.object, revision: record.revision });
    }
    if (evaluateRetry(effect, attempts, now).kind !== "retry") return undefined;
    const invocationRecord = await this.#read(original.invocation);
    const snapshot = invocationRecord.value as unknown as InvocationSnapshot;
    if (terminal(snapshot) || snapshot.control !== "running") return undefined;
    readSet.push({ object: invocationRecord.object, revision: invocationRecord.revision });
    const sourceReservation = (await this.#read(original.reservation))
      .value as unknown as ReservationRecord;
    if (sourceReservation.maxUnits !== 0 && !this.options.budget)
      throw executionError("CAPABILITY_DENIED", "Retry reservation requires a budget ledger");
    const attemptId = `${effect.effectId}/attempt/${attempts.length + 1}`;
    const reservationId = `${attemptId}/reservation`;
    const retryRef = this.#associated(
      "Outbox",
      original.invocation,
      `${original.commandId}/attempt/${attempts.length + 1}`,
    );
    const attempt: AttemptRecord = {
      attemptId,
      effectId: effect.effectId,
      runnerEpoch: this.options.runnerEpoch,
      state: "prepared",
      reservationId,
      result: null,
    };
    const reservation: ReservationRecord = {
      ...sourceReservation,
      attemptId,
      reservationId,
      actualUnits: null,
      status: "reserved",
    };
    const intent = {
      ...original,
      attempt: this.#ref("Attempt", attemptId),
      reservation: this.#ref("Reservation", reservationId),
      status: "prepared",
    };
    const budgetPlan = this.options.budget
      ? await this.options.budget.ledger.plan([
          {
            budgetId:
              sourceReservation.ancestorBudgetIds[0] ??
              this.options.budget.scope(original.invocation),
            reservation,
            reservationRef: intent.reservation,
            attemptRef: intent.attempt,
          },
        ])
      : undefined;
    await this.options.store.commit(this.options.context, {
      commitKey: `retry/${attemptId}`,
      readSet: [...readSet, ...(budgetPlan?.readSet ?? [])],
      events: [],
      writes: [
        { kind: "create", object: intent.attempt, value: json(attempt) },
        {
          kind: "create",
          object: intent.reservation,
          value: json(budgetPlan?.reservations[0] ?? reservation),
        },
        { kind: "create", object: retryRef, value: json(intent) },
        this.#replace(index, { objects: [...objects, retryRef] }),
        ...(budgetPlan?.writes ?? []),
      ],
    });
    return retryRef;
  }
  async pump(runtime: ExecutionService): Promise<void> {
    for (const ref of await this.intents()) {
      await this.dispatch(ref);
      const intent = (await this.#read(ref)).value as unknown as OutboxIntent;
      if (
        intent.status === "resolved" &&
        !(await runtime.snapshot(intent.invocation)).unresolvedEffectIds.length
      )
        await runtime.step(intent.invocation, `effect:${intent.commandId}`);
    }
  }
}
