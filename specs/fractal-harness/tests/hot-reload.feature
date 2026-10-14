Feature: Every plugin supports generation-safe hot reload
  Background:
    Given a file-backed harness with active generation "g1" and host ABI "fractal.host.v1"
    And all plugin packages implement the declared ReloadParticipant contract
    And independent fake transport counters are C=0 and S=0

  @HR-001
  Scenario Outline: Each plugin category switches without restarting its host
    Given a compatible new implementation of plugin category "<category>"
    When I hot reload that package using expected generation "g1"
    Then the active generation is "g2"
    And the daemon process identity is unchanged
    And a new operation uses the new implementation
    And all prior durable object identifiers and values remain available
    Examples:
      | category |
      | meta |
      | store |
      | lifecycle |
      | execution |
      | api |
      | llm |
      | tools |
      | memory |
      | ui |
      | bridge |

  @HR-002
  Scenario: A running invocation finishes on its pinned generation
    Given one invocation in "g1" is waiting for a held model completion
    When I publish "g2" and submit a new invocation
    And I release the original completion
    Then the original invocation uses only "g1" bindings and code
    And the new invocation uses only "g2" bindings and code
    And each logical effect is delivered once
    And the root budget has no duplicated charge

  @HR-003
  Scenario Outline: Failure before publication leaves the old version operational
    Given candidate "g2" fails at "<cut>"
    When I request hot reload
    Then I receive "RELOAD_PREPARE_FAILED" with the original cause in diagnostics
    And the active generation remains "g1"
    And candidate resources are disposed without deleting old resources or data
    And the next operation on "g1" succeeds
    Examples:
      | cut |
      | capture |
      | restore |
      | ready |
      | compilation |

  @HR-004
  Scenario: UI reload preserves two independent dirty drafts
    Given mounts "m1" and "m2" show the same object with drafts "alpha" and "beta"
    When their compatible renderer and a nested badge are hot reloaded
    Then mount identifiers, object references and both drafts are unchanged
    And child mounts retain stable binding identity within each parent
    And a late "g1" callback cannot overwrite either "g2" draft
    And no cancel or purge command is sent

  @HR-005
  Scenario: Store handover never creates a second writer or partial transaction
    Given one store transaction is held before commit
    When store reload reaches its admission barrier
    And I release the transaction
    Then the transaction commits completely under its original generation
    And the new store takes the same writer lease and storeId
    And subsequent writes use the new implementation
    And old revisions and committed events remain readable

  @HR-006
  Scenario Outline: Publication and recovery share a durable generation boundary
    Given a reload is held at "<cut>"
    When the daemon process is terminated and restarted on the same storage
    Then active generation is "<expected>"
    And no candidate partial registry is visible
    And old invocation locks are recoverable
    Examples:
      | cut | expected |
      | before publication commit | g1 |
      | after publication commit before route swap | g2 |

  @HR-007
  Scenario: Rapid edits cannot publish a stale build
    Given watch revision 2 starts building before revision 3
    When build 3 becomes ready before build 2
    And both completion barriers are released
    Then only revision 3 becomes active
    And revision 2 is disposed as stale
    And generated artifact files do not trigger another source build

  @HR-008
  Scenario: A reload receipt is idempotent and generation CAS is enforced
    Given reload key "reload-1" published "g2" from "g1"
    When I repeat the same request and key
    Then I receive the same reload receipt
    And no additional activation occurs
    When I change the payload using "reload-1"
    Then I receive "IDEMPOTENCY_CONFLICT"
    When a different key tries to publish against stale "g1"
    Then I receive "REVISION_CONFLICT"

  @HR-009
  Scenario: Retained packages preserve replay and unknown external outcomes
    Given an old invocation has an unknown non-retryable external write with C=1 and S=1
    When I reload its feature and execution packages
    Then no retry occurs and counters remain C=1 and S=1
    And its reservation and exact source lock remain retained
    And replay of a completed old invocation uses recorded results with zero live calls
    And purge of its referenced old package returns "LIVE_REFERENCES"

  @HR-010
  Scenario: Each generation cleans up only its own resources
    Given "g1" and "g2" each own an observation subscription
    And one old invocation still retains "g1"
    When "g2" becomes active
    Then "g1" is retained and not disposed early
    When the final old reference is released
    Then "g1" cleanup runs once
    And the "g2" subscription remains active
    And a cleanup exception is logged without rolling back "g2"

  @HR-011
  Scenario: Version identity stays immutable during development reload
    Given package version "1.0.0" is installed with digest "A"
    When changed bytes are staged under the same published version
    Then I receive "DEFINITION_CONFLICT"
    When watch mode stages the edit as version "1.0.0-dev.7"
    Then a distinct exact artifact reference is published
    And the original source manifest and published artifact remain unchanged

  @HR-012
  Scenario: Incompatible snapshots and fixed host ABI changes do not corrupt active plugins
    Given a candidate cannot restore the declared old snapshot type
    When I request reload
    Then I receive "RELOAD_PREPARE_FAILED"
    And old state and active generation remain unchanged
    When a candidate requests a different fixed host ABI
    Then I receive "UNKNOWN_ABI"
    And no host code is modified or restarted implicitly
