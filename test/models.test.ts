import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ModelCommands } from '../src/models.js';
import type { Config } from '../src/config.js';
function setup(t:any){
 const dir=mkdtempSync(join(tmpdir(),'models-test-')),store=new Store(dir);
 store.db.exec('CREATE TABLE runtime_bindings(task TEXT PRIMARY KEY,revision TEXT,configPath TEXT)');
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const config={codex:process.execPath,codexHome:dir,routes:[{account:'default',channel:'parent',guild:'guild',model:'luna',effort:'low'}]} as Config;
 const task:any={key:'task',workspace:'default',platform:'discord',account:'default',channel:'thread',parent:'parent',model:'luna',effort:'low',thread:'existing-conversation',cwd:dir,status:'done'};store.saveTask(task);
 const commands=new ModelCommands(config,store,()=>({initialize:async()=>{},request:async()=>({data:[{id:'luna',model:'luna',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]},{id:'sol',model:'sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]}],nextCursor:null}),close:()=>{}} as any));
 return {store,task,commands};
}
test('model commands validate exact models/reasoning and preserve the existing conversation',async t=>{
 const {store,commands}=setup(t);
 assert.match((await commands.run('/models','task'))!,/sol.*high/);
 assert.match((await commands.run('/model missing','task'))!,/Unavailable/);
 assert.match((await commands.run('/model sol low','task'))!,/Unsupported/);
 assert.equal(store.task('task')!.model,'luna');
 assert.match((await commands.run('/model sol xhigh','task'))!,/Model set/);
 assert.equal(store.task('task')!.model,'sol');assert.equal(store.task('task')!.effort,'xhigh');assert.equal(store.task('task')!.thread,'existing-conversation');
});
test('busy turns cannot change models, and channel defaults leave existing tasks unchanged',async t=>{
 const {store,commands}=setup(t);store.db.prepare("UPDATE tasks SET status='running'").run();
 assert.match((await commands.run('/model sol','task'))!,/Wait/);assert.equal(store.task('task')!.model,'luna');
 await commands.run('/model sol high',undefined,'modelDefault:discord:default:parent',{model:'luna',effort:'low'});
 assert.equal(store.meta('modelDefault:discord:default:parent').model,'sol');assert.equal(store.task('task')!.model,'luna');
});
test('status counts running and queued tasks and reports this chat model',async t=>{
 const {store,commands}=setup(t);store.db.prepare("UPDATE tasks SET status='running'").run();store.enqueue('task','pending','go');
 const status=await commands.run('/status','task');assert.match(status!,/Running tasks: 1/);assert.match(status!,/Queued tasks: 1/);assert.match(status!,/Model: luna \/ low/);
 assert.doesNotMatch(status!,/System:|CPU:|RAM:|Disk:|Uptime:/);
});
test('Discord slash commands reject unconfigured channels and defer configured requests',async t=>{
 const {commands}=setup(t);const replies:any[]=[];
 const i:any={isChatInputCommand:()=>true,commandName:'models',channelId:'other',guildId:'guild',channel:{isThread:()=>false},reply:async(v:any)=>replies.push(v),deferReply:async(v:any)=>replies.push(v),editReply:async(v:any)=>replies.push(v),options:{getString:()=>null}};
 await commands.interaction('default',i);assert.match(replies[0].content,/not enabled/);
 replies.length=0;i.channelId='parent';await commands.interaction('default',i);assert.equal(replies[0].flags,64);assert.match(replies[1],/Available models/);
});


test('Discord /stop is registered and targets only the current task thread',async t=>{
 const {commands,store,task}=setup(t);const registered:string[]=[];await commands.register({guilds:{fetch:async()=>({commands:{create:async(v:any)=>registered.push(v.name)}})}});assert.ok(registered.includes('stop'));
 task.key='discord:default:thread';store.saveTask(task);const stopped:string[]=[],replies:any[]=[];
 const i:any={isChatInputCommand:()=>true,commandName:'stop',channelId:'thread',guildId:'guild',channel:{isThread:()=>true,parentId:'parent'},deferReply:async()=>{},editReply:async(v:any)=>replies.push(v)};
 await commands.interaction('default',i,async key=>{stopped.push(key);return 'Stopped';});assert.deepEqual(stopped,[task.key]);assert.equal(replies[0],'Stopped');
});
