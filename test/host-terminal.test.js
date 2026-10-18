import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runHostTerminal} from '../server/host.js';
function terminal(chunks,{maxBytes,timeoutMs}={}) {
 const child=new EventEmitter();child.pid=123456789;child.stdout=new PassThrough();child.stderr=new PassThrough();const signals=[];
 const result=runHostTerminal('fixture-only-never-executed',{cwd:'fixture',maxBytes,timeoutMs,spawnProcess:(binary,args,options)=>{
  assert.equal(binary,'/bin/bash');assert.deepEqual(args,['-lc','fixture-only-never-executed']);assert.equal(options.detached,true);
  queueMicrotask(()=>{for(const [key,chunk]of chunks)child[key].write(chunk);child.stdout.end();child.stderr.end();child.emit('close',0);});return child;
 },killGroup:pid=>signals.push(pid)});return {result,signals,child};
}
test('host terminal preserves split Vietnamese and emoji independently on both output pipes',async()=>{
 const out='Tiếng Việt 🧱 €',err='Lỗi mạng 🌍';const chunks=[];
 for(let i=0;i<Math.max(Buffer.byteLength(out),Buffer.byteLength(err));i++){
  if(i<Buffer.byteLength(out))chunks.push(['stdout',Buffer.from(out).subarray(i,i+1)]);
  if(i<Buffer.byteLength(err))chunks.push(['stderr',Buffer.from(err).subarray(i,i+1)]);
 }
 const {result,signals}=terminal(chunks);assert.deepEqual(await result,{stdout:out,stderr:err,exitCode:0,timedOut:false,truncated:false});assert.deepEqual(signals,[123456789]);
});
test('host terminal byte budget remains shared and output after the budget is never decoded',async()=>{
 const {result,signals}=terminal([['stdout',Buffer.from('abc')],['stderr',Buffer.from('def')],['stdout',Buffer.from('ignored')]],{maxBytes:5});
 assert.deepEqual(await result,{stdout:'abc',stderr:'',exitCode:0,timedOut:false,truncated:true});assert.ok(signals.length>=1);
});
test('host terminal flushes a final incomplete UTF8 sequence once and handles launch failure without a second result',async()=>{
 const {result}=terminal([['stdout',Buffer.from([0xe2,0x82])]]);assert.equal((await result).stdout,'�');
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let kills=0;
 const failed=runHostTerminal('fixture',{spawnProcess:()=>{queueMicrotask(()=>{child.emit('error',new Error('fixture launch failure'));child.emit('close',null);});return child;},killGroup:()=>kills++});
 assert.deepEqual(await failed,{stdout:'',stderr:'fixture launch failure',exitCode:-1,timedOut:false,truncated:false});assert.equal(kills,1);
});
