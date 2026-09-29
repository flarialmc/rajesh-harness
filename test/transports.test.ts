import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { WhatsAppAdapter } from '../src/whatsapp.js';
import { DiscordAdapter } from '../src/discord.js';
import { Engine } from '../src/engine.js';
import type { Config } from '../src/config.js';
import { discordReplyToBot,whatsappReplyToBot,markWhatsappReplyInvoked } from '../src/reply-triggers.js';
import { mentioned } from '../src/whatsapp.js';

function setup(t:any) {
  const dir=mkdtempSync(join(tmpdir(),'transport-test-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const config={dataDir:dir,whatsappGroup:'secondary@g.us',whatsappWorkspace:'secondary',whatsappAccount:'secondary',whatsappModel:'test-model',whatsappEffort:'low',routes:[{account:'default',workspace:'default',guild:'guild',channel:'parent',model:'other-model',effort:'xhigh'}]} as Config;
  const calls:any[]=[];const engine={submit:async(...args:any[])=>{calls.push(args);store.saveTask(args[0]);},command:async()=>false} as unknown as Engine;
  return {store,config,engine,calls};
}
test('WhatsApp records ordinary group messages, ignores DMs and invokes only on mentions',async t=>{
  const {store,config,engine,calls}=setup(t);const adapter=new WhatsAppAdapter(config,store,engine);adapter.socket={user:{id:'self@s.whatsapp.net'}} as any;
  const m=(id:string,group:string,mention=false)=>({key:{id,remoteJid:group,participant:'human@s.whatsapp.net'},messageTimestamp:1,message:mention?{extendedTextMessage:{text:'@self thoughts?',contextInfo:{mentionedJid:['self@s.whatsapp.net']}}}:{conversation:'Discussing income'}} as any);
  await adapter.receive(m('dm','person@s.whatsapp.net',true),true);
  await adapter.receive(m('other','other@g.us',true),true);
  await adapter.receive(m('ordinary',config.whatsappGroup),true);
  await adapter.receive(m('ping',config.whatsappGroup,true),true);
  await adapter.receive(m('ping',config.whatsappGroup,true),true);
  assert.equal(calls.length,1);assert.equal(calls[0][0].model,'test-model');assert.equal(calls[0][0].effort,'low');
  assert.equal(store.recent('secondary',config.whatsappGroup).length,2);
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get()!.n,2);
});
test('Discord duplicate pings create one native thread and replies reuse task',async t=>{
  const {store,config,engine,calls}=setup(t);const adapter=new DiscordAdapter(config,store,engine);
  adapter.clients.set('default',{user:{id:'bot'},channels:{fetch:async()=>null}} as any);
  let created=0;
  const author={id:'human',displayName:'Human',bot:false};
  const message:any={id:'ping',guildId:'guild',channelId:'parent',content:'<@bot> thoughts?',author,createdTimestamp:1,mentions:{users:{has:()=>true}},attachments:new Map(),channel:{isThread:()=>false},thread:null,startThread:async()=>{created++;return {id:'thread'};}};
  await adapter.receive('default',message);await adapter.receive('default',message);
  assert.equal(created,1);assert.equal(calls.length,1);assert.equal(calls[0][0].model,'other-model');
  await adapter.receive('default',{...message,id:'reply',channelId:'thread',content:'Follow up',mentions:{users:{has:()=>false}},channel:{isThread:()=>true,parentId:'parent'}});
  assert.equal(calls.length,2);assert.equal(calls[1][0].key,calls[0][0].key);
});
test('definitely unsent messages remain pending, ambiguous failures are not replayed',async t=>{
  const {store,config}=setup(t);const engine=new Engine(config,store);const task:any={key:'test',workspace:'default',platform:'discord',account:'default',channel:'thread',parent:'parent',model:'test',effort:'low',thread:null,cwd:'test',status:'done'};store.saveTask(task);
  engine.sender=async()=>{throw Object.assign(new Error('disconnected'),{notSent:true});};await engine.tell(task,'hello','one');
  assert.equal(store.db.prepare('SELECT state FROM deliveries WHERE id=?').get('one')!.state,'pending');
  engine.sender=async()=>{throw new Error('connection lost after sending');};await engine.flushDeliveries();
  assert.equal(store.db.prepare('SELECT state FROM deliveries WHERE id=?').get('one')!.state,'uncertain');
  let sent=0;engine.sender=async()=>{sent++;return 'id';};await engine.flushDeliveries();assert.equal(sent,0);
});

test('WhatsApp plain /new works in the enabled group, is deduplicated and follow-ups select the new conversation',async t=>{
  const {store,config,engine,calls}=setup(t);const adapter=new WhatsAppAdapter(config,store,engine);adapter.socket={user:{id:'123@s.whatsapp.net'}} as any;
  let created=0;adapter.newConversation=async()=>{created++;};
  const message=(id:string,group=config.whatsappGroup,mention=true,text='@123 /new')=>({key:{id,remoteJid:group,participant:'human'},message:{extendedTextMessage:{text,contextInfo:{mentionedJid:mention?['123@s.whatsapp.net']:[]}}}} as any);
  await adapter.receive(message('dm','dm@s.whatsapp.net'),true);await adapter.receive(message('ordinary',undefined,false,'ordinary text'),true);
  assert.equal(created,0);
  await adapter.receive(message('new',undefined,false,'/new'),true);await adapter.receive(message('new',undefined,false,'/new'),true);assert.equal(created,1);
  await adapter.receive(message('follow',undefined,true,'@123 hello'),true);
  assert.equal(calls[0][0].key,`whatsapp:${config.whatsappGroup}:new`);assert.equal(store.meta(`waConversation:${config.whatsappGroup}`),calls[0][0].key);
});
test('Discord replies invoke only when the referenced author is this bot',async()=>{
 const message:any={author:{bot:false},reference:{messageId:'original'},fetchReference:async()=>({author:{id:'bot'}})};
 assert.equal(await discordReplyToBot(message,'bot'),true);assert.equal(await discordReplyToBot(message,'other'),false);
 assert.equal(await discordReplyToBot({...message,author:{bot:true}},'bot'),false);
});
test('WhatsApp replies recognize bot PN/LID identities and preserve quoted context when invoking pinned adapters',t=>{
 const {store}=setup(t);const message:any={key:{remoteJid:'group@g.us'},message:{extendedTextMessage:{text:'follow up',contextInfo:{stanzaId:'reply',participant:'123:4@s.whatsapp.net',quotedMessage:{conversation:'prior response'}}}}};
 assert.equal(whatsappReplyToBot(message,['123@s.whatsapp.net'],store),true);
 assert.equal(whatsappReplyToBot(message,['other@s.whatsapp.net'],store),false);
 markWhatsappReplyInvoked(message,'123@s.whatsapp.net');assert.equal(mentioned(message,['123@s.whatsapp.net']),true);
 assert.equal(message.message.extendedTextMessage.contextInfo.quotedMessage.conversation,'prior response');
});

for(const quoted of [false,true])test(`WhatsApp downloads ${quoted?'quoted':'captioned'} documents before submission`,async t=>{
  const {store,config,engine,calls}=setup(t);const adapter=new WhatsAppAdapter(config,store,engine);
  adapter.socket={user:{id:'123@s.whatsapp.net'}} as any;
  let downloads=0;adapter.downloadAttachment=async()=>{downloads++;return Readable.from([Buffer.from('zip-content')]) as any;};
  const document={documentMessage:{fileName:'../../archive.zip',caption:'@123 analyze this zip',contextInfo:{mentionedJid:['123@s.whatsapp.net']}}};
  const message:any={key:{id:'upload',remoteJid:config.whatsappGroup,participant:'human'},message:quoted?{extendedTextMessage:{text:'@123 analyze this zip',contextInfo:{mentionedJid:['123@s.whatsapp.net'],stanzaId:'original',quotedMessage:document}}}:{documentWithCaptionMessage:{message:document}}};
  await adapter.receive(message,true);await adapter.receive(message,true);
  assert.equal(calls.length,1);assert.equal(downloads,1);
  const prompt=calls[0][2];assert.match(prompt,/analyze this zip/);
  const path=JSON.parse(prompt.match(/Local file: ("[^"\n]+")/)[1]);
  assert.ok(path.startsWith(join(calls[0][0].cwd,'attachments')+'/'));
  assert.equal(readFileSync(path,'utf8'),'zip-content');
  assert.equal(store.db.prepare('SELECT state FROM inbox').get()!.state,'done');
});
test('WhatsApp reports attachment download failure and skips downloads for uninvoked history',async t=>{
  const {config,store,engine,calls}=setup(t);const adapter=new WhatsAppAdapter(config,store,engine);
  adapter.socket={user:{id:'123@s.whatsapp.net'}} as any;
  let downloads=0;adapter.downloadAttachment=async()=>{downloads++;throw new Error('private transport details');};
  const message:any={key:{id:'file',remoteJid:config.whatsappGroup},message:{documentMessage:{fileName:'archive.zip',caption:'@123 analyze',contextInfo:{mentionedJid:['123@s.whatsapp.net']}}}};
  await adapter.receive(message,false);assert.equal(downloads,0);
  await adapter.receive(message,true);assert.equal(downloads,1);
  assert.match(calls[0][2],/attachment.*archive.zip/);assert.match(calls[0][2],/Download failed/);
  assert.doesNotMatch(calls[0][2],/private transport details/);
});

test('Discord suppresses standalone NO_REPLY without contacting Discord',async t=>{
  const {store,config,engine}=setup(t);const adapter=new DiscordAdapter(config,store,engine);
  const task:any={account:'default',channel:'thread'};
  for(const text of ['NO_REPLY','  NO_REPLY \n'])assert.equal(await adapter.send(task,text,'silent'),'');
  const sent:string[]=[];
  adapter.clients.set('default',{isReady:()=>true,channels:{fetch:async()=>({isSendable:()=>true,isThread:()=>false,send:async({content}:any)=>{sent.push(content);return {id:'message'};}})}} as any);
  for(const text of ['Hello','The response was NO_REPLY','NO_REPLY\nMore text'])assert.equal(await adapter.send(task,text,'normal'),'message');
  assert.deepEqual(sent,['Hello','The response was NO_REPLY','NO_REPLY\nMore text']);
});
test('Discord permits only the schedule allowlist to receive automated mentions',async t=>{
 const {store,config,engine}=setup(t);const adapter=new DiscordAdapter(config,store,engine);const task:any={key:'scheduled:test',account:'default',channel:'thread'};const payloads:any[]=[];
 store.meta(`scheduleRun:${task.key}`,{mentionUserIds:['111111111111111111']});
 adapter.clients.set('default',{isReady:()=>true,channels:{fetch:async()=>({isSendable:()=>true,isThread:()=>false,send:async(payload:any)=>{payloads.push(payload);return {id:'message'};}})}} as any);
 await adapter.send(task,'<@111111111111111111> scheduled update <@123456789012345678>','mention');
 assert.deepEqual(payloads[0].allowedMentions,{parse:[],users:['111111111111111111']});
});
