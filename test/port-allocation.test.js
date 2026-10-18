import test from 'node:test';
import { fixtureManagedRuntime } from './application-managed-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createPortAllocator, creationPortMode, readHostPortInventory, supportsAutomaticPorts, PORT_ALLOCATION_POLICY } from '../server/port-allocation.js';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';
import { networkPortReservations, parseUdpPorts } from '../server/safety.js';

const inventory = (ports = [], ephemeral = [32768, 60999]) => async () => ({ ports, ephemeral });
const allocator = changes => createPortAllocator({ readInventory: inventory(), random: () => 0, ...changes });
const app = (port, extra = {}) => ({ id: String(port), name: 'Reserved app', kind: 'nodejs', port, portV6: null, transport: 'tcp', ...extra });
const bedrock = (port, extra = {}) => ({ id: String(port), name: 'Reserved world', port, portV6: port + 1, transport: 'raknet', ...extra });
const rejected = code => error => error.code === code;

test('creation defaults to auto only when every numeric port field is omitted, and legacy explicit requests remain manual', () => {
  for (const kind of ['bedrock', 'nodejs', 'python']) assert.equal(creationPortMode({ kind }), 'auto');
  assert.equal(creationPortMode({ port: 30000 }), 'manual');
  assert.equal(creationPortMode({ portAllocation: 'auto' }), 'auto');
  assert.equal(creationPortMode({ portAllocation: 'manual', port: 30000 }), 'manual');
  for (const input of [null, [], { portAllocation: 'random' }, { portAllocation: 'manual' }, ...['port', 'portV6', 'udpPorts', 'debugPort', 'server-port'].map(key => ({ portAllocation: 'auto', [key]: null }))]) assert.throws(() => creationPortMode(input), rejected('PORT_ALLOCATION_INPUT'));
});

test('automatic ports are crypto-selected from all free bounded candidates and never reuse any host protocol, managed metadata or ephemeral range', async () => {
  let choices;
  const allocate = allocator({ minPort: 20000, maxPort: 20010, readInventory: inventory([20000, 20002], [20006, 20008]), random: count => { choices = count; return count - 1; } });
  const servers = [app(20003, { status: 'stopped' }), bedrock(20004)];
  const selected = await allocate({ kind: 'python', servers });
  assert.equal(selected.port, 20010); assert.equal(choices, 3); assert.equal(selected.transport, 'tcp'); assert.equal(selected.portV6, null);
  assert.equal((await allocator({ minPort: 32766, maxPort: 32770 })({ kind: 'nodejs' })).port, 32766);
});

test('NetherNet and unknown transport allocate the complete player-sized block; unused IPv6 metadata and debugger also block automatic choices', async () => {
  for (const transport of ['auto', 'nethernet']) {
    const selected = await allocator({ readInventory: inventory([20017]) })({ transport, maxPlayers: 1000 });
    assert.equal(selected.port, 20018); assert.equal(selected.portV6, 20019);
    assert.equal(parseUdpPorts(selected.udpPorts).length, 1004);
    assert.equal(parseUdpPorts(selected.udpPorts).at(-1), 21023);
  }
  await assert.rejects(allocator({ minPort: 20000, maxPort: 20032 })({ transport: 'nethernet' }), rejected('PORT_ALLOCATION_EXHAUSTED'));
  const selected = await allocator({ minPort: 20000, maxPort: 20040 })({ transport: 'nethernet', servers: [bedrock(21000, { transport: 'nethernet', portV6: 20000, udpPorts: '22000-22031' })] });
  assert.equal(selected.port, 20001);
});

test('bounded allocator matches a brute-force free-placement oracle for every occupied mask in a small pool', async () => {
  for (const kind of ['nodejs', 'bedrock']) for (let mask = 0; mask < 128; mask++) {
    const ports = Array.from({ length: 7 }, (_, n) => 20000 + n).filter((_, n) => mask & (1 << n));
    const expected = Array.from({ length: kind === 'nodejs' ? 7 : 6 }, (_, n) => 20000 + n).filter(port => !ports.includes(port) && (kind !== 'bedrock' || !ports.includes(port + 1)));
    const allocate = allocator({ minPort: 20000, maxPort: 20006, readInventory: inventory(ports) });
    if (!expected.length) await assert.rejects(allocate({ kind, transport: 'raknet' }), rejected('PORT_ALLOCATION_EXHAUSTED'));
    else assert.equal((await allocate({ kind, transport: 'raknet' })).port, expected[0]);
  }
});

test('allocation reads pending reservations after host I/O, without mutating server records', async () => {
  let release; const wait = new Promise(resolve => { release = resolve; }), servers = [];
  const allocate = allocator({ readInventory: async () => { await wait; return { ports: [], ephemeral: [32768, 60999] }; } });
  const pending = allocate({ kind: 'nodejs', servers: () => servers });
  servers.push(app(20000), bedrock(20001)); const before = JSON.stringify(servers); release();
  assert.equal((await pending).port, 20003); assert.equal(JSON.stringify(servers), before);
});

