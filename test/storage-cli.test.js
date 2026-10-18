import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { parseStorageMaintenanceArgs,runStorageMaintenance } from '../server/storage-cli.js';

async function fixture(t) {
  const parent=path.resolve(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'vortex-storage-maintenance-')),dataDir=path.join(root,'data'),privateDir=path.join(root,'backup');
  await fs.mkdir(dataDir,{mode:0o700});await fs.mkdir(privateDir,{mode:0o700});
  const servers=[0,1,2].map(()=>({id:randomUUID(),storagePolicy:{mode:'fixed',diskGiB:1}}));servers.push({id:randomUUID()});
  const store=Buffer.from(JSON.stringify({servers,settings:{opaque:'preserve'},users:[{passwordHash:'opaque-secret-never-in-receipt'}]}));
  await fs.writeFile(path.join(dataDir,'panel.json'),store,{mode:0o600});const lock={pid:12345,identity:'backup-test-12345'};await fs.writeFile(path.join(dataDir,'panel.lock'),JSON.stringify(lock),{mode:0o600});
  const mounted=new Set(servers.slice(0,2).map(s=>s.id)),calls=[];let failUnmount,failMount,active=[];
  const controller={initialize:async()=>({supported:true}),isMounted:async server=>mounted.has(server.id),
    async unmount(server){calls.push(['unmount',server.id]);if(server.id===failUnmount)throw new Error('busy');mounted.delete(server.id);return{ok:true,unmounted:true};},
    async ensureMounted(server){calls.push(['mount',server.id]);if(server.id===failMount)throw new Error('failed mount');mounted.add(server.id);},close:async()=>{calls.push(['close']);}};
  const receipt=path.join(privateDir,'receipt.json'),options={dataDir,receipt,lockOwnerPid:12345};
  const deps={platform:'linux',uid:0,fileOwnerUid:process.getuid?.()??0,ppid:12345,enforceMode:process.platform!=='win32',controllerFactory:()=>controller,inspectProcesses:async()=>active};
  t.after(async()=>{assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('vortex-storage-maintenance-'));await fs.rm(root,{recursive:true,force:true});});
  return{root,dataDir,receipt,servers,mounted,calls,store,lock,deps,options,failUnmount(id){failUnmount=id;},failMount(id){failMount=id;},active(value){active=value;},run:command=>runStorageMaintenance({...options,command},deps),record:async()=>JSON.parse(await fs.readFile(receipt,'utf8'))};
}
test('maintenance arguments require exact explicit paths and direct backup parent identity',()=>{
  assert.deepEqual(parseStorageMaintenanceArgs(['unmount-all','--data-dir','/data','--receipt','/backup/receipt','--lock-owner-pid','12']),{command:'unmount-all',dataDir:'/data',receipt:'/backup/receipt',lockOwnerPid:12});
  for(const args of [[],['mount-all'],['unmount-all','--unknown','value'],['unmount-all','--data-dir','/a','--data-dir','/b']])assert.throws(()=>parseStorageMaintenanceArgs(args));
});
test('receipt precedes unmounts, preserves store/secrets, and remounts only originally mounted fixed servers',async t=>{
  const f=await fixture(t),before=createHash('sha256').update(f.store).digest('hex');const result=await f.run('unmount-all');assert.equal(result.unmounted,2);assert.equal(f.mounted.size,0);
  let record=await f.record();assert.equal(record.state,'unmounted');assert.equal(record.storeSHA256,before);assert.equal(JSON.stringify(record).includes('opaque-secret'),false);
  const restored=await f.run('mount-all');assert.equal(restored.restored,2);assert.deepEqual([...f.mounted],f.servers.slice(0,2).map(s=>s.id));assert.equal(f.mounted.has(f.servers[2].id),false);assert.deepEqual(await fs.readFile(path.join(f.dataDir,'panel.json')),f.store);
  record=await f.record();assert.equal(record.state,'restored');await f.run('mount-all');assert.equal(f.mounted.size,2);
});
test('partial unmount failure restores the original mount set before returning error',async t=>{
  const f=await fixture(t);f.failUnmount(f.servers[1].id);await assert.rejects(f.run('unmount-all'),/busy/);assert.deepEqual([...f.mounted].sort(),f.servers.slice(0,2).map(s=>s.id).sort());assert.equal((await f.record()).state,'restored');
});
test('failed recovery leaves a private retryable receipt; mount-all retry restores remaining originals',async t=>{
  const f=await fixture(t);await f.run('unmount-all');f.failMount(f.servers[1].id);await assert.rejects(f.run('mount-all'),/need recovery/);assert.equal((await f.record()).state,'restore-pending');f.failMount(null);await f.run('mount-all');assert.equal((await f.record()).state,'restored');assert.equal(f.mounted.size,2);
});
test('active native process, wrong parent, non-backup lock and changed inventory fail before mount effects',async t=>{
  for(const change of [async f=>f.active([777]),async f=>{f.options.lockOwnerPid=12;},async f=>{await fs.writeFile(path.join(f.dataDir,'panel.lock'),JSON.stringify({...f.lock,identity:'panel-lock'}));}]){
    const f=await fixture(t);await change(f);await assert.rejects(f.run('unmount-all'));assert.equal(f.calls.length,0);await assert.rejects(fs.access(f.receipt));
  }
  const f=await fixture(t);await f.run('unmount-all');await fs.writeFile(path.join(f.dataDir,'panel.json'),JSON.stringify({servers:f.servers,changed:true}));const before=f.calls.length;await assert.rejects(f.run('mount-all'),/receipt does not match/);assert.equal(f.calls.length,before);
});
test('receipt cannot be overwritten, relocated into DATA or made to restore a previously unmounted ID',async t=>{
  const f=await fixture(t);await fs.writeFile(f.receipt,'user-owned-receipt');await assert.rejects(f.run('unmount-all'),{code:'EEXIST'});assert.equal(await fs.readFile(f.receipt,'utf8'),'user-owned-receipt');assert.equal(f.calls.filter(r=>r[0]==='unmount').length,0);
  const g=await fixture(t);g.options.receipt=path.join(g.dataDir,'receipt');await assert.rejects(g.run('unmount-all'),/outside the data/);assert.equal(g.calls.length,0);
  const h=await fixture(t);await h.run('unmount-all');const row=await h.record();row.originalMountedIds.push(h.servers[2].id);await fs.writeFile(h.receipt,JSON.stringify(row));const before=h.calls.length;await assert.rejects(h.run('mount-all'),/does not match/);assert.equal(h.calls.length,before);
});
test('lock identity replacement during unmount blocks further effects and retains recovery IDs',async t=>{
  const f=await fixture(t),original=f.deps.controllerFactory;let first=true;
  f.deps.controllerFactory=()=>{const controller=original();const unmount=controller.unmount;return{...controller,async unmount(server){const value=await unmount(server);if(first){first=false;await fs.writeFile(path.join(f.dataDir,'panel.lock'),JSON.stringify({...f.lock,identity:'backup-replaced'}));}return value;}};};
  await assert.rejects(f.run('unmount-all'),/lock changed/);assert.equal(f.calls.filter(r=>r[0]==='unmount').length,1);assert.equal(f.calls.filter(r=>r[0]==='mount').length,0);assert.deepEqual((await f.record()).originalMountedIds,f.servers.slice(0,2).map(s=>s.id));
});
