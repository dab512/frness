import { createHash } from "node:crypto";
import { canonicalJson } from "../../../packages/abi/src/json.js";
import { definitionKey } from "../../../packages/abi/src/references.js";
import type {
  CommitBatch,
  ExecutionContext,
  InvocationSnapshot,
  Json,
  ObjectRecord,
  ObjectRef,
  ObjectStore,
  TypeRef,
} from "../../../specs/fractal-harness/contracts.js";
import { executionError } from "./reducer.js";

export interface ControlOptions {
  readonly store: ObjectStore;
  readonly context: ExecutionContext;
  readonly storeId: string;
  readonly namespaceId: string;
  readonly types: (name: string) => TypeRef;
  readonly cancelPrepared?: (root: ObjectRef) => Promise<void>;
}
export interface ControlFence {
  readonly allowed: boolean;
  readonly records: readonly {
    readonly record: ObjectRecord;
    readonly snapshot: InvocationSnapshot;
  }[];
  readonly readSet: CommitBatch["readSet"];
}
interface ControlState {
  parentInvocation: ObjectRef | null;
  inboxIds: string[];
  issuedCommands: string[];
  readonly [key: string]: unknown;
}
const json = (value: unknown): Json => JSON.parse(canonicalJson(value)) as Json;
const terminal = (snapshot: InvocationSnapshot): boolean =>
  ["succeeded", "failed", "cancelled"].includes(snapshot.phase);