const header = '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
const row = (port, ipv6 = false, state = '0A') => `  0: ${'0'.repeat(ipv6 ? 32 : 8)}:${port.toString(16).padStart(4, '0')} ${'0'.repeat(ipv6 ? 32 : 8)}:0000 ${state} 00000000:00000000 00:00000000 00000000 0 0 1\n`;
function procReader(overrides = {}) { return async filename => overrides[filename] ?? (filename.endsWith('ip_local_port_range') ? '32768\t60999\n' : filename.endsWith('ip_local_reserved_ports') ? '\n' : header); }
test('Linux inventory includes bound UDP, IPv6, connected and TIME_WAIT local ports and actual ephemeral policy', async () => {
  const result = await readHostPortInventory({ platform: 'linux', readFile: procReader({ '/proc/net/tcp': header + row(25000, false, '06'), '/proc/net/tcp6': header + row(25001, true, '01'), '/proc/net/udp': header + row(25002, false, '07'), '/proc/net/udp6': header + row(25003, true, '07') }) });
  assert.deepEqual(result, { ports: [25000, 25001, 25002, 25003], ephemeral: [32768, 60999], reserved: [] });
});
test('unknown, missing, truncated or malformed host inventories fail closed rather than falling back to a fixed port', async () => {
  await assert.rejects(readHostPortInventory({ platform: 'win32', readFile: () => assert.fail('Must not read proc on Windows') }), rejected('PORT_ALLOCATION_INVENTORY'));
  for (const readFile of [async () => { throw Error('unavailable'); }, procReader({ '/proc/net/udp6': 'truncated' }), procReader({ '/proc/net/tcp': header + 'broken row\n' }), procReader({ '/proc/sys/net/ipv4/ip_local_port_range': '60000 32768' })]) await assert.rejects(readHostPortInventory({ platform: 'linux', readFile }), rejected('PORT_ALLOCATION_INVENTORY'));
  for (const value of [null, { ports: [], ephemeral: null }, { ports: [NaN], ephemeral: [32768, 60999] }, { ports: [], ephemeral: [60999, 32768] }]) await assert.rejects(allocator({ readInventory: async () => value })({ kind: 'python' }), rejected('PORT_ALLOCATION_INVENTORY'));
  await assert.rejects(allocator()({ servers: [{ kind: 'unknown' }] }), rejected('PORT_ALLOCATION_INVENTORY'));
});
test('declared host reserved ports outside the ephemeral range are excluded and malformed sysctl reservations fail closed', async () => {
  const result = await readHostPortInventory({ platform: 'linux', readFile: procReader({ '/proc/sys/net/ipv4/ip_local_reserved_ports': '20000,20002-20005,25000\n' }) });
  assert.deepEqual(result.reserved, [20000, 20002, 20003, 20004, 20005, 25000]);
  const selected = await allocator({ readInventory: async () => result })({ kind: 'nodejs' }); assert.equal(selected.port, 20001);
  for (const value of ['20000,,20001', '20000-', '25000-24000', '65536', '0', '20000, hello', '1-65536']) await assert.rejects(readHostPortInventory({ platform: 'linux', readFile: procReader({ '/proc/sys/net/ipv4/ip_local_reserved_ports': value }) }), rejected('PORT_ALLOCATION_INVENTORY'));
});
test('unsupported mixed-version node capability cannot advertise automatic allocation', () => {
  assert.equal(supportsAutomaticPorts(PORT_ALLOCATION_POLICY), true);
  for (const value of [null, {}, { ...PORT_ALLOCATION_POLICY, schemaVersion: 2 }, { ...PORT_ALLOCATION_POLICY, supported: false }, { ...PORT_ALLOCATION_POLICY, authority: 'browser' }]) assert.equal(supportsAutomaticPorts(value), false);
});

