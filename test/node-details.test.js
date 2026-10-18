import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNodes } from '../server/nodes.js';
import { createStore } from '../server/store.js';
import { federationFixture, COLLISION_ID } from './nodes080-fixture.js';

const packageVersion = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

async function emptyLocal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-details-'));
  const store = createStore(directory);
  store.data.settings.existingSetting = 'preserve'; store.save();
  const manager = { dashboard: async () => ({ servers: [], host: { hostname: 'real-os-host' }, capabilities: {} }), listServers: () => [], jobs: () => [], schedules: () => [], activity: () => [], close: async () => {} };
  const nodes = createNodes({ store, localManager: manager, dataDir: directory, demo: true });
  t.after(async () => { await nodes.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, nodes, directory };
}

test('Main details distinguish the real panel process from an absent agent and preserve a genuine zero server count', async t => {
  const { store, nodes } = await emptyLocal(t), before = JSON.stringify(store.data.settings);
  const row = (await nodes.publicNodes())[0];
  assert.equal(row.name, 'Vortex Main'); assert.equal(row.serverCount, 0); assert.equal(row.runningServers, 0);
  assert.equal(row.version, packageVersion); assert.equal(row.agentId, null); assert.equal(row.fingerprint, null); assert.equal(row.endpoint, null);
  assert.deepEqual(row.controlPlane, { kind: 'local-panel', service: 'vortex-panel', version: packageVersion, processId: process.pid, agentId: null, tls: { mode: 'in-process', endpoint: null, fingerprint: null } });
  assert.equal(row.host.hostname, 'real-os-host'); assert.equal(JSON.stringify(store.data.settings), before);
  assert.equal(Object.hasOwn(store.data.settings, 'localNodeName'), false, 'Reading the default name must not implicitly migrate persisted settings');
});

test('explicit local display-name commit preserves unrelated settings and rolls back all metadata on durable audit failure', async t => {
  const { store, nodes, directory } = await emptyLocal(t);
  const updated = await nodes.update('local', { name: '  My Main Panel  ' }, { username: 'named-admin' });
  assert.equal(updated.name, 'My Main Panel'); assert.equal(updated.host.hostname, 'real-os-host');
  assert.equal(store.data.settings.existingSetting, 'preserve'); assert.equal(store.data.activity[0].user, 'named-admin');
  assert.equal(createStore(directory).data.settings.localNodeName, 'My Main Panel');
  const before = { settings: store.data.settings, activity: store.data.activity, nodes: store.data.nodes, disk: await fs.readFile(path.join(directory, 'panel.json'), 'utf8') };
  const originalSave = store.save;
  store.save = () => { throw new Error('ENOSPC injected private failure'); };
  await assert.rejects(nodes.update('local', { name: 'Rejected Name' }, { username: 'named-admin' }), /ENOSPC/);
  store.save = originalSave;
  assert.strictEqual(store.data.settings, before.settings); assert.strictEqual(store.data.activity, before.activity); assert.strictEqual(store.data.nodes, before.nodes);
  assert.equal((await nodes.publicNodes())[0].name, 'My Main Panel'); assert.equal(await fs.readFile(path.join(directory, 'panel.json'), 'utf8'), before.disk);
  for (const body of [{ name: '' }, { name: 'x\ny' }, { name: 'a'.repeat(81) }, { name: 'Safe', endpoint: 'https://replace.example' }, { maintenance: true }, {}]) await assert.rejects(nodes.update('local', body), { status: 400 });
  assert.equal((await nodes.update('local', { name: 'a'.repeat(80) })).name.length, 80);
});

test('Admin local and remote display-name HTTP edits persist independently without changing OS, identity or connection metadata', async t => {
  const f = await federationFixture(t);
  const before = (await f.request('/nodes')).data.nodes;
  const remote = before.find(row => row.id === f.agents[0].linked.id), local = before.find(row => row.id === 'local');
  const changed = await f.request('/nodes/local', { method: 'PATCH', body: { name: ' Main Display Only ' } });
  assert.equal(changed.status, 200); assert.equal(changed.data.node.name, 'Main Display Only');
  assert.deepEqual(changed.data.node.host.hostname, local.host.hostname); assert.deepEqual(changed.data.node.controlPlane, local.controlPlane);
  const renamedRemote = await f.request(`/nodes/${remote.id}`, { method: 'PATCH', body: { name: 'Remote Display Only' } });
  assert.equal(renamedRemote.status, 200); assert.equal(renamedRemote.data.node.name, 'Remote Display Only');
  for (const key of ['endpoint', 'agentId', 'fingerprint', 'publicAddress']) assert.equal(renamedRemote.data.node[key], remote[key]);
  assert.equal(renamedRemote.data.node.controlPlane.service, 'vortex-node'); assert.equal(renamedRemote.data.node.controlPlane.processId, process.pid);
  assert.equal(renamedRemote.data.node.controlPlane.tls.mode, 'loopback-http'); assert.equal(renamedRemote.data.node.controlPlane.tls.fingerprint, null);
  const dashboard = (await f.request('/dashboard')).data;
  assert.equal(dashboard.servers.find(row => row.id === COLLISION_ID).nodeName, 'Main Display Only');
  assert.equal(dashboard.servers.find(row => row.id === f.remote(0)).nodeName, 'Remote Display Only');
  assert.equal((await f.request('/nodes/local', { method: 'PATCH', body: { name: 'No CSRF' }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  for (const role of ['viewer', 'operator']) {
    const actor = await f.createUser('name-' + role, { role, allServers: true });
    for (const id of ['local', remote.id]) assert.equal((await f.request(`/nodes/${id}`, { actor, method: 'PATCH', body: { name: 'Denied' } })).status, 403);
  }
  assert.equal((await f.request('/nodes/local', { method: 'PATCH', body: { name: 'Changed', hostname: 'unexpected-os-edit' } })).status, 400);
  await f.restartCentral();
  const after = (await f.request('/nodes')).data.nodes;
  assert.equal(after.find(row => row.id === 'local').name, 'Main Display Only'); assert.equal(after.find(row => row.id === remote.id).name, 'Remote Display Only');
  assert.equal(f.central.store.data.activity.filter(row => row.action === 'node.update' && row.user === 'nodes-admin').length, 2);
  t.diagnostic('Real controller sessions, CSRF, RBAC, headless agents and disk reload; no operating-system hostname command or native Bedrock process is executed.');
});
