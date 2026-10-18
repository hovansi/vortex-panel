import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import archiver from 'archiver';
import { createPrivateKey } from 'node:crypto';
import { createManager, ensureServerIdentity } from '../server/manager.js';
import { createVersionService, validateDownloadUrl } from '../server/versions.js';
import { safePath, parseProperties, serializeProperties, validatePorts, validateNetwork, parseUdpPorts } from '../server/safety.js';
import { extractZip, zipDirectory } from '../server/archives.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';

function memoryStore() {
  const store = { data: { servers: [], versions: [], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit(action, detail) { this.data.activity.unshift({ action, detail }); } };
  return store;
}
async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bedrock-core-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function archive(entries, destination) {
  const output = createWriteStream(destination);
  const zip = archiver('zip');
  const completion = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); zip.on('error', reject); });
  zip.pipe(output);
  for (const [name, content] of Object.entries(entries)) zip.append(content, { name });
  await zip.finalize(); await completion;
}
function elf() {
  const bytes = Buffer.alloc(4096);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(62, 18);
  return bytes;
}
async function waitJob(manager, id, expected = 'completed') {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = manager.jobs().find(item => item.id === id);
    if (['completed', 'failed'].includes(job.status)) { assert.equal(job.status, expected, job.message); return job; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Backend job did not finish');
}

test('property roundtrip preserves repeated official UDP mappings and cross-family port conflicts', () => {
  const parsed = parseProperties('server-udp-ports=19132\nserver-udp-ports=22001\nlevel-name=My world\n');
  assert.equal(parsed['server-udp-ports'], '19132,22001');
  assert.deepEqual(parseProperties(serializeProperties(parsed)), parsed);
  assert.throws(() => validatePorts([{ id: 'one', name: 'One', port: 19132, portV6: 19133 }], 'two', 19133, 19144), /sử dụng/);
  assert.throws(() => validatePorts([], null, 19132, 19132), /khác/);
  assert.throws(() => validatePorts([], null, 22, 19133), /1024/);
  assert.deepEqual(parseUdpPorts('19200-19202,203.0.113.10:20000-20001:19203-19204,[::1]:20002:19205'), [19200, 19201, 19202, 19203, 19204, 19205]);
  assert.throws(() => parseUdpPorts('19200-19202,19202'), /trùng/);
  assert.throws(() => parseUdpPorts('20000-20001:19200-19202'), /cùng độ dài/);
  assert.throws(() => validateNetwork([{ id: 'one', name: 'One', port: 19132, portV6: 19133, transport: 'nethernet', udpPorts: '19134-19165' }], 'two', { port: 19232, portV6: 19233, transport: 'nethernet', udpPorts: '19160-19191' }), /Dải cổng trùng/);
});

test('scoped file paths reject traversal, absolute names and ancestor symlinks', async t => {
  const directory = await workspace(t);
  const root = path.join(directory, 'root'); const outside = path.join(directory, 'outside');
  await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
  for (const value of ['../outside/secret.txt', '/etc/passwd', 'C:/private', 'folder\\escape', 'a/../b', 'a\0b']) await assert.rejects(safePath(root, value), /hợp lệ/);
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safePath(root, 'escape/secret.txt'), /liên kết/);
  assert.equal(await safePath(root, 'new/file.txt', { allowMissing: true }), path.join(root, 'new', 'file.txt'));
});

test('version discovery uses typed Mojang API links and never invents historical latest', async t => {
  const directory = await workspace(t); const store = memoryStore();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const current = 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.52.3.zip';
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: current }, { downloadType: 'serverBedrockWindows', downloadUrl: 'https://evil.test/fake.zip' }] } }), { status: 200 });
  const service = createVersionService({ store, dataDir: directory, demo: false, emit() {} });
  const result = await service.refresh();
  assert.equal(result.latest, '1.26.52.3'); assert.equal(result.preview, null); assert.equal(result.versions.length, 1);
  globalThis.fetch = async () => { throw new Error('offline'); };
  const offline = await service.refresh();
  assert.equal(offline.latest, '1.26.52.3'); assert.match(offline.error, /offline/);
  assert.throws(() => validateDownloadUrl('http://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.2.3.4.zip'));
  assert.throws(() => validateDownloadUrl('https://www.minecraft.net.evil.test/bedrockdedicatedserver/bin-linux/bedrock-server-1.2.3.4.zip'));
  assert.throws(() => validateDownloadUrl(current + '?redirect=evil'));
  service.close();
});

