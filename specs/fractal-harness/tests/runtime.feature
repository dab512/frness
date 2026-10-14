Feature: Durable runtime of the standard runtime plugin
  The host does not define Request, Invocation, Effect, Attempt or their statuses.
  Runtime tests use Node.js 24, one writer, file-backed SQLite and a separate durable fake remote.
  C counts actual fake transport calls; S counts committed fake remote mutations.
  All transport calls in Given, When and Then count, including retry and restart.
  Direct fixture seeding does not call transport; only an explicit reset changes counters.

  Background:
    Given an immutable assembly containing exact schema and implementation hashes
    And runtime objects are defined by the standard runtime plugin
    And a fresh file-backed SQLite storage owned by one writer
    And a separate durable fake remote with C 0 and S 0
    And every public invoke has a valid idempotencyKey unless the scenario overrides it
    And persistence uses only CommitBatch with readSet, expectedRevision and typed journal events

  @RT-001
  Scenario: Invalid input is rejected before allocating an invocation
    Given the echo operation accepts a string field named text
    When a command supplies text as an object
    Then the result is INVALID_INPUT
    And no Request, Invocation, Effect, Attempt or Reservation is allocated
    And C is 0 and S is 0

  @RT-001
  Scenario: Per-invocation initialization does not reuse the component's long-lived state
    Given two authorized inputs target the same component instance with distinct idempotency keys
    And initialize is a pure function producing state from each input
    When both invocations are accepted and only the first processes a state-changing event
    Then each invocation has a distinct typed reducer state record
    And the second state is unchanged by the first reducer transition
    And ComponentInstance.stateNamespaceId is unchanged
    And the component's long-lived objects have not been changed implicitly
    And C is 0 and S is 0

  @RT-001
  Scenario: Invalid initialized state is rejected before accepting the invocation
    Given initialize returns a value violating ImplementationDefinition.stateType
    When the input is otherwise valid and the public invoke is submitted
    Then the result is INVALID_OUTPUT
    And no invocation receipt, initial event or Effect is committed
    And C is 0 and S is 0

  @RT-001
  Scenario: An initialize exception has a distinct execution error
    Given the pinned initialize function throws before returning state
    When the input is otherwise valid and the public invoke is submitted
    Then the result is REDUCER_EXECUTION_FAILED
    And no invocation receipt, initial event or Effect is committed
    And C is 0 and S is 0

  @RT-002
  Scenario: Repeated identical inbound command reuses the first invocation
    Given a write InvocationRequest with principalId alice, scopeId scope-1 and idempotencyKey key-1
    And targetInstanceId and exact OperationRef and assemblyRevision are fixed
    When two concurrent submissions use identical canonical input
    And the accepted invocation completes
    Then both InvocationReceipt values return the same request and invocation ObjectRefs
    And there is one Effect and one Attempt
    And C is 1 and S is 1

  @RT-003
  Scenario Outline: Reusing an inbound key with a different pinned body does not run a second command
    Given a write InvocationRequest with principalId alice and idempotencyKey key-1 completed
    And the fixture resets C and S without removing the receipt
    When principal alice submits the same scope, target, exact operation and key with <change>
    Then the result is IDEMPOTENCY_CONFLICT
    And the original Request and Invocation remain unchanged
    And no new Effect or Reservation exists
    And C is 0 and S is 0
    Examples:
      | change                      |
      | different input             |
      | different assemblyRevision  |

  @RT-003
  Scenario: Retry explicitly pins the original assembly revision after a deployment
    Given a write InvocationRequest explicitly used assemblyRevision rev-1 and idempotencyKey key-1
    And its invocation completed with an original InvocationReceipt
    And deployment activated rev-2 while retaining the pinned rev-1 dependencies
    And the fixture resets C and S without changing persisted requests or receipts
    When the caller repeats the original body with explicit assemblyRevision rev-1 and key-1
    Then the original InvocationReceipt is returned
    And active rev-2 is not substituted into the request body or its digest
    And no second invocation or Effect is created
    And C is 0 and S is 0

  @RT-003
  Scenario Outline: All public invoke operations require a valid idempotency key
    Given an otherwise valid InvocationRequest
    When its idempotencyKey is <key>
    Then the result is INVALID_INPUT
    And no Request or Invocation is created
    And C is 0 and S is 0
    Examples:
      | key                 |
      | absent              |
      | empty               |
      | 129 ASCII characters |
      | non-ASCII text      |

  @RT-003
  Scenario Outline: An ingress key is scoped to principal, scope, target and exact operation
    Given one write invocation completed with idempotencyKey key-1
    And the caller is authorized for both the original and the changed context
    When an otherwise identical request changes only <scopePart> and keeps key-1
    And the newly accepted invocation completes
    Then the new InvocationReceipt refers to a different invocation
    And C is 2 and S is 2
    Examples:
      | scopePart         |
      | principalId       |
      | scopeId           |
      | targetInstanceId  |
      | exact OperationRef |

  @RT-004
  Scenario: Prepared intent survives a crash before dispatch
    Given a write command is waiting at the hook after T2 commit
    When the writer is killed and restarted with the same assembly
    And the scheduler finishes the invocation
    Then the original prepared Attempt was dispatched exactly once
    And the effect result was consumed exactly once
    And the invocation phase is succeeded
    And all reservations are settled with actual 1
    And C is 1 and S is 1

  @RT-005
  Scenario: Crash after dispatch permission cannot be treated as proof of no action
    Given a non-idempotent write is waiting after T3 commit before transport
    When the writer is killed and restarted
    Then the original Attempt is unknown
    And the invocation phase is waiting with waitingReason indeterminate
    And its reason is EXTERNAL_OUTCOME_UNKNOWN
    And unresolvedEffectIds contains the original effectId
    And its reservation remains reserved
    And no automatic retry Attempt is created
    And C is 0 and S is 0

  @RT-006
  Scenario: Lost response after a committed remote mutation remains unknown
    Given a non-idempotent write stops after the remote committed its mutation
    When the response is dropped and the writer is restarted
    Then the Attempt is unknown
    And the invocation phase is waiting with waitingReason indeterminate
    And the original reservation remains reserved
    And no success, known failure or task acceptance is fabricated
    And no automatic retry is performed
    And C is 1 and S is 1

  @RT-007
  Scenario Outline: Unknown writes retry only within a valid native idempotency window
    Given an idempotent write lost its response after one committed mutation
    And sufficient budget exists for two physical attempts
    And the persisted test time is advanced by <elapsed> seconds
    When the runtime evaluates the pinned retry policy
    Then the number of Attempts is <attempts>
    And C is <calls> and S is 1
    And the invocation phase is <phase> with waitingReason <reason>
    And the original reservation remains reserved until explicit reconciliation
    Examples:
      | elapsed | attempts | calls | phase   | reason        |
      | 10      | 2        | 2     | waiting | indeterminate |
      | 61      | 1        | 1     | waiting | indeterminate |

  @RT-007
  Scenario: A native idempotency receipt resolves the original attempt without another mutation
    Given an unknown original write and a completed native-idempotency retry share one effectId
    And C is 2 and S is 1
    And the retry used the identical remoteKey and inputDigest
    When reconciliation consumes the fake remote receipt proving the original result and actual 1
    Then both Attempts have known results and separately settled actual 1
    And the logical effect result is consumed once
    And the invocation phase is succeeded
    And unresolvedEffectIds is empty
    And C remains 2 and S remains 1

  @RT-008
  Scenario: Durable inbox prevents resending after completion was persisted
    Given a write completed and the writer stops after T4 commit before reducer
    When the writer is killed and restarted
    Then the stored inbox event is consumed once
    And the invocation phase is succeeded
    And no new Attempt is created
    And C is 1 and S is 1

  @RT-009
  Scenario Outline: Duplicate completions never replace the first saved result
    Given a write completed with business payload digest hash-A
    When a duplicate completion for the same attemptId supplies <hash>
    Then the completion response is <response>
    And the saved business payload digest remains hash-A
    And the result inbox event and its consumption each exist once
    And C is 1 and S is 1
    Examples:
      | hash   | response            |
      | hash-A | idempotent success  |
      | hash-B | COMPLETION_CONFLICT |

  @RT-010
  Scenario: Siblings and fork continuations do not share one remote idempotency key
    Given two child invocations request the same write arguments
    And a stable checkpoint can start one independent fork continuation
    When both children and the fork each perform their write
    Then three distinct effectIds and remote idempotency keys exist
    And the fork has a distinct invocation lineage
    And retries of each effect preserve only that effect's key
    And C is 3 and S is 3

  @RT-010
  Scenario: An effect cannot address an arbitrary sibling adapter instance
    Given an adapter instance exists and exports the requested exact operation
    And it is a sibling rather than a connected immediate child of the calling instance
    When the reducer returns an effect command addressing that adapterInstanceId
    Then the operation fails with CAPABILITY_DENIED before preparing an Effect
    And no Reservation is created
    And C is 0 and S is 0

  @RT-011
  Scenario: Concurrent reservations cannot oversubscribe the parent budget
    Given the root test-credit limit is 100
    And two child scopes each have test-credit limit 100
    When both children concurrently request credit-write with maxUnits 60
    Then exactly one prepared Attempt and reserved 60 are committed
    And the competing preparation returns BUDGET_EXCEEDED without an Effect or reservation
    When the accepted write settles with actual 40
    Then root spent is 40 and root reserved is 0
    When the rejected child explicitly requests a fresh preparation with maxUnits 60
    And that write settles with actual 40
    Then root spent is 80 and root reserved is 0
    And C is 2 and S is 2

  @RT-012
  Scenario: One leaf reservation is not counted repeatedly through ancestors
    Given a root, child and grandchild each have test-credit limit 100
    When the grandchild prepares one credit-write with maxUnits 60
    Then reserved is 60 in each of the three scopes
    And there is one Reservation object for the Attempt and unit
    When the write settles with actual 40
    Then spent is 40 and reserved is 0 in each scope
    And C is 1 and S is 1

  @RT-013
  Scenario: Unknown attempt keeps its budget through retry denial and cancellation
    Given root test-credit limit is 100
    And a dispatched write with maxUnits 60 has unknown outcome
    And C is 1 and S is 1
    When a retry requests another reservation of 60
    Then the retry returns BUDGET_EXCEEDED and no second Attempt is created
    When the root invocation is cancelled
    Then phase is cancelled and control is cancel_requested
    And unresolvedEffectIds contains the original effectId
    And reserved remains 60
    And C remains 1 and S remains 1

  @RT-014
  Scenario Outline: Invalid numeric budgets fail before dispatch
    Given a budget configuration contains <value> in <field>
    When the configuration or preparation is validated
    Then the result is <error>
    And no partial Reservation is committed
    And C is 0 and S is 0
    Examples:
      | field          | value            | error          |
      | limit          | -1               | INVALID_INPUT  |
      | limit          | Infinity         | NON_JSON_VALUE |
      | maxUnits       | NaN              | NON_JSON_VALUE |
      | maxUnits       | 0.5              | INVALID_INPUT  |
      | maxUnits       | 9007199254740992 | INVALID_INPUT  |

  @RT-014
  Scenario Outline: Invalid reported usage is preserved as evidence but cannot silently settle
    Given a credit-write with maxUnits 60 has reached the fake remote
    When its adapter reports actualUnits <actual>
    Then the result contains INVALID_USAGE
    And the original usage evidence remains available
    And the reservation is not marked settled
    And further dispatch in the affected scope is blocked
    And no accepted task result is published
    And C is 1 and S is 1
    Examples:
      | actual |
      | -1     |
      | 0.5    |
      | 61     |

  @RT-015
  Scenario Outline: Cancellation and dispatch are ordered by their committed transactions
    Given a prepared write with an active reservation
    When <first> commits before <second> is evaluated
    And all already authorised transport work and completions finish
    Then phase is cancelled and control is cancel_requested
    And no additional child or effect is scheduled
    And no late result changes the phase to succeeded
    And C is <calls> and S is <mutations>
    And the Attempt state is <attemptState>
    And the reservation is settled with actualUnits <actual>
    Examples:
      | first             | second            | calls | mutations | actual | attemptState |
      | cancellation TC   | dispatch T3       | 0     | 0         | 0      | failed_known |
      | dispatch T3       | cancellation TC   | 1     | 1         | 1      | completed    |

  @RT-015
  Scenario: Cancellation before dispatch preserves proof and settles zero usage
    Given a prepared Attempt and its active ReservationRecord
    When cancellation TC wins before T3 and cleanup completes
    Then the Attempt state is failed_known with error CANCELLED_BEFORE_DISPATCH
    And its evidence references the local control commit proving no dispatch
    And the historical Attempt and immutable EffectDefinition remain stored
    And its ReservationRecord has status settled and actualUnits 0
    And C is 0 and S is 0

  @RT-015
  Scenario: An ancestor cancellation invalidates a stale prepared dispatch batch
    Given a descendant dispatcher read running ancestor revisions into its CommitBatch.readSet
    When cancellation TC commits a new ancestor revision
    And the stale dispatch CommitBatch is submitted
    Then storage returns REVISION_CONFLICT and writes no dispatched transition
    And the next eligibility check observes the cancelled ancestor
    And C is 0 and S is 0

  @RT-016
  Scenario: Pause saves in-flight results and prevents the next dispatch until resume
    Given a first write is dispatched and a second write is prepared in the same subtree
    When the pause transaction commits before the second dispatch transaction
    And the first write completes
    Then control is paused
    And the first result is durably saved
    And the second Attempt remains prepared with its reservation
    And C is 1 and S is 1
    When resume is requested and the second write completes
    Then control is running
    And C is 2 and S is 2

  @RT-017
  Scenario: Replay uses scratch storage and zero live effects
    Given a completed invocation journal and canonical JSON snapshots of live records
    And the fixture resets C and S without changing the journal
    When replay runs in a fresh scratch namespace
    Then the reproduced outcome and effect inputDigest values match the journal
    And canonical JSON of live records, memory, artifacts and accounting remains unchanged
    And no external adapter transport is invoked
    And C is 0 and S is 0

  @RT-018
  Scenario: Replay divergence cannot fall back to an external service
    Given a recorded effect has exact OperationRef write and inputDigest hash-A
    When the replayed reducer requests the same OperationRef and inputDigest hash-B at that position
    Then the replay stops with REPLAY_DIVERGENCE
    And no later recorded response is substituted
    And live storage remains unchanged
    And C is 0 and S is 0

  @RT-019
  Scenario Outline: Resume never substitutes an unpinned dependency
    Given a suspended invocation is pinned to schema v1 and implementation v1 with exact hashes
    And the registry now contains <available>
    When resume is requested
    Then the response is PINNED_DEPENDENCY_MISSING
    And no automatic migration or replacement by latest occurs
    And the persisted invocation and assemblyRevision remain unchanged
    And C is 0 and S is 0
    Examples:
      | available                                      |
      | schema v2 and implementation v2 only            |
      | schema v1 and implementation v1 with wrong hash  |
      | schema v1 but no implementation v1               |

  @RT-020
  Scenario Outline: Fork requires a stable plugin-exported checkpoint
    Given the requested checkpoint contains <pending>
    When fork is requested
    Then the response is CHECKPOINT_NOT_FORKABLE
    And no new lineage or namespace is committed
    And C is 0 and S is 0
    Examples:
      | pending                       |
      | a prepared Attempt            |
      | a dispatched Attempt          |
      | an unknown Attempt            |
      | an unconsumed inbox event     |
      | a missing plugin state export |

  @RT-020
  Scenario: Fork of a stable checkpoint preserves its parent and uses new future effects
    Given all plugins exported a stable checkpoint without pending work
    And the parent snapshot and its immutable artifact references are recorded
    When planFork and executeFork complete using a valid readSet
    Then C is 0 and S is 0
    When a subsequent independent invocation in the new branch performs one write
    Then the fork has a new invocation lineage and future effectId and remote key
    And the parent snapshot is unchanged
    And the historical immutable artifacts remain shared only by reference
    And C is 1 and S is 1

  @RT-020
  Scenario: A fully cleaned cancellation before dispatch is forkable without resending the action
    Given a write was cancelled while its Attempt was prepared
    And cleanup changed it to failed_known with CANCELLED_BEFORE_DISPATCH and actualUnits 0
    And all descendants are terminal and all administrative events are consumed
    And every plugin exported a stable ForkPlan-compatible snapshot
    When planFork and executeFork complete
    Then the fork exists with the declared clone, reference and reset policies
    And neither source nor target contains a live prepared, dispatched or unknown Attempt
    And the historical cancelled Attempt is not rescheduled
    And all transferred historical accounting remains settled
    And C is 0 and S is 0

  @RT-021
  Scenario Outline: Candidate completion is not equivalent to task acceptance
    Given one completed model call produced candidateDigest hash-A
    When the mandatory verifier completes with <verdict> for <verifiedHash>
    Then the verifier invocation may be succeeded
    And no AcceptedResult exists for candidateDigest hash-A
    And the task has reason <reason>
    And C is 2 and S is 0
    Examples:
      | verdict      | verifiedHash | reason                    |
      | reject       | hash-A       | VERIFICATION_REJECTED     |
      | inconclusive | hash-A       | VERIFICATION_INCONCLUSIVE |
      | accept       | hash-B       | VERIFICATION_INCONCLUSIVE |

  @RT-021
  Scenario: Changing a verified candidate invalidates its old acceptance evidence
    Given candidate hash-A was accepted by every mandatory verifier
    When a recorded edit changes the current candidate to hash-B
    Then the old verification remains attached only to hash-A
    And there is no AcceptedResult for candidateDigest hash-B
    And no new external call is made until a new verification is scheduled
    And C is 0 and S is 0

  @RT-022
  Scenario Outline: Provisional model chunks cannot dispatch tools or publish accepted memory
    Given the model emitted text and a complete-looking tool JSON as provisional chunks
    When the stream ends with <ending>
    Then the result reason is <reason>
    And no tool Effect is prepared or dispatched
    And no accepted memory or task result is published
    And provisional data remains marked incomplete
    And unknown usage keeps its reservation
    And C is 1 and S is 0
    Examples:
      | ending                                      | reason              |
      | disconnect before final event               | INCOMPLETE_RESPONSE |
      | final finish reason length                  | INCOMPLETE_RESPONSE |
      | final payload violating the response schema | INVALID_OUTPUT      |

  @RT-022
  Scenario: A normal complete model response can continue only after full validation
    Given the model emits one valid tool call with a normal final event
    When the full message passes its pinned response schema
    And the resulting write tool completes with sufficient budget
    Then one model result is committed before one tool Effect is prepared
    And C is 2 and S is 1

  @RT-023
  Scenario: A second writer cannot execute work from the same local storage
    Given the first writer owns the storage and has one prepared write
    When a second writer process opens that storage
    Then the second process exits with WRITER_ALREADY_RUNNING before loading active tasks
    When the first writer completes the write
    Then C is 1 and S is 1
    When the first writer is killed and a replacement starts
    Then the replacement acquires exclusive ownership
    And it does not redispatch the completed write
    And C remains 1 and S remains 1

  @RT-024
  Scenario: Process failure before CommitBatch cannot consume an event or leak a new intent
    Given an unconsumed event invokes the reducer-commit-fault fixture
    When it calculates new state and a write intent and the writer is killed before T5 commit
    Then the previous state revision remains unchanged
    And the event remains unconsumed
    And no new Effect, Reservation or OutboxIntent is committed
    And C is 0 and S is 0
    When the writer restarts with the hook disabled and the same event is delivered to the same pinned reducer
    And the resulting write completes
    Then the event is consumed once and its intent exists once
    And C is 1 and S is 1

  @RT-024
  Scenario: An exception thrown by reducer is a failed invocation, not an automatic retry
    Given an unconsumed event invokes the reducer-throws fixture
    When the pinned reducer function throws before returning ReducerResult
    Then no partial state or new Effect, Reservation or OutboxIntent is committed
    And one separate valid CommitBatch records phase failed, REDUCER_EXECUTION_FAILED and the failed consumed marker
    And the previous reducer state is preserved
    And subsequent event delivery does not execute the failed reducer again
    And C is 0 and S is 0

  @RT-024
  Scenario: A failed poison-event failure commit stops scheduling until storage recovers
    Given the reducer threw before returning and its event is still pending
    When storage also rejects the separate failed-and-consumed CommitBatch
    Then the scheduler stops processing invocations rather than retrying the poison reducer in a loop
    And the old state and pending event remain available for recovery
    And no partial failure marker or new effect exists
    And C is 0 and S is 0

  @RT-025
  Scenario Outline: Invalid transitions cannot fabricate success or mutate terminal results
    Given an Invocation has phase <initial> and waitingReason null
    When a transition directly requests phase <target>
    Then the response is INVALID_TRANSITION
    And the original phase, result and revision remain unchanged
    And no effect or task acceptance is emitted
    And C is 0 and S is 0
    Examples:
      | initial   | target    |
      | queued    | succeeded |
      | succeeded | active    |
      | failed    | succeeded |
      | cancelled | succeeded |

  @RT-025
  Scenario: Waiting reasons and terminal cancellation uncertainty are independent
    Given an unknown Attempt belongs to a cancelled invocation
    When its runtime projection is loaded after restart
    Then phase is cancelled and control is cancel_requested
    And waitingReason is null
    And unresolvedEffectIds contains the unknown effectId
    And the unknown reservation remains reserved
    And C is 0 and S is 0
