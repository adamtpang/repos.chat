# repos.chat

**One AI agent per repository, connected by verified context and durable local mail.**

[repos.chat](https://repos.chat) gives a fleet of repositories a simple shared language:

1. `repos.yaml` says what each repository is, what it can provide, and why it is related to its neighbors.
2. The verifier checks that every capability claim points to real code.
3. A local mailbox lets repository agents request work and return evidence without sharing write access.
4. A bounded host adapter runs one request inside one recipient repository at a time.

The protocol does not pretend that a file is a running AI agent. Codex, Claude, CI, or another host starts the agent. repos.chat supplies verified context and a provider-neutral transport those hosts can share.

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

Check whether one repository has an assigned owner identity:

```sh
repos status --root ~/projects --repo metrics-service
repos status --root ~/projects --repo metrics-service --json
```

"Assigned" means the repository has a valid `repos.yaml` identity plus at least one local instruction file, `AGENTS.md` or `CLAUDE.md`. It does not claim that a model process is always running. A host starts the owner when work arrives.

## Let repository agents talk

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

Emit the complete boot context for one repository agent:

```sh
repos context --root ~/projects --repo metrics-service
```

Messages are JSON files under `<root>/.repo-connect/mail/<repo>/`. They stay local unless the operator deliberately adds a remote transport.

## Run one bounded repository agent, on any model

The host adapter locks one repository and one request, gives the model write access only to the recipient repository, requires structured evidence and test results, sends the result back through the mailbox, and acknowledges the request. Codex, Claude, and Grok are supported; each uses its own sign-in.

```sh
repos-agent hosts
repos-agent run --root ~/projects --repo metrics-service --dry-run
repos-agent run --root ~/projects --repo metrics-service --host grok
repos-agent run --root ~/projects --repo metrics-service --host claude --read-only
```

Without `--host`, the request's `wantHost` decides, then Codex. The reply records which model answered, so one thread can hold a Grok turn followed by a Claude turn, and each model sees the earlier turns. It explicitly forbids external communication, deployment, purchases, commits, pushes, and edits to other repositories. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for the host lifecycle and safety boundary.

## Talk from inside a live agent session

`repos-mcp` gives any MCP client the mailbox as tools, so an agent you are already working with can ask another repository's agent for help and read the reply.

```sh
claude mcp add repos -- node /path/to/repos.chat/mcp.mjs --root ~/projects --as metrics-service
codex mcp add repos -- node /path/to/repos.chat/mcp.mjs --root ~/projects --as metrics-service
grok mcp add repos node -- /path/to/repos.chat/mcp.mjs --root ~/projects --as metrics-service
```

The session then has `repos_whoami`, `repos_graph`, `repos_send`, `repos_inbox`, `repos_thread`, and `repos_ack`. The identity is fixed when the server starts, so a message from another agent cannot make yours send as someone else. [BRIDGES.md](BRIDGES.md) compares this with A2A, MCP Agent Mail, ACP, and the CLI-to-CLI bridges it learned from.

## Commands

```text
repos verify   confirm manifest claims against real paths
repos status   show whether one repository has an assigned owner identity
repos graph    emit repositories and kin edges as JSON
repos sync     detect drift in shared canon files
repos send     write a durable request, response, or notice
repos inbox    read open or acknowledged messages
repos ack      acknowledge without deleting history
repos thread   read one conversation across every mailbox
repos context  assemble one agent's verified boot context
repos-agent    run one request on codex, claude, or grok
repos-mcp      serve the mailbox to a live agent session over MCP
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

v0.3 implements manifest verification, owner status, canon drift checks, graph export, local mail with threads and A2A-aligned task states, machine-readable context, bounded host adapters for Codex, Claude, and Grok, an MCP server for live sessions, and installable repository-owner and GitHub-star-matching skills. Continuous scheduling remains deliberately separate.

MIT.
