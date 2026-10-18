import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { LOG_RETENTION_DEFAULTS, getLogRetentionPolicy, validateLogRetentionPolicy, retainStoreHistory, boundedUtf8Text, boundConsoleEntry, trimConsoleEntries, createBoundedConsoleRing, readConsoleTail, createBoundedConsoleWriter, createUtf8LineConsumer, nativeLogRetentionPolicy } from '../server/log-retention.js';

const today = '2026-10-14T12:00:00.000Z', nowMs = Date.parse(today), old = '2025-01-01T00:00:00.000Z';
const activity = (id, time = today, detail = 'record') => ({ id, time, action: 'server.command', detail });
const job = (id, status = 'completed', finishedAt = today, extra = {}) => ({ id, status, finishedAt, createdAt: old, ...extra });
const record = (message, time = new Date().toISOString()) => ({ time, level: 'info', source: 'native', message });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-log-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('history age/count/byte limits independently retain recent record objects and omit large legacy records', () => {
  const newest = activity('newest'), other = activity('other'), huge = activity('huge', today, '界'.repeat(1000)), expired = activity('expired', old);
  const data = { activity: [newest, expired, huge, other, activity('extra')], jobs: [job('a'), job('old', 'failed', old), job('b'), job('c')], servers: [], schedules: [] };
  const result = retainStoreHistory(data, { ...LOG_RETENTION_DEFAULTS, activityEntries: 2, activityBytes: 512, finishedJobEntries: 2, finishedJobBytes: 1024 }, { nowMs });
  assert.deepEqual(result.activity.map(row => row.id), ['newest', 'other']);
  assert.strictEqual(result.activity[0], newest);
  assert.deepEqual(result.jobs.map(row => row.id), ['a', 'b']);
  assert.equal(result.stats.activity.removed, 3);
  assert.ok(result.stats.activity.bytes <= 512);
});

test('active jobs and server/schedule/recovery anchors survive age and byte overflow without touching recovery payloads', () => {
  const payload = { original: 'servers/a/.rollback-owned', candidate: 'servers/a/run', primaryError: 'commit failed', rollbackError: 'EPERM', backupId: 'protected-backup', createdAt: old };
  const recoveryAudit = { ...activity('recovery-audit', old), action: 'restore.failed', serverId: 'a' };
  const active = Array.from({ length: 300 }, (_, i) => job(`active-${i}`, i % 2 ? 'running' : 'queued', old));
  const pinned = [job('server-job', 'failed', old), job('clone-job', 'completed', old), job('schedule-job', 'completed', old), job('restore-job', 'failed', old, { type: 'restore', serverId: 'a', message: 'original and candidate preserved' }), job('verify-job', 'failed', old, { type: 'backup-verify', serverId: 'a' }), job('unpersisted', 'completed', old, { operationCompleted: true, completionStatusPersisted: false }), job('quarantine', 'completed', old, { result: { cleanupPending: 'backups/.owned-quarantine' } })];
  const data = { activity: [activity('expired', old), recoveryAudit], jobs: [...active, ...pinned, job('expired', 'completed', old)], servers: [{ id: 'a', jobId: 'server-job', cloneJobId: 'clone-job', restoreRecoveryRequired: payload, backupVerificationFailure: { backupId: 'protected-backup' }, backups: [{ id: 'protected-backup', locked: true }] }], schedules: [{ lastJobId: 'schedule-job' }], users: [{ id: 'owner', mfa: 'opaque' }] };
  const before = structuredClone(data.servers), users = data.users;
  const result = retainStoreHistory(data, { ...LOG_RETENTION_DEFAULTS, activityBytes: 1, finishedJobBytes: 1, finishedJobEntries: 1 }, { nowMs });
  assert.equal(result.jobs.length, active.length + pinned.length);
  for (const row of [...active, ...pinned]) assert.ok(result.jobs.includes(row));
  assert.deepEqual(result.activity, [recoveryAudit]);
  assert.equal(result.stats.jobs.protectedOverBudget, true);
  assert.deepEqual(data.servers, before); assert.strictEqual(data.users, users); assert.strictEqual(data.servers[0].restoreRecoveryRequired, payload);
});

