import { readFileSync,readdirSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

// Tool commands may create separate process groups. Include descendants rather
// than only killing the app-server group, and freeze parents before walking.
export function forceStop(child?:ChildProcess) {
  if(!child?.pid)return;
  const root=child.pid;
  if(process.platform!=='linux'){child.kill('SIGKILL');return;}
  const signal=(pid:number,kind:NodeJS.Signals)=>{try{process.kill(pid,kind);}catch(e:any){if(e.code!=='ESRCH')throw e;}};
  const descendants:number[]=[];
  const freeze=(pid:number)=>{
    signal(pid,'SIGSTOP');descendants.push(pid);
    for(const name of readdirSync('/proc')) {
      if(!/^\d+$/.test(name))continue;
      let parent:number;
      try{const stat=readFileSync(`/proc/${name}/stat`,'utf8');parent=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);}catch{continue;}
      if(parent===pid)freeze(Number(name));
    }
  };
  try{freeze(root);}finally{for(const pid of descendants.reverse())signal(pid,'SIGKILL');}
}
