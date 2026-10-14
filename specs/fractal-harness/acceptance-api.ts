import type {
  Assembly, BudgetSnapshot, CommitBatch, CommitReceipt, DefinitionRef, InvocationReceipt,
  InvocationRequest, InvocationSnapshot, Json, ObjectRecord, ObjectRef, Outcome,
} from "./contracts.js";

/** Adapter MUST delegate to real product APIs; fixture names identify packages, not scenarios. */
export type FixtureName = "documents" | "composite" | "writer" | "budget-tree" | "agent" | "checklist" | "badge";
export interface FixtureHandle {
  readonly definitions: Readonly<Record<string, DefinitionRef>>;
  readonly assembly: Assembly;
  readonly request: InvocationRequest;
  readonly object: ObjectRef;
  readonly namespaceId: string;
  readonly scopeId: string;
}
export type CrashPoint = "before_prepare_commit" | "after_prepare_commit" | "after_dispatch_commit_before_transport" | "after_remote_accept_before_receipt" | "after_receipt_commit_before_reduce" | "after_reduce_commit";
export interface AcceptanceHarness {
  fixture(name: FixtureName): Promise<FixtureHandle>;
  validateAssembly(assembly: Assembly): Promise<Outcome<Assembly>>;
  invoke(request: InvocationRequest): Promise<Outcome<InvocationReceipt>>;
  pump(): Promise<void>;
  snapshot(ref: ObjectRef): Promise<InvocationSnapshot>;
  read(ref: ObjectRef, revision?: string): Promise<ObjectRecord>;
  commit(batch: CommitBatch): Promise<Outcome<CommitReceipt>>;
  crashAt(point: CrashPoint): Promise<void>;
  recover(): Promise<void>;
  effectCounts(): Promise<{ readonly calls: number; readonly changes: number }>;
  replay(ref: ObjectRef): Promise<{ readonly result: Json; readonly externalCalls: number; readonly productionWrites: number }>;
  runBudgetRace(input: { readonly limit: number; readonly reservations: readonly number[] }): Promise<{
    readonly admitted: number; readonly rejectedCodes: readonly string[]; readonly root: BudgetSnapshot;
  }>;
  close(): Promise<void>;
}
export interface HarnessOptions { readonly directory: string; readonly bootstrap: "standard" | "missing" }
export type CreateAcceptanceHarness = (options: HarnessOptions) => Promise<AcceptanceHarness>;
