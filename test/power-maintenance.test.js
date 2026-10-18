import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { createSystemPowerController } from '../server/system-power.js';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-power-maintenance-'));
  const server = { id: randomUUID(), name: 'Inert maintenance fixture', version: '1.26.52.3', channel: 'stable', transport: 'raknet', port: 39132, portV6: 39133, maxPlayers: 10, status: 'running', runtimeFiles: ['bedrock_server'], backups: [], demoFiles: { 'server.properties': 'level-name=Main\n', 'notes.txt': 'original' } };
  const store = { data: { servers: [server], versions: [], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  const manager = await createManager({ store, dataDir, demo: true });
  t.after(async () => { await manager.close(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { manager, server, dataDir };
}
const request = () => ({ action: 'restart-service', requestId: randomUUID() });

test('zram and uninstall exclude power and server mutations while preserving running reads', async t => {
  for (const action of ['zram', 'uninstall']) {
    const { manager, server, dataDir } = await fixture(t);
    const power = createSystemPowerController({ role: 'panel', nodeId: 'local', dataDir, manager,
      store: { audit() {} }, bootId: 'inert-boot', probe: async () => ({ available: true }),
      dispatch: async () => { assert.fail('No system command is allowed in this fixture'); } });
    t.after(() => power.close());
    const release = manager.beginMaintenance({ action, requestId: randomUUID() });
    const observed = await power.read(); assert.equal(observed.busy, true);
    await assert.rejects(power.request({ nodeId: 'local', action: 'reboot', confirmed: true, requestId: randomUUID(), revision: observed.revision }), { status: 409 });
    assert.throws(() => manager.withHostOperation(() => assert.fail('Blocked operation must not start')), { status: 409 });
    await assert.rejects(manager.action(server.id, 'stop'), { status: 409 });
    assert.equal(manager.getServer(server.id).status, 'running');
    assert.equal((await manager.readFile(server.id, 'notes.txt')).content, 'original');
    release(); assert.equal((await power.read()).busy, false);
  }
});

test('maintenance freezes all writes while reads and running servers remain available, then releases atomically', async t => {
  const { manager, server } = await fixture(t);
  const input = request(), release = manager.beginMaintenance(input);
  assert.deepEqual(manager.maintenanceStatus(), { active: true, ...input });
  assert.equal(manager.beginMaintenance(input), release);
  assert.throws(() => manager.beginMaintenance(request()), { status: 409 });
  assert.equal((await manager.readFile(server.id, 'notes.txt')).content, 'original');
  assert.equal(manager.getServer(server.id).status, 'running');
  await assert.rejects(manager.writeFile(server.id, 'notes.txt', 'changed'), { status: 409 });
  await assert.rejects(manager.backup(server.id), { status: 409 });
  await assert.rejects(manager.action(server.id, 'stop'), { status: 409 });
  release(); release(); assert.equal(manager.maintenanceStatus(), null);
  await manager.writeFile(server.id, 'notes.txt', 'released');
  assert.equal((await manager.readFile(server.id, 'notes.txt')).content, 'released');
});

test('inflight file work and unfinished server transitions prevent restart admission', async t => {
  const { manager, server } = await fixture(t);
  const pending = manager.writeFile(server.id, 'notes.txt', 'inflight');
  assert.throws(() => manager.beginMaintenance(request()), { status: 409 });
  assert.equal(manager.maintenanceStatus(), null); await pending;
  for (const status of ['starting', 'stopping', 'installing']) {
    server.status = status; assert.throws(() => manager.beginMaintenance(request()), { status: 409 });
  }
  server.status = 'running'; server.jobId = randomUUID();
  assert.throws(() => manager.beginMaintenance(request()), { status: 409 });
  delete server.jobId; const release = manager.beginMaintenance(request()); release();
});

test('invalid maintenance targets never freeze the manager and shutdown completes while frozen', async t => {
  const { manager } = await fixture(t);
  for (const input of [null, { action: 'shutdown', requestId: randomUUID() }, { action: 'reboot', requestId: 'arbitrary' }]) assert.throws(() => manager.beginMaintenance(input), { status: 400 });
  assert.equal(manager.maintenanceStatus(), null);
  manager.beginMaintenance(request()); await manager.close();
});


test('host operations block restart before their first yield and release admission after success or failure', async t => {
  const { manager } = await fixture(t);
  let finish, started = false;
  const gate = new Promise(resolve => { finish = resolve; });
  const work = manager.withHostOperation(async () => { started = true; await gate; return 'firewall-finished'; });
  assert.equal(started, false);
  assert.throws(() => manager.beginMaintenance(request()), { status: 409 });
  await Promise.resolve(); assert.equal(started, true);
  finish(); assert.equal(await work, 'firewall-finished');
  let release = manager.beginMaintenance(request());
  assert.throws(() => manager.withHostOperation(() => {}), { status: 409 });
  release();
  await assert.rejects(manager.withHostOperation(async () => { throw new Error('inert failed system command'); }), /inert failed/);
  release = manager.beginMaintenance(request()); release();
});

test('graceful shutdown drains an admitted host operation and rejects new system writes', async t => {
  const { manager } = await fixture(t);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const work = manager.withHostOperation(() => gate);
  let stopped = false;
  const closing = manager.close().then(() => { stopped = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(stopped, false);
  assert.throws(() => manager.withHostOperation(() => {}), { status: 503 });
  finish(); await work; await closing; assert.equal(stopped, true);
});

test('startup restoration freezes admission despite preexisting work and never bypasses validation or shutdown', async t => {
  const { manager, server } = await fixture(t);
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const work = manager.withHostOperation(() => gate);
  server.status = 'starting';
  const restore = { ...request(), restore: true };
  const release = manager.beginMaintenance(restore);
  assert.deepEqual(manager.maintenanceStatus(), { active: true, action: restore.action, requestId: restore.requestId });
  assert.throws(() => manager.withHostOperation(() => {}), { status: 409 });
  assert.throws(() => manager.beginMaintenance({ action: 'shutdown', requestId: randomUUID(), restore: true }), { status: 400 });
  finish(); await work; server.status = 'running'; release();
  await manager.close();
  assert.throws(() => manager.beginMaintenance({ ...request(), restore: true }), { status: 503 });
});
