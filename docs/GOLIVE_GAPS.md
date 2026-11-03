# repos.chat relay: gaps before a live bubba ⇄ Maans bridge

Reviewed `main` at **a348e59** (PR #4, 2026-11-02 19:35 CST). That is later than 77e99cf (PR #2, the signed relay).
Line numbers refer to the unpatched files at a348e59. Baseline `npm test`: **97/97 passed**. With the patch: **99/99**.

Ranks:
- **MUST-HELLO**: fix or configure before the first hello round trip.
- **MUST-LIVE**: fix before relying on it as an always-on listener.
- **LATER**: everything else.

## Ranked gaps

1. **MUST-HELLO (config, no code). `--claude-print` cannot start an npm-installed Claude Code on Windows.**
   - Code: `relay-cli.mjs:287` spawns with `shell:false`. Line 330 uses the bare name `claude`, and line 334 passes `-p`.
   - On win32, a spawn without a shell resolves only `.exe` and `.com` files. An npm `claude.cmd` gives ENOENT, or EINVAL since Node's 2024 .cmd hardening.
   - Workaround (in the runbook):
     - Set `REPOS_CLAUDE_BIN` to the native `claude.exe`.
     - Or set `REPOS_CLAUDE_BIN=node.exe` and `REPOS_CLAUDE_BIN_ARGS='["…\\cli.js"]'`. Build the JSON with `ConvertTo-Json` so the backslashes are escaped; in PowerShell use single quotes.
   - The `--claude-print` flag itself has no quoting issue.
   - Also make sure `ANTHROPIC_API_KEY` is unset. Otherwise `claude -p` bills the API instead of the subscription (harvey lesson).

2. **MUST-HELLO (config). Every Grok bot on the shared Linux box would share one identity and one cursor.**
   - The default key file is `~/.repos-chat/identity.json` (`identity.mjs:25`). The cursor and inbox are keyed by workspace root (`relay-local.mjs:44-53`).
   - Every agent on that box gets the same `$HOME`. Two bots would sign as each other and steal each other's mail.
   - Workaround: give each bot its own `REPOS_IDENTITY_FILE` (honoured at `identity.mjs:129` and `relay-cli.mjs:97`) and its own `--root`.

3. **MUST-HELLO (verify). The Grok routine webhook may not accept the relay's wake POST.**
   - `relay.mjs:78-100` sends only `content-type` and `X-Repos-Signature: sha256=<HMAC>`.
   - A Grok routine webhook trigger comes with a sender key from the routine panel. If that key must be sent in a header, the relay cannot send it. That would need a code change to add a configurable header.
   - If the key can sit in the URL query, it works: `validateWebhookUrl` (`identity.mjs:286-296`) allows a query string.
   - Fallback that works today: a scheduled routine running `repos relay sync`.

4. **MUST-HELLO (doc). VERIFY.md assumes a different topology.**
   - It assumes a TLS relay on the Linux box bound to `0.0.0.0` (`VERIFY.md:9, 22-30`) and agent id `bubba` (`:54, :58`).
   - The planned topology is a relay on bubba at `127.0.0.1` behind a Cloudflare Tunnel, with agent id `bubba-claude`.
   - `notes/BUBBA_RUNBOOK.md` replaces those sections. Nothing in the code blocks this.

5. **MUST-HELLO (ordering). Registration is trust-on-first-use with no allowlist.**
   - `relay-store.mjs:83-101`: anyone holding the bearer token can claim an unclaimed agent id or repo.
   - Bubba cannot register `agent:maans` on Maans's behalf. Each agent must run `relay register` with its own key, right after the relay comes up.
   - Later improvement: an `agentId → publicKey` allowlist (for example `REPOS_RELAY_AGENTS`).

6. **MUST-LIVE, PATCHED. `relay watch` exits for good on the first transient error.**
   - `relay-cli.mjs:438-439` throws on any non-ok result, including `relay unreachable: fetch failed` (status 0), 5xx and 429.
   - A relay restart, a tunnel blip or a laptop sleep kills the live listener (the a2a-bridge "live listener" lesson).
   - Patch: retry with exponential backoff (1 s up to 30 s) on status 0, 408, 429 and 5xx. Auth and validation errors still exit.

7. **MUST-LIVE, PATCHED. `relay serve` hangs on Ctrl-C or SIGTERM while any watcher is connected.**
   - `relay-cli.mjs:390` and `relay.mjs:320` call only `server.close()`, which waits for keep-alive long-poll sockets that never go idle.
   - On bubba the local watcher is always connected, so the relay could never be stopped cleanly.
   - Patch: also call `server.closeAllConnections()`. With patch 6, the watchers retry.

8. **MUST before more than two agents. A clientMessageId shared by two senders silently drops mail.**
   - The relay dedups per sender: `${from}/${clientMessageId}` (`relay-store.mjs:157`).
   - The local inbox file is keyed only by `${kind}/${id}/${clientMessageId}` (`relay-local.mjs:52`).
   - When a second sender's `hello-1` arrives, `materialize` gets "already exists with different content" (`relay-cli.mjs:261`). The cursor still advances past it (`relay-cli.mjs:276-281`), so the next sync reports `ok:true` and the message is gone.
   - Reproduced locally.
   - Mitigation for now: prefix every id with the sender (`bubba-…`, `maans-…`), as VERIFY.md already does.
   - Fix: include the sender in the local key, or do not advance the cursor past a skip.

9. **LATER. A wake is fired once, inline, with no retry.**
   - `relay.mjs:139-160` awaits `postWake` (5 s timeout, `:89`) inside the sender's POST, and only on the first put.
   - If Maans's webhook is down, it is never woken for that message. Keep a periodic sync as a backstop.
   - The wake carries no timestamp, so it is replayable, but harmless: a replayed wake only causes an extra sync.

10. **LATER. No per-conversation rooms.**
    - `--claude-print` starts a fresh `claude -p` per wake (`relay-cli.mjs:317-338`), with no `--resume` or session per `conversationId`. The relay never looks at `conversationId`.
    - Other `claude -p` problems:
      - It runs in the watcher's working directory (`:287`, no `cwd`).
      - It is killed after 120 s (`:292`).
      - Its output only appears, truncated to 4000 characters, in the watch's stdout (`:290`).
      - Without `--allowedTools` it cannot run `relay send`. That keeps the human approval gate (good, the harvey lesson) but means it never replies on its own.

11. **LATER. The sqlite store is not append-only and its ids are unstable.**
    - Message ids are `m${seq}-${hex}` at write (`relay-store.mjs:167`) but are rebuilt as `m${seq}` on reload (`:344`). Sender and recipient see different relay ids. Cosmetic, because local dedup uses the client id.
    - Every write deletes and reinserts every row (`:355-377`), and every request reloads the whole database (`:380-395`). WAL is not enabled.
    - That is fine for tens of messages. It falls short of the unreal-agent "stable id plus append-only log" lesson.

12. **LATER. Signed pulls and watches are never checked for freshness.**
    - `signedAt` is signed but never compared to the clock (`identity.mjs:257` onward, and the verify functions at 185-284).
    - Someone holding the bearer token who also captured a signed pull could replay it to read an inbox. That is low risk behind TLS and a private token.

13. **LATER. Getting the token to a routine.**
    - The CLI reads only `--token` or the environment (`relay-cli.mjs:57-63`), and `--token` shows up in the process list.
    - Grok routine runs do not keep their environment between runs, so source a mode-0600 env file outside every workspace.

## What already works

I checked each of these in tests or by hand:
- **Signatures.** Ed25519-signed envelopes. A hand-edited envelope or a spoofed `from` is rejected and not stored (test at `test/relay.test.mjs:230`).
- **Idempotency.** Each `clientMessageId` is idempotent per sender, and retrying a send never duplicates. Exactly one target per message: agent, session or repo.
- **Stores.** File, memory and sqlite stores all dedup. `node:sqlite` loads on Node v24.22.1 with no flag and no warning.
- **Long-poll.** It is capped at 25 s (`relay.mjs:182-200`), well under Cloudflare's 100 s origin timeout.
- **Network safety.** The relay is loopback-only unless TLS is configured (`relay.mjs:243`), which suits `cloudflared` → `127.0.0.1:8787`. Health needs no auth; every other route needs the bearer token.
- **Wake.** The HMAC wake carries no message body.
- **Approval gate.** The relay carries only `notice` and `response` kinds. Work requests still go through `repos_propose` plus human approval. Incoming bodies are fenced as untrusted.
- **Key safety.** Keys are refused inside the clone or workspace, and `identity show` prints only the public key.
- **Windows paths.** Hook commands and relay mail paths have win32 tests (`test/relay.test.mjs:156`).
- **Delivery.** The end-to-end exchange with exactly one webhook, long-poll, session claim and MCP send/ack is all tested.

## Against the starred-repo lessons

| Lesson | Status |
| --- | --- |
| a2a-bridge: hub plus adapters | Yes. The relay is the hub; the CLI, MCP and hook are the adapters. There is no A2A protocol edge yet. |
| a2a-bridge: live listener | `watch` is there, but it died on errors. Fixed by the patch. |
| a2a-bridge: per-conversation rooms | No. See gap 10. |
| a2a-bridge: SQLite task state that survives restarts | Mail survives (now tested across a restart). There is no task state machine. |
| a2a-bridge: single bearer token | Yes, plus ed25519 signatures. |
| unreal-agent: stable unique ids for dedup | The client ids are stable. The relay ids are not under sqlite (gap 11), and the cross-sender collision is gap 8. |
| unreal-agent: append-only, forkable sessions | No. The store rewrites in place. |
| harvey: headless on the subscription, no API key | Yes, through `claude -p`, as long as `ANTHROPIC_API_KEY` is unset. |
| harvey: human approval gate | Yes. No work requests cross the relay, and headless claude cannot send without tool approval. |

## Patch

`notes/0001-relay-watch-retry-and-clean-shutdown.patch` is a `git diff` against a348e59. It applies cleanly (`git apply --check`) and is not committed.
- Code: the watch retry with backoff (gap 6) and closing all connections on stop (gap 7).
- Tests: two new tests in `test/relay.test.mjs`. One checks that a watch survives a relay restart and still delivers mail, using the sqlite store; it fails without the patch. The other checks that a watch still exits on an auth failure.
