/** Normative wire/data contracts. Product implementations live elsewhere. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Id = string;
export type Digest = string;
export type Revision = string;
export type JsonSchema = Readonly<Record<string, Json>>;
export interface BootLock {
  readonly format: 1;
  readonly hostAbi: "fractal.host.v1";
  readonly packages: readonly { readonly artifactPath: string; readonly digest: Digest }[];
  readonly activations: readonly { readonly packageDigest: Digest; readonly exportName: string }[];
}

export interface DefinitionRef {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly digest: Digest;
  readonly name: string;
}
export type TypeRef = DefinitionRef;
export type ContractRef = DefinitionRef;
export type ImplementationRef = DefinitionRef;
/** Local references exist only in immutable source packages, before their digest is known. */
export type SourceDefinitionRef = DefinitionRef | { readonly local: string };
export interface PackageReloadDefinition {
  readonly snapshotType: SourceDefinitionRef;
  readonly serverEntry: string | null;
  readonly clientEntry: string | null;
}

export interface PackageManifest {
  readonly format: 1;
  readonly packageId: string;
  readonly version: string;
  readonly hostAbi: "fractal.host.v1";
  readonly reload: PackageReloadDefinition;
  readonly dependencies: readonly DefinitionRef[];
  readonly definitions: readonly SourceDefinitionRecord[];
  readonly exports: Readonly<Record<string, { readonly path: string; readonly exportName: string; readonly environment: "server" | "client" }>>;
}
export interface SourceDefinitionRecord {
  readonly name: string;
  readonly metaType: SourceDefinitionRef;
  readonly value: Json;
}
export interface DefinitionRecord {
  readonly name: string;
  readonly metaType: TypeRef;
  readonly value: Json;
}

/** Shapes interpreted by plugins/meta, never domain switches in host. */
export interface TypeDefinition {
  readonly schema: JsonSchema;
  readonly references: Readonly<Record<string, TypeRef>>;
}
export interface OperationDefinition {
  readonly input: TypeRef;
  readonly output: TypeRef;
  readonly errorCodes: readonly string[];
}
export interface ContractDefinition {
  readonly operations: Readonly<Record<string, OperationDefinition>>;
  readonly conformanceSuite: DefinitionRef;
  readonly allowedEffects: readonly ContractRef[];
}
export interface ConformanceSuiteDefinition { readonly entry: string; readonly targetContract: ContractRef }
export interface SlotDefinition {
  readonly name: string;
  readonly accepts: ContractRef;
  readonly collection: "single" | "ordered" | "keyed";
  readonly min: number;
  readonly max: number;
}
export interface ImplementationDefinition {
  readonly contracts: readonly ContractRef[];
  readonly configurationType: TypeRef;
  readonly stateType: TypeRef;
  readonly slots: readonly SlotDefinition[];
  readonly entry: string;
  readonly abi: string;
  readonly requiredCapabilities: readonly string[];
}
export interface ComponentInstance {
  readonly instanceId: Id;
  readonly implementation: ImplementationRef;
  readonly configuration: Json;
  readonly stateNamespaceId: Id;
  readonly scopeId: Id;
}
export interface Binding {
  readonly parentInstanceId: Id;
  readonly slot: string;
  readonly childInstanceId: Id;
  readonly order?: number;
  readonly key?: string;
}
export interface Assembly {
  readonly assemblyId: Id;
  readonly revision: Revision;
  readonly rootInstanceId: Id;
  readonly profile: "volatile.v1" | "durable.v1";
  readonly instances: readonly ComponentInstance[];
  readonly bindings: readonly Binding[];
}

/** Storage plugin contracts. Namespace access derives from ExecutionContext. */
export interface ObjectRef {
  readonly storeId: Id;
  readonly namespaceId: Id;
  readonly objectId: Id;
  readonly type: TypeRef;
}
export interface VersionedObjectRef { readonly object: ObjectRef; readonly revision: Revision }
export interface ObjectRecord extends VersionedObjectRef { readonly value: Json }
export interface ExecutionContext {
  readonly principalId: Id;
  readonly scopeId: Id;
  readonly ownerInstanceId: Id;
  readonly assemblyRevision: Revision;
  readonly grants: readonly string[];
}
export type RecordWrite =
  | { readonly kind: "create"; readonly object: ObjectRef; readonly value: Json }
  | { readonly kind: "replace"; readonly object: ObjectRef; readonly expectedRevision: Revision; readonly value: Json }
  | { readonly kind: "tombstone"; readonly object: ObjectRef; readonly expectedRevision: Revision };
