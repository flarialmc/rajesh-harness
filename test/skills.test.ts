import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Skills } from '../src/skills.js';
test('agent skills persist across instances, stay workspace-scoped, reject stale writes and have Git history',t=>{
 const dir=mkdtempSync(join(tmpdir(),'skills-test-')),a=new Skills(join(dir,'default')),b=new Skills(join(dir,'secondary')),again=new Skills(join(dir,'default'));
 t.after(()=>{a.lock.close();b.lock.close();again.lock.close();rmSync(dir,{recursive:true,force:true});});
 const first=a.write('check-build','Check a project build when changing its build configuration.','Read the project-specific build instructions, then run its documented validation.');
 assert.ok(first.gitCommit);assert.match(readFileSync(first.path,'utf8'),/^---\nname:/);assert.equal(again.read(first.name).revision,first.revision);assert.equal(b.list().skills.length,0);
 const catalog=again.list('build');assert.equal(catalog.skills.length,1);assert.ok(!('instructions' in catalog.skills[0]));
 const second=again.write(first.name,first.description,'Read the build instructions. Run validation and report the command and result.',first.revision);
 assert.notEqual(second.gitCommit,first.gitCommit);assert.throws(()=>a.write(first.name,first.description,'Stale instructions',first.revision),/changed/);
 assert.throws(()=>a.write('../outside','Bad','Bad'),/name/);
 const git=(...args:string[])=>execFileSync('git',['-C',a.folder,...args],{encoding:'utf8'}).trim();
 assert.equal(git('rev-parse','HEAD^'),first.gitCommit);assert.ok(!git('ls-files').includes('.lock.sqlite'));assert.equal(git('status','--porcelain'),'');
});