test('legacy store is pruned on load even without users, while large file loading fails before parsing and preserves bytes', t => {
  const root = fixture(t), filename = path.join(root, 'panel.json');
  const raw = { users: [], servers: [{ id: 'owned', restoreRecoveryRequired: { original: 'keep', candidate: 'also-keep' } }], jobs: [job('active', 'running', old), ...Array.from({ length: 250 }, (_, i) => job(`old-${i}`, 'completed', old))], activity: [activity('old', old), ...Array.from({ length: 1100 }, (_, i) => activity(String(i), new Date().toISOString()))], settings: {} };
  fs.writeFileSync(filename, JSON.stringify(raw)); const original = fs.readFileSync(filename);
  const store = createStore(root);
  assert.equal(store.data.activity.length, 100); assert.equal(store.data.jobs.length, 1); assert.equal(store.data.jobs[0].id, 'active');
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.throws(() => createStore(root, { maxLoadBytes: 64 }), /safe loading limit/);
  assert.deepEqual(fs.readFileSync(filename), original);
});

test('actual atomic save failure preserves both history array references and committed disk bytes', t => {
  const root = fixture(t), store = createStore(root); store.audit('before', 'committed');
  const filename = path.join(root, 'panel.json'), disk = fs.readFileSync(filename);
  const auditRows = [activity('new', new Date().toISOString()), activity('expired', old)], jobs = [job('active', 'running', old), job('expired', 'completed', old)];
  store.data.activity = auditRows; store.data.jobs = jobs;
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('durable rename ENOSPC'), { code: 'ENOSPC' }); });
  assert.throws(() => store.save(), /durable rename ENOSPC/);
  assert.strictEqual(store.data.activity, auditRows); assert.strictEqual(store.data.jobs, jobs); assert.deepEqual(fs.readFileSync(filename), disk);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.vortex-store-')), false);
  fs.renameSync = originalRename; store.save();
  assert.deepEqual(store.data.activity.map(row => row.id), ['new']); assert.deepEqual(store.data.jobs.map(row => row.id), ['active']);
});

test('policy update and explicitly confirmed clear commit audit; failed update/clear retain previous settings and history references', t => {
  const root = fixture(t), store = createStore(root); store.data.jobs = [job('active', 'running', old), job('finished', 'completed', new Date().toISOString())]; store.audit('before', 'keep');
  const previousSettings = store.data.settings, previousActivity = store.data.activity, previousJobs = store.data.jobs;
  const originalSave = store.save;
  store.save = () => { throw Error('actual candidate commit denied'); };
  assert.throws(() => store.updateHistoryPolicy({ activityDays: 14 }, 'owner'), /commit denied/);
  assert.strictEqual(store.data.settings, previousSettings); assert.strictEqual(store.data.activity, previousActivity); assert.strictEqual(store.data.jobs, previousJobs);
  assert.throws(() => store.clearHistory({ activity: true, finishedJobs: true, confirmed: true }, 'owner'), /commit denied/);
  assert.strictEqual(store.data.activity, previousActivity); assert.strictEqual(store.data.jobs, previousJobs);
  store.save = originalSave;
  assert.throws(() => store.clearHistory({ activity: true, confirmed: false }), /explicit confirmation/);
  assert.equal(store.updateHistoryPolicy({ activityDays: 14 }, 'owner').policy.activityDays, 14);
  const cleared = store.clearHistory({ activity: true, finishedJobs: true, confirmed: true }, 'owner');
  assert.equal(cleared.finishedJobs, 1); assert.equal(store.data.jobs[0].id, 'active'); assert.equal(store.data.activity[0].action, 'logs.history.clear'); assert.equal(store.data.activity[0].user, 'owner');
  assert.equal(createStore(root).historyPolicy().activityDays, 14);
});

