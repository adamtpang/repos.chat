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
//
// Why this exists: a manifest that points an agent at code which does not exist is
// worse than no manifest at all. Claims rot silently. This makes them fail loudly.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

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
const PRESENCE_ROOT = path.join(ROOT, '.repo-connect', 'presence');
const PROPOSAL_ROOT = path.join(ROOT, '.repo-connect', 'proposals');
const APPROVAL_ROOT = path.join(ROOT, '.repo-connect', 'approvals');
const GITHUB_ROOT = path.join(ROOT, '.repo-connect', 'github');
const MESSAGE_KINDS = new Set(['request', 'response', 'notice']);
const TRIGGERS = new Set(['manual', 'webhook', 'ci', 'contract-drift']);
const PERMISSIONS = new Set(['read-only', 'propose-change', 'branch-pr']);

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

function writeJsonAtomic(dest, value) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, dest);
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

function ensureQueue(repo) {
  const queueDir = path.join(QUEUE_ROOT, repo);
  if (fs.existsSync(queueDir)) return queueDir;
  fs.mkdirSync(queueDir, { recursive: true });
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
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const fd = fs.openSync(dest, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
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
    metadata: {
      proposalId: id,
      exchange: proposal.exchange,
      permission: currentRecipe.permission,
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

  const requestedId = input.id || null;
  if (requestedId && !safeMessageId(requestedId)) return { ok: false, error: 'message id contains unsupported characters' };
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:.]/g, '');
  const id = requestedId || `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
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
    ...(input.metadata ? { authorization: input.metadata } : {}),
  };
  const dest = messagePath(to, id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const fd = fs.openSync(dest, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(message, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') return { ok: false, error: `could not deliver message: ${error.message}` };
    let existing;
    try { existing = JSON.parse(fs.readFileSync(dest, 'utf8')); }
    catch { return { ok: false, error: `message id already exists but is unreadable: ${id}` }; }
    const same = ['id', 'from', 'to', 'kind', 'subject', 'body', 'replyTo', 'conversationId']
      .every(key => (existing[key] ?? null) === (message[key] ?? null))
      && JSON.stringify(existing.authorization || null) === JSON.stringify(message.authorization || null);
    if (!same) return { ok: false, error: `message id already exists with different content: ${id}` };
    if (!existing.acknowledgedAt) {
      writeJsonAtomic(queuePath(existing.to, existing.id), { id: existing.id, to: existing.to });
    }
    return { ok: true, message: existing, reused: true };
  }
  writeJsonAtomic(queuePath(to, id), { id, to });
  return { ok: true, message };
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
    id: process.env.REPOS_CHAT_AGENT_HOST === '1'
      ? process.env.REPOS_CHAT_INTERNAL_MESSAGE_ID || null
      : null,
  });
  if (!delivered.ok) {
    console.error(delivered.error);
    return 1;
  }
  console.log(JSON.stringify(delivered, null, 2));
  return 0;
}

function inbox(repos) {
  const repo = option('repo');
  if (!safeRepoId(repo) || !findRepo(repos, repo)) {
    console.error('inbox requires --repo matching a verified manifest');
    return 1;
  }
  const messages = readInbox(repo, hasFlag('all'));
  if (hasFlag('json')) {
    console.log(JSON.stringify({ repo, messages }, null, 2));
    return 0;
  }
  if (!messages.length) {
    console.log(`no ${hasFlag('all') ? '' : 'open '}messages for ${repo}`);
    return 0;
  }
  for (const message of messages) {
    const state = message.acknowledgedAt ? 'acknowledged' : 'open';
    console.log(`${message.id}  ${message.kind}  ${state}  from ${message.from}`);
    console.log(`    ${message.subject}`);
  }
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
  if (!message.acknowledgedAt) message.acknowledgedAt = new Date().toISOString();
  const temp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(message, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, dest);
  try { fs.unlinkSync(queuePath(repo, id)); } catch {}
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
  repos proposals --root DIR [--repo REPO] [--json] [--all]
  repos approve --root DIR --id PROPOSAL_ID --approve PROPOSAL_ID:DIGEST_PREFIX
  repos send    --root DIR --from REPO --to REPO --kind response|notice --subject TEXT --body TEXT
  repos inbox   --root DIR --repo REPO [--json] [--all]
  repos ack     --root DIR --repo REPO --id MESSAGE_ID
  repos context --root DIR --repo REPO

An assigned Repo Rep has a valid repos.yaml identity and at least one local
instruction file. A live watcher lease makes it proactive and observable.
Recipe triggers create proposals, never messages. Only an exact approve command
delivers proposed work. Use repos-agent watch --root DIR --repo REPO to keep it awake.`);
  return 0;
}

/* ---------- run ---------------------------------------------------------- */
if (cmd === 'help' || cmd === '--help' || hasFlag('help')) {
  process.exit(help());
}
const repos = findManifests(ROOT, DEPTH);
if (!repos.length) {
  console.log(`no repos.yaml found under ${ROOT}`);
  process.exit(0);
}
if (!['send', 'inbox', 'ack', 'context', 'status', 'graph', 'trigger', 'proposals', 'approve', 'validate-request'].includes(cmd)) {
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
  : cmd === 'status' ? status(repos)
  : verify(repos);
process.exit(code);
