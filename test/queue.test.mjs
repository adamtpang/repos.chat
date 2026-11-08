import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { Queue, snapshot, gitBin } from '../queue-store.mjs';
import { dispatchApproved, recover } from '../queue-relay.mjs';
import { serve } from '../queue-server.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
  execFileSync(gitBin, ['init', '-q', root]);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const queue = new Queue(root);
  const read = (runtime = 'idle', turnId = 'original', status = 'completed', text = 'Tests passed; choose the next change.') => ({
    thread: { id: 'existing-task', kind: 'codex', hostId: 'local', title: 'Fictional orchard', cwd: root, status: { type: runtime }, updatedAt: Date.now()/1000 },
    page: { order: 'newest_first' },
    turns: [{ id: turnId, status, startedAt: Math.floor(Date.now()/1000), completedAt: status === 'completed' ? Math.floor(Date.now()/1000) : null, items: [{ type: 'agentMessage', phase: 'final_answer', text }] }],
  });
  const card = queue.ingest(snapshot(read(), root));
  const draft = () => queue.draft(card.id, { prompt: 'Please report the next local step only.', decision: 'Request a read-only next step?', importance: 2, urgency: 1, reason: 'Unblocks a local design decision', dependencies: [] });
  const approve = () => { const d = draft(); return queue.approve(card.id, d.id, d.prompt, card.threadId); };
  return { root, queue, read, card, draft, approve };
}
test('same-session round trip: draft is inert, exact approval, one send, receipt, result review', async t => {
  const f = fixture(t); let sends = 0, delivered = false;
  const tools = {
    mcp__codex_app__read_thread: async ({ threadId }) => {
      assert.equal(threadId, 'existing-task');
      const read = f.read(delivered ? 'active' : 'idle', delivered ? 'reply-turn' : 'original', delivered ? 'inProgress' : 'completed');
      if (delivered) read.turns[0].items.unshift({ type: 'userMessage', content: [{ type: 'text', text: 'Please report the next local step only.' }] });
      return read;
    },
    mcp__codex_app__send_message_to_thread: async args => { assert.deepEqual(args, { threadId: 'existing-task', hostId: 'local', prompt: 'Please report the next local step only.' }); sends++; delivered = true; return { delivered: true }; },
  };
  const d = f.draft(); assert.equal(sends, 0);
  assert.throws(() => f.queue.approve(f.card.id, d.id, 'changed', f.card.threadId), /Exact/);
  const r = f.queue.approve(f.card.id, d.id, d.prompt, f.card.threadId);
  assert.equal(f.queue.approve(f.card.id, d.id, d.prompt, f.card.threadId).id, r.id);
  const receipt = await dispatchApproved(f.queue, tools, r.id);
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.turnId, 'reply-turn'); assert.ok(receipt.receiptId);
  assert.equal(f.queue.view().cards[0].delivery, 'awaiting results');
  await assert.rejects(dispatchApproved(f.queue, tools, r.id), /unattempted/); assert.equal(sends, 1);
  f.queue.ingest(snapshot(f.read('idle', 'reply-turn', 'completed', 'Read-only result.'), f.root));
  const view = new Queue(f.root).view(); assert.equal(view.current.returned, true); assert.equal(view.current.delivery, null);
  assert.equal(view.current.state, 'completed'); assert.equal(view.current.goalComplete, undefined);
  f.queue.ingest(snapshot(f.read('idle','later-owner-turn','completed','A later result.'),f.root));
  assert.equal(f.queue.view().cards[0].delivery,null,'A verified completed receipt cannot become pending again after later owner work');
});
test('lost response is uncertain across restart; read-back recovers without a resend', async t => {
  const f = fixture(t); const r = f.approve(); let count = 0;
  const tools = { mcp__codex_app__read_thread: async () => f.read(), mcp__codex_app__send_message_to_thread: async () => { count++; throw new Error('lost transport'); } };
  await assert.rejects(dispatchApproved(f.queue, tools, r.id), /lost/);
  const restarted = new Queue(f.root);
  assert.equal(restarted.state().requests[0].status, 'uncertain');
  await assert.rejects(dispatchApproved(restarted, tools, r.id), /unattempted/);
  const evidence = f.read('idle', 'delivered-turn'); evidence.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: r.prompt }] });
  await recover(restarted, { mcp__codex_app__read_thread: async () => evidence }, r.id);
  assert.equal(restarted.state().requests[0].turnId, 'delivered-turn'); assert.equal(count, 1);
});
test('active, stale, changed and unsupported sessions cannot dispatch', async t => {
  const f = fixture(t); const r = f.approve(); let sends = 0;
  await assert.rejects(dispatchApproved(f.queue, { mcp__codex_app__read_thread: async () => f.read('active'), mcp__codex_app__send_message_to_thread: async () => sends++ }, r.id), /running/);
  assert.equal(sends, 0);
  const stale = snapshot(f.read(), f.root, new Date(Date.now()-120000).toISOString());
  assert.throws(() => f.queue.ingest(stale), /Out-of-order/);
  const other = f.read(); other.thread.kind = 'grok'; assert.throws(() => snapshot(other, f.root), /Only local Codex/);
  const changed = snapshot(f.read('idle', 'another-turn'), f.root); f.queue.ingest(changed);
  assert.throws(() => f.queue.claim(r.id), /changed/);
});
test('identity uses verified Git common directory and exact checkout, never title', t => {
  const f = fixture(t); const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-other-'));
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  execFileSync(gitBin, ['init', '-q', foreign]);
  assert.throws(() => snapshot(f.read(), foreign), /different repository/);
  execFileSync(gitBin, ['-C', f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'fixture']);
  const worktree = path.join(f.root, 'worktree');
  execFileSync(gitBin, ['-C', f.root, 'worktree', 'add', '--detach', worktree], { stdio: 'pipe' });
  const read = f.read(); read.thread.cwd = worktree;
  const c = snapshot(read, f.root); assert.equal(c.checkout.common, f.card.checkout.common); assert.notEqual(c.checkout.cwd, f.card.checkout.cwd);
});
test('uncertain delivery rejects unrelated, old, ambiguous or wrong-destination read-back', t => {
  const f = fixture(t), r = f.approve(); f.queue.claim(r.id);
  assert.throws(() => f.queue.reconcile(r.id, f.read()), /uncertain/);
  const wrong = f.read(); wrong.thread.id = 'other'; assert.throws(() => f.queue.reconcile(r.id, wrong), /Wrong destination/);
  const ambiguous = f.read('idle', 'new-turn'); ambiguous.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: r.prompt }] });
  ambiguous.turns.push({ ...ambiguous.turns[0], id: 'second-turn' }); assert.throws(() => f.queue.reconcile(r.id, ambiguous), /uncertain/);
  assert.throws(() => f.queue.claim(r.id), /blindly resend/);
});
test('ranking respects stated priority and unresolved dependencies; all cards remain accessible', t => {
  const f = fixture(t); const read = f.read(); read.thread.id = 'dependency';
  const other = f.queue.ingest(snapshot(read, f.root));
  f.queue.draft(other.id, { prompt: 'Inspect', decision: 'Inspect?', importance: 1, urgency: 1, reason: 'Prerequisite', dependencies: [] });
  const d = f.queue.draft(f.card.id, { prompt: 'Continue', decision: 'Continue?', importance: 3, urgency: 3, reason: 'Important but blocked', dependencies: [other.id] });
  assert.equal(f.queue.view().current.id, other.id); assert.equal(f.queue.view().cards.length, 2);
  assert.throws(() => f.queue.approve(f.card.id, d.id, d.prompt, f.card.threadId), /Dependencies/);
});
test('concurrent claim and stale crash lock fail closed', t => {
  const f = fixture(t), r = f.approve(); f.queue.claim(r.id);
  assert.throws(() => new Queue(f.root).claim(r.id), /Already attempted/);
  fs.writeFileSync(path.join(f.queue.root, 'write.lock'), '{"pid":0}');
  assert.throws(() => f.draft(), /locked/);
});
test('stale approvals can be withdrawn, but attempted deliveries cannot', t => {
  const f = fixture(t), r = f.approve(); f.queue.cancel(r.id);
  assert.equal(f.queue.view().cards[0].delivery, null);
  const next = f.approve(); f.queue.claim(next.id);
  assert.throws(() => f.queue.cancel(next.id), /unattempted/);
});
test('unloaded terminal tasks can continue; unloaded in-progress and unknown tasks cannot', t => {
  const f = fixture(t);
  f.queue.ingest(snapshot(f.read('notLoaded'), f.root));
  assert.equal(f.queue.view().current.canContinue, true);
  const r = f.approve(); assert.equal(f.queue.claim(r.id).arguments.threadId, 'existing-task');
  f.queue.ingest(snapshot(f.read('notLoaded', 'unfinished', 'inProgress'), f.root));
  assert.equal(f.queue.view().cards[0].canContinue, false);
  f.queue.ingest(snapshot(f.read('systemError'), f.root));
  assert.equal(f.queue.view().cards[0].canContinue, false);
});
test('earlier visible result keeps its own provenance and parked cards never get prompted', t => {
  const f = fixture(t), d = f.read();
  d.turns.unshift({ ...d.turns[0], id: 'latest', items: [] });
  const card = f.queue.ingest(snapshot(d, f.root));
  assert.equal(card.turnId, 'latest'); assert.equal(card.resultTurnId, 'original'); assert.match(card.resultKind, /earlier/);
  f.queue.triage(card.id, { disposition: 'parked', nextAction: 'Wait for new direction', importance: 0, urgency: 0, reason: 'Explicit owner hold' });
  assert.equal(f.queue.view().current, null);
  assert.throws(() => f.approve(), /Parked/);
});
test('actual desktop delegation receipt binds source task, exact text and untruncated output', t => {
  const f = fixture(t), r = f.approve(), claim = f.queue.claim(r.id);
  f.queue.recordResponse(r.id, claim.receiptId, { threadId: r.threadId }, 'relay-task');
  const read = f.read('idle', 'delivered-turn');
  const item = { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: `<codex_delegation>\n  <source_thread_id>wrong-task</source_thread_id>\n  <input>${r.prompt}</input>\n</codex_delegation>`, truncated: false } };
  read.turns[0].items.push(item);
  assert.throws(() => f.queue.reconcile(r.id, read), /uncertain/);
  item.output.text = item.output.text.replace('wrong-task', 'relay-task'); item.output.truncated = true;
  assert.throws(() => f.queue.reconcile(r.id, read), /uncertain/);
  item.output.truncated = false;
  f.queue.reconcile(r.id, read);
  assert.equal(f.queue.state().requests[0].turnId, 'delivered-turn');
  read.thread.status = { type: 'systemError' }; read.turns[0].status = 'failed'; read.turns[0].error = { message: 'Blocked by provider' };
  f.queue.ingest(snapshot(read, f.root));
  assert.equal(f.queue.view().current.returned, true);
  assert.equal(f.queue.view().current.error, 'Blocked by provider');
});
test('local server protects data and approval against missing token, foreign origin and paths', async t => {
  const f = fixture(t), server = await serve(f.queue, 0); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, auth = { Authorization: `Bearer ${server.queueToken}` };
  assert.equal((await fetch(base+'/api/queue')).status, 401);
  assert.equal((await fetch(base+'/api/queue', { headers: { ...auth, Origin: 'https://hostile.example' } })).status, 403);
  const hostileHostStatus = await new Promise(resolve => http.get(base+'/api/queue', { headers: { ...auth, Host: 'hostile.example' } }, res => { res.resume(); resolve(res.statusCode); }));
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(base+'/.repo-connect/queue/00000001.json', { headers: auth })).status, 404);
  const response = await fetch(base+'/api/queue', { headers: auth }); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).cards.length, 1);
  const d = f.draft();
  const options = { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ cardId: f.card.id, draftId: d.id, prompt: d.prompt, destination: f.card.threadId }) };
  assert.equal((await fetch(base+'/api/approve', { ...options, headers: auth })).status, 403);
  assert.equal((await fetch(base+'/api/approve', options)).status, 200);
  assert.equal(f.queue.state().requests[0].status, 'approved');
});
