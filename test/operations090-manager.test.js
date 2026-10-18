import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { createStore } from '../server/store.js';
import { createManager } from '../server/manager.js';
import { createRouter } from '../server/routes.js';
import { serializeProperties } from '../server/safety.js';
import { createDirectoryStorageFixture } from './storage-fixture.js';
import { zipEntries, waitJob } from './worlds-fixture.js';
import { federationFixture, COLLISION_ID } from './nodes080-fixture.js';
import { remoteServerRouteAllowed } from '../server/node-routes.js';

const GIB=1024**3;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t,{seed=true,fixed=false,storageOverrides={}}={}){
  const parent=path.resolve(os.tmpdir()),dataDir=await fs.mkdtemp(path.join(parent,'vortex-operations090-manager-')),store=createStore(dataDir),id=randomUUID();
  const server={id,name:'Owned integration fixture',version:'1.26.52.3',channel:'stable',transport:'nethernet',port:32100,portV6:32101,udpPorts:'32102-32133',maxPlayers:8,status:'stopped',autoStart:false,autoRestart:false,resourcePolicy:{mode:'shared',cpuCores:null,memoryMiB:null},...(fixed?{storagePolicy:{mode:'fixed',diskGiB:1}}:{}),backups:[],runtimeFiles:['bedrock_server']};
  const run=path.join(dataDir,'servers',id,'run');
  if(seed){store.data.servers.push(server);await fs.mkdir(run,{recursive:true});await fs.writeFile(path.join(run,'bedrock_server'),'INERT fixture must never execute');await fs.writeFile(path.join(run,'server.properties'),serializeProperties({'server-name':server.name,'server-port':32100,'server-portv6':32101,transport:'nethernet','server-udp-ports':server.udpPorts,'max-players':8,'level-name':'Owned','enable-lan-visibility':false,'online-mode':true,'allow-list':false,'allow-cheats':false,gamemode:'survival',difficulty:'peaceful','view-distance':16,'tick-distance':4,'max-threads':0}));}
  store.data.versions=[{version:'1.26.52.3',channel:'stable',transport:'nethernet',cached:true,available:true}];store.data.settings.latestVersion='1.26.52.3';store.save();
  const host={cpus:1,memoryTotal:4*GIB,memoryAvailable:4*GIB,memoryUsed:0,diskTotal:100*GIB,diskAvailable:90*GIB,diskUsed:10*GIB,platform:'test-fixture'};
  const storage={...createDirectoryStorageFixture(dataDir),...storageOverrides};
  const cap={fixedSupported:true,supported:true,sharedSupported:true,enforcement:'fixture',cpu:{minCores:0.1,maxCores:8},memory:{minMiB:256,maxMiB:16384},managedPool:{cpuCores:0.9,memoryMiB:3686,reserveRatio:0.1,kernelEnforced:false}};
  const resources={initialize:async()=>cap,capabilities:async()=>cap,prepare:async()=>{throw new Error('This unit fixture must never execute native processes.');}};
  const network={initialize:async()=>({supported:false}),capabilities:()=>({supported:false}),syncServers:async()=>{},sample:async()=>({}),peek:()=>({available:false}),close:async()=>{}};
  const manager=await createManager({store,dataDir,demo:false,hostReader:async()=>({...host}),storageController:storage,resourceController:resources,networkMetrics:network});
  const save=store.save;
  t.after(async()=>{store.save=save;await manager.close();assert.equal(path.dirname(dataDir),parent);assert.ok(path.basename(dataDir).startsWith('vortex-operations090-manager-'));await fs.rm(dataDir,{recursive:true,force:true});});
  return{dataDir,store,server,id,run,manager,host,storage,async importPackage(){const bytes=Buffer.alloc(4096);Buffer.from([0x7f,0x45,0x4c,0x46,2,1]).copy(bytes);bytes.writeUInt16LE(62,18);const zip=path.join(dataDir,'official-shaped-inert.zip');await zipEntries(zip,[{name:'bedrock_server',content:bytes},{name:'server.properties',content:'transport=nethernet\nserver-port=19132\nserver-portv6=19133\nmax-players=8\n'}]);store.data.versions[0].cached=false;await manager.importVersion(zip,'1.26.52.3','stable');}};
}
test('simultaneous manager creates spend admission budget once while install is still asynchronous',async t=>{
  const entered=deferred(),release=deferred();let f;
  f=await fixture(t,{seed:false,storageOverrides:{async provision(server){entered.resolve();await release.promise;await fs.mkdir(path.join(f.dataDir,'servers',server.id),{recursive:true});}}});
  await f.importPackage();
  const input=port=>({name:'Concurrent owned fixture',version:'1.26.52.3',port,portV6:port+1,maxPlayers:8,eula:true,resourcePolicy:{mode:'fixed',cpuCores:0.6,memoryMiB:256},storagePolicy:{mode:'fixed',diskGiB:1}});
  const outcomes=await Promise.allSettled([f.manager.createServer(input(32200)),f.manager.createServer(input(32300))]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);const denied=outcomes.find(r=>r.status==='rejected').reason;assert.equal(denied.status,409);assert.equal(denied.code,'CAPACITY_CPU');assert.equal(f.store.data.servers.length,1);
  await entered.promise;release.resolve();await waitJob(f.manager,outcomes.find(r=>r.status==='fulfilled').value.job.id);assert.equal(f.manager.listServers()[0].storagePolicy.diskGiB,1);
});
test('resource admission rejection occurs before configuration file activation; durable commit failure rolls back allocation and properties',async t=>{
  const f=await fixture(t),filename=path.join(f.run,'server.properties'),before=await fs.readFile(filename,'utf8');
  await assert.rejects(f.manager.saveConfiguration(f.id,{settings:{resourcePolicy:{mode:'fixed',cpuCores:1,memoryMiB:512}},properties:{difficulty:'hard'}}),error=>error.status===409&&error.code==='CAPACITY_CPU');
  assert.equal(await fs.readFile(filename,'utf8'),before);assert.equal(f.server.resourcePolicy.mode,'shared');
  const save=f.store.save;let injected=false;f.store.save=()=>{if(!injected&&f.server.resourcePolicy.mode==='fixed'){injected=true;throw new Error('injected atomic commit failure');}return save();};
  await assert.rejects(f.manager.saveConfiguration(f.id,{settings:{resourcePolicy:{mode:'fixed',cpuCores:0.4,memoryMiB:512}},properties:{difficulty:'hard'}}),/atomic commit failure/);
  assert.equal(await fs.readFile(filename,'utf8'),before);assert.equal(f.server.resourcePolicy.mode,'shared');assert.equal(f.manager.getServer(f.id).resources.allocation.cpuCores,0.1);
});
test('legacy storage stays unchanged through resource edits and a failed settings save releases admission credits',async t=>{
  const f=await fixture(t);assert.equal(Object.hasOwn(f.server,'storagePolicy'),false);
  await f.manager.updateServer(f.id,{resourcePolicy:{mode:'fixed',cpuCores:0.4,memoryMiB:512}});assert.equal(Object.hasOwn(f.server,'storagePolicy'),false);assert.equal(f.manager.getServer(f.id).storagePolicy.mode,'unlimited');
  const save=f.store.save;f.store.save=()=>{throw new Error('settings disk full');};await assert.rejects(f.manager.updateServer(f.id,{resourcePolicy:{mode:'fixed',cpuCores:0.8,memoryMiB:1024}}),/settings disk full/);f.store.save=save;
  assert.equal(f.server.resourcePolicy.cpuCores,0.4);assert.equal((await f.manager.dashboard()).host.capacity.cpu.allocatedCores,0.4);
});
test('growth queues durable desired size and excludes native start, file writes and delete until completion',async t=>{
  const entered=deferred(),release=deferred();const f=await fixture(t,{fixed:true,storageOverrides:{async grow(){entered.resolve();await release.promise;}}});
  const growth=await f.manager.growStorage(f.id,{diskGiB:2});await entered.promise;assert.equal(f.server.storagePolicy.diskGiB,2);assert.ok(f.server.jobId);
  for(const operation of [()=>f.manager.action(f.id,'start'),()=>f.manager.writeFile(f.id,'owned.txt','forbidden during grow'),()=>f.manager.deleteServer(f.id)])await assert.rejects(operation(),error=>error.status===409);
  release.resolve();await waitJob(f.manager,growth.job.id);assert.equal(f.manager.getServer(f.id).busy,false);
});
test('delete owns the stopped-server operation throughout asynchronous unmount',async t=>{
  const entered=deferred(),release=deferred();const f=await fixture(t,{fixed:true,storageOverrides:{async unmount(){entered.resolve();await release.promise;return{ok:true,unmounted:true};}}});
  const deletion=f.manager.deleteServer(f.id);await entered.promise;
  await assert.rejects(f.manager.action(f.id,'start'),error=>error.status===409);await assert.rejects(f.manager.writeFile(f.id,'racing.txt','no'),error=>error.status===409);
  release.resolve();const result=await deletion;assert.equal(result.ok,true);assert.equal(f.store.data.servers.length,0);await assert.rejects(fs.access(path.dirname(f.run)));
});
test('actual Express growth route requires administrator before manager/storage work and rejects malformed admin body',async t=>{
  let grows=0;const f=await fixture(t,{fixed:true,storageOverrides:{async grow(){grows++;}}});const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.session={user:{id:'fixture',username:'fixture',role:req.headers['x-fixture-role']||'viewer',allServers:true,serverIds:[]}};next();});app.use('/api',createRouter(f.manager,{dataDir:f.dataDir,store:f.store}));app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}/api/servers/${f.id}/storage/grow`;const request=(role,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Fixture-Role':role},body:JSON.stringify(body)});
  for(const role of ['viewer','operator'])assert.equal((await request(role,{diskGiB:2})).status,403);assert.equal(grows,0);
  assert.equal((await request('admin',{})).status,400);assert.equal(grows,0);const response=await request('admin',{diskGiB:2});assert.equal(response.status,202);const body=await response.json();await waitJob(f.manager,body.job.id);assert.equal(grows,1);
});
test('remote growth route allows only POST and enforces central and agent administrator roles before forwarding',async t=>{
  assert.equal(remoteServerRouteAllowed('POST','/storage/grow'),true);for(const method of ['GET','PATCH','DELETE'])assert.equal(remoteServerRouteAllowed(method,'/storage/grow'),false);
  const f=await federationFixture(t),agent=f.agents[0],remote=f.remote(0),original=agent.runtime.manager.growStorage;let forwards=0;
  agent.runtime.manager.growStorage=(...args)=>{forwards++;return original(...args);};
  for(const role of ['operator','viewer']){const user=await f.createUser('growth-'+role,{role,serverIds:[remote]});const denied=await f.request('/servers/'+remote+'/storage/grow',{actor:user,body:{diskGiB:2}});assert.equal(denied.status,403);}
  assert.equal(forwards,0);const malformed=await f.request('/servers/'+remote+'/storage/grow',{body:{}});assert.equal(malformed.status,400);assert.equal(forwards,1);
  const legacy=await f.request('/servers/'+remote+'/storage/grow',{body:{diskGiB:2}});assert.equal(legacy.status,409);assert.equal(forwards,2);assert.equal(agent.store.data.servers.find(s=>s.id===COLLISION_ID).storagePolicy,undefined);
  const actor=Buffer.from(JSON.stringify({id:'fixture',username:'fixture',role:'operator',allServers:true,serverIds:[]})).toString('base64url');
  const direct=await fetch(agent.endpoint+'/api/servers/'+COLLISION_ID+'/storage/grow',{method:'POST',headers:{Authorization:'Bearer '+agent.token,'X-Vortex-Actor':actor,'Content-Type':'application/json'},body:JSON.stringify({diskGiB:2})});assert.equal(direct.status,403);assert.equal(forwards,2);
});
test('workspace reservations serialize against physical host reserve and release idempotently after rejection',async t=>{
  const f=await fixture(t,{seed:false});f.host.diskAvailable=12*GIB;f.host.diskUsed=88*GIB;
  const release=await f.manager.reserveDiskWorkspace(1.5*GIB);assert.equal((await f.manager.dashboard()).host.capacity.storage.availableBytes,0.5*GIB);
  await assert.rejects(f.manager.reserveDiskWorkspace(GIB),error=>error.status===409&&error.code==='CAPACITY_DISK');
  release();release();assert.equal((await f.manager.dashboard()).host.capacity.storage.availableBytes,2*GIB);
  const exact=await f.manager.reserveDiskWorkspace(2*GIB);exact();assert.equal((await f.manager.dashboard()).host.capacity.storage.availableBytes,2*GIB);
});
test('uncached native create reserves package workspace before install while cached create needs only its volume',async t=>{
  const f=await fixture(t,{seed:false});await f.importPackage();f.host.diskAvailable=13*GIB;f.host.diskUsed=87*GIB;
  const input={name:'Workspace budget fixture',version:'1.26.52.3',port:32400,portV6:32401,maxPlayers:8,eula:true,resourcePolicy:{mode:'fixed',cpuCores:0.25,memoryMiB:256},storagePolicy:{mode:'fixed',diskGiB:1}};
  f.store.data.versions[0].cached=false;await assert.rejects(f.manager.createServer(input),error=>error.status===409&&error.code==='CAPACITY_DISK');assert.equal(f.store.data.servers.length,0);
  assert.equal((await f.manager.dashboard()).host.capacity.storage.availableBytes,3*GIB);f.store.data.versions[0].cached=true;
  const result=await f.manager.createServer(input);await waitJob(f.manager,result.job.id);assert.equal(f.store.data.servers.length,1);
});
test('grandfathered fixed policy stays configured above new pool ceiling while new allocations are blocked',async t=>{
  const f=await fixture(t);f.server.resourcePolicy={mode:'fixed',cpuCores:1,memoryMiB:1024};f.store.save();
  const publicServer=f.manager.getServer(f.id);assert.equal(publicServer.resourcePolicy.cpuCores,1);assert.equal(publicServer.telemetry.cpu.totalCores,0.9);
  await f.manager.updateServer(f.id,{name:'Preserved user server'});assert.equal(f.server.resourcePolicy.cpuCores,1);assert.equal(f.server.name,'Preserved user server');
  const cap=(await f.manager.dashboard()).host.capacity;assert.equal(cap.cpu.availableCores,0);assert.equal(cap.cpu.allocatedCores,1);assert.equal(cap.cpu.allocatableCores,0.9);
  await assert.rejects(f.manager.updateServer(f.id,{resourcePolicy:{mode:'fixed',cpuCores:1,memoryMiB:768}}),error=>error.status===409&&error.code==='CAPACITY_CPU');
});
test('multipart staging directory failure and caller abort release host workspace without orphan upload bytes',async t=>{
  const f=await fixture(t,{seed:false}),app=express();app.use((req,_res,next)=>{req.session={user:{id:'fixture',username:'fixture',role:'admin',allServers:true,serverIds:[]}};next();});app.use('/api',createRouter(f.manager,{dataDir:f.dataDir,store:f.store}));app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));const origin=`http://127.0.0.1:${server.address().port}`;
  const before=(await f.manager.dashboard()).host.capacity.storage.availableBytes,destination=f.manager.uploadStagingDirectory;
  f.manager.uploadStagingDirectory=async()=>{throw new Error('injected mkdir failure');};const form=new FormData();form.append('file',new Blob(['inert']),'fixture.zip');form.append('version','1.21.50.10');const failed=await fetch(origin+'/api/versions/import',{method:'POST',body:form});assert.equal(failed.status,500);await failed.arrayBuffer();assert.equal((await f.manager.dashboard()).host.capacity.storage.availableBytes,before);f.manager.uploadStagingDirectory=destination;
  const boundary='vortex-operations090-abort',prefix=`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  const request=http.request(origin+'/api/versions/import',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':1024*1024}});request.on('error',()=>{});request.write(prefix);request.write(Buffer.alloc(4096,0x5a));
  async function waitFor(condition){const until=Date.now()+5000;while(Date.now()<until){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,15));}assert.fail('Timed out observing multipart workspace cleanup');}
  await waitFor(async()=>((await f.manager.dashboard()).host.capacity.storage.availableBytes===before-GIB));request.destroy();
  await waitFor(async()=>((await f.manager.dashboard()).host.capacity.storage.availableBytes===before));await waitFor(async()=>!(await fs.readdir(path.join(f.dataDir,'.uploads')).catch(()=>[])).length);
});
