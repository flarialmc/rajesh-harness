import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store,type Task,eventId } from './store.js';
import { redact } from './redact.js';

export const scheduleInput={
  action:z.enum(['list','create','update','pause','resume','delete','run']),
  id:z.string().optional(),name:z.string().min(1).max(120).optional(),
  prompt:z.string().min(1).max(12000).optional(),
  cron:z.string().optional(),at:z.string().optional(),timezone:z.string().optional(),
  model:z.string().min(1).max(120).optional(),effort:z.string().min(1).max(40).optional(),
  mention_user_ids:z.array(z.string().regex(/^\d{17,20}$/)).max(20).optional(),
  output:z.enum(['chat','silent','webhook']).optional(),webhook:z.string().url().optional(),
};
const schema=z.object(scheduleInput);
type Input=z.infer<typeof schema>;
interface Schedule {id:string;origin:string;name:string;prompt:string;cron:string|null;at:string|null;timezone:string;model:string|null;effort:string|null;mentionUserIds:string|null;output:string;webhook:string|null;enabled:number;next:number|null}
export function nextOccurrence(cron:string,timezone:string,now:number) {
  if(cron.trim().split(/\s+/).length!==5)throw new Error('Use a five-field cron expression, with minute precision.');
  new Intl.DateTimeFormat('en',{timeZone:timezone}).format();
  return CronExpressionParser.parse(cron,{tz:timezone,currentDate:now}).next().getTime();
}
export class Schedules {
  constructor(public store:Store,public timezone='UTC') {
    store.db.exec(`CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,origin TEXT,name TEXT,prompt TEXT,cron TEXT,at TEXT,timezone TEXT,output TEXT,webhook TEXT,enabled INTEGER,next INTEGER,UNIQUE(origin,name));
      CREATE TABLE IF NOT EXISTS schedule_runs(id TEXT PRIMARY KEY,schedule TEXT,task TEXT UNIQUE,due INTEGER,state TEXT,output TEXT,webhook TEXT,folder TEXT,UNIQUE(schedule,due));`);
    const columns=store.db.prepare('PRAGMA table_info(schedules)').all() as {name:string}[];
    if(!columns.some(column=>column.name==='model'))store.db.exec('ALTER TABLE schedules ADD COLUMN model TEXT');
    if(!columns.some(column=>column.name==='effort'))store.db.exec('ALTER TABLE schedules ADD COLUMN effort TEXT');
    if(!columns.some(column=>column.name==='mentionUserIds'))store.db.exec('ALTER TABLE schedules ADD COLUMN mentionUserIds TEXT');
  }
  view(row:Schedule){const {webhook,mentionUserIds,...safe}=row;return {...safe,mention_user_ids:JSON.parse(mentionUserIds??'[]'),webhookConfigured:!!webhook,next:row.next?new Date(row.next).toISOString():null};}
  command(origin:Task,raw:unknown,now=Date.now()) {
    const input=schema.parse(raw);
    if(input.action==='list')return this.store.db.prepare('SELECT * FROM schedules WHERE origin=?').all(origin.key).map(row=>({...this.view(row as unknown as Schedule),runs:this.store.db.prepare('SELECT id,task,due,state,folder FROM schedule_runs WHERE schedule=? ORDER BY due DESC LIMIT 5').all(row.id)}));
    if(input.action==='create') {
      if(!input.name||!input.prompt)throw new Error('A name and self-contained task prompt are required.');
      const prior=this.store.db.prepare('SELECT * FROM schedules WHERE origin=? AND name=?').get(origin.key,input.name);
      if(prior)return {existing:true,...this.view(prior as unknown as Schedule)};
      const row=this.validate({id:randomUUID(),origin:origin.key,name:input.name,prompt:input.prompt,cron:null,at:null,timezone:input.timezone??this.timezone,model:null,effort:null,mentionUserIds:null,output:'chat',webhook:null,enabled:1,next:null},input,now);
      this.store.db.prepare('INSERT INTO schedules (id,origin,name,prompt,cron,at,timezone,output,webhook,enabled,next,model,effort,mentionUserIds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id,row.origin,row.name,row.prompt,row.cron,row.at,row.timezone,row.output,row.webhook,row.enabled,row.next,row.model,row.effort,row.mentionUserIds);
      return this.view(row);
    }
    const row=this.store.db.prepare('SELECT * FROM schedules WHERE id=? AND origin=?').get(input.id??'',origin.key) as unknown as Schedule|undefined;
    if(!row)throw new Error('Schedule not found in this conversation. List schedules to get its ID.');
    if(input.action==='delete'){this.store.db.prepare('DELETE FROM schedules WHERE id=?').run(row.id);return {deleted:row.id};}
    if(input.action==='pause'){this.store.db.prepare('UPDATE schedules SET enabled=0 WHERE id=?').run(row.id);return {paused:row.id};}
    if(input.action==='run'){return this.enqueue(row,now);}
    const updated=this.validate(row,input,now);updated.enabled=1;
    this.store.db.prepare('UPDATE schedules SET name=?,prompt=?,cron=?,at=?,timezone=?,model=?,effort=?,mentionUserIds=?,output=?,webhook=?,enabled=?,next=? WHERE id=?').run(updated.name,updated.prompt,updated.cron,updated.at,updated.timezone,updated.model,updated.effort,updated.mentionUserIds,updated.output,updated.webhook,updated.enabled,updated.next,row.id);
    return this.view(updated);
  }
  validate(row:Schedule,input:Input,now:number):Schedule {
    const next={...row};
    for(const field of ['name','prompt','model','effort','output','webhook'] as const)if(input[field]!==undefined)next[field]=input[field]!;
    if(input.mention_user_ids!==undefined)next.mentionUserIds=JSON.stringify(input.mention_user_ids);
    // Keep an existing timezone unless the caller supplied a replacement.
    if(input.timezone!==undefined)next.timezone=input.timezone;
    if(input.cron!==undefined){next.cron=input.cron;next.at=null;}
    if(input.at!==undefined){if(input.cron!==undefined)throw new Error('Choose cron or at, not both.');next.at=input.at;next.cron=null;}
    if(next.cron)next.next=nextOccurrence(next.cron,next.timezone,now);
    else if(next.at&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(next.at)&&Number.isFinite(Date.parse(next.at))&&Date.parse(next.at)>now)next.next=Date.parse(next.at);
    else throw new Error('Provide a recurring cron or future ISO at timestamp with an explicit UTC offset.');
    if(next.output==='webhook'){
      if(!next.webhook||!['http:','https:'].includes(new URL(next.webhook).protocol))throw new Error('Webhook output requires an HTTP(S) URL.');
    }else next.webhook=null;
    next.prompt=redact(next.prompt);if(next.webhook)next.prompt=next.prompt.split(next.webhook).join('[configured webhook]');return next;
  }
  enqueue(row:Schedule,due:number) {
    return this.store.transaction(()=>{
      const existing=this.store.db.prepare('SELECT id,task,state,folder FROM schedule_runs WHERE schedule=? AND due=?').get(row.id,due);if(existing)return existing;
      const busy=this.store.db.prepare("SELECT task FROM schedule_runs WHERE schedule=? AND state IN ('queued','running')").get(row.id);
      if(busy)return {skipped:'Previous run is still queued or running',task:busy.task};
      const origin=this.store.task(row.origin);if(!origin)throw new Error('Originating conversation is missing');
      const id=eventId(row.id,String(due)),key=`scheduled:${id}`,folder=join(this.store.dir,'schedules','runs',id);
      mkdirSync(folder,{recursive:true,mode:0o700});
      const task={...origin,key,thread:null,cwd:join(folder,'work'),status:'queued',model:row.model??origin.model,effort:row.effort??origin.effort};
      this.store.saveTask(task);
      this.store.db.prepare("INSERT INTO schedule_runs VALUES (?,?,?,?,'queued',?,?,?)").run(id,row.id,key,due,row.output,row.webhook,folder);
      this.store.meta(`scheduleRun:${key}`,{id,origin:row.origin,output:row.output,folder,mentionUserIds:JSON.parse(row.mentionUserIds??'[]')});
      this.store.enqueue(key,`scheduled:${id}`,`Scheduled task: ${row.name}\nRun independently using this task description. Save any artifacts under ${folder}. Follow the usual worktree rules for code changes. Final output is ${row.output==='chat'?'delivered to the originating chat automatically':row.output==='webhook'?'posted to the configured webhook automatically; do not post it yourself':'saved locally only; perform any explicitly requested external delivery yourself'}.\n\n${row.prompt}`);
      return {id,task:key,state:'queued',folder};
    });
  }
  tick(now=Date.now()) {
    this.store.db.exec(`UPDATE schedule_runs SET state=COALESCE((SELECT state FROM jobs WHERE task=schedule_runs.task ORDER BY id DESC LIMIT 1),state) WHERE state IN ('queued','running','steering');`);
    for(const row of this.store.db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next<=?').all(now) as unknown as Schedule[]) {
      this.store.transaction(()=>{
        this.enqueue(row,row.next!);
        // Coalesce missed occurrences into one run, never replay a backlog of commands.
        this.store.db.prepare('UPDATE schedules SET next=?,enabled=? WHERE id=?').run(row.cron?nextOccurrence(row.cron,row.timezone,now):null,row.cron?1:0,row.id);
      });
    }
  }
  async deliver(task:Task,text:string,id:string,chat:(task:Task,text:string,id:string)=>Promise<string>) {
    const row=this.store.db.prepare('SELECT * FROM schedule_runs WHERE task=?').get(task.key) as any;
    if(!row)throw new Error('Missing scheduled run');
    writeFileSync(join(row.folder,`${eventId(id)}.md`),redact(text),{mode:0o600});
    if(id.startsWith('codex:'))writeFileSync(join(row.folder,'output.md'),redact(text),{mode:0o600});
    if(row.output==='chat')return chat(task,text,id);
    if(row.output==='webhook') {
      const response=await fetch(row.webhook,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({content:redact(text)}),signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
    }
    return `scheduled:${row.id}:${eventId(id)}`;
  }
}
