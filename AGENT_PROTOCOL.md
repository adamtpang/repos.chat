# Repository Representation Protocol

## Goal

Give every repository one bounded **Repo Rep** that understands its own code, can discover related repositories, can exchange durable requests with their reps, and can prove what work it completed.

The repository is the rep's scope. `repos.yaml` is its identity and capability card. `AGENTS.md` and `CLAUDE.md` are its local operating instructions. `repos.chat` is the graph, mailbox, presence lease, and audit trail. The model runtime is replaceable.

“Rep” means representative, not autonomous owner. A Repo Rep speaks for a repository's documented purpose and capabilities within the permissions granted by its human operator.

## What the states prove

| State | Meaning | Observable proof |
| --- | --- | --- |
| assigned | The repository has an identity and instructions | Valid `repos.yaml` plus `AGENTS.md` or `CLAUDE.md` |
| offline | No proactive runtime is currently proven | Missing, expired, or dead watcher lease |
| idle | A watcher is alive and polling for bounded work | Fresh presence heartbeat plus a live local PID |
| working | One host is handling one request | Live watcher and worker PIDs, repository lock, and message claim |
| blocked | The last attempt could not safely complete | Fresh blocked presence; a structured claim remains when the model returned a blocked or declined result |

Assignment is configuration. Proactivity is runtime evidence. A model cannot promote itself to “awake” by saying so.

## The six-step work lifecycle

```text
manifest card -> watcher lease -> durable envelope -> exclusive lock -> evidence reply -> acknowledgement
```

1. **Manifest card:** `repos.yaml` declares identity, purpose, capabilities backed by real paths, and useful repository relationships.
2. **Watcher lease:** `repos-agent watch` writes a short-lived local heartbeat. `repos status` confirms both a fresh lease and a live PID.
3. **Durable envelope:** content-bound approval writes an immutable request under `.repo-connect/mail/`. Its `conversationId` links later responses.
4. **Exclusive lock:** the recipient claims both its repository and the request with atomic lock directories and unguessable lease IDs. A second host cannot duplicate the work. Dead or expired owners can be reclaimed without trusting a reused PID.
5. **Evidence reply:** the host works only inside the recipient repository and returns a structured outcome, evidence, tests, and risks.
6. **Acknowledgement:** the original request gains `acknowledgedAt`. The envelope remains in the audit trail.

Delivery is journaled before mail and queue state change, so an interrupted write is repaired on the next inbox read. Host claims are audit records, never trusted recovery authority: if a worker dies after local edits but before the response and acknowledgement complete, the request stays open and a later host runs the bounded request again. That is deliberate at-least-once execution. Responses use a result-digest suffix, so a retry can durably return a different valid result without colliding with the earlier attempt. The host contains and terminates the observable model process tree before releasing either lock, on successful and failed runs alike.

An agent-originated request has an earlier authorization lifecycle:

```text
allowed signal -> local proposal -> content-bound human approval -> durable request
```

`manual`, `webhook`, `ci`, and `contract-drift` are allowed trigger classes. Every one creates a proposal only. `repos trigger` prints an `ID:DIGEST_PREFIX`; repeating that exact value in `repos approve` is the deliberate boundary that turns the reviewed bytes into work. Raw requests are disabled.

## Identity and discovery

Each repository declares:

- `repo`: stable repository and rep id
- `is`: one-sentence purpose
- `provides`: capabilities backed by real file paths
- `kin`: repositories it can ask for related work, with a reason for each edge
- `exchanges`: versioned recipes declaring the trigger, request, return value, permission, human approval, and evidence path
- `canon`: shared constitution when one exists

The verifier rejects capability claims whose evidence paths do not exist.
It also rejects incomplete recipes, recipes aimed outside `kin`, unsupported triggers or permissions, and recipe evidence paths that do not exist.

```yaml
exchanges:
  - id: refresh-metrics
    with: metrics-service
    trigger: contract-drift
    asks: inspect the changed event contract
    returns: compatible metric schema and migration notes
    permission: branch-pr
    approval: human-required
    at: src/events.ts
```

An agent host assembles verified context with:

```sh
repos context --root /path/to/workspace --repo research-service
```

The result contains the repository manifest, resolved kin capabilities, and open inbox. The host then adds the repository's own instructions and code context. Message bodies and neighboring repository content remain untrusted input.