test('real offline imported packages install, update and restore with world/config/identity intact', async t => {
  const directory = await workspace(t); const store = memoryStore();
  const manager = await createManager({ store, dataDir: directory, demo: false, storageController: createDirectoryStorageFixture(directory), hostReader: directoryFixtureHost });
  t.after(() => manager.close());
  for (const [version, runtime] of [['1.21.100.6', 'old runtime'], ['1.21.130.3', 'new runtime']]) {
    const zip = path.join(directory, `${version}.zip`);
    await archive({ bedrock_server: elf(), 'server.properties': 'server-name=Official\nserver-port=19132\nserver-portv6=19133\nmax-players=10\ntransport=nethernet\nnew-mojang-setting=preserved\n', 'resource_packs/vanilla/runtime.json': runtime, 'keys/server_identity_key.pem': `initial-${version}` }, zip);
    await manager.importVersion(zip, version, 'stable');
  }
  const created = await manager.createServer({ name: 'Core world', version: '1.21.100.6', port: 19200, portV6: 19201, maxPlayers: 12, eula: true });
  await waitJob(manager, created.job.id);
  const id = created.server.id;
  const run = path.join(directory, 'servers', id, 'run');
  const config = await manager.properties(id);
  assert.equal(config['new-mojang-setting'], 'preserved'); assert.equal(config.transport, 'nethernet'); assert.equal(config['server-udp-ports'], '19202-19233'); assert.equal(config['enable-lan-visibility'], 'false');
  await manager.mkdir(id, 'worlds/Core');
  await manager.writeFile(id, 'worlds/Core/world.txt', 'original world');
  await fs.writeFile(path.join(run, 'keys/server_identity_key.pem'), 'saved identity');
  await manager.saveProperties(id, { ...config, difficulty: 'hard', 'max-players': '17' });
  await assert.rejects(manager.writeFile(id, 'bedrock_server', 'replacement'), /bảo vệ/);
  await assert.rejects(manager.deleteFile(id, 'resource_packs'), /bảo vệ/);
  await assert.rejects(manager.writeFile(id, '../outside.txt', 'escape'), /hợp lệ/);
  const beforePropertyText = await fs.readFile(path.join(run, 'server.properties'), 'utf8'); const beforePropertyServer = manager.getServer(id);
  store.save = () => { throw new Error('Injected properties persistence failure'); };
  await assert.rejects(manager.saveProperties(id, { 'server-port': '19250', 'server-portv6': '19251', 'server-udp-ports': '19252-19283', 'max-players': '30' }), /properties persistence failure/);
  assert.equal(await fs.readFile(path.join(run, 'server.properties'), 'utf8'), beforePropertyText); assert.equal(manager.getServer(id).port, beforePropertyServer.port); assert.equal(manager.getServer(id).maxPlayers, beforePropertyServer.maxPlayers);
  store.save = () => {};
  let rejectActivation = true;
  const originalSave = store.save;
  store.save = function () {
    if (rejectActivation && this.data.servers.some(value => value.version === '1.21.130.3')) { rejectActivation = false; throw new Error('Simulated metadata commit failure'); }
    return originalSave.call(this);
  };
  const failedUpgrade = await manager.upgrade(id, { version: '1.21.130.3' });
  await waitJob(manager, failedUpgrade.id, 'failed');
  assert.equal(manager.getServer(id).version, '1.21.100.6');
  assert.equal(await fs.readFile(path.join(run, 'resource_packs/vanilla/runtime.json'), 'utf8'), 'old runtime');
  assert.equal((await manager.readFile(id, 'worlds/Core/world.txt')).content, 'original world');
  const upgrade = await manager.upgrade(id, { version: '1.21.130.3' });
  await waitJob(manager, upgrade.id);
  assert.equal(manager.backups(id)[0].reason, 'pre-update');
  assert.equal(manager.backups(id)[0].version, '1.21.100.6');
  assert.equal((await manager.readFile(id, 'worlds/Core/world.txt')).content, 'original world');
  assert.equal((await manager.readFile(id, 'keys/server_identity_key.pem')).content, 'saved identity');
  assert.equal((await manager.properties(id)).difficulty, 'hard');
  assert.equal(await fs.readFile(path.join(run, 'resource_packs/vanilla/runtime.json'), 'utf8'), 'new runtime');
  const backup = await manager.backup(id); await waitJob(manager, backup.id);
  const saved = manager.backups(id)[0]; assert.ok(saved.size > 0);
  await manager.writeFile(id, 'worlds/Core/world.txt', 'changed world');
  await manager.writeFile(id, 'worlds/extra.txt', 'new data');
  await manager.saveProperties(id, { 'max-players': '23' });
  let rejectRestore = true;
  store.save = function () {
    if (rejectRestore && this.data.servers.some(value => value.maxPlayers === 17)) { rejectRestore = false; throw new Error('Simulated restore metadata failure'); }
    return originalSave.call(this);
  };
  const failedRestore = await manager.restore(id, saved.id); await waitJob(manager, failedRestore.id, 'failed');
  assert.equal(manager.getServer(id).maxPlayers, 23);
  assert.equal((await manager.readFile(id, 'worlds/Core/world.txt')).content, 'changed world');
  const restore = await manager.restore(id, saved.id); await waitJob(manager, restore.id);
  assert.equal((await manager.readFile(id, 'worlds/Core/world.txt')).content, 'original world');
  await assert.rejects(manager.readFile(id, 'worlds/extra.txt'), /Không tìm thấy/);
  assert.equal(await fs.readFile(path.join(run, 'resource_packs/vanilla/runtime.json'), 'utf8'), 'new runtime');
  assert.equal(manager.getServer(id).maxPlayers, 17);
  const update = await manager.upgrade(id, { version: '1.21.100.6' });
  await assert.rejects(manager.writeFile(id, 'worlds/Core/world.txt', 'race'), /tác vụ/);
  await waitJob(manager, update.id);
  await assert.rejects(manager.restore(id, saved.id), /phiên bản khác/);
  await assert.rejects(manager.cloneServer(id, { name: 'Conflict', port: 19200, portV6: 19201, eula: true }), /sử dụng/);
  const clone = await manager.cloneServer(id, { name: 'Independent copy', port: 19300, portV6: 19301, eula: true });
  await assert.rejects(manager.action(id, 'start'), /tác vụ/);
  await waitJob(manager, clone.job.id);
  const cloneId = clone.server.id;
  assert.equal(manager.getServer(cloneId).status, 'stopped');
  assert.equal((await manager.readFile(cloneId, 'worlds/Core/world.txt')).content, 'original world');
  assert.equal((await manager.properties(cloneId))['server-port'], '19300');
  assert.equal((await manager.properties(cloneId))['server-udp-ports'], '19302-19333');
  const cloneIdentity = (await manager.readFile(cloneId, 'keys/server_identity_key.pem')).content;
  assert.notEqual(cloneIdentity, 'saved identity'); assert.equal(createPrivateKey(cloneIdentity).asymmetricKeyDetails.namedCurve, 'secp384r1');
  await ensureServerIdentity(path.join(directory, 'servers', cloneId, 'run'));
  assert.equal((await manager.readFile(cloneId, 'keys/server_identity_key.pem')).content, cloneIdentity);
  await manager.writeFile(cloneId, 'worlds/Core/world.txt', 'independent world');
  assert.equal((await manager.readFile(id, 'worlds/Core/world.txt')).content, 'original world');
  manager.updateServer(cloneId, { backupRetention: 2 });
  const firstBackup = await manager.backup(cloneId); await waitJob(manager, firstBackup.id);
  const prunedBackup = manager.backups(cloneId)[0];
  for (let count = 0; count < 2; count++) { const record = await manager.backup(cloneId); await waitJob(manager, record.id); }
  assert.equal(manager.backups(cloneId).length, 2);
  assert.equal(await fs.stat(path.join(directory, 'servers', cloneId, 'backups', `${prunedBackup.id}.zip`)).catch(() => null), null);
});

