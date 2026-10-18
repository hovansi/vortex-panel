import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';

async function fixture(t, supported = false, demo = false) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-gameplay-resources-')), store = createStore(dataDir), id = randomUUID(), run = path.join(dataDir, 'servers', id, 'run');
  await fs.mkdir(run, { recursive: true });
  const properties = 'server-name=Resource world\nlevel-name=Resource world\nserver-port=38240\nserver-portv6=38241\ntransport=raknet\nmax-players=20\nallow-cheats=false\nenable-lan-visibility=false\n';
  await fs.writeFile(path.join(run, 'server.properties'), properties);
  const server = { id, name: 'Resource world', version: '1.26.52.3', channel: 'stable', port: 38240, portV6: 38241, transport: 'raknet', maxPlayers: 20, status: 'stopped', createdAt: new Date().toISOString(), backups: [] }; store.data.servers.push(server); store.save();
  const caps = { sharedSupported: true, fixedSupported: supported, supported, reason: supported ? null : 'Giới hạn tài nguyên cần server native trên hệ thống hỗ trợ.' };
  const resourceController = { capabilities: async () => caps, initialize: async () => caps, prepare: async () => { assert.fail('This metadata-only fixture must not launch an engine'); } };
  const manager = await createManager({ store, dataDir, resourceController, demo });
  t.after(async () => { store.save = () => {}; server.status = 'stopped'; await manager.close(); assert.ok(path.basename(dataDir).startsWith('vortex-gameplay-resources-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { manager, store, server, dataDir, run, properties };
}

test('fixed resource metadata persists and rolls back atomically without rewriting BDS properties; changes require stopped state', async t => {
  const { manager, store, server, dataDir, run, properties } = await fixture(t, true), resourcePolicy = { mode: 'fixed', cpuCores: 0.5, memoryMiB: 256 };
  assert.deepEqual(manager.getServer(server.id).resourcePolicy, { mode: 'shared', cpuCores: null, memoryMiB: null });
  const configured = await manager.withActor({ username: 'resourceoperator' }, () => manager.saveConfiguration(server.id, { settings: { resourcePolicy } }));
  assert.deepEqual(configured.resourcePolicy, resourcePolicy); assert.equal(configured.resourceControl.fixedSupported, true); assert.equal(configured.resources.effective, null); assert.equal(configured.resources.usage, null);
  assert.equal(await fs.readFile(path.join(run, 'server.properties'), 'utf8'), properties); assert.deepEqual(createStore(dataDir).data.servers[0].resourcePolicy, resourcePolicy); assert.equal(store.data.activity[0].serverId, server.id); assert.equal(store.data.activity[0].user, 'resourceoperator');
  server.status = 'running'; await assert.rejects(manager.saveConfiguration(server.id, { settings: { resourcePolicy: { mode: 'shared' } } }), error => error.status === 409);
  assert.throws(() => manager.updateServer(server.id, { resourcePolicy: { mode: 'shared' } }), error => error.status === 409);
  const voice = await manager.saveConfiguration(server.id, { settings: { messageLanguage: 'vi' } }); assert.equal(voice.server.messageLanguage, 'vi'); assert.deepEqual(voice.resourcePolicy, resourcePolicy); assert.equal(await fs.readFile(path.join(run, 'server.properties'), 'utf8'), properties);
  server.status = 'stopped'; const before = structuredClone(server), activity = structuredClone(store.data.activity), disk = await fs.readFile(path.join(dataDir, 'panel.json'));
  store.save = () => { throw Error('Injected metadata storage fault'); };
  await assert.rejects(manager.saveConfiguration(server.id, { settings: { resourcePolicy: { mode: 'shared' } } }), /Injected metadata storage fault/); assert.deepEqual(server, before); assert.deepEqual(store.data.activity, activity); assert.deepEqual(await fs.readFile(path.join(dataDir, 'panel.json')), disk); assert.equal(await fs.readFile(path.join(run, 'server.properties'), 'utf8'), properties);
});

test('unsupported fixed enforcement fails before metadata/job changes and running labels without owned processes cannot accept gameplay', async t => {
  const { manager, store, server } = await fixture(t), before = structuredClone(server), activity = store.data.activity.length;
  await assert.rejects(manager.saveConfiguration(server.id, { settings: { resourcePolicy: { mode: 'fixed', cpuCores: 0.5, memoryMiB: 256 } } }), error => error.status === 409);
  assert.deepEqual(server, before); assert.equal(store.data.activity.length, activity);
  server.status = 'running'; const metadata = await manager.gameplay(server.id); assert.equal(metadata.available, false); assert.equal(metadata.world.revision, null); assert.equal(metadata.cheatsEnabled, false); assert.ok(metadata.rules.every(rule => rule.value === null));
  const worldRevision = 'a'.repeat(64); await assert.rejects(manager.queryGameRules(server.id, { worldRevision, keys: ['keepinventory'] }), error => error.status === 409); await assert.rejects(manager.changeGameRules(server.id, { worldRevision, changes: { keepinventory: true }, expected: { keepinventory: false } }), error => error.status === 409); assert.equal(manager.logs(server.id).length, 0); assert.equal(store.data.activity.length, activity);
});

test('diagnostic disk log IDs survive while a new manager current console remains empty and fresh logs have stable run IDs', async t => {
  const { manager, server, run } = await fixture(t), root = path.dirname(run);
  const id = randomUUID(), entry = { id, time: new Date().toISOString(), level: 'info', source: 'native', message: 'keepinventory = false' }, legacy = { ...entry, message: 'Older retained native entry' }; delete legacy.id;
  await fs.writeFile(path.join(root, 'console.log'), [entry, legacy].map(row => JSON.stringify(row)).join('\n') + '\n');
  await manager.initialize(); assert.deepEqual(manager.logs(server.id), []); assert.match(manager.consoleState(server.id).runId, /^[0-9a-f-]{36}$/);
  const persisted = (await fs.readFile(path.join(root, 'console.log'), 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(persisted[0].id, id); assert.equal(persisted[0].message, entry.message); await manager.close();
  const simulated = await fixture(t, false, true); await simulated.manager.action(simulated.server.id, 'start'); const generated = simulated.manager.logs(simulated.server.id)[0]; assert.match(generated.id, /^[0-9a-f-]{36}$/); assert.equal(generated.runId, simulated.manager.consoleState(simulated.server.id).runId); assert.equal(simulated.manager.logs(simulated.server.id)[0].id, generated.id); assert.match(generated.message, /DEMO/);
});
