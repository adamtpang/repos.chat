# Private conversation queue — first slice

The default desktop-relay mode is described below. An opt-in persistent local Codex connection is now implemented separately in [LOCAL_BRIDGE.md](LOCAL_BRIDGE.md). Run `npm run bridge` for explicitly bound sessions; it automatically delivers approved directions and imports results while holding the provider's native writer lease. Claude remains unsupported.

`npm run queue` starts a loopback-only interface. Open the private launch link printed by the terminal. The capability token stays in the URL fragment/session storage and is required for every data request. There are no remote assets or provider credentials. Nothing in this queue is served by the public site, whose output must remain `public/` only.

This slice uses **supported Codex desktop tools through an active Codex task relay**. It is not an unattended desktop bridge: the standalone Node server cannot invoke Codex desktop tools. Claude and other sources are unsupported. It never starts, forks, interrupts, resumes, or creates a task, and it does not use `codex exec`. There is no always-running Eve/model process; each imported repository is represented by a bounded queue card.

## Discovery and review

The relay uses `mcp__codex_app__list_threads` to find candidate IDs and checkouts, then `mcp__codex_app__read_thread` to read the selected existing task. Only explicitly selected local Codex tasks are imported. The CLI does not scan a vault or import every project's history.

The supported task list does not expose the sidebar's red/unread flag. An owner request to review red tasks therefore needs an owner-supplied cohort; idle and notLoaded must never be substituted for red. A bounded owner-authorized continuation pass is not permission to auto-prompt indefinitely. Record each selected destination and prompt through the same approval journal before dispatching.

Save that tool result privately and run:

```sh
node queue.mjs import --file /private/read-result.json --checkout /workspace/orchard
node queue.mjs show
```

`--checkout` is an independently selected real repository. Git resolves the session's CWD and common directory; linked worktrees are supported and their exact destination stays visible. Titles are display text only. The queue stores the source timestamp, observation time, last turn ID/status, reported result, and source revision. Reported work is not independently proven merely because its source is verified. A fresh idle or notLoaded runtime with a terminal last turn can continue that existing task. An unloaded in-progress turn, missing turn or system error cannot. Runtime and turn status remain separately visible; unloaded never means red. Live approvals and input requests must be resolved in the original task in this slice.

When the newest turn's text is unavailable, an earlier visible result retains its own turn ID and timestamp and is explicitly labeled earlier. Review annotations persist priority, evidence references, next action, and ready/needs-owner/external-blocker/done/parked disposition. Parked and done tasks cannot be prompted without a new explicit review. Failures with verified receipts return to attention even when the runtime reports an error.

The owner/relay drafts the next decision, exact prompt, importance (0–3), urgency (0–3), explanation and explicit unresolved card dependencies. The score is importance × 4 + urgency, with unblocked actionable cards first. It is not an unread/recency score. Dependencies remain blocked until explicitly reviewed and cleared; no inferred goal completion clears them. Remaining cards stay accessible, including running and uncertain tasks. No periodic model polling or repeated prompts occur.

## Approval and delivery

The owner edits a reply, chooses **Review exact reply**, then **Approve this reply for Codex relay**. The second control displays the immutable text, task ID, host and checkout. Editing any field disables the old approval. This records approval locally and does not itself invoke a provider. An active relay task must process it.

`queue-relay.mjs` exports `refresh`, `dispatchApproved`, and `recover`, accepting the supported desktop tool functions as callbacks. Tests exercise this exact adapter with synthetic callbacks. In the Codex tool runtime, where Node imports are unavailable, the equivalent relay is:

