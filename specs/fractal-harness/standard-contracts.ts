/** Data shapes supplied by standard plugins, not exported as domain classes by host. */
import type { DefinitionRef, Json, ObjectRecord, ObjectRef, OperationRef, ProtocolError, Revision, TypeRef, VersionedObjectRef } from "./contracts.js";

export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId: string | null;
}
export interface ToolSpec { readonly name: string; readonly description: string; readonly inputType: TypeRef; readonly outputType: TypeRef }
export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly outputType: TypeRef | null;
  readonly maxOutputTokens: number;
}
export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: Json }
export interface ModelCompletion {
  readonly text: string;
  readonly structured: Json | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finish: "stop" | "tool_calls";
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}
export interface AgentTask {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly sources: readonly VersionedObjectRef[];
  readonly outputType: TypeRef;
}
export type Decision =
  | { readonly kind: "actions"; readonly calls: readonly ToolCall[] }
  | { readonly kind: "candidate"; readonly value: Json }
  | { readonly kind: "needInput"; readonly question: string; readonly inputType: TypeRef }
  | { readonly kind: "blocked"; readonly reason: string };
export interface ToolObservation {
  readonly callId: string;
  readonly ok: boolean;
  readonly value: Json | null;
  readonly errorCode: string | null;
  readonly sources: readonly VersionedObjectRef[];
}
export interface Candidate { readonly value: Json; readonly type: TypeRef; readonly sources: readonly VersionedObjectRef[]; readonly digest: string }
export interface Verification {
  readonly candidateDigest: string;
  readonly verifier: DefinitionRef;
  readonly verdict: "accept" | "revise" | "reject" | "inconclusive";
  readonly feedback: readonly string[];
  readonly evidence: readonly VersionedObjectRef[];
}
export interface AcceptedResult {
  readonly candidate: Candidate;
  readonly verifications: readonly Verification[];
  readonly warnings: readonly string[];
}
export interface ContextBundle { readonly messages: readonly Message[]; readonly sources: readonly VersionedObjectRef[]; readonly omittedSources: readonly VersionedObjectRef[] }
export interface Knowledge {
  readonly statement: string;
  readonly sources: readonly VersionedObjectRef[];
  readonly status: "observed" | "accepted" | "retracted";
  readonly recordedAt: string;
  readonly validUntil: string | null;
}
export interface Interaction { readonly request: ObjectRef; readonly invocation: ObjectRef; readonly acceptedResult: VersionedObjectRef | null }
export interface Session { readonly title: string; readonly interactions: readonly ObjectRef[]; readonly context: readonly VersionedObjectRef[]; readonly configuration: readonly { readonly type: TypeRef; readonly value: Json }[] }
export interface HistoryEntry { readonly subject: VersionedObjectRef; readonly sourceEventId: string; readonly recordedAt: string }
export interface Project { readonly title: string; readonly members: readonly ObjectRef[]; readonly context: readonly VersionedObjectRef[]; readonly configuration: readonly { readonly type: TypeRef; readonly value: Json }[] }
export interface Tab {
  readonly title: string;
  readonly target: ObjectRef;
  readonly view: DefinitionRef;
  readonly viewInstanceId: string;
  readonly assemblyRevision: Revision;
  readonly fixedRevision: Revision | null;
  readonly props: Json;
}
export interface TabLayout { readonly tabs: readonly ObjectRef[]; readonly activeTab: ObjectRef | null }
export interface Head { readonly current: ObjectRef }
/** Backend plugin data; CLI agents do not implement ModelCompletion by shape. */
export interface AgentBackendCapabilities {
  readonly streaming: boolean;
  readonly resume: boolean;
  readonly reconcileTurn: boolean;
  readonly permissions: boolean;
  readonly interrupt: "turn" | "session" | "none";
  readonly nativeFork: boolean;
}
export interface NativeAgentSession {
  readonly adapter: DefinitionRef;
  readonly configuration: VersionedObjectRef;
  readonly workspace: VersionedObjectRef;
  readonly nativeHandle: string | null;
  readonly metadata: Json;
  readonly activeTurnId: string | null;
  readonly eventCursor: string | null;
}
export interface AgentTurnInput {
  readonly session: VersionedObjectRef;
  readonly clientTurnId: string;
  readonly prompt: string;
  readonly sources: readonly VersionedObjectRef[];
}
export type AgentRuntimeEvent = {
  readonly eventId: string;
  readonly clientTurnId: string;
  readonly nativeTurnId: string | null;
} & (
  | { readonly kind: "session"; readonly nativeHandle: string; readonly metadata: Json }
  | { readonly kind: "text"; readonly delta: string }
  | { readonly kind: "tool"; readonly toolId: string; readonly phase: "started" | "completed"; readonly value: Json }
  | { readonly kind: "permission"; readonly requestId: string; readonly actionDigest: string; readonly options: readonly { readonly id: string; readonly title: string }[]; readonly value: Json }
  | { readonly kind: "provider"; readonly type: TypeRef; readonly value: Json }
  | { readonly kind: "terminal"; readonly status: "completed" | "failed" | "cancelled" | "unknown"; readonly result: Json; readonly errorCode: string | null }
);
export interface AgentPermissionDecision {
  readonly session: VersionedObjectRef;
  readonly clientTurnId: string;
  readonly requestId: string;
  readonly actionDigest: string;
  readonly optionId: string;
}
/** Optional addon contracts. Backend records contain no usage counters or limit policy. */
export type AgentLaunchDecision = { readonly kind: "allow" } | { readonly kind: "deny"; readonly error: ProtocolError };
export interface AgentObservedEvent { readonly session: ObjectRef; readonly event: ObjectRecord }
export interface AgentUsageSample { readonly source: VersionedObjectRef; readonly unit: string; readonly amount: number | null }
export interface CreateInput { readonly value: Json }
export interface UpdateInput { readonly object: ObjectRef; readonly expectedRevision: Revision; readonly value: Json }
export interface AppendInput { readonly object: ObjectRef; readonly expectedRevision: Revision; readonly child: ObjectRef }
export interface ActionBinding { readonly operation: OperationRef; readonly targetInstanceId: string; readonly assemblyRevision: Revision }
