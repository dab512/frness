import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, freezeJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  DefinitionRef,
  ExecutionContext,
  InvocationReceipt,
  InvocationRequest,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  ProtocolError,
  RecordWrite,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import type {
  AgentLaunchDecision,
  AgentRuntimeEvent,
  AgentTurnInput,
  NativeAgentSession,
} from "../../../specs/fractal-harness/standard-contracts.js";
import type { AgentTransport, TransportEvent } from "./transport.js";
import { startTurn, type TurnOutcome } from "./turn.js";

export interface ProviderBinding {
  readonly implementation: DefinitionRef;
  readonly eventType: TypeRef;
  readonly configuration: Json;
  readonly transport: AgentTransport;
}
export interface EventObserver {
  observe(event: { readonly session: ObjectRef; readonly event: ObjectRecord }): Promise<void>;
}
export interface CliRuntimeOptions {
  readonly cut?: (value: {
    readonly point:
      | "after_accept"
      | "before_spawn"
      | "after_spawn"
      | "before_event_commit"
      | "after_terminal_commit";
    readonly turn: ObjectRef;
    readonly pid: number | null;
  }) => Promise<void>;
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly instanceId: string;
  readonly assemblyRevision: string;
  readonly workspace: string;
  readonly types: (name: string) => TypeRef;
  readonly provider: ProviderBinding;
  readonly validate: (type: TypeRef, value: unknown) => void;
  readonly gate?: { check(input: AgentTurnInput): Promise<AgentLaunchDecision> };
  readonly observers?: readonly EventObserver[];
}
interface Turn {
  request: ObjectRef;
  session: ObjectRef;
  phase: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  text: string;
  result: string | null;
  error: ProtocolError | null;
}
type RuntimeEvent =
  | Exclude<TransportEvent, { kind: "terminal" }>
  | { readonly kind: "outcome"; readonly outcome: TurnOutcome };
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function error(code: string): ProtocolError {
  return { code, message: "CLI operation could not complete", details: null, retryable: false };
}

