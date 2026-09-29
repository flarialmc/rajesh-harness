import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { Schedules } from '../src/schedules.js';
const base=()=>({dataDir:'/example/data',secretsDir:'/example/secrets',codex:'/example/codex',codexHome:'/example/codex-home',workspaces:{research:'/example/research'},routes:[{account:'bot',guild:'guild',channel:'channel',workspace:'research',model:'model',effort:'medium'}]});
test('arbitrary workspace names and explicit WhatsApp routing are supported',()=>{
 const config=parseConfig({...base(),whatsappGroup:'group@g.us',whatsappWorkspace:'research',whatsappAccount:'mobile',whatsappModel:'model',whatsappEffort:'low'});
 assert.equal(config.whatsappWorkspace,'research');assert.equal(config.timezone,'UTC');assert.equal(config.concurrency,2);
});
test('invalid, ambiguous and path-traversing configuration is rejected',()=>{
 assert.throws(()=>parseConfig({...base(),workspaces:{'../outside':'/example'}}));
 assert.throws(()=>parseConfig({...base(),dataDir:'relative'}));
 assert.throws(()=>parseConfig({...base(),workspaces:{other:'/example'}}),/unknown workspace/);
 assert.throws(()=>parseConfig({...base(),whatsappGroup:'group@g.us'}),/WhatsApp requires/);
 assert.throws(()=>parseConfig({...base(),routes:[...base().routes,...base().routes]}),/Duplicate/);
 assert.throws(()=>parseConfig({...base(),timezone:'invalid/timezone'}));
 assert.throws(()=>parseConfig({...base(),unrecognized:true}));
});
test('schedule timezone defaults to operator configuration and can be overridden',t=>{
 const dir=mkdtempSync(join(tmpdir(),'timezone-test-')),store=new Store(dir);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const task={key:'task',workspace:'research',platform:'discord',account:'bot',channel:'channel',parent:'channel',model:'model',effort:'medium',thread:null,cwd:dir,status:'done'};store.saveTask(task);
 const schedules=new Schedules(store,'Europe/London');
 const now=Date.parse('2026-01-01T00:00:00Z');
 const first:any=schedules.command(task,{action:'create',name:'daily',prompt:'Check project',cron:'0 9 * * *'},now);
 assert.equal(first.timezone,'Europe/London');
 const second:any=schedules.command(task,{action:'create',name:'explicit',prompt:'Check project',cron:'0 9 * * *',timezone:'UTC'},now);
 assert.equal(second.timezone,'UTC');
});
