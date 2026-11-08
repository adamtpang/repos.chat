#!/usr/bin/env node
// repos.mjs: verify and sync the repos.yaml protocol.
// No dependencies. Node 18+.
//
//   node repos.mjs verify [--root DIR]   check every manifest's claims against real code
//   node repos.mjs sync   [--root DIR]   detect drift in shared canon files across kin
//   node repos.mjs graph  [--root DIR]   emit the repo graph as JSON
//   node repos.mjs status [options]      show one repo rep's assignment and presence
//   node repos.mjs send   [options]      send a durable local message between repos
//   node repos.mjs inbox  [options]      read one repo's open messages
//   node repos.mjs ack    [options]      acknowledge a message without deleting it
//   node repos.mjs context [options]     emit the verified context an agent host needs
//   node repos.mjs trigger [options]     turn an allowed signal into a reviewable proposal
//   node repos.mjs proposals [options]   list pending or historical proposals
//   node repos.mjs approve [options]     explicitly approve and deliver one proposal
//   node repos.mjs conversation [options] read one conversation across every mailbox
//   node repos.mjs sent   [options]      show what one repo sent and whether it was seen or acked
//   node repos.mjs focus  [options]      count open, unseen, stale, and expired messages
//   node repos.mjs hook claude [options] deliver new messages into live Claude Code sessions
//   node repos.mjs mcp install [options] add repos-mcp to a Claude Code project
//
// Why this exists: a manifest that points an agent at code which does not exist is
// worse than no manifest at all. Claims rot silently. This makes them fail loudly.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { STALE_DAYS, deliveryStatus, freshness, parseDuration, readSeen, recordSeen } from './receipts.mjs';
import { formatHookCommand } from './relay-local.mjs';
import { runIdentity, runRelay } from './relay-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const cmd = args[0] || 'verify';
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx > -1 ? args[rootIdx + 1] : process.cwd();
const depthIdx = args.indexOf('--depth');
// Default 1 matches the tool's original behavior exactly: only immediate
// subdirectories of --root are scanned. Raise it to see a hub manifest
// (e.g. workspace-root/repos.yaml) and nested project manifests in one run.
const DEPTH = depthIdx > -1 ? parseInt(args[depthIdx + 1], 10) : 1;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.vercel']);
const GIT_BIN = process.env.GIT_BIN || (process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'].find(fs.existsSync) || 'git.exe'
  : 'git');

const option = name => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : null;
};
const hasFlag = name => args.includes(`--${name}`);

const C = process.stdout.isTTY
  ? { r:'\x1b[31m', g:'\x1b[32m', y:'\x1b[33m', d:'\x1b[2m', b:'\x1b[1m', x:'\x1b[0m' }
  : { r:'', g:'', y:'', d:'', b:'', x:'' };

/* ---------- a deliberately small YAML reader ------------------------------
   Only the shapes repos.yaml uses: scalars, `- ` lists, and one level of
   nested maps inside a list item. A full YAML parser is a dependency, and a
   dependency is how a format starts dying. */
function parseManifest(text) {
  const out = {};
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  let key = null;
  for (const line of lines) {
    const indent = line.match(/^ */)[0].length;
    const t = line.trim();

    if (indent === 0) {
      const m = t.match(/^([\w.-]+):\s*(.*)$/);
      if (!m) continue;
      key = m[1];
      out[key] = m[2] === '' ? [] : scalar(m[2]);
      continue;
    }
    if (!key) continue;
    if (!Array.isArray(out[key])) out[key] = [];

    if (t.startsWith('- ')) {
      const body = t.slice(2);
      const kv = body.match(/^([\w.-]+):\s*(.*)$/);
      out[key].push(kv ? { [kv[1]]: scalar(kv[2]) } : body);
    } else {
      const kv = t.match(/^([\w.-]+):\s*(.*)$/);
      const last = out[key][out[key].length - 1];
      if (kv && last && typeof last === 'object') last[kv[1]] = scalar(kv[2]);
    }
  }
  return out;
}
const scalar = v => {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']'))
    return v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
  return v;
};

/* ---------- discovery ---------------------------------------------------- */
// Walks `remaining` levels below `dir` looking for repos.yaml in each
// subdirectory. remaining=1 (the default) is the tool's original behavior:
// only immediate children of --root. remaining>1 descends further, so a
// hub-level manifest (workspace-root/repos.yaml) and nested project manifests can
// be verified together -- previously a documented, unfixed gap.
function walk(dir, remaining, found) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const sub = path.join(dir, e.name);
    const p = path.join(sub, 'repos.yaml');
    if (fs.existsSync(p)) {
      try { found.push({ dir: sub, name: e.name, m: parseManifest(fs.readFileSync(p, 'utf8')) }); }
      catch (err) { found.push({ dir: sub, name: e.name, err: err.message }); }
    }
    if (remaining > 1) walk(sub, remaining - 1, found);
  }
}
function findManifests(root, depth = 1) {
  const found = [];
  // The root itself can carry a manifest (a hub repos.yaml describing the
  // workspace, e.g. workspace-root/repos.yaml) -- previously never checked, only
  // its subdirectories were.
  const hubPath = path.join(root, 'repos.yaml');
  if (fs.existsSync(hubPath)) {
    const name = path.basename(path.resolve(root));
    try { found.push({ dir: root, name, isRoot: true, m: parseManifest(fs.readFileSync(hubPath, 'utf8')) }); }
    catch (err) { found.push({ dir: root, name, isRoot: true, err: err.message }); }
  }
  walk(root, depth, found);
  return found;
}

/* ---------- verify ------------------------------------------------------- */
// A claim is CONFIRMED only when its `at:` path exists on disk. A claim with no
// `at:` is UNVERIFIED, which is a warning, not a pass: unfalsifiable claims are
// how the protocol rots.
function verify(repos) {
  const names = new Set(repos.map(r => r.name));
  let confirmed = 0, unverified = 0, broken = 0, badKin = 0;

  for (const r of repos) {
    const problems = [], notes = [];
    if (r.err) { console.log(`${C.r}✗${C.x} ${r.name}  unparseable: ${r.err}`); broken++; continue; }
    const m = r.m;

    for (const f of ['repo', 'is', 'kin']) if (!m[f]) problems.push(`missing required field: ${f}`);
    if (m.repo && m.repo !== r.name && !r.isRoot) problems.push(`repo field "${m.repo}" != folder "${r.name}"`);

    for (const p of (m.provides || [])) {
      const id = typeof p === 'object' ? (p.id || Object.keys(p)[0]) : String(p).split(':')[0];
      const at = typeof p === 'object' ? p.at : null;
      if (!at) { notes.push(`${id}: no evidence path (add "at:")`); unverified++; continue; }
      const evidence = containedEvidence(r.dir, at);
      if (evidence.ok) { confirmed++; }
      else { problems.push(`${id}: claims ${at}, which ${evidence.error}`); broken++; }
    }

    const seenKin = new Set();
    for (const k of (m.kin || [])) {
      const kr = typeof k === 'object' ? k.repo : String(k);
      const why = typeof k === 'object' ? k.why : null;
      if (!why) { notes.push(`kin ${kr}: no "why" (an edge without a reason teaches an agent nothing)`); }
      if (!names.has(kr)) notes.push(`kin ${kr}: no manifest found in this workspace`);
      if (seenKin.has(kr)) notes.push(`kin ${kr}: listed more than once`);
      seenKin.add(kr);
    }

    const seenExchange = new Set();
    for (const exchange of (m.exchanges || [])) {
      if (!exchange || typeof exchange !== 'object') {
        problems.push('exchange must be a map');
        broken++;
        continue;
      }
      const label = exchange.id || '(missing id)';
      for (const field of ['id', 'with', 'trigger', 'asks', 'returns', 'permission', 'approval', 'at']) {
        if (!exchange[field]) { problems.push(`exchange ${label}: missing ${field}`); broken++; }
      }
      if (exchange.id && !safeExchangeId(exchange.id)) {
        problems.push(`exchange ${label}: id contains unsupported characters`); broken++;
      }
      if (seenExchange.has(exchange.id)) {
        problems.push(`exchange ${label}: id is listed more than once`); broken++;
      }
      seenExchange.add(exchange.id);
      if (exchange.with && !seenKin.has(exchange.with)) {
        problems.push(`exchange ${label}: with ${exchange.with} is not declared in kin`); broken++;
      }
      if (exchange.trigger && !TRIGGERS.has(exchange.trigger)) {
        problems.push(`exchange ${label}: trigger must be one of ${[...TRIGGERS].join(', ')}`); broken++;
      }
      if (exchange.permission && !PERMISSIONS.has(exchange.permission)) {
        problems.push(`exchange ${label}: permission must be one of ${[...PERMISSIONS].join(', ')}`); broken++;
      }
      if (exchange.approval && exchange.approval !== 'human-required') {
        problems.push(`exchange ${label}: approval must be human-required`); broken++;
      }
      if (exchange.at) {
        const evidence = containedEvidence(r.dir, exchange.at);
        if (!evidence.ok) {
          problems.push(`exchange ${label}: evidence ${exchange.at} ${evidence.error}`); broken++;
        }
      }
    }

    const icon = problems.length ? `${C.r}✗${C.x}` : notes.length ? `${C.y}!${C.x}` : `${C.g}✓${C.x}`;
    console.log(`${icon} ${C.b}${r.name}${C.x}`);
    problems.forEach(p => console.log(`    ${C.r}BROKEN${C.x}  ${p}`));
    notes.forEach(n => console.log(`    ${C.y}WARN${C.x}    ${n}`));
    badKin += notes.length;
  }
  console.log(`\n${C.b}${confirmed}${C.x} claims confirmed by a real path, ${C.y}${unverified}${C.x} unverifiable, ${C.r}${broken}${C.x} broken, ${badKin} warnings`);
  return broken ? 1 : 0;
}

