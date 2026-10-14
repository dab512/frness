# Repository capabilities

Repository contexts are issued by runtime from the calling component's pinned identity, scope and native grants. Request input cannot supply a principal, owner or grants.

A namespace owner retains read/write access within its scope. A different component requires an explicit grant produced by `namespaceGrant(storeId, namespaceId, "read" | "write")`, from the storage plugin SDK. The serialized token uses an unambiguous canonical JSON tuple. Only the native profile authority issues it; a token appearing inside an operation payload has no authority.

Read grants allow historical reads and namespace subscriptions, including snapshot/catch-up with cursors bound to the caller. They confer no mutation authority. Write grants do not implicitly confer read permission. Read sets require read authority; writes require write authority. Scope and store identity checks apply even when a grant exists.

This lets a context reader consume an explicitly shared knowledge namespace without taking ownership or gaining write access. It does not make data from another scope visible.
