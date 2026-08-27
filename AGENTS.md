# repos.chat agent guidance

- Read `CLAUDE.md` and `AGENT_PROTOCOL.md` before changing protocol behavior.
- The repository owns the `repos.yaml` graph, durable local mailbox, and bounded agent host.
- Capability claims must point to real files and pass `npm test` plus `repos verify`.
- Keep the protocol local-first and provider-neutral.
- Keep public examples fictional. Never expose a user's repository names, local paths, messages, or workspace metadata.
- Do not advertise features that are not implemented.