/* ---------- sync --------------------------------------------------------- */
// ECOSYSTEM.md is duplicated by hand across kin repos. Identical copies drift the
// first time one is edited, and nobody notices. This catches it.
function sync(repos) {
  // Keyed by cluster + filename, not filename alone: two unrelated clusters can
  // each declare a same-named canon (e.g. two different ECOSYSTEM.md constitutions)
  // without being flagged as drift against each other.
  const byCanon = {};
  for (const r of repos) {
    const canon = (r.m?.canon || '').split(' ')[0];
    if (!canon || !canon.endsWith('.md')) continue;
    const p = path.join(r.dir, canon);
    if (!fs.existsSync(p)) { console.log(`${C.r}✗${C.x} ${r.name}: canon ${canon} declared but missing`); continue; }
    const hash = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
    const key = `${r.m?.cluster || '(no cluster)'} :: ${canon}`;
    (byCanon[key] = byCanon[key] || []).push({ repo: r.name, hash, path: p, canon });
  }
  if (!Object.keys(byCanon).length) { console.log('no shared canon files declared'); return 0; }

  let drift = 0;
  for (const [key, copies] of Object.entries(byCanon)) {
    const canon = copies[0].canon;
    const hashes = new Set(copies.map(c => c.hash));
    if (hashes.size === 1) {
      console.log(`${C.g}✓${C.x} ${canon}  [${key.split(' :: ')[0]}]  in sync across ${copies.length} repos  ${C.d}${[...hashes][0].slice(0,8)}${C.x}`);
    } else {
      drift++;
      console.log(`${C.r}✗${C.x} ${canon}  [${key.split(' :: ')[0]}]  ${C.r}DRIFTED${C.x} across ${copies.length} repos`);
      const newest = copies.map(c => ({ ...c, mtime: fs.statSync(c.path).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      copies.forEach(c => console.log(`    ${c.hash.slice(0,8)}  ${c.repo}${c.repo === newest.repo ? `  ${C.y}(newest)${C.x}` : ''}`));
      console.log(`    ${C.d}to reconcile: copy ${newest.repo}/${canon} over the others, then re-run${C.x}`);
    }
  }
  return drift ? 1 : 0;
}

/* ---------- graph -------------------------------------------------------- */
function graph(repos) {
  const gitRepos = new Set(String(option('git-repos') || '').split(',').filter(Boolean));
  const pendingByRepo = new Map();
  for (const proposal of readProposals()) {
    if (proposal.state !== 'proposed') continue;
    pendingByRepo.set(proposal.from, (pendingByRepo.get(proposal.from) || 0) + 1);
    if (proposal.to !== proposal.from) pendingByRepo.set(proposal.to, (pendingByRepo.get(proposal.to) || 0) + 1);
  }
  const nodes = repos.map(r => {
    const id = repoId(r);
    const includeGit = hasFlag('git') && (!gitRepos.size || gitRepos.has(id));
    const manifestValid = (r.m?.repo === r.name || r.isRoot === true)
      && typeof r.m?.is === 'string' && r.m.is.length > 0
      && Array.isArray(r.m?.kin);
    const instructions = fs.existsSync(path.join(r.dir, 'AGENTS.md'))
      || fs.existsSync(path.join(r.dir, 'CLAUDE.md'));
    return {
      id, is: r.m?.is, cluster: r.m?.cluster, ranks: r.m?.ranks,
      stack: r.m?.stack || [],
      provides: (r.m?.provides || []).map(p => typeof p === 'object' ? (p.id || Object.keys(p)[0]) : String(p).split(':')[0]),
      assigned: manifestValid && instructions,
      openMessages: readInbox(id).length,
      pendingProposals: pendingByRepo.get(id) || 0,
      presence: readPresence(id),
      git: includeGit ? gitSummary(r.dir) : null,
      pullRequests: readPullRequests(id),
    };
  });
  const edges = [];
  for (const r of repos)
    for (const k of (r.m?.kin || [])) {
      const to = typeof k === 'object' ? k.repo : String(k);
      const recipes = (r.m?.exchanges || [])
        .filter(exchange => exchange && typeof exchange === 'object' && exchange.with === to)
        .map(exchange => ({
          id: exchange.id,
          trigger: exchange.trigger,
          asks: exchange.asks,
          returns: exchange.returns,
          permission: exchange.permission,
          approval: exchange.approval,
        }));
      edges.push({ from: repoId(r), to, why: typeof k === 'object' ? k.why : null, ready: recipes.length > 0, recipes });
    }
  console.log(JSON.stringify({ nodes, edges }, null, 2));
  return 0;
}

/* ---------- agent mail -------------------------------------------------- */
// repos.chat is the transport, not the agent host. Messages live under the
// workspace root so Codex, Claude, CI, or another host can all consume the same
// durable inbox without a server or provider-specific API.
const MAIL_ROOT = path.join(ROOT, '.repo-connect', 'mail');
const QUEUE_ROOT = path.join(ROOT, '.repo-connect', 'queue');
const DELIVERY_ROOT = path.join(ROOT, '.repo-connect', 'delivery');
const PRESENCE_ROOT = path.join(ROOT, '.repo-connect', 'presence');
const PROPOSAL_ROOT = path.join(ROOT, '.repo-connect', 'proposals');
const APPROVAL_ROOT = path.join(ROOT, '.repo-connect', 'approvals');
const GITHUB_ROOT = path.join(ROOT, '.repo-connect', 'github');
const MESSAGE_KINDS = new Set(['request', 'response', 'notice']);
const TRIGGERS = new Set(['manual', 'webhook', 'ci', 'contract-drift']);
const PERMISSIONS = new Set(['read-only', 'propose-change', 'branch-pr']);
// Model hosts repos-agent can run (see hosts.mjs). A recipe may pin one with
// host; a response records the one that answered.
const HOSTS = new Set(['codex', 'claude', 'grok']);
// Aligned with A2A TaskState so a bridge can map one onto the other directly.
// Host responses map the completion outcome: completed, blocked to
// input-required, declined to rejected.
const RESPONSE_STATES = new Set(['completed', 'input-required', 'rejected', 'failed', 'canceled']);

function repoId(r) {
  return r.m?.repo || r.name;
}

function findRepo(repos, id) {
  return repos.find(r => repoId(r) === id || r.name === id);
}

function safeRepoId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== '.' && id !== '..';
}

function safeMessageId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

function safeConversationId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id);
}

function safeExchangeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id);
}

