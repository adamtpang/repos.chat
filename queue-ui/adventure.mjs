import { excerpt, repoName } from './story.mjs';
export function mapLane(card) {
  if(['parked','done'].includes(card.triage?.disposition))return 'Resting';
  if(card.delivery || card.state==='running')return 'In motion';
  if(card.triage?.disposition==='external blocker' || card.blockedBy?.length)return 'Waiting';
  return 'Your turn';
}
export function readMemory(raw) {
  try {const x=JSON.parse(raw);if(x?.version!==1)return {version:1,visits:{}};
    const visits={};for(const [id,v] of Object.entries(x.visits||{})){if(v && typeof v.prompt==='string' && v.prompt.length<=20000 && typeof v.title==='string')visits[id]={prompt:v.prompt,title:v.title,revision:v.revision};}
    return {version:1,selected:typeof x.selected==='string'?x.selected:undefined,mode:['play','map','journal'].includes(x.mode)?x.mode:'play',visits};
  }catch{return {version:1,visits:{}};}
}
export function choiceKey(event) {
  if(event.ctrlKey||event.metaKey||event.altKey||event.repeat)return null;
  if(event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY|A)$/.test(event.target?.tagName||''))return null;
  return /^[123]$/.test(event.key)?Number(event.key)-1:null;
}
export function journalEntries(events) {
  const entries=[],seen=new Set();
  for(const e of events){const p=e.payload;
    if(e.type==='snapshot' && p.result && p.resultTurnId){
      const key=`${p.id}:${p.resultTurnId}:${p.result}`;if(seen.has(key))continue;seen.add(key);
      entries.push({id:e.id,cardId:p.id,at:p.resultTimestamp || p.sourceTimestamp || e.at,type:'Report',title:repoName(p),text:excerpt(p.result,240),detail:p.result});
    }
    if(e.type==='draft')entries.push({id:e.id,cardId:p.cardId,at:e.at,type:'Draft',title:p.decision,text:excerpt(p.prompt,160),detail:p.prompt});
    if(e.type==='approved')entries.push({id:e.id,cardId:p.cardId,at:e.at,type:'Direction approved',title:'Queued for delivery',text:excerpt(p.prompt,160),detail:p.prompt});
  }
  return entries.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).slice(0,100);
}
