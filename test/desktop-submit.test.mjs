import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {DesktopSubmitter} from '../desktop-submit.mjs';
function setup(t,run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pet-desktop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const card={id:'card',threadId:'task',revision:'v',draft:{id:'draft',prompt:'Bounded fictional check'}};
 const state={cards:[card],requests:[]};
 const queue={root:path.join(dir,'queue'),state:()=>state,returned:()=>false,approve(){const r={id:'request',cardId:'card',revision:'v',status:'approved',prompt:card.draft.prompt};state.requests.push(r);return r;},transact(fn){return fn(state,(type,payload)=>Object.assign(state.requests[0],payload));}};
 return {sender:new DesktopSubmitter(queue,run),state,input:{cardId:'card',draftId:'draft',destination:'task',prompt:card.draft.prompt}};
}
test('a nonempty or inaccessible desktop composer never creates an approved request',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;throw new Error('Existing draft');});
 await assert.rejects(f.sender.send(f.input),/Existing draft/);assert.equal(f.state.requests.length,0);assert.equal(calls,1);
});
test('desktop calls are exact, journaled before submit, and never retried after uncertainty',async t=>{
 let f;const calls=[];f=setup(t,async request=>{calls.push(request);if(request.mode==='probe')return {ok:true,emptyDraft:true,threadId:'task',observedAt:new Date().toISOString()};assert.equal(f.state.requests[0].status,'uncertain');assert.equal(request.prompt,f.input.prompt);throw new Error('Lost confirmation');});
 await assert.rejects(f.sender.send(f.input),/Lost confirmation/);await assert.rejects(f.sender.send(f.input),/outstanding request/);assert.equal(calls.length,2);
});
test('wrong identity and changed reviewed text stop before submission',async t=>{
 const f=setup(t,async()=>({ok:true,emptyDraft:true,threadId:'wrong',observedAt:new Date().toISOString()}));
 await assert.rejects(f.sender.send({...f.input,prompt:'Different wording'}),/Exact reviewed/);
 await assert.rejects(f.sender.send(f.input),/verification required/);assert.equal(f.state.requests.length,0);
});