function safeProposalId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function syncProtocolPath(file) {
  if (process.platform === 'win32') {
    let fd = null;
    try {
      fd = fs.openSync(file, 'rs+');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  syncDirectory(path.dirname(file));
}

function ensureDurableDirectory(directory) {
  const missing = [];
  let cursor = path.resolve(directory);
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const entry of missing.reverse()) {
    try { fs.mkdirSync(entry); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    syncDirectory(path.dirname(entry));
  }
}

function writeJsonAtomic(dest, value) {
  ensureDurableDirectory(path.dirname(dest));
  const temp = `${dest}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_SYNC,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, dest);
    syncProtocolPath(dest);
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function containedEvidence(repoDir, claimedPath) {
  if (typeof claimedPath !== 'string' || !claimedPath || path.isAbsolute(claimedPath) || claimedPath.includes('\0')) {
    return { ok: false, error: 'must be a relative regular-file path' };
  }
  const absolute = path.resolve(repoDir, claimedPath);
  const lexical = path.relative(repoDir, absolute);
  if (!lexical || lexical.startsWith('..') || path.isAbsolute(lexical)) {
    return { ok: false, error: 'escapes the represented repository' };
  }
  try {
    const realRoot = fs.realpathSync(repoDir);
    const realTarget = fs.realpathSync(absolute);
    const inside = path.relative(realRoot, realTarget);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return { ok: false, error: 'resolves outside the represented repository' };
    }
    if (!fs.statSync(realTarget).isFile()) return { ok: false, error: 'is not a regular file' };
    return { ok: true, path: realTarget };
  } catch {
    return { ok: false, error: 'does not exist' };
  }
}

function recipeSnapshot(exchange) {
  return {
    with: exchange.with,
    trigger: exchange.trigger,
    asks: exchange.asks,
    returns: exchange.returns,
    permission: exchange.permission,
    approval: exchange.approval,
    evidence: exchange.at,
    // Only present when pinned, so recipes without a host keep the digest
    // they had before hosts existed and in-flight approvals stay valid.
    ...(exchange.host ? { host: exchange.host } : {}),
  };
}

function recipeDigest(recipe) {
  return crypto.createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
}

function validateExchange(repos, source, exchange) {
  if (!exchange || typeof exchange !== 'object') return 'exchange is not a recipe';
  for (const field of ['id', 'with', 'trigger', 'asks', 'returns', 'permission', 'approval', 'at']) {
    if (!exchange[field]) return `exchange is missing ${field}`;
  }
  if (!safeExchangeId(exchange.id)) return 'exchange id contains unsupported characters';
  if (!findRepo(repos, exchange.with)) return `exchange target is not available in this workspace: ${exchange.with}`;
  if (!TRIGGERS.has(exchange.trigger)) return `unsupported trigger: ${exchange.trigger}`;
  if (!PERMISSIONS.has(exchange.permission)) return `unsupported permission: ${exchange.permission}`;
  if (exchange.approval !== 'human-required') return 'exchange approval must be human-required';
  if (exchange.host !== undefined && !HOSTS.has(exchange.host)) return `unsupported host: ${exchange.host}`;
  const evidence = containedEvidence(source.dir, exchange.at);
  if (!evidence.ok) return `exchange evidence ${exchange.at} ${evidence.error}`;
  return null;
}

function messagePath(to, id) {
  return path.join(MAIL_ROOT, to, `${id}.json`);
}

function queuePath(to, id) {
  return path.join(QUEUE_ROOT, to, `${id}.json`);
}

function deliveryPath(to, id) {
  return path.join(DELIVERY_ROOT, to, `${id}.json`);
}

function sameMessage(left, right) {
  return ['id', 'from', 'to', 'kind', 'subject', 'body', 'replyTo', 'conversationId', 'state', 'expiresAt', 'clientMessageId']
    .every(key => (left?.[key] ?? null) === (right?.[key] ?? null))
    && JSON.stringify(left?.authorization || null) === JSON.stringify(right?.authorization || null)
    && JSON.stringify(left?.host || null) === JSON.stringify(right?.host || null)
    && JSON.stringify(left?.target || null) === JSON.stringify(right?.target || null)
    && JSON.stringify(left?.origin || null) === JSON.stringify(right?.origin || null);
}

// Retries that mint a new message id still name the same send with
// clientMessageId. The index is claimed before the mailbox file so a second
// attempt returns the first copy instead of writing another.
function sameClientPayload(left, right) {
  return ['from', 'to', 'kind', 'subject', 'body', 'replyTo', 'state', 'expiresAt', 'clientMessageId']
    .every(key => (left?.[key] ?? null) === (right?.[key] ?? null))
    && JSON.stringify(left?.authorization || null) === JSON.stringify(right?.authorization || null)
    && JSON.stringify(left?.host || null) === JSON.stringify(right?.host || null)
    && JSON.stringify(left?.target || null) === JSON.stringify(right?.target || null)
    && JSON.stringify(left?.origin || null) === JSON.stringify(right?.origin || null);
}

function clientIndexPath(to, clientMessageId) {
  if (!safeRepoId(to) || !safeMessageId(clientMessageId)) return null;
  return path.join(ROOT, '.repo-connect', 'client-ids', to, `${clientMessageId}.json`);
}

function claimClientId(message) {
  if (!message.clientMessageId) return { ok: true };
  const indexPath = clientIndexPath(message.to, message.clientMessageId);
  if (!indexPath) return { ok: false, error: 'client_message_id contains unsupported characters' };
  ensureDurableDirectory(path.dirname(indexPath));
  const pointer = { id: message.id, to: message.to, clientMessageId: message.clientMessageId };
  let fd = null;
  try {
    fd = fs.openSync(indexPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_SYNC, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(pointer)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return { ok: true };
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    if (error.code !== 'EEXIST') return { ok: false, error: `could not record client_message_id: ${error.message}` };
    let existingPointer;
    try { existingPointer = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
    catch { return { ok: false, error: `client_message_id index is unreadable: ${message.clientMessageId}` }; }
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(messagePath(existingPointer.to, existingPointer.id), 'utf8')); }
    catch { /* the first attempt claimed the id and died before the mailbox write */ }
    if (!existing) {
      return existingPointer.id === message.id
        ? { ok: true }
        : { ok: false, error: `client_message_id is claimed by an unfinished delivery: ${message.clientMessageId}` };
    }
    if (!sameClientPayload(existing, message)) {
      return { ok: false, error: `client_message_id already exists with different content: ${message.clientMessageId}` };
    }
    return { ok: true, reused: true, message: existing };
  }
}

function writeMessageExclusive(message) {
  const dest = messagePath(message.to, message.id);
  ensureDurableDirectory(path.dirname(dest));
  let fd = null;
  try {
    fd = fs.openSync(
      dest,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_SYNC,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(message, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    syncProtocolPath(dest);
    return { ok: true, message };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(dest); } catch {}
    }
    if (error.code !== 'EEXIST') return { ok: false, error: `could not deliver message: ${error.message}` };
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch { return { ok: false, error: `message id already exists but is unreadable: ${message.id}` }; }
    if (!sameMessage(existing, message)) {
      return { ok: false, error: `message id already exists with different content: ${message.id}` };
    }
    return { ok: true, message: existing, reused: true };
  }
}

function writeDeliveryIntent(message) {
  const dest = deliveryPath(message.to, message.id);
  ensureDurableDirectory(path.dirname(dest));
  let fd = null;
  try {
    fd = fs.openSync(
      dest,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_SYNC,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(message, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    syncProtocolPath(dest);
    return { ok: true };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(dest); } catch {}
    }
    if (error.code !== 'EEXIST') return { ok: false, error: `could not journal message delivery: ${error.message}` };
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch { return { ok: false, error: `delivery journal is unreadable: ${message.id}` }; }
    return sameMessage(existing, message)
      ? { ok: true, reused: true }
      : { ok: false, error: `delivery journal conflicts with message: ${message.id}` };
  }
}

function repairDeliveries(repo) {
  const dir = path.join(DELIVERY_ROOT, repo);
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return 0; }
  let repaired = 0;
  for (const name of names) {
    try {
      const message = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!safeMessageId(message.id) || name !== `${message.id}.json` || message.to !== repo
          || message.protocol !== 'repos.chat/1' || message.version !== 3
          || !MESSAGE_KINDS.has(message.kind)) continue;
      const written = writeMessageExclusive(message);
      if (!written.ok) continue;
      if (!written.message.acknowledgedAt) {
        writeJsonAtomic(queuePath(repo, message.id), { id: message.id, to: repo });
      }
      fs.unlinkSync(deliveryPath(repo, message.id));
      syncDirectory(path.join(DELIVERY_ROOT, repo));
      repaired++;
    } catch {
      // Keep the journal for inspection or a later successful repair.
    }
  }
  return repaired;
}

function ensureQueue(repo) {
  repairDeliveries(repo);
  const queueDir = path.join(QUEUE_ROOT, repo);
  if (fs.existsSync(queueDir)) return queueDir;
  ensureDurableDirectory(queueDir);
  const mailDir = path.join(MAIL_ROOT, repo);
  let names = [];
  try { names = fs.readdirSync(mailDir).filter(name => name.endsWith('.json')); } catch { return queueDir; }
  for (const name of names) {
    try {
      const message = JSON.parse(fs.readFileSync(path.join(mailDir, name), 'utf8'));
      if (MESSAGE_KINDS.has(message.kind) && !message.acknowledgedAt && safeMessageId(message.id)
          && name === `${message.id}.json` && message.to === repo) {
        writeJsonAtomic(queuePath(repo, message.id), { id: message.id, to: repo });
      }
    } catch {}
  }
  return queueDir;
}

function readInbox(repo, includeAcknowledged = false) {
  const dir = path.join(MAIL_ROOT, repo);
  let names = [];
  try {
    names = includeAcknowledged
      ? fs.readdirSync(dir).filter(name => name.endsWith('.json'))
      : fs.readdirSync(ensureQueue(repo)).filter(name => name.endsWith('.json'));
  } catch { return []; }
  const messages = [];
  for (const name of names) {
    try {
      const message = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (includeAcknowledged || !message.acknowledgedAt) messages.push(message);
    } catch {
      // A corrupt message should not make every other message unreadable.
    }
  }
  return messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function findMessageById(id) {
  let repos = [];
  try { repos = fs.readdirSync(MAIL_ROOT, { withFileTypes: true }); } catch { return null; }
  for (const entry of repos) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(MAIL_ROOT, entry.name, `${id}.json`);
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {}
  }
  return null;
}

function readAllMail() {
  let boxes = [];
  try { boxes = fs.readdirSync(MAIL_ROOT, { withFileTypes: true }); } catch { return []; }
  return boxes
    .filter(entry => entry.isDirectory() && safeRepoId(entry.name))
    .flatMap(entry => readInbox(entry.name, true));
}

// Messages from before conversationId existed belong to the root of their
// replyTo chain.
function conversationOf(message, byId, seen = new Set()) {
  if (message.conversationId) return message.conversationId;
  if (!message.replyTo || seen.has(message.id)) return message.id;
  seen.add(message.id);
  const parent = byId.get(message.replyTo);
  return parent ? conversationOf(parent, byId, seen) : message.replyTo;
}

function conversation() {
  const id = option('id');
  if (!safeConversationId(id)) {
    console.error('conversation requires --id with a message or conversation id');
    return 1;
  }
  const all = readAllMail();
  const byId = new Map(all.map(message => [message.id, message]));
  const target = byId.has(id) ? conversationOf(byId.get(id), byId) : id;
  const messages = all
    .filter(message => conversationOf(message, byId) === target)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!messages.length) {
    console.error(`no messages in conversation ${id}`);
    return 1;
  }
  if (hasFlag('json')) {
    console.log(JSON.stringify({ conversationId: target, messages: messages.map(message => ({ ...message, delivery: deliveryStatus(ROOT, message) })) }, null, 2));
    return 0;
  }
  console.log(`conversation ${target}  ${messages.length} message${messages.length === 1 ? '' : 's'}\n`);
  for (const message of messages) {
    const via = message.host ? `  via ${message.host.name}${message.host.model ? `/${message.host.model}` : ''}` : '';
    const state = message.state ? `  [${message.state}]` : '';
    console.log(`${message.createdAt}  ${message.from} -> ${message.to}  ${message.kind}${state}${via}  (${deliveryStatus(ROOT, message).label})`);
    console.log(`  ${message.subject}`);
    console.log(`  ${String(message.body).split('\n').join('\n  ')}\n`);
  }
  return 0;
}

function proposalPath(id) {
  return path.join(PROPOSAL_ROOT, `${id}.json`);
}

function approvalPath(id) {
  return path.join(APPROVAL_ROOT, `${id}.json`);
}

function proposalPayload(proposal) {
  return {
    version: proposal.version,
    protocol: proposal.protocol,
    id: proposal.id,
    from: proposal.from,
    to: proposal.to,
    exchange: proposal.exchange,
    event: proposal.event,
    subject: proposal.subject,
    body: proposal.body,
    recipe: proposal.recipe,
    recipeDigest: proposal.recipeDigest,
    createdAt: proposal.createdAt,
    // A follow-up is bound to the message it continues. Absent otherwise, so
    // proposals without one keep the digest they always had.
    ...(proposal.replyTo ? { replyTo: proposal.replyTo } : {}),
  };
}

function proposalDigest(proposal) {
  return crypto.createHash('sha256').update(JSON.stringify(proposalPayload(proposal))).digest('hex');
}

function approvalToken(proposal) {
  return `${proposal.id}:${proposal.payloadDigest.slice(0, 12)}`;
}

function readApproval(id) {
  try { return JSON.parse(fs.readFileSync(approvalPath(id), 'utf8')); } catch { return null; }
}

function writeApprovalExclusive(record) {
  const dest = approvalPath(record.proposalId);
  ensureDurableDirectory(path.dirname(dest));
  try {
    const fd = fs.openSync(
      dest,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_SYNC,
      0o600,
    );
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    syncProtocolPath(dest);
    return { ok: true, record };
  } catch (error) {
    if (error.code !== 'EEXIST') return { ok: false, error: error.message };
    const existing = readApproval(record.proposalId);
    if (!existing || existing.payloadDigest !== record.payloadDigest || existing.confirmation !== record.confirmation) {
      return { ok: false, error: 'an incompatible approval record already exists' };
    }
    return { ok: true, record: existing, reused: true };
  }
}

function readProposals(repo = null) {
  let names = [];
  try { names = fs.readdirSync(PROPOSAL_ROOT).filter(name => name.endsWith('.json')); } catch { return []; }
  const proposals = [];
  for (const name of names) {
    try {
      const proposal = JSON.parse(fs.readFileSync(path.join(PROPOSAL_ROOT, name), 'utf8'));
      if (!repo || proposal.from === repo || proposal.to === repo) proposals.push(proposal);
    } catch {
      // One corrupt proposal must not hide the remaining approval queue.
    }
  }
  return proposals.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function readPullRequests(repo) {
  const dest = path.join(GITHUB_ROOT, 'pull-requests', `${repo}.json`);
  try {
    const value = JSON.parse(fs.readFileSync(dest, 'utf8'));
    return Array.isArray(value.pullRequests) ? value.pullRequests : [];
  } catch { return []; }
}

function gitRun(dir, gitArgs) {
  try {
    return execFileSync(GIT_BIN, ['-C', dir, ...gitArgs], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

function gitSummary(dir) {
  if (gitRun(dir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const log = gitRun(dir, ['log', '-3', '--date=iso-strict', '--pretty=format:%h%x1f%cs%x1f%s']);
  return {
    branch: gitRun(dir, ['branch', '--show-current']) || '(detached)',
    head: gitRun(dir, ['rev-parse', '--short', 'HEAD']) || null,
    changedFiles: gitRun(dir, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean).length,
    commits: log ? log.split(/\r?\n/).map(line => {
      const [hash, date, subject] = line.split('\x1f');
      return { hash, date, subject };
    }) : [],
  };
}

function exchangeFor(repos, from, exchangeId) {
  const source = findRepo(repos, from);
  if (!source) return null;
  const exchange = (source.m?.exchanges || []).find(item =>
    item && typeof item === 'object' && item.id === exchangeId);
  return exchange ? { source, exchange } : null;
}

function trigger(repos) {
  const from = option('from');
  const exchangeId = option('exchange');
  const event = option('event') || 'manual';
  const replyTo = option('reply-to');
  const subject = option('subject');
  const bodyFile = option('body-file');
  let body = option('body');
  if (!safeRepoId(from) || !safeExchangeId(exchangeId) || !TRIGGERS.has(event)) {
    console.error(`trigger requires safe --from and --exchange plus --event ${[...TRIGGERS].join('|')}`);
    return 1;
  }
  const resolved = exchangeFor(repos, from, exchangeId);
  if (!resolved) {
    console.error(`exchange not found: ${from}/${exchangeId}`);
    return 1;
  }
  const { source, exchange } = resolved;
  const exchangeProblem = validateExchange(repos, source, exchange);
  if (exchangeProblem) {
    console.error(`exchange ${exchangeId} is not executable: ${exchangeProblem}`);
    return 1;
  }
  if (exchange.trigger !== event) {
    console.error(`exchange ${exchangeId} accepts ${exchange.trigger}, not ${event}`);
    return 1;
  }
  if (!findRepo(repos, exchange.with)) {
    console.error(`exchange target is not available in this workspace: ${exchange.with}`);
    return 1;
  }
  if (!subject) {
    console.error('trigger requires --subject');
    return 1;
  }
  // A follow-up continues a message this repository received from the same
  // repository it is asking, so a conversation cannot be joined from outside.
  if (replyTo) {
    const parent = safeMessageId(replyTo) ? findMessageById(replyTo) : null;
    if (!parent || parent.to !== from || parent.from !== exchange.with) {
      console.error(`--reply-to must name a message ${exchange.with} sent to ${from}`);
      return 1;
    }
  }
  if (bodyFile) {
    try { body = fs.readFileSync(path.resolve(bodyFile), 'utf8'); }
    catch (err) { console.error(`could not read --body-file: ${err.message}`); return 1; }
  }
  if (!body) {
    console.error('trigger requires --body or --body-file');
    return 1;
  }
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:.]/g, '');
  const id = `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  const proposal = {
    version: 1,
    protocol: 'repos.chat/proposal/1',
    id,
    state: 'proposed',
    from,
    to: exchange.with,
    exchange: exchangeId,
    event,
    subject,
    body,
    recipe: recipeSnapshot(exchange),
    recipeDigest: recipeDigest(recipeSnapshot(exchange)),
    createdAt,
    ...(replyTo ? { replyTo } : {}),
  };
  proposal.payloadDigest = proposalDigest(proposal);
  writeJsonAtomic(proposalPath(id), proposal);
  console.log(JSON.stringify({
    ok: true,
    delivered: false,
    proposal,
    next: `repos approve --id ${id} --approve ${approvalToken(proposal)}`,
  }, null, 2));
  return 0;
}

function listProposals(repos) {
  const repo = option('repo');
  if (repo && (!safeRepoId(repo) || !findRepo(repos, repo))) {
    console.error('proposals --repo must match a verified manifest');
    return 1;
  }
  const proposals = readProposals(repo).filter(proposal => hasFlag('all') || proposal.state === 'proposed');
  if (hasFlag('json')) {
    console.log(JSON.stringify({ repo: repo || null, proposals }, null, 2));
    return 0;
  }
  if (!proposals.length) {
    console.log('no pending proposals');
    return 0;
  }
  for (const proposal of proposals) {
    console.log(`${proposal.id}  ${proposal.state}  ${proposal.from} -> ${proposal.to}  [${proposal.exchange}]`);
    console.log(`    ${proposal.subject}`);
  }
  return 0;
}

function approve(repos) {
  const id = option('id');
  const confirmation = option('approve');
  if (!safeProposalId(id)) {
    console.error('approve requires a safe --id');
    return 1;
  }
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(proposalPath(id), 'utf8')); }
  catch { console.error(`proposal not found: ${id}`); return 1; }
  if (proposal.id !== id || proposal.protocol !== 'repos.chat/proposal/1' || proposal.version !== 1
      || proposal.payloadDigest !== proposalDigest(proposal)) {
    console.error(`proposal ${id} failed its immutable payload check`);
    return 1;
  }
  const expectedConfirmation = approvalToken(proposal);
  if (confirmation !== expectedConfirmation) {
    console.error(`approve requires the exact content-bound confirmation: --approve ${expectedConfirmation}`);
    return 1;
  }
  if (!['proposed', 'approved'].includes(proposal.state)) {
    console.error(`proposal ${id} is already ${proposal.state}`);
    return 1;
  }
  const resolved = exchangeFor(repos, proposal.from, proposal.exchange);
  if (!resolved || resolved.exchange.with !== proposal.to) {
    console.error(`proposal ${id} no longer matches a declared exchange`);
    return 1;
  }
  const exchangeProblem = validateExchange(repos, resolved.source, resolved.exchange);
  if (exchangeProblem) {
    console.error(`proposal ${id} is no longer authorized: ${exchangeProblem}`);
    return 1;
  }
  const currentRecipe = recipeSnapshot(resolved.exchange);
  if (recipeDigest(currentRecipe) !== proposal.recipeDigest
      || JSON.stringify(currentRecipe) !== JSON.stringify(proposal.recipe)) {
    console.error(`proposal ${id} is stale because its exchange recipe changed; trigger a new proposal`);
    return 1;
  }
  const approval = writeApprovalExclusive({
    protocol: 'repos.chat/approval/1',
    proposalId: id,
    payloadDigest: proposal.payloadDigest,
    confirmation: expectedConfirmation,
    approvedBy: 'local-operator',
    approvedAt: new Date().toISOString(),
  });
  if (!approval.ok) {
    console.error(`could not persist approval: ${approval.error}`);
    return 1;
  }
  const delivered = deliverMessage(repos, {
    id: `${id}-request`,
    from: proposal.from,
    to: proposal.to,
    kind: 'request',
    subject: proposal.subject,
    body: proposal.body,
    replyTo: proposal.replyTo || null,
    metadata: {
      proposalId: id,
      exchange: proposal.exchange,
      permission: currentRecipe.permission,
      ...(currentRecipe.host ? { host: currentRecipe.host } : {}),
      recipeDigest: proposal.recipeDigest,
      approvedBy: 'local-operator',
    },
  });
  if (!delivered.ok) {
    console.error(delivered.error);
    return 1;
  }
  proposal.state = 'approved';
  proposal.approvedAt = approval.record.approvedAt;
  proposal.approvedBy = 'local-operator';
  proposal.messageId = delivered.message.id;
  writeJsonAtomic(proposalPath(id), proposal);
  console.log(JSON.stringify({ ok: true, proposal, message: delivered.message }, null, 2));
  return 0;
}

