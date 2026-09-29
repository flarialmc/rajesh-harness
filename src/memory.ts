import { mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { redact } from './redact.js';
import { DatabaseSync } from 'node:sqlite';
export class Memory {
  lock:DatabaseSync;
  constructor(public folder:string){mkdirSync(folder,{recursive:true,mode:0o700});this.lock=new DatabaseSync(join(folder,'.lock.sqlite'));this.lock.exec('PRAGMA busy_timeout=5000');}
  guarded<T>(fn:()=>T){this.lock.exec('BEGIN IMMEDIATE');try{const value=fn();this.lock.exec('COMMIT');return value;}catch(e){this.lock.exec('ROLLBACK');throw e;}}
  path(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid memory ID');return join(this.folder,id+'.json');}
  read(query='') {
    let characters=0;const notes=[];
    for(const file of readdirSync(this.folder).filter(f=>f.endsWith('.json')).sort()) {
      const note=JSON.parse(readFileSync(join(this.folder,file),'utf8'));
      if(query&&!note.text.toLowerCase().includes(query.toLowerCase()))continue;
      if(characters+note.text.length>16000)return {notes,truncated:true};
      characters+=note.text.length;notes.push(note);
    }
    return {notes,truncated:false};
  }
  write(text:string,id:string=randomUUID(),expected?:string) {
    return this.guarded(()=>{
    const path=this.path(id);text=redact(text.trim());if(!text||text.length>12000)throw new Error('Memory must contain 1–12000 characters');
    if(existsSync(path)) {
      const prior=JSON.parse(readFileSync(path,'utf8'));if(expected!==prior.revision)throw new Error('Memory changed; read it again before updating');
    }else if(expected)throw new Error('Memory no longer exists');
    const revision=createHash('sha256').update(text).digest('hex');const note={id,text,revision,updated:new Date().toISOString()};
    const temp=path+'.tmp-'+randomUUID();writeFileSync(temp,JSON.stringify(note),{mode:0o600});renameSync(temp,path);return note;
    });
  }
  delete(id:string,expected:string){return this.guarded(()=>{const path=this.path(id);const prior=JSON.parse(readFileSync(path,'utf8'));if(expected!==prior.revision)throw new Error('Memory changed; read it again');unlinkSync(path);return {deleted:id};});}
}
