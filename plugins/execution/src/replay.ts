import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  ContractDefinition,
  DefinitionRef,
  ExecutionContext,
  ImplementationDefinition,
  InvocationRequest,
  InvocationSnapshot,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  ReducerCommand,
  ReducerEvent,
  ReducerModule,
  TypeRef,
  VersionedObjectRef,
} from "../../../specs/fractal-harness/contracts.js";
import { executionError, initialize, transition } from "./reducer.js";

export interface ReplayOptions {
  readonly read: (
    context: ExecutionContext,
    ref: ObjectRef,
    revision?: string,
  ) => Promise<ObjectRecord>;
  readonly context: ExecutionContext;
  readonly types: (name: string) => TypeRef;
  readonly registry: {
    get(ref: DefinitionRef): { readonly value: Json };
    validate(type: TypeRef, value: unknown): void;
  };
  readonly reducer: (implementation: DefinitionRef) => ReducerModule;
  readonly repositoryExport?: (implementation: DefinitionRef) => ObjectStore;
  readonly createScratch: (
    path: string,
    type: TypeRef,
  ) => Promise<{
    readonly store: ObjectStore;
    readonly context: ExecutionContext;
    readonly frame: ObjectRef;
    readonly dispose: () => void | Promise<void>;
  }>;
}
interface RecordedState {
  request: ObjectRef;
  implementation: DefinitionRef;
  configuration: Json;
  state: Json;
  initialState: Json;
  initialDigest: string;
  steps: number;
  trace: readonly {
    readonly inbox: VersionedObjectRef;
    readonly commands: ObjectRef;
    readonly stateDigest: string;
    readonly commandDigest: string;
  }[];
}
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const divergence = () =>
  executionError(
    "REPLAY_DIVERGENCE",
    "Recorded reducer state or commands do not match pinned replay",
  );