test('policy validator rejects unsupported/noninteger limits, and malformed persisted fields fall back safely', () => {
  assert.throws(() => validateLogRetentionPolicy({ activityDays: 0 }), /supported range/);
  assert.throws(() => validateLogRetentionPolicy({ activityEntries: '1000' }), /supported range/);
  assert.throws(() => validateLogRetentionPolicy({ clearUsers: true }), /invalid/);
  assert.equal(getLogRetentionPolicy({ activityDays: -1, consoleBytes: 'infinite' }).activityDays, 7);
  assert.equal(validateLogRetentionPolicy({ activityDays: 7 }).activityDays, 7);
});

test('new defaults retain the latest 100 activity and 50 completed jobs by actual timestamps while all active jobs survive', t => {
  const root = fixture(t), store = createStore(root), stamp = Date.now();
  const activities = Array.from({ length: 180 }, (_, index) => activity(`activity-${index}`, new Date(stamp - index * 1000).toISOString()));
  const completed = Array.from({ length: 90 }, (_, index) => job(`job-${index}`, 'completed', new Date(stamp - index * 1000).toISOString()));
  const active = Array.from({ length: 70 }, (_, index) => job(`active-${index}`, index % 2 ? 'running' : 'queued', old));
  store.data.activity = [...activities].reverse(); store.data.jobs = [...completed].reverse().concat(active); store.save();
  assert.equal(store.data.activity.length, 100); assert.equal(store.data.activity[0].id, 'activity-0'); assert.equal(store.data.activity.at(-1).id, 'activity-99');
  assert.equal(store.data.jobs.filter(row => row.status === 'completed').length, 50);
  assert.equal(store.data.jobs.filter(row => row.status === 'completed')[0].id, 'job-0');
  assert.equal(store.data.jobs.filter(row => ['running', 'queued'].includes(row.status)).length, 70);
});

test('existing explicit retention policies, including exact former defaults with expired audit, preserve user intent after upgrade', t => {
  const root = fixture(t), filename = path.join(root, 'panel.json');
  const former = { ...LOG_RETENTION_DEFAULTS, activityDays: 30, activityEntries: 1000, activityBytes: 2 * 1024 ** 2, finishedJobDays: 30, finishedJobEntries: 200, finishedJobBytes: 4 * 1024 ** 2 };
  for (const policy of [former, { ...former, activityEntries: 500, finishedJobDays: 90 }]) {
    fs.writeFileSync(filename, JSON.stringify({ users: [], servers: [], jobs: [], activity: [], settings: { logRetention: policy } }));
    const store = createStore(root); assert.deepEqual(store.historyPolicy(), policy);
    store.updateHistoryPolicy({ activityEntries: 300 }, 'owner');
    assert.equal(store.data.settings.logRetentionCustomized, true); assert.equal(createStore(root).historyPolicy().activityEntries, 300);
  }
  fs.writeFileSync(filename, JSON.stringify({ users: [], servers: [], jobs: [], activity: [], settings: { logRetention: former, logRetentionDefaultsVersion: 1 } }));
  assert.deepEqual(createStore(root).historyPolicy(), LOG_RETENTION_DEFAULTS);
});

