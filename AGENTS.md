<!-- BEGIN:imported-claude-context -->
# repos.chat project context

repos.chat provides verified repository manifests, a kin graph, canon synchronization, durable local mail, acknowledgements, machine-readable agent context, and a bounded Codex host adapter.

The public website is served exclusively from `public/`. Product source, tests, manifests, and local continuity data must never be part of the website output.
<!-- END:imported-claude-context -->
<!-- BEGIN:claude-chat-continuation -->
Claude chat continuation: read `CODEX_CONTINUE_FROM_CLAUDE.md` to resume from the latest local Claude Code sessions for this project.
<!-- END:claude-chat-continuation -->
<!-- BEGIN:imported-codex-context -->
# repos.chat project context

repos.chat provides verified repository manifests, a kin graph, canon synchronization, durable local mail, acknowledgements, machine-readable agent context, and a bounded Codex host adapter.

The public website is served exclusively from `public/`. Product source, tests, manifests, and local continuity data must never be part of the website output.
<!-- END:imported-codex-context -->
<!-- BEGIN:codex-chat-continuation -->
Codex chat continuation: read `CLAUDE_CONTINUE_FROM_CODEX.md` to resume from the latest local Codex sessions for this project.
<!-- END:codex-chat-continuation -->
# repos.chat agent guidance

- Read `CLAUDE.md` and `AGENT_PROTOCOL.md` before changing protocol behavior.
- The repository owns the `repos.yaml` graph, durable local mailbox, and bounded agent host.
- Capability claims must point to real files and pass `npm test` plus `repos verify`.
- Keep the protocol local-first and provider-neutral.
- Keep public examples fictional. Never expose a user's repository names, local paths, messages, or workspace metadata.
- Do not advertise features that are not implemented.
