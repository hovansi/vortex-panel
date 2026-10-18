import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';
import { serializeProperties } from '../server/safety.js';
import { extractZip, verifyZip } from '../server/archives.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';
import { writeWorld, waitJob } from './worlds-fixture.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function freePort(type, address) {
  const socket = dgram.createSocket(type); await new Promise(resolve => socket.bind(0, address, resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function fixture(t, { onQuery = async () => {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-online-manager-'));
  const store = createStore(dataDir), commands = [], children = [];
  const server = { id: randomUUID(), name: 'Online backup fixture', version: '1.26.52.3', channel: 'stable', status: 'stopped', port: await freePort('udp4', '127.0.0.1'), portV6: await freePort('udp6', '::1'), transport: 'raknet', maxPlayers: 8, autoStart: false, autoRestart: false, worldVoiceEnabled: false, runtimeFiles: ['bedrock_server'], backups: [], backupRetention: 5 };
  const run = path.join(dataDir, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, 'bedrock_server'), 'INERT fixture; injected launcher never executes this file.');
  await fs.writeFile(path.join(run, 'server.properties'), serializeProperties({ 'server-name': server.name, transport: 'raknet', 'server-port': server.port, 'server-portv6': server.portV6, 'max-players': 8, 'enable-lan-visibility': false, 'level-name': 'Main', 'online-mode': true, 'allow-list': false, 'allow-cheats': false, gamemode: 'survival', difficulty: 'normal', 'view-distance': 16, 'tick-distance': 4, 'max-threads': 0 }));
  await writeWorld(path.join(run, 'worlds', 'Main'));
  const nativeFiles = ['level.dat', 'db/CURRENT', 'db/MANIFEST-000001', 'db/000002.ldb'];
  const fileList = [];
  for (const name of nativeFiles) fileList.push(`Main/${name}:${(await fs.stat(path.join(run, 'worlds', 'Main', name))).size}`);
  store.data.servers.push(server); store.save();
  const caps = { fixedSupported: false, sharedSupported: true };
  const resources = { capabilities: async () => caps, initialize: async () => caps, async prepare(_id, policy) {
    return { policy, effective: { cgroupPath: null }, cleanup: async () => ({ stats: null }), spawn() {
      const child = Object.assign(new EventEmitter(), { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
      children.push(child); let ended = false, queue = Promise.resolve();
      const output = body => { if (!ended) child.stdout.write(`[2026-10-16 09:00:00:001 INFO] ${body}\n`); };
      const finish = () => { if (!ended) { ended = true; child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); } };
      child.kill = () => { child.killed = true; setImmediate(finish); return true; };
      child.stdin.on('data', input => {
        for (const command of input.toString().trim().split('\n')) {
          commands.push(command);
          queue = queue.then(async () => {
            if (command === 'stop') { setImmediate(finish); return; }
            if (command.startsWith('vortex_')) output(`Unknown command: ${command}. Please check that the command exists and that you have permission to use it.`);
            else if (command === 'save hold') output('Saving...');
            else if (command === 'save query') { await onQuery({ run }); output('Data saved. Files are now ready to be copied.'); output(fileList.join(', ')); }
            else if (command === 'save resume') output('Changes to the world are resumed.');
            else if (command === 'list') output('There are 0/8 players online:');
          });
          queue.catch(error => child.emit('error', error));
        }
      });
      setImmediate(() => output('Server started.'));
      return { child, ready: Promise.resolve({ kernelEnforced: false, testFixture: true }) };
    } };
  } };
  const network = { initialize: async () => ({ supported: false }), capabilities: () => ({ supported: false }), syncServers: async () => {}, sample: async () => ({}), peek: () => null, close: async () => {} };
  const manager = await createManager({ store, dataDir, hostReader: directoryFixtureHost, storageController: createDirectoryStorageFixture(dataDir), resourceController: resources, networkMetrics: network });
  t.after(async () => { await manager.close(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); await fs.rm(dataDir, { recursive: true, force: true }); });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try { await manager.action(server.id, 'start'); await new Promise(resolve => setImmediate(resolve)); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
  assert.equal(manager.getServer(server.id).status, 'running');
  return { store, server, dataDir, run, manager, commands, children };
}

test('manual and scheduled online backups preserve the running process and native byte boundary without stop/start', async t => {
  const x = await fixture(t), expected = await fs.readFile(path.join(x.run, 'worlds', 'Main', 'db', '000002.ldb'));
  await fs.appendFile(path.join(x.run, 'worlds', 'Main', 'db', '000002.ldb'), 'Beyond snapshot boundary.');
  const pid = x.manager.getServer(x.server.id).pid;
  const accepted = await x.manager.backup(x.server.id);
  assert.throws(() => x.manager.command(x.server.id, 'save resume'), error => error.status === 409);
  await assert.rejects(x.manager.action(x.server.id, 'stop'), error => error.status === 409);
  await waitJob(x.manager, accepted.id);
  const first = x.manager.backups(x.server.id)[0]; assert.equal(first.consistency, 'native-online'); assert.equal(first.integrity.status, 'verified');
  const archive = path.join(x.dataDir, 'servers', x.server.id, 'backups', first.id + '.zip');
  const checked = await verifyZip(archive); assert.ok(checked.entries > 3);
  const unpacked = path.join(x.dataDir, 'read-back'); await extractZip(archive, unpacked);
  assert.deepEqual(await fs.readFile(path.join(unpacked, 'worlds', 'Main', 'db', '000002.ldb')), expected);
  const schedule = x.manager.createSchedule({ serverId: x.server.id, action: 'backup', intervalMinutes: 60, enabled: false });
  const scheduled = x.manager.runSchedule(schedule.id); await waitJob(x.manager, scheduled.job.id);
  assert.equal(x.manager.backups(x.server.id).length, 2);
  assert.equal(x.manager.getServer(x.server.id).pid, pid); assert.equal(x.server.status, 'running'); assert.equal(x.children.length, 1);
  assert.equal(x.commands.includes('stop'), false); assert.equal(x.commands.filter(command => command === 'save resume').length, 2);
  assert.equal(x.manager.logs(x.server.id).some(row => /Unknown command: vortex_backup_/.test(row.message)), false);
  assert.equal((await fs.readdir(path.dirname(archive))).some(name => name.includes('.snapshot') || name.endsWith('.tmp')), false);
  t.diagnostic('Actual disk ZIP/read-back and manager lifecycle; native stdin/stdout, PID and resource spawn are injected, not a native BDS gameplay test.');
});

test('failed online copying releases save hold, retains the live process and never commits an archive', async t => {
  const x = await fixture(t, { onQuery: async ({ run }) => fs.truncate(path.join(run, 'worlds', 'Main', 'db', '000002.ldb'), 1) });
  const pid = x.manager.getServer(x.server.id).pid;
  const result = await waitJob(x.manager, (await x.manager.backup(x.server.id)).id, 'failed');
  assert.match(result.message, /ngắn hơn/); assert.equal(x.commands.at(-2), 'save resume');
  assert.equal(x.manager.getServer(x.server.id).pid, pid); assert.equal(x.server.status, 'running'); assert.equal(x.commands.includes('stop'), false);
  assert.equal(x.manager.backups(x.server.id).length, 0);
  assert.deepEqual(await fs.readdir(path.join(x.dataDir, 'servers', x.server.id, 'backups')), []);
});

test('panel shutdown waits for an in-flight online snapshot to resume saving before stopping its process', async t => {
  const entered = deferred(), release = deferred();
  const x = await fixture(t, { onQuery: async () => { entered.resolve(); await release.promise; } });
  const accepted = await x.manager.backup(x.server.id); await entered.promise;
  const closing = x.manager.close(); release.resolve(); await closing;
  assert.equal(x.server.status, 'stopped'); assert.equal(x.manager.getServer(x.server.id).pid, null);
  assert.ok(x.commands.indexOf('save resume') >= 0); assert.ok(x.commands.indexOf('save resume') < x.commands.indexOf('stop'));
  assert.equal(x.manager.jobs().find(job => job.id === accepted.id).status, 'failed');
  assert.equal(x.manager.backups(x.server.id).length, 0);
});

test('snapshot cleanup failure preserves a verified backup and reports the retained temporary path', async t => {
  const x = await fixture(t), remove = fs.rm; let retained;
  fs.rm = async (target, options) => {
    if (String(target).endsWith('.snapshot')) { retained = target; throw Object.assign(Error('Snapshot cleanup fixture denied'), { code: 'EACCES' }); }
    return remove(target, options);
  };
  let result;
  try { result = await waitJob(x.manager, (await x.manager.backup(x.server.id)).id); }
  finally { fs.rm = remove; }
  assert.equal(result.operationCompleted, true); assert.ok(result.warnings.some(warning => warning.includes(path.basename(retained))));
  assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'verified'); assert.equal(x.server.status, 'running');
  assert.ok((await fs.stat(retained)).isDirectory());
  const recovery = x.store.data.jobs.find(row => row.id === result.id); assert.ok(recovery);
  x.store.clearHistory({ activity: true, finishedJobs: true, confirmed: true });
  assert.ok(x.store.data.jobs.includes(recovery), 'Explicit history clearing preserves the retained snapshot warning');
  recovery.finishedAt = '2025-01-01T00:00:00.000Z'; x.store.save();
  assert.ok(x.store.data.jobs.includes(recovery), 'Age retention preserves the snapshot recovery pointer');
  await fs.rm(retained, { recursive: true }); x.store.save();
  assert.equal(x.store.data.jobs.includes(recovery), false, 'The old job becomes prunable only after its snapshot is removed');
});

test('fixed server volumes use their own free space and resume when snapshot space is insufficient', async t => {
  const x = await fixture(t), statfs = fs.statfs; let checked = false;
  x.server.storagePolicy = { mode: 'fixed', diskGiB: 1 };
  fs.statfs = async target => { if (String(target).endsWith(path.sep + 'backups')) { checked = true; return { bavail: 0, bsize: 4096 }; } return statfs(target); };
  let result;
  try { result = await waitJob(x.manager, (await x.manager.backup(x.server.id)).id, 'failed'); }
  finally { fs.statfs = statfs; }
  assert.equal(checked, true); assert.match(result.message, /Không đủ dung lượng/);
  assert.ok(x.commands.includes('save resume')); assert.equal(x.server.status, 'running'); assert.equal(x.manager.backups(x.server.id).length, 0);
});