1. Read the approved request from `node queue.mjs show`. If it is already attempted, never send again.
2. Call `read_thread` for its exact destination; save and import the result. Runtime must be idle or notLoaded with a terminal last turn, observation under 60 seconds old, and source revision unchanged since approval. Active/in-progress/unknown states fail closed. No title matching and no configuration overrides.
3. Run `node queue.mjs claim --request REQUEST_ID`. This atomically creates the durable attempt/receipt ID **before** returning one `mcp__codex_app__send_message_to_thread` call. Invoke exactly its returned arguments once. Never add wording, substitute IDs, or use another send tool.
4. Preserve the raw tool response with `node queue.mjs record-response --request REQUEST_ID --receipt RECEIPT_ID --file RESPONSE_JSON --sender-thread RELAY_TASK_ID`. On timeout, exception, ambiguous response or process death, leave the attempt uncertain.
5. Read the same task back with `includeOutputs: true` and `maxOutputCharsPerItem: 20000`, then `node queue.mjs reconcile --request REQUEST_ID --file READ_JSON`. Acceptance requires one new destination turn containing the exact prompt and an appropriate source timestamp. Desktop task delivery appears as `functionCallOutput` from `codex_app.send_message_to_thread`, containing a delegation envelope; its source task must also match the recorded relay ID and the output must not be truncated. Ordinary exact user messages are also recognized. Active-turn items may not yet be available; **never blindly resend** while waiting for read-back. An unresolved attempt blocks another request to that card.
6. Import the fresh read result. Accepted means awaiting results. When the identified receipt turn completes and is imported, its result returns for owner review. There is no completion XP or goal-complete transition.

The tool runtime must already have owner authorization: normally the exact-reply control, or an explicit bounded continuation pass whose exact destinations/prompts and authority are recorded in the same journal. A screenshot identifies the cohort; it is not by itself dispatch authority. Discovery and drafting alone never authorize dispatch, and a bounded pass never authorizes perpetual prompting.

## Durability and limits

The existing `.repo-connect` local storage boundary is reused. `queue/` contains immutable numbered events, exclusive write locking, flushed temporary writes and atomic rename. Requests and receipts survive process restart. Crash locks deliberately do not expire; inspect the recorded PID before manually removing an abandoned lock. Corrupt journal entries fail closed. Local filesystem access is trusted, as it is for the existing mailbox; Windows account ACLs provide file privacy. Do not copy this directory to a public build or shared drive.

No provider-side idempotency key or atomic “send only if idle” precondition is exposed by the desktop send tool. Local duplicate suppression and a fresh state check reduce risk but cannot eliminate a different actor starting work in the interval before the call. Do not operate the destination concurrently during an approved relay. Unknown deliveries are reconciled through exact-text read-back, never retransmitted. A matching message from another actor in that interval is not distinguishable by a provider request ID. Long/truncated history may require manual read-back; if proof cannot be established, leave uncertain.

The local UI does not automatically wake a stopped relay task. Approval may therefore remain queued until the owner returns to the relay. This limitation is visible in the UI; a standalone supported transport would be a separate later slice.

## Verification

Run `npm test` and `node repos.mjs verify --root .`. Tests cover same-session synthetic round trips, approval binding, duplicate suppression, crash/restart recovery, running/changed/unsupported sources, Git worktree identity, dependencies, receipt evidence and HTTP privacy boundaries. A real dispatch requires separate exact approval; a synthetic pass must never be reported as a real round trip.
# Pet briefings and priority queue

The private queue can attach revision-bound pet briefings from `.repo-connect/pet-briefings.json`. Each card explains its intended outcome, current state, blocker, last result and three next prompts. Last-prompt text comes from the supported task observation. Missing facts stay explicitly unknown. Source details remain expandable.

Each `cards[cardId]` entry contains `revision`, `briefing` (`ideal`, `current`, `blocker`, `last`, `needsInput`, `sources`), an optional three-path `chapter`, and `priority` (`rank`, `reason`, `sources`, `observedAt`, `expiresAt`). Only entries matching the current task revision are used. Expired priority context does not rank a card. Keep this file private; it is never part of the public website.

The queue advances after an approved request has a verified receipt matching a freshly observed active turn. Approval, copying a prompt and uncertain delivery do not advance it. Editing a draft suppresses automatic navigation. Paused projects, unresolved dependencies and working tasks are excluded from the next-pet selection. This transition requires fresh observations from an active desktop relay; the standalone page cannot refresh Codex or invoke its tools by itself. Native approval/input flags are displayed as blockers, not answered by ordinary follow-up prompts. Unread red badges are not available through the task API and are never inferred from `notLoaded`.
