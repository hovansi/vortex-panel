import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';
import { createApplicationRuntime } from '../server/application-runtime.js';
import { serializeProperties } from '../server/safety.js';
import { createDirectoryStorageFixture } from './storage-fixture.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
async function fixture(t, { reserveRatio = 0.1 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-capacity-start-'));
  const store = createStore(directory), server = { id: randomUUID(), name: 'Grandfathered ceiling fixture', version: '1.26.52.3', channel: 'stable', status: 'stopped', port: 43820, portV6: 43821, transport: 'raknet', maxPlayers: 8, autoStart: false, autoRestart: false, worldVoiceEnabled: false, resourcePolicy: { mode: 'fixed', cpuCores: 1, memoryMiB: 1843 }, runtimeFiles: ['bedrock_server'], backups: [] };
  const host = { cpus: 1, memoryTotal: 2 * GIB, memoryAvailable: 128 * MIB, diskTotal: 100 * GIB, diskAvailable: 80 * GIB };
  const run = path.join(directory, 'servers', server.id, 'run');
  await fs.mkdir(run, { recursive: true }); await fs.writeFile(path.join(run, 'bedrock_server'), 'INERT fixture, resource spawn is injected and never executes this file.');
  await fs.writeFile(path.join(run, 'server.properties'), serializeProperties({ 'server-name': server.name, transport: 'raknet', 'server-port': server.port, 'server-portv6': server.portV6, 'max-players': 8, 'enable-lan-visibility': false, 'level-name': 'Owned', 'online-mode': true, 'allow-list': false, 'allow-cheats': false, gamemode: 'survival', difficulty: 'normal', 'view-distance': 16, 'tick-distance': 4, 'max-threads': 0 }));
  store.data.servers.push(server); store.save();
  const prepared = [], spawned = [];
  const caps = { fixedSupported: true, sharedSupported: true, memory: { minMiB: 256, maxMiB: 2048 } };
  const resources = { capabilities: async () => caps, initialize: async () => caps, async prepare(id, policy) {
    prepared.push({ id, policy });
    return { policy, effective: { cgroupPath: null }, cleanup: async () => ({ stats: null }), spawn(executable) {
      spawned.push(executable);
      const child = new EventEmitter(); Object.assign(child, { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
      let closed = false;
      const finish = () => { if (!closed) { closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); } };
      child.stdin.on('data', line => { if (line.toString().trim() === 'stop') setImmediate(finish); });
      child.kill = () => { child.killed = true; setImmediate(finish); return true; };
      setImmediate(() => child.stdout.write('[2026-10-15 09:00:00:000 INFO] Server started.\n'));
      return { child, ready: Promise.resolve({ kernelEnforced: false, testFixture: true }) };
    } };
  } };
  const network = { initialize: async () => ({ supported: false }), capabilities: () => ({ supported: false }), syncServers: async () => {}, sample: async () => ({}), peek: () => null, close: async () => {} };
  // Keep the real Linux/root pending-build admission guard active even on a
  // Windows test runner. Missing application PIDs support remains legitimate
  // for this Bedrock fixture and must not create application-owned state.
  const application = createApplicationRuntime({ dataDir: directory, platform: 'linux', uid: 0, resourceController: resources });
  const manager = await createManager({ store, dataDir: directory, reserveRatio, hostReader: async () => ({ ...host }), storageController: createDirectoryStorageFixture(directory), resourceController: resources, networkMetrics: network, applicationController: application });
  assert.equal(application.capabilities().supported, false);
  t.after(async () => { await manager.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store, server, host, manager, prepared, spawned };
}

test('critical or unknown start headroom leaves existing server metadata and configured ceilings untouched before any spawn', async t => {
  const f = await fixture(t), original = JSON.stringify(f.server), properties = await fs.readFile(path.join(f.directory, 'servers', f.server.id, 'run', 'server.properties'), 'utf8');
  await assert.rejects(f.manager.action(f.server.id, 'start'), { code: 'CAPACITY_MEMORY_PRESSURE', status: 409 });
  assert.equal(JSON.stringify(f.server), original); assert.equal(f.prepared.length, 0); assert.equal(f.spawned.length, 0);
  f.host.memoryAvailable = undefined;
  await assert.rejects(f.manager.action(f.server.id, 'start'), { code: 'CAPACITY_INPUT', status: 503 });
  f.host.memoryAvailable = GIB; f.host.sampledAt = new Date(Date.now() - 16000).toISOString();
  await assert.rejects(f.manager.action(f.server.id, 'start'), { code: 'CAPACITY_INPUT', status: 503 });
  assert.equal(JSON.stringify(f.server), original); assert.equal(f.spawned.length, 0);
  assert.equal(await fs.readFile(path.join(f.directory, 'servers', f.server.id, 'run', 'server.properties'), 'utf8'), properties);
});

test('worker start uses observed RAM headroom without subtracting the main-panel percentage reserve', async t => {
  const main = await fixture(t), worker = await fixture(t, { reserveRatio: 0 });
  main.host.memoryAvailable = worker.host.memoryAvailable = 300 * MIB;
  await assert.rejects(main.manager.action(main.server.id, 'start'), { code: 'CAPACITY_MEMORY_PRESSURE' });
  assert.equal(main.spawned.length, 0);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try {
    const v4 = dgram.createSocket('udp4'); await new Promise(resolve => v4.bind(0, '127.0.0.1', resolve));
    worker.server.port = v4.address().port; await new Promise(resolve => v4.close(resolve));
    const v6 = dgram.createSocket('udp6'); await new Promise(resolve => v6.bind(0, '::1', resolve));
    worker.server.portV6 = v6.address().port; await new Promise(resolve => v6.close(resolve));
    if (worker.server.portV6 === worker.server.port) worker.server.portV6 = worker.server.port === 65535 ? 65534 : worker.server.port + 1;
    const filename = path.join(worker.directory, 'servers', worker.server.id, 'run', 'server.properties');
    await fs.writeFile(filename, (await fs.readFile(filename, 'utf8')).replace(/^server-port=.*$/m, `server-port=${worker.server.port}`).replace(/^server-portv6=.*$/m, `server-portv6=${worker.server.portV6}`));
    await worker.manager.action(worker.server.id, 'start');
    assert.equal(worker.spawned.length, 1);
    await worker.manager.action(worker.server.id, 'stop');
    const dashboard = await worker.manager.dashboard();
    assert.equal(dashboard.host.capacity.reserveRatio, 0);
  } finally { await worker.manager.close(); Object.defineProperty(process, 'platform', descriptor); }
});

test('fresh noncritical headroom permits existing larger ceilings and grandfathered CPU policy without reallocating them', async t => {
  const f = await fixture(t), descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  f.host.memoryAvailable = Math.floor(1.4 * GIB);
  // Model only the native process boundary. The inert file is never executed,
  // and neither test resources nor directory storage claim kernel enforcement.
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try {
    // Reserve a fresh OS-selected UDP port for this fixture; the production
    // start still performs its real IPv4/IPv6 bind probes before fake spawn.
    const socket = dgram.createSocket('udp4'); await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    f.server.port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const v6 = dgram.createSocket('udp6'); await new Promise(resolve => v6.bind(0, '::1', resolve));
    f.server.portV6 = v6.address().port; await new Promise(resolve => v6.close(resolve));
    if (f.server.portV6 === f.server.port) f.server.portV6 = f.server.port === 65535 ? 65534 : f.server.port + 1;
    const filename = path.join(f.directory, 'servers', f.server.id, 'run', 'server.properties');
    const properties = (await fs.readFile(filename, 'utf8')).replace(/^server-port=.*$/m, `server-port=${f.server.port}`).replace(/^server-portv6=.*$/m, `server-portv6=${f.server.portV6}`);
    await fs.writeFile(filename, properties);
    const result = await f.manager.action(f.server.id, 'start'); assert.equal(result.server.pid, process.pid);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.manager.getServer(f.server.id).status, 'running'); assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.prepared[0].policy, { mode: 'fixed', cpuCores: 1, memoryMiB: 1843 });
    assert.deepEqual(f.server.resourcePolicy, { mode: 'fixed', cpuCores: 1, memoryMiB: 1843 });
    await f.manager.action(f.server.id, 'stop'); assert.equal(f.server.status, 'stopped');
    await assert.rejects(fs.lstat(path.join(f.directory, '.application-users')), { code: 'ENOENT' });
  } finally { await f.manager.close(); Object.defineProperty(process, 'platform', descriptor); }
  t.diagnostic('Real files and UDP port probes; resource prepare/spawn and stdout are injected. This is no Ubuntu/BDS or cgroup execution claim.');
});
