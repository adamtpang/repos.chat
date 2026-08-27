# CLAUDE.md - repos.chat (formerly repo-connect)

Created by Codex on 2026-08-02 during Claude/Codex continuity sync.

Read `CODEX_CONTINUE_FROM_CLAUDE.md` for the latest imported Claude Code sessions before continuing work here.

## Current state (2026-08-27)

- The public project and GitHub repository are now named `repos.chat`.
- `repos.mjs` implements verified manifests, the kin graph, canon sync, durable mail, acknowledgements, and agent context.
- `agent-host.mjs` is the bounded Codex adapter for one repository request at a time.
- `AGENT_PROTOCOL.md` defines the provider-neutral lifecycle and safety boundary.
- The static landing page deploys to https://repos.chat through Vercel.
