import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rpc } from './rpc.js';
import { loadConfig, type Config } from './config.js';

const exec=promisify(execFile);
const required=['thread/start','thread/resume','turn/start','turn/steer','turn/interrupt','thread/compact/start'];
export async function probe(binary:string,config:Config,withSchema=true) {
  binary=realpathSync(binary);
  await exec(binary,['--version'],{timeout:30000});
  if(withSchema) {
    const folder=join(config.dataDir,'schema-check',String(Date.now()));mkdirSync(folder,{recursive:true});
    await exec(binary,['app-server','generate-json-schema','--out',folder],{timeout:60000,maxBuffer:1024*1024});
    const files=(path:string):string=>readdirSync(path,{withFileTypes:true}).map(e=>e.isDirectory()?files(join(path,e.name)):readFileSync(join(path,e.name),'utf8')).join('\n');
    const schema=files(folder);
    for(const method of required)if(!schema.includes(`"${method}"`))throw new Error(`Missing protocol method ${method}`);
  }
  const rpc=new Rpc(binary,[],{...process.env,CODEX_HOME:config.codexHome});
  try {
    await rpc.initialize();
    const account=await rpc.request('account/read',{refreshToken:false});
    if(!account.account)throw new Error('Codex is not authenticated');
    const models:any[]=[];let cursor:string|null=null;
    do {const page=await rpc.request('model/list',{includeHidden:true,cursor});models.push(...page.data);cursor=page.nextCursor??null;}while(cursor);
    for(const route of [...config.routes,...(config.whatsappGroup?[{model:config.whatsappModel!,effort:config.whatsappEffort!}]:[])]) {
      const model=models.find(m=>m.model===route.model||m.id===route.model);
      if(!model)throw new Error(`Unavailable configured model: ${route.model}`);
      if(!model.supportedReasoningEfforts?.some((e:any)=>e.reasoningEffort===route.effort))throw new Error(`Unsupported reasoning: ${route.model}/${route.effort}`);
    }
    await rpc.request('thread/start',{cwd:config.dataDir,approvalPolicy:'never',sandbox:config.agent?.sandbox ?? 'workspace-write',ephemeral:true,config:{'memories.generate_memories':false,'memories.use_memories':false}});
    return models.map(m=>({id:m.id,model:m.model,efforts:m.supportedReasoningEfforts?.map((e:any)=>e.reasoningEffort)}));
  } finally {rpc.close();}
}