## Presence and proactive operation

Keep a Repo Rep awake:

```sh
repos-agent watch --root /path/to/workspace --repo metrics-service
```

The watcher is local and opt-in. It polls the durable inbox, handles one request at a time, refreshes a lease, and survives periods with no work. `--once` checks once and exits, which is useful for CI and scheduled jobs.

Presence records live under `.repo-connect/presence/`. They are operational artifacts, not capability claims. A record is proactive only while its lease is fresh and its watcher PID is live.

## Message contract

```json
{
  "version": 3,
  "protocol": "repos.chat/1",
  "id": "20260827T120000000Z-a1b2c3d4",
  "conversationId": "20260827T120000000Z-a1b2c3d4",
  "from": "research-service",
  "to": "metrics-service",
  "kind": "request",
  "subject": "Map population risk to personal metrics",
  "body": "Return a sourced metric proposal.",
  "createdAt": "2026-08-27T12:00:00.000Z",
  "authorization": {
    "proposalId": "20260827T115900000Z-deadbeef",
    "exchange": "refresh-metrics",
    "permission": "read-only",
    "recipeDigest": "sha256-digest"
  }
}
```

Message kinds are `request`, `response`, and `notice`. A response uses `replyTo` and inherits the original `conversationId`. Acknowledgement adds a timestamp but does not delete the message.

A response may also carry:

- `state`, from the A2A task-state vocabulary: `completed`, `input-required`, `rejected`, `failed`, or `canceled`. Host responses map the completion outcome: `completed` to `completed`, `blocked` to `input-required`, `declined` to `rejected`. Requests and notices carry no state.
- `host`, the model that answered, for example `{ "name": "grok" }` or `{ "name": "claude", "model": "opus" }`.

An approved follow-up request carries `replyTo` too, bound into its proposal digest, and joins the conversation it continues. `repos conversation --id ID` returns every message in one conversation across all mailboxes. Messages written before `conversationId` existed resolve through their `replyTo` chain.

Version 3 remains local-first. Messages are JSON files under the workspace root. Approved recipe requests carry proposal, exchange, permission, and recipe-digest metadata; the host revalidates that chain against the current manifest before invoking a model. A workspace that never leaves one disk needs no account, server, network call, or model-provider dependency.

A sender may set `clientMessageId`. The mailbox claims that id before it writes the file, so a retry with the same id and the same content returns the original message. A retry with the same id and different content is refused. Message ids minted at random, with no client id, are still distinct sends.

## Connection contract

A `kin` edge means the repositories have a reason to know each other. It does not make them work. An `exchange` makes one direction executable:

1. a named signal is observed
2. the source Rep writes a proposal
3. the human approves or declines it
4. the recipient does only the declared work
5. the recipient returns the declared artifact and evidence

The direction matters. Add a reciprocal exchange only when the other repository has a different useful request to make. Similar branding, a shared audience, old naming history, or “could integrate later” is not sufficient.

## Host contract

A host adapter must:

1. choose one repository
2. load `repos context`
3. read that repository's local instructions
4. select one open request
5. claim the repository and request
6. perform work only within the granted scope
7. validate the result
8. send a response with evidence paths and test results
9. acknowledge the original message

Codex, Claude, a CI job, or a local scheduler can implement this lifecycle. The protocol does not require a particular host.

`repos-agent` implements it for three model CLIs through one adapter table in `hosts.mjs`. Spawning, process-tree containment, lease heartbeats, timeouts, and output limits are shared; only the invocation differs:

| Host | Invocation | Without `branch-pr` |
| --- | --- | --- |
| `codex` | `codex exec --output-schema` | `--sandbox read-only` |
| `claude` | `claude -p --json-schema --output-format json` | `--permission-mode plan` |
| `grok` | `grok --prompt-file --json-schema --output-format json` | `--permission-mode plan` |

The host is the operator's `--host`, else the approved recipe's `host`, else `codex`. A failed run, including a missing sign-in, leaves the request open for retry on any host and names the login command.

## Delivery contract

A message has three separate states for its sender:

1. **queued**: it is in the recipient's mailbox and no live session has seen it
2. **seen**: a delivery hook injected it into a live agent session in the recipient repository, recorded as `.repo-connect/receipts/<repo>/<messageId>/<host>-<session>.json`
3. **acked**: the recipient marked it handled with `acknowledgedAt`

