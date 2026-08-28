---
name: github-star-match
description: Evaluate a starred or external GitHub repository against a local codebase, then recommend adoption, selective borrowing, deferral, or rejection using license, duplication, evidence, and the smallest useful experiment. Use when learning from open-source repositories or matching them to local projects.
---

# GitHub star match

Determine whether an external GitHub repository solves a real problem in a named local repository. Popularity is not evidence of fit.

## Review

1. Read the local repository's `AGENTS.md`, `CLAUDE.md`, `repos.yaml`, product documentation, and relevant implementation files.
2. Inspect the external repository from its primary GitHub source. Record the exact commit reviewed, license, architecture, installation model, and the files that contain the potentially useful mechanism.
3. Compare the external mechanism against what the local repository already has. Name duplication, conflicting canon, runtime cost, maintenance cost, privacy risk, prompt authority, and supply-chain risk.
4. Choose exactly one verdict:
   - `adopt`: the repository should use the maintained package or tool.
   - `borrow selectively`: copy or recreate a small licensed mechanism without importing the whole system.
   - `defer`: the match is real, but a named trigger has not occurred.
   - `ignore`: no concrete local seam justifies the integration.
5. Name the smallest useful experiment and its definition of done. If the verdict is `defer`, name the observable trigger instead.

## Implementation boundary

Analysis does not authorize installation or code changes. Implement only when the user explicitly requests it. When implementation is authorized:

- Pin or record the reviewed upstream commit.
- Preserve required license notices and attribution.
- Do not copy code with an absent, unclear, or incompatible license.
- Prefer one reversible experiment over framework-wide adoption.
- Reuse local sources of truth instead of creating a second brand, product, policy, or architecture canon.
- Run tests that prove the claimed local benefit.

## repos.chat routing

An external GitHub repository is a reference, not a Repo Rep. Do not add it as a `kin` node unless it is intentionally cloned locally, assigned a verified Repo Rep, and connected for a concrete reason. To hand the finding to a local rep, send a bounded repos.chat request containing the source URL, reviewed commit, constraints, expected evidence, and definition of done.

## Output contract

Return:

- verdict and one-sentence reason
- local owner repository
- exact local evidence paths
- exact upstream URLs and reviewed commit
- license conclusion
- duplication and risks
- smallest experiment or deferred trigger
- validation required before adoption

Do not include credentials, private personal data, private messages, or unrelated workspace metadata.