/** Read capability only for production. No effect adapter, repository or event observer is connected. */
export class ReplayService {
  constructor(readonly options: ReplayOptions) {}
  async run(
    invocation: ObjectRef,
    scratchPath: string,
  ): Promise<{
    result: Json;
    transitions: number;
    externalCalls: number;
    productionWrites: number;
  }> {
    try {
      await lstat(scratchPath);
      throw executionError("INVALID_INPUT", "Replay requires a fresh scratch database");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const read = (ref: ObjectRef, revision?: string) =>
      this.options.read(this.options.context, ref, revision);
    const snapshot = (await read(invocation)).value as unknown as InvocationSnapshot;
    const stateRef: ObjectRef = {
      ...invocation,
      objectId: `State/${invocation.objectId}`,
      type: this.options.types("State"),
    };
    const recorded = (await read(stateRef)).value as unknown as RecordedState;
    const request = (await read(recorded.request)).value as unknown as InvocationRequest;
    this.options.registry.validate(this.options.types("Request"), request);
    const implementation = this.options.registry.get(recorded.implementation)
      .value as unknown as ImplementationDefinition;
    if (
      !implementation.contracts.some(
        (ref) => definitionKey(ref) === definitionKey(request.operation.contract),
      )
    )
      throw executionError("PINNED_DEPENDENCY_MISSING", "Pinned contract is not exported");
    const contract = this.options.registry.get(request.operation.contract)
      .value as unknown as ContractDefinition;
    const operation = contract.operations[request.operation.operation];
    if (!operation)
      throw executionError("PINNED_DEPENDENCY_MISSING", "Pinned operation is not available");
    this.options.registry.validate(operation.input, request.input);
    this.options.registry.validate(implementation.configurationType, recorded.configuration);
    let repositoryCommands: readonly ReducerCommand[] = [];
    let module: ReducerModule;
    if (implementation.abi === "store.v1") {
      const exported = this.options.repositoryExport?.(recorded.implementation);
      if (!exported || typeof exported.read !== "function" || typeof exported.commit !== "function")
        throw executionError(
          "PINNED_DEPENDENCY_MISSING",
          "Pinned repository export is unavailable for replay",
        );
      module = {
        initialize: () => null,
        reduce: (state) => ({ state, commands: repositoryCommands }),
      };
    } else module = this.options.reducer(recorded.implementation);
    const validation = {
      validate: (type: TypeRef, value: unknown) => this.options.registry.validate(type, value),
      stateType: implementation.stateType,
      outputType: operation.output,
      commandType: this.options.types("Command"),
    };
    let state: Json;
    try {
      state = initialize(module, request.input, recorded.configuration, validation);
    } catch {
      throw divergence();
    }
    if (
      digest(state) !== recorded.initialDigest ||
      canonicalJson(state) !== canonicalJson(recorded.initialState)
    )
      throw divergence();
    const allocation = await this.options.createScratch(
      scratchPath,
      this.options.types("ReplayFrame"),
    );
    const scratch = allocation.store;
    const scratchContext = allocation.context;
    const frame = allocation.frame;
    let result: Json = null;
    let terminalCommand: ReducerCommand | undefined;
    try {
      if (frame.storeId === invocation.storeId)
        throw executionError(
          "CAPABILITY_DENIED",
          "Replay scratch must be separate from production storage",
        );
      let receipt = await scratch.commit(scratchContext, {
        commitKey: "initialize",
        readSet: [],
        events: [],
        writes: [
          {
            kind: "create",
            object: frame,
            value: json({ source: invocation, position: 0, state, result }),
          },
        ],
      });
      if (recorded.trace.length !== recorded.steps) throw divergence();
      for (const [index, trace] of recorded.trace.entries()) {
        const inbox = (await read(trace.inbox.object, trace.inbox.revision)).value as unknown as {
          invocation: ObjectRef;
          event: ReducerEvent;
        };
        if (canonicalJson(inbox.invocation) !== canonicalJson(invocation)) throw divergence();
        this.options.registry.validate(inbox.event.type, inbox.event.value);
        const commands = (await read(trace.commands)).value as unknown as {
          eventId: string;
          commands: ReducerCommand[];
        };
        if (implementation.abi === "store.v1") {
          if (
            commands.commands.length !== 1 ||
            !["complete", "fail"].includes(commands.commands[0]!.kind)
          )
            throw divergence();
          repositoryCommands = commands.commands;
        }
        let next: ReturnType<typeof transition>;
        try {
          next = transition(module, state, inbox.event, recorded.configuration, validation);
        } catch {
          throw divergence();
        }
        if (
          commands.eventId !== inbox.event.eventId ||
          digest(next.commands) !== trace.commandDigest ||
          canonicalJson(next.commands) !== canonicalJson(commands.commands) ||
          digest(next.state) !== trace.stateDigest
        )
          throw divergence();
        state = next.state;
        terminalCommand =
          next.commands.find((command) => command.kind === "complete" || command.kind === "fail") ??
          terminalCommand;
        if (terminalCommand?.kind === "complete") result = terminalCommand.output;
        receipt = await scratch.commit(scratchContext, {
          commitKey: `replay/${index}`,
          readSet: [],
          events: [],
          writes: [
            {
              kind: "replace",
              object: frame,
              expectedRevision: receipt.records[0]!.revision,
              value: json({ source: invocation, position: index + 1, state, result }),
            },
          ],
        });
      }
      if (
        canonicalJson(state) !== canonicalJson(recorded.state) ||
        canonicalJson(result) !== canonicalJson(snapshot.result) ||
        (snapshot.phase === "succeeded" && terminalCommand?.kind !== "complete") ||
        (snapshot.phase === "failed" &&
          (terminalCommand?.kind !== "fail" ||
            canonicalJson(terminalCommand.error) !== canonicalJson(snapshot.error)))
      )
        throw divergence();
      return { result, transitions: recorded.trace.length, externalCalls: 0, productionWrites: 0 };
    } finally {
      await allocation.dispose();
    }
  }
}
