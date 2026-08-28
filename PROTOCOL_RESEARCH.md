# Prior art for repository-to-repository agents

Research checked on 2026-08-28. This document records what repos.chat borrows and what it deliberately leaves out.

## Current protocols and systems

### Agent2Agent Protocol

The [A2A specification](https://a2a-protocol.org/latest/specification/) defines agent cards for discovery, messages and parts for communication, stateful tasks, artifacts, extensions, streaming, push notifications, and authenticated HTTP transports. The official [A2A Inspector](https://github.com/a2aproject/a2a-inspector) makes cards, live exchanges, validation, and raw JSON-RPC visible.

Borrow now:

- separate identity and capability discovery from message transport
- make protocol envelopes inspectable
- treat remote agent data as untrusted
- keep a path to authenticated remote transport

Defer:

- HTTP discovery and public agent cards
- streaming and push notifications
- a full remote task state machine

### Model Context Protocol

The [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture) uses a host-client-server boundary for prompts, resources, and tools. The host controls permissions and context isolation. MCP is complementary: it connects an agent to tools and context, while repos.chat connects repository representatives to each other.

Borrow now:

- provider-neutral JSON contracts
- explicit host control over permissions and context
- repository isolation by default

### FIPA ACL

The historical [FIPA ACL message structure](https://www.fipa.org/specs/fipa00061/XC00061E.html) requires a communicative act and defines sender, receiver, content, protocol, conversation id, reply ids, and deadlines.

Borrow now:

- `kind` as the small performative set
- `from`, `to`, `conversationId`, and `replyTo`
- an explicit response when work is blocked or declined

Avoid now:

- a large speech-act vocabulary that local developer workflows do not need

### Agent Communication Protocol

[IBM's ACP project](https://research.ibm.com/projects/agent-communication-protocol) explored HTTP-native discovery, asynchronous runs, and streaming, then merged into A2A. This supports treating A2A as the main interoperability target instead of implementing two remote protocols.

### Agent Network Protocol and AGNTCY

[ANP](https://agentnetworkprotocol.com/en/specs/) explores decentralized identity, encrypted messaging, discovery, and meta-protocol negotiation. [AGNTCY](https://docs.agntcy.org/) provides a broader stack for agent discovery, identity, messaging, observability, and capability schemas.

Borrow later if remote use is proven:

- authenticated repository identities
- signed capability cards
- encrypted cross-machine transport
- protocol-level observability

Do not import this infrastructure into the local MVP.

## Multi-agent frameworks

[AutoGen teams](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/teams.html) coordinate multiple agents through team patterns and often shared conversation context. [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/) transfer a run to a specialist. [GitHub custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents) provide repository-level agent profiles and delegation.

These systems coordinate agents inside a runtime. repos.chat instead supplies durable communication between independently scoped repositories and does not require shared model context.

## Naming check

Candidate words included agent, steward, maintainer, custodian, keeper, guardian, operator, delegate, representative, envoy, liaison, captain, caretaker, and daemon.

“Steward” describes the responsibility well, but it is already used by products such as [Repo Steward](https://github.com/AlexsJones/repo-steward) and [ElfTech Steward](https://elftech.ai/steward/). “Maintainer” and “owner” imply human or organizational authority. “Daemon” describes a process, not a representative.

**Repo Rep** is the chosen role name. It is short, specific to repos.chat, and accurately describes bounded representation. The public sentence is: **Every repo gets a rep.**

## Resulting design

repos.chat is a local-first Repository Representation Protocol with five distinct concerns:

1. identity and verified capabilities in `repos.yaml`
2. a live watcher lease for proactive presence
3. durable message envelopes with conversation threading
4. exclusive claims for bounded execution
5. evidence-bearing replies and an inspectable audit trail

The localhost inspector borrows the visibility of A2A Inspector, but it reads local artifacts and exposes no public network listener.
