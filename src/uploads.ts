import { createHash } from 'node:crypto';
import { open, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Store, Task } from './store.js';

export interface Upload {path:string;name:string;caption:string;mime:string;presentation?:'auto'|'image'|'document'}
export function decodeUpload(text:string,id:string):Upload|undefined {
  if(!id.startsWith('upload:'))return;
  const value=JSON.parse(text);
  if(!value.path||!value.name||typeof value.caption!=='string'||typeof value.mime!=='string')throw new Error('Invalid upload');
  return value;
}
export async function queueUpload(store:Store,task:Task,input:{path:string;request_id:string;filename?:string;caption?:string;mime_type?:string;presentation?:'auto'|'image'|'document'}) {
  const id='upload:'+createHash('sha256').update(task.key+'\0'+input.request_id).digest('hex');
  const status=()=>store.db.prepare('SELECT id,state,external FROM deliveries WHERE id=?').get(id);
  if(status())return status();
  const scheduled=store.meta(`scheduleRun:${task.key}`)?store.db.prepare('SELECT output FROM schedule_runs WHERE task=?').get(task.key):undefined;
  if(scheduled&&scheduled.output!=='chat')throw new Error('File uploads require chat output; this scheduled run uses silent or webhook output');
  const max=(task.platform==='discord'?10:100)*1024*1024;
  const source=await open(resolve(task.cwd,input.path),'r');
  let bytes:Buffer;
  try {
    const stat=await source.stat();
    if(!stat.isFile()||stat.size>max)throw new Error(`Upload must be a regular file of at most ${max/1024/1024} MiB`);
    bytes=Buffer.alloc(stat.size+1);
    let offset=0;
    while(offset<bytes.length){const result=await source.read(bytes,offset,bytes.length-offset,null);if(!result.bytesRead)break;offset+=result.bytesRead;}
    if(offset>stat.size)throw new Error('File changed while preparing upload');
    bytes=bytes.subarray(0,offset);
  } finally {await source.close();}
  const name=basename(input.filename??input.path).replace(/[\x00-\x1f\x7f\\/]/g,'_').slice(-120);
  if(!name||name==='.'||name==='..')throw new Error('Invalid filename');
  const detectedMime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':undefined;
  const presentation=input.presentation??'auto';
  if(presentation==='image'&&!detectedMime)throw new Error('Inline images must be PNG or JPEG; use document for other file types');
  const dir=join(task.cwd,'outgoing',id.slice(7));await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,createHash('sha256').update(bytes).digest('hex'));
  await writeFile(path,bytes,{mode:0o600});
  const upload:Upload={path,name,caption:input.caption??'',mime:detectedMime??input.mime_type??'application/octet-stream',presentation:presentation==='auto'?(detectedMime?'image':'document'):presentation};
  store.db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?,?,'pending',NULL)").run(id,task.key,JSON.stringify(upload));
  return status();
}