test('aged known quarantine/orphan-backup pointers survive clear while bytes exist, then become prunable after owned recovery cleanup', t => {
  const root = fixture(t), store = createStore(root), serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', backupId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', suffix = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const quarantine = `servers/${serverId}/backups/.vortex-delete-backup-${backupId}.zip-${suffix}`, orphan = `servers/${serverId}/backups/${backupId}.zip`;
  fs.mkdirSync(path.dirname(path.join(root, quarantine)), { recursive: true }); fs.writeFileSync(path.join(root, quarantine), 'QUARANTINE RECOVERY'); fs.writeFileSync(path.join(root, orphan), 'UNCATALOGUED RECOVERY');
  const deletion = { ...activity('quarantine-pointer', old), action: 'backup.retention', detail: `Old backup [quarantine: ${quarantine}]` };
  const orphanJob = job('orphan-pointer', 'failed', old, { type: 'backup', message: `commit failure; backup chưa được ghi vào catalog vẫn ở ${orphan}: EPERM` });
  const warningJob = job('warning-pointer', 'completed', old, { type: 'backup', warnings: [`Đã lưu thao tác xóa; còn dữ liệu cách ly tại ${quarantine}. Quản trị viên cần kiểm tra trước khi dọn: EPERM`] });
  store.data.activity = [deletion]; store.data.jobs = [orphanJob, warningJob]; store.save();
  assert.ok(store.data.activity.includes(deletion)); assert.ok(store.data.jobs.includes(orphanJob)); assert.ok(store.data.jobs.includes(warningJob));
  store.clearHistory({ activity: true, finishedJobs: true, confirmed: true });
  assert.ok(store.data.activity.includes(deletion)); assert.equal(store.data.jobs.length, 2); assert.equal(fs.readFileSync(path.join(root, quarantine), 'utf8'), 'QUARANTINE RECOVERY');
  fs.unlinkSync(path.join(root, quarantine)); fs.unlinkSync(path.join(root, orphan)); store.save();
  assert.equal(store.data.activity.includes(deletion), false); assert.equal(store.data.jobs.length, 0);
});

test('validated world quarantine and exact backup snapshot pointers survive retention until their data is removed', async t => {
  const root = fixture(t), store = createStore(root), serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', suffix = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const names = ['Đảo [A] + β', '界'.repeat(64), 'World-' + suffix];
  const quarantines = names.map(name => `servers/${serverId}/run/worlds/.vortex-delete-server-${name}-${suffix}`);
  const records = quarantines.map((relative, i) => ({ ...activity('world-pointer-' + i, old), action: 'world.delete', detail: `${names[i]} [quarantine: ${relative}]` }));
  const snapshot = `servers/${serverId}/backups/.${suffix}.snapshot`;
  for (const relative of [...quarantines, snapshot]) { fs.mkdirSync(path.join(root, relative), { recursive: true }); fs.writeFileSync(path.join(root, relative, 'marker'), 'OWNED RECOVERY'); }
  const backup = job('snapshot-pointer', 'completed', old, { type: 'backup', warnings: [`Chưa dọn được dữ liệu sao lưu tạm tại ${snapshot}: EPERM`] });
  store.data.activity = records; store.data.jobs = [backup]; store.save();
  for (const row of records) assert.ok(store.data.activity.includes(row)); assert.ok(store.data.jobs.includes(backup));
  store.clearHistory({ activity: true, finishedJobs: true, confirmed: true });
  for (const row of records) assert.ok(store.data.activity.includes(row)); assert.ok(store.data.jobs.includes(backup));
  for (const relative of [...quarantines, snapshot]) { assert.equal(fs.readFileSync(path.join(root, relative, 'marker'), 'utf8'), 'OWNED RECOVERY'); await fsp.rm(path.join(root, relative), { recursive: true }); assert.equal(fs.existsSync(path.join(root, relative)), false); }
  store.save(); for (const row of records) assert.equal(store.data.activity.includes(row), false); assert.equal(store.data.jobs.length, 0);
});

test('invalid world names and lookalike cleanup paths never trigger a recovery path inspection', t => {
  const root = fixture(t), store = createStore(root), serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', suffix = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const worlds = path.join(root, 'servers', serverId, 'run', 'worlds'), inspected = [], lstat = fs.lstatSync;
  const names = ['.', '..', 'CON', 'bad:name', 'bad/name', 'bad\\name', ' leading', 'trailing ', 'trailing.', 'bad\nname', '界'.repeat(86)];
  store.data.activity = names.map((name, i) => ({ ...activity('invalid-world-' + i, old), action: 'world.delete', detail: `world [quarantine: servers/${serverId}/run/worlds/.vortex-delete-server-${name}-${suffix}]` }));
  store.data.jobs = [job('lookalike-snapshot', 'completed', old, { type: 'backup', warnings: [`Chưa dọn được dữ liệu sao lưu tạm tại servers/${serverId}/backups/.${suffix}.snapshot/child: EPERM`] })];
  t.mock.method(fs, 'lstatSync', (filename, ...args) => { if (String(filename).startsWith(worlds)) { inspected.push(filename); throw Error('Invalid recovery path must not be inspected'); } return lstat(filename, ...args); });
  store.save(); assert.deepEqual(store.data.activity, []); assert.deepEqual(store.data.jobs, []); assert.deepEqual(inspected, []);
});

