import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { serializeProperties, defaultUdpPorts } from '../server/safety.js';
import { validateBedrockProperties } from '../server/configuration.js';

const config = port => ({ 'server-name': 'World', 'server-port': String(port), 'server-portv6': String(port + 1), 'server-udp-ports': defaultUdpPorts(port, 20), transport: 'nethernet', 'max-players': '20', 'level-name': 'World one', 'view-distance': '16', 'tick-distance': '4', 'online-mode': 'true', 'allow-list': 'false', 'allow-cheats': 'false', 'enable-lan-visibility': 'false', gamemode: 'survival', difficulty: 'normal', 'max-threads': '0', 'mojang-future-setting': 'original' });
async function fixture(t, demo = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-config-'));
  const store = { data: { servers: [], versions: [{ version: '1.26.52.3', channel: 'stable', transport: 'nethernet' }], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  for (const port of [28200, 28300]) {
    const server = { id: randomUUID(), name: `Server ${port}`, version: '1.26.52.3', channel: 'stable', port, portV6: port + 1, udpPorts: defaultUdpPorts(port, 20), transport: 'nethernet', maxPlayers: 20, autoStart: false, autoRestart: true, backupRetention: 10, status: 'stopped', createdAt: new Date().toISOString(), runtimeFiles: ['bedrock_server'], demoFiles: { 'server.properties': serializeProperties(config(port)) } };
    store.data.servers.push(server);
    if (!demo) { const run = path.join(directory, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true }); await fs.writeFile(path.join(run, 'server.properties'), server.demoFiles['server.properties']); }
  }
  const manager = await createManager({ store, dataDir: directory, demo });
  t.after(async () => { store.save = () => {}; await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, store, directory, first: store.data.servers[0], second: store.data.servers[1] };
}

test('configuration commits metadata, properties and actor audit once, and rolls all back on failure', async t => {
  const { manager, store, directory, first } = await fixture(t);
  let writes = 0; store.save = () => { writes++; };
  const result = await manager.withActor({ username: 'assigned-operator' }, () => manager.saveConfiguration(first.id, { settings: { name: 'Renamed', autoStart: true, backupRetention: 3 }, properties: { 'server-port': 28400, 'server-portv6': 28401, 'max-players': 40, difficulty: 'hard', 'new-package-property': 'unchanged syntax' }, udpMode: 'auto' }));
  assert.equal(writes, 1); assert.equal(result.server.name, 'Renamed'); assert.equal(result.server.maxPlayers, 40); assert.equal(result.server.autoStart, true);
  assert.equal(result.properties['server-udp-ports'], '28402-28445'); assert.equal(result.network.udpMode, 'auto'); assert.equal(result.network.udpPortCount, 44);
  assert.equal(result.properties['mojang-future-setting'], 'original'); assert.equal(store.data.activity[0].user, 'assigned-operator');
  const filename = path.join(directory, 'servers', first.id, 'run', 'server.properties');
  const beforeText = await fs.readFile(filename, 'utf8'); const beforeServer = structuredClone(first); const beforeActivity = structuredClone(store.data.activity);
  store.save = () => { throw new Error('Injected disk full'); };
  await assert.rejects(manager.saveConfiguration(first.id, { settings: { name: 'Rejected', autoRestart: false }, properties: { 'server-port': 28500, 'server-portv6': 28501, 'max-players': 50 }, udpMode: 'auto' }), /Injected disk full/);
  assert.deepEqual(first, beforeServer); assert.deepEqual(store.data.activity, beforeActivity); assert.equal(await fs.readFile(filename, 'utf8'), beforeText);
  assert.deepEqual((await fs.readdir(path.dirname(filename))).filter(name => name.includes('.rollback') || name.endsWith('.tmp')), []);
  store.save = () => { writes++; };
  const beforeValidationWrites = writes;
  for (const properties of [{ difficulty: 'impossible' }, { 'allow-cheats': 'yes' }, { 'tick-distance': 13 }, { 'view-distance': 4 }, { 'level-name': '../escape' }, { 'server-name': 'invalid;name' }, { 'max-players': 0 }, { 'max-threads': -1 }, { 'compression-threshold': 65536 }, { 'enable-lan-visibility': true }]) {
    await assert.rejects(manager.saveConfiguration(first.id, { settings: { name: 'Must not leak' }, properties }), error => error.status === 400);
    assert.equal(first.name, beforeServer.name); assert.equal(await fs.readFile(filename, 'utf8'), beforeText);
  }
  assert.equal(writes, beforeValidationWrites);
  // An externally damaged mapping remains readable and can be repaired through
  // the same configuration API instead of trapping the operator outside it.
  await fs.writeFile(filename, beforeText.replace('server-udp-ports=28402-28445', 'server-udp-ports=invalid'));
  assert.equal((await manager.configuration(first.id)).network.warnings.length, 1);
  assert.equal((await manager.saveConfiguration(first.id, { udpMode: 'auto' })).properties['server-udp-ports'], '28402-28445');
});

test('configuration preserves custom NAT mappings, scopes transport support and distinguishes running metadata edits', async t => {
  const { manager, store, first } = await fixture(t, true);
  const custom = '203.0.113.10:30400-30403:28600-28603';
  await manager.saveConfiguration(first.id, { properties: { 'server-udp-ports': custom }, udpMode: 'custom' });
  let result = await manager.saveConfiguration(first.id, { properties: { 'server-port': 28700, 'server-portv6': 28701, 'max-players': 45 } });
  assert.equal(result.properties['server-udp-ports'], custom); assert.equal(result.network.udpMode, 'custom');
  await manager.action(first.id, 'start');
  result = await manager.saveConfiguration(first.id, { settings: { name: 'Running metadata', autoRestart: false } });
  assert.equal(result.server.status, 'running'); assert.equal(result.server.name, 'Running metadata');
  await assert.rejects(manager.saveConfiguration(first.id, { settings: { name: 'Rejected running edit' }, properties: { difficulty: 'hard' } }), error => error.status === 409);
  assert.equal(first.name, 'Running metadata');
  const before = structuredClone(first); store.save = () => { throw new Error('Metadata write failure'); };
  assert.throws(() => manager.updateServer(first.id, { name: 'Not committed' }), /Metadata write failure/); assert.deepEqual(first, before);
  store.save = () => {};
  await manager.action(first.id, 'stop');
  first.version = '1.26.60.30'; first.channel = 'preview';
  assert.deepEqual((await manager.configuration(first.id)).network.allowedTransports, ['nethernet']);
  await assert.rejects(manager.saveConfiguration(first.id, { properties: { transport: 'raknet' } }), /Mojang.*deprecated/);
  first.version = '1.20.0.0'; first.channel = 'stable'; store.data.versions.push({ version: first.version, channel: 'stable', transport: 'raknet' });
  assert.deepEqual((await manager.configuration(first.id)).network.allowedTransports, ['raknet']);
  await assert.rejects(manager.saveConfiguration(first.id, { properties: { difficulty: 'hard', transport: 'nethernet' } }), /transport: raknet/);
  assert.equal(validateBedrockProperties({ ...config(28200), 'view-distance': '128', 'max-threads': '0', 'player-idle-timeout': '0', 'server-build-radius-ratio': 'Disabled' })['view-distance'], '128');
});

test('network configuration rejects concurrent overlapping reservations and externally occupied TCP/UDP ports', async t => {
  const { manager, first, second } = await fixture(t);
  const attempts = await Promise.allSettled([first, second].map(server => manager.saveConfiguration(server.id, { properties: { 'server-port': 28800, 'server-portv6': 28801 }, udpMode: 'auto' })));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = attempts.find(item => item.status === 'rejected'); assert.equal(rejected.reason.status, 409);
  const unchanged = first.port === 28800 ? second : first;
  const listener = net.createServer(); await new Promise(resolve => listener.listen(28900, '0.0.0.0', resolve)); t.after(() => new Promise(resolve => listener.close(resolve)));
  await assert.rejects(manager.saveConfiguration(unchanged.id, { properties: { 'server-port': 28900, 'server-portv6': 28901 }, udpMode: 'auto' }), error => error.status === 409 && /TCP 28900/.test(error.message));
  const socket = dgram.createSocket('udp4'); await new Promise(resolve => socket.bind(29002, '0.0.0.0', resolve)); t.after(() => new Promise(resolve => socket.close(resolve)));
  await assert.rejects(manager.saveConfiguration(unchanged.id, { properties: { 'server-port': 29000, 'server-portv6': 29001 }, udpMode: 'auto' }), error => error.status === 409 && /UDP 29002/.test(error.message));
  assert.ok([28200, 28300].includes(unchanged.port));
});

test('explicit inbound script debugger joins port reservations without silently enabling scripting', async t => {
  const { manager, first, second } = await fixture(t, true);
  await manager.saveConfiguration(first.id, { properties: { 'allow-inbound-script-debugging': true, 'force-inbound-debug-port': 29100 } });
  assert.equal((await manager.configuration(first.id)).network.debugPort, 29100);
  await assert.rejects(manager.saveConfiguration(second.id, { properties: { 'server-port': 29100, 'server-portv6': 29101 }, udpMode: 'auto' }), error => error.status === 409);
  await assert.rejects(manager.saveConfiguration(second.id, { properties: { 'allow-inbound-script-debugging': true, 'force-inbound-debug-port': 29100 } }), error => error.status === 409);
  await assert.rejects(manager.cloneServer(first.id, { name: 'Clone', port: 29200, portV6: 29201, eula: true }), /debugger/);
  await manager.saveConfiguration(first.id, { properties: { 'allow-inbound-script-debugging': false } });
  assert.equal((await manager.configuration(first.id)).network.debugPort, null);
  assert.equal((await manager.properties(second.id))['allow-inbound-script-debugging'], undefined);
});

test('a port move retains original reservations until durable commit or rollback', async t => {
  const { manager, store, directory, first, second } = await fixture(t);
  const originalLink = fs.link;
  const firstPath = path.join(directory, 'servers', first.id, 'run', 'server.properties');
  let continueWrite, reachedStaging;
  const staging = new Promise(resolve => { reachedStaging = resolve; });
  const gate = new Promise(resolve => { continueWrite = resolve; });
  fs.link = async (source, destination) => { if (source === firstPath) { reachedStaging(); await gate; } return originalLink(source, destination); };
  t.after(() => { fs.link = originalLink; continueWrite(); });
  store.save = () => { if (first.port === 29300) throw new Error('Reject pending port move'); };
  const moving = manager.saveConfiguration(first.id, { properties: { 'server-port': 29300, 'server-portv6': 29301 }, udpMode: 'auto' });
  await staging;
  try {
    await assert.rejects(manager.saveConfiguration(second.id, { properties: { 'server-port': 28200, 'server-portv6': 28201 }, udpMode: 'auto' }), error => error.status === 409);
  } finally { continueWrite(); }
  await assert.rejects(moving, /Reject pending port move/);
  assert.equal(first.port, 28200); assert.equal(second.port, 28300);
  assert.equal((await manager.properties(first.id))['server-port'], '28200');
});

test('supported RakNet configuration probes IPv4 and IPv6 without IPv6-only flags on UDP4', async t => {
  const { manager, first } = await fixture(t);
  const result = await manager.saveConfiguration(first.id, { properties: { transport: 'raknet', 'server-port': 29400, 'server-portv6': 29401 } });
  assert.equal(result.server.transport, 'raknet'); assert.equal(result.server.udpPorts, null); assert.equal(result.network.udpPortCount, 0);
  assert.equal((await manager.properties(first.id)).transport, 'raknet');
});
