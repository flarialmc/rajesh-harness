import { mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,lstatSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './redact.js';

export class Skills {
  lock:DatabaseSync;
  constructor(public folder:string){mkdirSync(folder,{recursive:true,mode:0o700});this.lock=new DatabaseSync(join(folder,'.lock.sqlite'));this.lock.exec('PRAGMA busy_timeout=10000');}
  path(name:string) {
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)||name.length>63)throw new Error('Use a skill name under 64 characters with lowercase letters, digits and hyphens.');
    const folder=join(this.folder,name),path=join(folder,'SKILL.md');
    for(const entry of [folder,path])if(existsSync(entry)&&lstatSync(entry).isSymbolicLink())throw new Error('Skill paths cannot be symlinks');
    return path;
  }
  read(name:string) {
    const path=this.path(name),text=readFileSync(path,'utf8');
    const match=text.match(/^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---\r?\n([\s\S]*)$/);
    if(!match)throw new Error('Invalid SKILL.md frontmatter');
    const decode=(value:string)=>{try{return JSON.parse(value);}catch{return value;}};
    return {name,description:decode(match[2]),instructions:match[3].trim(),revision:createHash('sha256').update(text).digest('hex'),path};
  }
  list(query='') {
    const skills=[];
    for(const entry of readdirSync(this.folder,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.name.startsWith('.')||!existsSync(join(this.folder,entry.name,'SKILL.md')))continue;
      const {instructions,...skill}=this.read(entry.name);
      if(!query||`${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))skills.push(skill);
      if(skills.length===100)return {skills,truncated:true};
    }
    return {skills,truncated:false};
  }
  write(name:string,description:string,instructions:string,expected?:string) {
    this.lock.exec('BEGIN IMMEDIATE');
    try {
      const path=this.path(name);
      if(existsSync(path)){if(this.read(name).revision!==expected)throw new Error('Skill changed; read it before updating.');}
      else if(expected)throw new Error('Skill no longer exists');
      description=redact(description.trim());instructions=redact(instructions.trim());
      if(!description||description.length>500||!instructions||instructions.length>24000)throw new Error('Use a description of 1–500 characters and instructions of 1–24000 characters.');
      const git=(...args:string[])=>execFileSync('git',['-C',this.folder,...args],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']}).trim();
      if(!existsSync(join(this.folder,'.git')))git('init','-b','main');
      if(!existsSync(join(this.folder,'.gitignore')))writeFileSync(join(this.folder,'.gitignore'),'.lock.sqlite*\n*.tmp-*\n',{mode:0o600});
      mkdirSync(join(this.folder,name),{recursive:true,mode:0o700});
      const temp=path+'.tmp-'+randomUUID();
      writeFileSync(temp,`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`,{mode:0o600});renameSync(temp,path);
      git('add','--','.gitignore',`${name}/SKILL.md`);
      if(git('diff','--cached','--name-only','--',`${name}/SKILL.md`,'.gitignore'))git('-c','user.name=Rajesh','-c','user.email=rajesh@localhost','commit','--only','-m',`Save skill ${name}`,'--',`${name}/SKILL.md`,'.gitignore');
      const result={...this.read(name),gitCommit:git('rev-parse','HEAD')};this.lock.exec('COMMIT');return result;
    }catch(e){this.lock.exec('ROLLBACK');throw e;}
  }
}
