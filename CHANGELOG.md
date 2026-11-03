# Changelog

All notable changes to repos.chat are documented here.

## [0.6.0] - 2026-11-03

### Added

- Signed remote relay for two machines that do not share a disk. `repos relay serve` is a Node HTTPS server with a bearer token plus ed25519 envelopes, pluggable `file` (default), `memory`, and `sqlite` storage, and no new npm dependency. `repos identity` keeps the private key in the user profile or in environment variables. Targets are exactly one of `agent:<id>`, `session:<id>`, or `repo:<name>`. `clientMessageId` is idempotent in the relay and in the local mailbox. `repos relay sync` pushes the outbox and pulls the inbox. `repos relay watch` long-polls. A registered webhook receives a wake POST. `--claude-print` and `--on-mail` are opt-in local wakes.
- `repos-mcp` records a seen receipt on inbox reads, records who acknowledged on ack, and adds `repos_relay_send`.
- The session hook takes `--host` instead of a hard-coded Claude name, and `--agent` for agent-addressed mail.
- Deliver messages into live Claude Code sessions: `repos hook claude` installs a `UserPromptSubmit` and `SessionStart` hook that shows each new message once per session as untrusted relayed content, prints nothing when nothing is new, and can never block a prompt.
- Track delivery honestly: per-session `seen` receipts, kept apart from `ack`, and `repos sent` (plus the `repos_sent` MCP tool) showing queued, seen by host at time, or acked. `repos send` now reports a new message as queued, not seen.
- Bound and triage old mail: optional `expiresAt` via `--expires-in` or `--expires-at`, stale flags after 7 days in `repos inbox`, and `repos focus` counts of open, unseen, stale, and expired messages.
- Add repos-mcp to a Claude Code project with `repos mcp install`, privately in local scope by default.
- Run Repo Reps on Claude and Grok as well as Codex through one adapter table that shares the runner's containment, leases, and limits. A recipe can pin the answering model with `host`, bound into its digest; `--host` overrides it; `repos-agent hosts` lists installed hosts.
- Record an A2A-aligned `state` and the answering `host` on every host response, and show a follow-up turn up to eight earlier turns of its conversation labeled by model.
- Continue a conversation with an approved follow-up: `repos trigger --reply-to`, bound into the proposal digest and checked again before execution.
- Read one conversation across every mailbox with `repos conversation`.
- Serve the protocol to live agent sessions with `repos-mcp`, a dependency-free stdio MCP server with a launch-fixed identity and no approval tool.

### Changed

- A host that is not signed in now reports the exact login command and leaves the request open for any host to retry.

## [0.5.0] - 2026-08-28

### Added

- Assign a proactive Repo Rep to each verified repository and observe its live lease, bounded work, proposals, conversations, and evidence in a loopback-only inspector.
- Explore the repository graph through deterministic pixel-art Repo Pets, including focused multi-repository views and executable exchange recipes.
- Turn approved `branch-pr` exchanges into guarded, app-authored draft pull requests through the optional GitHub App adapter.
- Install the repos.chat and GitHub-star matchmaking skills for repeatable repository onboarding and evaluation.

### Changed

- Require every executable request and GitHub plan to repeat a content-bound human confirmation instead of trusting mutable local records or self-declared operator authority.
- Keep active mail in a bounded open queue while preserving the complete local mailbox as a durable audit trail.
- Make repository planning, review, testing, and release workflows reproducible through explicit local skill guidance.

### Fixed

- Prevent stale recipe permissions, escaped evidence paths, forged mailbox records, conflicting response IDs, lock races, and command-wrapper injection from crossing the agent boundary.
- Make GitHub branch, commit, and pull-request operations resumable and verify their remote contents against the reviewed local plan.
- Keep public website output separate from repository names, local paths, mailbox records, and workspace metadata.
- Serve cached inspector snapshots asynchronously and keep the repository map keyboard-accessible and readable.