/** Basic process/session lifecycle. Policy and derived event data belong to optional children. */
export class CliRuntime {
  #active = new Map<string, ReturnType<typeof startTurn>>();
  #work = new Map<string, Promise<void>>();
  #observerWork = new Set<Promise<void>>();
  #ingress = Promise.resolve();
  #cancelled = new Set<string>();
  #updates = new Map<string, Promise<void>>();
  constructor(readonly options: CliRuntimeOptions) {}
  #ref(type: string, id: string): ObjectRef {
    return {
      storeId: this.options.storeId,
      namespaceId: this.options.namespaceId,
      objectId: `${type}/${id}`,
      type: this.options.types(type),
    };
  }
  #read(ref: ObjectRef, revision?: string): Promise<ObjectRecord> {
    this.#authorize(ref);
    return this.options.store.read(this.options.context, ref, revision);
  }
  #authorize(ref: ObjectRef, type?: string): void {
    if (
      ref.storeId !== this.options.storeId ||
      ref.namespaceId !== this.options.namespaceId ||
      (type && definitionKey(ref.type) !== definitionKey(this.options.types(type)))
    )
      fail("CAPABILITY_DENIED");
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
  invoke(request: InvocationRequest): Promise<InvocationReceipt> {
    const accepted = this.#ingress.then(() => this.#accept(freezeJson(structuredClone(request))));
    this.#ingress = accepted.then(
      () => {},
      () => {},
    );
    return accepted;
  }
  async #accept(request: InvocationRequest): Promise<InvocationReceipt> {
    this.options.validate(this.options.types("Request"), request);
    if (
      request.targetInstanceId !== this.options.instanceId ||
      request.assemblyRevision !== this.options.assemblyRevision
    )
      fail("CAPABILITY_DENIED");
    if (definitionKey(request.operation.contract) !== definitionKey(this.options.types("Runner")))
      fail("CONTRACT_MISMATCH");
    const operation = request.operation.operation;
    if (!["run", "resume", "interrupt"].includes(operation)) fail("UNSUPPORTED_OPERATION");
    this.options.validate(
      this.options.types(
        operation === "run"
          ? "RunInput"
          : operation === "resume"
            ? "ResumeInput"
            : "InterruptInput",
      ),
      request.input,
    );
    const id = hash([
      this.options.context.principalId,
      this.options.context.scopeId,
      request.targetInstanceId,
      request.operation,
      request.idempotencyKey,
    ]);
    const requestRef = this.#ref("Request", id);
    const receiptRef = this.#ref("Receipt", id);
    const previous = await this.#maybe(receiptRef);
    if (previous) {
      const receipt = previous.value as unknown as InvocationReceipt;
      if (canonicalJson((await this.#read(receipt.request)).value) !== canonicalJson(request))
        fail("IDEMPOTENCY_CONFLICT");
      return receipt;
    }
    if (operation !== "run") return this.#action(request, requestRef, receiptRef, id);
    const input = request.input as { readonly prompt: string; readonly session?: ObjectRef | null };
    const turnRef = this.#ref("Turn", id);
    const sessionRef = input.session ?? this.#ref("Session", hash([id, "session"]));
    this.#authorize(sessionRef, "Session");
    const sessionRecord = input.session ? await this.#read(sessionRef) : undefined;
    let session: NativeAgentSession;
    const writes: RecordWrite[] = [];
    if (sessionRecord) {
      session = sessionRecord.value as unknown as NativeAgentSession;
      if (session.activeTurnId !== null) fail("SESSION_BUSY");
      if (definitionKey(session.adapter) !== definitionKey(this.options.provider.implementation))
        fail("PINNED_DEPENDENCY_MISSING");
    } else {
      const configRef = this.#ref("ConfigurationSnapshot", id);
      const workspaceRef = this.#ref("Workspace", id);
      const configRevision = randomUUID();
      const workspaceRevision = randomUUID();
      writes.push(
        {
          kind: "create",
          object: configRef,
          revision: configRevision,
          value: json({
            adapter: this.options.provider.implementation,
            configuration: this.options.provider.configuration,
          }),
        },
        {
          kind: "create",
          object: workspaceRef,
          revision: workspaceRevision,
          value: { path: this.options.workspace },
        },
      );
      session = {
        adapter: this.options.provider.implementation,
        configuration: { object: configRef, revision: configRevision },
        workspace: { object: workspaceRef, revision: workspaceRevision },
        nativeHandle: null,
        metadata: {},
        activeTurnId: null,
        eventCursor: null,
      };
    }
    const turn: Turn = {
      request: requestRef,
      session: sessionRef,
      phase: "queued",
      text: "",
      result: null,
      error: null,
    };
    const sessionRevision = randomUUID();
    const nextSession = { ...session, activeTurnId: turnRef.objectId };
    writes.push(
      sessionRecord
        ? { ...this.#replace(sessionRecord, nextSession), revision: sessionRevision }
        : {
            kind: "create",
            object: sessionRef,
            revision: sessionRevision,
            value: json(nextSession),
          },
      { kind: "create", object: turnRef, value: json(turn) },
      { kind: "create", object: requestRef, value: json(request) },
      { kind: "create", object: this.#ref("EventLog", id), value: { sequence: 0 } },
    );
    const receipt = { request: requestRef, invocation: turnRef };
    writes.push({ kind: "create", object: receiptRef, value: json(receipt) });
    const indexRef = this.#ref("TurnIndex", "index");
    const index = await this.#maybe(indexRef);
    const turns = index ? (index.value as unknown as { turns: ObjectRef[] }).turns : [];
    writes.push(
      index
        ? this.#replace(index, { turns: [...turns, turnRef] })
        : { kind: "create", object: indexRef, value: json({ turns: [turnRef] }) },
    );
    await this.options.store.commit(this.options.context, {
      commitKey: `cli/accept/${id}`,
      readSet: [],
      events: [],
      writes,
    });
    await this.options.cut?.({ point: "after_accept", turn: turnRef, pid: null });
    const work = this.#run(
      turnRef,
      {
        session: { object: sessionRef, revision: sessionRevision },
        clientTurnId: turnRef.objectId,
        prompt: input.prompt,
        sources: [],
      },
      session,
    ).finally(() => {
      this.#work.delete(turnRef.objectId);
      this.#cancelled.delete(turnRef.objectId);
    });
    this.#work.set(turnRef.objectId, work);
    void work.catch(() => {});
    return receipt;
  }
  async #action(
    request: InvocationRequest,
    requestRef: ObjectRef,
    receiptRef: ObjectRef,
    id: string,
  ): Promise<InvocationReceipt> {
    const input = request.input as { session?: ObjectRef; turn?: ObjectRef };
    let result: unknown = null;
    if (request.operation.operation === "resume") result = await this.resume(input.session!);
    else await this.interrupt(input.turn!);
    const action = this.#ref("Action", id);
    const receipt = { request: requestRef, invocation: action };
    await this.options.store.commit(this.options.context, {
      commitKey: `cli/action/${id}`,
      readSet: [],
      events: [],
      writes: [
        { kind: "create", object: requestRef, value: json(request) },
        {
          kind: "create",
          object: action,
          value: json({ request: requestRef, phase: "succeeded", result, error: null }),
        },
        { kind: "create", object: receiptRef, value: json(receipt) },
      ],
    });
    return receipt;
  }
  async #run(
    turnRef: ObjectRef,
    input: AgentTurnInput,
    originalSession: NativeAgentSession,
  ): Promise<void> {
    try {
      if (this.options.gate) {
        const decision = await this.options.gate.check(input);
        this.options.validate(this.options.types("GateDecision"), decision);
        if (decision.kind === "deny") {
          await this.#finish(turnRef, {
            status: "failed",
            text: "",
            nativeHandle: originalSession.nativeHandle,
            errorCode: decision.error.code,
          });
          return;
        }
      }
      if (this.#cancelled.has(turnRef.objectId)) return;
      const turnRecord = await this.#read(turnRef);
      const turn = turnRecord.value as unknown as Turn;
      await this.options.store.commit(this.options.context, {
        commitKey: `cli/start/${turnRef.objectId}`,
        readSet: [],
        events: [],
        writes: [this.#replace(turnRecord, { ...turn, phase: "running" })],
      });
      const workspace = (
        await this.#read(originalSession.workspace.object, originalSession.workspace.revision)
      ).value as { path: string };
      if (this.#cancelled.has(turnRef.objectId)) return;
      await this.options.cut?.({ point: "before_spawn", turn: turnRef, pid: null });
      const process = startTurn(
        this.options.provider.transport,
        { prompt: input.prompt, cwd: workspace.path, nativeHandle: originalSession.nativeHandle },
        async (event) => {
          if (event.kind !== "terminal") await this.#event(turnRef, event);
        },
      );
      this.#active.set(turnRef.objectId, process);
      await this.options.cut?.({ point: "after_spawn", turn: turnRef, pid: process.pid ?? null });
      const outcome = await process.done;
      this.#active.delete(turnRef.objectId);
      await this.#finish(turnRef, outcome);
    } catch (failure) {
      if (this.#cancelled.has(turnRef.objectId)) return;
      const code =
        failure instanceof Error && "code" in failure && typeof failure.code === "string"
          ? failure.code
          : "CLI_EXECUTION_FAILED";
      if (this.#active.has(turnRef.objectId)) throw failure;
      await this.#finish(turnRef, {
        status: "failed",
        text: "",
        nativeHandle: originalSession.nativeHandle,
        errorCode: code,
      });
    }
  }
  #event(turn: ObjectRef, value: RuntimeEvent): Promise<void> {
    const update = (this.#updates.get(turn.objectId) ?? Promise.resolve()).then(() =>
      this.#publish(turn, value),
    );
    this.#updates.set(
      turn.objectId,
      update.catch(() => {}),
    );
    return update;
  }
  async #publish(turnRef: ObjectRef, value: RuntimeEvent): Promise<void> {
    const turnRecord = await this.#read(turnRef);
    const turn = turnRecord.value as unknown as Turn;
    if (value.kind === "outcome" && !["queued", "running"].includes(turn.phase)) return;
    const sessionRecord = await this.#read(turn.session);
    const session = sessionRecord.value as unknown as NativeAgentSession;
    const logRef = this.#ref("EventLog", turnRef.objectId.slice("Turn/".length));
    const logRecord = await this.#read(logRef);
    const sequence = (logRecord.value as { sequence: number }).sequence;
    const eventId = hash([turnRef.objectId, sequence]);
    const eventRef = this.#ref("Event", eventId);
    const common = { eventId, clientTurnId: turnRef.objectId, nativeTurnId: null };
    const event: AgentRuntimeEvent =
      value.kind === "outcome"
        ? {
            ...common,
            kind: "terminal",
            status: value.outcome.status,
            result: value.outcome.status === "completed" ? value.outcome.text : null,
            errorCode: value.outcome.errorCode,
          }
        : value.kind === "provider"
          ? {
              ...common,
              kind: "provider",
              type: this.options.provider.eventType,
              value: value.value,
            }
          : value.kind === "session"
            ? { ...common, kind: "session", nativeHandle: value.handle, metadata: {} }
            : { ...common, kind: "text", delta: value.delta };
    const recordValue = json({ session: turn.session, turn: turnRef, event });
    const revision = randomUUID();
    await this.options.cut?.({
      point: "before_event_commit",
      turn: turnRef,
      pid: this.#active.get(turnRef.objectId)?.pid ?? null,
    });
    await this.options.store.commit(this.options.context, {
      commitKey: `cli/event/${eventId}`,
      readSet: [],
      events: [],
      writes: [
        { kind: "create", object: eventRef, revision, value: recordValue },
        this.#replace(logRecord, { sequence: sequence + 1 }),
        this.#replace(sessionRecord, {
          ...session,
          ...(value.kind === "session" ? { nativeHandle: value.handle } : {}),
          ...(value.kind === "outcome"
            ? { nativeHandle: value.outcome.nativeHandle, activeTurnId: null }
            : {}),
          eventCursor: eventRef.objectId,
        }),
        this.#replace(turnRecord, {
          ...turn,
          ...(value.kind === "text" ? { text: turn.text + value.delta } : {}),
          ...(value.kind === "outcome"
            ? {
                phase: value.outcome.status,
                text: value.outcome.text || turn.text,
                result: value.outcome.status === "completed" ? value.outcome.text : null,
                error: value.outcome.errorCode ? error(value.outcome.errorCode) : null,
              }
            : {}),
        }),
      ],
    });
    this.#observe(turn.session, { object: eventRef, revision, value: recordValue });
    if (value.kind === "outcome")
      await this.options.cut?.({ point: "after_terminal_commit", turn: turnRef, pid: null });
  }
  #observe(session: ObjectRef, event: ObjectRecord): void {
    for (const observer of this.options.observers ?? []) {
      const work = Promise.resolve()
        .then(() => observer.observe(freezeJson(structuredClone({ session, event }))))
        .catch(() => {})
        .finally(() => {
          this.#observerWork.delete(work);
        });
      this.#observerWork.add(work);
    }
  }
  async #finish(turnRef: ObjectRef, outcome: TurnOutcome): Promise<void> {
    await this.#event(turnRef, { kind: "outcome", outcome });
  }
  async resume(session: ObjectRef): Promise<NativeAgentSession> {
    this.#authorize(session, "Session");
    const value = (await this.#read(session)).value as unknown as NativeAgentSession;
    if (!this.options.provider.transport.capabilities.resume) fail("UNSUPPORTED_OPERATION");
    if (definitionKey(value.adapter) !== definitionKey(this.options.provider.implementation))
      fail("PINNED_DEPENDENCY_MISSING");
    return value;
  }
  async recover(): Promise<void> {
    const index = await this.#maybe(this.#ref("TurnIndex", "index"));
    for (const ref of index ? (index.value as unknown as { turns: ObjectRef[] }).turns : []) {
      const record = await this.#read(ref);
      const turn = record.value as unknown as Turn;
      if (!["queued", "running"].includes(turn.phase) || this.#work.has(ref.objectId)) continue;
      const sessionRecord = await this.#read(turn.session);
      const session = sessionRecord.value as unknown as NativeAgentSession;
      await this.options.store.commit(this.options.context, {
        commitKey: `cli/recover/${ref.objectId}`,
        readSet: [],
        events: [],
        writes: [
          this.#replace(record, {
            ...turn,
            phase: turn.phase === "queued" ? "failed" : "unknown",
            error: error(
              turn.phase === "queued" ? "INTERRUPTED_BEFORE_SPAWN" : "PROCESS_OUTCOME_UNKNOWN",
            ),
          }),
          ...(turn.phase === "queued"
            ? [this.#replace(sessionRecord, { ...session, activeTurnId: null })]
            : []),
        ],
      });
    }
  }
  async interrupt(turn: ObjectRef): Promise<void> {
    this.#authorize(turn, "Turn");
    const record = (await this.#read(turn)).value as unknown as Turn;
    if (!["queued", "running"].includes(record.phase)) return;
    this.#cancelled.add(turn.objectId);
    const process = this.#active.get(turn.objectId);
    if (process) {
      await process.interrupt();
      await this.#work.get(turn.objectId);
    } else {
      const session = (await this.#read(record.session)).value as unknown as NativeAgentSession;
      await this.#finish(turn, {
        status: "cancelled",
        text: "",
        nativeHandle: session.nativeHandle,
        errorCode: null,
      });
    }
  }
  async idle(): Promise<void> {
    await Promise.all([...this.#work.values()]);
  }
  async observersIdle(): Promise<void> {
    await Promise.all([...this.#observerWork]);
  }
  async read(ref: ObjectRef, revision?: string): Promise<ObjectRecord> {
    return this.#read(ref, revision);
  }
}
