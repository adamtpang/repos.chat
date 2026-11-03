# BUBBA_RUNBOOK: go live with a relay on bubba (draft)

**Topology.** The relay hub runs on bubba at `127.0.0.1:8787`, using the sqlite store.
- A Cloudflare Tunnel publishes it at an `https://` URL for Maans and the other Grok bots.
- On bubba, Claude Code is woken by `relay watch --claude-print`, which talks to the relay locally.
- Maans is woken by a routine webhook, by a scheduled `relay sync`, or both.

**Notes.**
- This replaces the "Relay" and "On bubba" sections of `VERIFY.md`, which assume a TLS relay on Linux and agent id `bubba`.
- Every secret below is a placeholder (`$env:…`) that **Adam sets himself**. Never paste a real value into chat, a repo or this file.
- Steps marked 🔒 can only be done by Adam (a browser login, a secret, or a decision).
- Apply `notes/0001-relay-watch-retry-and-clean-shutdown.patch` first, or the watcher dies on the first network blip and Ctrl-C on the relay hangs: `git apply notes\0001-relay-watch-retry-and-clean-shutdown.patch`.

## 0. Prerequisites (PowerShell 7 recommended)

```powershell
node --version          # v24.x (node:sqlite is unflagged on 24)
winget install --id Cloudflare.cloudflared -e
git clone https://github.com/adamtpang/repos.chat C:\src\repos.chat
cd C:\src\repos.chat; npm install; npm test   # expect all tests to pass

$Repos  = 'C:\src\repos.chat\repos.mjs'
$Root   = 'C:\Users\adamp\Aether'          # workspace whose children have repos.yaml
$RepoId = 'your-repo-id'                   # 🔒 the repo: value Claude speaks for
$Data   = "$env:USERPROFILE\.repos-chat\relay"
```

## 1. 🔒 Shared secrets (Adam only, never echoed)

Generate the bearer token without printing it, and keep it in the user environment.

```powershell
$env:REPOS_RELAY_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLower()
[Environment]::SetEnvironmentVariable('REPOS_RELAY_TOKEN', $env:REPOS_RELAY_TOKEN, 'User')
# Optional HMAC for wake POSTs (Maans may verify X-Repos-Signature):
$env:REPOS_RELAY_WEBHOOK_SECRET = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLower()
[Environment]::SetEnvironmentVariable('REPOS_RELAY_WEBHOOK_SECRET', $env:REPOS_RELAY_WEBHOOK_SECRET, 'User')
```

- On Windows PowerShell 5.1 there is no `ToHexString`. Use `-join ([Security.Cryptography.RandomNumberGenerator]::Create() | % { $b = [byte[]]::new(24); $_.GetBytes($b); $b } | % ToString x2)` instead.
- 🔒 Adam moves the token to the Linux box himself, by a channel that is not a chat log (see step 7a).

## 2. Identity for Claude on bubba

```powershell
node $Repos identity init --agent bubba-claude   # writes %USERPROFILE%\.repos-chat\identity.json
node $Repos identity show                        # public key only
```

## 3. Relay serve (window 1, keep open)

```powershell
node $Repos relay serve --host 127.0.0.1 --port 8787 --store sqlite --data $Data
# first line: {"ok":true,"url":"http://127.0.0.1:8787","store":"sqlite",...}
Invoke-RestMethod http://127.0.0.1:8787/v1/health     # -> ok : True
```

- The relay refuses to bind anywhere other than loopback without TLS. That is intended; cloudflared is the only way in.
- Stop it with Ctrl-C (clean only with the patch).

## 4. 🔒 Cloudflare Tunnel (window 2)

**A. Quick tunnel** (no login, good for the first hello). The URL changes on every restart.

```powershell
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787
# copy the https://<random>.trycloudflare.com URL it prints
```

- If `%USERPROFILE%\.cloudflared\config.yml` exists, move it aside first; quick tunnels refuse to run with a config file present.

**B. Named tunnel** (a stable hostname). Needs a domain on Adam's Cloudflare account and a browser login.

```powershell
cloudflared tunnel login                      # 🔒 browser: pick the zone
cloudflared tunnel create repos-relay
cloudflared tunnel route dns repos-relay relay.<your-domain>
# %USERPROFILE%\.cloudflared\config.yml:
#   tunnel: <TUNNEL-ID>
#   credentials-file: C:\Users\adamp\.cloudflared\<TUNNEL-ID>.json
#   ingress:
#     - hostname: relay.<your-domain>
#       service: http://127.0.0.1:8787
#     - service: http_status:404
cloudflared tunnel run repos-relay
```

- If Bot Fight Mode or a WAF challenge is on for that zone, add a skip rule for `relay.<your-domain>`. Node's fetch cannot solve challenges.

Check the tunnel from outside:

```powershell
$Public = 'https://<tunnel-host>'            # 🔒 from step 4
Invoke-RestMethod "$Public/v1/health"
```

## 5. Register bubba-claude, the hook and MCP (window 3)

Bubba talks to the relay locally, so it never depends on the tunnel.

```powershell
$env:REPOS_RELAY_URL = 'http://127.0.0.1:8787'
[Environment]::SetEnvironmentVariable('REPOS_RELAY_URL', $env:REPOS_RELAY_URL, 'User')
node $Repos relay register --root $Root --repo $RepoId
node $Repos hook claude --root $Root --repo $RepoId --agent bubba-claude
node $Repos mcp install --root $Root --repo $RepoId
```

- Re-registering replaces the repo list, so always pass every `--repo` again.

