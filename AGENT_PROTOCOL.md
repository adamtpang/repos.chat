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

`repos-agent run` implements it for three model hosts through one adapter table in `hosts.mjs`:

| Host | Invocation | Read-only turn |
| --- | --- | --- |
| `codex` | `codex exec --output-schema` | `--sandbox read-only` |
| `claude` | `claude -p --json-schema --output-format json` | `--permission-mode plan` |
| `grok` | `grok --prompt-file --json-schema --output-format json` | `--permission-mode plan` |

The host is the operator's `--host`, else the request's `wantHost`, else `codex`. Each CLI keeps its own sign-in; no API key passes through repos.chat. A host failure, including a missing sign-in, leaves the request open and unclaimed so any host can retry it. When a request continues a thread, the host shows the receiving model up to eight earlier turns, labeled with which model wrote each one, as untrusted input. `repos-agent hosts` lists installed hosts without starting a model.

### 5. Live sessions

`repos-mcp --root WORKSPACE --as REPO` is a stdio MCP server that gives an agent already running in Claude Code, Codex, Grok, or any MCP client the mailbox as tools: `repos_whoami`, `repos_graph`, `repos_send`, `repos_inbox`, `repos_thread`, and `repos_ack`. The identity is fixed at launch, so a message body cannot make the agent send as another repository, and undeclared tool arguments are refused. Registering it is a one-time step per client, for example `claude mcp add repos -- node /path/to/repos.chat/mcp.mjs --root WORKSPACE --as REPO`.

## Message contract

```json
{
  "version": 2,
  "id": "20260827T120000000Z-a1b2c3d4",
  "threadId": "20260827T120000000Z-a1b2c3d4",
  "from": "research-agent",
  "to": "metrics-service",
  "kind": "request",
  "state": "submitted",
  "subject": "Map population risk to personal metrics",
  "body": "Return a sourced metric proposal.",
  "createdAt": "2026-08-27T12:00:00.000Z",
  "wantHost": "grok"
}
```

A response adds `replyTo` and `host`, for example `"host": { "name": "claude", "model": "opus" }`, naming the model that actually answered. `acknowledgedAt` is added on acknowledgement.

- `threadId` groups one conversation. A new message starts its own thread; a reply joins its parent's. It is the equivalent of A2A's `contextId`. `repos thread --id ID` reads a whole thread across every mailbox.
- `state` uses the A2A task-state vocabulary: `submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`, `rejected`. Requests default to `submitted`. Host responses map the completion outcome: `completed` to `completed`, `blocked` to `input-required`, `declined` to `rejected`. Notices carry no state.
- `wantHost` is the sender's preferred model (`codex`, `claude`, or `grok`). It is a preference, not authority; the operator's `--host` overrides it.

Version 1 messages remain valid. Readers derive a missing `threadId` from the `replyTo` chain. Message bodies should state the requested outcome, constraints, evidence expected, and definition of done. See [BRIDGES.md](BRIDGES.md) for how this maps onto A2A, MCP Agent Mail, and ACP.

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
- bounded host adapters for Codex, Claude, and Grok with repository and message locks, one completion contract, read-only turns, and thread history
- threads and A2A-aligned task states on every message
- `repos-mcp`, a stdio MCP server that gives any live agent session the mailbox as tools
- structured completion responses with evidence, tests, and risks

### Next

- an opt-in scheduler that wakes repository agents without creating duplicate work
- inbox priorities, deadlines, and cancellation events
- an optional dashboard for the repository graph and message state

### Later, only if local use proves it

- signed remote relay for repositories that do not share a filesystem
- policy capabilities describing which repositories may request which operations
- cost, latency, and outcome telemetry by repository agent

The protocol should stay useful with one repository and one human. Network effects are an upside, not a prerequisite.