function deliverMessage(repos, input) {
  const { from, to, subject } = input;
  const kind = input.kind || 'request';
  const replyTo = input.replyTo || null;
  const requestedConversationId = input.conversationId || null;
  const body = input.body;
  if (!safeRepoId(from) || !safeRepoId(to)) return { ok: false, error: 'message requires safe from and to repo ids' };
  if (!findRepo(repos, from) || !findRepo(repos, to)) return { ok: false, error: 'message requires from and to to match verified manifests in this workspace' };
  if (!subject) return { ok: false, error: 'message requires a subject' };
  if (!MESSAGE_KINDS.has(kind)) return { ok: false, error: `kind must be one of: ${[...MESSAGE_KINDS].join(', ')}` };
  if (replyTo && !safeMessageId(replyTo)) return { ok: false, error: 'replyTo contains unsupported characters' };
  if (requestedConversationId && !safeConversationId(requestedConversationId)) return { ok: false, error: 'conversationId contains unsupported characters' };
  if (!body) return { ok: false, error: 'message requires a body' };
  if (input.state && (kind !== 'response' || !RESPONSE_STATES.has(input.state))) {
    return { ok: false, error: `state is only for responses and must be one of: ${[...RESPONSE_STATES].join(', ')}` };
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires)) return { ok: false, error: 'expiresAt must be an ISO 8601 time' };
    if (expires <= Date.now()) return { ok: false, error: 'expiresAt is already in the past' };
  }
  if (input.host && !HOSTS.has(input.host.name)) {
    return { ok: false, error: `host must be one of: ${[...HOSTS].join(', ')}` };
  }
  if (input.host?.model && !/^[A-Za-z0-9._:/-]{1,100}$/.test(input.host.model)) {
    return { ok: false, error: 'host model contains unsupported characters' };
  }

  const requestedId = input.id || null;
  if (requestedId && !safeMessageId(requestedId)) return { ok: false, error: 'message id contains unsupported characters' };
  const clientMessageId = input.clientMessageId || null;
  if (clientMessageId && !safeMessageId(clientMessageId)) return { ok: false, error: 'client_message_id contains unsupported characters' };
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:.]/g, '');
  const id = requestedId || clientMessageId || `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  const parent = replyTo ? findMessageById(replyTo) : null;
  const conversationId = requestedConversationId || parent?.conversationId || id;
  const message = {
    version: 3,
    protocol: 'repos.chat/1',
    id,
    conversationId,
    from,
    to,
    kind,
    subject,
    body,
    createdAt,
    ...(replyTo ? { replyTo } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.host ? { host: input.host } : {}),
    ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
    ...(input.metadata ? { authorization: input.metadata } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(input.target ? { target: input.target } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.receiptRepo ? { receiptRepo: input.receiptRepo } : {}),
  };
  return commitMessage(message);
}

function commitMessage(message) {
  const claimed = claimClientId(message);
  if (!claimed.ok) return claimed;
  if (claimed.reused) return { ok: true, message: claimed.message, reused: true };
  const intent = writeDeliveryIntent(message);
  if (!intent.ok) return intent;
  const written = writeMessageExclusive(message);
  if (!written.ok) return written;
  if (!written.message.acknowledgedAt) {
    writeJsonAtomic(queuePath(message.to, written.message.id), { id: written.message.id, to: message.to });
  }
  try {
    fs.unlinkSync(deliveryPath(message.to, message.id));
    syncDirectory(path.join(DELIVERY_ROOT, message.to));
  }
  catch (error) { return { ok: false, error: `message delivered but delivery journal could not close: ${error.message}` }; }
  return { ok: true, message: written.message, reused: written.reused || intent.reused || false };
}

function importRelayMessage(message) {
  if (!message || message.protocol !== 'repos.chat/1' || message.version !== 3) {
    return { ok: false, error: 'unsupported relay message' };
  }
  if (message.kind === 'request') return { ok: false, error: 'relay import accepts notice and response only' };
  if (!MESSAGE_KINDS.has(message.kind)) return { ok: false, error: 'unsupported message kind' };
  if (!safeRepoId(message.from) || !safeRepoId(message.to) || !safeMessageId(message.id)) {
    return { ok: false, error: 'remote message has an unsafe id' };
  }
  if (!message.clientMessageId || !safeMessageId(message.clientMessageId)) {
    return { ok: false, error: 'remote message is missing client_message_id' };
  }
  if (!message.subject || !message.body) return { ok: false, error: 'remote message requires subject and body' };
  if (message.target?.kind === 'repo' && !findRepo(findManifests(ROOT, DEPTH), message.to)) {
    return { ok: false, error: `no local manifest for ${message.to}` };
  }
  return commitMessage(message);
}

function send(repos) {
  const from = option('from');
  const to = option('to');
  const subject = option('subject');
  const bodyFile = option('body-file');
  let body = option('body');
  const kind = option('kind') || 'notice';
  const replyTo = option('reply-to');
  const requestedConversationId = option('conversation-id');
  const state = option('state');
  const hostName = option('host');
  const hostModel = option('model');
  const expiresIn = option('expires-in');
  let expiresAt = option('expires-at');
  if (expiresIn) {
    const ms = parseDuration(expiresIn);
    if (!ms) {
      console.error('send --expires-in takes a duration such as 30m, 48h, 7d, or 2w');
      return 1;
    }
    expiresAt = new Date(Date.now() + ms).toISOString();
  }

  if (!safeRepoId(from) || !safeRepoId(to)) {
    console.error('send requires safe --from and --to repo ids');
    return 1;
  }
  if (!findRepo(repos, from) || !findRepo(repos, to)) {
    console.error('send requires --from and --to to match verified manifests in this workspace');
    return 1;
  }
  if (!subject) {
    console.error('send requires --subject');
    return 1;
  }
  if (!MESSAGE_KINDS.has(kind)) {
    console.error(`send --kind must be one of: ${[...MESSAGE_KINDS].join(', ')}`);
    return 1;
  }
  if (replyTo && !safeMessageId(replyTo)) {
    console.error('send --reply-to contains unsupported characters');
    return 1;
  }
  if (requestedConversationId && !safeConversationId(requestedConversationId)) {
    console.error('send --conversation-id contains unsupported characters');
    return 1;
  }
  if (bodyFile) {
    try { body = fs.readFileSync(path.resolve(bodyFile), 'utf8'); }
    catch (err) { console.error(`could not read --body-file: ${err.message}`); return 1; }
  }
  if (!body) {
    console.error('send requires --body or --body-file');
    return 1;
  }
  if (kind === 'request') {
    console.error('raw requests are disabled; use trigger then approve so work is bound to a verified recipe');
    return 1;
  }
  const delivered = deliverMessage(repos, {
    from,
    to,
    subject,
    body,
    kind,
    replyTo,
    conversationId: requestedConversationId,
    state,
    host: hostName ? { name: hostName, ...(hostModel ? { model: hostModel } : {}) } : null,
    expiresAt,
    clientMessageId: option('client-message-id'),
    id: process.env.REPOS_CHAT_AGENT_HOST === '1'
      ? process.env.REPOS_CHAT_INTERNAL_MESSAGE_ID || null
      : null,
  });
  if (!delivered.ok) {
    console.error(delivered.error);
    return 1;
  }
  // Report delivery truthfully: a fresh message is queued, not seen.
  const delivery = deliveryStatus(ROOT, delivered.message);
  console.log(JSON.stringify({ ...delivered, delivery: { ...delivery, check: `repos sent --root ${ROOT} --repo ${from}` } }, null, 2));
  return 0;
}

function inbox(repos) {
  const repo = option('repo');
  if (!safeRepoId(repo) || !findRepo(repos, repo)) {
    console.error('inbox requires --repo matching a verified manifest');
    return 1;
  }
  const staleDays = staleDaysOption();
  if (staleDays === null) return 1;
  const messages = readInbox(repo, hasFlag('all'));
  if (hasFlag('mark-seen')) {
    const host = option('host') || 'mcp';
    const session = option('session') || 'stdio';
    if (!/^[A-Za-z0-9._-]+$/.test(host) || !/^[A-Za-z0-9._-]{1,80}$/.test(session)) {
      console.error('inbox --mark-seen requires a safe --host and --session');
      return 1;
    }
    for (const message of messages) {
      if (!message.acknowledgedAt && safeMessageId(message.id)) {
        try { recordSeen(ROOT, message.receiptRepo || repo, message.id, { host, session }); } catch { /* a bad receipt must not hide the inbox */ }
      }
    }
  }
  if (hasFlag('json')) {
    console.log(JSON.stringify({
      repo,
      staleDays,
      messages: messages.map(message => ({
        ...message,
        flags: freshness(message, { staleDays }),
        seen: readSeen(ROOT, repo, message.id),
      })),
    }, null, 2));
    return 0;
  }
  if (!messages.length) {
    console.log(`no ${hasFlag('all') ? '' : 'open '}messages for ${repo}`);
    return 0;
  }
  for (const message of messages) {
    const state = message.acknowledgedAt ? 'acknowledged' : 'open';
    const { stale, expired, openDays } = freshness(message, { staleDays });
    const flag = expired ? `  ${C.r}EXPIRED${C.x}` : stale ? `  ${C.y}STALE ${openDays}d${C.x}` : '';
    console.log(`${message.id}  ${message.kind}  ${state}  from ${message.from}${flag}`);
    console.log(`    ${message.subject}`);
  }
  return 0;
}

function staleDaysOption() {
  const raw = option('stale-days');
  if (raw === null) return STALE_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    console.error('--stale-days must be a whole number of at least 1');
    return null;
  }
  return days;
}

// The sender's view: every message one repository sent, newest first, with
// whether a live session has seen it and whether the recipient acked it.
function sentMessages(repos) {
  const repo = option('repo');
  if (!safeRepoId(repo) || !findRepo(repos, repo)) {
    console.error('sent requires --repo matching a verified manifest');
    return 1;
  }
  const staleDays = staleDaysOption();
  if (staleDays === null) return 1;
  const all = readAllMail()
    .filter(message => message.from === repo)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const shown = hasFlag('all') ? all : all.slice(0, 20);
  const rows = shown.map(message => ({
    id: message.id,
    to: message.to,
    kind: message.kind,
    subject: message.subject,
    createdAt: message.createdAt,
    ...(message.expiresAt ? { expiresAt: message.expiresAt } : {}),
    delivery: deliveryStatus(ROOT, message, { staleDays }),
  }));
  if (hasFlag('json')) {
    console.log(JSON.stringify({ repo, total: all.length, messages: rows }, null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log(`${repo} has sent no messages`);
    return 0;
  }
  for (const row of rows) {
    const colour = row.delivery.status === 'acked' ? C.g : row.delivery.status === 'seen' ? C.y : C.d;
    console.log(`${row.id}  -> ${row.to}  ${row.kind}  ${colour}${row.delivery.label}${C.x}`);
    console.log(`    ${row.subject}`);
  }
  if (all.length > rows.length) console.log(`\n${all.length - rows.length} older; add --all to list them`);
  return 0;
}

// Workspace triage: which mailboxes hold open work, how much of it nobody has
// seen, and which messages are old enough to close or re-send.
function focus(repos) {
  const only = option('repo');
  if (only && (!safeRepoId(only) || !findRepo(repos, only))) {
    console.error('focus --repo must match a verified manifest');
    return 1;
  }
  const staleDays = staleDaysOption();
  if (staleDays === null) return 1;
  let boxes = [];
  try { boxes = fs.readdirSync(MAIL_ROOT, { withFileTypes: true }).filter(e => e.isDirectory() && safeRepoId(e.name)).map(e => e.name); }
  catch {}
  if (only) boxes = boxes.filter(box => box === only);
  const rows = [];
  for (const box of boxes) {
    const open = readInbox(box);
    if (!open.length) continue;
    const details = open.map(message => ({ message, ...freshness(message, { staleDays }), seen: readSeen(ROOT, box, message.id).length > 0 }));
    rows.push({
      repo: box,
      open: open.length,
      unseen: details.filter(item => !item.seen).length,
      stale: details.filter(item => item.stale).length,
      expired: details.filter(item => item.expired).length,
      oldestDays: Math.max(...details.map(item => item.openDays ?? 0)),
      attention: details
        .filter(item => item.stale || item.expired)
        .map(item => ({ id: item.message.id, from: item.message.from, kind: item.message.kind, subject: item.message.subject, openDays: item.openDays, expired: item.expired })),
    });
  }
  rows.sort((a, b) => b.stale + b.expired - (a.stale + a.expired) || b.open - a.open || a.repo.localeCompare(b.repo));
  const totals = rows.reduce((sum, row) => ({
    open: sum.open + row.open, unseen: sum.unseen + row.unseen, stale: sum.stale + row.stale, expired: sum.expired + row.expired,
  }), { open: 0, unseen: 0, stale: 0, expired: 0 });
  if (hasFlag('json')) {
    console.log(JSON.stringify({ staleDays, totals, repos: rows }, null, 2));
    return 0;
  }
  if (!rows.length) {
    console.log(only ? `no open messages for ${only}` : 'no open messages in this workspace');
    return 0;
  }
  console.log(`${totals.open} open across ${rows.length} repo${rows.length === 1 ? '' : 's'}: ${totals.unseen} never seen, ${totals.stale} open ${staleDays}+ days, ${totals.expired} expired\n`);
  for (const row of rows) {
    const parts = [`${row.open} open`, `${row.unseen} unseen`];
    if (row.stale) parts.push(`${C.y}${row.stale} stale${C.x}`);
    if (row.expired) parts.push(`${C.r}${row.expired} expired${C.x}`);
    console.log(`${row.repo}  ${parts.join(', ')}`);
    for (const item of row.attention) {
      console.log(`    ${item.expired ? 'EXPIRED' : `${item.openDays}d`}  ${item.id}  ${item.kind} from ${item.from}: ${item.subject}`);
    }
  }
  if (totals.stale || totals.expired) console.log('\nClose each with repos ack, or re-send it if the work is still needed.');
  return 0;
}

const slash = value => String(value).replace(/\\/g, '/');
const OUR_HOOK = 'inbox-hook.mjs';

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed;
}

// Installs or removes the session delivery hook. Defaults to the private
// settings.local.json because the command holds absolute local paths;
// --shared writes the committed settings.json instead.
function installClaudeHook(repos) {
  if (args[1] !== 'claude') {
    console.error('usage: repos hook claude --root DIR --repo REPO [--shared] [--remove]');
    return 1;
  }
  const id = option('repo');
  const current = safeRepoId(id) ? findRepo(repos, id) : null;
  if (!current) {
    console.error('hook requires --repo matching a verified manifest');
    return 1;
  }
  const shared = hasFlag('shared');
  const remove = hasFlag('remove');
  const file = path.join(current.dir, '.claude', shared ? 'settings.json' : 'settings.local.json');
  let settings;
  try { settings = readJsonFile(file); }
  catch (err) {
    console.error(`refusing to overwrite unreadable settings: ${err.message}`);
    return 1;
  }
  const agent = option('agent');
  if (agent && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) {
    console.error('hook --agent must be a safe agent id');
    return 1;
  }
  const command = event => formatHookCommand({
    hookPath: path.join(HERE, OUR_HOOK),
    root: path.resolve(ROOT),
    repo: repoId(current),
    event,
    host: 'claude',
    agent,
  });
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    // Drop only entries that run this hook, so other hooks are untouched and
    // reinstalling never duplicates.
    const groups = (Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [])
      .map(group => ({ ...group, hooks: (group.hooks || []).filter(hook => !String(hook.command || '').includes(OUR_HOOK)) }))
      .filter(group => group.hooks.length);
    if (!remove) {
      groups.push({
        ...(event === 'SessionStart' ? { matcher: 'startup|resume|clear|compact' } : {}),
        hooks: [{ type: 'command', command: command(event), timeout: 5 }],
      });
    }
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeJsonAtomic(file, settings);
  console.log(JSON.stringify({
    ok: true,
    repo: repoId(current),
    file,
    installed: !remove,
    events: remove ? [] : ['UserPromptSubmit', 'SessionStart'],
    note: remove
      ? 'Session delivery removed.'
      : `New messages to ${repoId(current)} now appear in the next prompt of any Claude Code session in that repository.${shared ? ' This file is shared: the command contains absolute local paths, so check before committing it.' : ''}`,
  }, null, 2));
  return 0;
}

// Adds repos-mcp to one Claude Code project so a live session can reply, ack,
// and propose without shelling out. Local scope by default (private to this
// machine, through the claude CLI); --shared writes the project .mcp.json.
function installMcp(repos) {
  if (args[1] !== 'install') {
    console.error('usage: repos mcp install --root DIR --repo REPO [--shared]');
    return 1;
  }
  const id = option('repo');
  const current = safeRepoId(id) ? findRepo(repos, id) : null;
  if (!current) {
    console.error('mcp install requires --repo matching a verified manifest');
    return 1;
  }
  const server = { command: 'node', args: [slash(path.join(HERE, 'mcp.mjs')), '--root', slash(path.resolve(ROOT)), '--as', repoId(current)] };
  if (hasFlag('shared')) {
    const file = path.join(current.dir, '.mcp.json');
    let config;
    try { config = readJsonFile(file); }
    catch (err) {
      console.error(`refusing to overwrite unreadable .mcp.json: ${err.message}`);
      return 1;
    }
    config.mcpServers = { ...(config.mcpServers || {}), repos: server };
    writeJsonAtomic(file, config);
    console.log(JSON.stringify({ ok: true, repo: repoId(current), scope: 'project', file, note: 'The entry contains absolute local paths; check before committing .mcp.json.' }, null, 2));
    return 0;
  }
  const bin = process.env.REPOS_CLAUDE_BIN || 'claude';
  let prefix = [];
  try { prefix = process.env.REPOS_CLAUDE_BIN_ARGS ? JSON.parse(process.env.REPOS_CLAUDE_BIN_ARGS) : []; } catch {}
  const claude = cliArgs => spawnSync(bin, [...prefix, ...cliArgs], { cwd: current.dir, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60000 });
  const manual = `cd "${current.dir}" && claude mcp add --scope local repos -- ${server.command} ${server.args.map(arg => `"${arg}"`).join(' ')}`;
  // Replace any earlier entry so the identity and paths stay current.
  claude(['mcp', 'remove', '--scope', 'local', 'repos']);
  const added = claude(['mcp', 'add', '--scope', 'local', 'repos', '--', server.command, ...server.args]);
  if (added.error || added.status !== 0) {
    console.error(`could not run the claude CLI (${added.error ? added.error.message : `exit ${added.status}`}). Run this yourself:\n${manual}`);
    return 1;
  }
  console.log(JSON.stringify({ ok: true, repo: repoId(current), scope: 'local', server, note: 'Restart or reload the Claude Code session in that repository to load the repos tools.' }, null, 2));
  return 0;
}

function acknowledge(repos) {
  const repo = option('repo');
  const id = option('id');
  if (!safeRepoId(repo) || !findRepo(repos, repo) || !safeMessageId(id)) {
    console.error('ack requires --repo matching a verified manifest and --id');
    return 1;
  }
  const dest = messagePath(repo, id);
  let message;
  try { message = JSON.parse(fs.readFileSync(dest, 'utf8')); }
  catch { console.error(`message not found: ${id}`); return 1; }
  if (message.to !== repo) {
    console.error(`message ${id} does not belong to ${repo}`);
    return 1;
  }
  const by = option('by');
  const session = option('session');
  if (by && !/^[A-Za-z0-9._-]+$/.test(by)) {
    console.error('ack --by contains unsupported characters');
    return 1;
  }
  if (session && !/^[A-Za-z0-9._-]{1,80}$/.test(session)) {
    console.error('ack --session contains unsupported characters');
    return 1;
  }
  if (!message.acknowledgedAt) {
    message.acknowledgedAt = new Date().toISOString();
    message.acknowledgedBy = { repo, ...(by ? { host: by } : {}), ...(session ? { session } : {}) };
  }
  writeJsonAtomic(dest, message);
  try {
    fs.unlinkSync(queuePath(repo, id));
    syncDirectory(path.join(QUEUE_ROOT, repo));
  } catch {}
  console.log(JSON.stringify({ ok: true, message }, null, 2));
  return 0;
}

function validateRequest(repos) {
  const repo = option('repo');
  const id = option('id');
  if (!safeRepoId(repo) || !findRepo(repos, repo) || !safeMessageId(id)) {
    console.error('validate-request requires a verified --repo and safe --id');
    return 1;
  }
  let message;
  try { message = JSON.parse(fs.readFileSync(messagePath(repo, id), 'utf8')); }
  catch { console.error(`request not found: ${id}`); return 1; }
  if (message.protocol !== 'repos.chat/1' || message.version !== 3 || message.kind !== 'request' || message.to !== repo) {
    console.error(`request ${id} is not a supported repos.chat request envelope`);
    return 1;
  }
  const proposalId = message.authorization?.proposalId;
  if (!safeProposalId(proposalId)) {
    console.error(`request ${id} has no approved proposal authorization`);
    return 1;
  }
  let proposal;
  try { proposal = JSON.parse(fs.readFileSync(proposalPath(proposalId), 'utf8')); }
  catch { console.error(`request ${id} references a missing proposal`); return 1; }
  if (proposal.id !== proposalId || proposal.protocol !== 'repos.chat/proposal/1'
      || proposal.version !== 1 || typeof proposal.payloadDigest !== 'string'
      || proposal.payloadDigest !== proposalDigest(proposal)) {
    console.error(`request ${id} references a mutable or malformed proposal`);
    return 1;
  }
  const approval = readApproval(proposalId);
  if (!approval || approval.protocol !== 'repos.chat/approval/1'
      || approval.payloadDigest !== proposal.payloadDigest
      || approval.confirmation !== approvalToken(proposal)
      || proposal.payloadDigest !== proposalDigest(proposal)) {
    console.error(`request ${id} has no matching content-bound human approval`);
    return 1;
  }
  if (proposal.state !== 'approved' || proposal.messageId !== id
      || proposal.from !== message.from || proposal.to !== message.to
      || proposal.subject !== message.subject || proposal.body !== message.body
      || (proposal.replyTo || null) !== (message.replyTo || null)
      || proposal.exchange !== message.authorization.exchange) {
    console.error(`request ${id} does not match its approved proposal`);
    return 1;
  }
  const resolved = exchangeFor(repos, proposal.from, proposal.exchange);
  const problem = resolved ? validateExchange(repos, resolved.source, resolved.exchange) : 'declared exchange no longer exists';
  if (problem) {
    console.error(`request ${id} is no longer authorized: ${problem}`);
    return 1;
  }
  const currentRecipe = recipeSnapshot(resolved.exchange);
  const currentDigest = recipeDigest(currentRecipe);
  if (proposal.recipeDigest !== currentDigest
      || message.authorization.recipeDigest !== currentDigest
      || message.authorization.permission !== currentRecipe.permission
      || JSON.stringify(proposal.recipe) !== JSON.stringify(currentRecipe)) {
    console.error(`request ${id} is stale because its exchange authority changed`);
    return 1;
  }
  console.log(JSON.stringify({ ok: true, message, proposal, recipe: currentRecipe }, null, 2));
  return 0;
}

function context(repos) {
  const id = option('repo');
  const current = safeRepoId(id) ? findRepo(repos, id) : null;
  if (!current) {
    console.error('context requires --repo matching a verified manifest');
    return 1;
  }
  const kinIds = (current.m?.kin || []).map(k => typeof k === 'object' ? k.repo : String(k));
  const kin = kinIds.map(kinId => {
    const related = findRepo(repos, kinId);
    const exchanges = (current.m?.exchanges || []).filter(exchange =>
      exchange && typeof exchange === 'object' && exchange.with === kinId);
    return related
      ? { repo: repoId(related), is: related.m?.is, provides: related.m?.provides || [], exchanges }
      : { repo: kinId, unavailable: true, exchanges };
  });
  console.log(JSON.stringify({
    protocol: 'repo-connect/agent-context/v1',
    generatedAt: new Date().toISOString(),
    repo: { id: repoId(current), path: current.dir, manifest: current.m },
    kin,
    inbox: readInbox(repoId(current)),
    proposals: readProposals(repoId(current)).filter(proposal => proposal.state === 'proposed'),
  }, null, 2));
  return 0;
}

function status(repos) {
  const id = option('repo');
  const current = safeRepoId(id) ? findRepo(repos, id) : null;
  if (!current) {
    console.error('status requires --repo matching a manifest');
    return 1;
  }

  const manifest = {
    present: true,
    identityMatchesFolder: current.m?.repo === current.name || current.isRoot === true,
    purposeDeclared: typeof current.m?.is === 'string' && current.m.is.length > 0,
    kinDeclared: Array.isArray(current.m?.kin),
  };
  manifest.valid = manifest.identityMatchesFolder && manifest.purposeDeclared && manifest.kinDeclared;

  const instructions = {
    agents: fs.existsSync(path.join(current.dir, 'AGENTS.md')),
    claude: fs.existsSync(path.join(current.dir, 'CLAUDE.md')),
  };
  const assigned = manifest.valid && (instructions.agents || instructions.claude);
  const presence = readPresence(repoId(current));
  const result = {
    repo: repoId(current),
    role: 'repo-rep',
    path: current.dir,
    assigned,
    manifest,
    instructions,
    capabilities: (current.m?.provides || []).length,
    connections: (current.m?.kin || []).length,
    exchanges: (current.m?.exchanges || []).length,
    pendingProposals: readProposals(repoId(current)).filter(proposal => proposal.state === 'proposed').length,
    openMessages: readInbox(repoId(current)).length,
    presence,
    runtime: presence.proactive
      ? `watcher lease active; rep is ${presence.state}`
      : 'no live watcher lease; run or watch the rep when work is requested',
  };

  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2));
    return assigned ? 0 : 1;
  }

  console.log(`${assigned ? `${C.g}✓${C.x}` : `${C.r}✗${C.x}`} ${result.repo}: repo rep ${assigned ? 'assigned' : 'not ready'}`);
  console.log(`  manifest: ${manifest.valid ? 'valid' : 'incomplete or mismatched'}`);
  console.log(`  instructions: ${[
    instructions.agents ? 'AGENTS.md' : null,
    instructions.claude ? 'CLAUDE.md' : null,
  ].filter(Boolean).join(', ') || 'none'}`);
  console.log(`  capabilities: ${result.capabilities}`);
  console.log(`  connections: ${result.connections}`);
  console.log(`  executable exchanges: ${result.exchanges}`);
  console.log(`  pending proposals: ${result.pendingProposals}`);
  console.log(`  open messages: ${result.openMessages}`);
  console.log(`  presence: ${presence.state}${presence.proactive ? ' (proactive)' : ''}`);
  console.log(`  runtime: ${result.runtime}`);
  return assigned ? 0 : 1;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPresence(repo) {
  const presencePath = path.join(PRESENCE_ROOT, `${repo}.json`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(presencePath, 'utf8')); }
  catch {
    return { state: 'offline', proactive: false, proof: 'no watcher lease' };
  }

  const heartbeat = Date.parse(raw.heartbeatAt || '');
  const leaseMs = Number(raw.leaseMs || 15000);
  const fresh = Number.isFinite(heartbeat) && Date.now() - heartbeat <= leaseMs;
  const watcherLive = processAlive(Number(raw.watcherPid || raw.pid));
  const workerLive = raw.state === 'working' && processAlive(Number(raw.pid));
  let watcherLease = null;
  try {
    watcherLease = JSON.parse(fs.readFileSync(
      path.join(ROOT, '.repo-connect', 'watchers', `${repo}.json`, 'owner.json'),
      'utf8',
    ));
  } catch {}
  const leaseHeartbeat = Date.parse(watcherLease?.heartbeatAt || watcherLease?.claimedAt || '');
  const leaseFresh = Number.isFinite(leaseHeartbeat) && Date.now() - leaseHeartbeat <= leaseMs;
  const leaseMatches = typeof raw.leaseId === 'string'
    && raw.leaseId === watcherLease?.ownerToken
    && Number(raw.watcherPid || raw.pid) === Number(watcherLease?.pid);
  const proactive = raw.proactive === true && watcherLive && leaseMatches && leaseFresh && (fresh || workerLive);
  if (!proactive && raw.state !== 'working') {
    return {
      state: 'offline',
      proactive: false,
      lastState: raw.state,
      lastSeenAt: raw.heartbeatAt || null,
      lastOutcome: raw.lastOutcome || null,
      proof: fresh ? 'watcher process is not live' : 'watcher lease expired',
    };
  }

  if (raw.state === 'working' && !workerLive) {
    return {
      state: proactive ? 'blocked' : 'offline',
      proactive,
      lastSeenAt: raw.heartbeatAt || null,
      messageId: raw.messageId || null,
      proof: 'worker process is not live',
    };
  }

  return {
    state: raw.state || 'idle',
    proactive,
    pid: Number(raw.pid) || null,
    watcherPid: Number(raw.watcherPid) || null,
    since: raw.since || null,
    lastSeenAt: raw.heartbeatAt || null,
    messageId: raw.messageId || null,
    lastOutcome: raw.lastOutcome || null,
    proof: proactive
      ? (fresh ? 'live local PID and fresh watcher lease' : 'live watcher and worker PIDs during active request')
      : 'live one-shot worker',
  };
}

function help() {
  console.log(`repos.chat commands:
  repos verify  --root DIR
  repos status  --root DIR --repo REPO [--json]
  repos graph   --root DIR [--depth N]
  repos sync    --root DIR
  repos trigger --root DIR --from REPO --exchange ID --event EVENT --subject TEXT --body TEXT
                [--reply-to MESSAGE_ID]   continue a conversation with a follow-up request
  repos proposals --root DIR [--repo REPO] [--json] [--all]
  repos approve --root DIR --id PROPOSAL_ID --approve PROPOSAL_ID:DIGEST_PREFIX
  repos send    --root DIR --from REPO --to REPO --kind response|notice --subject TEXT --body TEXT
                [--reply-to ID] [--conversation-id ID] [--state STATE] [--host NAME --model MODEL]
  repos inbox   --root DIR --repo REPO [--json] [--all]
  repos ack     --root DIR --repo REPO --id MESSAGE_ID
  repos context --root DIR --repo REPO
  repos conversation --root DIR --id MESSAGE_OR_CONVERSATION_ID [--json]
  repos sent    --root DIR --repo REPO [--json] [--all]   queued, seen, or acked
  repos focus   --root DIR [--repo REPO] [--stale-days N] [--json]
  repos hook claude --root DIR --repo REPO [--agent AGENT] [--shared] [--remove]
  repos mcp install --root DIR --repo REPO [--shared]
  repos identity init --agent ID [--file PATH]
  repos identity show [--file PATH]
  repos relay serve [--data DIR] [--host HOST] [--port PORT] [--store file|memory|sqlite]
  repos relay register [--repo REPO ...] [--webhook URL]
  repos relay send --to agent:ID|session:ID|repo:NAME --subject TEXT --body TEXT
                [--from-repo REPO] [--client-message-id ID] [--reply-to ID]
  repos relay sync [--session ID]
  repos relay watch [--once] [--timeout-ms N] [--session ID] [--claude-print]
                [--on-mail PROGRAM --on-mail-arg ARG]
  repos relay inbox [--session ID] [--all]
  repos relay ack --id CLIENT_MESSAGE_ID [--by HOST] [--session ID]

