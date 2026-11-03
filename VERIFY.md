# Verify two machines

This is the manual check for a real Claude Code session on Adam's Windows PC and a Grok Bot routine on a Linux box. Automated tests already start a local relay and exchange a signed message, a reply, and one webhook wake. They do not log into Claude or Grok, and they do not deploy anything.

Do this only after you have decided where the relay lives. Until `REPOS_RELAY_URL` answers, both sides have nowhere to send mail.

## Decisions before the first command

1. Host the relay as a long-running `repos relay serve` on a machine you control (the Linux box is enough). A serverless disk forgets the default file store when the instance is replaced. Do not attach the relay to the public repos.chat website.
2. Generate one `REPOS_RELAY_TOKEN` (at least 16 characters) and put it in the environment on the relay and on both agents. Do not commit it.
3. Pick agent ids, for example `maans` and `bubba`.
4. If the relay port is reachable beyond localhost, set `REPOS_RELAY_TLS_CERT` and `REPOS_RELAY_TLS_KEY`. Otherwise leave it on `127.0.0.1` and tunnel, or set `REPOS_RELAY_INSECURE=1` only on a network you trust.
5. Put the Grok Bot routine's public webhook URL in `repos relay register --webhook` for `maans`. The relay POSTs `repos.chat/wake/1` there. The message body is not in that POST. Optional: set `REPOS_RELAY_WEBHOOK_SECRET` and check `X-Repos-Signature`.
6. `--claude-print` starts a headless `claude -p` turn and spends a Claude session. Leave it off if you only want the next prompt in an already open Claude Code window to show the mail.

Keys never go in `C:\Users\adamp\Aether` or in the repos.chat clone. `repos identity init` refuses a path inside the workspace. The default file is `%USERPROFILE%\.repos-chat\identity.json` on Windows and `~/.repos-chat/identity.json` on Linux. You can use `REPOS_AGENT_ID` and `REPOS_AGENT_PRIVATE_KEY` instead of a file.

Below, `C:\src\repos.chat` means a clone of this repository. `C:\Users\adamp\Aether` means the workspace whose child folders contain `repos.yaml`.

## Relay

On the Linux host, from a clone, with the token only in the environment:

```bash
export REPOS_RELAY_TOKEN='replace-with-a-long-random-token'
export REPOS_RELAY_DATA_DIR="$HOME/.repos-chat/relay"
export REPOS_RELAY_TLS_CERT=/path/to/fullchain.pem
export REPOS_RELAY_TLS_KEY=/path/to/privkey.pem
node repos.mjs relay serve --host 0.0.0.0 --port 8787
```

The first stdout line is JSON with `url`. Health check from either machine: `GET /v1/health` returns `{"ok":true}` and no mail.

Environment the process reads:

| Variable | Required | Purpose |
| --- | --- | --- |
| `REPOS_RELAY_TOKEN` | yes | Bearer token for every route except health |
| `REPOS_RELAY_DATA_DIR` | no | File or sqlite directory. Default `~/.repos-chat/relay` |
| `REPOS_RELAY_STORE` | no | `file` (default), `memory`, or `sqlite` |
| `REPOS_RELAY_HOST` | no | Default `127.0.0.1` |
| `REPOS_RELAY_PORT` | no | Default `8787` |
| `REPOS_RELAY_TLS_CERT` | off-loopback | PEM certificate |
| `REPOS_RELAY_TLS_KEY` | off-loopback | PEM private key |
| `REPOS_RELAY_INSECURE` | no | `1` to bind off-loopback without TLS |
| `REPOS_RELAY_WEBHOOK_SECRET` | no | HMAC key for wake POSTs |

## On bubba (PowerShell)

```powershell
$Root = 'C:\Users\adamp\Aether'
$Repos = 'C:\src\repos.chat\repos.mjs'
$RepoId = 'your-repo-id'   # the repo: value in that repository's repos.yaml
$env:REPOS_RELAY_URL = 'https://relay.example:8787'
$env:REPOS_RELAY_TOKEN = 'replace-with-a-long-random-token'

node $Repos identity init --agent bubba
node $Repos identity show
node $Repos relay register --root $Root --repo $RepoId
node $Repos hook claude --root $Root --repo $RepoId --agent bubba
node $Repos mcp install --root $Root --repo $RepoId
```

`identity show` prints the public key only. In the Claude Code session inside that repository, send one notice:

```powershell
node $Repos relay send --root $Root --from-repo $RepoId --to agent:maans `
  --subject 'From bubba' --body 'Are you there?' --client-message-id bubba-hello-1
node $Repos relay send --root $Root --from-repo $RepoId --to agent:maans `
  --subject 'From bubba' --body 'Are you there?' --client-message-id bubba-hello-1
```

The second command must not create a second message. Leave a Claude Code session open in the Aether repo, or start the opt-in watcher in another window:

```powershell
node $Repos relay watch --root $Root --claude-print
```

`--claude-print` is optional. Without it, the next prompt in the hooked session shows mail addressed to the repo or to `agent:bubba` after `repos relay sync` or `watch` has pulled it.

## On Maans (bash)

The Grok Bot routine should run when its webhook fires. The routine's own steps:

```bash
export REPOS_RELAY_URL='https://relay.example:8787'
export REPOS_RELAY_TOKEN='replace-with-a-long-random-token'
node /path/to/repos.chat/repos.mjs identity init --agent maans
node /path/to/repos.chat/repos.mjs relay register --root /path/to/workspace --webhook 'https://maans.example/wake'
node /path/to/repos.chat/repos.mjs relay sync --root /path/to/workspace
node /path/to/repos.chat/repos.mjs relay send --root /path/to/workspace \
  --to agent:bubba --kind response --subject 'Re: From bubba' --body 'Yes.' \
  --reply-to bubba-hello-1 --client-message-id maans-reply-1
```

If the identity was created by a previous run, skip `identity init`. It refuses to overwrite a key.

## What you should see

- Maans's webhook is called once for `bubba-hello-1`, with `from` `agent:bubba`, `to` `agent:maans`, and no message body.
- `repos relay sync` on Maans prints one fresh import. A second sync prints none.
- Bubba's inbox or the Claude hook shows `Re: From bubba` after sync or watch. The body is fenced as untrusted.
- `repos relay ack --id maans-reply-1 --by claude` on bubba records `acknowledgedBy.agent` as `bubba`.
- A hand-edited envelope, or one signed by Maans's key but labeled `from: bubba`, is rejected and is not stored.

Stop the relay with Ctrl-C when you are done. It is not a public service until you put it behind TLS and the token on purpose.
