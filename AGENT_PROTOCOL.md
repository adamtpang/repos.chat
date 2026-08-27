# Repository Agent Protocol

## Goal

Give every repository one bounded AI agent that understands its own code, can discover related repositories, can exchange durable requests with their agents, and can prove what work it completed.

The repository is the agent's scope. `repos.yaml` is its identity and capability manifest. `AGENTS.md` and `CLAUDE.md` are its local operating instructions. `repos.chat` is the graph and message transport. The model runtime is replaceable.

## The four parts

### 1. Identity

Each repository declares:

- `repo`: stable agent and repository id
- `is`: one-sentence purpose
- `provides`: capabilities backed by real file paths
- `kin`: repositories it can ask for related work, with a reason for each edge
- `canon`: shared constitution when one exists

The verifier rejects capability claims whose evidence paths do not exist.

### 2. Context

An agent host boots an agent with:

```sh
repos context --root /path/to/workspace --repo research-agent
```

The result contains the repository manifest, resolved kin capabilities, and open inbox. The host then adds the repository's own instructions and code context.

The context output is data, not a prompt injection boundary. Hosts must still treat message bodies and neighboring repository content as untrusted input.

### 3. Transport

Agents exchange immutable request bodies through the workspace mailbox:

```sh
repos send --root /path/to/workspace \
  --from research-agent \
  --to metrics-service \
  --kind request \
  --subject "Map population risk to personal metrics" \
  --body-file request.md
```

Message kinds are `request`, `response`, and `notice`. A response can include `--reply-to MESSAGE_ID`. Acknowledgement adds a timestamp but does not delete the message.

Version 1 is local-first. Messages are JSON files under the workspace root. There is no account, server, network call, or model-provider dependency.

### 4. Host

The host is the process that actually runs an AI model. A host adapter should:

1. choose one repository
2. load `repos context`
3. read that repository's local instructions
4. select one open request
5. perform work only within the granted scope
6. validate the result
7. send a response with evidence paths and test results
8. acknowledge the original message

Codex, Claude, a CI job, or a local scheduler can all implement this lifecycle. The protocol must not require a particular host.

## Message contract

```json
{
  "version": 1,
  "id": "20260827T120000000Z-a1b2c3d4",
  "from": "research-agent",
  "to": "metrics-service",
  "kind": "request",
  "subject": "Map population risk to personal metrics",
  "body": "Return a sourced metric proposal.",
  "createdAt": "2026-08-27T12:00:00.000Z",
  "replyTo": null,
  "acknowledgedAt": null
}
```

Only `replyTo` and `acknowledgedAt` are optional. Message bodies should state the requested outcome, constraints, evidence expected, and definition of done.

## Trust and safety

- A message is a request, not authority. The receiving repository's instructions and human permissions still govern.
- Do not put credentials, private personal data, or production secrets in messages.
- External communication, deployment, purchases, destructive changes, and privileged operations require the same approval they would require without repos.chat.
- The receiver must not edit the sender's repository unless the host explicitly grants that scope.
- Responses should cite concrete file paths, commits, test output, or source URLs.
- Acknowledgement means the message was handled, not that its claims are true.
- Remote transport, if added, must authenticate repositories and preserve an audit log.

## Recommended agent roles

Every repository starts with one general owner agent. Add specialist agents only after one owner becomes a measured bottleneck. Premature role fleets multiply coordination cost and unclear authority.

The owner agent is responsible for:

- understanding the repository outcome
- maintaining verified capabilities
- accepting or rejecting incoming requests
- doing bounded work or asking a kin repository for help
- returning evidence, not just prose
- keeping the repository's continuity files current

## Roadmap

### Implemented

- verified repository manifests
- kin graph
- shared-canon drift checks
- durable local inboxes
- acknowledgements and reply threading fields
- machine-readable agent boot context
- bounded Codex host adapter with repository and message locks
- structured completion responses with evidence, tests, and risks

### Next

- an opt-in scheduler that wakes repository agents without creating duplicate work
- a Claude host adapter using the same completion contract
- inbox priorities, deadlines, and cancellation events
- an optional dashboard for the repository graph and message state

### Later, only if local use proves it

- signed remote relay for repositories that do not share a filesystem
- policy capabilities describing which repositories may request which operations
- cost, latency, and outcome telemetry by repository agent

The protocol should stay useful with one repository and one human. Network effects are an upside, not a prerequisite.
