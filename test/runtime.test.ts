import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { Store, type Task } from '../src/store.js';
import { Revisions, fingerprint } from '../src/revisions.js';
import { Runtime } from '../src/runtime.js';
import type { Config } from '../src/config.js';

function fixture(t:any) {
  const root=mkdtempSync(join(tmpdir(),'runtime-test-')),source=join(root,'source'),data=join(root,'data');
  mkdirSync(join(source,'src'),{recursive:true});mkdirSync(join(source,'test'));
  const config:Config={dataDir:data,secretsDir:root,codex:process.execPath,codexHome:root,workspaces:{default:root,secondary:root},routes:[],whatsappGroup:'group@g.us',whatsappWorkspace:'secondary',whatsappAccount:'secondary',whatsappModel:'test-model',whatsappEffort:'low',concurrency:1};
  writeFileSync(join(source,'config.json'),JSON.stringify(config));
  for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json'])writeFileSync(join(source,file),'{}');
  writeFileSync(join(source,'package.json'),JSON.stringify({type:'module'}));
  const engineUrl=pathToFileURL(fileURLToPath(new URL('../src/engine.ts',import.meta.url))).href;
  const storeUrl=pathToFileURL(fileURLToPath(new URL('../src/store.ts',import.meta.url))).href;
  const engine=(marker:string)=>`import {Engine as Base} from ${JSON.stringify(engineUrl)}; export class Engine extends Base {marker=${JSON.stringify(marker)}}`;
  writeFileSync(join(source,'src','engine.ts'),engine('A'));
  writeFileSync(join(source,'src','store.ts'),`export {Store} from ${JSON.stringify(storeUrl)}`);
  for(const name of ['discord','whatsapp'])writeFileSync(join(source,'src',name+'.ts'),'export {}');
  writeFileSync(join(source,'src','redact.ts'),'export function loadRedactions(){}');
  const store=new Store(data),reports:any[]=[];
  const revisions=new Revisions(source,config,v=>reports.push(v));
  revisions.validate=async path=>{if(readFileSync(join(path,'src','engine.ts'),'utf8').includes('BROKEN'))throw new Error('invalid candidate');};
  const runtime=new Runtime(revisions,store);
  t.after(async()=>{await runtime.shutdown();for(const modules of runtime.modules.values())(await modules).store.close();store.close();rmSync(root,{recursive:true,force:true});});
  const task=(key:string):Task=>({key,workspace:'default',platform:'discord',account:'default',channel:key,parent:'channel',model:'model',effort:'low',thread:null,cwd:join(root,key),status:'queued'});
  return {root,source,config,store,revisions,runtime,task,engine,reports};
}
class FakeRpc extends EventEmitter {
  async initialize(){}
  async request(method:string){if(method.startsWith('thread/'))return {thread:{id:'conversation'}};return {turn:{id:'turn'}};}
  close(){}respond(){}reject(){}
  complete(){this.emit('notification',{method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});}
}
const settle=()=>new Promise(r=>setTimeout(r,40));

test('published TS modules and config stay pinned across edits and runtime reconstruction',async t=>{
  const f=fixture(t);const a=await f.runtime.latest(),old=f.task('old');f.store.saveTask(old);
  const before=await f.runtime.get(old,a);assert.equal((before as any).marker,'A');
  const pinnedBinary=before.config.codex;
  const newBinary=join(f.root,'new-codex');writeFileSync(newBinary,'placeholder');
  writeFileSync(join(f.source,'config.json'),JSON.stringify({...f.config,codex:newBinary,concurrency:2}));
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));
  const b=await f.runtime.latest();assert.notEqual(a.id,b.id);
  assert.equal((await f.runtime.get(old) as any).marker,'A');assert.equal(before.config.codex,pinnedBinary);
  const fresh=f.task('fresh');f.store.saveTask(fresh);const after=await f.runtime.get(fresh,b);
  assert.equal((after as any).marker,'B');assert.equal(after.config.codex,newBinary);
  const reconstructed=new Runtime(new Revisions(f.source,f.config,()=>{}),f.store);
  const resumed=await reconstructed.get(old);assert.equal((resumed as any).marker,'A');assert.equal(resumed.config.codex,pinnedBinary);
  await reconstructed.shutdown();for(const modules of reconstructed.modules.values())(await modules).store.close();
});

test('invalid edits retain last good revision, valid draft publishes, stale draft cannot overwrite it',async t=>{
  const f=fixture(t);const a=await f.runtime.latest();
  const first=f.revisions.prepare('task'),stale=f.revisions.prepare('task');
  writeFileSync(join(first.path,'src','engine.ts'),f.engine('B'));
  const b=await f.revisions.publish('task',first.path);assert.notEqual(a.id,b.id);assert.equal(fingerprint(f.source),b.id);
  await assert.rejects(f.revisions.publish('task',stale.path),/Stale/);
  writeFileSync(join(f.source,'src','engine.ts'),'BROKEN');
  assert.equal((await f.runtime.latest()).id,b.id);assert.equal(f.reports.at(-1).state,'rejected');
  const recovered=new Revisions(f.source,f.config,()=>{});assert.equal(recovered.current?.id,b.id);
});

