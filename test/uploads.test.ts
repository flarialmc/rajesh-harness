import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { queueUpload } from '../src/uploads.js';
import { DiscordAdapter } from '../src/discord.js';
import { WhatsAppAdapter } from '../src/whatsapp.js';
import { discordAttachments } from '../src/attachments.js';

function setup(t:any,platform='discord') {
 const dir=mkdtempSync(join(tmpdir(),'uploads-'));const store=new Store(dir);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const task:any={key:'task',workspace:'secondary',platform,account:'secondary',channel:'chat',parent:'chat',cwd:dir,model:'model',effort:'low',status:'done',thread:null};store.saveTask(task);
 return {dir,store,task};
}
for(const platform of ['discord','whatsapp'])test(`${platform} sends a queued snapshot as a native file and reuses delivery status`,async t=>{
 const {dir,store,task}=setup(t,platform);writeFileSync(join(dir,'report.txt'),'original');
 const result:any=await queueUpload(store,task,{path:'report.txt',request_id:'report',caption:'Your report',mime_type:'text/plain'});
 writeFileSync(join(dir,'report.txt'),'changed');
 const row:any=store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(result.id);
 let payload:any,options:any;
 if(platform==='discord'){
  const adapter=new DiscordAdapter({} as any,store,{} as any);
  adapter.clients.set('secondary',{isReady:()=>true,channels:{fetch:async()=>({isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{payload=p;return {id:'remote'};}})}} as any);
  assert.equal(await adapter.send(task,row.text,row.id),'remote');
  assert.equal(readFileSync(payload.files[0].attachment,'utf8'),'original');assert.equal(payload.files[0].name,'report.txt');assert.deepEqual(payload.allowedMentions,{parse:[]});assert.equal(payload.content,'Your report');
 }else{
  store.meta('whatsapp',{ready:true});const adapter=new WhatsAppAdapter({} as any,store,{} as any);
  adapter.socket={sendMessage:async(channel:string,p:any,o:any)=>{assert.equal(channel,'chat');payload=p;options=o;return {key:{id:'remote'}};}} as any;
  assert.equal(await adapter.send(task,row.text,row.id),'remote');assert.equal(readFileSync(payload.document.url,'utf8'),'original');assert.equal(payload.fileName,'report.txt');assert.equal(payload.mimetype,'text/plain');assert.ok(options.messageId);
 }
 store.db.prepare("UPDATE deliveries SET state='sent',external='remote' WHERE id=?").run(row.id);
 const again:any=await queueUpload(store,task,{path:'missing',request_id:'report'});assert.equal(again.state,'sent');assert.equal(again.external,'remote');assert.equal(store.db.prepare('SELECT count(*) n FROM deliveries').get()!.n,1);
});
test('upload rejects directories and oversized files before queueing',async t=>{
 const {dir,store,task}=setup(t);await assert.rejects(queueUpload(store,task,{path:dir,request_id:'dir'}),/regular file/);
 writeFileSync(join(dir,'large'),Buffer.alloc(10*1024*1024+1));await assert.rejects(queueUpload(store,task,{path:'large',request_id:'large'}),/10 MiB/);
 assert.equal(store.db.prepare('SELECT count(*) n FROM deliveries').get()!.n,0);
});
test('Discord downloads attachments safely, caches them, and reports failures',async t=>{
 const {dir}=setup(t);let downloads=0;
 t.mock.method(globalThis,'fetch',async()=>{downloads++;return new Response('document content');});
 const message:any={id:'m',attachments:new Map([['a',{id:'a',name:'../../report.txt',size:16,url:'https://cdn.discordapp.com/attachments/a'}]])};
 const prompt=await discordAttachments(message,dir);const path=JSON.parse(prompt.match(/Local file: ("[^"\n]+")/)![1]);assert.ok(path.startsWith(join(dir,'attachments')+'/'));assert.equal(readFileSync(path,'utf8'),'document content');
 await discordAttachments(message,dir);assert.equal(downloads,1);
 message.attachments.set('b',{id:'b',name:'private',size:1,url:'https://localhost/secret'});
 assert.match(await discordAttachments(message,dir),/Download failed/);assert.equal(downloads,1);
});
for(const quoted of [false,true])test(`Discord submits local ${quoted?'quoted':'direct'} attachment paths on thread replies`,async t=>{
 const {dir,store,task}=setup(t);task.key='discord:secondary:chat';store.saveTask(task);
 let submitted='';const engine:any={command:async()=>false,submit:async(_task:any,_id:any,prompt:string)=>{submitted=prompt;}};
 const adapter=new DiscordAdapter({routes:[{account:'secondary',workspace:'secondary',guild:'guild',channel:'parent'}]} as any,store,engine);
 adapter.clients.set('secondary',{user:{id:'bot'}} as any);
 t.mock.method(globalThis,'fetch',async()=>new Response('file bytes'));
 const file={id:'attachment',name:'file.txt',size:10,url:'https://cdn.discordapp.com/attachments/file'};
 const message:any={id:'reply',guildId:'guild',channelId:'chat',content:'read file',author:{displayName:'User',id:'user',bot:false},createdTimestamp:1,channel:{isThread:()=>true,parentId:'parent'},attachments:new Map(quoted?[]:[['a',file]]),reference:quoted?{messageId:'original'}:undefined,fetchReference:async()=>({id:'original',author:{displayName:'User'},content:'file here',attachments:new Map([['a',file]])})};
 await adapter.receive('secondary',message);
 assert.match(submitted,/Local file:/);const path=JSON.parse(submitted.match(/Local file: ("[^"\n]+")/)![1]);assert.equal(readFileSync(path,'utf8'),'file bytes');
});
for(const format of ['png','jpeg'])for(const presentation of ['auto','document'] as const)test(`WhatsApp ${format} ${presentation} selects native image or explicit document`,async t=>{
 const {dir,store,task}=setup(t,'whatsapp');
 const bytes=format==='png'?Buffer.from('89504e470d0a1a0a00000000','hex'):Buffer.from('ffd8ffe000000000','hex');
 writeFileSync(join(dir,'generated'),bytes);
 const result:any=await queueUpload(store,task,{path:'generated',request_id:'image',caption:'Generated image',presentation});
 const row:any=store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(result.id);
 const adapter=new WhatsAppAdapter({} as any,store,{} as any);store.meta('whatsapp',{ready:true});let payload:any;
 adapter.socket={sendMessage:async(_channel:string,p:any)=>{payload=p;return {key:{id:'image-remote'}};}} as any;
 assert.equal(await adapter.send(task,row.text,row.id),'image-remote');
 assert.equal(payload.mimetype,format==='png'?'image/png':'image/jpeg');assert.equal(payload.caption,'Generated image');
 if(presentation==='auto'){assert.ok(payload.image);assert.equal(payload.document,undefined);assert.deepEqual(readFileSync(payload.image.url),bytes);}
 else{assert.ok(payload.document);assert.equal(payload.image,undefined);}
});
test('unsupported image formats cannot be forced into WhatsApp image payloads',async t=>{
 const {dir,store,task}=setup(t,'whatsapp');writeFileSync(join(dir,'fake.png'),'plain text');
 await assert.rejects(queueUpload(store,task,{path:'fake.png',request_id:'fake',presentation:'image'}),/PNG or JPEG/);
 const result:any=await queueUpload(store,task,{path:'fake.png',request_id:'auto'});
 const row:any=store.db.prepare('SELECT text FROM deliveries WHERE id=?').get(result.id);assert.equal(JSON.parse(row.text).presentation,'document');
});
