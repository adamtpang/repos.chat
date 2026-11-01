# Changelog

All notable changes to repos.chat are documented here.

## [Unreleased]

### Added

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