test('package activation rolls back disk and catalog after a failed durable commit', async t => {
  const directory = await workspace(t); const store = memoryStore();
  const zip = path.join(directory, 'fixture.zip');
  await archive({ bedrock_server: elf(), 'server.properties': 'transport=nethernet\n' }, zip);
  const service = createVersionService({ store, dataDir: directory, demo: false, emit() {} }); t.after(() => service.close());
  let rejectCommit = true;
  store.save = () => { if (rejectCommit) { rejectCommit = false; throw new Error('Injected package persistence failure'); } };
  await assert.rejects(service.importPackage(zip, '1.26.52.3'), /persistence failure/);
  assert.equal(store.data.versions.length, 0);
  assert.equal(await fs.stat(service.directory('1.26.52.3', 'stable')).catch(() => null), null);
  const imported = await service.importPackage(zip, '1.26.52.3'); assert.equal(imported.cached, true);
  const version = { version: '1.26.60.30', channel: 'preview', cached: false, available: true, url: 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux-preview/bedrock-server-1.26.60.30.zip', discoveredAt: 'before' };
  store.data.versions.push(version); const before = structuredClone(version);
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(await fs.readFile(zip), { status: 200 });
  rejectCommit = true;
  await assert.rejects(service.ensure(version.version, version.channel), /persistence failure/);
  assert.equal(store.data.versions.find(item => item === version), version); assert.deepEqual(version, before);
  assert.equal(await fs.stat(service.directory(version.version, version.channel)).catch(() => null), null);
  const downloaded = await service.ensure(version.version, version.channel);
  assert.equal(version.cached, true); assert.ok(downloaded.manifest.includes('bedrock_server'));
  assert.ok(await fs.stat(service.directory(imported.version, imported.channel)));
});

test('backup data cap is enforced before success and ZIP extraction rejects oversized data', async t => {
  const directory = await workspace(t); const root = path.join(directory, 'source'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.txt'), 'a'.repeat(300));
  await assert.rejects(zipDirectory(root, path.join(directory, 'too-large.zip'), { maxBytes: 100 }), /vượt giới hạn/);
  assert.equal(await fs.stat(path.join(directory, 'too-large.zip')).catch(() => null), null);
  await assert.rejects(zipDirectory(root, path.join(directory, 'too-many.zip'), { maxEntries: 0 }), /50.000/);
  const zip = path.join(directory, 'ordinary.zip'); await archive({ 'a.txt': 'a'.repeat(300) }, zip);
  await assert.rejects(extractZip(zip, path.join(directory, 'extracted'), { maxBytes: 100 }), /vượt quá/);
});

test('ZIP validation blocks traversal, symbolic links and duplicate destination entries', async t => {
  const directory = await workspace(t);
  const zip = path.join(directory, 'traversal.zip'); await archive({ 'safe.txt': 'content' }, zip);
  const original = await fs.readFile(zip);
  // ZIP file names are present in local and central records; CRC covers content.
  for (let index = original.indexOf('safe.txt'); index >= 0; index = original.indexOf('safe.txt', index + 8)) original.write('../x.txt', index);
  await fs.writeFile(zip, original);
  await assert.rejects(extractZip(zip, path.join(directory, 'unsafe')));
  assert.equal(await fs.stat(path.join(directory, 'x.txt')).catch(() => null), null);
  for (const kind of ['symlink', 'duplicate']) {
    const destination = path.join(directory, `${kind}.zip`);
    const output = createWriteStream(destination); const malicious = archiver('zip');
    const completion = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); malicious.on('error', reject); });
    malicious.pipe(output);
    if (kind === 'symlink') malicious.symlink('worlds/escape', '../../outside');
    else { malicious.append('first', { name: 'same.txt' }); malicious.append('second', { name: 'same.txt' }); }
    await malicious.finalize(); await completion;
    await assert.rejects(extractZip(destination, path.join(directory, `reject-${kind}`)), kind === 'symlink' ? /liên kết/ : /trùng/);
  }
});

