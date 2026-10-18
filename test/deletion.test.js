import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';

async function fixture(t, { demo = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-delete-'));
  const store = createStore(dataDir); const backup = { id: randomUUID(), name: 'Owned backup.zip', version: '1.26.52.3', createdAt: new Date().toISOString() };
  const server = { id: randomUUID(), name: 'Deletion QA', status: 'stopped', version: '1.26.52.3', channel: 'stable', port: 32000, portV6: 32001, maxPlayers: 12, backups: [backup], backupRetention: 1, runtimeFiles: ['bedrock_server'] };
  const other = { ...server, id: randomUUID(), name: 'Other instance', backups: [] };
  const assigned = { id: randomUUID(), username: 'assigned', role: 'operator', serverIds: [server.id, other.id] }, unassigned = { id: randomUUID(), username: 'unassigned', role: 'viewer' };
  const schedule = { id: randomUUID(), serverId: server.id, enabled: false }, unrelated = { id: randomUUID(), serverId: other.id, enabled: false };
  Object.assign(store.data, { servers: [server, other], users: [assigned, unassigned], schedules: [schedule, unrelated], activity: [] }); store.save();
  const serverRoot = path.join(dataDir, 'servers', server.id), archive = path.join(serverRoot, 'backups', backup.id + '.zip');
  if (!demo) { await fs.mkdir(path.join(serverRoot, 'backups'), { recursive: true }); await fs.mkdir(path.join(serverRoot, 'run'), { recursive: true }); await fs.writeFile(archive, 'Original backup bytes'); await fs.writeFile(path.join(serverRoot, 'world-marker'), 'Original world bytes'); await fs.writeFile(path.join(serverRoot, 'run/notes.txt'), 'Actual backup input'); }
  const manager = await createManager({ store, dataDir, demo }); const save = store.save;
  t.after(async () => { store.save = save; server.status = other.status = 'stopped'; await manager.close(); assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dataDir).startsWith('vortex-delete-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, save, manager, server, other, assigned, unassigned, schedule, unrelated, backup, archive, serverRoot };
}
const exists = filename => fs.lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function finished(manager, id) {
  for (let count = 0; count < 300; count++) { const result = manager.jobs().find(item => item.id === id); if (['completed', 'failed'].includes(result.status)) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Backup job did not finish');
}

for (const method of ['deleteBackup', 'deleteServer']) test(`${method} preserves real bytes, persisted metadata and object references when audited commit fails`, async t => {
  const x = await fixture(t); const beforeDisk = await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8');
  const refs = { servers: x.store.data.servers, schedules: x.store.data.schedules, activity: x.store.data.activity, grants: x.assigned.serverIds, backups: x.server.backups };
  const action = method === 'deleteServer' ? 'server.delete' : 'backup.delete'; let commits = 0;
  x.store.save = () => { commits++; assert.equal(x.store.data.activity[0].action, action); assert.equal(x.store.data.activity[0].user, 'named-operator'); throw Object.assign(Error('Actual metadata sink rejects audited deletion'), { code: 'ENOSPC' }); };
  await assert.rejects(x.manager.withActor({ username: 'named-operator' }, () => method === 'deleteServer' ? x.manager.deleteServer(x.server.id) : x.manager.deleteBackup(x.server.id, x.backup.id)), /metadata sink rejects/);
  assert.equal(commits, 1); assert.equal(await fs.readFile(x.archive, 'utf8'), 'Original backup bytes'); assert.equal(await fs.readFile(path.join(x.serverRoot, 'world-marker'), 'utf8'), 'Original world bytes');
  assert.equal(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'), beforeDisk);
  assert.strictEqual(x.store.data.servers, refs.servers); assert.strictEqual(x.store.data.servers[0], x.server); assert.strictEqual(x.store.data.schedules, refs.schedules); assert.strictEqual(x.assigned.serverIds, refs.grants); assert.strictEqual(x.server.backups, refs.backups); assert.strictEqual(x.store.data.activity, refs.activity); assert.equal(Object.hasOwn(x.unassigned, 'serverIds'), false);
  const parent = method === 'deleteServer' ? path.dirname(x.serverRoot) : path.dirname(x.archive); assert.ok(!(await fs.readdir(parent)).some(name => name.startsWith('.vortex-delete-')));
});

test('server deletion durably removes only its metadata, grants and schedules with one named audit commit', async t => {
  const x = await fixture(t); let commits = 0; x.store.save = () => { commits++; x.save(); }; x.store.audit = () => { throw Error('Deletion must not issue a second independent audit save'); };
  assert.deepEqual(await x.manager.withActor({ username: 'instance-admin' }, () => x.manager.deleteServer(x.server.id)), { ok: true });
  assert.equal(commits, 1); assert.equal(await exists(x.serverRoot), false); assert.deepEqual(x.store.data.servers, [x.other]); assert.deepEqual(x.store.data.schedules, [x.unrelated]); assert.deepEqual(x.assigned.serverIds, [x.other.id]);
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.equal(disk.servers.length, 1); assert.equal(disk.servers[0].id, x.other.id); assert.equal(disk.activity[0].action, 'server.delete'); assert.equal(disk.activity[0].user, 'instance-admin'); assert.match(disk.activity[0].detail, /quarantine: servers\/\.vortex-delete-server-/);
});

test('backup deletion is one durable named audit and leaves world/server metadata intact', async t => {
  const x = await fixture(t); let commits = 0; x.store.save = () => { commits++; x.save(); }; x.store.audit = () => { throw Error('No separate audit sink'); };
  assert.deepEqual(await x.manager.withActor({ username: 'backup-operator' }, () => x.manager.deleteBackup(x.server.id, x.backup.id)), { ok: true }); assert.equal(commits, 1); assert.equal(await exists(x.archive), false); assert.equal(await fs.readFile(path.join(x.serverRoot, 'world-marker'), 'utf8'), 'Original world bytes'); assert.strictEqual(x.store.data.servers[0], x.server); assert.deepEqual(x.server.backups, []);
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.equal(disk.servers[0].backups.length, 0); assert.equal(disk.activity[0].user, 'backup-operator'); assert.equal(disk.activity[0].action, 'backup.delete');
});

test('post-commit cleanup failure reports retained quarantine without pretending metadata rollback', async t => {
  const x = await fixture(t); const original = fs.rm; fs.rm = async (target, options) => { if (path.basename(target).startsWith('.vortex-delete-server-')) throw Object.assign(Error('Cleanup access denied'), { code: 'EACCES' }); return original(target, options); };
  let result; try { result = await x.manager.deleteServer(x.server.id); } finally { fs.rm = original; }
  assert.equal(result.ok, true); assert.match(result.warnings[0], /Cleanup access denied/); assert.match(result.cleanupPending, /^servers\/\.vortex-delete-server-/); assert.equal(await exists(x.serverRoot), false);
  const retained = path.join(x.dataDir, result.cleanupPending); assert.equal(await fs.readFile(path.join(retained, 'world-marker'), 'utf8'), 'Original world bytes'); assert.equal(JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')).servers.some(item => item.id === x.server.id), false);
});

test('server and backup ancestor symlinks are rejected before rename or metadata mutation', async t => {
  const x = await fixture(t); const outside = path.join(x.dataDir, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'marker.txt'), 'Outside bytes must survive');
  await fs.rename(x.serverRoot, x.serverRoot + '-original'); await fs.symlink(outside, x.serverRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'); await assert.rejects(x.manager.deleteServer(x.server.id), error => error.status === 403); assert.equal(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'), before); assert.equal(await fs.readFile(path.join(outside, 'marker.txt'), 'utf8'), 'Outside bytes must survive');
  await fs.unlink(x.serverRoot); await fs.rename(x.serverRoot + '-original', x.serverRoot); await fs.rename(path.join(x.serverRoot, 'backups'), path.join(x.serverRoot, 'backups-original')); await fs.symlink(outside, path.join(x.serverRoot, 'backups'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(x.manager.deleteBackup(x.server.id, x.backup.id), error => error.status === 403); assert.equal(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'), before); assert.equal(x.server.backups.length, 1); assert.equal(await fs.readFile(path.join(outside, 'marker.txt'), 'utf8'), 'Outside bytes must survive');
});

test('retention uses the same durable deletion rollback while the backup job holds its own lock', async t => {
  const x = await fixture(t); const oldRecord = x.backup; x.store.save = () => { if (x.store.data.activity[0]?.action === 'backup.retention') throw Object.assign(Error('Retention metadata ENOSPC'), { code: 'ENOSPC' }); x.save(); };
  const record = await x.manager.withActor({ username: 'scheduler-operator' }, () => x.manager.backup(x.server.id));
  for (let count = 0; count < 300 && !['completed', 'failed'].includes(x.manager.jobs().find(item => item.id === record.id).status); count++) await new Promise(resolve => setTimeout(resolve, 10));
  const result = x.manager.jobs().find(item => item.id === record.id); assert.equal(result.status, 'completed'); assert.equal(result.operationCompleted, true); assert.equal(result.retentionComplete, false); assert.ok(result.warnings.some(warning => /Retention metadata ENOSPC/.test(warning))); assert.equal(x.server.backups.length, 2); assert.equal(await fs.readFile(x.archive, 'utf8'), 'Original backup bytes'); assert.ok(x.server.backups.includes(oldRecord));
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.ok(disk.servers[0].backups.some(item => item.id === oldRecord.id)); assert.equal(disk.activity.some(item => item.action === 'backup.retention'), false); assert.equal(x.store.data.activity.some(item => item.action === 'backup.retention'), false); assert.ok(!(await fs.readdir(path.dirname(x.archive))).some(name => name.startsWith('.vortex-delete-')));
});

test('demo deletion rollback retains server references, ACLs, schedules and backup record', async t => {
  const x = await fixture(t, { demo: true }); const refs = { servers: x.store.data.servers, schedules: x.store.data.schedules, grants: x.assigned.serverIds, backups: x.server.backups }; x.store.save = () => { throw Error('Demo commit failed'); };
  await assert.rejects(x.manager.deleteBackup(x.server.id, x.backup.id), /Demo commit failed/); await assert.rejects(x.manager.deleteServer(x.server.id), /Demo commit failed/); assert.strictEqual(x.store.data.servers, refs.servers); assert.strictEqual(x.store.data.schedules, refs.schedules); assert.strictEqual(x.assigned.serverIds, refs.grants); assert.strictEqual(x.server.backups, refs.backups); assert.equal(Object.hasOwn(x.unassigned, 'serverIds'), false);
});

test('a missing archive can remove its damaged catalog entry without deleting unrelated bytes', async t => {
  const x = await fixture(t); await fs.unlink(x.archive); let commits = 0; x.store.save = () => { commits++; x.save(); };
  assert.deepEqual(await x.manager.deleteBackup(x.server.id, x.backup.id), { ok: true }); assert.equal(commits, 1); assert.deepEqual(x.server.backups, []); assert.equal(await fs.readFile(path.join(x.serverRoot, 'world-marker'), 'utf8'), 'Original world bytes'); assert.equal(x.store.data.activity[0].action, 'backup.delete');
});

test('failed backup creation audit restores original catalog and removes only the newly completed archive', async t => {
  const x = await fixture(t); const backups = x.server.backups;
  x.store.save = () => { if (x.store.data.activity[0]?.action === 'backup.create') throw Object.assign(Error('Backup creation audit ENOSPC'), { code: 'ENOSPC' }); x.save(); };
  const record = await x.manager.withActor({ username: 'backup-creator' }, () => x.manager.backup(x.server.id)); const result = await finished(x.manager, record.id);
  assert.equal(result.status, 'failed'); assert.match(result.message, /Backup creation audit ENOSPC/); assert.strictEqual(x.server.backups, backups); assert.equal(await fs.readFile(x.archive, 'utf8'), 'Original backup bytes'); assert.deepEqual(await fs.readdir(path.dirname(x.archive)), [x.backup.id + '.zip']);
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.deepEqual(disk.servers[0].backups.map(item => item.id), [x.backup.id]); assert.equal(disk.activity.some(item => item.action === 'backup.create'), false);
});

test('failed new-backup cleanup keeps an explicit unlisted recovery path and preserves all old archives', async t => {
  const x = await fixture(t); x.store.save = () => { if (x.store.data.activity[0]?.action === 'backup.create') throw Error('Reject completed archive catalog'); x.save(); };
  const original = fs.rm; fs.rm = async (target, options) => { if (path.dirname(target) === path.dirname(x.archive) && target.endsWith('.zip') && target !== x.archive) throw Error('New archive cleanup denied'); return original(target, options); };
  let result; try { const record = await x.manager.backup(x.server.id); result = await finished(x.manager, record.id); } finally { fs.rm = original; }
  assert.equal(result.status, 'failed'); assert.match(result.message, /backup chưa được ghi vào catalog vẫn ở servers\/.*\.zip: New archive cleanup denied/); assert.equal(await fs.readFile(x.archive, 'utf8'), 'Original backup bytes'); assert.equal(x.server.backups.length, 1); assert.equal((await fs.readdir(path.dirname(x.archive))).filter(name => name.endsWith('.zip')).length, 2); assert.equal(JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')).servers[0].backups.length, 1);
});

test('retention cleanup warnings appear in completed backup job and server console after durable removal', async t => {
  const x = await fixture(t); const original = fs.rm; fs.rm = async (target, options) => { if (path.basename(target).startsWith('.vortex-delete-backup-')) throw Error('Retention cleanup denied'); return original(target, options); };
  let result; try { const record = await x.manager.withActor({ username: 'retention-owner' }, () => x.manager.backup(x.server.id)); result = await finished(x.manager, record.id); } finally { fs.rm = original; }
  assert.equal(result.status, 'completed'); assert.equal(result.warnings.length, 1); assert.match(result.message, /cách ly/); assert.match(result.warnings[0], /Retention cleanup denied/); assert.ok(x.manager.logs(x.server.id).some(line => line.level === 'warn' && line.message.includes('Retention cleanup denied')));
  assert.equal(x.server.backups.length, 1); assert.notEqual(x.server.backups[0].id, x.backup.id); assert.equal(await exists(x.archive), false); const files = await fs.readdir(path.dirname(x.archive)); const retained = files.find(name => name.startsWith('.vortex-delete-backup-')); assert.ok(retained); assert.equal(await fs.readFile(path.join(path.dirname(x.archive), retained), 'utf8'), 'Original backup bytes');
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.equal(disk.servers[0].backups.some(item => item.id === x.backup.id), false); assert.ok(disk.activity.some(item => item.action === 'backup.retention' && item.user === 'retention-owner'));
});