export class InvocationControl {
  constructor(readonly options: ControlOptions) {}
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
  async guard(invocation: ObjectRef): Promise<ControlFence> {
    const records: { record: ObjectRecord; snapshot: InvocationSnapshot }[] = [];
    const readSet: { object: ObjectRef; revision: string }[] = [];
    const seen = new Set<string>();
    let current: ObjectRef | null = invocation;
    while (current !== null) {
      if (
        current.storeId !== this.options.storeId ||
        current.namespaceId !== this.options.namespaceId ||
        definitionKey(current.type) !== definitionKey(this.options.types("Invocation"))
      )
        throw executionError("CAPABILITY_DENIED", "Invocation is outside the control scope");
      if (seen.has(current.objectId) || seen.size >= 10000)
        throw executionError("INVALID_INPUT", "Invalid invocation lineage");
      seen.add(current.objectId);
      const record = await this.#read(current);
      const snapshot = record.value as unknown as InvocationSnapshot;
      const stateRecord = await this.#read(this.#associated("State", current));
      const state = stateRecord.value as unknown as ControlState;
      records.push({ record, snapshot });
      readSet.push(
        { object: current, revision: record.revision },
        { object: stateRecord.object, revision: stateRecord.revision },
      );
      current = state.parentInvocation;
    }
    return {
      allowed: records.every(
        (entry) => entry.snapshot.control === "running" && !terminal(entry.snapshot),
      ),
      records,
      readSet,
    };
  }
  async apply(
    invocation: ObjectRef,
    command: "pause" | "resume" | "cancel",
    key: string,
  ): Promise<InvocationSnapshot> {
    const fence = await this.guard(invocation);
    if (!["pause", "resume", "cancel"].includes(command) || !/^[\x00-\x7f]{1,128}$/.test(key))
      throw executionError("INVALID_INPUT", "Invalid control request");
    const id = createHash("sha256")
      .update(
        canonicalJson([
          this.options.context.principalId,
          this.options.context.scopeId,
          invocation,
          key,
        ]),
      )
      .digest("hex");
    const receiptRef = this.#ref("ControlReceipt", id);
    const previous = await this.#maybe(receiptRef);
    if (previous) {
      const value = previous.value as unknown as { command: string; snapshot: InvocationSnapshot };
      if (value.command !== command)
        throw executionError("IDEMPOTENCY_CONFLICT", "Control key has a different command");
      if (command === "cancel") {
        await this.#materialize(invocation);
        await this.options.cancelPrepared?.(invocation);
        return (await this.#read(invocation)).value as unknown as InvocationSnapshot;
      }
      return value.snapshot;
    }
    const target = fence.records[0]!;
    if (terminal(target.snapshot)) return target.snapshot;
    const next: InvocationSnapshot = {
      ...target.snapshot,
      control:
        command === "cancel" ? "cancel_requested" : command === "pause" ? "paused" : "running",
      ...(command === "cancel" ? { phase: "cancelled", waitingReason: null } : {}),
    };
    await this.options.store.commit(this.options.context, {
      commitKey: `control/${id}`,
      readSet: [],
      events: [],
      writes: [
        {
          kind: "replace",
          object: invocation,
          expectedRevision: target.record.revision,
          value: json(next),
        },
        { kind: "create", object: receiptRef, value: json({ command, snapshot: next }) },
      ],
    });
    if (command === "cancel") {
      await this.#materialize(invocation);
      await this.options.cancelPrepared?.(invocation);
    }
    return (await this.#read(invocation)).value as unknown as InvocationSnapshot;
  }
  async descendants(root: ObjectRef): Promise<readonly ObjectRef[]> {
    const index = await this.#maybe(this.#ref("InvocationIndex", "index"));
    const objects = index ? (index.value as unknown as { objects: ObjectRef[] }).objects : [root];
    const result: ObjectRef[] = [];
    for (const invocation of objects)
      if (
        (await this.guard(invocation)).records.some(
          (entry) => entry.record.object.objectId === root.objectId,
        )
      )
        result.push(invocation);
    return result;
  }
  async #materialize(root: ObjectRef): Promise<void> {
    for (const invocation of await this.descendants(root)) {
      const fence = await this.guard(invocation);
      const rootRecord = fence.records.find(
        (entry) => entry.record.object.objectId === root.objectId,
      )!;
      if (rootRecord.snapshot.control !== "cancel_requested")
        throw executionError("REVISION_CONFLICT", "Cancellation boundary changed");
      const target = fence.records[0]!;
      const stateRecord = await this.#read(this.#associated("State", invocation));
      const state = stateRecord.value as unknown as ControlState;
      if (!terminal(target.snapshot))
        await this.options.store.commit(this.options.context, {
          commitKey: `cancel/materialize/${root.objectId}/${invocation.objectId}`,
          readSet: [{ object: root, revision: rootRecord.record.revision }],
          events: [],
          writes: [
            {
              kind: "replace",
              object: invocation,
              expectedRevision: target.record.revision,
              value: json({
                ...target.snapshot,
                phase: "cancelled",
                control: "cancel_requested",
                waitingReason: null,
              }),
            },
          ],
        });
      if (
        (state.pendingCommands && (state.pendingCommands as string[]).length) ||
        (state.awaitingInputs && Object.keys(state.awaitingInputs as object).length)
      )
        await this.options.store.commit(this.options.context, {
          commitKey: `cancel/planning/${root.objectId}/${invocation.objectId}`,
          readSet: [],
          events: [],
          writes: [
            {
              kind: "replace",
              object: stateRecord.object,
              expectedRevision: stateRecord.revision,
              value: json({ ...state, pendingCommands: [], pendingKinds: {}, awaitingInputs: {} }),
            },
          ],
        });
      for (const id of state.inboxIds) {
        const inbox = await this.#read(this.#associated("Inbox", invocation, id));
        const value = inbox.value as unknown as { consumed: boolean };
        if (!value.consumed)
          await this.options.store.commit(this.options.context, {
            commitKey: `cancel/inbox/${inbox.object.objectId}`,
            readSet: [],
            events: [],
            writes: [
              {
                kind: "replace",
                object: inbox.object,
                expectedRevision: inbox.revision,
                value: json({ ...(inbox.value as object), consumed: true }),
              },
            ],
          });
      }
      for (const id of state.issuedCommands) {
        const link = await this.#maybe(this.#associated("ChildLink", invocation, id));
        if (link && !(link.value as unknown as { delivered: boolean }).delivered)
          await this.options.store.commit(this.options.context, {
            commitKey: `cancel/link/${link.object.objectId}`,
            readSet: [],
            events: [],
            writes: [
              {
                kind: "replace",
                object: link.object,
                expectedRevision: link.revision,
                value: json({ ...(link.value as object), delivered: true }),
              },
            ],
          });
      }
    }
  }
}
