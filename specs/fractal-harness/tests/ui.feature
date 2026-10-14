Feature: Plugin-defined UI, storage, history and forks
  All types, operations, views and domains below are contributed by fixture plugins.
  The fixture runner uses deterministic opaque revision tokens and IDs for assertions.
  The scenario labels are normative acceptance IDs, not evidence of implemented tests.

  Background:
    Given a fresh SQLite database "test.db" with transaction domain "sqlite:test"
    And the root scope is the opaque token "scope-A" with no domain type
    And plugin instance "owner-A" owns namespace "ns-A" in "scope-A" and store "local"
    And plugin instance "owner-B" owns namespace "ns-B" in "scope-B" and store "local"
    And principal "alice" has read and mutate capabilities only for "owner-A" in "scope-A"
    And each digestOf expression below resolves to the actual fixture artifact digest defined by CONTRACTS C02
    And DefinitionRef alias "ChecklistV1" is:
      | packageId     | packageVersion | digest       | name      |
      | fixture.lists | 1.0.0          | digestOf(fixture.lists@1.0.0) | Checklist |
    And ContractRef alias "RenderableV1" is:
      | packageId  | packageVersion | digest      | name       |
      | fixture.ui | 1.0.0          | digestOf(fixture.ui@1.0.0) | Renderable |
    And the following immutable definition aliases are registered:
      | alias       | packageId     | packageVersion | digest      | name      |
      | ChecklistV2 | fixture.lists | 2.0.0          | digestOf(fixture.lists@2.0.0) | Checklist |
      | BadgeV1     | fixture.badge | 1.0.0          | digestOf(fixture.badge@1.0.0) | Badge     |
      | ForkableV1  | fixture.fork  | 1.0.0          | digestOf(fixture.fork@1.0.0)  | Forkable  |
      | ListOpsV1   | fixture.lists | 1.0.0          | digestOf(fixture.lists@1.0.0) | ListOps   |
    And render implementations export exact ContractRef "RenderableV1"
    And separate ViewDefinitions use exact targetTypes "ChecklistV1" and "ChecklistV2"
    And each public invoke sets targetInstanceId "owner-A", assemblyRevision "assembly-old", an exact OperationRef and a nonempty idempotencyKey
    And UI gets assemblyRevision from its ViewMount and all retries preserve the original InvocationRequest
    And domain object targets and expectedRevision values are fields of operation input
    And object alias "list-A" resolves to:
      | storeId | namespaceId | objectId | type        | revision |
      | local   | ns-A        | entity-A | ChecklistV1 | rev-red  |
    And "list-A" has value:
      """
      {"title":"First","done":false,"secret":"do-not-render"}
      """
    And plugin-owned Head fixture "active-list" has a stable Head type and points to "list-A" at revision "active-red"
    And field "/secret" is omitted from alice's render projection
    And external effect counter is 0
    And local state change event counter is 0

  @UI-001
  Scenario: Multiple mounts share data identity and retain owner-scoped storage
    Given "mount-left" and "mount-right" display "list-A" through instance "owner-A"
    When "mount-left" is closed and "mount-new" displays "list-A"
    Then "mount-right" and "mount-new" both target objectId "entity-A" in namespace "ns-A"
    And "owner-A", "entity-A", "mount-right" and "mount-new" are distinct identifiers
    And the namespace count for pair "owner-A,scope-A" is 1
    And namespace for pair "owner-A,scope-B" differs from "ns-A"
    And namespace for pair "owner-C,scope-A" differs from "ns-A"
    And exactly 1 ChecklistV1 object exists in "ns-A"

  @UI-002
  Scenario: Saving in one mount preserves a conflicting dirty draft in another
    Given "mount-left" has draft title "Left" based on "rev-red"
    And "mount-right" has draft title "Right" based on "rev-red"
    When "mount-left" saves using expectedRevision "rev-red" and key "save-left"
    And "mount-right" receives the resulting "rev-blue" event
    And "mount-right" saves using expectedRevision "rev-red" and key "save-right"
    Then the second command returns "REVISION_CONFLICT" with current revision "rev-blue"
    And the persisted title is "Left"
    And "mount-right" retains dirty draft title "Right" and baseRevision "rev-red"
    And local state change event counter is 1

  @UI-003
  Scenario: Closing a view never cancels an active invocation
    Given invocation "inv-1" is running for "list-A" under pinned package "fixture.agent@1.0.0"
    And "mount-left" observes "inv-1"
    When "mount-left" is unmounted
    And "inv-1" completes with output "answer-1"
    And "mount-new" opens the same invocation
    Then cancel command count is 0
    And "mount-new" shows invocationId "inv-1" and output "answer-1"
    And "mount-left" has 0 live event listeners

  @UI-004
  Scenario: Disable and uninstall preserve pinned work and durable data
    Given invocation "inv-1" is running under package "fixture.lists@1.0.0"
    And "history-1" durably references version "list-A@rev-red"
    When instance "owner-A" is disabled
    And a new mutation command targets "owner-A"
    Then the new command returns "PLUGIN_DISABLED"
    When package "fixture.lists@1.0.0" is uninstalled
    And an explicit purge requests its code and data
    Then purge returns "LIVE_REFERENCES" including "inv-1" and "history-1"
    And "list-A@rev-red" remains readable through an authorized inspector
    And pinned code "fixture.lists@1.0.0" remains available to "inv-1"
    When "inv-1" completes and the same package is reinstalled
    Then "list-A" still has objectId "entity-A" and title "First"
    And no data reset or migration occurred

  @UI-005
  Scenario Outline: Missing or incompatible renderer falls back without leaking fields
    Given the renderer binding for "list-A" is "<binding>"
    When alice opens "list-A"
    Then the generic inspector shows code "VIEW_UNAVAILABLE" and title "First"
    And specialized renderer invocation count is 0
    And neither inspector payload nor rendered text contains "do-not-render"
    Examples:
      | binding                         |
      | missing                         |
      | disabled                        |
      | different-contract-version      |
      | exact-targetType-does-not-match |

  @UI-006
  Scenario: Independent plugin contributes to a newly declared typed slot
    Given plugin "fixture.lists" declares ordered slot "item.badges" with min 0 and max 10 accepting ContractRef "BadgeV1"
    And independent plugin "fixture.audit" exports implementation "badge-1" of exactly "BadgeV1"
    And the pre-install host source digest is "host-original"
    When the binding is installed:
      | parentInstanceId | slot        | childInstanceId | order |
      | owner-A          | item.badges | badge-1         | 0     |
    Then the binding is active and badge text is "verified"
    And the post-install host source digest is "host-original"
    And no host route, switch case or component import was added

  @UI-007
  Scenario Outline: Invalid bindings fail before any assembly change
    Given active assembly digest is "assembly-old"
    And a candidate assembly has violation "<violation>"
    When the candidate assembly is validated and activated
    Then activation returns "<error>"
    And active assembly digest remains "assembly-old"
    And child activation count is 0
    Examples:
      | violation                                  | error                  |
      | child exports another registered contract with identical schemas | CONTRACT_MISMATCH |
      | child exports a registered different contract version            | CONTRACT_MISMATCH |
      | two children occupy a single slot         | SLOT_CARDINALITY       |
      | owner-A owns child-C which owns owner-A    | OWNERSHIP_CYCLE        |
      | owner-A and owner-B both own child-C       | MULTIPLE_OWNERS        |
      | a keyed slot contains duplicate key audit | DUPLICATE_SLOT_KEY     |
      | ordered slot contains duplicate order 0   | DUPLICATE_SLOT_ORDER   |

  @UI-008
  Scenario: UI, CLI and API use one idempotent command implementation
    Given operation "completeItem" sets "list-A.done" to true and has handler counter 0
    When UI, CLI and API invoke targetInstanceId "owner-A" operation "ListOpsV1.completeItem" with identical input containing object "list-A", expectedRevision "rev-red" and key "complete-1"
    Then all three receipts contain request "req-complete-1" and invocation "inv-complete-1"
    And handler counter is 1
    And "list-A.done" is true
    And local state change event counter is 1
    When current assembly changes to "assembly-new"
    And API retries the original request with assemblyRevision "assembly-old" and key "complete-1"
    Then receipt still contains request "req-complete-1" and invocation "inv-complete-1"
    When API reuses key "complete-1" but changes only assemblyRevision to "assembly-new"
    Then API returns "IDEMPOTENCY_CONFLICT"
    And handler counter remains 1
    When API retries the original request with key "complete-1" except input.expectedRevision is "rev-blue"
    Then API returns "IDEMPOTENCY_CONFLICT"
    And handler counter remains 1

  @UI-009
  Scenario Outline: A forged namespace or cursor is not a capability
    Given "ns-B" contains objectId "entity-secret" with title "Hidden"
    And private revision is "rev-secret" and subscription cursor is "cursor-B"
    When alice performs "<operation>" against "ns-B"
    Then the response is "CAPABILITY_DENIED"
    And the response contains none of "Hidden", "rev-secret" and "entity-secret exists"
    And private storage read counter is 0
    And private subscription delivery counter is 0
    Examples:
      | operation                             |
      | read entity-secret                    |
      | invoke completeItem on entity-secret |
      | list namespace ns-B                   |
      | resume cursor-B                       |

  @UI-010
  Scenario: Historical records keep the version that was observed
    Given "history-1" references "list-A@rev-red"
    When title of "list-A" changes to "Second" at revision "rev-blue"
    Then latest view shows title "Second"
    And "history-1" shows title "First" from revision "rev-red"
    When the fixture marks version "rev-red" unavailable
    Then opening "history-1" returns "SNAPSHOT_UNAVAILABLE"
    And "history-1" does not substitute title "Second"

  @UI-011
  Scenario: A fork applies explicit policies and remaps owned children
    Given terminal source "root-1@rev-root" has links:
      | path    | target               | relation  | policy    |
      | /child  | child-1@rev-child    | owned     | clone     |
      | /ticket | ticket-1@rev-ticket  | reference | reference |
      | /draft  | draft-1@rev-draft    | owned     | reset     |
    And "child-1" contains text "copied" and "draft-1" contains text "discarded"
    And the declared draft initial state is "{\"text\":\"\"}"
    And all objects use transaction domain "sqlite:test"
    When executeFork invokes immutable plan "plan-1" with key "fork-1"
    Then the result root is "root-2" with a new entityId
    And ForkPlan.mappings contains clone "root-1 -> root-2", clone "child-1 -> child-2" and reset "draft-1 -> draft-2"
    And "root-2.child" targets "child-2" with text "copied"
    And "root-2.ticket" targets unchanged "ticket-1"
    And ForkPlan.mappings contains reference "ticket-1 -> ticket-1"
    And "root-2.draft" targets "draft-2" with empty text
    And provenance references "root-1@rev-root"
    And external effect counter is 0

  @UI-012
  Scenario Outline: Unsupported or incomplete fork plans create no objects
    Given terminal source "root-1@rev-root" has fork problem "<problem>"
    And total durable object count is 4
    When a fork is planned and committed if planning succeeds
    Then the operation returns "<error>"
    And total durable object count is 4
    And fork provenance record count is 0
    And external effect counter is 0
    Examples:
      | problem                                  | error                |
      | root type has no exact Forkable contract | FORK_UNSUPPORTED     |
      | a reference link has no policy           | FORK_UNSUPPORTED     |
      | an owned link has reference policy       | FORK_UNSUPPORTED     |
      | a link has reject policy                 | FORK_UNSUPPORTED     |
      | two links to one source request different policies | FORK_UNSUPPORTED |
      | snapshot child-1@rev-child is missing    | SNAPSHOT_UNAVAILABLE |

  @UI-013
  Scenario: Fork commit guards every planned source revision
    Given "plan-1" reads terminal "root-1@rev-root" and "child-1@rev-child"
    And planned durable object creation count is 2
    When "child-1" changes to revision "rev-changed"
    And executeFork invokes "plan-1" with key "fork-stale"
    Then commit returns "REVISION_CONFLICT"
    And newly created fork object count is 0
    And fork provenance record count is 0
    And external effect counter is 0

  @UI-014
  Scenario Outline: Fork requires a guarded terminal or quiescent checkpoint
    Given source "root-1@rev-root" has execution state "<state>"
    And source has pending child calls "<children>" and pending external effects "<effects>"
    And source write admission is "<admission>"
    When a fork is planned and committed
    Then the fork result is "<result>"
    Examples:
      | state      | children | effects | admission | result           |
      | terminal   | 0        | 0       | closed    | committed        |
      | quiescent  | 0        | 0       | closed    | committed        |
      | running    | 0        | 0       | open      | CHECKPOINT_NOT_FORKABLE |
      | quiescent  | 1        | 0       | closed    | CHECKPOINT_NOT_FORKABLE |
      | quiescent  | 0        | 1       | closed    | CHECKPOINT_NOT_FORKABLE |
      | quiescent  | 0        | 0       | open      | CHECKPOINT_NOT_FORKABLE |

  @UI-015
  Scenario Outline: Fork is atomic, retryable and produces no external effects
    Given source "root-1@rev-root" references already created ticket "EXT-7"
    And "plan-1" creates exactly 3 objects and uses reference policy for "EXT-7"
    And external effect counter is 7
    When executeFork with key "fork-retry" reaches process crash failpoint "<failpoint>"
    And the runtime restarts on the same SQLite database
    Then durable fork object count before retry is <beforeRetry>
    When executeFork with key "fork-retry" is retried twice
    Then both retries resolve to root "fork-root-1"
    And durable fork object count is 3
    And fork provenance record count is 1
    And external effect counter is 7
    Examples:
      | failpoint                       | beforeRetry |
      | after second insert before COMMIT | 0           |
      | after COMMIT before response      | 3           |

  @UI-016
  Scenario: Migration loses a CAS race without partial schema changes
    Given migration "migrate-v2" has read "list-A@rev-red"
    And its MigrationPlan fixes head "active-list@active-red" and new destination "list-A-v2"
    When a user saves title "Concurrent" at revision "rev-blue"
    And "migrate-v2" tries committing a new ChecklistV2 object with source readSet "list-A@rev-red"
    Then migration returns "REVISION_CONFLICT"
    And latest object type remains "ChecklistV1"
    And latest title is "Concurrent" at revision "rev-blue"
    And no ChecklistV2 target object was created
    And Head "active-list" still points to "list-A" at revision "active-red"
    And local state change event counter is 1

  @UI-017
  Scenario: Invalid migration output preserves the original record and event log
    Given migration "migrate-v2" for "list-A@rev-red" returns output violating the ChecklistV2 schema
    When the migration is invoked
    Then the invocation fails with "INVALID_OUTPUT"
    And "list-A" retains type "ChecklistV1", revision "rev-red" and title "First"
    And local state change event counter is 0

  @UI-018
  Scenario: A migration cannot erase or silently save an old dirty draft
    Given "mount-left" has dirty title "Unsaved" with base object "list-A@rev-red" and active-reference guard "active-red"
    And MigrationPlan fixes source "list-A@rev-red", head "active-list@active-red" and destination "list-A-v2" of type "ChecklistV2"
    When migration creates "list-A-v2" of type "ChecklistV2" and revision "rev-green" in its declared namespace
    And migration atomically switches "active-list" to "list-A-v2" at revision "active-green"
    And "mount-left" receives the migration event
    Then "mount-left" retains dirty title "Unsaved" and indicates conflict
    When "mount-left" submits the old draft through saveList with expectedRevision "rev-red" and expectedActiveRevision "active-red"
    Then submission returns "REVISION_CONFLICT"
    And "active-list" still points to "list-A-v2" of type "ChecklistV2" at revision "rev-green"
    And historical "list-A@rev-red" still has type "ChecklistV1" and title "First"
    And Head "active-list" retains its original Head type
    And "mount-left" still offers draft export and discard

  @UI-019
  Scenario: Duplicate delivery and an expired cursor converge without losing drafts
    Given subscription snapshot has title "First" and cursor "cursor-red"
    And "mount-left" has dirty title "Unsaved" based on "rev-red"
    When event "event-blue" with previousCursor "cursor-red", cursor "cursor-blue" and title "Second" is delivered twice
    Then authoritative cache applies "event-blue" exactly once
    When the client disconnects and server advances title to "Third" at cursor "cursor-green"
    And resuming "cursor-blue" returns "CURSOR_EXPIRED"
    Then the client requests one new consistent snapshot and cursor
    And authoritative cache has title "Third" and cursor "cursor-green"
    And "mount-left" retains dirty title "Unsaved" and indicates conflict

  @UI-020
  Scenario: A crash after commit cannot separate persisted state from its event
    Given a title update to "Committed" uses key "save-committed"
    When the process stops after SQLite COMMIT and before event publication and command response
    And runtime restarts and alice resumes from the pre-update cursor
    Then latest title is "Committed"
    And exactly one state change event for revision "rev-blue" is eventually observed
    When alice retries key "save-committed" with the same request
    Then the original request and invocation references are returned
    And local state change event counter is 1

  @UI-021
  Scenario: An external store cannot claim atomic membership in a local fork
    Given source "root-1@rev-root" owns child "remote-1@remote-rev"
    And "remote-1" is stored by an external adapter outside the shared SQLite transaction coordinator
    And both links request clone policy
    When a fork is planned and committed if planning succeeds
    Then the operation returns "DEPENDENCY_UNAVAILABLE"
    And local fork object creation count is 0
    And remote write counter is 0
    And external effect counter is 0

  @UI-022
  Scenario: An independent extension survives alternate views and a restart
    Given host source digest is "host-original" and no Checklist type is built into the host
    When package "fixture.lists" declares ChecklistV1, completeItem, its renderer, storage and slot "item.badges"
    And package "fixture.audit" binds a compatible badge into "item.badges"
    And "list-A" is opened in mounts "mount-left" and "mount-right"
    And CLI invokes completeItem with key "vertical-complete"
    And runtime restarts with the same assembly and database
    And the Checklist renderer is disabled
    Then both reopened mounts target objectId "entity-A" in namespace "ns-A"
    And generic inspector shows "done" equal to true without field "secret"
    And total ChecklistV1 object count in "ns-A" is 1
    And host source digest remains "host-original"

  @UI-023
  Scenario Outline: Fork write limit includes every domain and control record
    Given a valid terminal-source ForkPlan generates exactly <writes> RecordWrite entries including provenance and control records
    And total serialized CommitBatch size is below 10 MiB and each object is below 1 MiB
    And the plan uses only the shared SQLite transaction coordinator
    When executeFork invokes that plan with key "fork-size-boundary"
    Then the result is "<result>"
    And committed batch write count is <committed>
    And external effect counter is 0
    Examples:
      | writes | result            | committed |
      | 1000   | committed         | 1000      |
      | 1001   | PAYLOAD_TOO_LARGE | 0         |

  @UI-024
  Scenario: Child mounts are stable within one parent and isolated across parents
    Given ViewDefinition "ListView" references implementation "ListViewImpl" and declares no slots itself
    And ImplementationDefinition "ListViewImpl" owns ordered slot "item.badges" accepting "BadgeV1"
    And "mount-left" and "mount-right" both use viewInstanceId "owner-A", target "list-A" and assemblyRevision "assembly-old"
    And pinned binding "owner-A,item.badges,0" points to child instance "badge-old"
    When both renderers invoke context.renderSlot for slot "item.badges" with order 0 and valid props
    Then the two child mounts have distinct mountId values
    And both child mounts target objectId "entity-A" in namespace "ns-A"
    When the left child local expanded state becomes true
    And both parent views rerender
    Then each child retains its preceding mountId
    And left child local expanded state is true
    And right child local expanded state is false
    When latest assembly changes the binding to "badge-new" at revision "assembly-new"
    And the old mounts rerender
    Then both old mounts still render child instance "badge-old"
    And no namespace is created for either child mountId
    When "mount-left" invokes context.renderSlot with slot "unregistered"
    Then the mount reports "UNKNOWN_SLOT" without invoking any child renderer