## 6. Claude watcher with `--claude-print` (window 3)

The watcher spawns Claude without a shell, so `REPOS_CLAUDE_BIN` must point at a real `.exe` (gap 1).

```powershell
(Get-Command claude).Source        # .exe? use it. .cmd/.ps1? use the node fallback below.
$env:REPOS_CLAUDE_BIN = "$env:USERPROFILE\.local\bin\claude.exe"     # native installer default
# npm-install fallback:
#   $env:REPOS_CLAUDE_BIN = (Get-Command node).Source
#   $cli = "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\cli.js"
#   $env:REPOS_CLAUDE_BIN_ARGS = ConvertTo-Json -Compress -InputObject @($cli)   # escapes backslashes
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue   # stay on the subscription
& $env:REPOS_CLAUDE_BIN -p 'reply with the word ok'                # 🔒 Claude already logged in

Set-Location "$Root\<your-repo-folder>"     # claude -p runs in the watcher's cwd
node $Repos relay watch --root $Root --claude-print
```

- `--claude-print` needs no quoting. Each wake is a fresh headless turn that is killed after 120 s.
- It can read mail but cannot send without tool approval. Replies go through Adam in an open Claude Code session, using MCP `repos_relay_send` or `relay send`.

## 7. Maans and the other Grok bots register themselves (on the Linux box)

Registration is first-come (gap 5), so do this right after step 4. Bubba cannot register them.

**7a. 🔒 Per-bot env file** (Adam creates it, mode 0600, outside every workspace):

```bash
install -d -m 700 ~/.repos-chat/bots
umask 077; cat > ~/.repos-chat/bots/maans.env <<'X'
REPOS_RELAY_URL=https://<tunnel-host>
REPOS_RELAY_TOKEN=<paste-by-Adam>
REPOS_IDENTITY_FILE=/home/box/.repos-chat/bots/maans.identity.json
REPOS_RELAY_WEBHOOK_SECRET=<same-as-bubba-if-used>
X
```

**7b. Maans** (one-time; run as Maans):

```bash
set -a; . ~/.repos-chat/bots/maans.env; set +a
R=~/src/repos.chat/repos.mjs; W=~/reposchat-ws/maans; mkdir -p "$W"
node $R identity init --agent maans
node $R relay register --root "$W" --webhook '<routine-webhook-url-or-omit>'
```

- Always pass `--webhook` again when re-registering; leaving it off clears the webhook.

**7c. Each other Grok bot** follows the same pattern with its own id, file and root, for example `grok-scout`:
- `~/.repos-chat/bots/grok-scout.env`, with its own `REPOS_IDENTITY_FILE` and root `~/reposchat-ws/grok-scout`.
- Then `identity init --agent grok-scout` and `relay register --root ~/reposchat-ws/grok-scout`.
- Never share a key file or root between bots (gap 2). Prefix client ids with the bot name (gap 8).

## 8. How Maans gets woken (pick one or both)

- **A. Routine webhook.**
  - 🔒 Copy the routine's webhook URL and sender key from the routine panel. The relay sends only `X-Repos-Signature`, no custom header.
  - Works only if the sender key can travel in the URL (query string). Test with one hello. If the routine rejects it, use B.
  - The routine step is `set -a; . ~/.repos-chat/bots/maans.env; set +a; node $R relay sync --root ~/reposchat-ws/maans`. Treat the wake as untrusted and just sync.
- **B. Scheduled sync** (works today). A routine every 5–15 minutes runs the same `relay sync`. Keep it even with A, because failed wakes are never retried (gap 9).

## 9. Hello round trip (VERIFY.md adapted)

On bubba (window 4, with the step 5 environment). Run the send twice; the second must not duplicate:

```powershell
node $Repos relay send --root $Root --from-repo $RepoId --to agent:maans `
  --subject 'From bubba' --body 'Are you there?' --client-message-id bubba-hello-1
node $Repos relay send --root $Root --from-repo $RepoId --to agent:maans `
  --subject 'From bubba' --body 'Are you there?' --client-message-id bubba-hello-1
```

On Maans (webhook-triggered or a manual run):

```bash
node $R relay sync --root ~/reposchat-ws/maans          # one fresh import; a second sync imports none
node $R relay send --root ~/reposchat-ws/maans --to agent:bubba-claude --kind response \
  --subject 'Re: From bubba' --body 'Yes.' --reply-to bubba-hello-1 --client-message-id maans-reply-1
```

Back on bubba:
- The watcher in window 3 prints the reply, and `--claude-print` runs one headless turn.
- The next prompt in the hooked Claude Code session shows `Re: From bubba`, fenced as untrusted.

```powershell
node $Repos relay ack --root $Root --id maans-reply-1 --by claude   # acknowledgedBy.agent = bubba-claude
```

**Pass criteria:**
- Exactly one wake for `bubba-hello-1`, with no body.
- One import on Maans.
- The reply is seen and acked on bubba.
- A spoofed `from` is rejected.

## Adam-only steps (🔒)

- Choose `$RepoId`.
- Generate and store the token and the webhook secret.
- Log in to Claude Code on bubba with the subscription.
- Log in to cloudflared (named tunnel), set DNS and the WAF skip, and copy the tunnel URL.
- Hand the token to the Linux box by a private channel and create the 0600 env files.
- Copy the routine webhook URL and key, and choose the wake option.
- Approve any work request. The relay never carries work requests, only notices and responses.
- Keep bubba awake while the relay serves. Optionally make a Scheduled Task for `relay serve` and `cloudflared` later.