test('world recovery presence checks stop at symlinks and preserve the warning without reading their targets', t => {
  const root = fixture(t), store = createStore(root), serverId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', suffix = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const relative = `servers/${serverId}/run/worlds/.vortex-delete-server-Linked-${suffix}`, target = path.join(root, 'foreign-target');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'marker'), 'FOREIGN BYTES'); fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.symlinkSync(target, path.join(root, relative), process.platform === 'win32' ? 'junction' : 'dir');
  const lstat = fs.lstatSync, visited = [];
  t.mock.method(fs, 'lstatSync', (filename, ...args) => { visited.push(String(filename)); return lstat(filename, ...args); });
  const record = { ...activity('linked-world', old), action: 'world.delete', detail: `world [quarantine: ${relative}]` }; store.data.activity = [record]; store.save();
  assert.ok(store.data.activity.includes(record)); assert.equal(visited.some(filename => filename.startsWith(target)), false); assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'FOREIGN BYTES');
});

test('oversized protected job refuses a commit without dropping its payload or altering committed data', t => {
  const root = fixture(t), store = createStore(root, { maxLoadBytes: 4096 }); store.audit('initial', 'committed');
  const filename = path.join(root, 'panel.json'), previous = fs.readFileSync(filename), active = [job('large-active', 'running', old, { result: { recovery: 'X'.repeat(10000) } })];
  store.data.jobs = active; const activityRows = store.data.activity;
  assert.throws(() => store.save(), /safe commit limit/);
  assert.strictEqual(store.data.jobs, active); assert.strictEqual(store.data.activity, activityRows); assert.equal(store.data.jobs[0].result.recovery.length, 10000); assert.deepEqual(fs.readFileSync(filename), previous);
});

test('UTF-8 and serialized console line bounds preserve whole characters and explicitly mark oversized text', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(boundConsoleEntry({ ...record('same native message'), id }).id, id);
  assert.equal(Object.hasOwn(boundConsoleEntry({ ...record('same native message'), id: 'untrusted-large-id'.repeat(100) }), 'id'), false);
  const text = boundedUtf8Text('🙂界'.repeat(10000), 1024);
  assert.ok(Buffer.byteLength(text) <= 1024); assert.ok(text.endsWith('[truncated]')); assert.equal(text.includes('�'), false);
  for (const message of ['🙂界'.repeat(20000), '\u0000'.repeat(20000), '\"\\'.repeat(20000)]) {
    const entry = boundConsoleEntry({ ...record(message), id }, { ...LOG_RETENTION_DEFAULTS, consoleLineBytes: 1024 });
    assert.ok(Buffer.byteLength(JSON.stringify(entry) + '\n') <= 1024);
    assert.equal(entry.message.includes('�'), false);
  }
});

test('partial native line ingestion is byte bounded, supports split UTF-8, and resumes after an oversized line', () => {
  const lines = [], consumer = createUtf8LineConsumer({ maxBytes: 1024, onLine: line => lines.push(line) });
  const unicode = Buffer.from('Player Spawned: 世界🙂\n');
  consumer.write(unicode.subarray(0, 19)); consumer.write(unicode.subarray(19));
  for (let i = 0; i < 30; i++) { consumer.write(Buffer.from('界'.repeat(10000))); assert.ok(consumer.stats().bufferedBytes <= 1024); }
  consumer.write(Buffer.from('\n[INFO] Server started.\r\n')); consumer.end();
  assert.equal(lines[0], 'Player Spawned: 世界🙂'); assert.ok(Buffer.byteLength(lines[1]) <= 1024); assert.ok(lines[1].endsWith('[truncated]')); assert.equal(lines[2], '[INFO] Server started.');
  assert.equal(lines.join('').includes('�'), false); assert.equal(consumer.stats().bufferedBytes, 0);
});

