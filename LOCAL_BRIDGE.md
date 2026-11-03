# Local Codex connection

The opt-in bridge runs alongside the private queue. It owns an explicitly selected existing Codex session through the installed CLI's app-server protocol. The bridge continues the same thread ID with its persisted history, configuration, and instructions. It never forks, creates replacement sessions, overrides model settings, or forcefully acquires a writer lock.

## Connect

With the bridge stopped, select an exact existing session and checkout:

```sh
node queue.mjs bind --thread EXISTING_SESSION_ID --checkout /absolute/path/to/orchard
npm run bridge
```

The binding command verifies the provider's session ID and Git checkout before saving `.repo-connect/bridge-bindings.json`. Start prints the private launch link. Paths and IDs stay local. No API key is copied; the installed Codex app-server uses its own normal authentication. Binding does not start a model turn. Desktop sessions still held by another writer are reported unavailable; close/release that session in its owner before trying again. Do not delete provider writer locks.

Only bound sessions use automatic dispatch. Other queue cards retain the existing manually operated desktop relay. The default `npm run queue` still starts the queue without its own model connection.

## One chapter

1. Read the last source report and three suggested directions. Bridge results use a structured recap and three model-written prompts; older results use the deterministic fallback.
2. Choose or write a direction, edit it, review it, and approve its exact text.
3. The bridge refreshes the session while holding its native writer lease, then claims the approved request before calling `turn/start` once.
4. The request receipt becomes `clientUserMessageId`. Delivery is accepted only after read-back finds the exact prompt and matching client ID in a new turn of the same session.
5. The result returns to the queue with three fresh paths. No choice starts itself. The browser refreshes local observations every three seconds, pausing rerenders during editing. Provider status polling does not invoke models.

Timeouts and lost responses stay uncertain and are read back, never blindly resent. An active turn blocks another request. Pending approvals are not automatically accepted: command and file approval requests can be declined, while other request types remain paused. Interrupt is available for a live owned turn. Full permission-granting forms are not implemented.

## Stop and recover

Run the bridge in a terminal and press Ctrl+C for normal shutdown. A local authenticated POST to `/api/bridge/stop` with an empty JSON body also shuts it down after checking that no turn is active. Its authorization and Origin requirements are identical to queue mutations. Stop an active step before disconnecting.

`.repo-connect/bridge.lock` prevents two local bridges. After a crash, inspect the recorded PID and stop any surviving owned app-server before removing a stale bridge lock. Never remove a live lock. Restart with the same bindings and journal: uncertain requests are reconciled, not resent. No OS login service or scheduled startup is installed.

## Scope of this milestone

Verified against the installed Codex CLI 0.153.4 on Windows. Its managed-daemon lifecycle is Unix-only, so this bridge uses private stdio rather than attaching to the desktop's private process transport. Independent app-server `notLoaded` status is not proof that a desktop task is idle; the native writer lock is required.

The bridge uses the normal CLI configuration. Desktop-only injected tools are not inherited. It cannot simultaneously drive a task still owned by the desktop, and it does not yet replace every desktop feature. Claude Code and Claude Desktop are not connected. The connection is persistent for the lifetime of this local service, not an OS startup service.

Tests cover exact delivery, result import, lost-response reconciliation, writer exclusion, pending permissions, structured chapters, and existing queue guards. A private real-session test additionally proved history recall after closing and reopening the connection, then browser approval, automatic dispatch, and a structured result in that same session. Public examples are fictional.
