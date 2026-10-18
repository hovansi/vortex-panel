import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';
import { serializeProperties } from '../server/safety.js';
import { LOG_RETENTION_DEFAULTS } from '../server/log-retention.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';
import { federationFixture, eventually, COLLISION_ID } from './nodes080-fixture.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function unusedPort(type, address) {
  const socket = dgram.createSocket(type); await new Promise(resolve => socket.bind(0, address, resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function nativeFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-console-run-')), store = createStore(dataDir), children = [], events = [];
  const server = { id: randomUUID(), name: 'Run isolation', status: 'stopped', version: '1.26.52.3', port: await unusedPort('udp4', '127.0.0.1'), portV6: await unusedPort('udp6', '::1'), transport: 'raknet', maxPlayers: 8, autoStart: false, autoRestart: false, worldVoiceEnabled: false, backups: [] };
  const run = path.join(dataDir, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, 'bedrock_server'), 'INERT. The injected launcher never executes this file.');
  await fs.writeFile(path.join(run, 'server.properties'), serializeProperties({ 'server-name': server.name, 'server-port': server.port, 'server-portv6': server.portV6, transport: 'raknet', 'max-players': 8, 'enable-lan-visibility': false, 'level-name': 'Main', 'online-mode': true, 'allow-list': false, 'allow-cheats': false, gamemode: 'survival', difficulty: 'normal', 'view-distance': 16, 'tick-distance': 4, 'max-threads': 0 }));
  store.data.servers.push(server); store.save();
  let prepareError = false;
  const caps = { fixedSupported: false, sharedSupported: true };
  const resources = { capabilities: async () => caps, initialize: async () => caps, async prepare(_id, policy) {
    if (prepareError) throw new Error('Injected launch admission failure');
    return { policy, effective: { cgroupPath: null }, cleanup: async () => ({ stats: null }), spawn() {
      const child = Object.assign(new EventEmitter(), { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
      let ended = false;
      const finish = () => { if (!ended) { ended = true; child.emit('close', 0, null); } };
      child.kill = () => { child.killed = true; setImmediate(finish); return true; };
      child.stdin.on('data', data => { if (data.toString().trim() === 'stop') setImmediate(finish); });
      children.push(child); setImmediate(() => child.stdout.write('[2026-10-16 09:00:00:001 INFO] Server started.\n'));
      return { child, ready: Promise.resolve({ testFixture: true }) };
    } };
  } };
  const network = { initialize: async () => ({ supported: false }), capabilities: () => ({ supported: false }), syncServers: async () => {}, sample: async () => ({}), peek: () => null, close: async () => {} };
  const manager = await createManager({ store, dataDir, hostReader: directoryFixtureHost, storageController: createDirectoryStorageFixture(dataDir), resourceController: resources, networkMetrics: network, emit: value => events.push(value) });
  t.after(async () => { await manager.close(); for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); } await fs.rm(dataDir, { recursive: true, force: true }); });
  const action = async (...args) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    try { return await manager.action(server.id, ...args); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
  };
  return { manager, store, server, dataDir, children, events, action, failPrepare(value = true) { prepareError = value; } };
}

test('native restart and automatic starts reset current console; late stdout, stderr and process callbacks cannot enter a later run', async t => {
  const f = await nativeFixture(t); await f.action('start'); await turn();
  const first = f.manager.consoleState(f.server.id).runId, old = f.children[0];
  old.stdout.write('first run player message\n'); old.stderr.write('old partial without newline');
  assert.ok(f.manager.logs(f.server.id).some(row => row.message.includes('first run')));
  await f.action('restart'); await turn();
  const next = f.manager.consoleState(f.server.id).runId; assert.notEqual(first, next);
  assert.ok(f.manager.logs(f.server.id).every(row => row.runId === next && !row.message.includes('first run')));
  const count = f.manager.logs(f.server.id).length;
  old.stdout.write('late first run\nServer started.\n'); old.stderr.end(' stale tail\n');
  old.stdin.emit('error', new Error('old stdin error')); old.emit('error', new Error('old process error')); await turn();
  assert.equal(f.manager.logs(f.server.id).length, count); assert.equal(f.manager.getServer(f.server.id).error, null);
  const reset = f.events.findLast(value => value.type === 'console-reset'); assert.equal(reset.runId, next);
  for (const event of f.events.filter(value => value.type === 'log')) assert.equal(event.runId, event.log.runId);
  await f.action('stop'); await f.action('start', true); await turn();
  assert.notEqual(f.manager.consoleState(f.server.id).runId, next);
  assert.ok(f.manager.logs(f.server.id).every(row => row.runId === f.manager.getServer(f.server.id).consoleRunId));
});

test('a rejected preflight preserves the console generation; an admitted launch failure starts a new console with its own error', async t => {
  const f = await nativeFixture(t); await f.action('start'); await turn();
  const running = f.manager.consoleState(f.server.id).runId;
  await assert.rejects(f.action('start'), error => error.status === 409); assert.equal(f.manager.consoleState(f.server.id).runId, running);
  await f.action('stop'); f.failPrepare();
  await assert.rejects(f.action('start'), /Injected launch admission failure/);
  const failed = f.manager.consoleState(f.server.id).runId; assert.notEqual(failed, running);
  assert.equal(f.manager.logs(f.server.id).length, 1); assert.match(f.manager.logs(f.server.id)[0].message, /Injected launch admission failure/);
  assert.equal(f.manager.logs(f.server.id)[0].runId, failed);
});

