import { createHash } from "node:crypto";
import { canonicalJson, freezeJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  Assembly,
  CommitBatch,
  ComponentInstance,
  ContractDefinition,
  DefinitionRef,
  ExecutionContext,
  ImplementationDefinition,
  InvocationReceipt,
  InvocationRequest,
  InvocationSnapshot,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  ProtocolError,
  RecordWrite,
  ReducerCommand,
  ReducerEvent,
  ReducerModule,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { InvocationControl } from "./control.js";
import { invocationIdentity } from "./idempotency.js";
import type { CrashCut, DurableOutbox } from "./outbox.js";
import { executionError, initialize, type ReducerValidation, transition } from "./reducer.js";
import { type RepositoryBridge, RepositoryUnavailable } from "./repository.js";

interface RegistryCapability {
  get(ref: DefinitionRef): { readonly value: Json };
  validate(type: TypeRef, value: unknown): void;
}
interface ResolvedInvocation {
  assembly: Assembly;
  instance: ComponentInstance;
  implementation: ImplementationDefinition;
  validation: ReducerValidation;
}
export interface ExecutionOptions {
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly registry: RegistryCapability;
  readonly types: (name: string) => TypeRef;
  readonly assembly: (revision: string) => Assembly;
  readonly reducer: (implementation: DefinitionRef, instanceId: string) => ReducerModule;
  readonly outbox?: DurableOutbox;
  readonly repository?: RepositoryBridge;
  readonly cut?: (point: CrashCut) => Promise<void>;
}
interface InvocationState {
  invocation: ObjectRef;
  request: ObjectRef;
  implementation: DefinitionRef;
  configuration: Json;
  state: Json;
  steps: number;
  pendingCommands: string[];
  issuedCommands: string[];
  parentInvocation: ObjectRef | null;
  parentCommandId: string | null;
  depth: number;
  inboxIds: string[];
  awaitingInputs: Record<string, TypeRef>;
  pendingKinds: Record<string, "callChild" | "effect" | "awaitInput">;
  initialState: Json;
  initialDigest: string;
  trace: {
    inbox: { object: ObjectRef; revision: string };
    commands: ObjectRef;
    stateDigest: string;
    commandDigest: string;
  }[];
}
interface Inbox {
  invocation: ObjectRef;
  event: ReducerEvent;
  consumed: boolean;
  error: ProtocolError | null;
}
interface CommandRecord {
  invocation: ObjectRef;
  eventId: string;
  commands: ReducerCommand[];
}
interface ChildLink {
  parent: ObjectRef;
  commandId: string;
  child: ObjectRef;
  delivered: boolean;
}
type MutableSnapshot = { -readonly [K in keyof InvocationSnapshot]: InvocationSnapshot[K] };
const hash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const terminal = (snapshot: InvocationSnapshot): boolean =>
  ["succeeded", "failed", "cancelled"].includes(snapshot.phase);

export class ExecutionService {
  readonly #options: ExecutionOptions;
  readonly controls: InvocationControl;
  constructor(options: ExecutionOptions) {
    this.#options = { ...options, context: freezeJson(structuredClone(options.context)) };
    this.controls = options.outbox?.control ?? new InvocationControl(options);
  }
  #ref(type: string, id: string): ObjectRef {
    return {
      storeId: this.#options.storeId,
      namespaceId: this.#options.namespaceId,
      objectId: `${type}/${id}`,
      type: this.#options.types(type),
    };
  }
  #assertInvocation(ref: ObjectRef): void {
    if (
      ref.storeId !== this.#options.storeId ||
      ref.namespaceId !== this.#options.namespaceId ||
      definitionKey(ref.type) !== definitionKey(this.#options.types("Invocation"))
    )
      throw executionError("CAPABILITY_DENIED", "Invocation is not accessible");
  }
  #associated(type: string, invocation: ObjectRef, suffix = ""): ObjectRef {
    this.#assertInvocation(invocation);
    return this.#ref(type, `${invocation.objectId}${suffix ? `/${suffix}` : ""}`);
  }
  #read(ref: ObjectRef): Promise<ObjectRecord> {
    return this.#options.store.read(this.#options.context, ref);
  }
  async #maybeRead(ref: ObjectRef): Promise<ObjectRecord | undefined> {
    try {
      return await this.#read(ref);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return undefined;
      throw error;
    }
  }
  #resolve(request: InvocationRequest): ResolvedInvocation {
    const assembly = this.#options.assembly(request.assemblyRevision);
    if (assembly.revision !== request.assemblyRevision)
      throw executionError("PINNED_DEPENDENCY_MISSING", "Assembly revision does not match");
    const instance = assembly.instances.find(
      (item) => item.instanceId === request.targetInstanceId,
    );
    if (!instance || instance.scopeId !== this.#options.context.scopeId)
      throw executionError("CAPABILITY_DENIED", "Target is outside the scope");
    const implementation = this.#options.registry.get(instance.implementation)
      .value as unknown as ImplementationDefinition;
    if (
      implementation.abi !== "reducer.v1" &&
      !(implementation.abi === "store.v1" && this.#options.repository)
    )
      throw executionError("UNKNOWN_ABI", "Target is not a reducer");
    if (
      !implementation.contracts.some(
        (ref) => definitionKey(ref) === definitionKey(request.operation.contract),
      )
    )
      throw executionError("CONTRACT_MISMATCH", "Operation contract is not exported by target");
    if (
      implementation.requiredCapabilities.some(
        (grant) => !this.#options.context.grants.includes(grant),
      )
    )
      throw executionError("CAPABILITY_DENIED", "Required capability is missing");
    const contract = this.#options.registry.get(request.operation.contract)
      .value as unknown as ContractDefinition;
    const operation = contract.operations[request.operation.operation];
    if (!operation) throw executionError("INVALID_INPUT", "Operation does not exist");
    this.#options.registry.validate(operation.input, request.input);
    this.#options.registry.validate(implementation.configurationType, instance.configuration);
    return {
      assembly,
      instance,
      implementation,
      validation: {
        validate: (type, value) => this.#options.registry.validate(type, value),
        stateType: implementation.stateType,
        outputType: operation.output,
        commandType: this.#options.types("Command"),
      },
    };
  }
  async submit(
    input: InvocationRequest,
    lineage?: { readonly parent: ObjectRef; readonly depth: number; readonly commandId?: string },
  ): Promise<InvocationReceipt> {
    this.#options.registry.validate(this.#options.types("Request"), input);
    const request = freezeJson(structuredClone(input));
    const resolved = this.#resolve(request);
    if (resolved.implementation.abi === "store.v1" && (!lineage?.parent || !lineage.commandId))
      throw executionError(
        "CAPABILITY_DENIED",
        "Repository invocations require a connected parent command",
      );
    const { id } = invocationIdentity(this.#options.context, request);
    const receiptRef = this.#ref("Receipt", id);
    const previous = await this.#maybeRead(receiptRef);
    if (previous) {
      const receipt = previous.value as unknown as InvocationReceipt;
      if (canonicalJson((await this.#read(receipt.request)).value) !== canonicalJson(request))
        throw executionError("IDEMPOTENCY_CONFLICT", "Invocation key has a different payload");
      return receipt;
    }
    const parentGuard = lineage ? await this.controls.guard(lineage.parent) : undefined;
    if (parentGuard && !parentGuard.allowed)
      throw executionError("CAPABILITY_DENIED", "Ancestor control prevents a new child invocation");
    const state =
      resolved.implementation.abi === "store.v1"
        ? null
        : initialize(
            this.#options.reducer(resolved.instance.implementation, resolved.instance.instanceId),
            request.input,
            resolved.instance.configuration,
            resolved.validation,
          );
    this.#options.registry.validate(resolved.implementation.stateType, state);
    const receipt: InvocationReceipt = {
      request: this.#ref("Request", id),
      invocation: this.#ref("Invocation", id),
    };
    const snapshot: InvocationSnapshot = {
      ref: receipt.invocation,
      phase: "queued",
      control: "running",
      waitingReason: null,
      unresolvedEffectIds: [],
      result: null,
      error: null,
    };
    const event: ReducerEvent = {
      eventId: hash([id, "input"]),
      type: this.#options.types("InputReceived"),
      value: json({
        invocation: receipt.invocation,
        operation: request.operation,
        input: request.input,
      }),
    };
    const writes: RecordWrite[] = [
      { kind: "create", object: receipt.request, value: json(request) },
      { kind: "create", object: receipt.invocation, value: json(snapshot) },
      {
        kind: "create",
        object: this.#associated("State", receipt.invocation),
        value: json({
          invocation: receipt.invocation,
          request: receipt.request,
          implementation: resolved.instance.implementation,
          configuration: resolved.instance.configuration,
          state,
          steps: 0,
          pendingCommands: [],
          issuedCommands: [],
          parentInvocation: lineage?.parent ?? null,
          parentCommandId: lineage?.commandId ?? null,
          depth: lineage?.depth ?? 0,
          inboxIds: ["input"],
          awaitingInputs: {},
          pendingKinds: {},
          initialState: state,
          initialDigest: `sha256:${hash(state)}`,
          trace: [],
        }),
      },
      {
        kind: "create",
        object: this.#associated("Inbox", receipt.invocation, "input"),
        value: json({ invocation: receipt.invocation, event, consumed: false, error: null }),
      },
      { kind: "create", object: receiptRef, value: json(receipt) },
    ];
    const indexRef = this.#ref("InvocationIndex", "index");
    const index = await this.#maybeRead(indexRef);
    const objects = index ? (index.value as unknown as { objects: ObjectRef[] }).objects : [];
    writes.push(
      index
        ? {
            kind: "replace",
            object: indexRef,
            expectedRevision: index.revision,
            value: json({ objects: [...objects, receipt.invocation] }),
          }
        : { kind: "create", object: indexRef, value: json({ objects: [receipt.invocation] }) },
    );
    await this.#options.store.commit(this.#options.context, {
      commitKey: `submit/${id}`,
      readSet: parentGuard?.readSet ?? [],
      writes,
      events: [event],
    });
    return receipt;
  }
  async snapshot(invocation: ObjectRef): Promise<InvocationSnapshot> {
    this.#assertInvocation(invocation);
    return (await this.#read(invocation)).value as unknown as InvocationSnapshot;
  }
  async state(invocation: ObjectRef): Promise<Json> {
    return (
      (await this.#read(this.#associated("State", invocation))).value as unknown as InvocationState
    ).state;
  }
  async workflow(): Promise<{
    signature: string;
    invocations: readonly { ref: ObjectRef; inboxIds: readonly string[] }[];
  }> {
    const index = await this.#maybeRead(this.#ref("InvocationIndex", "index"));
    const objects = index ? (index.value as unknown as { objects: ObjectRef[] }).objects : [];
    const invocations: { ref: ObjectRef; inboxIds: readonly string[] }[] = [];
    const signature: unknown[] = [];
    for (const ref of objects) {
      const record = await this.#read(ref);
      const snapshot = record.value as unknown as InvocationSnapshot;
      const stateRecord = await this.#read(this.#associated("State", ref));
      signature.push([ref, record.revision, stateRecord.revision]);
      if (!terminal(snapshot) && snapshot.control === "running")
        invocations.push({
          ref,
          inboxIds: (stateRecord.value as unknown as InvocationState).inboxIds,
        });
    }
    return { invocations, signature: hash(signature) };
  }
  async pendingChildren(
    invocation: ObjectRef,
  ): Promise<readonly { inboxId: string; commandId: string }[]> {
    const state = (await this.#read(this.#associated("State", invocation)))
      .value as unknown as InvocationState;
    if (!(await this.controls.guard(invocation)).allowed) return [];
    const result: { inboxId: string; commandId: string }[] = [];
    for (const inboxId of state.inboxIds)
      for (const command of await this.commands(invocation, inboxId))
        if (command.kind === "callChild" && state.pendingCommands.includes(command.commandId))
          result.push({ inboxId, commandId: command.commandId });
    return result;
  }
  async inbox(invocation: ObjectRef, id: string): Promise<Inbox> {
    return (await this.#read(this.#associated("Inbox", invocation, id))).value as unknown as Inbox;
  }
  async commands(invocation: ObjectRef, id: string): Promise<readonly ReducerCommand[]> {
    const record = await this.#maybeRead(this.#associated("Commands", invocation, id));
    return record ? (record.value as unknown as CommandRecord).commands : [];
  }
  #childRequest(
    request: InvocationRequest,
    command: Extract<ReducerCommand, { kind: "callChild" }>,
    invocation: ObjectRef,
  ): InvocationRequest {
    const resolved = this.#resolve(request);
    const slot = resolved.implementation.slots.find((item) => item.name === command.slot);
    if (!slot) throw executionError("UNKNOWN_SLOT", "Child slot does not exist");
    if (
      (slot.collection === "single" &&
        (command.childKey !== undefined || command.childOrder !== undefined)) ||
      (slot.collection === "keyed" && (!command.childKey || command.childOrder !== undefined)) ||
      (slot.collection === "ordered" &&
        (command.childOrder === undefined || command.childKey !== undefined))
    )
      throw executionError("INVALID_INPUT", "Child selector does not match slot");
    const binding = resolved.assembly.bindings.find(
      (item) =>
        item.parentInstanceId === request.targetInstanceId &&
        item.slot === command.slot &&
        (slot.collection === "single" ||
          (slot.collection === "keyed"
            ? item.key === command.childKey
            : item.order === command.childOrder)),
    );
    if (!binding) throw executionError("CAPABILITY_DENIED", "No connected child at selector");
    const child: InvocationRequest = {
      targetInstanceId: binding.childInstanceId,
      assemblyRevision: request.assemblyRevision,
      operation: { contract: slot.accepts, operation: command.operation },
      input: command.input,
      idempotencyKey: `child/${hash([invocation.objectId, command.commandId])}`,
    };
    this.#resolve(child);
    if (
      this.#options.repository &&
      definitionKey(child.operation.contract) ===
        definitionKey(this.#options.repository.options.contract)
    )
      this.#options.repository.validate(child, command.commandId);
    return child;
  }
  async step(invocation: ObjectRef, inboxId: string): Promise<void> {
    this.#assertInvocation(invocation);
    const inboxRecord = await this.#read(this.#associated("Inbox", invocation, inboxId));
    const inbox = inboxRecord.value as unknown as Inbox;
    if (inbox.consumed) return;
    const invocationRecord = await this.#read(invocation);
    const snapshot = invocationRecord.value as unknown as InvocationSnapshot;
    if (terminal(snapshot) || snapshot.control !== "running") return;
    const controls = await this.controls.guard(invocation);
    if (!controls.allowed) return;
    if (snapshot.phase !== "active") {
      await this.#options.store.commit(this.#options.context, {
        commitKey: `active/${inbox.event.eventId}`,
        readSet: controls.readSet,
        events: [],
        writes: [
          {
            kind: "replace",
            object: invocation,
            expectedRevision: invocationRecord.revision,
            value: json({ ...snapshot, phase: "active", waitingReason: null }),
          },
        ],
      });
      return this.step(invocation, inboxId);
    }
    const stateRecord = await this.#read(this.#associated("State", invocation));
    const state = stateRecord.value as unknown as InvocationState;
    const requestRecord = await this.#read(state.request);
    const request = requestRecord.value as unknown as InvocationRequest;
    const resolved = this.#resolve(request);
    if (
      definitionKey(state.implementation) !== definitionKey(resolved.instance.implementation) ||
      canonicalJson(state.configuration) !== canonicalJson(resolved.instance.configuration)
    )
      throw executionError(
        "PINNED_DEPENDENCY_MISSING",
        "Pinned implementation or configuration changed",
      );
    let result: ReturnType<typeof transition>;
    let effects: { writes: RecordWrite[]; readSet: CommitBatch["readSet"] } = {
      writes: [],
      readSet: [],
    };
    try {
      this.#options.registry.validate(inbox.event.type, inbox.event.value);
      const module =
        resolved.implementation.abi === "store.v1"
          ? await this.#repositoryStep({
              invocation,
              request,
              resolved,
              state,
              inbox,
              controls: controls.readSet,
            })
          : this.#options.reducer(state.implementation, request.targetInstanceId);
      result = transition(
        module,
        state.state,
        inbox.event,
        state.configuration,
        resolved.validation,
      );
      for (const command of result.commands) {
        if (command.kind === "callChild") this.#childRequest(request, command, invocation);
        if (
          command.kind === "complete" &&
          (state.pendingCommands.length || snapshot.unresolvedEffectIds.length)
        )
          throw executionError("INVALID_COMMAND_BATCH", "Completion has unfinished work");
        if (command.kind === "effect") {
          if (!this.#options.outbox)
            throw executionError("UNKNOWN_ABI", "Effect bridge is not installed");
          this.#options.outbox.validate(resolved.assembly, request, invocation, command);
        }
        if ("commandId" in command && state.issuedCommands.includes(command.commandId))
          throw executionError("INVALID_COMMAND_BATCH", "Command identity was already issued");
      }
      effects =
        resolved.implementation.abi === "store.v1"
          ? { writes: [], readSet: [] }
          : ((await this.#options.outbox?.prepare(
              resolved.assembly,
              request,
              invocation,
              result.commands,
              { eventId: inbox.event.eventId, depth: state.depth },
            )) ?? { writes: [], readSet: [] });
    } catch (error) {
      if (error instanceof RepositoryUnavailable) throw error;
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "INVALID_OUTPUT";
      const protocol: ProtocolError = {
        code,
        message: "Reducer transition rejected",
        details: null,
        retryable: false,
      };
      const failure = { ...snapshot, phase: "failed", waitingReason: null, error: protocol };
      await this.#options.store.commit(this.#options.context, {
        commitKey: `poison/${inbox.event.eventId}`,
        readSet: [{ object: stateRecord.object, revision: stateRecord.revision }],
        events: [],
        writes: [
          {
            kind: "replace",
            object: invocation,
            expectedRevision: invocationRecord.revision,
            value: json(failure),
          },
          {
            kind: "replace",
            object: inboxRecord.object,
            expectedRevision: inboxRecord.revision,
            value: json({ ...inbox, consumed: true, error: protocol }),
          },
        ],
      });
      return;
    }
    const next: MutableSnapshot = { ...snapshot, phase: "active", waitingReason: null };
    if (state.pendingCommands.length) {
      next.phase = "waiting";
      next.waitingReason = Object.values(state.pendingKinds).includes("awaitInput")
        ? "input"
        : Object.values(state.pendingKinds).includes("callChild")
          ? "child"
          : "effect";
    }
    for (const command of result.commands) {
      if (command.kind === "complete") {
        next.phase = "succeeded";
        next.result = command.output;
      } else if (command.kind === "fail") {
        next.phase = "failed";
        next.error = command.error;
      } else if (command.kind === "callChild") {
        next.phase = "waiting";
        next.waitingReason = "child";
      } else if (command.kind === "awaitInput") {
        next.phase = "waiting";
        next.waitingReason = "input";
      } else if (command.kind === "effect") {
        next.phase = "waiting";
        next.waitingReason = "effect";
      }
    }
    const pending = result.commands.flatMap((command) =>
      "commandId" in command ? [command.commandId] : [],
    );
    const hasEffects = result.commands.some((command) => command.kind === "effect");
    if (hasEffects) await this.#options.cut?.("before_prepare_commit");
    await this.#options.store.commit(this.#options.context, {
      commitKey: `step/${inbox.event.eventId}`,
      readSet: [
        { object: requestRecord.object, revision: requestRecord.revision },
        ...effects.readSet,
        ...controls.readSet,
      ],
      events: [],
      writes: [
        {
          kind: "replace",
          object: invocation,
          expectedRevision: invocationRecord.revision,
          value: json(next),
        },
        {
          kind: "replace",
          object: stateRecord.object,
          expectedRevision: stateRecord.revision,
          value: json({
            ...state,
            state: result.state,
            steps: state.steps + 1,
            pendingCommands: [...state.pendingCommands, ...pending],
            issuedCommands: [...state.issuedCommands, ...pending],
            pendingKinds: {
              ...state.pendingKinds,
              ...Object.fromEntries(
                result.commands.flatMap((command) =>
                  "commandId" in command ? [[command.commandId, command.kind]] : [],
                ),
              ),
            },
            awaitingInputs: {
              ...state.awaitingInputs,
              ...Object.fromEntries(
                result.commands.flatMap((command) =>
                  command.kind === "awaitInput" ? [[command.commandId, command.inputType]] : [],
                ),
              ),
            },
            trace: [
              ...state.trace,
              {
                inbox: { object: inboxRecord.object, revision: inboxRecord.revision },
                commands: this.#associated("Commands", invocation, inboxId),
                stateDigest: `sha256:${hash(result.state)}`,
                commandDigest: `sha256:${hash(result.commands)}`,
              },
            ],
          }),
        },
        {
          kind: "replace",
          object: inboxRecord.object,
          expectedRevision: inboxRecord.revision,
          value: json({ ...inbox, consumed: true }),
        },
        {
          kind: "create",
          object: this.#associated("Commands", invocation, inboxId),
          value: json({ invocation, eventId: inbox.event.eventId, commands: result.commands }),
        },
        ...effects.writes,
      ],
    });
    if (hasEffects) await this.#options.cut?.("after_prepare_commit");
    else await this.#options.cut?.("after_reduce_commit");
  }
  async #repositoryStep(input: {
    invocation: ObjectRef;
    request: InvocationRequest;
    resolved: ResolvedInvocation;
    state: InvocationState;
    inbox: Inbox;
    controls: CommitBatch["readSet"];
  }): Promise<ReducerModule> {
    const { invocation, request, resolved, state, inbox, controls } = input;
    if (!state.parentInvocation || !state.parentCommandId)
      throw executionError("CAPABILITY_DENIED", "Repository parent command is missing");
    let parentState = (await this.#read(this.#associated("State", state.parentInvocation)))
      .value as unknown as InvocationState;
    let parentRequest = (await this.#read(parentState.request))
      .value as unknown as InvocationRequest;
    const seen = new Set<string>();
    while (
      definitionKey(parentRequest.operation.contract) ===
        definitionKey(this.#options.repository!.options.contract) &&
      parentState.parentInvocation
    ) {
      const key = canonicalJson(parentState.parentInvocation);
      if (seen.has(key))
        throw executionError("CAPABILITY_DENIED", "Repository authority lineage contains a cycle");
      seen.add(key);
      parentState = (await this.#read(this.#associated("State", parentState.parentInvocation)))
        .value as unknown as InvocationState;
      parentRequest = (await this.#read(parentState.request)).value as unknown as InvocationRequest;
    }
    const parent = this.#resolve(parentRequest).instance;
    const dispatch = this.#ref("RepositoryDispatch", inbox.event.eventId);
    if (!(await this.#maybeRead(dispatch))) {
      const step = await this.#options.outbox?.prepare(resolved.assembly, request, invocation, [], {
        eventId: inbox.event.eventId,
        depth: state.depth,
      });
      try {
        await this.#options.store.commit(this.#options.context, {
          commitKey: `repository-dispatch/${inbox.event.eventId}`,
          events: [],
          readSet: [...controls, ...(step?.readSet ?? [])],
          writes: [
            ...(step?.writes ?? []),
            {
              kind: "create",
              object: dispatch,
              value: json({ invocation, eventId: inbox.event.eventId }),
            },
          ],
        });
      } catch {
        throw new RepositoryUnavailable();
      }
    }
    const command = await this.#options.repository!.execute({
      request,
      child: resolved.instance,
      parent,
      principal: this.#options.context,
      parentInvocation: state.parentInvocation,
      commandId: state.parentCommandId,
      outputType: resolved.validation.outputType,
    });
    return { initialize: () => null, reduce: (state) => ({ state, commands: [command] }) };
  }
  async resume(invocation: ObjectRef, key: string): Promise<InvocationSnapshot> {
    this.#assertInvocation(invocation);
    const state = (await this.#read(this.#associated("State", invocation)))
      .value as unknown as InvocationState;
    const request = (await this.#read(state.request)).value as unknown as InvocationRequest;
    try {
      const pinned = this.#resolve(request);
      if (
        definitionKey(pinned.instance.implementation) !== definitionKey(state.implementation) ||
        canonicalJson(pinned.instance.configuration) !== canonicalJson(state.configuration)
      )
        throw new Error("Pinned configuration changed");
      if (pinned.implementation.abi === "store.v1")
        this.#options.repository!.options.store(pinned.instance);
      else {
        const module = this.#options.reducer(state.implementation, request.targetInstanceId);
        if (typeof module.initialize !== "function" || typeof module.reduce !== "function")
          throw new Error("Pinned module is not available");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "CAPABILITY_DENIED")
        throw error;
      throw executionError(
        "PINNED_DEPENDENCY_MISSING",
        "Cannot resume without the pinned schemas, assembly and reducer",
      );
    }
    return this.controls.apply(invocation, "resume", key);
  }
  async provideInput(
    invocation: ObjectRef,
    commandId: string,
    input: Json,
    key: string,
  ): Promise<ObjectRef> {
    this.#assertInvocation(invocation);
    if (!/^[\x00-\x7f]{1,128}$/.test(key))
      throw executionError("INVALID_INPUT", "Input key must contain 1 to 128 ASCII characters");
    const id = hash([
      this.#options.context.principalId,
      this.#options.context.scopeId,
      invocation,
      key,
    ]);
    const deliveryRef = this.#ref("InputDelivery", id);
    const previous = await this.#maybeRead(deliveryRef);
    if (previous) {
      const delivery = previous.value as unknown as {
        commandId: string;
        input: Json;
        inbox: ObjectRef;
      };
      if (
        delivery.commandId !== commandId ||
        canonicalJson(delivery.input) !== canonicalJson(input)
      )
        throw executionError("IDEMPOTENCY_CONFLICT", "Input key has a different body");
      return delivery.inbox;
    }
    const controls = await this.controls.guard(invocation);
    if (
      controls.records.some(
        (entry) => terminal(entry.snapshot) || entry.snapshot.control === "cancel_requested",
      )
    )
      throw executionError("CAPABILITY_DENIED", "Input is no longer accepted");
    const stateRecord = await this.#read(this.#associated("State", invocation));
    const state = stateRecord.value as unknown as InvocationState;
    const inputType = state.awaitingInputs[commandId];
    if (!inputType)
      throw executionError("INVALID_INPUT", "Invocation is not waiting for this input");
    this.#options.registry.validate(inputType, input);
    const inboxRef = this.#associated("Inbox", invocation, `input:${commandId}`);
    const event: ReducerEvent = {
      eventId: hash([invocation, commandId, "input"]),
      type: this.#options.types("InputProvided"),
      value: json({ commandId, input }),
    };
    await this.#options.store.commit(this.#options.context, {
      commitKey: `input/${id}`,
      readSet: controls.readSet,
      events: [event],
      writes: [
        {
          kind: "create",
          object: deliveryRef,
          value: json({ invocation, commandId, input, inbox: inboxRef }),
        },
        {
          kind: "create",
          object: inboxRef,
          value: json({ invocation, event, consumed: false, error: null }),
        },
        {
          kind: "replace",
          object: stateRecord.object,
          expectedRevision: stateRecord.revision,
          value: json({
            ...state,
            pendingCommands: state.pendingCommands.filter((id) => id !== commandId),
            pendingKinds: Object.fromEntries(
              Object.entries(state.pendingKinds).filter(([id]) => id !== commandId),
            ),
            awaitingInputs: Object.fromEntries(
              Object.entries(state.awaitingInputs).filter(([id]) => id !== commandId),
            ),
            inboxIds: [...state.inboxIds, `input:${commandId}`],
          }),
        },
      ],
    });
    return inboxRef;
  }
  async startChild(
    parent: ObjectRef,
    inboxId: string,
    commandId: string,
  ): Promise<InvocationReceipt> {
    const command = (await this.commands(parent, inboxId)).find(
      (item) => "commandId" in item && item.commandId === commandId,
    );
    if (!command || command.kind !== "callChild")
      throw executionError("INVALID_INPUT", "Command is not a child call");
    const snapshot = await this.snapshot(parent);
    if (terminal(snapshot) || snapshot.control !== "running")
      throw executionError("CAPABILITY_DENIED", "Parent cannot start new work");
    const state = (await this.#read(this.#associated("State", parent)))
      .value as unknown as InvocationState;
    const request = (await this.#read(state.request)).value as unknown as InvocationRequest;
    const receipt = await this.submit(this.#childRequest(request, command, parent), {
      parent,
      depth: state.depth + 1,
      commandId,
    });
    const link: ChildLink = { parent, commandId, child: receipt.invocation, delivered: false };
    const linkRef = this.#associated("ChildLink", parent, commandId);
    if (!(await this.#maybeRead(linkRef)))
      await this.#options.store.commit(this.#options.context, {
        commitKey: `link/${parent.objectId}/${commandId}`,
        readSet: [],
        events: [],
        writes: [{ kind: "create", object: linkRef, value: json(link) }],
      });
    return receipt;
  }
  async deliverChild(parent: ObjectRef, commandId: string, child: ObjectRef): Promise<void> {
    const linkRecord = await this.#read(this.#associated("ChildLink", parent, commandId));
    const link = linkRecord.value as unknown as ChildLink;
    if (canonicalJson(link.child) !== canonicalJson(child))
      throw executionError("CAPABILITY_DENIED", "Child identity does not match link");
    if (link.delivered) return;
    const childRecord = await this.#read(child);
    const childSnapshot = childRecord.value as unknown as InvocationSnapshot;
    if (!terminal(childSnapshot)) throw executionError("INVALID_INPUT", "Child is not terminal");
    const stateRecord = await this.#read(this.#associated("State", parent));
    const state = stateRecord.value as unknown as InvocationState;
    const event: ReducerEvent = {
      eventId: hash([parent, commandId, "completed"]),
      type: this.#options.types(
        childSnapshot.phase === "succeeded" ? "ChildCompleted" : "ChildFailed",
      ),
      value:
        childSnapshot.phase === "succeeded"
          ? json({ commandId, output: childSnapshot.result })
          : json({
              commandId,
              error: childSnapshot.error ?? {
                code: "CANCELLED",
                message: "Child was cancelled",
                details: null,
                retryable: false,
              },
            }),
    };
    await this.#options.store.commit(this.#options.context, {
      commitKey: `deliver/${event.eventId}`,
      readSet: [{ object: child, revision: childRecord.revision }],
      events: [event],
      writes: [
        {
          kind: "replace",
          object: linkRecord.object,
          expectedRevision: linkRecord.revision,
          value: json({ ...link, delivered: true }),
        },
        {
          kind: "replace",
          object: stateRecord.object,
          expectedRevision: stateRecord.revision,
          value: json({
            ...state,
            pendingCommands: state.pendingCommands.filter((id) => id !== commandId),
            pendingKinds: Object.fromEntries(
              Object.entries(state.pendingKinds).filter(([id]) => id !== commandId),
            ),
            inboxIds: [...state.inboxIds, `child:${commandId}`],
          }),
        },
        {
          kind: "create",
          object: this.#associated("Inbox", parent, `child:${commandId}`),
          value: json({
            invocation: parent,
            event,
            consumed: terminal(await this.snapshot(parent)),
            error: null,
          }),
        },
      ],
    });
  }
}
