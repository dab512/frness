# Repository capabilities

Repository contexts are issued by runtime from the calling component's pinned identity, scope and native grants. Request input cannot supply a principal, owner or grants.

A namespace owner retains read/write access within its scope. A different component requires an explicit grant produced by `namespaceGrant(storeId, namespaceId, "read" | "write")`, from the storage plugin SDK. The serialized token uses an unambiguous canonical JSON tuple. Only the native profile authority issues it; a token appearing inside an operation payload has no authority.

Read grants allow historical reads and namespace subscriptions, including snapshot/catch-up with cursors bound to the caller. They confer no mutation authority. Write grants do not implicitly confer read permission. Read sets require read authority; writes require write authority. Scope and store identity checks apply even when a grant exists.

This lets a context reader consume an explicitly shared knowledge namespace without taking ownership or gaining write access. It does not make data from another scope visible.

`std.storage.Repository` is supplied by a separate runtime package built from the storage workspace. A managed execution backend enables it with the exact `repositoryContract` ref. Native profiles bind repository instances to an existing storage service:

```json
{"repositories":{"main":{"serviceId":"storage","instances":["repository-instance"]}},"grants":{"repository-instance":["repository"]}}
```

The `LocalRepository` instance config contains `{"binding":"main"}`. Its ABI is `store.v1`; a reducer calls it through an ownership-tree slot, never by an arbitrary instance ID. Service/application IDs and state namespaces must be unique in an active daemon profile. Application namespaces are registered with their pinned owners before requests are admitted.

Repository dispatch is journaled together with its shared step-budget charge before I/O. The local transaction records its own idempotent receipt. A crash between that transaction and execution completion repeats the same technical commit key and recovers the original revisions. An unavailable response leaves the inbox pending and stops scheduling. Read may repeat until its result is journaled; replay uses only that recorded result. An already dispatched receipt can be recovered after quota exhaustion.

`std.storage.Proxy` proves replacement by a reducer subtree: it forwards the same exact repository contract. Repository authority follows the original caller through such wrappers, and cannot be supplied in JSON. Each forwarding step rewrites its own reducer command key; runtime hashes the parent invocation and command ID into the actual storage key. Child ingress keys are also hashed, so Unicode/long command IDs do not violate the ASCII ingress-key contract.