export interface CommitBatch {
  readonly commitKey: Id;
  readonly readSet: readonly VersionedObjectRef[];
  readonly writes: readonly RecordWrite[];
  readonly events: readonly { readonly eventId: Id; readonly type: TypeRef; readonly value: Json }[];
}
export interface CommitReceipt {
  readonly commitId: Id;
  readonly records: readonly VersionedObjectRef[];
  readonly cursor: string;
}
export interface ObjectStore {
  read(context: ExecutionContext, ref: ObjectRef, revision?: Revision): Promise<ObjectRecord>;
  commit(context: ExecutionContext, batch: CommitBatch): Promise<CommitReceipt>;
}

/** Standard execution plugin data. Not bootstrap primitives. */
export interface OperationRef { readonly contract: ContractRef; readonly operation: string }
export interface InvocationRequest {
  readonly targetInstanceId: Id;
  readonly assemblyRevision: Revision;
  readonly operation: OperationRef;
  readonly input: Json;
  readonly idempotencyKey: string;
}
export interface InvocationReceipt { readonly request: ObjectRef; readonly invocation: ObjectRef }
export type InvocationPhase = "queued" | "active" | "waiting" | "succeeded" | "failed" | "cancelled";
export interface InvocationSnapshot {
  readonly ref: ObjectRef;
  readonly phase: InvocationPhase;
  readonly control: "running" | "paused" | "cancel_requested";
  readonly waitingReason: "effect" | "child" | "input" | "indeterminate" | null;
  readonly unresolvedEffectIds: readonly Id[];
  readonly result: Json | null;
  readonly error: ProtocolError | null;
}
export type ReducerCommand =
  | { readonly kind: "callChild"; readonly commandId: Id; readonly slot: string; readonly childKey?: string; readonly childOrder?: number; readonly operation: string; readonly input: Json }
  | { readonly kind: "effect"; readonly commandId: Id; readonly adapterInstanceId: Id; readonly operation: OperationRef; readonly input: Json; readonly maxUnits: number }
  | { readonly kind: "awaitInput"; readonly commandId: Id; readonly inputType: TypeRef }
  | { readonly kind: "complete"; readonly output: Json }
  | { readonly kind: "fail"; readonly error: ProtocolError };
export interface ReducerEvent { readonly eventId: Id; readonly type: TypeRef; readonly value: Json }
export interface InputReceivedValue { readonly invocation: ObjectRef; readonly operation: OperationRef; readonly input: Json }
export interface ReducerResult { readonly state: Json; readonly commands: readonly ReducerCommand[] }
export type Reducer = (state: Json, event: ReducerEvent, config: Json) => ReducerResult;
export interface ReducerModule {
  initialize(input: Json, config: Json): Json;
  reduce: Reducer;
}
export type AttemptState = "prepared" | "dispatched" | "completed" | "failed_known" | "unknown";
export interface RetryPolicy {
  readonly strategy: "read-only" | "idempotency-key" | "reconcile" | "non-retryable";
  readonly maxAttempts: number;
  readonly idempotencyValidUntil: string | null;
}
export interface EffectDefinition {
  readonly effectId: Id;
  readonly invocationId: Id;
  readonly adapterInstanceId: Id;
  readonly adapter: ImplementationRef;
  readonly adapterConfiguration: Json;
  readonly accountRef: string;
  readonly operation: OperationRef;
  readonly input: Json;
  readonly inputDigest: Digest;
  readonly remoteKey: string;
  readonly policy: RetryPolicy;
}
export interface AttemptRecord {
  readonly attemptId: Id;
  readonly effectId: Id;
  readonly runnerEpoch: Id;
  readonly state: AttemptState;
  readonly reservationId: Id;
  readonly result: VersionedObjectRef | null;
}
export interface BudgetSpec {
  readonly unit: string;
  readonly limit: number;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly maxConcurrentEffects: number;
}
export interface BudgetSnapshot { readonly reserved: number; readonly spent: number; readonly limit: number }
export interface ReservationRecord {
  readonly reservationId: Id;
  readonly attemptId: Id;
  readonly ancestorBudgetIds: readonly Id[];
  readonly unit: string;
  readonly maxUnits: number;
  readonly actualUnits: number | null;
  readonly status: "reserved" | "settled";
}
export interface EffectResolutionRecord {
  readonly effectId: Id;
  readonly result: VersionedObjectRef;
  readonly businessResultDigest: Digest;
  readonly deliveredEventId: Id;
}
export type EffectOutcome =
  | { readonly kind: "completed"; readonly value: Json; readonly actualUnits: number | null; readonly evidence: Json }
  | { readonly kind: "failed_known"; readonly error: ProtocolError; readonly actualUnits: number | null; readonly evidence: Json }
  | { readonly kind: "unknown"; readonly reason: string; readonly evidence: Json };
