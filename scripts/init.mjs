import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
const { values }=parseArgs({options:{codex:{type:'string'},model:{type:'string'},effort:{type:'string',default:'medium'},workspace:{type:'string'},'codex-home':{type:'string'},help:{type:'boolean'}}});
if(values.help||!values.codex||!values.model){console.log('pnpm setup --codex /absolute/path/to/codex --model MODEL [--effort medium] [--workspace PATH] [--codex-home PATH]');process.exit(values.help?0:1);}
process.umask(0o077);
const config={dataDir:resolve('.local/data'),secretsDir:resolve('.local/secrets'),codex:resolve(values.codex),codexHome:resolve(values['codex-home']??join(homedir(),'.codex')),workspaces:{default:resolve(values.workspace??'workspace')},routes:[{account:'main',guild:'YOUR_DISCORD_GUILD_ID',channel:'YOUR_DISCORD_CHANNEL_ID',workspace:'default',model:values.model,effort:values.effort,requireMention:true}],whatsappGroup:'',concurrency:2,timezone:'UTC',agent:{name:'Rajesh',sandbox:'workspace-write'}};
writeFileSync('config.json',JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
for(const path of [config.dataDir,config.secretsDir,config.workspaces.default])mkdirSync(path,{recursive:true,mode:0o700});
writeFileSync(join(config.secretsDir,'credentials.json'),JSON.stringify({discord:{}},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(`Created private config.json and empty credentials. Replace the route guild/channel placeholders and add a Discord token for account main; examples/config.example.json shows the fields. Nothing is connected yet.`);
