import test from 'node:test';
import assert from 'node:assert/strict';
import {rankedCards,nextAfterCooking,confirmedCooking,briefingFor,inputNeeded,freshPriority} from '../queue-ui/briefing.mjs';
const now=Date.now();
const card=(id,rank=1)=>({id,state:'completed',runtime:'idle',turnStatus:'completed',turnId:'before',observedAt:new Date(now).toISOString(),priorityContext:{rank,reason:'Dated evidence',sources:['fictional priority handoff'],observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString()}});
test('queue respects sourced rank and skips cooking, parked and externally blocked projects',()=>{
 const a=card('a',2),b=card('b',1),parked={...card('p',0),triage:{disposition:'parked'}},blocked={...card('x',0),blockedBy:['a']};
 assert.deepEqual(rankedCards([a,blocked,parked,b],now).slice(0,2).map(c=>c.id),['b','a']);
 assert.equal(freshPriority({...b,priorityContext:{...b.priorityContext,expiresAt:new Date(now-1).toISOString()}},now),null);
});
test('advancing requires the same approved receipt, matching active turn and fresh observation',()=>{
 const before={...card('a'),request:{id:'receipt',status:'approved'}};
 const working={...before,request:{id:'receipt',status:'accepted',turnId:'new'},turnId:'new',state:'running',runtime:'active',turnStatus:'inProgress'};
 assert.equal(nextAfterCooking(before,[working,card('b')],now).id,'b');
 for(const change of [{request:{id:'receipt',status:'uncertain'}},{request:{id:'other',status:'accepted',turnId:'new'}},{turnId:'unrelated'},{activeFlags:['waitingOnUserInput']},{observedAt:new Date(now-61000).toISOString()},{turnStatus:'completed'}])assert.equal(nextAfterCooking(before,[{...working,...change},card('b')],now),null);
 assert.equal(nextAfterCooking(working,[working,card('b')],now),null);
 assert.equal(confirmedCooking(before,now),false);
});
test('unknown facts and unread status are not invented',()=>{
 assert.equal(inputNeeded({...card('a'),runtime:'notLoaded'}),false);
 assert.match(briefingFor(card('a')).blocker,/No current blocker/);
 assert.match(briefingFor(card('a')).ideal,/needs a documented definition/);
 assert.equal(inputNeeded({...card('a'),briefing:{needsInput:true}}),true);
});