test('console ring respects age, entry count and serialized byte budget', () => {
  const entries = [record('old', old), ...Array.from({ length: 100 }, (_, i) => record(`new-${i}`))];
  const limits = { ...LOG_RETENTION_DEFAULTS, consoleEntries: 3, consoleMemoryBytes: 1024 };
  const kept = trimConsoleEntries(entries, limits); assert.deepEqual(kept.map(row => row.message), ['new-97', 'new-98', 'new-99']);
  const bounded = trimConsoleEntries(Array.from({ length: 20 }, () => record('界'.repeat(10000))), { ...limits, consoleEntries: 20, consoleLineBytes: 1024 });
  assert.ok(Buffer.byteLength(bounded.map(row => JSON.stringify(row) + '\n').join('')) <= 1024);
  const ring = createBoundedConsoleRing({ limits });
  for (let i = 0; i < 5000; i++) ring.append(record(`entry-${i}`));
  assert.deepEqual(ring.snapshot().map(row => row.message), ['entry-4997', 'entry-4998', 'entry-4999']); assert.ok(ring.stats().bytes <= 1024);
});

test('owned console tail/maintenance bounds legacy disk bytes and preserves native logs, diagnostics, worlds and user log assets', async t => {
  const root = fixture(t), consoleFile = path.join(root, 'console.log');
  fs.mkdirSync(path.join(root, 'run/worlds/Main/db'), { recursive: true }); fs.mkdirSync(path.join(root, 'run/logs'), { recursive: true }); fs.mkdirSync(path.join(root, 'run/diagnostics'), { recursive: true });
  const protectedFiles = ['run/worlds/Main/db/000014.log', 'run/logs/content_log.txt', 'run/diagnostics/capture.log', 'run/custom.log'];
  for (const relative of protectedFiles) fs.writeFileSync(path.join(root, relative), `keep ${relative}`);
  const before = protectedFiles.map(relative => fs.readFileSync(path.join(root, relative)));
  const limits = { ...LOG_RETENTION_DEFAULTS, consoleBytes: 4096, consoleMemoryBytes: 4096, consoleEntries: 20, consoleLineBytes: 1024 };
  fs.writeFileSync(consoleFile, 'bad legacy giant partial '.repeat(50000) + '\n' + JSON.stringify(record('retained')) + '\n' + JSON.stringify(record('expired', old)) + '\n');
  const tail = await readConsoleTail(root, limits); assert.deepEqual(tail.map(row => row.message), ['retained']);
  const writer = createBoundedConsoleWriter({ serverRoot: root, limits }); await writer.maintain();
  assert.ok(fs.statSync(consoleFile).size <= 4096); writer.append(record('after maintenance')); await writer.close();
  assert.deepEqual((await readConsoleTail(root, limits)).map(row => row.message), ['retained', 'after maintenance']);
  for (let i = 0; i < protectedFiles.length; i++) assert.deepEqual(fs.readFileSync(path.join(root, protectedFiles[i])), before[i]);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.vortex-console-')), false);
});

test('writer queue stays bounded under a delayed disk sink and retains recent accepted entries', async t => {
  const root = fixture(t), limits = { ...LOG_RETENTION_DEFAULTS, consoleQueueBytes: 4096, consoleLineBytes: 1024, consoleBytes: 8192, consoleMemoryBytes: 8192 };
  const originalOpen = fsp.open; let release; const gate = new Promise(resolve => { release = resolve; }); let held = false;
  t.mock.method(fsp, 'open', async (...args) => { if (!held) { held = true; await gate; } return originalOpen(...args); });
  const writer = createBoundedConsoleWriter({ serverRoot: root, limits }); writer.append(record('first')); await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 1000; i++) { writer.append(record(`entry-${i} ${'界'.repeat(300)}`)); const stats = writer.stats(); assert.ok(stats.queuedBytes + stats.inFlightBytes <= limits.consoleQueueBytes); }
  assert.ok(writer.stats().droppedEntries > 0); release(); await writer.close();
  assert.ok(fs.statSync(path.join(root, 'console.log')).size <= limits.consoleBytes); assert.ok((await readConsoleTail(root, limits)).some(row => row.message.startsWith('entry-999')));
  assert.equal(writer.stats().queuedBytes, 0); assert.equal(writer.stats().inFlightBytes, 0);
});

