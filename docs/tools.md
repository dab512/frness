# Tools

`std.tools.Invoke.invoke` receives `ToolCall` and returns `ToolObservation`. `Router` has a keyed `tools` slot and metadata-defined `ToolSpec`s. It validates arguments before emitting a child command and validates successful observations against the exact output type. Unknown names/invalid arguments produce an error observation with no child dispatch. Groups run sequentially; the per-run `ToolRouter` helper rejects changed reuse of a call ID. Durable request/child deduplication is provided by execution receipts, rather than a global map of model call IDs.

`SingleTool` wraps an effect adapter under its `adapter` slot. `ReadFile` and `WriteFile` implement the same contract. A subagent can implement `Invoke` as a normal reducer subtree; the host has no special subagent path. The current acceptance fixture uses a pure nested reducer, as specified by AT-016; the verified agent implementation follows in FH-17.

Filesystem adapters require a named `filesystem.root` binding in the daemon profile:

```json
{"filesystems":{"workspace":{"root":"/absolute/workspace","access":"read-write","instances":["read-effect","write-effect"]}}}
```

Grant `filesystem.root` only to those adapter instances; configure their `filesystemBinding` as `workspace`. Read-only bindings reject writes. Paths must be relative and cannot contain empty/dot/parent components. Symlinks are rejected, including intermediate components. Final opens use `O_NOFOLLOW`, and non-regular files are rejected.

Read returns UTF-8 content and its SHA-256 digest. Write requires `expectedContentDigest` (null means create), writes a private temporary file, fsyncs it, renames it, then reads the target back. A content conflict is returned before writing. A write without verified read-back remains unknown. Reconcile only reads and accepts an already matching desired digest; it never repeats an uncertain write.

This is a trusted local workspace capability, not an OS sandbox for hostile concurrent filesystem actors. In particular, Node's path APIs do not provide portable `openat` traversal or atomic compare-and-swap against non-cooperating writers. The workspace must not be concurrently rearranged by an untrusted process. External edits can cause conflicts or unknown outcomes; they are not rolled back. This implementation makes no stronger confinement or transactional-filesystem claim.