test('invalid ZIP input returns a clear client error without masking filesystem failures', async t => {
  const directory = await workspace(t); const malformed = path.join(directory, 'not-a-zip.mcpack');
  await fs.writeFile(malformed, 'This is not a ZIP archive.');
  await assert.rejects(extractZip(malformed, path.join(directory, 'invalid')), error => error.status === 400 && /ZIP không hợp lệ/.test(error.message));
  await assert.rejects(extractZip(path.join(directory, 'missing.zip'), path.join(directory, 'missing')), error => error.code === 'ENOENT' && error.status === undefined);
});

test('demo lifecycle excludes overlapping starts and online backups preserve running state while locking conflicting actions', async t => {
  const directory = await workspace(t); const manager = await createManager({ store: memoryStore(), dataDir: directory, demo: true });
  t.after(() => manager.close()); await manager.initialize();
  const metrics = manager.serverHistory(manager.listServers()[0].id);
  assert.equal(metrics.demo, true); assert.equal(metrics.retentionSeconds, 600); assert.ok(metrics.history.length);
  const server = manager.listServers()[1];
  const start = manager.action(server.id, 'start');
  await assert.rejects(manager.action(server.id, 'start'), /chuyển trạng thái/);
  await start;
  const online = await manager.backup(server.id);
  await assert.rejects(manager.backup(server.id), /tác vụ/);
  await assert.rejects(manager.action(server.id, 'stop'), /tác vụ/);
  await waitJob(manager, online.id);
  assert.equal(manager.getServer(server.id).status, 'running');
  await manager.action(server.id, 'stop');
  const backup = await manager.backup(server.id); await waitJob(manager, backup.id);
  assert.equal(manager.getServer(server.id).status, 'stopped');
  assert.deepEqual(await fs.readdir(directory), []);
});

