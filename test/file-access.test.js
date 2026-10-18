import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';

test('advanced file access requires admin password and warning, is session/server scoped and expires; live world locks remain', async t => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'vortex-file-access-'));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url).startsWith('https:')?Promise.reject(Error('No external catalog in fixture')):originalFetch(url,options);
  const runtime=await createApp({dataDir,setupToken:'file-access-test-setup'});
  await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const s of runtime.store.data.servers)s.status='stopped';await runtime.close();globalThis.fetch=originalFetch;await fs.rm(dataDir,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${runtime.server.address().port}`;
  for(let i=0;i<2;i++){
    const s={id:randomUUID(),name:'File access '+i,status:'stopped',version:'1.20.0.01',channel:'stable',port:36000+i*100,portV6:36001+i*100,transport:'raknet',maxPlayers:10,runtimeFiles:['bedrock_server'],backups:[]};
    runtime.store.data.servers.push(s);
    const run=path.join(dataDir,'servers',s.id,'run');await fs.mkdir(path.join(run,'worlds/Main/db'),{recursive:true});
    await fs.writeFile(path.join(run,'server.properties'),'level-name=Main\ntransport=raknet\nenable-lan-visibility=false\n');
    await fs.writeFile(path.join(run,'bedrock_server'),'inert runtime fixture');
    await fs.writeFile(path.join(run,'worlds/Main/db/table'),'world-data');
  }
  const password='file-access-test-password';
  const authenticate=async(route,body)=>{
    const r=await fetch(origin+'/api/auth/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(r.status,200);const d=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:d.csrfToken};
  };
  const admin=await authenticate('setup',{token:'file-access-test-setup',username:'fileadmin',password});
  const secondSession=await authenticate('login',{username:'fileadmin',password});
  const request=async(actor,route,body,method='POST',extra={})=>{
    const r=await fetch(origin+'/api'+route,{method,headers:{Cookie:actor.cookie,Origin:origin,'X-CSRF-Token':actor.csrf,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,data:await r.json()};
  };
  const [one,two]=runtime.store.data.servers,base='/servers/'+one.id;
  const remove=(actor,id=one.id,headers={})=>request(actor,'/servers/'+id+'/file?path=bedrock_server',undefined,'DELETE',headers);
  assert.equal((await remove(admin)).status,403);
  assert.equal((await remove(admin,one.id,{'X-Vortex-File-Access':JSON.stringify({serverId:one.id,expires:Date.now()+600000})})).status,403);
  assert.equal((await request(admin,'/auth/file-access',{serverId:one.id,password})).status,400);
  assert.equal((await request(admin,'/auth/file-access',{serverId:one.id,password:'wrong',confirmed:true})).status,403);
  const enabled=await request(admin,'/auth/file-access',{serverId:one.id,password,confirmed:true});assert.equal(enabled.status,200);
  assert.ok(enabled.data.fileAccess.expires>Date.now());
  assert.equal((await remove(secondSession)).status,403);
  assert.equal((await remove(admin,two.id)).status,403);
  const listing=(await request(admin,base+'/files',undefined,'GET')).data;
  assert.equal(listing.files.find(f=>f.path==='bedrock_server').capabilities.delete,true);
  assert.equal((await request(admin,'/auth/users',{username:'fileoperator',password,role:'operator',allServers:true})).status,201);
  const operator=await authenticate('login',{username:'fileoperator',password});
  assert.equal((await request(operator,'/auth/file-access',{serverId:one.id,password,confirmed:true})).status,403);
  one.status='running';
  assert.equal((await request(operator,base+'/files/create',{path:'live-notes.txt',content:'Works while running'})).status,201);
  assert.equal((await request(operator,base+'/files/compress',{sources:['live-notes.txt'],destination:'live.zip'})).status,200);
  assert.equal((await request(admin,base+'/files/compress',{sources:['worlds/Main'],destination:'unsafe.zip'})).status,409);
  assert.equal((await request(admin,base+'/file?path=worlds/Main/db/table',undefined,'DELETE')).status,409);
  assert.equal((await remove(admin)).status,403);
  one.status='stopped';
  assert.equal((await request(admin,base+'/file?path=../escape',undefined,'DELETE')).status,400);
  assert.equal((await request(admin,'/auth/file-access',{serverId:one.id},'DELETE')).status,200);
  assert.equal((await remove(admin)).status,403);
  assert.equal((await request(admin,'/auth/file-access',{serverId:one.id,password,confirmed:true})).status,200);
  const realNow=Date.now;Date.now=()=>realNow()+11*60*1000;
  try{assert.equal((await remove(admin)).status,403);}finally{Date.now=realNow;}
  assert.equal((await request(admin,'/auth/file-access',{serverId:one.id,password,confirmed:true})).status,200);
  assert.equal((await remove(admin)).status,200);
  assert.ok(runtime.store.data.activity.some(e=>e.action==='file.access.enable'));
  assert.ok(runtime.store.data.activity.some(e=>e.action==='file.access.disable'));
});
