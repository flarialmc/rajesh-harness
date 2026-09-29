import { existsSync, readFileSync } from 'node:fs';
let values:string[]=[];
export function loadRedactions(path:string) {
  if(existsSync(path)) {
    const walk=(v:any):void=>{if(typeof v==='string'&&v.length>16)values.push(v);else if(v&&typeof v==='object')Object.values(v).forEach(walk);};
    walk(JSON.parse(readFileSync(path,'utf8')));
  }
}
export function redact(text:string) {
  for(const value of values) text=text.split(value).join('[REDACTED]');
  return text.replace(/https:\/\/(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com\/services)\/[^\s"'<>]+/gi,'[REDACTED WEBHOOK]').replace(/\bsk-[A-Za-z0-9_-]{16,}/g,'[REDACTED]')
    .replace(/("(?:access_token|refresh_token|id_token|botToken|apiKey|api_key|password|secret|webhook)"\s*:\s*")[^"\n]+/gi,'$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:bearer|bot)\s+)[^\s"']+/gi,'$1[REDACTED]');
}
export function redactValue<T>(value:T):T {
  if(typeof value==='string')return redact(value) as T;
  if(Array.isArray(value))return value.map(redactValue) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(?:access_token|refresh_token|id_token|botToken|apiKey|api_key|password|secret|webhook)$/i.test(key)?'[REDACTED]':redactValue(item)])) as T;
  return value;
}
