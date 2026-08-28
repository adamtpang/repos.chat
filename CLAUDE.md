# repos.chat project context

repos.chat provides verified repository manifests, executable exchange recipes, a kin graph, human-approved proposals, canon synchronization, durable local mail, acknowledgements, machine-readable agent context, a bounded Codex host adapter, and a guarded GitHub App adapter.

The public website is served exclusively from `public/`. Product source, tests, manifests, and local continuity data must never be part of the website output.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
