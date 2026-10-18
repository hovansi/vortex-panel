import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createNodeAgent, validateNodeDataDir } from '../server/node-agent.js';
import { initializeNodeConfig, readNodeConfig, rotateNodeToken, nodeConnection } from '../server/node-cli.js';

const nodeId = 'bad0b7aa-38b1-48ea-bd68-f1a8c8fdb910', serverId = '3d1c25ba-3315-40c9-852b-01601723ae36', otherId = 'd2406c25-1311-42c3-8eb5-bad0d0af9118', token = 'Z'.repeat(43);
const actorHeader = actor => Buffer.from(JSON.stringify(actor)).toString('base64url');
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-agent-')); const actors = [], context = new AsyncLocalStorage(); let closed = 0;
  const manager = { initialize() {}, close() { closed++; }, withActor: (actor, next) => context.run(actor, next), listServers: () => [{ id: serverId }, { id: otherId }], getServer: id => ({ id }), schedules: () => [{ id: 'schedule', serverId }], jobs: () => [], activity: () => [], dashboard: async () => ({ servers: [{ id: serverId }, { id: otherId }], jobs: [], history: [], activity: [], capabilities: { hostTerminal: true } }), updateServer: async id => { actors.push(context.getStore()); return { server: { id } }; } };
  const runtime = await createNodeAgent({ dataDir, nodeId, token, manager, store: { data: {} } }); await new Promise(resolve => runtime.server.listen(0, resolve)); assert.equal(runtime.server.address().address, '127.0.0.1');
  t.after(async () => { await runtime.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const endpoint = `http://127.0.0.1:${runtime.server.address().port}`;
  const request = (route, options = {}) => fetch(endpoint + route, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  return { ...runtime, request, endpoint, actors, closed: () => closed };
}

test('agent requires bearer before body parsing and exposes no browser auth, UI or host terminal routes', async t => {
  const f = await fixture(t);
  const unauthorized = await fetch(f.endpoint + '/api/node/identity'); assert.equal(unauthorized.status, 401); assert.equal(unauthorized.headers.get('x-vortex-node-id'), nodeId);
  assert.equal((await fetch(f.endpoint + '/api/servers', { method: 'POST', body: '{notjson', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' } })).status, 401);
  const identity = await f.request('/api/node/identity'); assert.equal(identity.headers.get('x-vortex-node-id'), nodeId);
  assert.deepEqual({ ...(await identity.json()), version: 'ignored' }, { service: 'vortex-node', protocol: 1, nodeId, version: 'ignored', processId: process.pid });
  for (const route of ['/api/auth/login', '/api/host/terminal', '/']) assert.equal((await f.request(route)).status, 404);
  const snapshot = await (await f.request('/api/node/snapshot')).json(); assert.equal(snapshot.nodeId, nodeId); assert.equal(typeof snapshot.version, 'string'); assert.equal(snapshot.schedules.length, 1); assert.equal(snapshot.capabilities.hostTerminal, false);
  const dashboard = await (await f.request('/api/dashboard')).json(); assert.equal(dashboard.capabilities.hostTerminal, false);
  const malformed = await f.request('/api/servers', { headers: { 'X-Vortex-Actor': 'invalid' } }); assert.equal(malformed.status, 400); assert.equal(malformed.headers.get('x-vortex-node-id'), nodeId);
});

test('forwarded users retain role/scope export protection and original audit actor', async t => {
  const f = await fixture(t), operator = { id: 'central-user', username: 'actual.operator', role: 'operator', allServers: false, serverIds: [serverId] }, viewer = { ...operator, role: 'viewer' };
  const headers = actor => ({ 'Content-Type': 'application/json', 'X-Vortex-Actor': actorHeader(actor) });
  assert.equal((await f.request(`/api/servers/${serverId}`, { method: 'PATCH', headers: headers(viewer), body: '{}' })).status, 403);
  assert.equal((await f.request(`/api/servers/${otherId}`, { method: 'PATCH', headers: headers(operator), body: '{}' })).status, 403);
  assert.equal((await f.request(`/api/servers/${serverId}/files/download?path=keys%2Fserver_identity_key.pem`, { headers: headers(viewer) })).status, 403);
  assert.equal((await f.request(`/api/servers/${serverId}`, { method: 'PATCH', headers: headers(operator), body: '{}' })).status, 200);
  assert.equal(f.actors.length, 1); assert.equal(f.actors[0].username, operator.username); assert.equal(f.actors[0].role, 'operator');
  const list = await (await f.request('/api/servers', { headers: headers(viewer) })).json(); assert.deepEqual(list.servers.map(s => s.id), [serverId]);
  assert.equal((await f.request('/api/node/snapshot', { headers: headers(viewer) })).status, 403);
});

test('agent SSE sends bounded live raw-ID events, scopes forwarded viewer and closes on agent shutdown', async t => {
  const f = await fixture(t), aborter = new AbortController();
  const response = await f.request('/api/node/events', { signal: aborter.signal }); const reader = response.body.getReader();
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8'); assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"update"/);
  f.emit({ type: 'log', serverId, log: { line: 'native fixture output' } });
  const event = new TextDecoder().decode((await reader.read()).value); assert.match(event, new RegExp(serverId)); assert.match(event, /native fixture output/);
  f.emit({ type: 'log', serverId, line: 'x'.repeat(128 * 1024) }); assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"update"/);
  const viewer = { id: 'viewer', username: 'actual.viewer', role: 'viewer', allServers: false, serverIds: [serverId] };
  let viewerResponse; f.server.once('request', (_req, res) => { viewerResponse = res; });
  const scoped = await f.request('/api/node/events', { headers: { 'X-Vortex-Actor': actorHeader(viewer) } }), scopedReader = scoped.body.getReader(); await scopedReader.read();
  f.emit({ type: 'log', serverId: otherId, log: { message: 'forbidden other-server event' } }); f.emit({ type: 'log', serverId, log: { message: 'granted scoped event' } });
  const scopedEvent = new TextDecoder().decode((await scopedReader.read()).value); assert.match(scopedEvent, /granted scoped event/); assert.doesNotMatch(scopedEvent, /forbidden/);
  let maximum = 0;
  for (let index = 0; index < 1000; index++) { f.emit({ type: 'log', serverId, log: { message: 'x'.repeat(32768) } }); maximum = Math.max(maximum, viewerResponse.writableLength); }
  assert.ok(maximum <= 1024 ** 2); assert.equal(viewerResponse.destroyed, true); await scopedReader.cancel().catch(() => {});
  aborter.abort(); await reader.cancel().catch(() => {}); await f.close(); assert.equal(f.closed(), 1); await f.close(); assert.equal(f.closed(), 1);
});

test('private configuration preserves identity/data on repeat and token rotation never changes either', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-config-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'node.json'), dataDir = path.join(directory, 'node-data');
  const first = initializeNodeConfig({ configFile, dataDir, host: '127.0.0.1', tls: false }); assert.equal(first.created, true); assert.equal(first.config.token.length, 43);
  const again = initializeNodeConfig({ configFile, dataDir: path.join(directory, 'wrong'), host: '0.0.0.0' }); assert.equal(again.created, false); assert.deepEqual(again.config, first.config);
  rotateNodeToken(configFile); const updated = readNodeConfig(configFile); assert.notEqual(updated.token, first.config.token); assert.equal(updated.nodeId, first.config.nodeId); assert.equal(updated.dataDir, dataDir);
  assert.equal(nodeConnection(updated).endpoint, 'http://127.0.0.1:8443');
  if (process.platform !== 'win32') { assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600); await fs.chmod(configFile, 0o644); assert.throws(() => readNodeConfig(configFile)); }
  await assert.rejects(createNodeAgent({ dataDir, nodeId, token, host: '0.0.0.0' }), /HTTPS/);
  if (process.platform !== 'win32') await fs.chmod(configFile, 0o600);
  await fs.link(configFile, path.join(directory, 'config-link')); assert.throws(() => readNodeConfig(configFile));
});

test('real manager startup uses the node service cgroup identity and keeps a separate durable data lock', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-real-node-manager-'));
  const runtime = await createNodeAgent({ dataDir, nodeId, token });
  t.after(async () => { await runtime.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  assert.equal((await fs.stat(path.join(dataDir, 'panel.lock'))).isFile(), true);
  const dashboard = await runtime.manager.dashboard(); assert.equal(dashboard.capabilities.resourceControl.configuredUnit, process.env.VORTEX_NODE_UNIT || 'vortex-node.service');
  assert.equal(dashboard.capabilities.resourceControl.managedPool.reserveRatio, 0);
  assert.equal(dashboard.host.capacity.reserveRatio, 0);
  assert.equal(dashboard.host.capacity.cpu.reservedCores, 0);
  assert.equal(dashboard.host.capacity.memory.reservedBytes, 0);
  assert.equal(dashboard.host.capacity.storage.reservedBytes, 0);
  await runtime.close(); assert.equal(await fs.stat(path.join(dataDir, 'panel.lock')).then(() => true, () => false), false);
});

test('node closes HTTP listeners even when manager persistence fails during shutdown', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-shutdown-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = { close: async () => { throw Object.assign(new Error('injected persistence failure'), { code: 'ENOSPC' }); } };
  const runtime = await createNodeAgent({ dataDir, nodeId, token, manager, store: {} }); await new Promise(resolve => runtime.server.listen(0, resolve));
  await assert.rejects(runtime.close(), { code: 'ENOSPC' }); assert.equal(runtime.server.listening, false);
});

test('token rotation takes effect only after restart, preserving the bound node identity and existing bytes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-rotate-')); const dataDir = path.join(directory, 'data'), configFile = path.join(directory, 'node.json');
  const first = initializeNodeConfig({ configFile, dataDir, host: '127.0.0.1', tls: false }).config;
  await fs.mkdir(dataDir); await fs.writeFile(path.join(dataDir, 'panel.json'), '{}'); await fs.writeFile(path.join(dataDir, 'world-marker'), 'owned world fixture');
  const active = [];
  t.after(async () => { for (const runtime of active) await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const start = async config => { const runtime = await createNodeAgent({ ...config, tls: undefined, manager: {}, store: {} }); active.push(runtime); await new Promise(resolve => runtime.server.listen(0, resolve)); return runtime; };
  const request = (runtime, credential) => fetch(`http://127.0.0.1:${runtime.server.address().port}/api/node/identity`, { headers: { Authorization: `Bearer ${credential}` } });
  const running = await start(first); rotateNodeToken(configFile); const updated = readNodeConfig(configFile);
  assert.equal((await request(running, updated.token)).status, 401); assert.equal((await request(running, first.token)).status, 200);
  await running.close(); const replacement = await start(updated);
  assert.equal((await request(replacement, first.token)).status, 401); assert.equal((await (await request(replacement, updated.token)).json()).nodeId, first.nodeId);
  assert.equal(await fs.readFile(path.join(dataDir, 'world-marker'), 'utf8'), 'owned world fixture');
});

test('node data rejects panel ancestors/descendants, symlink ancestors and unrelated populated directories', async t => {
  for (const value of ['/var/lib/bedrock-panel', '/var/lib/bedrock-panel/agent', '/var/lib']) assert.throws(() => validateNodeDataDir(path.resolve(value)), /overlap/);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-paths-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const unrelated = path.join(directory, 'unrelated'); await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'private-user-data.txt'), 'unrelated bytes'); assert.throws(() => validateNodeDataDir(unrelated), /empty/);
  const real = path.join(directory, 'real'), link = path.join(directory, 'alias'); await fs.mkdir(real); await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => validateNodeDataDir(path.join(link, 'new-agent-data')), /symlink/);
});