test('a start-state commit failure restores the stopped metadata without spawning or leaving a transition lock', async t => {
  const f = await nativeFixture(t); await f.action('start'); await turn(); await f.action('stop');
  const stopped = structuredClone(f.server), oldRun = f.manager.consoleState(f.server.id).runId, count = f.children.length, save = f.store.save;
  f.store.save = () => { throw new Error('Injected start-state disk failure'); };
  await assert.rejects(f.action('start'), /Injected start-state disk failure/);
  assert.deepEqual(f.server, stopped); assert.equal(f.manager.getServer(f.server.id).busy, false); assert.equal(f.children.length, count);
  const failedRun = f.manager.consoleState(f.server.id).runId; assert.notEqual(failedRun, oldRun);
  assert.ok(f.manager.logs(f.server.id).some(row => row.runId === failedRun && row.level === 'error' && /Injected start-state disk failure/.test(row.message)));
  f.store.save = save; await f.action('start'); assert.equal(f.children.length, count + 1); await eventually(() => assert.equal(f.manager.getServer(f.server.id).status, 'running'));
});

test('fresh demo HTTP runs return run metadata and federated reset/log events retain scope and reject inconsistent generation fields', async t => {
  const f = await federationFixture(t, { demoAgents: true }), target = f.remote(0), rawManager = f.agents[0].runtime.manager;
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: f.admin.cookie, Origin: f.base } }), events = [];
  socket.on('message', message => events.push(JSON.parse(message.toString()))); t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await eventually(() => assert.ok(f.central.nodes.stateOf(f.agents[0].linked).online));
  const before = (await f.request(`/servers/${target}/logs`)).data;
  assert.match(before.runId, /^[a-f0-9-]{36}$/); assert.deepEqual(before.logs, []);
  const response = await f.request(`/servers/${target}/start`, { body: {} }); assert.equal(response.status, 200);
  const runId = response.data.server.consoleRunId; assert.notEqual(runId, before.runId);
  await eventually(() => assert.ok(events.some(value => value.type === 'console-reset' && value.serverId === target && value.runId === runId)));
  const logs = (await f.request(`/servers/${target}/logs`)).data;
  assert.equal(logs.runId, runId); assert.ok(logs.logs.length); assert.ok(logs.logs.every(row => row.runId === runId));
  assert.equal(rawManager.consoleState(COLLISION_ID).runId, runId);
  const next = randomUUID(), secret = 'inconsistent run must not cross federation';
  f.agents[0].runtime.emit({ type: 'log', serverId: COLLISION_ID, runId, log: { id: randomUUID(), runId: next, message: secret, source: 'native' } });
  await turn(); await turn(); assert.ok(!events.some(value => value.log?.message === secret));
  await f.request(`/servers/${target}/restart`, { body: {} });
  const after = (await f.request(`/servers/${target}/logs`)).data; assert.notEqual(after.runId, runId);
  assert.ok(after.logs.every(row => row.runId === after.runId));
  assert.ok(after.logs.every(row => !logs.logs.some(old => old.id === row.id)));
  assert.equal(LOG_RETENTION_DEFAULTS.activityEntries, 100); assert.equal(LOG_RETENTION_DEFAULTS.finishedJobEntries, 50);
  const stamp = Date.now();
  for (const [index, runtime] of [f.central, ...f.agents.map(agent => agent.runtime)].entries()) {
    const serverId = index ? COLLISION_ID : f.central.manager.listServers().find(row => row.nodeId === 'local').id;
    const age = index === 1 ? 0 : index === 0 ? 3600000 : 7200000;
    runtime.store.data.jobs = Array.from({ length: 75 }, (_, number) => ({ id: randomUUID(), type: 'backup', serverId, status: 'completed', progress: 100, createdAt: new Date(stamp - age - number * 1000).toISOString(), finishedAt: new Date(stamp - age - number * 1000).toISOString() }));
    runtime.store.data.jobs.push(...Array.from({ length: 3 }, () => ({ id: randomUUID(), type: 'backup', serverId, status: 'running', progress: 20, createdAt: '2025-01-01T00:00:00.000Z' })));
    runtime.store.save();
  }
  const provisionId = randomUUID();
  t.mock.method(f.central.provisioner, 'jobs', () => [{ id: provisionId, type: 'node-provision', serverId: null, adminOnly: true, status: 'completed', createdAt: new Date(stamp + 1000).toISOString(), finishedAt: new Date(stamp + 1000).toISOString() }]);
  await Promise.all(f.agents.map(agent => f.central.nodes.refresh(agent.linked.id, { force: true })));
  const merged = (await f.request('/jobs')).data.jobs;
  assert.equal(merged.filter(row => row.status === 'completed').length, 50);
  assert.equal(merged.filter(row => row.status === 'completed')[0].id, provisionId);
  assert.ok(merged.filter(row => row.status === 'completed' && row.id !== provisionId).every(row => row.nodeId === f.agents[0].linked.id));
  assert.equal(merged.filter(row => row.status === 'running').length, 9);
});
