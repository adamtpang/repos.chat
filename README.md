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

## Give each repository an identity

Add a `repos.yaml` file to each repository:

```yaml
repo: skill.supply
is: An AI career agent that packages a person and places them.
url: https://skill.supply
cluster: talent-stack

provides:
  - id: career-agent
    what: resume packaging and role matching
    at: lib/agent.ts

stack: [next, typescript]

kin:
  - repo: darktalent.tech
    why: darktalent scores talent from the demand side; skill.supply works the supply side
```

Then verify the workspace:

```sh
repos verify --root ~/projects
```

Every `provides.at` claim must resolve to a real path. Broken claims make verification exit nonzero, so the check works in CI.

## Let repository agents talk

Send a request:

```sh
repos send --root ~/projects \
  --from optimism.fun \
  --to vitals.run \
  --subject "Check hypertension metrics" \
  --body "Return the smallest personal vital set supported by the evidence."
```

Read a repository's inbox:

```sh
repos inbox --root ~/projects --repo vitals.run
repos inbox --root ~/projects --repo vitals.run --json
```

Emit the complete boot context for one repository agent:

```sh
repos context --root ~/projects --repo vitals.run
```

Messages are JSON files under `<root>/.repo-connect/mail/<repo>/`. They stay local unless the operator deliberately adds a remote transport.

## Run one bounded repository agent

The included Codex host adapter locks one repository and one request, gives Codex write access only to the recipient repository, requires structured evidence and test results, sends the result back through the mailbox, and acknowledges the request.

```sh
node agent-host.mjs run --root ~/projects --repo vitals.run --dry-run
node agent-host.mjs run --root ~/projects --repo vitals.run
```

It explicitly forbids external communication, deployment, purchases, commits, pushes, and edits to other repositories. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md) for the host lifecycle and safety boundary.

## Commands

```text
repos verify   confirm manifest claims against real paths
repos graph    emit repositories and kin edges as JSON
repos sync     detect drift in shared canon files
repos send     write a durable request, response, or notice
repos inbox    read open or acknowledged messages
repos ack      acknowledge without deleting history
repos context  assemble one agent's verified boot context
```

Use `--depth N` when manifests sit more than one directory below the workspace root.

## Why the evidence path matters

A manifest that sends an agent to nonexistent code is worse than no manifest. Capability claims rot silently; `at:` makes them fail loudly.

```text
✓ darktalent.tech
! optimism.fun
    WARN    kin ness.city: no manifest found in this workspace
✗ pokedex.life
    BROKEN  card-ui: claims components/specimen-card.tsx, which does not exist

10 claims confirmed by a real path, 0 unverifiable, 1 broken, 2 warnings
```

## Principles

- Local first. The graph and mail live beside the repositories.
- Evidence first. Agents return paths, tests, commits, or sources.
- Provider neutral. The protocol does not depend on one model host.
- Repository scoped. A receiver works inside its own codebase.
- Useful at one. The first manifest already improves agent context.

## Status

v0.2 implements manifest verification, canon drift checks, graph export, local mail, machine-readable context, and a bounded Codex host adapter. Continuous scheduling remains deliberately separate.

MIT.