export interface EffectAdapter {
  execute(input: { readonly effect: EffectDefinition; readonly attemptId: Id; readonly runnerEpoch: Id }): Promise<EffectOutcome>;
  reconcile(input: { readonly effect: EffectDefinition; readonly attemptId: Id }): Promise<EffectOutcome>;
}
export interface MigrationPlan {
  readonly planId: Id;
  readonly source: VersionedObjectRef;
  readonly head: VersionedObjectRef;
  readonly destination: ObjectRef;
  readonly implementation: ImplementationRef;
  readonly planDigest: Digest;
}
/** Reload data is provided by the lifecycle plugin; generation IDs are opaque. */
export interface ReloadRequest {
  readonly expectedGenerationId: Id;
  readonly candidateLock: BootLock;
  readonly idempotencyKey: string;
}
export interface ReloadSnapshot { readonly type: TypeRef; readonly value: Json }
export interface ReloadReceipt {
  readonly reloadId: Id;
  readonly previousGenerationId: Id;
  readonly activeGenerationId: Id;
  readonly retiredGenerationIds: readonly Id[];
}
export interface ReloadContext {
  readonly generationId: Id;
  readonly packageId: string;
  readonly instanceIds: readonly Id[];
  readonly resourceIds: readonly Id[];
}
export interface ReloadParticipant {
  capture(context: ReloadContext): Promise<ReloadSnapshot>;
  restore(snapshot: ReloadSnapshot, context: ReloadContext): Promise<void>;
  ready(context: ReloadContext): Promise<void>;
  dispose(context: ReloadContext): Promise<void>;
}

/** UI plugin contracts. A mount never owns its target object. */
export interface ViewDefinition {
  readonly targetType: TypeRef;
  readonly propsType: TypeRef;
  readonly implementation: ImplementationRef;
}
export interface ViewMount {
  readonly mountId: Id;
  readonly view: DefinitionRef;
  readonly viewInstanceId: Id;
  readonly assemblyRevision: Revision;
  readonly target: ObjectRef;
  readonly fixedRevision: Revision | null;
  readonly props: Json;
}
export interface ActionDefinition {
  readonly operation: OperationRef;
  readonly title: string;
  readonly inputType: TypeRef;
}
export interface SubscriptionEvent {
  readonly eventId: Id;
  readonly cursor: string;
  readonly previousCursor: string;
  readonly value: Json;
}
export interface SubscriptionSnapshot { readonly cursor: string; readonly records: readonly ObjectRecord[] }

/** Fork is a standard plugin operation, with no external actions in v1. */
export type ForkPolicy = "clone" | "reference" | "reset" | "reject";
export interface ForkPlan {
  readonly planId: Id;
  readonly source: VersionedObjectRef;
  readonly readSet: readonly VersionedObjectRef[];
  readonly targetScopeId: Id;
  readonly mappings: readonly { readonly source: VersionedObjectRef; readonly policy: ForkPolicy; readonly target: ObjectRef | null }[];
  readonly planDigest: Digest;
}
export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly details: Json;
  readonly retryable: boolean;
}
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ProtocolError };
