#!/usr/bin/env node
// repos.mjs — verify and sync the repos.yaml protocol.
// No dependencies. Node 18+.
//
//   node repos.mjs verify [--root DIR]   check every manifest's claims against real code
//   node repos.mjs sync   [--root DIR]   detect drift in shared canon files across kin
//   node repos.mjs graph  [--root DIR]   emit the repo graph as JSON
//
// Why this exists: a manifest that points an agent at code which does not exist is
// worse than no manifest at all. Claims rot silently. This makes them fail loudly.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const args = process.argv.slice(2);
const cmd = args[0] || 'verify';
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx > -1 ? args[rootIdx + 1] : process.cwd();
const depthIdx = args.indexOf('--depth');
// Default 1 matches the tool's original behavior exactly: only immediate
// subdirectories of --root are scanned. Raise it to see a hub manifest
// (e.g. Aether/repos.yaml) and nested project manifests in one run.
const DEPTH = depthIdx > -1 ? parseInt(args[depthIdx + 1], 10) : 1;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.vercel']);

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
// hub-level manifest (Aether/repos.yaml) and nested project manifests can
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
  // workspace, e.g. Aether/repos.yaml) -- previously never checked, only
  // its subdirectories were.
  const hubPath = path.join(root, 'repos.yaml');
  if (fs.existsSync(hubPath)) {
    const name = path.basename(path.resolve(root));
    try { found.push({ dir: root, name, m: parseManifest(fs.readFileSync(hubPath, 'utf8')) }); }
    catch (err) { found.push({ dir: root, name, err: err.message }); }
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
    if (m.repo && m.repo !== r.name) problems.push(`repo field "${m.repo}" != folder "${r.name}"`);

    for (const p of (m.provides || [])) {
      const id = typeof p === 'object' ? (p.id || Object.keys(p)[0]) : String(p).split(':')[0];
      const at = typeof p === 'object' ? p.at : null;
      if (!at) { notes.push(`${id}: no evidence path (add "at:")`); unverified++; continue; }
      if (fs.existsSync(path.join(r.dir, at))) { confirmed++; }
      else { problems.push(`${id}: claims ${at}, which does not exist`); broken++; }
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
  const nodes = repos.map(r => ({
    id: r.name, is: r.m?.is, cluster: r.m?.cluster, ranks: r.m?.ranks,
    stack: r.m?.stack || [],
    provides: (r.m?.provides || []).map(p => typeof p === 'object' ? (p.id || Object.keys(p)[0]) : String(p).split(':')[0]),
  }));
  const edges = [];
  for (const r of repos)
    for (const k of (r.m?.kin || [])) {
      const to = typeof k === 'object' ? k.repo : String(k);
      edges.push({ from: r.name, to, why: typeof k === 'object' ? k.why : null });
    }
  console.log(JSON.stringify({ nodes, edges }, null, 2));
  return 0;
}

/* ---------- run ---------------------------------------------------------- */
const repos = findManifests(ROOT, DEPTH);
if (!repos.length) {
  console.log(`no repos.yaml found under ${ROOT}`);
  process.exit(0);
}
console.log(`${C.d}${repos.length} manifests under ${ROOT}${C.x}\n`);
const code = cmd === 'sync' ? sync(repos) : cmd === 'graph' ? graph(repos) : verify(repos);
process.exit(code);
