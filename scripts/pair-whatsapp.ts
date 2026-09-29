import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import pino from 'pino';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
process.umask(0o077);
const config=loadConfig();
if(!config.whatsappGroup)throw new Error('Configure the WhatsApp route first');
const terminal=createInterface({input:process.stdin,output:process.stdout});
const phone=(await terminal.question('Phone number with country code (digits only): ')).trim();terminal.close();
if(!/^\d{7,15}$/.test(phone))throw new Error('Invalid phone number');
const {state,saveCreds}=await useMultiFileAuthState(join(config.secretsDir,'whatsapp'));
let requesting=false;
function connect(){
 const socket=makeWASocket({auth:state,logger:pino({level:'silent'}),markOnlineOnConnect:false});
 socket.ev.on('creds.update',saveCreds);
 socket.ev.on('connection.update',update=>{
  if(update.qr&&!state.creds.registered&&!requesting){requesting=true;void socket.requestPairingCode(phone).then(code=>console.log('Enter this private pairing code in WhatsApp Linked devices:',code)).catch(()=>{console.error('Pairing failed; retry the command.');process.exitCode=1;socket.end(new Error('Pairing failed'));});}
  if(update.connection==='open'){void saveCreds().then(()=>{console.log('Paired. Stop this command before starting the service.');socket.end(new Error('Pairing complete'));process.exit(0);});}
  if(update.connection==='close'){
   const code=(update.lastDisconnect?.error as any)?.output?.statusCode;
   if(code===DisconnectReason.restartRequired)connect();
   else {console.error('Connection closed. Retry pairing if it did not finish.');process.exitCode=1;}
  }
 });
}
connect();
