# repos.chat GitHub App boundary

The optional GitHub adapter turns an approved local Repo Rep proposal into an app-authored commit and a **draft** pull request. It never merges, deploys, approves reviews, messages people, or acts from a trigger alone.

## Minimal GitHub App registration

Register one GitHub App named `repos-chat` and install it only on repositories you deliberately select.

Repository permissions:

- Metadata: read (implicit and required by GitHub Apps)
- Contents: write (create the reviewed branch and commit)
- Pull requests: write (open and read draft pull requests)

Do not grant Administration, Actions, Deployments, Issues, Members, Secrets, or Webhooks write access. Subscribe only to the `push` and `pull_request` events if you later operate a webhook receiver. Every delivery must be HMAC-validated before it is allowed to call `repos trigger`; a webhook creates a proposal, never approved work.

Set credentials outside the repository:

```sh
REPOS_CHAT_GITHUB_APP_ID=...
REPOS_CHAT_GITHUB_INSTALLATION_ID=...
REPOS_CHAT_GITHUB_PRIVATE_KEY_FILE=/secure/path/repos-chat.pem
```

Check configuration without making a network call:

```sh
repos-github status
```

## Guarded pull-request flow

1. A manifest exchange declares `permission: branch-pr` and `approval: human-required`.
2. `repos trigger` records a proposal locally.
3. A human runs `repos approve` with the proposal ID plus payload-digest prefix printed by `repos trigger`. This sends only the reviewed bytes to the recipient Rep.
4. The recipient changes only its repository and runs its tests.
5. `repos-github plan` records the exact files, their hashes, test evidence, base branch, proposal, title, and body. It does not call GitHub.
6. A human reviews that plan and runs `repos-github open` with the plan ID plus digest prefix printed by the planner. The adapter rechecks the approval chain and every file hash, obtains a short-lived installation token, and checkpoints the branch, app-authored commit, and draft PR stages so retries are resumable.
7. A human reviews and merges on GitHub. The app has no merge command.

Example with fictional repositories:

```sh
repos trigger --root ~/projects --from research-service \
  --exchange refresh-metrics --event contract-drift \
  --subject "Refresh metric contract" --body "Return a compatible metric schema."

repos approve --root ~/projects --id PROPOSAL_ID --approve PROPOSAL_ID:DIGEST_PREFIX

repos-github plan --root ~/projects --repo metrics-service \
  --proposal PROPOSAL_ID --files src/schema.ts,test/schema.test.ts \
  --tests "npm test: 18 passed" --title "Refresh metric contract"

repos-github open --root ~/projects --id PLAN_ID --approve PLAN_ID:DIGEST_PREFIX
```

GitHub documents that installation access tokens attribute actions to the app. The adapter uses GitHub's commit API so the commit is authored by the app identity, then the ordinary contributor graph can count it after the commit reaches the default branch. A draft PR alone is not a default-branch contribution.

## What remains operator-owned

- creating and installing the GitHub App
- selecting repository access
- keeping the private key outside source control
- approving each proposal and PR plan
- reviewing and merging the draft PR
- deciding whether any deployment should follow
