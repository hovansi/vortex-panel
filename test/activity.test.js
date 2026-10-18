import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

test('audit preserves explicit server identity across identical names, rename and store reload', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vortex-activity-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=createStore(dir);
  store.data.servers=[{id:'one',name:'A'},{id:'two',name:'A'}];
  store.audit('server.start','A','operator',undefined,'one');
  store.audit('server.stop','A','operator',undefined,'two');
  store.data.servers[0].name='Renamed';
  store.audit('world.select','Renamed: Old world','operator',undefined,'one');
  store.audit('auth.login','Signed in','admin');
  const reloaded=createStore(dir);
  assert.deepEqual(reloaded.data.activity.filter(row=>row.serverId==='one').map(row=>row.action),['world.select','server.start']);
  assert.deepEqual(reloaded.data.activity.filter(row=>row.serverId==='two').map(row=>row.action),['server.stop']);
  assert.equal(Object.hasOwn(reloaded.data.activity.find(row=>row.action==='auth.login'),'serverId'),false);
  assert.equal(reloaded.data.activity.find(row=>row.action==='server.start').detail,'A');
});

test('audit durable-write failure preserves all history and the previous array', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vortex-activity-rollback-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=createStore(dir);
  const before=Array.from({length:1000},(_,n)=>({id:'old-'+n,action:'existing',detail:String(n)}));
  store.data.activity=before;
  store.save=()=>{throw Object.assign(new Error('write failed'),{code:'ENOSPC'});};
  assert.throws(()=>store.audit('world.select','A','operator',undefined,'one'),/write failed/);
  assert.equal(store.data.activity,before);
  assert.equal(store.data.activity.length,1000);
  assert.equal(store.data.activity.at(-1).id,'old-999');
});
