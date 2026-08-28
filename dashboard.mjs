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
const requestedFocus = option('focus') || '';

function normalizeFocus(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values
    .map(item => String(item).trim())
    .filter(item => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))];
}

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

function activityFor(node, messagesById) {
  const state = node.presence?.state || 'offline';
  const message = messagesById.get(node.presence?.messageId);
  if (state === 'working') {
    return {
      label: 'Working',
      detail: message?.subject || 'Handling one bounded repository request.',
    };
  }
  if (state === 'blocked') {
    return {
      label: 'Needs help',
      detail: message?.subject || 'Stopped safely and waiting for direction.',
    };
  }
  if (node.presence?.proactive) {
    return {
      label: 'On watch',
      detail: node.openMessages
        ? `${node.openMessages} request${node.openMessages === 1 ? '' : 's'} waiting.`
        : 'Inbox clear. Waiting for bounded work.',
    };
  }
  if (node.assigned) {
    return {
      label: 'Off shift',
      detail: 'Assigned, but no live watcher lease is proven.',
    };
  }
  return {
    label: 'Unassigned',
    detail: 'Needs a verified manifest and repository instructions.',
  };
}

export function snapshot(focus = []) {
  const graph = protocol('graph');
  const selected = normalizeFocus(focus);
  const selectedIds = new Set(selected);
  const allMessages = readMessages();
  const messagesById = new Map(allMessages.map(message => [message.id, message]));
  const allNodes = graph.nodes.map(node => ({
    id: node.id,
    is: node.is,
    cluster: node.cluster || null,
    provides: node.provides,
    assigned: node.assigned,
    openMessages: node.openMessages,
    presence: node.presence,
    activity: activityFor(node, messagesById),
  }));
  const nodes = selected.length
    ? allNodes.filter(node => selectedIds.has(node.id))
    : allNodes;
  const edges = selected.length
    ? graph.edges.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to))
    : graph.edges;
  const messages = selected.length
    ? allMessages.filter(message => selectedIds.has(message.from) && selectedIds.has(message.to))
    : allMessages;
  return {
    protocol: 'repos.chat/inspector/1',
    generatedAt: new Date().toISOString(),
    focus: selected,
    summary: {
      repositories: nodes.length,
      assigned: nodes.filter(node => node.assigned).length,
      proactive: nodes.filter(node => node.presence.proactive).length,
      working: nodes.filter(node => node.presence.state === 'working').length,
      openMessages: nodes.reduce((sum, node) => sum + node.openMessages, 0),
      conversations: new Set(messages.map(message => message.conversationId)).size,
    },
    nodes,
    edges,
    messages,
  };
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>repos.chat inspector</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0b111b;
  --panel: #131c29;
  --panel-2: #0e1622;
  --line: #2a3a4e;
  --muted: #93a4b8;
  --text: #edf2f7;
  --paper: #f2eee4;
  --orange: #ff8a5c;
  --cyan: #72d7e4;
  --green: #8ad47b;
  --amber: #ffc857;
  --red: #ff7272;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--text);
  background-color: var(--bg);
  background-image:
    linear-gradient(rgba(114,215,228,.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(114,215,228,.035) 1px, transparent 1px);
  background-size: 24px 24px;
  font: 14px/1.48 "Cascadia Mono", Consolas, monospace;
}
main { max-width: 1320px; margin: auto; padding: 34px 24px 72px; }
header { display: flex; justify-content: space-between; align-items: end; gap: 20px; }
h1 { margin: 0; font: 800 clamp(34px,5vw,62px)/.92 "Arial Rounded MT Bold","Segoe UI",sans-serif; letter-spacing: -.055em; }
h1 span { color: var(--orange); }
h2 { margin: 0; font-family: "Segoe UI", sans-serif; }
.eyebrow { color: var(--cyan); font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
.muted { color: var(--muted); }
.live { display: flex; align-items: center; gap: 8px; color: var(--green); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 14px currentColor; }
.focus { display: none; margin: 20px 0 -8px; padding: 12px 15px; border: 1px dashed color-mix(in srgb,var(--cyan) 55%,var(--line)); background: #0d1824; color: var(--muted); }
.focus.visible { display: block; }
.focus b { color: var(--cyan); }
.brief { display: grid; grid-template-columns: minmax(260px,.8fr) 1.2fr; gap: 26px; margin-top: 28px; padding: 24px; border: 1px solid var(--line); border-left: 5px solid var(--orange); background: rgba(19,28,41,.96); box-shadow: 10px 10px 0 rgba(0,0,0,.2); }
.brief h2 { max-width: 620px; margin-top: 6px; font-size: clamp(22px,3vw,34px); line-height: 1.05; letter-spacing: -.03em; }
.brief p { margin: 12px 0 0; color: var(--muted); max-width: 58ch; }
.rep-loop { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; align-content: center; }
.loop-step { min-height: 68px; padding: 10px; border: 1px solid var(--line); background: var(--panel-2); }
.loop-step b { display: block; color: var(--paper); font-family: "Segoe UI",sans-serif; }
.loop-step span { color: var(--muted); font-size: 11px; }
.perfect-next { grid-column: 1/-1; padding-top: 7px; color: var(--orange); font-size: 11px; }
.stats { display: grid; grid-template-columns: repeat(6,1fr); gap: 8px; margin: 26px 0 18px; }
.stat,.panel,.step { border: 1px solid var(--line); background: rgba(19,28,41,.96); }
.stat { padding: 12px 14px; }
.stat b { display: block; font: 800 24px "Segoe UI",sans-serif; }
.stat span { color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.flow { display: grid; grid-template-columns: repeat(6,1fr); gap: 7px; margin-bottom: 18px; }
.step { position: relative; padding: 10px; color: var(--muted); font-size: 11px; }
.step b { display: block; color: var(--text); font: 700 12px "Segoe UI",sans-serif; }
.step:not(:last-child):after { content: "→"; position: absolute; right: -8px; top: 14px; z-index: 3; color: var(--orange); }
.grid { display: grid; grid-template-columns: 1.1fr .9fr; gap: 14px; }
.panel { min-width: 0; padding: 18px; }
.panel-title { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 14px; }
.panel-title h2 { font-size: 16px; }
.panel-title span { color: var(--muted); font-size: 10px; }
.cards { position: relative; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px; }
.cards.pair:before { content: ""; position: absolute; z-index: 0; top: 58px; left: 24%; right: 24%; height: 3px; background: repeating-linear-gradient(90deg,var(--orange) 0 9px,transparent 9px 15px); opacity: .7; }
.card { position: relative; z-index: 1; padding: 15px; border: 1px solid var(--line); background: #0d1622; box-shadow: 5px 5px 0 rgba(0,0,0,.22); }
.rep-main { display: flex; gap: 13px; align-items: center; }
.rep-copy { min-width: 0; flex: 1; }
.cardtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cardtop strong { overflow: hidden; text-overflow: ellipsis; font: 750 15px "Segoe UI",sans-serif; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: 2px 7px; font-size: 9px; letter-spacing: .07em; text-transform: uppercase; }
.idle,.awake { color: var(--green); }
.working { color: var(--cyan); }
.blocked { color: var(--amber); }
.offline { color: var(--muted); }
.purpose { margin: 8px 0 0; color: var(--muted); font-size: 11px; }
.activity { margin-top: 13px; padding: 10px; border-left: 3px solid var(--green); background: #111d2a; }
.card[data-state="working"] .activity { border-color: var(--cyan); }
.card[data-state="blocked"] .activity { border-color: var(--amber); }
.card[data-state="offline"] .activity { border-color: var(--muted); }
.activity small { display: block; margin-bottom: 2px; color: var(--muted); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
.activity strong { display: block; font: 700 12px "Segoe UI",sans-serif; }
.activity span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
.meta { margin-top: 11px; color: var(--muted); font-size: 10px; }
.tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.tag { max-width: 100%; overflow: hidden; text-overflow: ellipsis; padding: 3px 6px; border: 1px solid #30455c; color: #bed0e2; font-size: 9px; }
.connections { margin-top: 10px; color: var(--muted); font-size: 10px; }
.connections summary { cursor: pointer; color: var(--cyan); }
.connection { padding: 7px 0; border-top: 1px solid var(--line); }
.connection b { display: block; color: var(--text); }
.connection p { margin: 2px 0 0; color: var(--muted); }
.rep-avatar { --skin: hsl(var(--h) 42% 73%); position: relative; flex: 0 0 76px; width: 76px; height: 88px; color: hsl(var(--h) 75% 66%); }
.avatar-ring { position: absolute; inset: 1px 4px 9px; border: 2px dashed currentColor; border-radius: 50%; opacity: .55; }
.rep-avatar.working .avatar-ring { animation: orbit 2.2s linear infinite; }
.rep-avatar.blocked .avatar-ring { border-style: solid; color: var(--amber); }
.rep-avatar.offline .avatar-ring { color: var(--muted); opacity: .28; }
.cap { position: absolute; z-index: 3; left: 24px; top: 14px; width: 30px; height: 14px; border-radius: 20px 20px 3px 3px; background: hsl(var(--h) 70% 48%); transform: rotate(-3deg); }
.v1 .cap { border-radius: 3px 18px 3px 3px; transform: rotate(4deg); }
.v2 .cap { height: 8px; top: 17px; border-radius: 2px; }
.v3 .cap { width: 22px; left: 28px; height: 17px; }
.head { position: absolute; z-index: 2; left: 23px; top: 23px; width: 32px; height: 31px; border: 2px solid #07101a; border-radius: 12px 12px 14px 14px; background: var(--skin); box-shadow: 2px 2px 0 #07101a; }
.eye { position: absolute; top: 11px; width: 3px; height: 4px; border-radius: 50%; background: #0a1118; }
.eye.left { left: 8px; }
.eye.right { right: 8px; }
.mouth { position: absolute; left: 12px; bottom: 6px; width: 8px; height: 4px; border-bottom: 2px solid #0a1118; border-radius: 50%; }
.rep-avatar.blocked .mouth { border-bottom: 0; border-top: 2px solid #0a1118; }
.torso { position: absolute; z-index: 1; left: 17px; bottom: 7px; width: 44px; height: 34px; border: 2px solid #07101a; border-radius: 13px 13px 5px 5px; background: hsl(var(--h) 55% 34%); box-shadow: 3px 3px 0 #07101a; }
.torso:before { content: "R"; position: absolute; right: 5px; top: 6px; display: grid; place-items: center; width: 15px; height: 15px; border: 1px solid rgba(255,255,255,.45); border-radius: 50%; color: white; font: 800 8px "Segoe UI",sans-serif; }
.message { width: 100%; margin: 0 0 9px; padding: 12px; border: 1px solid var(--line); color: inherit; background: #0d1622; text-align: left; cursor: pointer; }
.message:hover,.message:focus-visible { outline: none; border-color: var(--cyan); box-shadow: 3px 3px 0 rgba(114,215,228,.18); }
.route { color: var(--cyan); font-size: 10px; }
.message strong { display: block; margin: 6px 0 4px; font: 700 12px "Segoe UI",sans-serif; }
.message small { color: var(--muted); font-size: 10px; }
dialog { width: min(760px,calc(100% - 32px)); padding: 20px; border: 1px solid var(--line); color: var(--text); background: #0d1622; }
dialog::backdrop { background: #000c; }
.close { float: right; border: 0; color: var(--muted); background: none; font-size: 24px; cursor: pointer; }
pre { max-height: 55vh; overflow: auto; padding: 14px; border: 1px solid var(--line); white-space: pre-wrap; word-break: break-word; background: #080e16; }
@keyframes orbit { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; scroll-behavior: auto !important; } }
@media (max-width: 960px) { .brief,.grid { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(3,1fr); } }
@media (max-width: 620px) { main { padding-inline: 14px; } header { align-items: start; flex-direction: column; } .rep-loop,.cards { grid-template-columns: 1fr; } .cards.pair:before { display: none; } .flow { grid-template-columns: repeat(2,1fr); } .step:after { display: none; } .stats { grid-template-columns: repeat(2,1fr); } }
</style></head>
<body><main><header><div><div class="eyebrow">LOCAL REPOSITORY WORKSHOP</div><h1>every repo gets<br>a <span>rep.</span></h1></div><div class="live"><i class="dot"></i><span id="updated">connecting</span></div></header>
<section class="focus" id="focus"></section>
<section class="brief"><div><div class="eyebrow">THE JOB</div><h2>Keep one repository coherent, useful, and honest.</h2><p>A Repo Rep is responsible for its repository, not unrestricted inside it. It understands the code, watches for bounded work, collaborates through declared connections, and proves every result.</p></div><div class="rep-loop"><div class="loop-step"><b>Know</b><span>purpose + real capabilities</span></div><div class="loop-step"><b>Watch</b><span>mailbox + live lease</span></div><div class="loop-step"><b>Work</b><span>one claimed task</span></div><div class="loop-step"><b>Ask</b><span>connected reps only</span></div><div class="loop-step"><b>Prove</b><span>evidence + tests + risks</span></div><div class="loop-step"><b>Guard</b><span>scope + human authority</span></div><div class="perfect-next"><b>PERFECT NEXT, NOT YET AUTOMATED:</b> detect contract drift, propose preventative maintenance, remember durable lessons, and escalate before a neighboring repo breaks.</div></div></section>
<section class="stats" id="stats"></section>
<section class="flow"><div class="step"><b>1. Manifest</b>assignment</div><div class="step"><b>2. Lease</b>presence proof</div><div class="step"><b>3. Envelope</b>durable request</div><div class="step"><b>4. Lock</b>one worker</div><div class="step"><b>5. Evidence</b>structured reply</div><div class="step"><b>6. Ack</b>closed request</div></section>
<div class="grid"><section class="panel"><div class="panel-title"><h2>Repo floor</h2><span>each person is deterministic per repo</span></div><div class="cards" id="nodes"></div></section><section class="panel"><div class="panel-title"><h2>What they did</h2><span>durable protocol envelopes</span></div><div id="messages"></div></section></div>
</main><dialog id="detail"><button class="close" aria-label="Close">×</button><h2>Protocol envelope</h2><pre></pre></dialog>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let state;
function repIdentity(id){let hash=2166136261;for(const ch of String(id)){hash^=ch.charCodeAt(0);hash=Math.imul(hash,16777619)}return{hue:Math.abs(hash)%360,variant:Math.abs(hash>>>8)%4}}
function avatar(n){const ident=repIdentity(n.id);return '<div class="rep-avatar '+esc(n.presence.state)+' v'+ident.variant+'" style="--h:'+ident.hue+'" aria-hidden="true"><i class="avatar-ring"></i><i class="cap"></i><div class="head"><i class="eye left"></i><i class="eye right"></i><i class="mouth"></i></div><i class="torso"></i></div>'}
function repCard(n,d){const outgoing=d.edges.filter(e=>e.from===n.id);const tags=(n.provides||[]).map(p=>'<span class="tag">'+esc(p)+'</span>').join('');const links=outgoing.length?'<details class="connections"><summary>Talks to '+outgoing.length+' connected repo'+(outgoing.length===1?'':'s')+'</summary>'+outgoing.map(e=>'<div class="connection"><b>→ '+esc(e.to)+'</b><p>'+esc(e.why||'Connected by verified manifest.')+'</p></div>').join('')+'</details>':'<div class="connections">No declared connections.</div>';return '<article class="card" data-state="'+esc(n.presence.state)+'"><div class="rep-main">'+avatar(n)+'<div class="rep-copy"><div class="cardtop"><strong>'+esc(n.id)+'</strong><span class="badge '+esc(n.presence.state)+'">'+esc(n.presence.state)+'</span></div><p class="purpose">'+esc(n.is)+'</p></div></div><div class="activity"><small>Right now</small><strong>'+esc(n.activity.label)+'</strong><span>'+esc(n.activity.detail)+'</span></div><div class="meta">Owns '+n.provides.length+' verified capabilit'+(n.provides.length===1?'y':'ies')+' · '+n.openMessages+' open</div><div class="tags">'+tags+'</div>'+links+'</article>'}
function render(d){state=d;document.querySelector('#updated').textContent='refreshed '+new Date(d.generatedAt).toLocaleTimeString();const focus=document.querySelector('#focus');if(d.focus.length){focus.className='focus visible';focus.innerHTML='<b>Focused shift:</b> '+d.focus.map(esc).join(' ↔ ')+' · '+d.edges.length+' declared direction'+(d.edges.length===1?'':'s')+' · only their conversations are shown'}else{focus.className='focus';focus.textContent=''}const labels=[['repositories','repos'],['assigned','assigned'],['proactive','awake'],['working','working'],['openMessages','open mail'],['conversations','threads']];document.querySelector('#stats').innerHTML=labels.map(([k,l])=>'<div class="stat"><b>'+d.summary[k]+'</b><span>'+l+'</span></div>').join('');const nodes=[...d.nodes].sort((a,b)=>Number(b.presence.proactive)-Number(a.presence.proactive)||a.id.localeCompare(b.id));const floor=document.querySelector('#nodes');floor.className='cards'+(nodes.length===2&&d.edges.length?' pair':'');floor.innerHTML=nodes.map(n=>repCard(n,d)).join('');document.querySelector('#messages').innerHTML=d.messages.length?d.messages.slice(0,50).map((m,i)=>'<button class="message" data-i="'+i+'"><span class="route">'+esc(m.from)+' → '+esc(m.to)+' · '+esc(m.kind)+'</span><strong>'+esc(m.subject)+'</strong><small>'+new Date(m.createdAt).toLocaleString()+' · '+(m.acknowledgedAt?'acknowledged':'open')+'</small></button>').join(''):'<p class="muted">No protocol envelopes yet. Send one bounded request to watch a rep go to work.</p>';document.querySelectorAll('.message').forEach(b=>b.onclick=()=>{document.querySelector('#detail pre').textContent=JSON.stringify(d.messages[Number(b.dataset.i)],null,2);document.querySelector('#detail').showModal()})}
const focusParam=new URLSearchParams(location.search).get('focus')||'';const stateUrl='/api/state'+(focusParam?'?focus='+encodeURIComponent(focusParam):'');async function refresh(){try{render(await(await fetch(stateUrl,{cache:'no-store'})).json())}catch{document.querySelector('#updated').textContent='inspector unavailable'}}refresh();setInterval(refresh,2000);document.querySelector('.close').onclick=()=>document.querySelector('#detail').close();
</script></body></html>`;

if (args.includes('--snapshot')) {
  console.log(JSON.stringify(snapshot(requestedFocus), null, 2));
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
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  if (requestUrl.pathname === '/api/state') {
    try {
      response.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(snapshot(requestUrl.searchParams.get('focus') || ''))}\n`);
    } catch (error) {
      response.writeHead(500, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify({ error: error.message })}\n`);
    }
    return;
  }
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
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
