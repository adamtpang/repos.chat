# Cross-model bridges

Researched 2026-11-01 so that Codex, Claude, and Grok Repo Reps can work together by learning from bridges that already connect coding agents. Network protocols (A2A, MCP's architecture, FIPA ACL, ANP, AGNTCY) are covered in [PROTOCOL_RESEARCH.md](PROTOCOL_RESEARCH.md); this document covers agent-to-agent bridges between coding CLIs.

## The landscape

| Bridge | Layer | What it connects |
| --- | --- | --- |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | coordination server | coding agents (Claude Code, Codex, Gemini CLI, Copilot) sharing one codebase |
| [Agent Client Protocol (ACP)](https://zed.dev/acp) | editor to agent | one editor driving any coding agent over stdio |
| [PAL / Zen MCP `clink`](https://glama.ai/mcp/servers/@BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/tools/clink.md) | CLI to CLI | one agent spawning another vendor's CLI as a subagent |
| Codex-as-MCP wrappers ([codex-mcp](https://github.com/panuhen/codex-mcp), [codex-as-mcp](https://images.glama.ai/mcp/servers/kky42/codex-as-mcp)) | single tool | Claude Code calling Codex as a tool |
| [Grok Build](https://mer.vin/2026/05/grok-build-cli-xai-terminal-coding-agent-with-plan-mode-subagents-and-headless-ci/) | agent CLI | xAI's coding agent, with headless, MCP, and ACP modes |

## What each one teaches

**MCP Agent Mail is the closest prior art.** It gives each coding agent an identity, threaded messages, acknowledgements, a Git-auditable archive, and advisory file reservations, all exposed as MCP tools. Two lessons carried over. First, put the protocol behind MCP tools, because every serious coding CLI is an MCP client; that is `repos-mcp`. Second, delivery is pull: Agent Mail has no push, and agents call `fetch_inbox`. repos.chat stays pull too. It differs on scope: Agent Mail names agents (GreenCastle) and lets several share one repository, so it needs file reservations; a Repo Rep is its repository and only writes inside it, so it does not. Agent Mail also lets agents message each other directly; repos.chat keeps work requests behind human approval.

**ACP is the session-level standard to adopt later.** ACP is one stdio JSON-RPC protocol for driving a live agent session with streaming updates and permission prompts. Gemini CLI speaks it natively (`--acp`), Grok Build's `grok agent stdio` and its `streaming-json` output are ACP session updates, and Claude Code and Codex speak it through adapters. If a Repo Rep ever needs to hold a long multi-turn session open instead of running bounded turns, adopt ACP rather than inventing a session protocol.

**`clink` and the Codex-as-MCP wrappers prove the cheapest bridge works:** run the other vendor's CLI headlessly and read its output. Their documented failure modes are the useful part. Their presets bypass each CLI's safety prompts, and calls hit client tool timeouts near 60 seconds. repos.chat keeps the spawning idea, refuses the bypass (read-only unless an approved `branch-pr` recipe says otherwise), and runs turns through the mailbox instead of inside the caller's tool call, so a slow model never stalls the calling agent.

## The common ground the CLIs already share

Checked against the installed CLIs on 2026-11-01, not their documentation:

| CLI | Headless one-shot | Structured final answer | MCP client | Live session protocol |
| --- | --- | --- | --- | --- |
| Codex 0.154 | `codex exec -` | `--output-schema FILE` | yes | app-server |
| Claude Code 2.1 | `claude -p` | `--json-schema`, `--output-format json` | yes | stream-json; ACP via adapter |
| Grok Build 1.0.5 | `grok --prompt-file` | `--json-schema`, `--output-format json` | yes | `grok agent stdio` (ACP) |
| Gemini CLI 0.55 | `gemini -p` | none | yes | `--acp` |

Three of the four constrain their final answer to a JSON schema, which is why one completion contract (`outcome`, `summary`, `evidence`, `tests`, `risks`) serves all of them. Gemini's free individual tier now refuses this client, so it has no adapter.

## Verification status

- Codex: a real `codex exec` call with the completion schema returned a valid answer in 26 seconds on 2026-11-01.
- Claude and Grok: the adapters pass tests against fake CLIs that mirror their documented output shapes. A real run still needs `claude /login` and `grok login` on the host machine, and the exact JSON wrapper each emits should be confirmed on that first run.
- Two machines: `repos relay` is covered by tests that start a local relay, exchange a signed message and a reply between two identities, reject a spoofed sender, dedupe a retry, and fire one webhook wake. A real Claude session on Windows and a Grok Bot routine on Linux have not been run; the steps are in [VERIFY.md](VERIFY.md).

## What the relay copies, and what it refuses

Addressing is one `agent:<id>`, `session:<id>`, or `repo:<name>` target, the shape used by [a2a-bridge](https://github.com/firstintent/a2a-bridge) (MIT). The idea is copied. The package is not a dependency. Wake is a webhook the relay POSTs, which is how a Grok Bot routine can be started, plus an opt-in local watcher for Claude Code. Work requests still stop at human approval. The relay transports notices and responses only.

## Deliberately not taken

- **Auto-approve presets** (`clink`, codex-as-mcp). A message is a request, never authority.
- **Direct agent-to-agent work requests** (Agent Mail). Work goes through proposal and human approval. The relay does not carry a raw request.
- **A required coordination daemon** (Agent Mail's server). Files are still the whole protocol on one machine. The relay is only for machines that do not share a disk.
- **Push into an open Claude prompt.** The hook still runs on the next user prompt. `repos relay watch --claude-print` is opt-in and starts a separate `claude -p` turn.
