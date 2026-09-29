import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { forceStop } from '../src/stop.js';

test('force stop kills descendants even when a tool created a separate process group',{skip:process.platform!=='linux'},async()=>{
  const child=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const tool=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(tool.pid);setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore'],detached:true});
  let tool=0;
  try {
    tool=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Child startup timeout')),5000);child.stdout!.once('data',v=>{clearTimeout(timer);resolve(Number(String(v).trim()));});});
    assert.ok(tool>0);forceStop(child);
    const alive=(pid:number)=>{try{return !['Z','X'].includes(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[0]);}catch{return false;}};
    for(let i=0;i<50&&(alive(child.pid!)||alive(tool));i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(alive(child.pid!),false);assert.equal(alive(tool),false);
  }finally{try{child.kill('SIGKILL');}catch{}if(tool)try{process.kill(tool,'SIGKILL');}catch{}}
});
