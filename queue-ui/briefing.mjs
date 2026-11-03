import {excerpt, repoName} from './story.mjs';

export function freshPriority(card, now=Date.now()) {
  const p=card.priorityContext;
  return p && Number.isFinite(p.rank) && p.rank>=0 && p.reason && p.sources?.length && Date.parse(p.expiresAt)>now && Date.parse(p.observedAt)<=now ? p : null;
}
export function inputNeeded(card) {
  return card.state==='needs decision' || card.activeFlags?.some(x=>/approval|input/i.test(x)) || card.briefing?.needsInput===true;
}
export function eligible(card) {
  return !['parked','done','external blocker'].includes(card.triage?.disposition) && !card.delivery && card.state!=='running' && card.state!=='unknown' && !card.blockedBy?.length;
}
export function rankedCards(cards, now=Date.now()) {
  return [...cards].sort((a,b)=>Number(eligible(b))-Number(eligible(a)) || (freshPriority(a,now)?.rank ?? 1000)-(freshPriority(b,now)?.rank ?? 1000) || Number(!!inputNeeded(b))-Number(!!inputNeeded(a)) || (b.priority||0)-(a.priority||0) || a.id.localeCompare(b.id));
}
export function confirmedCooking(card, now=Date.now()) {
  return card?.request?.status==='accepted' && card.request.turnId===card.turnId && card.runtime==='active' && card.turnStatus==='inProgress' && card.state==='running' && !inputNeeded(card) && now-Date.parse(card.observedAt)>=0 && now-Date.parse(card.observedAt)<60000;
}
export function nextAfterCooking(previous, cards, now=Date.now()) {
  const current=cards.find(c=>c.id===previous?.id);
  if(!previous?.request || previous.request.id!==current?.request?.id || confirmedCooking(previous,now) || !confirmedCooking(current,now))return null;
  return rankedCards(cards,now).find(c=>c.id!==current.id && eligible(c)) || null;
}
export function briefingFor(card) {
  const b=card.briefing || {};
  return {
    ideal:b.ideal || 'My ideal outcome still needs a documented definition.',
    current:b.current || `My last recorded task is ${card.turnStatus || 'unknown'}.`,
    blocker:b.blocker || (card.error ? excerpt(card.error,160) : inputNeeded(card) ? 'The source task needs your input. Open its pending request before answering.' : 'No current blocker has been verified.'),
    last:b.last || excerpt(card.result,220) || 'My last result is not readable yet.',
    prompt:card.lastPrompt ? excerpt(card.lastPrompt,160) : 'Latest prompt unavailable in this observation.',
    name:repoName(card),
  };
}