test('failed console compaction after a partial temporary write preserves committed log and removes only its owned temporary', async t => {
  const root = fixture(t), filename = path.join(root, 'console.log'), original = Buffer.from(JSON.stringify(record('original')) + '\n' + 'legacy '.repeat(5000));
  fs.writeFileSync(filename, original); fs.writeFileSync(path.join(root, 'user.log'), 'USER BYTES');
  const originalOpen = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (path.basename(args[0]).startsWith('.vortex-console-')) return { close: () => handle.close(), async writeFile() { await handle.writeFile('partial write'); throw Object.assign(Error('disk full after a partial write'), { code: 'ENOSPC' }); } };
    return handle;
  });
  const writer = createBoundedConsoleWriter({ serverRoot: root, limits: { ...LOG_RETENTION_DEFAULTS, consoleBytes: 4096, consoleMemoryBytes: 4096 } });
  await writer.maintain(); await writer.close();
  assert.equal(writer.stats().writeFailures, 1); assert.equal(writer.stats().lastErrorCode, 'ENOSPC'); assert.equal(writer.stats().fileBytes, null);
  assert.deepEqual(fs.readFileSync(filename), original); assert.equal(fs.readFileSync(path.join(root, 'user.log'), 'utf8'), 'USER BYTES'); assert.equal(fs.readdirSync(root).some(name => name.startsWith('.vortex-console-')), false);
});

test('symlink/hardlink console guards refuse external files and surface persisted-log failure without rejecting native ingestion', async t => {
  const root = fixture(t), outside = path.join(root, 'external.txt'), serverRoot = path.join(root, 'server'); fs.mkdirSync(serverRoot); fs.writeFileSync(outside, 'EXTERNAL MUST REMAIN');
  const linked = path.join(serverRoot, 'console.log');
  fs.linkSync(outside, linked);
  await assert.rejects(readConsoleTail(serverRoot), /regular unlinked/);
  const warnings = [], writer = createBoundedConsoleWriter({ serverRoot, onWarning: error => warnings.push(error.code) });
  assert.equal(writer.append(record('accepted for safe in-memory display')), true); await writer.close();
  assert.equal(writer.stats().writeFailures, 1); assert.equal(writer.stats().droppedEntries, 1); assert.deepEqual(warnings, ['LOG_PATH_UNSAFE']); assert.equal(fs.readFileSync(outside, 'utf8'), 'EXTERNAL MUST REMAIN');
  fs.unlinkSync(linked);
  try { fs.symlinkSync(outside, linked, 'file'); } catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows symlink creation unavailable; hardlink refusal and outside-file preservation passed.'); return; } throw error; }
  await assert.rejects(readConsoleTail(serverRoot), /regular unlinked/); assert.equal(fs.readFileSync(outside, 'utf8'), 'EXTERNAL MUST REMAIN');
});

test('native log policy reports unmanaged content/diagnostics rather than deleting arbitrary runtime assets', () => {
  const policy = nativeLogRetentionPolicy({ 'content-log-file-enabled': 'true', 'diagnostics-capture-auto-start': 'false', 'diagnostics-capture-max-files': '5', 'diagnostics-capture-max-file-size': '256' });
  assert.equal(policy.automaticallyDeleted, false); assert.equal(policy.contentLogEnabled, true); assert.equal(policy.diagnosticsAutoStart, false); assert.equal(policy.diagnosticsMaxFiles, 5); assert.equal(policy.diagnosticsMaxFileSize, 256); assert.equal(policy.journaldManagedByPanel, false);
});