send also takes --expires-in 7d, --expires-at ISO_TIME, and
--client-message-id so a retry is the same message. inbox, sent, and focus
flag messages open 7+ days (--stale-days N) and expired ones. inbox --mark-seen
records a seen receipt. ack --by and --session record who acknowledged.

Relay commands need REPOS_RELAY_URL and REPOS_RELAY_TOKEN. Identity comes from
REPOS_AGENT_ID plus REPOS_AGENT_PRIVATE_KEY, or from the user profile key file.
The relay carries notices and responses. Work requests still need local human
approval. repos relay serve refuses to listen off loopback without TLS.

An assigned Repo Rep has a valid repos.yaml identity and at least one local
instruction file. A live watcher lease makes it proactive and observable.
Recipe triggers create proposals, never messages. Only an exact approve command
delivers proposed work. Use repos-agent watch --root DIR --repo REPO to keep it awake,
repos-agent hosts to see which models (codex, claude, grok) can answer, and
repos-mcp --root DIR --as REPO to give a live agent session these as tools.`);
  return 0;
}

/* ---------- run ---------------------------------------------------------- */
if (cmd === 'help' || cmd === '--help' || hasFlag('help')) {
  process.exit(help());
}
if (cmd === 'identity') {
  process.exit(runIdentity(args, { packageRoot: HERE, workspace: path.resolve(ROOT) }));
}
if (cmd === 'relay') {
  // Set exitCode instead of calling process.exit(): exiting while fetch sockets are
  // still closing aborts Node on Windows (libuv UV_HANDLE_CLOSING, exit 0xC0000409).
  process.exitCode = await runRelay(args, {
    packageRoot: HERE,
    workspace: path.resolve(ROOT),
    importRepoMessage: importRelayMessage,
  });
} else {
  const repos = findManifests(ROOT, DEPTH);
  if (!repos.length) {
    console.log(`no repos.yaml found under ${ROOT}`);
    process.exit(0);
  }
  if (!['send', 'inbox', 'ack', 'context', 'status', 'graph', 'trigger', 'proposals', 'approve', 'validate-request', 'conversation', 'sent', 'focus', 'hook', 'mcp'].includes(cmd)) {
    console.log(`${C.d}${repos.length} manifests under ${ROOT}${C.x}\n`);
  }
  const code = cmd === 'sync' ? sync(repos)
    : cmd === 'graph' ? graph(repos)
    : cmd === 'send' ? send(repos)
    : cmd === 'inbox' ? inbox(repos)
    : cmd === 'ack' ? acknowledge(repos)
    : cmd === 'validate-request' ? validateRequest(repos)
    : cmd === 'trigger' ? trigger(repos)
    : cmd === 'proposals' ? listProposals(repos)
    : cmd === 'approve' ? approve(repos)
    : cmd === 'context' ? context(repos)
    : cmd === 'conversation' ? conversation()
    : cmd === 'sent' ? sentMessages(repos)
    : cmd === 'focus' ? focus(repos)
    : cmd === 'hook' ? installClaudeHook(repos)
    : cmd === 'mcp' ? installMcp(repos)
    : cmd === 'status' ? status(repos)
    : verify(repos);
  process.exit(code);
}
