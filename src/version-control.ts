import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,openSync,closeSync,renameSync,unlinkSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const managed=['src','test','scripts','examples','docs','.github','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','README.md','.gitignore','AGENTS.md','LICENSE','SECURITY.md','CONTRIBUTING.md','tsconfig.tools.json'];
const privatePath=(path:string)=>path==='config.json'||/^(?:\.secrets|data|storage|\.runtime|node_modules|dist)(?:\/|$)/.test(path);
export function commitRevision(source:string,snapshot:string,id:string,files:string[],secretFiles:string[]=[]) {
  const git=(args:string[],env:NodeJS.ProcessEnv=process.env)=>execFileSync('git',['-C',source,...args],{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
  if(!existsSync(join(source,'.git')))git(['init','--initial-branch=main']);
  if(resolve(git(['rev-parse','--show-toplevel']))!==resolve(source))throw new Error('Expected a dedicated bot source repository');
  const gitDir=git(['rev-parse','--absolute-git-dir']);
  const lockPath=join(gitDir,'index.lock'),index=join(gitDir,'runtime-index-'+randomUUID());
  const lock=openSync(lockPath,'wx',0o600);closeSync(lock);
  try {
    const tracked=git(['ls-files','-z']).split('\0').filter(Boolean);
    if(tracked.some(privatePath))throw new Error('Private application data is tracked in Git; refusing publication');
    // Preserve a human's staged work instead of quietly including or resetting it.
    if(git(['diff','--cached','--name-only']))throw new Error('The source repository has staged changes; commit or unstage them before publishing');
    const secrets:string[]=[];
    const collect=(v:any):void=>{if(typeof v==='string'&&v.length>16)secrets.push(v);else if(v&&typeof v==='object')Object.values(v).forEach(collect);};
    for(const path of secretFiles)if(existsSync(path))collect(JSON.parse(readFileSync(path,'utf8')));
    for(const file of files.filter(file=>file!=='config.json')){if(privatePath(file.replaceAll('\\','/')))throw new Error('Private file in publication');const contents=readFileSync(join(snapshot,file),'utf8');if(secrets.some(secret=>contents.includes(secret)))throw new Error('Known credential found in source; refusing Git commit');}
    let previous:string|undefined;try{previous=git(['rev-parse','--verify','HEAD']);}catch{}
    const env={...process.env,GIT_INDEX_FILE:index,GIT_WORK_TREE:resolve(snapshot),GIT_AUTHOR_NAME:'Rajesh',GIT_AUTHOR_EMAIL:'rajesh@localhost',GIT_COMMITTER_NAME:'Rajesh',GIT_COMMITTER_EMAIL:'rajesh@localhost'};
    git(previous?['read-tree',previous]:['read-tree','--empty'],env);
    const paths=managed.filter(path=>existsSync(join(snapshot,path))||tracked.some(file=>file===path||file.startsWith(path+'/')));
    git(['add','-A','--',...paths],env);
    const staged=git(['ls-files','-z'],env).split('\0').filter(Boolean);
    if(staged.some(privatePath))throw new Error('Private file staged for publication');
    const tree=git(['write-tree'],env);
    if(previous&&git(['rev-parse',previous+'^{tree}'])===tree)return previous;
    const commit=git(['commit-tree',tree,...(previous?['-p',previous]:[]),'-m',`Publish bot runtime ${id.slice(0,12)}\n\nRuntime-Revision: ${id}`],env);
    git(['update-ref','HEAD',commit,previous??'0'.repeat(40)]);
    renameSync(index,join(gitDir,'index'));
    return commit;
  } finally {if(existsSync(index))unlinkSync(index);unlinkSync(lockPath);}
}
