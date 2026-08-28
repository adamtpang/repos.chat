# Project Learnings

> Managed by `/learn`. Append-only — latest entry wins on conflicts.

## Patterns

### normalized-ordered-conversation-seam
- **Insight:** Cross-repository triage should exchange a normalized chronological conversation, because turn ownership and open-loop state cannot be derived safely from only the newest event.
- **Confidence:** 10/10
- **Source:** repos-chat
- **Date:** 2026-08-28

## Pitfalls

### synthetic-incoming-message-destroys-turn-state
- **Insight:** An adapter that collapses a thread to one synthetic incoming message will incorrectly make every thread look like the human owes a response.
- **Confidence:** 10/10
- **Source:** repos-chat
- **Date:** 2026-08-28

### documented-tiebreak-is-not-runtime-parity
- **Insight:** Do not claim ranking parity across repositories until tie-breaking rules are implemented explicitly and covered by the same fixtures.
- **Confidence:** 10/10
- **Source:** repos-chat
- **Date:** 2026-08-28

## Preferences

### human-performs-final-communication
- **Insight:** Repository collaboration may prepare editable drafts, but the human performs every final person-to-person communication action.
- **Confidence:** 10/10
- **Source:** manual
- **Date:** 2026-08-28

## Architecture

### advisory-contract-before-transport
- **Insight:** Stabilize a pure advisory input/output contract before adding transport, shared credentials, or direct cross-repository mutations.
- **Confidence:** 9/10
- **Source:** repos-chat
- **Date:** 2026-08-28

### draft-only-port-must-be-structurally-send-free
- **Insight:** A draft-only integration should use a pure MIME builder and an injected port that exposes draft creation but no send operation, rather than importing from a general mail module that also contains send functions.
- **Confidence:** 10/10
- **Source:** repos-chat
- **Date:** 2026-08-28

## Tools
