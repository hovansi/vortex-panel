import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {activeDataProcesses,runStorageMaintenance} from '../server/storage-cli.js';
async function fixture(t,{state='active',account=true}={}){
 const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'vortex-process-inventory-')),dataDir=path.join(root,'data'),privateRoot=path.join(dataDir,'.application-users'),backup=path.join(root,'backup'),proc=path.join(root,'proc');
 await Promise.all([fs.mkdir(privateRoot,{recursive:true,mode:0o700}),fs.mkdir(backup,{mode:0o700}),fs.mkdir(proc)]);
 const id=randomUUID(),ownerId=randomUUID(),scope=createHash('sha256').update(dataDir).digest('hex').slice(0,8),username=`vxapp_${scope}_${id.replaceAll('-','').slice(0,16)}`,uid=997,gid=998;
 const record={schema:1,serverId:id,scope,username,ownerId,state,uid,gid};const filename=path.join(privateRoot,id+'.json');await fs.writeFile(filename,JSON.stringify(record),{mode:0o600});
 const passwdPath=path.join(root,'passwd'),groupPath=path.join(root,'group');
 await fs.writeFile(passwdPath,account?`${username}:x:${uid}:${gid}:vortex-app,${scope},${id},${ownerId}:/nonexistent:/usr/sbin/nologin\n`:'',{mode:0o600});
 await fs.writeFile(groupPath,account?`${username}:x:${gid}:\n`:'',{mode:0o600});const processes=new Map();
 const io={...fs,readlink:async filename=>{const match=filename.match(/[\\/](\d+)[\\/](exe|cwd)$/);if(!match||!processes.has(Number(match[1])))throw Object.assign(new Error('missing'),{code:'ENOENT'});return processes.get(Number(match[1]))[match[2]];}};
 const options={io,procRoot:proc,fileOwnerUid:process.getuid?.()??0,enforceMode:process.platform!=='win32',passwdPath,groupPath};
 async function addProcess(pid,owner,{exe='/usr/bin/node',cwd='/workspace'}={}){await fs.mkdir(path.join(proc,String(pid)));await fs.writeFile(path.join(proc,String(pid),'status'),`Name:\tfixture\nUid:\t${owner}\t${owner}\t${owner}\t${owner}\n`);processes.set(pid,{exe,cwd});}
 t.after(async()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('vortex-process-inventory-'));await fs.rm(root,{recursive:true,force:true});});
 return{root,dataDir,privateRoot,backup,proc,id,uid,gid,username,record,filename,options,process:addProcess,passwdPath,groupPath};
}
test('offline inventory detects receipted Node/Python/sandbox UIDs even when namespace cwd hides DATA_DIR',async t=>{
 const f=await fixture(t);await f.process(41,f.uid);await f.process(42,f.uid,{exe:'/usr/bin/python3.12'});await f.process(43,f.uid,{exe:'/usr/bin/bwrap',cwd:'/mnt/workspace'});await f.process(44,0,{exe:path.join(f.dataDir,'servers',f.id,'run','bedrock_server'),cwd:path.join(f.dataDir,'servers',f.id,'run')});await f.process(45,1001,{exe:'/usr/bin/node',cwd:'/other-project'});await f.process(46,0,{exe:'/usr/bin/node',cwd:f.dataDir});
 assert.deepEqual((await activeDataProcesses(f.dataDir,f.options)).sort((a,b)=>a-b),[41,42,43,44]);
});
test('a releasing receipt still guards its UID after passwd and group rows have been removed',async t=>{
 const f=await fixture(t,{state:'releasing',account:false});await f.process(50,f.uid);assert.deepEqual(await activeDataProcesses(f.dataDir,f.options),[50]);
});
test('unknown or changed ownership refuses the inventory instead of adopting another account',async t=>{
 for(const mutate of [async f=>{await fs.unlink(f.filename);},async f=>{await fs.writeFile(f.filename,JSON.stringify({...f.record,uid:0}));},async f=>{await fs.writeFile(f.filename,JSON.stringify({...f.record,scope:'00000000'}));},async f=>{await fs.writeFile(f.passwdPath,`${f.username}:x:${f.uid}:${f.gid}:foreign:/nonexistent:/usr/sbin/nologin\n`);}]){
  const f=await fixture(t);await mutate(f);const before=await fs.readFile(f.passwdPath);await assert.rejects(activeDataProcesses(f.dataDir,f.options));assert.deepEqual(await fs.readFile(f.passwdPath),before);
 }
});
test('unreadable or malformed process UID status fails closed without changing metadata',async t=>{
 const f=await fixture(t);await f.process(60,1001);const before=await fs.readFile(f.filename);
 await fs.writeFile(path.join(f.proc,'60','status'),'Name:\tmissing UID\n');await assert.rejects(activeDataProcesses(f.dataDir,f.options),/identity/);
 const read=f.options.io.readFile;f.options.io={...f.options.io,readFile:async(filename,...args)=>{if(filename===path.join(f.proc,'60','status'))throw Object.assign(new Error('denied'),{code:'EACCES'});return read(filename,...args);}};
 await assert.rejects(activeDataProcesses(f.dataDir,f.options),/application process inventory/);assert.deepEqual(await fs.readFile(f.filename),before);
});
test('storage backup refuses an active owned application before controller, receipt or unmount effects',async t=>{
 const f=await fixture(t);await f.process(70,f.uid);const store=Buffer.from(JSON.stringify({servers:[{id:f.id,kind:'nodejs',storagePolicy:{mode:'fixed',diskGiB:1}}]}));await fs.writeFile(path.join(f.dataDir,'panel.json'),store,{mode:0o600});await fs.writeFile(path.join(f.dataDir,'panel.lock'),JSON.stringify({pid:12345,identity:'backup-process-fixture'}),{mode:0o600});
 let controllers=0;const receipt=path.join(f.backup,'receipt.json');
 await assert.rejects(runStorageMaintenance({command:'unmount-all',dataDir:f.dataDir,receipt,lockOwnerPid:12345},{platform:'linux',uid:0,fileOwnerUid:process.getuid?.()??0,ppid:12345,enforceMode:process.platform!=='win32',inspectProcesses:()=>activeDataProcesses(f.dataDir,f.options),controllerFactory:()=>{controllers++;throw Error('must not touch mounts');}}),/application process/);
 assert.equal(controllers,0);await assert.rejects(fs.access(receipt));assert.deepEqual(await fs.readFile(path.join(f.dataDir,'panel.json')),store);
});