test('clean panel restart resumes prior running servers and preserves intentionally stopped instances', async t => {
  const directory = await workspace(t); const store = memoryStore();
  const first = await createManager({ store, dataDir: directory, demo: true }); await first.initialize();
  const [running, stopped] = first.listServers();
  await first.close();
  assert.equal(store.data.servers.find(server => server.id === running.id).resumeOnPanelStart, true);
  assert.equal(store.data.servers.find(server => server.id === running.id).status, 'stopped');
  assert.equal(Boolean(store.data.servers.find(server => server.id === stopped.id).resumeOnPanelStart), false);
  const second = await createManager({ store, dataDir: directory, demo: true }); await second.initialize();
  assert.equal(second.getServer(running.id).status, 'running'); assert.equal(second.getServer(stopped.id).status, 'stopped');
  assert.equal(Boolean(store.data.servers.find(server => server.id === running.id).resumeOnPanelStart), false);
  const stopping = second.action(running.id, 'stop'); const closing = second.close(); await stopping; await closing;
  assert.equal(Boolean(store.data.servers.find(server => server.id === running.id).resumeOnPanelStart), false);
  const third = await createManager({ store, dataDir: directory, demo: true }); t.after(() => third.close()); await third.initialize();
  assert.equal(third.getServer(running.id).status, 'stopped'); assert.equal(third.getServer(stopped.id).status, 'stopped');
});