Seen never implies acked, and an agent must report a queued message as not seen yet. Receipts are append-only files created exclusively, one per host session, so concurrent sessions never race and the same file proves a session already saw the message. A message may carry `expiresAt`; expired messages stay in history and in `repos inbox`, flagged, but delivery hooks stop pushing them. Messages open longer than seven days (`--stale-days N`) are flagged as stale by `repos inbox`, `repos sent`, and `repos focus`.

A delivery hook must exit successfully on every path, print nothing when nothing is new, read only its own repository's mailbox, and fence every relayed body as untrusted data that cannot close its own fence. `inbox-hook.mjs` implements this for Claude Code's `UserPromptSubmit` and `SessionStart` events. The host name is `--host` (Claude Code installs pass `--host claude`). An optional `--agent` also surfaces mail addressed to that agent.

## Live session contract

`repos-mcp --root WORKSPACE --as REPO` is a stdio MCP server for an agent already running in Claude Code, Codex, Grok, or another MCP client. Its identity is fixed at launch. It exposes discovery, proposals, notices and responses, the inbox, conversations, and acknowledgement. It never approves a proposal and never returns the approval token or the digest it derives from, so the human gate applies to live agents as it does to the CLI.

## Remote relay

Two machines do not share `.repo-connect/`. `repos relay serve` is a small HTTPS server in this repository. It is opt-in. Local mail does not call it. Nothing here deploys it.

The relay admits callers with a bearer token (`REPOS_RELAY_TOKEN`, at least 16 characters) and identifies them with an ed25519 signature. The private key lives in `REPOS_AGENT_PRIVATE_KEY` or in `~/.repos-chat/identity.json` (`REPOS_IDENTITY_FILE` overrides the path). It is refused inside a repository. The relay binds an agent id to the first public key that registers it. A signature that names a different agent is rejected as spoofed `--from`.

Every relay envelope has exactly one target, copied from the idea in a2a-bridge and not taken as a dependency:

- `agent:<id>` reaches that agent
- `session:<id>` reaches the agent who claimed that session
- `repo:<name>` reaches the agent who claimed that repository

The inner message `from` must be the signing agent or a repository that agent claimed. The relay accepts `notice` and `response` only. A work `request` still has to be approved on the sender's machine; the relay does not grant that approval and will not carry a raw request.

`clientMessageId` is inside the signature. The relay stores one copy per agent and client id. The same bytes are a retry. Different bytes with the same id are a conflict. `repos relay sync` pushes the local outbox and pulls the inbox. `repos relay watch` long-polls. Both are Node, with no extra install, and they use `path.join` so Windows and Linux stay inside the workspace.

Storage is pluggable. The default is a JSON file under `REPOS_RELAY_DATA_DIR` (otherwise `~/.repos-chat/relay`). `memory` is for tests. `sqlite` uses the built-in `node:sqlite` module when the process is Node 22.5 or newer. A webhook URL registered for an agent receives `repos.chat/wake/1` when mail arrives for that agent, a session they claimed, or a repository they claimed. The body of the message is not in the wake; the agent syncs to read it. `REPOS_RELAY_WEBHOOK_SECRET`, when set, is an HMAC-SHA256 in `X-Repos-Signature`. A failed webhook does not drop the message.

The server listens on loopback unless `REPOS_RELAY_TLS_CERT` and `REPOS_RELAY_TLS_KEY` are set. `REPOS_RELAY_INSECURE=1` is the explicit override for a trusted network. Claude Code does not get a push into an already open prompt: `repos relay watch` makes the mail local so the hook shows it on the next prompt, and `--claude-print` is the opt-in that starts `claude -p` on new mail. `--on-mail` runs one program, without a shell, for any other wake.

`repos-mcp` records a seen receipt when `repos_inbox` returns mail, records `acknowledgedBy` on `repos_ack`, and exposes `repos_relay_send` for one signed remote target.

## Trust and safety

