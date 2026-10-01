import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { WorkerError } from './diagnostics.mjs';
const MAX_BYTES=8192;
/** Secret input only; static prompt, hidden TTY echo, bounded pipe, no diagnostics. */
export async function readPrivateEnrollmentCode({input=process.stdin,output=process.stderr}={}) {
  if(input.isTTY){
    output.write('Paste approved enrollment code: ');
    const silent=new Writable({write(_chunk,_encoding,done){done();}});
    const reader=createInterface({input,output:silent,terminal:true,historySize:0});
    try{return await new Promise((resolve,reject)=>{reader.once('line',line=>{if(Buffer.byteLength(line)>MAX_BYTES)reject(new WorkerError('setup_code_invalid'));else resolve(line.trim());});reader.once('SIGINT',()=>reject(new WorkerError('setup_code_cancelled')));reader.once('close',()=>reject(new WorkerError('setup_code_cancelled')));});}
    finally{reader.close();output.write('\n');}
  }
  let size=0;const chunks=[];
  for await(const chunk of input){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>MAX_BYTES)throw new WorkerError('setup_code_invalid');chunks.push(bytes);if(bytes.includes(10))break;}
  const text=Buffer.concat(chunks).toString('utf8').trim();
  if(!text||text.includes('\n')||text.includes('\r'))throw new WorkerError('setup_code_invalid');
  return text;
}
