<!-- BEGIN:imported-claude-context -->
# CLAUDE.md - repos.chat (formerly repo-connect)

Created by Codex on 2026-08-02 during Claude/Codex continuity sync.

Read `CODEX_CONTINUE_FROM_CLAUDE.md` for the latest imported Claude Code sessions before continuing work here.
<!-- END:imported-claude-context -->
<!-- BEGIN:claude-chat-continuation -->
Claude chat continuation: read `CODEX_CONTINUE_FROM_CLAUDE.md` to resume from the latest local Claude Code sessions for this project.
<!-- END:claude-chat-continuation -->
# repos.chat Guidance for Codex

Read `CLAUDE.md` first, then `CODEX_CONTINUE_FROM_CLAUDE.md` for the newest Claude chat continuity.

## Product contract

- The repository owns the `repos.yaml` graph, the durable local mailbox, and the bounded agent host.
- Capability claims must point to real files and pass `npm test` plus `repos verify`.
- Keep the protocol local-first and provider-neutral.
- Do not advertise features that are not implemented.
