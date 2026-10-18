import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {EventEmitter} from 'node:events';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function readinessProbe({retireAt=null}={}) {
 const source=await fs.readFile(new URL('../server/manager.js',import.meta.url),'utf8');const begin=source.indexOf('      const readyTask = (async () => {'),end=source.indexOf('      gameplayRuns.add(readyTask);',begin);assert.ok(begin>=0&&end>begin);
 const block=source.slice(begin,end),reading=deferred(),read=deferred(),connecting=deferred(),connect=deferred();let current=true,commits=0;
 const runtime={expected:false,applicationRuntime:{uid:997},ready:false,readyTimer:null};const server={id:'owned-fixture',port:30000,status:'starting',application:{readiness:'tcp'},resumeOnPanelStart:true};
 const fakeFs={readFile:async()=>{reading.resolve();await read.promise;return 'header\n0: 00000000:7530 00000000:0000 0A 0 0 0 997\n';}};
 const fakeNet={connect:()=>{const socket=new EventEmitter();socket.setTimeout=()=>{};socket.destroy=()=>{};connecting.resolve();connect.promise.then(()=>socket.emit('connect'));return socket;}};
 const execute=new Function('fs','net','server','runtime','runtimeCurrent','closed','persistRuntime','log','setTimeout','clearTimeout',block+'return readyTask;');
 const pending=execute(fakeFs,fakeNet,server,runtime,()=>current,false,()=>commits++,()=>{},fn=>{queueMicrotask(fn);return 1;},()=>{});
 await reading.promise;
 if(retireAt==='read'){current=false;runtime.expected=true;server.status='stopped';}
 read.resolve();
 if(retireAt==='read'){connect.resolve();await pending;return{server,runtime,commits};}
 await connecting.promise;
 if(retireAt==='connect'){current=false;runtime.expected=true;server.status='starting';server.resumeOnPanelStart='replacement-launch-marker';}
 connect.resolve();await pending;return{server,runtime,commits};
}
test('current application TCP readiness can still commit after a successful owned listener probe',async()=>{
 const {server,runtime,commits}=await readinessProbe();assert.equal(server.status,'running');assert.equal(runtime.ready,true);assert.equal(commits,1);assert.equal(server.resumeOnPanelStart,undefined);
});
test('stopped application cannot be resurrected by an earlier pending listener read',async()=>{
 const {server,runtime,commits}=await readinessProbe({retireAt:'read'});assert.equal(server.status,'stopped');assert.equal(runtime.ready,false);assert.equal(commits,0);assert.equal(server.resumeOnPanelStart,true);
});
test('old TCP readiness cannot publish over a replacement launch while connect awaits',async()=>{
 const {server,runtime,commits}=await readinessProbe({retireAt:'connect'});assert.equal(server.status,'starting');assert.equal(runtime.ready,false);assert.equal(commits,0);assert.equal(server.resumeOnPanelStart,'replacement-launch-marker');
});
