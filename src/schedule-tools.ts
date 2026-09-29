import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request } from 'node:http';
import { scheduleInput } from './schedules.js';

async function control(action:string,input:unknown):Promise<any> {
 return new Promise((resolve,reject)=>{
  const req=request({socketPath:process.env.RAJESH_CONTROL,path:'/',method:'POST',headers:{'Content-Type':'application/json'}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{const value=JSON.parse(body);res.statusCode===200?resolve(value):reject(new Error(value.error));}catch(e){reject(e);}});});
  req.setTimeout(15000,()=>req.destroy(new Error('Request timed out; check saved state before retrying')));req.on('error',reject);req.end(JSON.stringify({action,task:process.env.RAJESH_TASK,input}));
 });
}
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const server=new McpServer({name:'rajesh-schedules',version:'1.0.0'});
server.registerTool('schedule_agent',{
  description:'Manage persistent headless Codex jobs when the user asks for scheduled work, reminders or monitoring. Interpret their request into a self-contained prompt and five-field cron plus IANA timezone, or a one-time ISO at timestamp. The default timezone is configured by the operator; pass an explicit IANA timezone when needed. Set model and effort when a schedule needs its own model configuration; otherwise it inherits the originating conversation. Set mention_user_ids only when the user explicitly authorizes a schedule to ping those Discord users. Output defaults to this WhatsApp group or Discord thread. Choose silent for no chat output or custom delivery performed by the agent; webhook automatically POSTs the final reply as JSON {content} to the URL. Runs have their own artifact folder, fresh conversation and worktrees. list shows IDs and recent runs; update/pause/resume/delete/run require an ID. Reuse existing jobs instead of creating duplicates. Pausing/deleting prevents future runs; /stop kills current runs.',
  inputSchema:scheduleInput,
},async input=>{
  return result(await control('schedule',input));
});
server.registerTool('list_skills',{description:'Discover reusable procedures saved by agents in this workspace. Lists names and descriptions only; read a skill when it is useful.',inputSchema:{query:z.string().optional()}},async input=>result(await control('skills',{action:'list',...input})));
server.registerTool('read_skill',{description:'Load a saved workspace skill when its procedure applies. Returns its revision for safe updates.',inputSchema:{name:z.string()}},async input=>result(await control('skills',{action:'read',...input})));
server.registerTool('write_skill',{description:'Save a useful reusable procedure for future agents in this workspace as a Git-versioned SKILL.md. Keep it focused on non-obvious steps and when to use them. Do not store credentials, chat transcripts or personal memory here. Personal memory still requires an explicit user request. Read an existing skill first and supply its revision to update it.',inputSchema:{name:z.string(),description:z.string().min(1).max(500),instructions:z.string().min(1).max(24000),revision:z.string().optional()}},async input=>result(await control('skills',{action:'write',...input})));

await server.connect(new StdioServerTransport());
