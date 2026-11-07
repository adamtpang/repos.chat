// Private, local event journal. No provider calls and no network side effects.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Resolve an executable, not a shell command (Windows npm can supply both Path and PATH).
export const gitBin = process.env.REPOS_GIT_BIN || (process.platform === 'win32'
  ? Object.entries(process.env).filter(([k]) => k.toLowerCase() === 'path').flatMap(([,v]) => v.split(';')).map(dir => path.join(dir.replace(/^"|"$/g, ''), 'git.exe')).find(p => fs.existsSync(p)) || 'git.exe'
  : 'git');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const stamp = () => new Date().toISOString();
export const canContinue = card => ['idle', 'notLoaded'].includes(card.runtime) && ['completed', 'failed', 'interrupted'].includes(card.turnStatus);
export function unwrap(value) {
  if (value?.isError) throw new Error('Codex tool returned an error');
  if (value?.content) return JSON.parse(value.content.find(x => x.type === 'text').text);
  return value;
}
export function checkout(cwd) {
  const git = (...args) => execFileSync(gitBin, ['-C', cwd, 'rev-parse', ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const root = fs.realpathSync(git('--show-toplevel'));
  const common = fs.realpathSync(path.resolve(cwd, git('--git-common-dir')));
  return { root, common, cwd: fs.realpathSync(cwd) };
}
export function snapshot(raw, expectedCheckout, observedAt = stamp()) {
  const data = unwrap(raw), thread = data.thread;
  assert(['codex', 'claude'].includes(thread?.kind) && thread.hostId === 'local', 'Only local Codex tasks and Claude Code sessions are supported');
  const verified = checkout(thread.cwd), expected = checkout(expectedCheckout);
  assert(verified.common === expected.common, 'Session belongs to a different repository');
  assert(data.page?.order === 'newest_first', 'Expected supported read_thread newest-first response');
  const latest = data.turns?.[0];
  const runtime = thread.status?.type || thread.status;
  const flags = thread.status?.activeFlags || [];
  const resultTurn = (data.turns || []).find(t => t.items?.some(x => x.type === 'agentMessage' && ['final_answer', 'final'].includes(x.phase)));
  const result = [...(resultTurn?.items || [])].reverse().find(x => x.type === 'agentMessage' && ['final_answer', 'final'].includes(x.phase));
  const progress = result || [...(latest?.items || [])].reverse().find(x => x.type === 'agentMessage');
  const state = runtime === 'active' ? (flags.length ? 'needs decision' : 'running') : latest?.status === 'inProgress' ? 'running'
    : ['idle','notLoaded'].includes(runtime) && ['completed','failed','interrupted'].includes(latest?.status) ? (latest.status === 'completed' ? 'completed' : 'waiting') : 'unknown';
  const sourceTimestamp = latest?.completedAt || latest?.startedAt || thread.updatedAt;
  const card = {
    id: `${thread.kind}:${thread.hostId}:${thread.id}`, provider: `${thread.kind}-desktop`, threadId: thread.id,
    hostId: thread.hostId, title: thread.title, checkout: verified,
    state, runtime, sourceTimestamp: sourceTimestamp ? new Date(sourceTimestamp * 1000).toISOString() : null,
    observedAt, turnId: latest?.id || null, turnStatus: latest?.status || 'unknown',
    error: latest?.error?.message || null,
    activeFlags: flags,
    lastPrompt: [...(latest?.items || [])].reverse().find(x => x.type === 'userMessage')?.content?.filter(x => x.type === 'text').map(x => x.text).join('') || null,
    result: progress?.text || 'Latest result unavailable through the source tool.', resultKind: result ? resultTurn.id === latest.id ? 'reported result' : 'earlier reported result — latest text unavailable' : 'reported progress',
    resultTurnId: resultTurn?.id || null, resultTimestamp: resultTurn?.completedAt ? new Date(resultTurn.completedAt * 1000).toISOString() : null,
    source: 'codex_app.read_thread',
  };
  card.revision = digest({ threadId: card.threadId, checkout: verified, runtime, flags, turnId: card.turnId, turnStatus: card.turnStatus, result: resultTurn?.id === latest?.id ? card.result : null });
  return card;
}

export class Queue {
  constructor(root) { this.root = path.resolve(root, '.repo-connect', 'queue'); fs.mkdirSync(this.root, { recursive: true, mode: 0o700 }); }
  events() { return fs.readdirSync(this.root).filter(x => /^\d{8}\.json$/.test(x)).sort().map(x => JSON.parse(fs.readFileSync(path.join(this.root, x), 'utf8'))); }
  state() {
    const cards = {}, requests = {};
    for (const event of this.events()) {
      const p = event.payload;
      if (event.type === 'snapshot') {
        const old = cards[p.id];
        cards[p.id] = { ...old, ...p };
      }
      if (event.type === 'draft') cards[p.cardId].draft = p;
      if (event.type === 'triage') cards[p.cardId].triage = p;
      if (event.type === 'approved') requests[p.id] = { ...p, status: 'approved' };
      if (['claimed', 'cancelled', 'accepted', 'uncertain', 'reconciled', 'toolResponse'].includes(event.type)) Object.assign(requests[p.id], p);
    }
    return { cards: Object.values(cards), requests: Object.values(requests) };
  }
  transact(fn) {
    const lock = path.join(this.root, 'write.lock');
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('Queue locked; inspect owner before manual crash recovery'); throw e; }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: stamp() })); fs.fsyncSync(fd);
    try {
      const events = this.events();
      const append = (type, payload) => {
        const event = { id: randomUUID(), type, at: stamp(), payload };
        const target = path.join(this.root, `${String(events.length + 1).padStart(8, '0')}.json`);
        const temp = `${target}.${randomUUID()}.tmp`;
        const out = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(out, JSON.stringify(event) + '\n'); fs.fsyncSync(out); } finally { fs.closeSync(out); }
        fs.renameSync(temp, target); events.push(event); return event;
      };
      return fn(this.state(), append);
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  ingest(card) {
    return this.transact((state, append) => {
      assert(Number.isFinite(Date.parse(card.observedAt)) && Date.parse(card.observedAt) <= Date.now() + 5000, 'Invalid observation time');
      const old = state.cards.find(x => x.id === card.id);
      assert(!old || card.observedAt >= old.observedAt, 'Out-of-order observation');
      append('snapshot', card);
      for(const request of state.requests){
        if(request.status==='accepted' && request.turnId===card.turnId && ['completed','failed','interrupted'].includes(card.turnStatus))append('reconciled',{id:request.id,receiptTurnStatus:card.turnStatus,receiptObservedAt:card.observedAt});
      }
      return card;
    });
  }
  draft(cardId, input) {
    return this.transact((state, append) => {
      const card = state.cards.find(x => x.id === cardId); assert(card, 'Unknown card');
      assert(typeof input.prompt === 'string' && input.prompt.trim() && input.prompt.length <= 20000, 'Reply must contain 1–20000 characters');
      assert(typeof input.decision === 'string' && input.decision.trim(), 'State the next decision');
      assert([0,1,2,3].includes(input.importance) && [0,1,2,3].includes(input.urgency), 'Priority values must be 0–3');
      assert(input.reason?.trim(), 'Priority needs an explicit reason');
      const dependencies = input.dependencies || [];
      assert(Array.isArray(dependencies) && dependencies.every(id => id !== cardId && state.cards.some(x => x.id === id)), 'Dependencies must name other known cards');
      const draft = { cardId, prompt: input.prompt, decision: input.decision, importance: input.importance, urgency: input.urgency, reason: input.reason, dependencies, revision: card.revision, id: randomUUID() };
      append('draft', draft); return draft;
    });
  }
  triage(cardId, input) {
    return this.transact((state, append) => {
      assert(state.cards.some(c => c.id === cardId), 'Unknown card');
      assert(['ready','needs Adam','external blocker','done','parked'].includes(input.disposition), 'Invalid review disposition');
      assert(input.nextAction?.trim() && input.reason?.trim(), 'Review requires next action and priority reason');
      assert([0,1,2,3].includes(input.importance) && [0,1,2,3].includes(input.urgency), 'Priority values must be 0–3');
      const review = { cardId, disposition: input.disposition, nextAction: input.nextAction, reason: input.reason, importance: input.importance, urgency: input.urgency, evidence: input.evidence || [], reviewedAt: stamp() };
      append('triage', review); return review;
    });
  }
  approve(cardId, draftId, prompt, destination, authority = 'Owner exact-reply UI approval') {
    return this.transact((state, append) => {
      const card = state.cards.find(x => x.id === cardId), d = card?.draft;
      assert(d && d.id === draftId && d.prompt === prompt && card.threadId === destination, 'Exact displayed draft and destination required');
      assert(canContinue(card) && d.revision === card.revision, 'Task changed, running or unknown: refresh and review first');
      assert(!['parked','done'].includes(card.triage?.disposition), 'Parked or done task requires an explicit new review before approval');
      assert(!d.dependencies.length, 'Dependencies unresolved; explicitly review and clear them first');
      const existing = state.requests.find(x => x.cardId === cardId && x.draftId === draftId);
      if (existing) return existing;
      assert(!state.requests.some(x => x.cardId === cardId && x.status !== 'cancelled' && !this.returned(x, card)), 'Existing request awaits delivery/results; no duplicate prompts');
      const request = { id: randomUUID(), cardId, draftId, prompt, threadId: card.threadId, hostId: card.hostId, revision: card.revision, baselineTurnId: card.turnId, approvedAt: stamp(), authority };
      append('approved', request); return { ...request, status: 'approved' };
    });
  }
  returned(request, card) {
    // Only an identified receipt turn may return as a completed result. Recency is not evidence.
    return request.status === 'accepted' && request.turnId && (['completed','failed','interrupted'].includes(request.receiptTurnStatus) || card.turnId === request.turnId && ['completed','failed','interrupted'].includes(card.turnStatus));
  }
  cancel(id) {
    return this.transact((state, append) => {
      assert(state.requests.find(x => x.id === id)?.status === 'approved', 'Only an unattempted approval may be cancelled; uncertain delivery requires read-back');
      append('cancelled', { id, status: 'cancelled', cancelledAt: stamp() });
    });
  }
  claim(id) {
    return this.transact((state, append) => {
      const r = state.requests.find(x => x.id === id); assert(r?.status === 'approved', 'Already attempted or not approved; never blindly resend');
      const card = state.cards.find(x => x.id === r.cardId);
      assert(Date.now() - Date.parse(card.observedAt) < 60000, 'Refresh live task state before relay (60-second limit)');
      assert(canContinue(card) && card.revision === r.revision, 'Destination changed or is running; approval needs review');
      assert(!['parked','done'].includes(card.triage?.disposition), 'Task parked after approval');
      assert(JSON.stringify(checkout(card.checkout.cwd)) === JSON.stringify(card.checkout), 'Checkout identity changed');
      const receiptId = randomUUID();
      append('claimed', { id, status: 'uncertain', receiptId, attemptedAt: stamp() });
      return { requestId: id, receiptId, tool: 'mcp__codex_app__send_message_to_thread', arguments: { threadId: r.threadId, hostId: r.hostId, prompt: r.prompt } };
    });
  }
  recordResponse(id, receiptId, result, senderThreadId = null) {
    return this.transact((state, append) => {
      const r = state.requests.find(x => x.id === id);
      assert(r?.receiptId === receiptId && r.status === 'uncertain', 'No matching uncertain attempt');
      append('toolResponse', { id, rawToolResponse: result, senderThreadId });
    });
  }
  reconcile(id, evidence) {
    return this.transact((state, append) => {
      const r = state.requests.find(x => x.id === id);
      assert(r && ['uncertain','accepted'].includes(r.status), 'No attempted delivery to reconcile');
      const data = unwrap(evidence);
      assert(data.thread?.id === r.threadId && data.thread?.hostId === r.hostId, 'Wrong destination in read-back');
      const card = state.cards.find(x => x.id === r.cardId);
      assert(JSON.stringify(checkout(data.thread.cwd)) === JSON.stringify(card.checkout), 'Checkout changed in delivery read-back');
      const matchesPrompt = item => {
        // Bridged sessions carry the claim's receipt as the message's client ID; text alone is not proof.
        if (item.type === 'userMessage') return (!['codex-app-server', 'claude-session'].includes(data.nativeSource) || item.clientId === r.receiptId) && item.content?.filter(c => c.type === 'text').map(c => c.text).join('') === r.prompt;
        // Desktop task-to-task delivery is a tool-result envelope, not a userMessage.
        if (item.type !== 'functionCallOutput' || item.namespace !== 'codex_app' || item.name !== 'send_message_to_thread' || item.output?.truncated || !r.senderThreadId) return false;
        const match = item.output?.text?.match(/^<codex_delegation>\s*<source_thread_id>([^<]+)<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/);
        return match?.[1] === r.senderThreadId && match[2] === r.prompt;
      };
      const matches = (data.turns || []).filter(t => t.id !== r.baselineTurnId && t.startedAt * 1000 >= Date.parse(r.attemptedAt) - 2000 && t.items?.some(matchesPrompt));
      assert(matches.length === 1, 'Delivery still uncertain: exact prompt must appear in one new destination turn; do not resend');
      append('reconciled', { id, status: 'accepted', turnId: matches[0].id, receiptTurnStatus:matches[0].status, reconciliation: evidence, reconciledAt: stamp() });
    });
  }
  view() {
    const state = this.state();
    const cards = state.cards.map(card => {
      const request = state.requests.filter(x => x.cardId === card.id && x.status !== 'cancelled').at(-1);
      const returned = request && this.returned(request, card);
      const delivery = request && !returned ? request.status === 'accepted' ? 'awaiting results' : request.status === 'uncertain' ? 'delivery uncertain — inspect; do not resend' : 'approved — awaiting Codex relay' : null;
      const draft = card.draft;
      const priority = card.triage || draft;
      return { ...card, request, delivery, returned: !!returned,
        canContinue: canContinue(card),
        attention: !delivery && (returned || (!['running','unknown'].includes(card.state) && !['parked','done'].includes(card.triage?.disposition))),
        priority: priority ? priority.importance * 4 + priority.urgency : 0,
        priorityReason: priority?.reason || 'Untriaged — importance and urgency not inferred',
        blockedBy: draft?.dependencies || [],
      };
    });
    cards.sort((a,b) => Number(b.attention) - Number(a.attention) || Number(!!a.blockedBy.length) - Number(!!b.blockedBy.length) || b.priority - a.priority || a.id.localeCompare(b.id));
    return { cards, requests: state.requests, current: cards.find(x => x.attention) || null, adapter: 'Codex desktop task relay, or the local bridge for bound Codex and Claude Code sessions; refresh and dispatch require an active relay or bridge.' };
  }
}
