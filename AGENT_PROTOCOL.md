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
| blocked | The last attempt could not safely complete | Structured blocked or declined outcome in presence and claim records |

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

Version 3 remains local-first. Messages are JSON files under the workspace root. Approved recipe requests carry proposal, exchange, permission, and recipe-digest metadata; the host revalidates that chain against the current manifest before invoking a model. There is no required account, server, network call, or model-provider dependency.

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

## Trust and safety

- A message is a request, not authority. The receiving repository's instructions and human permissions still govern.
- Do not put credentials, private personal data, or production secrets in messages.
- External communication, deployment, purchases, destructive changes, and privileged operations require the same approval they would require without repos.chat.
- The receiver must not edit the sender's repository unless the host explicitly grants that scope.
- Responses should cite concrete file paths, commits, test output, or source URLs.
- Triggers and proposals never grant authority. Every recipe currently requires `approval: human-required`.
- Acknowledgement means the message was handled, not that its claims are true.
- The inspector binds only to `127.0.0.1`. It is not a public dashboard.
- Remote transport, if added, must authenticate repositories and preserve an audit log.

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
- bounded Codex host adapter with repository and message locks
- proactive watcher with verifiable local presence
- structured completion responses with evidence, tests, and risks
- localhost graph, presence, and conversation inspector
- recipe verifier plus manual/webhook/CI/contract-drift proposal triggers
- explicit proposal approval before message delivery
- guarded GitHub App planning, app-authored commit, and draft-PR adapter
- local Git commits and stored GitHub PRs in the inspector

## Later, only if local use proves it

- a Claude host adapter using the same completion contract
- inbox priorities, deadlines, and cancellation events
- signed remote relay for repositories that do not share a filesystem
- policy capabilities describing which repositories may request which operations
- cost, latency, and outcome telemetry by Repo Rep

The protocol should stay useful with one repository and one human. Network effects are an upside, not a prerequisite.
