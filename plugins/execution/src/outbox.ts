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
import type { EffectBridge } from "./effect-adapter.js";
import type { ExecutionService } from "./ingress.js";
import { executionError } from "./reducer.js";

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
  readonly [key: string]: unknown;
}
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const terminal = (snapshot: InvocationSnapshot): boolean =>
  ["succeeded", "failed", "cancelled"].includes(snapshot.phase);

export class DurableOutbox {
  readonly bridge: EffectBridge;
  constructor(readonly options: OutboxOptions) {
    this.bridge = options.bridge;
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
    if (command.maxUnits !== 0)
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
  ): Promise<{ writes: RecordWrite[]; readSet: CommitBatch["readSet"] }> {
    const effects = commands.filter(
      (command): command is Extract<ReducerCommand, { kind: "effect" }> =>
        command.kind === "effect",
    );
    if (!effects.length) return { writes: [], readSet: [] };
    const indexRef = this.#ref("OutboxIndex", "index");
    const index = await this.#maybe(indexRef);
    const objects = index ? (index.value as unknown as { objects: ObjectRef[] }).objects : [];
    const writes: RecordWrite[] = [];
    for (const command of effects) {
      if (command.maxUnits !== 0)
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
        maxUnits: 0,
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
    }
    writes.push(
      index
        ? this.#replace(index, { objects })
        : { kind: "create", object: indexRef, value: json({ objects }) },
    );
    return { writes, readSet: [] };
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
    const reservationRecord = await this.#read(intent.reservation);
    const effectRecord = await this.#read(intent.effect);
    const effect = effectRecord.value as unknown as EffectDefinition;
    await this.options.store.commit(this.options.context, {
      commitKey: `dispatch/${attempt.attemptId}`,
      readSet: [
        { object: effectRecord.object, revision: effectRecord.revision },
        { object: reservationRecord.object, revision: reservationRecord.revision },
      ],
      events: [],
      writes: [
        this.#replace(attemptRecord, {
          ...attempt,
          state: "dispatched",
          runnerEpoch: this.options.runnerEpoch,
        }),
        this.#replace(outboxRecord, { ...intent, status: "dispatched" }),
        this.#replace(invocationRecord, {
          ...snapshot,
          unresolvedEffectIds: [...new Set([...snapshot.unresolvedEffectIds, effect.effectId])],
        }),
      ],
    });
    await this.options.cut?.("after_dispatch_commit_before_transport");
    const outcome = await this.bridge.execute(effect, attempt.attemptId, this.options.runnerEpoch);
    await this.options.cut?.("after_remote_accept_before_receipt");
    await this.complete(ref, outcome);
    await this.options.cut?.("after_receipt_commit_before_reduce");
  }
  async complete(ref: ObjectRef, outcome: EffectOutcome): Promise<void> {
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
    if (!["dispatched", "unknown"].includes(attempt.state))
      throw executionError("INVALID_INPUT", "Attempt has not been dispatched");
    const invocationRecord = await this.#read(intent.invocation);
    const snapshot = invocationRecord.value as unknown as InvocationSnapshot;
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
      this.#replace(
        reservationRecord,
        outcome.actualUnits === null
          ? reservation
          : { ...reservation, actualUnits: outcome.actualUnits, status: "settled" },
      ),
      this.#replace(invocationRecord, {
        ...snapshot,
        unresolvedEffectIds: snapshot.unresolvedEffectIds.filter((id) => id !== attempt.effectId),
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
        }),
        {
          kind: "create",
          object: this.#associated("Inbox", intent.invocation, `effect:${intent.commandId}`),
          value: json({ invocation: intent.invocation, event, consumed: false, error: null }),
        },
      );
    }
    await this.options.store.commit(this.options.context, {
      commitKey: `receipt/${attempt.attemptId}`,
      readSet: [],
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
  async pump(runtime: ExecutionService): Promise<void> {
    for (const ref of await this.intents()) {
      await this.dispatch(ref);
      const intent = (await this.#read(ref)).value as unknown as OutboxIntent;
      if (intent.status === "resolved")
        await runtime.step(intent.invocation, `effect:${intent.commandId}`);
    }
  }
}
