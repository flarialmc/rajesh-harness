import { normalizeMessageContent,jidNormalizedUser } from 'baileys';
import type { Store } from './store.js';
export async function discordReplyToBot(m:any,botId:string) {
  if(m.author.bot||!m.reference?.messageId)return false;
  try{return (await m.fetchReference()).author.id===botId;}catch{return false;}
}
export function whatsappReplyToBot(m:any,self:string[],store:Store) {
  const content=normalizeMessageContent(m.message);
  const body:any=content?.extendedTextMessage??content?.imageMessage??content?.videoMessage??content?.documentMessage;
  const context=body?.contextInfo;if(!context?.stanzaId)return false;
  if(context.participant&&self.includes(jidNormalizedUser(context.participant)))return true;
  return !!store.db.prepare("SELECT 1 FROM deliveries JOIN tasks ON tasks.key=deliveries.task WHERE tasks.platform='whatsapp' AND tasks.channel=? AND instr(','||deliveries.external||',',','||?||',')>0 LIMIT 1").get(m.key.remoteJid,context.stanzaId);
}
export function markWhatsappReplyInvoked(m:any,botId:string) {
  const content=normalizeMessageContent(m.message);
  const body:any=content?.extendedTextMessage??content?.imageMessage??content?.videoMessage??content?.documentMessage;
  if(body?.contextInfo)body.contextInfo.mentionedJid=[...(body.contextInfo.mentionedJid??[]),botId];
}
