# repos.chat

**Every repo gets a rep.**

A **Repo Rep** is a bounded AI representative for one repository. It has a verified identity, a durable inbox, an observable presence lease, and permission to work only inside the repository it represents.

[repos.chat](https://repos.chat) gives a fleet of repositories a simple shared language:

1. `repos.yaml` says what each repository is, what it can provide, and why it is related to its neighbors.
2. The verifier checks that every capability claim points to real code.
3. A local mailbox lets Repo Reps request work and return evidence without sharing write access.
4. A proactive watcher proves when a rep is awake and runs one request at a time.
5. A localhost inspector shows the graph, presence, and exact protocol envelopes.

The protocol does not pretend that a file is a running AI agent. “Assigned” comes from the manifest and instructions. “Idle,” “working,” and “blocked” require a fresh watcher lease and a live local process. Codex, Claude, CI, or another host can supply the model runtime.

Read [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for the exact lifecycle and [PROTOCOL_RESEARCH.md](PROTOCOL_RESEARCH.md) for the comparison with A2A, MCP, FIPA ACL, ACP, ANP, AGNTCY, and current multi-agent frameworks.

## Install

```sh
npm install -g https://github.com/adamtpang/repos.chat/tarball/main
```

Requires Node 18 or newer. No account, server, database, or runtime dependency is required.

Install the agent skills into every detected coding agent:

```sh
npx skills add adamtpang/repos.chat -g --all
```

The skill installer requires Git on `PATH`.

This installs `$repos-chat` for repository assignment and communication, plus `$github-star-match` for evidence-based learning from external GitHub repositories.

## Give each repository an identity

Add a `repos.yaml` file to each repository:

```yaml
repo: product-app
is: A product agent that plans releases and routes implementation work.
cluster: product-platform

provides:
  - id: release-planner
    what: release planning and task routing
    at: src/agent.ts

stack: [next, typescript]

kin:
  - repo: metrics-service
    why: product releases use its verified outcome metrics
```

Then verify the workspace:

```sh
repos verify --root ~/projects
```

Every `provides.at` claim must resolve to a real path. Broken claims make verification exit nonzero, so the check works in CI.

Check whether one repository has an assigned Repo Rep and whether it is awake:

```sh
repos status --root ~/projects --repo metrics-service
repos status --root ~/projects --repo metrics-service --json
```

"Assigned" means the repository has a valid `repos.yaml` identity plus at least one local instruction file, `AGENTS.md` or `CLAUDE.md`. "Proactive" means a watcher has a fresh lease and a live PID.

## Let Repo Reps talk

Send a request:

```sh
repos send --root ~/projects \
  --from research-agent \
  --to metrics-service \
  --subject "Compare release outcome metrics" \
  --body "Return the smallest metric set supported by the evidence."
```

Read a repository's inbox:

```sh
repos inbox --root ~/projects --repo metrics-service
repos inbox --root ~/projects --repo metrics-service --json
```

Emit the complete boot context for one Repo Rep:

```sh
repos context --root ~/projects --repo metrics-service
```

Messages are JSON files under `<root>/.repo-connect/mail/<repo>/`. They stay local unless the operator deliberately adds a remote transport.

## Run or wake one bounded Repo Rep

The included Codex host adapter locks one repository and one request, gives Codex write access only to the recipient repository, requires structured evidence and test results, sends the result back through the mailbox, and acknowledges the request.

```sh
node agent-host.mjs run --root ~/projects --repo metrics-service --dry-run
node agent-host.mjs run --root ~/projects --repo metrics-service
```

Keep the rep proactive so requests are handled without manually invoking `run`:

```sh
repos-agent watch --root ~/projects --repo metrics-service
```

The watcher refreshes `.repo-connect/presence/<repo>.json`, polls the inbox, and preserves one-worker and one-message locks. Use `--once` for a scheduled or CI check.

## Watch the protocol

Start the read-only local inspector:

```sh
repos-dashboard --root ~/projects
```

Open `http://127.0.0.1:4777`. It shows Repo Rep states, declared repository edges, conversation threads, acknowledgement status, and raw envelopes. It binds only to loopback and is separate from the public landing page.

It explicitly forbids external communication, deployment, purchases, commits, pushes, and edits to other repositories. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for the host lifecycle and safety boundary.

## Commands

```text
repos verify   confirm manifest claims against real paths
repos status   show one Repo Rep's assignment and live presence
repos graph    emit repositories and kin edges as JSON
repos sync     detect drift in shared canon files
repos send     write a durable request, response, or notice
repos inbox    read open or acknowledged messages
repos ack      acknowledge without deleting history
repos context  assemble one agent's verified boot context
repos-agent watch  keep one Repo Rep awake and handling requests
repos-dashboard    inspect the local graph, presence, and conversations
```

Use `--depth N` when manifests sit more than one directory below the workspace root.

## Why the evidence path matters

A manifest that sends an agent to nonexistent code is worse than no manifest. Capability claims rot silently; `at:` makes them fail loudly.

```text
✓ product-app
! metrics-service
    WARN    kin data-pipeline: no manifest found in this workspace
✗ catalog-ui
    BROKEN  card-ui: claims components/item-card.tsx, which does not exist

10 claims confirmed by a real path, 0 unverifiable, 1 broken, 2 warnings
```

## Principles

- Local first. The graph and mail live beside the repositories.
- Evidence first. Agents return paths, tests, commits, or sources.
- Provider neutral. The protocol does not depend on one model host.
- Repository scoped. A receiver works inside its own codebase.
- Useful at one. The first manifest already improves agent context.

## Status

v0.4 implements the Repository Representation Protocol: manifest verification, Repo Rep status, live watcher leases, conversation ids, canon drift checks, graph export, local mail, machine-readable context, a bounded Codex host adapter, a localhost inspector, and installable Repo Rep and GitHub-star-matching skills.

MIT.
