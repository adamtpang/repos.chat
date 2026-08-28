#!/usr/bin/env node
// Local, read-only Repo Rep inspector. It never binds beyond loopback.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'repos.mjs');
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index > -1 ? args[index + 1] : null;
};
const root = path.resolve(option('root') || process.cwd());
const depth = option('depth') || '1';
const requestedPort = Number(option('port') || 4777);

function protocol(...protocolArgs) {
  return JSON.parse(execFileSync(process.execPath, [
    cli,
    ...protocolArgs,
    '--root', root,
    '--depth', depth,
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
}

function readMessages() {
  const mailRoot = path.join(root, '.repo-connect', 'mail');
  let inboxes = [];
  try { inboxes = fs.readdirSync(mailRoot, { withFileTypes: true }); } catch { return []; }
  const messages = [];
  for (const inbox of inboxes) {
    if (!inbox.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(mailRoot, inbox.name)); } catch { continue; }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      try {
        const message = JSON.parse(fs.readFileSync(path.join(mailRoot, inbox.name, file), 'utf8'));
        messages.push({
          id: message.id,
          conversationId: message.conversationId || message.id,
          protocol: message.protocol || 'repo-connect/legacy',
          from: message.from,
          to: message.to,
          kind: message.kind,
          subject: message.subject,
          body: message.body,
          createdAt: message.createdAt,
          replyTo: message.replyTo || null,
          acknowledgedAt: message.acknowledgedAt || null,
        });
      } catch {}
    }
  }
  return messages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function snapshot() {
  const graph = protocol('graph');
  const nodes = graph.nodes.map(node => ({
    id: node.id,
    is: node.is,
    cluster: node.cluster || null,
    provides: node.provides,
    assigned: node.assigned,
    openMessages: node.openMessages,
    presence: node.presence,
  }));
  const messages = readMessages();
  return {
    protocol: 'repos.chat/inspector/1',
    generatedAt: new Date().toISOString(),
    summary: {
      repositories: nodes.length,
      assigned: nodes.filter(node => node.assigned).length,
      proactive: nodes.filter(node => node.presence.proactive).length,
      working: nodes.filter(node => node.presence.state === 'working').length,
      openMessages: nodes.reduce((sum, node) => sum + node.openMessages, 0),
      conversations: new Set(messages.map(message => message.conversationId)).size,
    },
    nodes,
    edges: graph.edges,
    messages,
  };
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>repos.chat inspector</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#11151d;--line:#29303e;--muted:#8f9bad;--text:#f3f6fb;--lime:#b8ff6a;--blue:#72a7ff;--amber:#ffc65c;--red:#ff7979}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -20%,#26314a 0,transparent 35%),var(--bg);font:14px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--text)}main{max-width:1280px;margin:auto;padding:32px 24px 64px}header{display:flex;justify-content:space-between;align-items:end;gap:20px}h1{font:700 clamp(28px,5vw,54px)/1 system-ui;margin:0;letter-spacing:-.04em}h1 span{color:var(--lime)}.eyebrow,.muted{color:var(--muted)}.live{display:flex;align-items:center;gap:8px;color:var(--lime)}.dot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 16px currentColor}.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:28px 0}.stat,.panel,.step{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:14px}.stat{padding:14px}.stat b{display:block;font:700 24px system-ui}.stat span{color:var(--muted);font-size:11px;text-transform:uppercase}.flow{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin:18px 0 28px}.step{padding:11px;color:var(--muted);position:relative}.step b{display:block;color:var(--text);margin-bottom:3px}.step:not(:last-child):after{content:'→';position:absolute;right:-10px;top:18px;color:var(--lime);z-index:2}.grid{display:grid;grid-template-columns:1.05fr .95fr;gap:16px}.panel{padding:18px;min-width:0}.panel h2{font:650 16px system-ui;margin:0 0 14px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card{border:1px solid var(--line);border-radius:12px;padding:14px;background:#0d1118}.cardtop{display:flex;justify-content:space-between;gap:8px}.badge{border:1px solid currentColor;border-radius:99px;padding:2px 7px;font-size:10px;text-transform:uppercase}.idle,.awake{color:var(--lime)}.working{color:var(--blue)}.blocked{color:var(--amber)}.offline{color:var(--muted)}.card p{color:var(--muted);min-height:40px}.edges{font-size:12px;color:var(--muted);margin-top:8px}.message{width:100%;text-align:left;color:inherit;background:#0d1118;border:1px solid var(--line);border-radius:12px;padding:12px;margin:0 0 9px;cursor:pointer}.message:hover{border-color:var(--blue)}.route{display:flex;align-items:center;gap:7px;color:var(--blue);font-size:11px}.message strong{display:block;margin:7px 0 4px}.message small{color:var(--muted)}dialog{width:min(760px,calc(100% - 32px));background:#0d1118;color:var(--text);border:1px solid var(--line);border-radius:14px;padding:20px}dialog::backdrop{background:#000b}.close{float:right;background:none;border:0;color:var(--muted);font-size:24px;cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;background:#080a0f;border:1px solid var(--line);border-radius:10px;padding:14px;max-height:55vh;overflow:auto}@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}.flow{grid-template-columns:repeat(2,1fr)}.step:after{display:none}.grid{grid-template-columns:1fr}}@media(max-width:560px){.cards{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}
</style></head>
<body><main><header><div><div class="eyebrow">LOCAL PROTOCOL INSPECTOR</div><h1>repo <span>reps</span></h1></div><div class="live"><i class="dot"></i><span id="updated">connecting</span></div></header>
<section class="stats" id="stats"></section>
<section class="flow"><div class="step"><b>1. Manifest</b>assignment</div><div class="step"><b>2. Lease</b>presence proof</div><div class="step"><b>3. Envelope</b>durable request</div><div class="step"><b>4. Lock</b>one worker</div><div class="step"><b>5. Evidence</b>structured reply</div><div class="step"><b>6. Ack</b>closed request</div></section>
<div class="grid"><section class="panel"><h2>Repository graph</h2><div class="cards" id="nodes"></div></section><section class="panel"><h2>Conversation log</h2><div id="messages"></div></section></div>
</main><dialog id="detail"><button class="close" aria-label="Close">×</button><h2>Protocol envelope</h2><pre></pre></dialog>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let state;
function render(d){state=d;document.querySelector('#updated').textContent='refreshed '+new Date(d.generatedAt).toLocaleTimeString();const labels=[['repositories','repos'],['assigned','assigned'],['proactive','awake'],['working','working'],['openMessages','open mail'],['conversations','threads']];document.querySelector('#stats').innerHTML=labels.map(([k,l])=>'<div class="stat"><b>'+d.summary[k]+'</b><span>'+l+'</span></div>').join('');const nodes=[...d.nodes].sort((a,b)=>Number(b.presence.proactive)-Number(a.presence.proactive)||a.id.localeCompare(b.id));document.querySelector('#nodes').innerHTML=nodes.map(n=>{const edges=d.edges.filter(e=>e.from===n.id).map(e=>'→ '+esc(e.to)+' · '+esc(e.why||'connected')).join('<br>')||'No declared connections';return '<article class="card"><div class="cardtop"><strong>'+esc(n.id)+'</strong><span class="badge '+esc(n.presence.state)+'">'+esc(n.presence.state)+'</span></div><p>'+esc(n.is)+'</p><div>'+n.provides.length+' capabilities · '+n.openMessages+' open</div><div class="edges">'+edges+'</div></article>'}).join('');document.querySelector('#messages').innerHTML=d.messages.length?d.messages.slice(0,50).map((m,i)=>'<button class="message" data-i="'+i+'"><span class="route">'+esc(m.from)+' → '+esc(m.to)+' · '+esc(m.kind)+'</span><strong>'+esc(m.subject)+'</strong><small>'+new Date(m.createdAt).toLocaleString()+' · '+(m.acknowledgedAt?'acknowledged':'open')+'</small></button>').join(''):'<p class="muted">No protocol envelopes yet.</p>';document.querySelectorAll('.message').forEach(b=>b.onclick=()=>{document.querySelector('#detail pre').textContent=JSON.stringify(d.messages[Number(b.dataset.i)],null,2);document.querySelector('#detail').showModal()})}
async function refresh(){try{render(await(await fetch('/api/state',{cache:'no-store'})).json())}catch{document.querySelector('#updated').textContent='inspector unavailable'}}refresh();setInterval(refresh,2000);document.querySelector('.close').onclick=()=>document.querySelector('#detail').close();
</script></body></html>`;

if (args.includes('--snapshot')) {
  console.log(JSON.stringify(snapshot(), null, 2));
  process.exit(0);
}
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  console.error('--port must be an integer from 0 to 65535');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  };
  const host = String(request.headers.host || '').toLowerCase();
  if (request.method !== 'GET') {
    response.writeHead(405, { ...headers, Allow: 'GET' });
    response.end('method not allowed');
    return;
  }
  if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
    response.writeHead(403, headers);
    response.end('loopback host required');
    return;
  }
  if (request.url === '/api/state') {
    try {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(snapshot())}\n`);
    } catch (error) {
      response.writeHead(500, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify({ error: error.message })}\n`);
    }
    return;
  }
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  response.writeHead(404, headers);
  response.end('not found');
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({
    ok: true,
    url: `http://127.0.0.1:${address.port}`,
    localOnly: true,
  }));
});