async function fixture(t, { native = false, allocate = allocator(), workspaceGate } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-autoports-')), store = createStore(dataDir);
  const version = '1.20.0.01'; store.data.versions.push({ version, channel: 'stable', transport: 'raknet', cached: true });
  const caps = { supported: true, fixedSupported: true, pidsSupported: true };
  const applicationController = { ...fixtureManagedRuntime(() => ({ supported: true, runtimes: { nodejs: { available: true, version: 'fixture-node' }, python: { available: true, version: 'fixture-python' } } })), capabilities: () => ({ supported: true, runtimes: { nodejs: { available: true, version: 'fixture-node' }, python: { available: true, version: 'fixture-python' } } }), async prepareWorkspace() { await workspaceGate; }, installDependencies: async () => ({ installed: false }), close: async () => {} };
  const manager = await createManager({ store, dataDir, demo: !native, portAllocator: allocate, hostReader: directoryFixtureHost, storageController: createDirectoryStorageFixture(dataDir), resourceController: { capabilities: () => caps, close: async () => {} }, applicationController });
  t.after(async () => { await manager.close(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('vortex-autoports-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const input = (changes = {}) => ({ name: 'Automatic test world', version, eula: true, ...changes });
  return { manager, store, input };
}
async function finish(manager, id) { for (let n = 0; n < 200; n++) { const job = manager.jobs().find(item => item.id === id); if (['completed', 'failed'].includes(job.status)) { assert.equal(job.status, 'completed'); return; } await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('Job did not finish'); }

test('concurrent automatic creates and a later clone receive distinct persisted allocations while an explicit existing server stays unchanged', async t => {
  const f = await fixture(t); const existing = await f.manager.createServer(f.input({ port: 20000, portV6: 20001 })); await finish(f.manager, existing.job.id);
  const before = { port: existing.server.port, portV6: existing.server.portV6 };
  const created = await Promise.all(Array.from({ length: 3 }, () => f.manager.createServer(f.input({ portAllocation: 'auto' }))));
  for (const item of created) await finish(f.manager, item.job.id);
  const clone = await f.manager.cloneServer(existing.server.id, { name: 'Automatic clone', eula: true }); await finish(f.manager, clone.job.id);
  const ports = [existing, ...created, clone].flatMap(item => [item.server.port, item.server.portV6]);
  assert.equal(new Set(ports).size, ports.length); assert.deepEqual({ port: f.manager.getServer(existing.server.id).port, portV6: f.manager.getServer(existing.server.id).portV6 }, before);
});
test('failed durable registration releases its automatic reservation; an accepted failed install keeps its ports reserved', async t => {
  const f = await fixture(t), save = f.store.save; f.store.save = () => { throw Error('registration fixture full'); };
  await assert.rejects(f.manager.createServer(f.input()), /registration fixture full/); assert.equal(f.store.data.servers.length, 0); assert.equal(f.store.data.jobs.length, 0);
  f.store.save = save; const created = await f.manager.createServer(f.input()); assert.equal(created.server.port, 20000); await finish(f.manager, created.job.id);
  f.store.data.servers[0].status = 'error';
  const next = await f.manager.createServer(f.input()); assert.equal(next.server.port, 20002); await finish(f.manager, next.job.id);
});
test('unknown inventory fails before accepted jobs or volume creation and invalid auto/manual hybrids do not allocate', async t => {
  const f = await fixture(t, { allocate: allocator({ readInventory: async () => { throw Error('private fixture failure'); } }) });
  await assert.rejects(f.manager.createServer(f.input()), rejected('PORT_ALLOCATION_INVENTORY'));
  await assert.rejects(f.manager.createServer(f.input({ portAllocation: 'auto', port: 20000 })), rejected('PORT_ALLOCATION_INPUT'));
  assert.equal(f.store.data.servers.length, 0); assert.equal(f.store.data.jobs.length, 0);
});
test('Node.js and Python native-manager creation allocate one distinct TCP port while provisioning is unfinished', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, { native: true, workspaceGate: wait });
  const created = await Promise.all(['nodejs', 'python'].map(kind => f.manager.createServer({ kind, name: 'Automatic test app', portAllocation: 'auto', application: { dependencies: 'none', readiness: 'process' } })));
  assert.notEqual(created[0].server.port, created[1].server.port);
  for (const item of created) { assert.equal(item.server.portV6, null); assert.equal(item.server.transport, 'tcp'); assert.equal(item.server.status, 'installing'); }
  release(); for (const item of created) await finish(f.manager, item.job.id);
});
test('a real occupied TCP socket racing the inventory is retried once without creating a failed server or job', async t => {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => listener.close(resolve)));
  const occupied = listener.address().port, calls = [];
  const choose = async request => { calls.push(request.excludedPorts.slice()); return { port: calls.length === 1 ? occupied : 26001, portV6: null, transport: 'tcp', udpPorts: null, debugPort: null }; };
  const f = await fixture(t, { native: true, allocate: choose });
  const created = await f.manager.createServer({ kind: 'nodejs', name: 'Address race fixture', application: { dependencies: 'none' } }); await finish(f.manager, created.job.id);
  assert.equal(created.server.port, 26001); assert.deepEqual(calls, [[], [occupied]]); assert.equal(f.store.data.servers.length, 1); assert.equal(f.store.data.jobs.length, 1);
});
test('a non-address-in-use probe failure is never retried or accepted', async t => {
  let calls = 0;
  const f = await fixture(t, { native: true, allocate: async () => { calls++; return { port: 26002, portV6: null, transport: 'tcp', udpPorts: null, debugPort: null }; } });
  t.mock.method(net, 'createServer', () => { const socket = new EventEmitter(); socket.listen = () => queueMicrotask(() => socket.emit('error', Object.assign(Error('fixture denied'), { code: 'EACCES' }))); return socket; });
  await assert.rejects(f.manager.createServer({ kind: 'python', name: 'Unknown probe fixture', application: { dependencies: 'none' } }), rejected('EACCES'));
  assert.equal(calls, 1); assert.equal(f.store.data.servers.length, 0); assert.equal(f.store.data.jobs.length, 0);
});
