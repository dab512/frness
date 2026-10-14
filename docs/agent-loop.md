# Verified agent loop

`std.agent.Loop` is a reducer plugin. Its metadata defines `AgentTask`, `Decision`, `Candidate`, `Verification`, `AcceptedResult`, and the working state. Context building, decisions, tools, acceptance and optional remembering are child slots. The host contains no agent workflow or agent status logic.

The loop preserves the original task and ordered constraints. Tools run sequentially. A repeated call ID with identical arguments reuses its observation within the run; changed reuse fails with `IDEMPOTENCY_CONFLICT`. User input is added to subsequent context feedback and does not overwrite the original goal. Blocked/need-input decisions wait for typed input instead of returning success.

The `accept` subtree determines mandatory verifier implementations. The bound reducer walks children connected through the exact acceptance contract. Its pinned `requiredVerifiers` configuration must match those leaves. Repeated implementations with the same exact ref are rejected: the current `Verification.verifier` contract identifies implementations, so it cannot distinguish two differently configured instances of the same implementation. Use distinct implementation refs for separately required checks.

Candidate digests cover canonical JSON `{value,type,sources}`. Every required verifier must return `accept` for that exact digest; missing, duplicate, unexpected, rejected, or inconclusive responses continue with feedback. Finalization recomputes the digest and checks all evidence again. Optional remember runs after acceptance; a known child failure adds a warning. A durable-store failure follows execution recovery rules.

Progress, inboxes and child receipts live in the execution journal. Step/depth/cost limits belong to the configured shared execution budget, not an agent-specific counter. The step-budget gate proves that repeated decisions stop with saved task/progress and no repeated tool effect.

`LlmDecision` delegates structured decisions through its `llm` slot. `AgentTool` exposes a full nested Run subtree through the ordinary `std.tools.Invoke` contract. Live model acceptance and UI integration remain later gates; current workflow fixtures use deterministic decision/tool/verifier plugins.
