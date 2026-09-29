import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store,type Task } from '../src/store.js';
import { Schedules,nextOccurrence } from '../src/schedules.js';
const now=Date.parse('2026-09-08T00:00:00Z');
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'schedules-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const task:Task={key:'origin',workspace:'secondary',platform:'discord',account:'secondary',channel:'thread',parent:'parent',model:'model',effort:'low',thread:'codex-original',cwd:dir,status:'done'};store.saveTask(task);return {store,task,schedules:new Schedules(store)};}
test('schedules are timezone-aware, idempotent, scoped and preserve schedule edits',t=>{
 const {store,task,schedules}=setup(t);
 assert.equal(nextOccurrence('0 9 * * *','Australia/Sydney',now),Date.parse('2026-09-08T23:00:00Z'));
 assert.throws(()=>nextOccurrence('* * * * * *','UTC',now),/five-field/);
 const created:any=schedules.command(task,{action:'create',name:'daily',prompt:'Check project',cron:'0 9 * * *'},now);
 assert.equal(created.output,'chat');assert.equal(created.next,'2026-09-08T09:00:00.000Z');
 const again:any=schedules.command(task,{action:'create',name:'daily',prompt:'Check project',cron:'0 9 * * *'},now);assert.equal(again.id,created.id);assert.equal(again.existing,true);
 assert.throws(()=>schedules.command({...task,key:'foreign'},{action:'pause',id:created.id},now),/not found/);
 schedules.command(task,{action:'pause',id:created.id},now);assert.equal((schedules.command(task,{action:'list'}) as any[])[0].enabled,0);
 schedules.command(task,{action:'update',id:created.id,prompt:'New instructions',output:'silent',model:'test-model',effort:'medium',mention_user_ids:['111111111111111111']},now);
 const updated=store.db.prepare('SELECT * FROM schedules').get()!;assert.equal(updated.prompt,'New instructions');assert.equal(updated.output,'silent');assert.equal(updated.cron,'0 9 * * *');assert.equal(updated.model,'test-model');assert.equal(updated.effort,'medium');assert.equal(updated.mentionUserIds,'["111111111111111111"]');
});
test('due jobs survive reconstruction, do not overlap or replay interrupted executions, and keep origin routing',t=>{
 const {store,task,schedules}=setup(t);schedules.command(task,{action:'create',name:'minute',prompt:'Check project',cron:'* * * * *'},now);
 schedules.tick(now+60000);new Schedules(store).tick(now+60000);assert.equal(store.pending().length,1);
 const job=store.pending()[0],run=store.task(job.task)!;assert.equal(run.channel,'thread');assert.equal(run.thread,null);assert.notEqual(run.cwd,task.cwd);assert.equal(run.model,task.model);assert.equal(run.effort,task.effort);
 schedules.tick(now+120000);assert.equal(store.pending().length,1);
 store.jobState(job.id,'running');store.recover();schedules.tick(now+180000);
 assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)!.state,'interrupted');assert.equal(store.pending().length,1);assert.notEqual(store.pending()[0].task,job.task);
 assert.equal(store.db.prepare('SELECT state FROM schedule_runs WHERE task=?').get(job.task)!.state,'interrupted');
});
test('scheduled model overrides are isolated from the originating conversation',t=>{
 const {store,task,schedules}=setup(t);const created:any=schedules.command(task,{action:'create',name:'luna',prompt:'Check project',cron:'* * * * *',model:'test-model',effort:'medium'},now);
 assert.equal(created.model,'test-model');assert.equal(created.effort,'medium');
 schedules.tick(now+60000);const run=store.task(store.pending()[0].task)!;assert.equal(run.model,'test-model');assert.equal(run.effort,'medium');assert.equal(task.model,'model');assert.equal(task.effort,'low');
});
test('scheduled output uses its originating platform, silent jobs stay local and webhooks never post in chat',async t=>{
 const {store,task,schedules}=setup(t);const sent:any[]=[];const chat=async(task:Task,text:string)=>{sent.push({platform:task.platform,channel:task.channel,text});return 'sent';};
 const originalFetch=globalThis.fetch;let webhookBody='';globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://example.test/hook');webhookBody=String(init?.body);return new Response('ok');};t.after(()=>{globalThis.fetch=originalFetch;});
 for(const output of ['chat','silent','webhook']){
   const created:any=schedules.command(task,{action:'create',name:output,prompt:'Say done',cron:'0 9 * * *',output,...(output==='webhook'?{webhook:'https://example.test/hook'}:{})},now);
   assert.ok(!JSON.stringify(created).includes('example.test'));
   const run:any=schedules.command(task,{action:'run',id:created.id},now);
   await schedules.deliver(store.task(run.task)!,'Done',`codex:${run.id}`,chat);
   assert.equal(readFileSync(join(run.folder,'output.md'),'utf8'),'Done');
 }
 assert.deepEqual(sent,[{platform:'discord',channel:'thread',text:'Done'}]);assert.equal(JSON.parse(webhookBody).content,'Done');
 task.platform='whatsapp';task.channel='group@g.us';store.saveTask(task);
 const wa:any=schedules.command(task,{action:'create',name:'wa',prompt:'Say done',at:'2026-09-08T00:01:00Z'},now);schedules.tick(now+60000);
 const row=store.db.prepare('SELECT task FROM schedule_runs WHERE schedule=?').get(wa.id)!;
 await schedules.deliver(store.task(String(row.task))!,'WhatsApp result','codex:wa',chat);assert.equal(sent.at(-1).platform,'whatsapp');assert.equal(sent.at(-1).channel,'group@g.us');
 assert.equal(store.db.prepare('SELECT enabled FROM schedules WHERE id=?').get(wa.id)!.enabled,0);
});