test('schedule edits and manual runs share exclusive execution and record outcomes', async t => {
  const directory = await workspace(t); const store = memoryStore();
  const manager = await createManager({ store, dataDir: directory, demo: true }); await manager.initialize();
  t.after(() => manager.close()); const [running] = manager.listServers();
  const schedule = manager.createSchedule({ serverId: running.id, action: 'backup', intervalMinutes: 60, enabled: false });
  const before = structuredClone(schedule);
  assert.throws(() => manager.updateSchedule(schedule.id, { intervalMinutes: 0, enabled: true }), /Chu kỳ/);
  assert.deepEqual(store.data.schedules[0], before);
  const enabled = manager.updateSchedule(schedule.id, { enabled: true, intervalMinutes: 5 });
  assert.equal(enabled.intervalMinutes, 5); assert.equal(enabled.enabled, true); assert.ok(Date.parse(enabled.nextRun) > Date.now());
  manager.updateSchedule(schedule.id, { enabled: false });
  const alternate = manager.createSchedule({ serverId: running.id, action: 'command', command: 'list', intervalMinutes: 60 });
  const accepted = manager.runSchedule(schedule.id);
  assert.equal(accepted.schedule.status, 'running'); assert.equal(accepted.job.type, 'schedule');
  assert.throws(() => manager.runSchedule(schedule.id), /đang chạy/);
  assert.throws(() => manager.runSchedule(alternate.id), /đang chạy/);
  assert.throws(() => manager.updateSchedule(schedule.id, { enabled: true }), /đang chạy/);
  assert.throws(() => manager.deleteSchedule(schedule.id), /đang chạy/);
  await assert.rejects(manager.action(running.id, 'stop'), /tác vụ/);
  const finished = await waitJob(manager, accepted.job.id);
  assert.equal(manager.getServer(running.id).status, 'running'); assert.equal(manager.backups(running.id).length, 1);
  assert.ok(finished.backupJobId); assert.equal(manager.schedules().find(item => item.id === schedule.id).status, 'completed');
  assert.equal(manager.schedules().find(item => item.id === schedule.id).enabled, false);
  await manager.action(running.id, 'stop');
  const failed = manager.runSchedule(alternate.id); await waitJob(manager, failed.job.id, 'failed');
  assert.match(manager.schedules().find(item => item.id === alternate.id).error, /đang chạy/);
  assert.ok(manager.schedules().find(item => item.id === alternate.id).lastFinishedAt);
  manager.deleteSchedule(schedule.id); manager.deleteSchedule(alternate.id);
  await manager.close();
  assert.throws(() => manager.updateServer(running.id, { name: 'Late mutation' }), /đang tắt/);
  assert.throws(() => manager.createSchedule({ serverId: running.id, action: 'backup', intervalMinutes: 1 }), /đang tắt/);
  await assert.rejects(manager.writeFile(running.id, 'late.txt', 'late mutation'), /đang tắt/);
  await assert.rejects(manager.createServer({ name: 'Late provision', version: 'latest', eula: true }), /đang tắt/);
});

test('failed scheduled online backup does not stop or restart the server and explicit stop clears restart intent', async t => {
  const directory = await workspace(t); const store = memoryStore();
  const manager = await createManager({ store, dataDir: directory, demo: true }); await manager.initialize();
  t.after(() => manager.close()); const server = manager.listServers()[0];
  const schedule = manager.createSchedule({ serverId: server.id, action: 'backup', intervalMinutes: 1 });
  const action = manager.action, actions = [], save = store.save;
  manager.action = async (id, value, ...args) => {
    actions.push(value);
    return action(id, value, ...args);
  };
  store.save = () => {
    if (store.data.activity[0]?.action === 'backup.create') throw new Error('Injected scheduled backup catalog failure');
    return save();
  };
  const accepted = manager.runSchedule(schedule.id); await waitJob(manager, accepted.job.id, 'failed');
  store.save = save;
  assert.equal(manager.getServer(server.id).status, 'running'); assert.deepEqual(actions, []);
  assert.equal(manager.backups(server.id).length, 0);
  assert.match(manager.schedules().find(item => item.id === schedule.id).error, /catalog failure/);
  await manager.action(server.id, 'stop');
  await manager.close(); assert.equal(Boolean(store.data.servers.find(item => item.id === server.id).resumeOnPanelStart), false);
});
