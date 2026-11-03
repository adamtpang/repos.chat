import { repoName, excerpt, petVariant, statusLabel, pathsFor, chapterFor } from './story.mjs';
import {mapLane,readMemory,choiceKey} from './adventure.mjs';
import {briefingFor, freshPriority, inputNeeded, nextAfterCooking, eligible} from './briefing.mjs';
const token = location.hash.slice(1) || sessionStorage.getItem('queue-token');
if (token) sessionStorage.setItem('queue-token', token);
history.replaceState(null, '', '/');
const $ = id => document.getElementById(id);
const node = (tag, text = '', cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; };
let selected, data, reviewId, chosen, custom = '', pending = false;
let memory;try{memory=readMemory(localStorage.getItem('repos-adventure'));}catch{memory=readMemory(null);}
selected=memory.selected;let mode=memory.mode||'play',chosenTitle='',currentCard;
const persist=()=>{try{memory.selected=selected;memory.mode=mode;localStorage.setItem('repos-adventure',JSON.stringify(memory));}catch{$('notice').textContent='This browser could not save your draft. Copy it before leaving.';}};
function keepDraft(){if(currentCard && chosen!==undefined){memory.visits[currentCard.id]={prompt:custom,title:chosenTitle||'My own direction',revision:currentCard.revision};persist();}}
function visit(id){keepDraft();selected=id;mode='play';reviewId=null;chosen=undefined;custom='';const saved=memory.visits[id];if(saved){chosen='saved';custom=saved.prompt;chosenTitle=saved.title;}persist();render();}
async function api(route, body) {
  const response = await fetch(`/api/${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
}
const action = fn => async () => { if (pending) return; pending = true; try { $('notice').textContent = ''; await fn(); } catch(e) { $('notice').textContent = e.message; } finally { pending = false; } };
async function reload() { const next=await api('queue');if(JSON.stringify(next)===JSON.stringify(data))return;
  const following=mode==='play' && chosen===undefined && !reviewId ? nextAfterCooking(currentCard,next.cards) : null;
  data=next;if(following){$('notice').textContent=`${repoName(currentCard)} is cooking. Next up: ${repoName(following)}.`;selected=following.id;persist();}render(); }
function pet(card, small = false) {
  const figure = node('div', '', `pet variant-${petVariant(card)}${small ? ' mini' : ''}`); figure.setAttribute('aria-hidden','true');
  const body = node('div', '', 'pet-body'); body.append(node('i','','eye left'), node('i','','eye right'), node('i','','mouth')); figure.append(body, node('i','','foot left'), node('i','','foot right')); return figure;
}
function disclosure(title, parent) { const el = node('details'); el.append(node('summary', title)); parent.append(el); return el; }
function render() {
  for(const name of ['play','map','journal']){const b=$(`nav-${name}`);if(mode===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  $('current').replaceChildren(); $('remaining').replaceChildren(); $('count').textContent = data.cards.length;
  const card = data.cards.find(c => c.id === selected) || data.cards.find(c=>data.bridge?.sessions?.[c.threadId]?.state==='connected' && !['parked','done'].includes(c.triage?.disposition)) || data.current || data.cards[0];
  const connectedCount=Object.values(data.bridge?.sessions || {}).filter(s=>s.state!=='unavailable' && s.state!=='connecting').length;
  document.querySelector('.local').textContent = data.bridge?.connected ? `${connectedCount} repos connected` : 'Your private world';
  for (const other of data.cards) {
    const button = node('button', '', `companion${other.id === card?.id ? ' selected' : ''}`); button.setAttribute('aria-pressed', String(other.id === card?.id));
    const connection=data.bridge?.sessions?.[other.threadId];
    const connectionLabel=connection?.state==='unavailable' ? 'Open in Codex desktop' : connection ? `Connected · ${statusLabel(other)}` : statusLabel(other);
    const text = node('span', '', 'companion-copy'); text.append(node('strong', repoName(other)), node('small', connectionLabel)); button.append(pet(other, true), text);
    button.onclick = () => visit(other.id); $('remaining').append(button);
  }
  if (!card) { $('current').append(node('h2', 'Your first companion is on its way.'), node('p', 'Import an existing task through the Codex relay to begin its story.')); return; }
  currentCard=card;selected=card.id;
  if(chosen===undefined && memory.visits[card.id]){const saved=memory.visits[card.id];chosen='saved';custom=saved.prompt;chosenTitle=saved.title;}
  if(mode==='map'){renderMap();return;}if(mode==='journal'){renderJournal();return;}
  const article = node('article'); $('current').append(article);
  const scene = node('div', '', 'scene'), identity = node('div', '', 'identity');
  identity.append(node('span', statusLabel(card), 'status'), node('h2', repoName(card)));
  scene.append(identity, pet(card)); article.append(scene);
  const queueBar=node('div','','queue-progress');
  queueBar.append(node('span',`${data.cards.filter(eligible).length} pets ready for a turn`));
  const nextPet=data.cards.find(c=>c.id!==card.id && eligible(c));
  if(nextPet){const skip=node('button','Visit next pet →','quiet');skip.onclick=()=>visit(nextPet.id);queueBar.append(skip);}article.append(queueBar);
  const priority=freshPriority(card);
  if(priority)article.append(node('p',`Why now: ${priority.reason}`,'priority-reason'));
  if(data.priorityNote){const note=disclosure('Today’s priorities',article);note.append(node('p',data.priorityNote,'source meta'));}
  const timestamp=card.resultTimestamp || card.sourceTimestamp;
  article.append(node('p',timestamp ? `Last report ${new Date(timestamp).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}` : 'Waiting for a source report','scene-time'));
  const speech = node('div', '', 'speech'), earlier = card.resultTurnId !== card.turnId && card.resultTimestamp;
  const briefing=briefingFor(card);
  speech.append(node('span','The project I want to become','report-label'),node('p',briefing.ideal,'recap'));
  const beats=node('div','','briefing-beats');
  for(const [label,value] of [['Right now',briefing.current],[inputNeeded(card)?'I need you':'In my way',briefing.blocker],['Last prompt → result',briefing.last]]){const beat=node('div');beat.append(node('span',label,'report-label'),node('p',value));beats.append(beat);}speech.append(beats);
  const promptSource=disclosure('What you last asked',speech);promptSource.append(node('p',briefing.prompt,'source meta'));
  if(earlier)speech.append(node('p','The available result is from an earlier turn.','meta'));
  if (card.error) speech.append(node('p', `My last attempt stopped. ${excerpt(card.error, 155)}`, 'failure')); article.append(speech);
  if(card.triage?.nextAction && !card.adventure){const fork=node('div','','story-fork');fork.append(node('span','The open thread'),node('p',excerpt(card.triage.nextAction,220)));article.append(fork);}
  const live=data.bridge?.sessions?.[card.threadId];
  if(live){
    const livePanel=node('div','','live-state');livePanel.append(node('p',`Local connection: ${live.state}`,'meta'));
    if(live.error)livePanel.append(node('p',live.error,'failure'));
    if(live.progress)livePanel.append(node('p',excerpt(live.progress,160),'meta'));
    if(live.state==='working') {const stop=node('button','Stop this step','quiet');stop.onclick=action(async()=>{await api('interrupt',{threadId:card.threadId});await reload();});livePanel.append(stop);}
    if(live.permission){const detail=disclosure('Codex needs permission',livePanel);detail.open=true;detail.append(node('pre',JSON.stringify(live.permission.details,null,2),'source meta'));
      const deny=node('button','Decline this action','quiet');deny.onclick=action(async()=>{await api('deny-permission',{id:live.permission.id});await reload();});detail.append(deny,node('p','This first bridge version can decline commands and file changes. Other permission types remain paused.','meta'));}
    article.append(livePanel);
  }
  const evidence = disclosure('Read the full report', article); evidence.append(node('p', card.result || 'No source result available.', 'source'));
  const provenance = disclosure('Source and delivery details', evidence);
  if(card.request?.desktopError)provenance.append(node('p',card.request.desktopError,'failure'));
  if(card.request?.desktopReceipt?.confirmed)provenance.append(node('p','The submitted prompt was visible in Codex. Its native turn receipt and work result remain unverified.','meta'));
  if(card.briefing?.sources)provenance.append(node('p',`Briefing sources: ${card.briefing.sources.join('\n')}`,'source meta'));
  if(priority)provenance.append(node('p',`Priority checked: ${priority.observedAt}\nExpires: ${priority.expiresAt}\n${priority.sources.join('\n')}`,'source meta'));
  provenance.append(node('p','Unread red badges are not exposed by the task API. Input labels use source requests and recorded decisions.','meta'));
  provenance.append(node('p', card.title), node('p', `Reported: ${card.resultTimestamp || card.sourceTimestamp || 'unknown'}\nObserved: ${card.observedAt}\nRuntime: ${card.runtime}; last turn: ${card.turnStatus}\n${card.hostId} / ${card.threadId}\n${card.checkout.cwd}`, 'source meta'));
  provenance.append(node('p', 'This is the source task’s report, not an independent verification of its work.', 'meta'), node('p', data.adapter, 'meta'));
  if (card.request) provenance.append(node('p', `Request: ${card.request.id}\nReceipt: ${card.request.receiptId || 'not attempted'}\n${card.delivery || 'Result returned'}`, 'source meta'));
  const held = ['parked','done'].includes(card.triage?.disposition) && !card.returned;
  if (card.delivery || !card.canContinue || held) {
    const message = card.delivery ? card.request?.status === 'uncertain' ? 'My delivery is being checked. I need a verified read-back before another prompt.' : card.request?.status === 'approved' ? card.bridgeBound ? 'Your direction is saved for the local bridge.' : 'Your direction is saved, waiting for the Codex relay.' : 'I’m away working on your last direction.' : held ? 'This chapter is resting. Give me a new direction in the original task when you want to reopen it.' : 'My latest task state needs checking before you can send another direction.';
    article.append(node('p', message, 'waiting'));
    if (card.request?.status === 'approved') { const cancel = node('button', 'Withdraw direction', 'quiet'); cancel.onclick = action(async () => { await api('cancel', { requestId: card.request.id }); await reload(); }); article.append(cancel); }
  }
  const enabled = !card.delivery && card.canContinue && !held;
  const heading = node('div', '', 'choice-heading'); heading.append(node('h3', 'Where do we go next?'), node('span', enabled ? 'Choose a path. Make it yours.' : 'Explore the next chapter.')); article.append(heading);
  const paths = pathsFor(card), choices = node('div', '', 'choices');
  paths.forEach((path, index) => {
    const button = node('button', '', `path${chosen === index ? ' picked' : ''}`); button.setAttribute('aria-pressed', String(chosen === index));
    button.append(node('kbd',String(index+1),'path-key'),node('span', ['↗','◎','⑂'][index], 'path-icon'), node('strong', path.title), node('span', path.description, 'path-description'));
    if(path.tradeoff)button.append(node('span',path.tradeoff,'path-cost'));
    if (path.recommended) button.append(node('small', 'Suggested', 'suggested'));
    button.onclick = () => { chosen = index; chosenTitle=path.title;reviewId = null; custom = path.prompt;keepDraft(); render(); $('prompt')?.focus(); }; choices.append(button);
  }); article.append(choices);
  const own = node('button', 'Do something else…', 'own'); own.onclick = () => { chosen = 'custom'; chosenTitle='My own direction';reviewId = null; custom = '';keepDraft(); render(); $('prompt')?.focus(); }; article.append(own);
  if (chosen !== undefined || reviewId) {
    const composer = node('section', '', 'composer'); article.append(composer);
    const label = node('label', 'Your next chapter'), prompt = node('textarea'); prompt.id = 'prompt'; prompt.value = custom; prompt.maxLength = 20000; label.append(prompt); composer.append(label);
    prompt.oninput = () => { custom = prompt.value; reviewId = null; composer.querySelector('.approval')?.remove();keepDraft(); };
    composer.append(node('p','Your draft stays here when you visit another pet. Nothing has been sent.','meta'));
    const discard=node('button','Discard unsent draft','quiet');discard.onclick=()=>{delete memory.visits[card.id];chosen=undefined;custom='';reviewId=null;persist();render();};composer.append(discard);
    if(memory.visits[card.id]?.revision!==card.revision)composer.append(node('p','The source has changed since this draft. Read the new report before continuing.','failure'));
    const copy=node('button','Copy prompt for Codex / Claude','quiet');copy.onclick=action(async()=>{await navigator.clipboard.writeText(prompt.value);$('notice').textContent='Prompt copied. Paste it into the original task to continue there.';});composer.append(copy);
    const draft = card.draft || {}, options = disclosure('Priority and dependencies', composer);
    const field = (title,value,type='text') => { const label = node('label',title), input = node('input'); input.type=type; input.value=value; if(type==='number'){input.min=0;input.max=3;} label.append(input); options.append(label); return input; };
    const importance = field('Importance · 0–3', draft.importance ?? card.triage?.importance ?? 1,'number'), urgency = field('Urgency · 0–3',draft.urgency ?? card.triage?.urgency ?? 0,'number');
    const reason = field('Reason',draft.reason || card.triage?.reason || 'Owner chose the next chapter.'), deps = field('Unresolved dependencies (card IDs)',(draft.dependencies || []).join(', '));
    for (const input of [importance,urgency,reason,deps]) input.oninput = () => { reviewId = null; composer.querySelector('.approval')?.remove(); };
    const save = node('button', 'Review direction', 'primary'); save.disabled = !enabled;
    save.onclick = action(async () => { const d = await api('draft', { cardId:card.id, prompt:prompt.value, decision: chosenTitle || paths[chosen]?.title || 'My own direction', reason:reason.value, importance:Number(importance.value), urgency:Number(urgency.value), dependencies:deps.value.split(',').map(x=>x.trim()).filter(Boolean) }); reviewId=d.id; selected=card.id; custom=prompt.value; await reload(); }); composer.append(save);
    if (!enabled) composer.append(node('p', 'You can edit these paths; sending is paused until this task is ready.', 'meta'));
    if (reviewId === draft.id && reviewId) {
      const approval = node('div', '', 'approval'); approval.append(node('h4', `Continue ${repoName(card)} with this direction?`), node('pre',draft.prompt));
      const target = disclosure('Destination',approval); target.append(node('p',`${card.title}\n${card.hostId} / ${card.threadId}\n${card.checkout.cwd}`,'source meta'));
      const send = node('button',data.desktop?.enabled?'Send to my Codex task now':'Approve direction','primary'); send.disabled = !!card.blockedBy.length;
      send.onclick = action(async () => { const result=await api(data.desktop?.enabled?'desktop-send':'approve',{cardId:card.id,draftId:draft.id,prompt:draft.prompt,destination:card.threadId}); delete memory.visits[card.id];persist();reviewId=null; chosen=undefined; await reload();if(result.submitted)$('notice').textContent='Codex displays your submitted prompt. Its work result has not been verified yet.'; }); approval.append(send,node('p',card.blockedBy.length ? 'Resolve dependencies before approving.' : data.desktop?.enabled?'Opens the linked Codex task and submits now. An existing draft stops delivery without being replaced.':card.bridgeBound ? 'The local bridge will continue this same Codex session.' : 'Saved for the active Codex relay to deliver to this same task.','meta')); composer.append(approval);
    }
  }
}
function renderMap(){
  const root=$('current');root.append(node('h2','Your world in progress','view-title'),node('p','Visit a companion. The map reflects the last recorded state.','meta'));
  const map=node('div','','world-map');
  for(const lane of ['Your turn','In motion','Waiting','Resting']){const group=node('section','','map-region');const cards=data.cards.filter(c=>mapLane(c)===lane);group.append(node('h3',`${lane} · ${cards.length}`));
    for(const card of cards){const b=node('button','','map-pet');b.append(pet(card,true),node('strong',repoName(card)),node('span',excerpt(card.triage?.nextAction || statusLabel(card),90)));b.onclick=()=>visit(card.id);group.append(b);}map.append(group);}
  root.append(map);
}
function renderJournal(){
  const root=$('current');root.append(node('h2','The story so far','view-title'),node('p','Drafts are intentions. Reports are what the source task says happened.','meta'));
  const list=node('div','','journal-list');
  for(const [cardId,saved] of Object.entries(memory.visits)){const card=data.cards.find(c=>c.id===cardId);if(!card)continue;const entry=node('article','','journal-entry');entry.append(node('small','Unsent draft'),node('h3',repoName(card)),node('p',excerpt(saved.prompt,150)));const b=node('button','Continue writing','quiet');b.onclick=()=>visit(cardId);entry.append(b);list.append(entry);}
  for(const event of data.journal||[]){const entry=node('article','','journal-entry');entry.append(node('small',`${event.type} · ${new Date(event.at).toLocaleDateString()}`),node('h3',event.title),node('p',event.text));const full=disclosure('Read entry',entry);full.append(node('p',event.detail,'source'));const b=node('button','Visit companion','quiet');b.onclick=()=>visit(event.cardId);entry.append(b);list.append(entry);}
  if(!list.childNodes.length)list.append(node('p','Your first report or saved direction will appear here.'));root.append(list);
}
for(const name of ['play','map','journal'])$(`nav-${name}`).onclick=()=>{keepDraft();mode=name;reviewId=null;persist();render();window.scrollTo(0,0);};
document.addEventListener('keydown',event=>{const index=choiceKey(event);if(mode==='play' && index!==null){const button=document.querySelectorAll('.path')[index];if(button){event.preventDefault();button.click();}}});
$('refresh').onclick = action(reload);
action(reload)();
// Refresh observations without invoking models or replacing an in-progress edit.
setInterval(()=>{if(chosen===undefined && !reviewId && !document.hidden)action(reload)();},3000);
