# Bridges: what already exists, and what repos.chat takes from it

Researched 2026-11-01 so that repos.chat learns from working agent-to-agent bridges instead of reinventing them. Each entry says what the project is, the idea worth borrowing, and where repos.chat deliberately differs.

## The landscape in one line each

| Bridge | Layer | What it connects |
| --- | --- | --- |
| [A2A (Agent2Agent)](https://a2a-protocol.org/latest/specification/) | network protocol | independent agent services over HTTP, under the Linux Foundation, v1.0 |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | coordination server | coding agents (Claude Code, Codex, Gemini CLI, Copilot) sharing one codebase |
| [Agent Client Protocol (ACP)](https://zed.dev/acp) | editor to agent | one editor driving any coding agent over stdio |
| [PAL / Zen MCP `clink`](https://glama.ai/mcp/servers/@BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/tools/clink.md) | CLI-to-CLI | one agent spawning another vendor's CLI as a subagent |
| Codex-as-MCP wrappers ([codex-mcp](https://github.com/panuhen/codex-mcp), [codex-as-mcp](https://images.glama.ai/mcp/servers/kky42/codex-as-mcp)) | single tool | Claude Code calling Codex as a tool |
| [Grok Build](https://mer.vin/2026/05/grok-build-cli-xai-terminal-coding-agent-with-plan-mode-subagents-and-headless-ci/) | agent CLI | xAI's coding agent, with headless, MCP, and ACP modes |

## What each one teaches

**A2A: the task lifecycle and the conversation id.** A2A separates a message from a task, groups related turns under a `contextId`, and gives every task an explicit state: submitted, working, input-required, auth-required, completed, failed, canceled, rejected. That vocabulary is the most widely adopted one for agent work, so repos.chat messages now carry a `threadId` (the `contextId` equivalent) and a `state` drawn from the same list. A bridge from repos.chat to A2A becomes a field rename, not a translation. What repos.chat does not take: HTTP endpoints, Agent Cards served from URLs, and push-notification webhooks. A local workspace has no network to cross, and `repos.yaml` already plays the Agent Card's role, with the added property that its capability claims are verified against real paths.

**MCP Agent Mail: identity, threads, and pull-based inboxes for coding agents.** This is the closest prior art. It gives each agent a durable identity, threaded messages, acknowledgements, a Git-auditable archive, and advisory file reservations, exposed to every agent through MCP. Two lessons carried over. First, expose the mailbox as MCP tools, because every serious coding CLI speaks MCP; that is now `repos-mcp`. Second, notifications are pull: Agent Mail has no push, agents call `fetch_inbox`. repos.chat stays pull too. Where it differs: Agent Mail names agents (GreenCastle) and lets several share one repository; repos.chat makes the repository itself the agent's identity and scope, which removes the need for file reservations between peers, because each agent only writes inside its own repository. Agent Mail also needs a running server and SQLite; repos.chat stays plain JSON files with no daemon.

**ACP: the session-level standard, for later.** ACP is to editors what LSP was to language servers: one stdio JSON-RPC protocol for driving a live agent session with streaming updates and permission prompts. Gemini CLI speaks it natively (`--acp`), Grok Build's `grok agent stdio` and its `streaming-json` output are ACP session updates, and Claude Code and Codex speak it through adapters. If repos.chat ever needs to hold a long multi-turn session open rather than run bounded turns, ACP is the protocol to adopt, not a custom one.

**PAL `clink` and the Codex-as-MCP wrappers: one CLI spawning another.** These prove the cheapest cross-model bridge works: run the other vendor's CLI headlessly and read its output. Their documented failure modes are the useful part. The shipped presets bypass each CLI's safety prompts, and calls hit client tool timeouts around 60 seconds. repos.chat keeps the spawning idea but refuses the bypass (hosts run with workspace-write or read-only sandboxes, never "approve everything") and runs turns outside the calling agent's tool timeout, through the mailbox, so a slow model never stalls the caller.

## The common ground every CLI already shares

Checked against the installed CLIs on 2026-11-01, not documentation:

| CLI | Headless one-shot | Structured final answer | MCP client | Live session protocol |
| --- | --- | --- | --- | --- |
| Codex 0.154 | `codex exec -` | `--output-schema FILE` | yes | app-server (used by LOCAL_BRIDGE.md) |
| Claude Code 2.1 | `claude -p` | `--json-schema`, `--output-format json` | yes | stream-json, ACP via adapter |
| Grok Build 1.0.5 | `grok --prompt-file` | `--json-schema`, `--output-format json` | yes | `grok agent stdio` (ACP) |
| Gemini CLI 0.55 | `gemini -p` | none | yes | `--acp` |

Three of the four constrain their final answer to a JSON schema, which is why one completion contract (`outcome`, `summary`, `evidence`, `tests`, `risks`) works across all of them with no per-model parsing beyond where the JSON lands. Gemini's free individual tier now refuses this client, so it is not an adapter yet.

## What repos.chat now is, in this landscape

The repository is the agent. `repos.yaml` is its verified identity. The mailbox is the transport: durable, local, pull-based, threaded, with A2A task states. Any model can answer any message: `repos-agent run --host codex|claude|grok`, or the sender's `wantHost`. Any live session can join the conversation through `repos-mcp`. Nothing else in the list combines verified capability claims, provider-neutral hosts, and zero infrastructure.

## Deliberately not taken

- **Auto-approve presets** (PAL `clink`, codex-as-mcp). A message is a request, never authority.
- **A coordination daemon** (Agent Mail's server, A2A's HTTP endpoints). Files are enough at one-workspace scale.
- **Agent names independent of repositories** (Agent Mail). Scope by repository keeps write access unambiguous.
- **Push delivery.** No prior art does it locally without a resident process; a scheduler that wakes hosts stays an opt-in roadmap item.
