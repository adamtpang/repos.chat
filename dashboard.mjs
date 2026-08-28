#!/usr/bin/env node
// Local, read-only Repo Pet habitat. It never binds beyond loopback.

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
  return [...new Set(values.map(item => String(item).trim())
    .filter(item => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))];
}

function protocol(...protocolArgs) {
  return JSON.parse(execFileSync(process.execPath, [
    cli, ...protocolArgs, '--root', root, '--depth', depth,
  ], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, windowsHide: true }));
}

function readJsonFiles(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(name => name.endsWith('.json')); } catch { return []; }
  const values = [];
  for (const file of files) {
    try { values.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))); } catch {}
  }
  return values;
}

function readMessages() {
  const mailRoot = path.join(root, '.repo-connect', 'mail');
  let inboxes = [];
  try { inboxes = fs.readdirSync(mailRoot, { withFileTypes: true }); } catch { return []; }
  const messages = [];
  for (const inbox of inboxes) {
    if (!inbox.isDirectory()) continue;
    for (const message of readJsonFiles(path.join(mailRoot, inbox.name))) {
      messages.push({
        id: message.id, conversationId: message.conversationId || message.id,
        protocol: message.protocol || 'repo-connect/legacy',
        from: message.from, to: message.to, kind: message.kind,
        subject: message.subject, body: message.body, createdAt: message.createdAt,
        replyTo: message.replyTo || null, acknowledgedAt: message.acknowledgedAt || null,
        authorization: message.authorization || null,
      });
    }
  }
  return messages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function readProposals() {
  return readJsonFiles(path.join(root, '.repo-connect', 'proposals'))
    .map(proposal => ({
      id: proposal.id, state: proposal.state, from: proposal.from, to: proposal.to,
      exchange: proposal.exchange, event: proposal.event, subject: proposal.subject,
      createdAt: proposal.createdAt, approvedAt: proposal.approvedAt || null,
      messageId: proposal.messageId || null,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function activityFor(node, messagesById) {
  const state = node.presence?.state || 'offline';
  const message = messagesById.get(node.presence?.messageId);
  if (state === 'working') return { label: 'Questing', detail: message?.subject || 'Handling one bounded repository request.' };
  if (state === 'blocked') return { label: 'Needs a trainer', detail: message?.subject || 'Stopped safely and waiting for direction.' };
  if (node.presence?.proactive) return {
    label: 'Guarding',
    detail: node.openMessages ? `${node.openMessages} request${node.openMessages === 1 ? '' : 's'} waiting.` : 'Inbox clear. Watching for bounded work.',
  };
  if (node.assigned) return { label: 'Napping', detail: 'Assigned, but no live watcher lease is proven.' };
  return { label: 'Unhatched', detail: 'Needs a verified manifest and repository instructions.' };
}

export function snapshot(focus = []) {
  const selected = normalizeFocus(focus);
  const graph = selected.length
    ? protocol('graph', '--git', '--git-repos', selected.join(','))
    : protocol('graph');
  const selectedIds = new Set(selected);
  const allMessages = readMessages();
  const allProposals = readProposals();
  const messagesById = new Map(allMessages.map(message => [message.id, message]));
  const allNodes = graph.nodes.map(node => ({
    id: node.id, is: node.is, cluster: node.cluster || 'unclustered', provides: node.provides,
    assigned: node.assigned, openMessages: node.openMessages,
    pendingProposals: node.pendingProposals || 0, presence: node.presence,
    git: node.git || null, pullRequests: node.pullRequests || [], activity: activityFor(node, messagesById),
  }));
  const nodes = selected.length ? allNodes.filter(node => selectedIds.has(node.id)) : allNodes;
  const edges = selected.length
    ? graph.edges.filter(edge => selectedIds.has(edge.from) && selectedIds.has(edge.to))
    : graph.edges;
  const messages = selected.length
    ? allMessages.filter(message => selectedIds.has(message.from) && selectedIds.has(message.to))
    : allMessages;
  const proposals = selected.length
    ? allProposals.filter(proposal => selectedIds.has(proposal.from) || selectedIds.has(proposal.to))
    : allProposals;
  return {
    protocol: 'repos.chat/inspector/2', generatedAt: new Date().toISOString(), focus: selected,
    summary: {
      repositories: nodes.length,
      assigned: nodes.filter(node => node.assigned).length,
      proactive: nodes.filter(node => node.presence.proactive).length,
      working: nodes.filter(node => node.presence.state === 'working').length,
      openMessages: nodes.reduce((sum, node) => sum + node.openMessages, 0),
      pendingProposals: proposals.filter(proposal => proposal.state === 'proposed').length,
      readyConnections: edges.filter(edge => edge.ready).length,
      conversations: new Set(messages.map(message => message.conversationId)).size,
    },
    nodes, edges, messages, proposals,
    network: {
      nodes: allNodes.map(node => ({ id: node.id, cluster: node.cluster, presence: node.presence, assigned: node.assigned })),
      edges: graph.edges,
    },
  };
}

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>repos.chat · Repo Pet habitat</title>
<style>
:root{color-scheme:dark;--ink:#f8f0d2;--muted:#a9a38f;--bg:#12161d;--panel:#1b2029;--panel2:#10151c;--line:#3b4350;--lime:#c6f46a;--sun:#ffd76a;--pink:#ff7d9c;--blue:#74d5ff;--purple:#b998ff;--danger:#ff755f;--shadow:#07090d}
*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--bg);background-image:linear-gradient(90deg,#ffffff05 1px,transparent 1px),linear-gradient(#ffffff05 1px,transparent 1px);background-size:16px 16px;font:13px/1.5 "Cascadia Mono",Consolas,monospace}button,a{font:inherit}main{width:min(1520px,100%);margin:auto;padding:28px 22px 72px}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:20px}.eyebrow{color:var(--lime);font-size:10px;font-weight:900;letter-spacing:.18em;text-transform:uppercase}h1,h2,h3,p{margin-top:0}h1{margin-bottom:0;font:900 clamp(38px,6vw,78px)/.82 "Arial Rounded MT Bold","Segoe UI",sans-serif;letter-spacing:-.07em}h1 em{color:var(--pink);font-style:normal;text-shadow:4px 4px 0 #711f42}.live{display:flex;align-items:center;gap:8px;color:var(--lime);font-size:11px}.live i{width:8px;height:8px;background:currentColor;box-shadow:0 0 0 3px #c6f46a20,0 0 14px currentColor;animation:blink 1.2s steps(2,end) infinite}
.hero{display:grid;grid-template-columns:minmax(280px,.7fr) 1.3fr;gap:16px}.panel,.stat,.stage{border:2px solid var(--line);background:var(--panel);box-shadow:6px 6px 0 var(--shadow)}.manifesto{padding:22px;border-color:#5f4562;background:linear-gradient(145deg,#2d1e31,#1b2029)}.manifesto h2{max-width:18ch;margin:8px 0 12px;font:900 clamp(23px,3vw,39px)/1 "Segoe UI",sans-serif;letter-spacing:-.04em}.manifesto p{max-width:58ch;color:#d4cbb3}.rules{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.rule{padding:10px;border:1px solid #61536a;background:#17151d}.rule b{display:block;color:var(--sun);font:800 12px "Segoe UI",sans-serif}.rule span{color:var(--muted);font-size:10px}.focus{display:none;margin:18px 0 0;padding:11px 14px;border:1px dashed var(--blue);background:#101a24;color:var(--muted)}.focus.visible{display:block}.focus b{color:var(--blue)}
.stats{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin:18px 0}.stat{padding:10px 12px}.stat b{display:block;color:var(--sun);font:900 23px "Segoe UI",sans-serif}.stat span{color:var(--muted);font-size:9px;letter-spacing:.08em;text-transform:uppercase}
.stage{margin:0 0 18px;padding:14px;overflow:hidden}.stagehead,.panelhead{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}.stage h2,.panel h2{margin:0;font:800 16px "Segoe UI",sans-serif}.stagehead span,.panelhead span{color:var(--muted);font-size:10px}.mapwrap{overflow:auto;border:1px solid #303744;background:#0b1016}.mapwrap>svg{display:block;min-width:1000px;width:100%;height:auto}.edge{stroke:#5d6877;stroke-width:1;opacity:.18;stroke-dasharray:3 4}.edge.ready{stroke:var(--lime);stroke-width:1.7;opacity:.48;stroke-dasharray:none}.cluster-label{fill:#6e7885;font:700 9px Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}.pet-label{fill:#d9d2bb;font:7px Consolas,monospace}.map-pet{cursor:pointer}.map-pet>svg{width:16px;height:16px}.map-pet:hover .pet-label{fill:var(--lime)}.legend{display:flex;gap:16px;margin-top:8px;color:var(--muted);font-size:9px}.legend i{display:inline-block;width:18px;height:2px;margin-right:5px;vertical-align:middle;background:#5d6877}.legend i.ready{background:var(--lime)}
.workbench{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(340px,.75fr);gap:14px}.panel{min-width:0;padding:16px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px}.cards.focused{grid-template-columns:repeat(2,minmax(0,1fr))}.card{min-width:0;padding:12px;border:2px solid #3b4350;background:#111720;box-shadow:4px 4px 0 #080a0e}.petrow{display:flex;align-items:center;gap:11px}.pet{position:relative;flex:0 0 auto;width:84px;height:84px;display:grid;place-items:center;border:2px solid #4b5360;background:linear-gradient(#263142,#19202b);box-shadow:4px 4px 0 #080a0e;overflow:hidden}.pet svg{width:74px;height:74px;image-rendering:pixelated;animation:bob 1.8s steps(2,end) infinite}.pet.offline svg{filter:saturate(.45) brightness(.75);animation-duration:3.2s}.pet.working{border-color:var(--blue);box-shadow:4px 4px 0 #163f56}.pet.blocked{border-color:var(--sun)}.pet-state{position:absolute;right:3px;top:2px;color:var(--sun);font:900 12px Consolas}.petname{color:var(--pink);font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.09em}.copy{min-width:0}.copy strong{display:block;overflow:hidden;text-overflow:ellipsis;font:800 14px "Segoe UI",sans-serif}.badge{display:inline-block;margin-top:5px;padding:1px 5px;border:1px solid currentColor;color:var(--muted);font-size:8px;text-transform:uppercase}.badge.idle{color:var(--lime)}.badge.working{color:var(--blue)}.badge.blocked{color:var(--sun)}.purpose{min-height:48px;margin:10px 0;color:var(--muted);font-size:10px}.now{padding:8px;border-left:3px solid var(--lime);background:#18211f}.card[data-state=offline] .now{border-color:#66707d}.card[data-state=working] .now{border-color:var(--blue)}.now small{display:block;color:var(--muted);font-size:8px;text-transform:uppercase}.now b{font:700 11px "Segoe UI",sans-serif}.now span{display:block;color:var(--muted);font-size:9px}.meta{margin:9px 0;color:#777f8d;font-size:8px}.tags{display:flex;flex-wrap:wrap;gap:4px}.tag{padding:2px 4px;background:#252c37;color:#bdc5cf;font-size:8px}.connections{margin-top:9px;border-top:1px solid #303844;padding-top:7px;font-size:9px}.connections summary{cursor:pointer;color:var(--blue)}.connection{margin-top:8px;padding:7px;background:#0c1218}.connection b{color:var(--ink)}.connection p{margin:3px 0;color:var(--muted)}.recipe{margin-top:5px;padding:6px;border:1px solid #4e5c45;color:#cdd8b5;background:#151d15}.recipe.related{border-color:#424957;color:#8c96a3;background:#151920}.recipe strong{color:var(--lime)}
.rightcol{display:grid;gap:14px;align-content:start}.feed{max-height:590px;overflow:auto}.item{width:100%;margin:0 0 8px;padding:10px;border:1px solid #3a424f;color:inherit;background:#0f151c;text-align:left}.item.route-button{cursor:pointer}.item.route-button:hover,.item.route-button:focus-visible{outline:none;border-color:var(--blue)}.route{color:var(--blue);font-size:9px}.item strong{display:block;margin:4px 0;font:700 11px "Segoe UI",sans-serif}.item small{color:var(--muted);font-size:8px}.gitrepo{margin-bottom:10px;padding:9px;border:1px solid #38414d;background:#0f151c}.gitrepo h3{margin:0 0 4px;font:800 11px "Segoe UI",sans-serif}.branch{color:var(--purple);font-size:9px}.commit{display:grid;grid-template-columns:48px 1fr;gap:7px;margin-top:5px;font-size:8px}.commit code{color:var(--lime)}.commit span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}.pr{display:block;margin-top:6px;color:var(--blue);text-decoration:none}.empty{color:var(--muted);font-size:10px}
.protocol{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-top:18px}.protocol .step{padding:9px;border:1px solid #414957;background:#181e27;color:var(--muted);font-size:9px}.protocol b{display:block;color:var(--sun);font:800 10px "Segoe UI",sans-serif}.footer-note{margin-top:12px;color:#7e8793;font-size:9px}
dialog{width:min(760px,calc(100% - 28px));padding:18px;border:2px solid #596474;color:var(--ink);background:#10161e;box-shadow:8px 8px 0 #000}dialog::backdrop{background:#000c}.close{float:right;border:0;color:var(--muted);background:none;font-size:22px;cursor:pointer}pre{max-height:60vh;overflow:auto;padding:12px;border:1px solid #39414d;white-space:pre-wrap;word-break:break-word;background:#080c11}
@keyframes bob{50%{transform:translateY(-3px)}}@keyframes blink{50%{opacity:.3}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}@media(max-width:1100px){.cards{grid-template-columns:repeat(2,1fr)}.stats{grid-template-columns:repeat(4,1fr)}}@media(max-width:850px){.hero,.workbench{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:580px){main{padding-inline:12px}header{align-items:flex-start;flex-direction:column}.rules,.cards,.cards.focused{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.protocol{grid-template-columns:repeat(2,1fr)}}
</style></head><body><main>
<header><div><div class="eyebrow">LOCAL · PRIVATE · REPOSITORY HABITAT</div><h1>meet your<br><em>Repo Pets.</em></h1></div><div class="live"><i></i><span id="updated">waking habitat</span></div></header>
<section class="hero"><div class="manifesto panel"><div class="eyebrow">WHAT THE PERFECT PET DOES</div><h2>Cute face. Serious repository stewardship.</h2><p>Each original pixel creature represents one bounded Repo Rep. It learns its own habitat, watches verified signals, asks a connected pet for a named result, proves the work, and waits for a human before crossing a permission boundary.</p></div><div class="rules"><div class="rule"><b>1 · Know</b><span>purpose, code, constraints</span></div><div class="rule"><b>2 · Watch</b><span>mail, CI, drift, webhooks</span></div><div class="rule"><b>3 · Propose</b><span>never self-authorize</span></div><div class="rule"><b>4 · Collaborate</b><span>named exchange recipes</span></div><div class="rule"><b>5 · Prove</b><span>paths, tests, risks</span></div><div class="rule"><b>6 · Guard</b><span>draft PR, human merge</span></div></div></section>
<section id="focus" class="focus"></section><section class="stats" id="stats"></section>
<section class="stage"><div class="stagehead"><h2>Aether connection map</h2><span>solid lime = executable recipe · gray dash = related only · click a pet to focus</span></div><div class="mapwrap" id="map"></div><div class="legend"><span><i class="ready"></i>ready to exchange work</span><span><i></i>relationship needs a recipe</span></div></section>
<div class="workbench"><section class="panel"><div class="panelhead"><h2>Repo Pet roster</h2><span>each species and nickname is deterministic per repository</span></div><div class="cards" id="nodes"></div></section><div class="rightcol"><section class="panel"><div class="panelhead"><h2>Proposals + conversations</h2><span>local durable audit trail</span></div><div class="feed" id="messages"></div></section><section class="panel"><div class="panelhead"><h2>Git + draft PRs</h2><span>evidence beside the conversation</span></div><div class="feed" id="git"></div></section></div></div>
<section class="protocol"><div class="step"><b>1. Signal</b>manual / webhook / CI / drift</div><div class="step"><b>2. Proposal</b>local, not delivered</div><div class="step"><b>3. Approval</b>exact ID confirmation</div><div class="step"><b>4. Work</b>one locked recipient</div><div class="step"><b>5. Draft PR</b>app-authored, tested</div><div class="step"><b>6. Human merge</b>authority stays human</div></section><p class="footer-note">This inspector binds to loopback. Repository names, messages, paths, and workspace metadata are never part of the public landing page.</p>
</main><dialog id="detail"><button class="close" aria-label="Close">×</button><h2>Durable record</h2><pre></pre></dialog>
<script>
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function hash(s){let h=2166136261;for(const ch of String(s)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
function ident(id){const h=hash(id),a=['Nib','Bop','Zuzu','Pip','Mochi','Tink','Fuzz','Kiko'],b=['bit','bun','mew','pop','kin','boo','zap','dot'];return{h,hue:h%360,accent:(h>>>9)%360,name:a[h%a.length]+b[(h>>>4)%b.length],kind:(h>>>12)%4}}
function petMarkup(id,state='offline',mini=false){const x=ident(id),main='hsl('+x.hue+' 72% 58%)',dark='hsl('+x.hue+' 58% 34%)',light='hsl('+x.hue+' 88% 76%)',accent='hsl('+x.accent+' 82% 67%)';let r=[];const rect=(px,py,w,h,fill)=>r.push('<rect x="'+px+'" y="'+py+'" width="'+w+'" height="'+h+'" fill="'+fill+'"/>');rect(3,14,10,1,'#080b10');if(x.kind===0){rect(3,3,3,4,'#080b10');rect(10,3,3,4,'#080b10');rect(4,4,2,3,main);rect(10,4,2,3,main)}if(x.kind===1){rect(4,2,2,5,'#080b10');rect(10,2,2,5,'#080b10');rect(5,3,1,4,accent);rect(10,3,1,4,accent)}if(x.kind===2){rect(2,5,3,3,'#080b10');rect(11,5,3,3,'#080b10');rect(3,6,2,2,accent);rect(11,6,2,2,accent)}if(x.kind===3){rect(6,2,4,3,'#080b10');rect(7,1,2,2,accent)}rect(3,6,10,7,'#080b10');rect(4,5,8,9,'#080b10');rect(5,5,6,9,main);rect(4,7,8,5,main);rect(5,11,6,3,dark);rect(6,10,4,3,light);rect(5,7,2,2,'#f8f1d5');rect(9,7,2,2,'#f8f1d5');rect(6,8,1,1,'#11151b');rect(9,8,1,1,'#11151b');rect(7,10,2,1,accent);rect(2,9,2,2,'#080b10');rect(2,8,1,2,accent);rect(12,10,2,2,'#080b10');rect(13,9,1,2,main);if(state==='working'){rect(1,3,1,2,'#74d5ff');rect(14,4,1,2,'#ffd76a')}if(state==='blocked'){rect(12,7,1,2,'#74d5ff')}const z=state==='offline'?'<text x="12" y="4" fill="#ffd76a" font-size="3" font-family="monospace">z</text>':'';return '<svg '+(mini?'width="16" height="16" ':'')+'viewBox="0 0 16 16" shape-rendering="crispEdges" role="img" aria-label="'+esc(x.name)+', Repo Pet for '+esc(id)+'">'+r.join('')+z+'</svg>'}
function avatar(n){const x=ident(n.id),st=n.presence.state||'offline';return '<div class="pet '+esc(st)+'">'+petMarkup(n.id,st)+'<i class="pet-state">'+(st==='working'?'!':st==='blocked'?'?':'')+'</i></div><div class="copy"><span class="petname">'+esc(x.name)+' · guardian</span><strong>'+esc(n.id)+'</strong><span class="badge '+esc(st)+'">'+esc(st)+'</span></div>'}
function card(n,d){const outgoing=d.edges.filter(e=>e.from===n.id),tags=(n.provides||[]).slice(0,5).map(p=>'<span class="tag">'+esc(p)+'</span>').join('');const links=outgoing.length?'<details class="connections"><summary>'+outgoing.filter(e=>e.ready).length+' ready · '+outgoing.length+' declared</summary>'+outgoing.map(e=>{const recipes=(e.recipes||[]).map(r=>'<div class="recipe"><strong>'+esc(r.id)+'</strong> · '+esc(r.trigger)+'<br>asks: '+esc(r.asks)+'<br>returns: '+esc(r.returns)+'</div>').join('');return '<div class="connection"><b>→ '+esc(e.to)+'</b><p>'+esc(e.why||'Declared relationship.')+'</p>'+(recipes||'<div class="recipe related">Related only — add a verified exchange before the pets work together.</div>')+'</div>'}).join('')+'</details>':'<div class="connections">No declared routes.</div>';return '<article class="card" data-state="'+esc(n.presence.state)+'"><div class="petrow">'+avatar(n)+'</div><p class="purpose">'+esc(n.is)+'</p><div class="now"><small>right now</small><b>'+esc(n.activity.label)+'</b><span>'+esc(n.activity.detail)+'</span></div><div class="meta">'+n.provides.length+' capabilities · '+n.pendingProposals+' proposals · '+n.openMessages+' mail</div><div class="tags">'+tags+'</div>'+links+'</article>'}
function layoutNetwork(net){const groups=new Map;for(const n of net.nodes){const key=n.cluster||'unclustered';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n)}const entries=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])),cols=4,cellW=285,cellH=155,width=cols*cellW,height=Math.ceil(entries.length/cols)*cellH,pos=new Map;let labels='';entries.forEach(([cluster,nodes],gi)=>{const gx=(gi%cols)*cellW,gy=Math.floor(gi/cols)*cellH;labels+='<text class="cluster-label" x="'+(gx+12)+'" y="'+(gy+17)+'">'+esc(cluster)+'</text>';nodes.sort((a,b)=>a.id.localeCompare(b.id)).forEach((n,i)=>{const x=gx+20+(i%4)*66,y=gy+31+Math.floor(i/4)*45;pos.set(n.id,{x,y})})});const edges=net.edges.map(e=>{const a=pos.get(e.from),b=pos.get(e.to);return a&&b?'<line class="edge '+(e.ready?'ready':'')+'" x1="'+(a.x+9)+'" y1="'+(a.y+9)+'" x2="'+(b.x+9)+'" y2="'+(b.y+9)+'"/>':''}).join('');const pets=net.nodes.map(n=>{const p=pos.get(n.id);return '<g class="map-pet" data-id="'+esc(n.id)+'" transform="translate('+p.x+' '+p.y+')"><g transform="scale(1.05)">'+petMarkup(n.id,n.presence.state||'offline',true)+'</g><text class="pet-label" x="0" y="22">'+esc(n.id.length>12?n.id.slice(0,11)+'…':n.id)+'</text></g>'}).join('');return '<svg viewBox="0 0 '+width+' '+height+'" aria-label="Aether repository connection map">'+edges+labels+pets+'</svg>'}
function gitFeed(nodes){return nodes.map(n=>{if(!n.git&&!n.pullRequests.length)return'';const commits=n.git?.commits?.map(c=>'<div class="commit"><code>'+esc(c.hash)+'</code><span>'+esc(c.subject)+'</span></div>').join('')||'';const prs=(n.pullRequests||[]).slice(0,5).map(pr=>'<a class="pr" href="'+esc(pr.url)+'" target="_blank" rel="noreferrer">PR #'+esc(pr.number)+' · '+esc(pr.title)+'</a>').join('');return '<div class="gitrepo"><h3>'+esc(n.id)+'</h3><div class="branch">'+esc(n.git?.branch||'GitHub')+(n.git?' · '+n.git.changedFiles+' changed':'')+'</div>'+commits+prs+'</div>'}).join('')||'<p class="empty">No Git or draft PR records for this view yet.</p>'}
function records(d){const proposals=d.proposals.map(p=>'<div class="item"><span class="route">'+esc(p.from)+' → '+esc(p.to)+' · '+esc(p.event)+'</span><strong>'+esc(p.subject)+'</strong><small>proposal '+esc(p.state)+' · '+new Date(p.createdAt).toLocaleString()+'</small></div>');const messages=d.messages.slice(0,50).map((m,i)=>'<button class="item route-button" data-i="'+i+'"><span class="route">'+esc(m.from)+' → '+esc(m.to)+' · '+esc(m.kind)+'</span><strong>'+esc(m.subject)+'</strong><small>'+new Date(m.createdAt).toLocaleString()+' · '+(m.acknowledgedAt?'acknowledged':'open')+'</small></button>');return [...proposals,...messages].join('')||'<p class="empty">No proposals or protocol envelopes yet.</p>'}
function render(d){document.querySelector('#updated').textContent='habitat refreshed '+new Date(d.generatedAt).toLocaleTimeString();const f=document.querySelector('#focus');if(d.focus.length){f.className='focus visible';f.innerHTML='<b>Focused habitat:</b> '+d.focus.map(esc).join(' ↔ ')+' · <a href="/" style="color:var(--lime)">show the whole fleet</a>'}else{f.className='focus';f.textContent=''}const labels=[['repositories','pets'],['assigned','hatched'],['proactive','guarding'],['working','questing'],['pendingProposals','proposals'],['readyConnections','ready routes'],['conversations','threads']];document.querySelector('#stats').innerHTML=labels.map(([k,l])=>'<div class="stat"><b>'+d.summary[k]+'</b><span>'+l+'</span></div>').join('');document.querySelector('#map').innerHTML=layoutNetwork(d.network);document.querySelectorAll('.map-pet').forEach(p=>p.onclick=()=>location.href='?focus='+encodeURIComponent(p.dataset.id));const nodes=[...d.nodes].sort((a,b)=>Number(b.presence.proactive)-Number(a.presence.proactive)||a.id.localeCompare(b.id));const floor=document.querySelector('#nodes');floor.className='cards'+(d.focus.length?' focused':'');floor.innerHTML=nodes.map(n=>card(n,d)).join('');document.querySelector('#messages').innerHTML=records(d);document.querySelector('#git').innerHTML=gitFeed(nodes);document.querySelectorAll('.route-button').forEach(b=>b.onclick=()=>{document.querySelector('#detail pre').textContent=JSON.stringify(d.messages[Number(b.dataset.i)],null,2);document.querySelector('#detail').showModal()})}
const focusParam=new URLSearchParams(location.search).get('focus')||'',stateUrl='/api/state'+(focusParam?'?focus='+encodeURIComponent(focusParam):'');async function refresh(){try{render(await(await fetch(stateUrl,{cache:'no-store'})).json())}catch(e){document.querySelector('#updated').textContent='habitat unavailable'}}refresh();setInterval(refresh,10000);document.querySelector('.close').onclick=()=>document.querySelector('#detail').close();
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
    response.writeHead(405, { ...headers, Allow: 'GET' }); response.end('method not allowed'); return;
  }
  if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:')) {
    response.writeHead(403, headers); response.end('loopback host required'); return;
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
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); return;
  }
  response.writeHead(404, headers); response.end('not found');
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${address.port}`, localOnly: true }));
});
