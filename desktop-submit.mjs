import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export function runDesktop(request, root) {
  if(process.platform!=='win32')return Promise.reject(new Error('Desktop submission requires Windows.'));
  const directory=path.resolve(root,'../desktop-submissions');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${randomUUID()}.json`);fs.writeFileSync(file,JSON.stringify(request),{mode:0o600});
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-STA','-File',fileURLToPath(new URL('./desktop-submit.ps1',import.meta.url)),'-RequestFile',file],{windowsHide:true,timeout:30000,maxBuffer:1024*1024},(error,stdout)=>{
    let result;try{result=JSON.parse(stdout.trim());}catch{reject(new Error('Desktop helper did not return a receipt. Inspect before retrying.'));return;}
    if(error || !result.ok){const failure=new Error(result.error || 'Desktop submission failed');failure.receipt=result;reject(failure);return;}
    resolve(result);
  }));
}

export class DesktopSubmitter {
  constructor(queue,run=runDesktop){this.queue=queue;this.run=run;this.busy=false;}
  async send(input) {
    if(this.busy)throw new Error('Another desktop submission is in progress.');
    this.busy=true;
    const lock=path.resolve(this.queue.root,'../desktop-submit.lock');let fd,request;
    try {
      fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
      const card=this.queue.state().cards.find(c=>c.id===input.cardId);
      if(!card || card.threadId!==input.destination || card.draft?.id!==input.draftId || card.draft?.prompt!==input.prompt)throw new Error('Exact reviewed draft and destination required.');
      const existing=this.queue.state().requests.find(r=>r.cardId===card.id && r.status!=='cancelled' && !this.queue.returned(r,card));
      if(existing)throw new Error('This task already has an outstanding request. Inspect its receipt; do not resend.');
      const probe=await this.run({mode:'probe',threadId:card.threadId},this.queue.root);
      if(!probe.ok || !probe.emptyDraft || probe.threadId!==card.threadId || Date.now()-Date.parse(probe.observedAt)>10000 || Date.parse(probe.observedAt)>Date.now()+5000 || !Number.isFinite(Date.parse(probe.observedAt)))throw new Error('Fresh destination and empty composer verification required.');
      request=this.queue.approve(card.id,input.draftId,input.prompt,input.destination,'Owner clicked immediate desktop submission of the exact reviewed prompt');
      this.queue.transact((state,append)=>{
        const current=state.cards.find(c=>c.id===card.id);
        if(current.revision!==request.revision)throw new Error('Task changed during desktop preparation.');
        append('claimed',{id:request.id,status:'uncertain',receiptId:randomUUID(),attemptedAt:new Date().toISOString(),transport:'desktop-ui'});
      });
      const receipt=await this.run({mode:'submit',threadId:card.threadId,prompt:request.prompt},this.queue.root);
      if(receipt.threadId!==card.threadId || !receipt.submitted || !receipt.confirmed)throw new Error('No matching desktop submission receipt. Do not resend.');
      this.queue.transact((state,append)=>append('toolResponse',{id:request.id,desktopReceipt:receipt}));
      return {requestId:request.id,submitted:true,receipt};
    } catch(error) {
      if(request)this.queue.transact((state,append)=>append('toolResponse',{id:request.id,desktopError:error.message,desktopReceipt:error.receipt || null}));
      throw error;
    } finally {
      if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}this.busy=false;
    }
  }
}
