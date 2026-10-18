import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createManager } from '../server/manager.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-provision-'));
  const source = { id: 'source', name: 'Source', version: '1.20.0.01', channel: 'stable', transport: 'raknet', port: 30000, portV6: 30001, status: 'stopped', maxPlayers: 10, backups: [], runtimeFiles: [], demoFiles: { 'server.properties': 'level-name=Main\ntransport=raknet\n', 'worlds/Main/text.txt': 'world' } };
  const store = { data: { servers: [source], versions: [{ version: source.version, channel: 'stable', cached: true, transport: 'raknet' }], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  const manager = await createManager({ store, dataDir: directory, demo: true });
  t.after(async () => { store.save = () => {}; await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const create = () => manager.createServer({ name: 'New server', version: source.version, channel: 'stable', port: 30100, portV6: 30101, eula: true });
  const clone = () => manager.cloneServer(source.id, { name: 'Clone', port: 30200, portV6: 30201, eula: true });
  return { manager, store, source, create, clone };
}
async function finished(manager, id) {
  for (let count = 0; count < 200; count++) {
    const job = manager.jobs().find(item => item.id === id);
    if (['completed', 'failed'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Provisioning did not finish');
}

test('a failed server registration restores arrays, audit and port availability before retry', async t => {
  const { manager, store, create } = await fixture(t);
  const servers = store.data.servers, jobs = store.data.jobs, activity = store.data.activity;
  store.data.jobs.push(...Array.from({ length: 105 }, (_, index) => ({ id: `old-${index}`, status: 'completed' })));
  const beforeJobs = structuredClone(jobs);
  store.save = () => { throw new Error('Registration disk full'); };
  await assert.rejects(create(), /Registration disk full/);
  assert.equal(store.data.servers, servers); assert.equal(servers.length, 1); assert.equal(store.data.jobs, jobs); assert.deepEqual(jobs, beforeJobs); assert.equal(store.data.activity, activity);
  store.save = () => {}; const accepted = await create();
  assert.equal((await finished(manager, accepted.job.id)).status, 'completed'); assert.equal(manager.getServer(accepted.server.id).status, 'stopped');
});

test('clone registration failure removes the target and restores the source execution lock', async t => {
  const { manager, store, source, clone } = await fixture(t);
  const servers = store.data.servers, activity = store.data.activity;
  store.save = () => { throw new Error('Clone queue write failed'); };
  await assert.rejects(clone(), /Clone queue write failed/);
  assert.equal(store.data.servers, servers); assert.equal(servers.length, 1); assert.equal(source.cloneJobId, undefined); assert.equal(manager.getServer(source.id).busy, false); assert.equal(store.data.activity, activity); assert.equal(store.data.jobs.length, 0);
  store.save = () => {}; const accepted = await clone(); assert.equal((await finished(manager, accepted.job.id)).status, 'completed');
});

test('clone queue persists source lock, target, audit actor and queued job in the same first write', async t => {
  const { manager, store, source, clone } = await fixture(t);
  let writes = 0;
  store.save = () => {
    if (++writes !== 1) return;
    assert.equal(store.data.servers.length, 2); const job = store.data.jobs[0]; assert.equal(job.status, 'queued'); assert.equal(source.cloneJobId, job.id);
    assert.equal(store.data.servers[1].jobId, job.id); assert.equal(store.data.activity[0].action, 'server.clone'); assert.equal(store.data.activity[0].user, 'provisioner');
  };
  const accepted = await manager.withActor({ username: 'provisioner' }, clone);
  assert.equal((await finished(manager, accepted.job.id)).status, 'completed'); assert.equal(source.cloneJobId, undefined);
});

test('a failure after durable queue acceptance remains a visible failed job and retryable instance', async t => {
  const { manager, store, create } = await fixture(t);
  let writes = 0; store.save = () => { if (++writes === 2) throw new Error('Accepted job startup save failed'); };
  const accepted = await create(); const job = await finished(manager, accepted.job.id);
  assert.equal(job.status, 'failed'); assert.match(job.message, /Accepted job startup save failed/);
  assert.equal(manager.getServer(accepted.server.id).status, 'error'); assert.equal(manager.getServer(accepted.server.id).busy, false);
  assert.equal(store.data.activity.some(item => item.action === 'server.create'), true);
});

test('a clone startup failure after queue acceptance releases the source lock even before copying begins', async t => {
  const { manager, store, source, clone } = await fixture(t);
  let writes = 0; store.save = () => { if (++writes === 2) throw new Error('Clone startup write failed'); };
  const accepted = await clone();
  assert.equal((await finished(manager, accepted.job.id)).status, 'failed');
  assert.equal(manager.getServer(accepted.server.id).status, 'error'); assert.equal(manager.getServer(source.id).busy, false); assert.equal(source.cloneJobId, undefined);
  store.save = () => {};
  await manager.savePlayers(source.id, { allowlist: [], permissions: [] });
});
