import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createApp } from '../server/index.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-retention-routes-'));
  const id = randomUUID(), setupToken = randomBytes(24).toString('base64url'), password = randomBytes(24).toString('base64url');
  const seeded = createStore(root); seeded.data.servers.push({ id, name: 'Owned retention routes', version: '1.26.52.3', channel: 'stable', port: 33100, portV6: 33101, transport: 'raknet', maxPlayers: 8, status: 'stopped', autoStart: false, autoRestart: false, runtimeFiles: [], backups: [] }); seeded.save();
  await fs.mkdir(path.join(root, 'servers', id, 'run'), { recursive: true });
  await fs.writeFile(path.join(root, 'servers', id, 'run/server.properties'), 'level-name=Owned world\nserver-port=33100\nserver-portv6=33101\ntransport=raknet\nenable-lan-visibility=false\n');
  const originalFetch = globalThis.fetch;
  let runtime, originalSave;
  // Register cleanup before setup assertions. A failed login/setup must not
  // leave a live HTTP server hiding the original assertion behind open handles.
  t.after(async () => {
    if (runtime && originalSave) runtime.store.save = originalSave;
    globalThis.fetch = originalFetch;
    try { await runtime?.close(); }
    finally {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('vortex-retention-routes-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  globalThis.fetch = (url, options) => String(url).startsWith('https:') ? Promise.reject(Error('Owned route fixture blocks external downloads')) : originalFetch(url, options);
  runtime = await createApp({ dataDir: root, demo: false, setupToken });
  originalSave = runtime.store.save;
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${runtime.server.address().port}`, sessions = {};
  const request = async (method, route, body, actor = 'owner', { csrf = true } = {}) => {
    const session = sessions[actor];
    return originalFetch(url + '/api' + route, { method, headers: { Origin: url, ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf ? { 'X-CSRF-Token': session.csrfToken } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  const establish = async (actor, route, body) => {
    const response = await request('POST', route, body, null); assert.equal(response.status, 200);
    const auth = await response.json(); sessions[actor] = { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: auth.csrfToken };
  };
  await establish('owner', '/auth/setup', { token: setupToken, username: 'retentionowner', password });
  for (const role of ['viewer', 'operator']) {
    const response = await request('POST', '/auth/users', { username: `retention${role}`, password, role, allServers: false, serverIds: [id] }); assert.equal(response.status, 201);
    await establish(role, '/auth/login', { username: `retention${role}`, password });
  }
  return { root, id, runtime, request, password };
}

test('actual Admin retention routes expose bounded stats/export while Viewer, Operator and missing CSRF cannot mutate or download', async t => {
  const { runtime, request, password } = await fixture(t);
  const admin = await request('GET', '/admin/log-retention'); assert.equal(admin.status, 200);
  const data = await admin.json(); assert.equal(data.policy.activityDays, 7); assert.equal(data.policy.activityEntries, 100); assert.equal(data.policy.finishedJobEntries, 50); assert.equal(data.policy.consoleBytes, 2097152); assert.equal(data.console.nativeFilesManaged, false); assert.equal(data.console.journaldManaged, false);
  for (const actor of ['viewer', 'operator']) for (const [method, route, body] of [['GET', '/admin/log-retention'], ['HEAD', '/admin/log-retention/export'], ['GET', '/admin/log-retention/export'], ['PATCH', '/admin/log-retention', { activityDays: 7 }], ['POST', '/admin/log-retention/clear', { activity: true, finishedJobs: true, confirmed: true }]]) assert.equal((await request(method, route, body, actor)).status, 403);
  assert.equal((await request('PATCH', '/admin/log-retention', { activityDays: 7 }, 'owner', { csrf: false })).status, 403);
  assert.equal(runtime.store.historyPolicy().activityDays, 7);
  const exportedResponse = await request('GET', '/admin/log-retention/export'); assert.equal(exportedResponse.status, 200); assert.match(exportedResponse.headers.get('content-disposition'), /attachment.*vortex-history\.json/);
  const exported = await exportedResponse.json(); assert.deepEqual(Object.keys(exported).sort(), ['activity', 'exportedAt', 'jobs', 'policy']); assert.equal(JSON.stringify(exported).includes(password), false);
});

test('actual policy PATCH persists supported lower byte values and rejects unknown, fractional or out-of-range fields without history mutation', async t => {
  const { runtime, request, root } = await fixture(t);
  const changed = await request('PATCH', '/admin/log-retention', { activityDays: 7, activityBytes: 65536, finishedJobBytes: 262144, consoleDays: 14 }); assert.equal(changed.status, 200);
  const body = await changed.json(); assert.equal(body.policy.activityDays, 7); assert.equal(body.policy.activityBytes, 65536); assert.equal(body.policy.finishedJobBytes, 262144); assert.ok(body.stats); assert.ok(body.console);
  assert.equal(runtime.store.data.activity[0].action, 'logs.policy.update'); assert.equal(runtime.store.data.activity[0].user, 'retentionowner');
  const disk = await fs.readFile(path.join(root, 'panel.json')), activity = runtime.store.data.activity, jobs = runtime.store.data.jobs;
  for (const invalid of [{ activityDays: 0 }, { activityEntries: 100.5 }, { activityDays: '7' }, { users: [] }]) assert.equal((await request('PATCH', '/admin/log-retention', invalid)).status, 400);
  assert.strictEqual(runtime.store.data.activity, activity); assert.strictEqual(runtime.store.data.jobs, jobs); assert.deepEqual(await fs.readFile(path.join(root, 'panel.json')), disk);
});

test('actual explicitly confirmed clear preserves active/referenced/recovery/quarantine records, users, vault and owned recovery bytes', async t => {
  const { root, id, runtime, request } = await fixture(t), server = runtime.store.data.servers[0], time = new Date().toISOString(), old = '2025-01-01T00:00:00.000Z';
  const suffix = randomUUID(), archive = randomUUID(), quarantine = `servers/${id}/backups/.vortex-delete-backup-${archive}.zip-${suffix}`;
  await fs.mkdir(path.dirname(path.join(root, quarantine)), { recursive: true }); await fs.writeFile(path.join(root, quarantine), 'owned recovery bytes');
  server.jobId = 'active'; server.restoreRecoveryRequired = { original: `servers/${id}/.rollback-owned`, candidate: `servers/${id}/run`, primaryError: 'owned injected failure', rollbackError: 'EPERM', backupId: 'protected-backup', createdAt: old }; server.backups = [{ id: 'protected-backup', locked: true }];
  runtime.store.data.jobs = [{ id: 'active', status: 'running', createdAt: old }, { id: 'restore', type: 'restore', serverId: id, status: 'failed', finishedAt: old }, { id: 'ordinary-finished', status: 'completed', finishedAt: time }];
  runtime.store.data.activity = [{ id: 'restore-audit', action: 'restore.failed', serverId: id, time: old, detail: 'recovery' }, { id: 'quarantine-audit', action: 'backup.retention', serverId: id, time: old, detail: `snapshot [quarantine: ${quarantine}]` }, { id: 'ordinary-activity', action: 'server.command', time, detail: 'removable' }]; runtime.store.save();
  const users = JSON.stringify(runtime.store.data.users), backups = JSON.stringify(server.backups), recovery = JSON.stringify(server.restoreRecoveryRequired), keyPath = path.join(root, '.mfa-key');
  const keyDigest = createHash('sha256').update(await fs.readFile(keyPath)).digest('hex');
  assert.equal((await request('POST', '/admin/log-retention/clear', { activity: true, finishedJobs: true, confirmed: false })).status, 400);
  const clearedResponse = await request('POST', '/admin/log-retention/clear', { activity: true, finishedJobs: true, confirmed: true }); assert.equal(clearedResponse.status, 200);
  const cleared = await clearedResponse.json(); assert.equal(cleared.activity, 1); assert.equal(cleared.finishedJobs, 1);
  assert.deepEqual(runtime.store.data.jobs.map(row => row.id), ['active', 'restore']); assert.ok(runtime.store.data.activity.some(row => row.id === 'restore-audit')); assert.ok(runtime.store.data.activity.some(row => row.id === 'quarantine-audit')); assert.equal(runtime.store.data.activity[0].action, 'logs.history.clear');
  assert.equal(JSON.stringify(runtime.store.data.users), users); assert.equal(JSON.stringify(server.backups), backups); assert.equal(JSON.stringify(server.restoreRecoveryRequired), recovery); assert.equal(createHash('sha256').update(await fs.readFile(keyPath)).digest('hex'), keyDigest); assert.equal(await fs.readFile(path.join(root, quarantine), 'utf8'), 'owned recovery bytes');
});

test('actual failed atomic policy/clear commits return failure and preserve settings/history references and committed store bytes', async t => {
  const { root, runtime, request } = await fixture(t), filename = path.join(root, 'panel.json');
  runtime.store.data.jobs = [{ id: 'active', status: 'queued', createdAt: new Date().toISOString() }, { id: 'finished', status: 'completed', finishedAt: new Date().toISOString() }]; runtime.store.save();
  const before = { settings: runtime.store.data.settings, activity: runtime.store.data.activity, jobs: runtime.store.data.jobs, bytes: await fs.readFile(filename) }, originalRename = fsSync.renameSync;
  t.mock.method(fsSync, 'renameSync', (...args) => { if (args[1] === filename) throw Object.assign(Error('Owned atomic metadata ENOSPC'), { code: 'ENOSPC' }); return originalRename(...args); });
  t.mock.method(console, 'error', () => {});
  try {
    assert.equal((await request('PATCH', '/admin/log-retention', { activityDays: 7 })).status, 500);
    assert.equal((await request('POST', '/admin/log-retention/clear', { activity: true, finishedJobs: true, confirmed: true })).status, 500);
    assert.strictEqual(runtime.store.data.settings, before.settings); assert.strictEqual(runtime.store.data.activity, before.activity); assert.strictEqual(runtime.store.data.jobs, before.jobs); assert.deepEqual(await fs.readFile(filename), before.bytes);
  } finally { fsSync.renameSync = originalRename; }
});
