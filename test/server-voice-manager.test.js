import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';
import { validateServerSettings } from '../server/configuration.js';

async function fixture(t, demo = false) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-server-voice-')), store = createStore(dataDir);
  const server = { id: randomUUID(), name: 'Sky Islands', version: '1.26.52.3', channel: 'stable', transport: 'raknet', port: 31200, portV6: 31201, maxPlayers: 20, status: 'stopped', runtimeFiles: [], backups: [], demoFiles: { 'server.properties': 'server-name=Sky Islands\nserver-port=31200\nserver-portv6=31201\ntransport=raknet\nmax-players=20\nenable-lan-visibility=false\nlevel-name=Main\nallow-cheats=false\n' }, createdAt: new Date().toISOString() };
  store.data.servers.push(server); store.data.versions.push({ version: server.version, channel: 'stable', cached: true, transport: 'raknet' }); store.save();
  const run = path.join(dataDir, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true }); await fs.writeFile(path.join(run, 'server.properties'), server.demoFiles['server.properties']);
  const manager = await createManager({ store, dataDir, demo });
  t.after(async () => { store.save = () => {}; server.status = 'stopped'; await manager.close(); assert.ok(path.basename(dataDir).startsWith('vortex-server-voice-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { manager, store, server, dataDir, run };
}
async function finish(manager, id) {
  for (let count = 0; count < 300; count++) { const record = manager.jobs().find(item => item.id === id); if (['completed', 'failed'].includes(record.status)) { assert.equal(record.status, 'completed', record.message); return; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Job did not finish');
}

test('server voice settings validate strictly with safe legacy defaults', () => {
  assert.deepEqual(validateServerSettings({ messageLanguage: 'vi', worldVoiceEnabled: false }), { messageLanguage: 'vi', worldVoiceEnabled: false });
  for (const value of ['VI', 'vi-VN', 'fr', '', null, undefined, 1, {}, []]) assert.throws(() => validateServerSettings({ messageLanguage: value }), error => error.status === 400);
  for (const value of ['true', 1, null, {}]) assert.throws(() => validateServerSettings({ worldVoiceEnabled: value }), error => error.status === 400);
});

test('server message language persists as metadata while running without rewriting properties and rolls back atomically', async t => {
  const x = await fixture(t), filename = path.join(x.run, 'server.properties'), original = await fs.readFile(filename), originalFields = { port: x.server.port, portV6: x.server.portV6, transport: x.server.transport, maxPlayers: x.server.maxPlayers };
  assert.equal(x.manager.getServer(x.server.id).messageLanguage, 'en'); assert.equal(x.manager.getServer(x.server.id).worldVoiceEnabled, true);
  x.server.messageLanguage = 'vi-VN'; assert.equal(x.manager.getServer(x.server.id).messageLanguage, 'en'); delete x.server.messageLanguage;
  x.server.status = 'running';
  const changed = await x.manager.withActor({ username: 'assignedoperator' }, () => x.manager.saveConfiguration(x.server.id, { settings: { messageLanguage: 'vi', worldVoiceEnabled: false } }));
  assert.equal(changed.server.status, 'running'); assert.equal(changed.server.messageLanguage, 'vi'); assert.equal(changed.server.worldVoiceEnabled, false); assert.deepEqual(await fs.readFile(filename), original);
  const persisted = createStore(x.dataDir).data.servers.find(server => server.id === x.server.id); assert.equal(persisted.messageLanguage, 'vi'); assert.equal(persisted.worldVoiceEnabled, false);
  for (const [key, value] of Object.entries(originalFields)) assert.equal(x.server[key], value);
  assert.equal(x.store.data.activity[0].serverId, x.server.id); assert.equal(x.store.data.activity[0].user, 'assignedoperator');
  const before = structuredClone(x.server), activity = structuredClone(x.store.data.activity), disk = await fs.readFile(path.join(x.dataDir, 'panel.json'));
  x.store.save = () => { throw Error('Metadata disk full'); };
  assert.throws(() => x.manager.updateServer(x.server.id, { messageLanguage: 'en', worldVoiceEnabled: true }), /Metadata disk full/);
  assert.deepEqual(x.server, before); assert.deepEqual(x.store.data.activity, activity); assert.deepEqual(await fs.readFile(filename), original); assert.deepEqual(await fs.readFile(path.join(x.dataDir, 'panel.json')), disk);
});

test('new servers persist English by default and clones inherit only the source server voice settings', async t => {
  const x = await fixture(t, true); x.manager.updateServer(x.server.id, { messageLanguage: 'vi', worldVoiceEnabled: false });
  const created = await x.manager.createServer({ name: 'Fresh default', version: x.server.version, port: 31300, portV6: 31301, eula: true });
  await finish(x.manager, created.job.id); const fresh = x.store.data.servers.find(item => item.id === created.server.id); assert.equal(fresh.messageLanguage, 'en'); assert.equal(fresh.worldVoiceEnabled, true);
  const cloned = await x.manager.cloneServer(x.server.id, { name: 'Inherited', port: 31400, portV6: 31401, eula: true }); await finish(x.manager, cloned.job.id);
  const clone = x.store.data.servers.find(item => item.id === cloned.server.id); assert.equal(clone.messageLanguage, 'vi'); assert.equal(clone.worldVoiceEnabled, false); assert.equal(clone.autoStart, false);
});

test('authoritative announcement language, strict body, single-line formatting and preview conflicts precede any send', async t => {
  const x = await fixture(t, true); await x.manager.action(x.server.id, 'start'); const base = { templateId: 'welcome', values: { worldName: 'Sky Islands', playerName: 'Traveler' }, expectedLanguage: 'en' };
  const initial = x.manager.withActor({ username: 'voiceoperator' }, () => x.manager.announcement(x.server.id, base));
  assert.equal(initial.acceptedToConsole, false); assert.equal(initial.simulated, true); assert.equal(initial.announcement.language, 'en'); assert.equal(initial.announcement.method, 'say'); assert.match(initial.announcement.minecraftMessage, /A new chapter opens/); assert.ok(!initial.announcement.minecraftMessage.includes('[Vortex]'));
  assert.equal(x.store.data.activity[0].action, 'server.announcement'); assert.equal(x.store.data.activity[0].serverId, x.server.id); assert.equal(x.store.data.activity[0].user, 'voiceoperator');
  x.manager.updateServer(x.server.id, { messageLanguage: 'vi' }); const logs = x.manager.logs(x.server.id).length, activity = structuredClone(x.store.data.activity);
  assert.throws(() => x.manager.announcement(x.server.id, base), error => error.status === 409); assert.equal(x.manager.logs(x.server.id).length, logs); assert.deepEqual(x.store.data.activity, activity);
  const vi = x.manager.announcement(x.server.id, { ...base, expectedLanguage: 'vi' }); assert.match(vi.announcement.minecraftMessage, /Một chương mới mở ra/);
  for (const input of [null, [], {}, { ...base, language: 'en' }, { ...base, command: 'stop' }, { ...base, unexpected: 'secret' }, { ...base, expectedLanguage: 'VI' }, { ...base, expectedLanguage: 'vi', values: [] }, { ...base, expectedLanguage: 'vi', method: 'arbitrary' }]) assert.throws(() => x.manager.announcement(x.server.id, input), error => error.status === 400);
  const malformed = { templateId: 'custom', values: { tone: 'adventure', message: 'Hello\nstop\r§cworld' }, expectedLanguage: 'vi' }, safe = x.manager.announcement(x.server.id, malformed);
  assert.deepEqual(safe.announcement.changedFields, ['message']); assert.equal(safe.announcement.normalizedValues.message, 'Hello stop world'); assert.ok(!/[\r\n]/.test(safe.announcement.minecraftMessage));
  assert.throws(() => x.manager.announcement(x.server.id, { templateId: 'custom', values: { message: '@a' } }), error => error.status === 400);
  const literal = x.manager.announcement(x.server.id, { templateId: 'custom', values: { message: '@a' }, method: 'tellraw' }); assert.equal(literal.announcement.normalizedValues.message, '@a');
  await x.manager.action(x.server.id, 'stop'); const stoppedLogs = x.manager.logs(x.server.id).length; assert.throws(() => x.manager.announcement(x.server.id, { templateId: 'backup' }), error => error.status === 409); assert.equal(x.manager.logs(x.server.id).length, stoppedLogs);
});

test('a running metadata label without an owned native process cannot accept an announcement', async t => {
  const x = await fixture(t); x.server.status = 'running'; const logs = x.manager.logs(x.server.id).length;
  assert.throws(() => x.manager.announcement(x.server.id, { templateId: 'backup' }), error => error.status === 409);
  assert.equal(x.manager.logs(x.server.id).length, logs);
});
