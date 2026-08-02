# repos.yaml

**A manifest for the edges between repositories, with a verifier that stops it from lying.**

`AGENTS.md` and `CLAUDE.md` describe the inside of one repo. Nothing describes how repos relate. So an AI coding agent opened in `skill.supply` has no idea that `darktalent.tech` next door already solved half its problem, and rebuilds it.

`repos.yaml` is one small file per repo declaring what it is, what other repos can borrow from it, and who its kin are.

```yaml
repo: skill.supply
is: The supply side of talent: an AI career agent that packages a person and places them.
url: https://skill.supply
cluster: talent-stack

provides:
  - id: career-agent
    what: ikigai read, resume packaging, role matching
    at: lib/agent.ts

stack: [next, anthropic, zod]

kin:
  - repo: darktalent.tech
    why: darktalent scores talent from the demand side; skill.supply works the supply side

canon: ECOSYSTEM.md
```

## The part that matters: `at:`

Every claim points at code. The verifier checks the path exists.

This is not decoration. The first version of this protocol shipped a manifest claiming `pokedex.life` provided "working Stripe checkout." It had a hosted payment link and three unused type fields — no checkout route, no webhook. An agent following that claim would hunt for code that was never written.

**A manifest that sends an agent to nonexistent code is worse than no manifest.** Claims rot silently; `at:` makes them fail loudly.

A claim with no `at:` is reported as *unverifiable*, not as a pass.

## Usage

```
node repos.mjs verify --root ~/projects   # check every claim against real code
node repos.mjs sync   --root ~/projects   # detect drift in shared canon files
node repos.mjs graph  --root ~/projects   # emit the graph as JSON
```

No dependencies, no install, no server, no schema registry. One file, Node 18+.

```
✓ darktalent.tech
! optimism.fun
    WARN    kin ness.city: no manifest found in this workspace
✗ pokedex.life
    BROKEN  card-ui: claims components/specimen-card.tsx, which does not exist

10 claims confirmed by a real path, 0 unverifiable, 1 broken, 2 warnings
```

`verify` exits non-zero when a claim is broken, so it works in CI.

## `sync` and the drift problem

Teams that share a constitution across repos duplicate it by hand. Identical copies drift the first time one is edited, and nobody notices for months.

Point `canon:` at the shared file and `sync` hashes every copy:

```
✓ ECOSYSTEM.md  in sync across 3 repos  fa84ddf8
```

When they diverge it names the newest copy so you know which way to reconcile.

## Designed against the standards that died

| Standard | Why it failed | What this does instead |
|---|---|---|
| RDF | Emitting valid RDF needed expertise most authors never acquired | Flat YAML, no validator, writable from memory |
| Microformats | Welded machine data into human content, so ordinary edits broke it | Manifest is its own file; prose stays in README |
| Dublin Core | Only paid off once everyone adopted it | Useful at n=1: the first repo to adopt it benefits immediately |
| Backstage `catalog-info.yaml` | Models real relationships, but needs a portal and a server | A file in a repo, readable by anything |
| schema.org | **Lived.** Google paid you in rich results | Rides `AGENTS.md`, a habit 60,000+ repos already have |
| llms.txt | **Living.** One file, obvious name, no tooling | Same shape: one file at root |

The pattern: standards die from ceremony and deferred payoff. So this is fifteen lines, needs nothing installed, and helps the very first repo that adopts it.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `repo` | yes | Must match the folder or repo name |
| `is` | yes | One line. What this is, in a stranger's words |
| `kin` | yes | Related repos. **Each needs a `why`** — an edge without a reason teaches an agent nothing |
| `url` | no | Where it runs |
| `cluster` | no | Free-text grouping |
| `provides` | no | What others can borrow. Each entry: `id`, `what`, `at` |
| `stack` | no | Runtime and major dependencies |
| `canon` | no | Shared constitution file, checked by `sync` |

## Status

v0, in production across six repositories. Expect the field names to move before v1.

MIT.
