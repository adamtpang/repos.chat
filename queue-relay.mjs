// Adapter to supported Codex desktop tools supplied by an active tool-capable task.
// This module cannot obtain desktop privileges by itself. It never creates sessions.
import { snapshot } from './queue-store.mjs';

export async function refresh(queue, tools, threadId, repository) {
  const read = await tools.mcp__codex_app__read_thread({ threadId, hostId: 'local', turnLimit: 8, includeOutputs: true, maxOutputCharsPerItem: 12000 });
  return queue.ingest(snapshot(read, repository));
}
export async function dispatchApproved(queue, tools, requestId, senderThreadId = null) {
  const request = queue.state().requests.find(r => r.id === requestId);
  if (!request || request.status !== 'approved') throw new Error('No unattempted approved request');
  const card = queue.state().cards.find(c => c.id === request.cardId);
  await refresh(queue, tools, request.threadId, card.checkout.root);
  const call = queue.claim(requestId);
  // No retry around this call. Failure, timeout, and process death remain uncertain.
  const response = await tools.mcp__codex_app__send_message_to_thread(call.arguments);
  queue.recordResponse(requestId, call.receiptId, response, senderThreadId);
  await recover(queue, tools, requestId);
  return queue.state().requests.find(r => r.id === requestId);
}
export async function recover(queue, tools, requestId) {
  const r = queue.state().requests.find(x => x.id === requestId);
  if (!r || !['uncertain', 'accepted'].includes(r.status)) throw new Error('No attempted request');
  const read = await tools.mcp__codex_app__read_thread({ threadId: r.threadId, hostId: r.hostId, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 });
  queue.reconcile(requestId, read);
  const card = queue.state().cards.find(x => x.id === r.cardId);
  queue.ingest(snapshot(read, card.checkout.root));
}