test('published revisions get Git commits while private data and rejected source stay out of history',async t=>{
 const f=fixture(t),a=await f.runtime.latest();
 const git=(...args:string[])=>execFileSync('git',['-C',f.source,...args],{encoding:'utf8'}).trim();
 assert.equal(git('rev-parse','HEAD'),a.gitCommit);
 mkdirSync(join(f.source,'.secrets'));writeFileSync(join(f.source,'.secrets','token'),'private');
 mkdirSync(join(f.source,'storage'));writeFileSync(join(f.source,'storage','data'),'private');
 const draft=f.revisions.prepare('task');writeFileSync(join(draft.path,'src','engine.ts'),f.engine('B'));
 const b=await f.revisions.publish('task',draft.path);
 assert.equal(git('rev-parse','HEAD'),b.gitCommit);assert.notEqual(a.gitCommit,b.gitCommit);
 assert.equal(git('rev-parse','HEAD^'),a.gitCommit);
 assert.ok(git('show','HEAD:src/engine.ts').includes('"B"'));assert.ok(!git('ls-files').includes('.secrets'));assert.ok(!git('ls-files').includes('storage'));assert.ok(!git('ls-files').split('\n').includes('config.json'));assert.ok(readFileSync(join(b.path,'config.json'),'utf8').includes(f.config.dataDir));
 writeFileSync(join(f.source,'src','engine.ts'),'BROKEN');assert.equal((await f.runtime.latest()).id,b.id);assert.equal(git('rev-parse','HEAD'),b.gitCommit);
});

test('publication preserves staged human edits and rejects known credentials',async t=>{
 const f=fixture(t),a=await f.runtime.latest();const git=(...args:string[])=>execFileSync('git',['-C',f.source,...args],{encoding:'utf8'}).trim();
 writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));git('add','src/engine.ts');
 assert.equal((await f.runtime.latest()).id,a.id);assert.equal(git('diff','--cached','--name-only'),'src/engine.ts');assert.equal(git('rev-parse','HEAD'),a.gitCommit);
 git('reset','--','src/engine.ts');
 const credential='private-test-token-12345678901234567890';writeFileSync(join(f.root,'credentials.json'),JSON.stringify({token:credential}));
 writeFileSync(join(f.source,'src','engine.ts'),f.engine(credential));assert.equal((await f.runtime.latest()).id,a.id);assert.equal(git('rev-parse','HEAD'),a.gitCommit);
});

test('isolated engines share the global concurrency limit and active old turns survive publication',async t=>{
  const f=fixture(t);const a=await f.runtime.latest();const one=f.task('one'),two=f.task('two');f.store.saveTask(one);f.store.saveTask(two);
  const e1=await f.runtime.get(one,a),e2=await f.runtime.get(two,a),rpc1=new FakeRpc(),rpc2=new FakeRpc();
  e1.rpcFactory=()=>rpc1 as any;e2.rpcFactory=()=>rpc2 as any;
  await e1.submit(one,'one','go');await settle();await e2.submit(two,'two','go');await settle();
  assert.equal(f.runtime.active,1);assert.equal(e2.running.size,0);assert.equal(f.store.pending().length,1);
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));await f.runtime.latest();
  assert.equal(e1.running.size,1);assert.equal((e1 as any).marker,'A');
  rpc1.complete();await settle();await f.runtime.drain();await settle();assert.equal(e2.running.size,1);assert.equal(f.runtime.active,1);
});


test('/stop force-closes only its task, cancels queued input and allows a new prompt',async t=>{
 const f=fixture(t),revision=await f.runtime.latest(),one=f.task('one'),two=f.task('two');f.store.saveTask(one);f.store.saveTask(two);
 const e1=await f.runtime.get(one,revision),e2=await f.runtime.get(two,revision);let closed=0;
 const rpc=new FakeRpc();rpc.close=()=>{closed++;};e1.rpcFactory=()=>rpc as any;e2.rpcFactory=()=>new FakeRpc() as any;
 await e1.submit(one,'first','go');await settle();f.store.enqueue(one.key,'queued','do more');f.store.enqueue(two.key,'other','go');
 assert.match(await f.runtime.stopTask(one.key),/Stopped/);assert.equal(closed,1);assert.equal(e1.running.size,0);assert.equal(f.store.task(one.key)!.status,'interrupted');
 assert.ok(f.store.db.prepare('SELECT state FROM jobs WHERE task=?').all(one.key).every(r=>r.state==='cancelled'));
 assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE task=?').get(two.key)!.state,'queued');
 rpc.complete();await settle();assert.equal(f.store.task(one.key)!.status,'interrupted');
 e1.rpcFactory=()=>new FakeRpc() as any;await e1.submit(one,'new','try again');await settle();assert.equal(e1.running.size,1);assert.equal(f.store.task(one.key)!.thread,'conversation');
});