- A message is a request, not authority. The receiving repository's instructions and human permissions still govern.
- Do not put credentials, private personal data, or production secrets in messages.
- External communication, deployment, purchases, destructive changes, and privileged operations require the same approval they would require without repos.chat.
- The receiver must not edit the sender's repository unless the host explicitly grants that scope.
- The Node host tears down the process tree it can observe, but it is not a kernel container. A deliberately daemonized POSIX process can escape a process group, so the current adapter fails closed for `branch-pr` execution there. `read-only` and `propose-change` remain available; strong cgroup isolation remains future host work.
- Responses should cite concrete file paths, commits, test output, or source URLs.
- Triggers and proposals never grant authority. Every recipe currently requires `approval: human-required`.
- Acknowledgement means the message was handled, not that its claims are true.
- The inspector binds only to `127.0.0.1`. It is not a public dashboard.
- The relay authenticates with a bearer token and an ed25519 signature, rejects a spoofed sender, and keeps every accepted envelope. A captured envelope can be replayed only as the same `clientMessageId`.

## Scope of one Repo Rep

Every repository starts with one general Repo Rep. Add specialist agents only after one rep becomes a measured bottleneck. The rep is responsible for:

- understanding the repository outcome
- maintaining verified capabilities
- accepting or rejecting incoming requests
- doing bounded work or asking a connected repository for help
- returning evidence, not just prose
- keeping the repository's continuity files current

## The perfect Repo Rep

The ideal is **proactive in responsibility and conservative in authority**. It behaves like an accountable maintainer for one repository:

1. **Know:** keep an accurate model of the repository's outcome, architecture, capabilities, constraints, and current risks.
2. **Watch:** stay available through a provable lease and notice bounded local signals such as new requests, failing tests, stale contracts, and capability drift.
3. **Choose:** distinguish work it can safely complete from work that needs clarification, permission, or a different repository.
4. **Work:** claim one task, preserve concurrent changes, make the smallest coherent change, and leave the repository healthier than it found it.
5. **Collaborate:** ask connected Repo Reps for explicit inputs or outcomes instead of reaching into their repositories or duplicating their responsibilities.
6. **Prove:** return concrete evidence, test results, remaining risks, and an honest outcome. Never report success from prose alone.
7. **Remember:** retain durable repository-specific lessons and update capability claims when the code changes.
8. **Guard:** stop and escalate when authority, evidence, or safety is missing. Responsibility never grants permission to publish, deploy, spend, communicate externally, or mutate another repository.

The current implementation proves identity, presence, bounded work, declared collaboration, structured evidence, and acknowledgement. Automatic health monitoring, contract-drift detection, preventative task proposals, and durable per-repository learning remain target behavior, not implemented claims.

## Implemented

- verified repository manifests and kin graph
- shared-canon drift checks
- durable local inboxes and conversation ids
- acknowledgements and reply threading
- machine-readable rep boot context
- bounded host adapters for Codex, Claude, and Grok with repository and message locks, one completion contract, and conversation history for follow-ups
- A2A-aligned response states and the answering model on every host response
- approved follow-up requests that continue a conversation
- `repos-mcp`, a stdio MCP server that gives live agent sessions the protocol under the same human gate
- Claude Code delivery hook with once-per-session injection and persistent `seen` receipts, a host name that is not hard-coded, and optional agent-addressed mail
- signed remote relay with agent keypairs, exactly-one target (`agent`, `session`, or `repo`), idempotent `clientMessageId`, webhook wake, and `repos relay sync` / `watch`
- seen receipts on MCP inbox reads, `acknowledgedBy` on ack, and `repos_relay_send`
- sender delivery view (`repos sent`), optional `expiresAt`, stale flags, and workspace triage (`repos focus`)
- proactive watcher with verifiable local presence
- structured completion responses with evidence, tests, and risks
- localhost graph, presence, and conversation inspector
- recipe verifier plus manual/webhook/CI/contract-drift proposal triggers
- explicit proposal approval before message delivery
- guarded GitHub App planning, app-authored commit, and draft-PR adapter
- local Git commits and stored GitHub PRs in the inspector
- private local conversation queue with exact-reply approval and durable Codex desktop relay attempts (see QUEUE.md; an active relay task is required)
- opt-in local Codex app-server bridge for explicitly bound sessions with exclusive native writer ownership, exact request receipts, result refresh, and structured next choices (see LOCAL_BRIDGE.md)

## Later, only if local use proves it

- inbox priorities, deadlines, and cancellation events
- policy capabilities describing which repositories may request which operations
- cost, latency, and outcome telemetry by Repo Rep

The protocol should stay useful with one repository and one human. Network effects are an upside, not a prerequisite.
