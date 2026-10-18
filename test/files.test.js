import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';

async function fixture(t, demo = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-move-'));
  const server = { id: randomUUID(), name: 'Files', version: '1.20.0.0', channel: 'stable', transport: 'raknet', port: 30000, portV6: 30001, maxPlayers: 20, status: 'stopped', runtimeFiles: ['bedrock_server', 'resource_packs/vanilla/runtime.json'] };
  const store = { data: { servers: [server], versions: [], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  const files = { 'server.properties': 'level-name=Main\n', 'notes/a.txt': 'keep this text', 'notes/folder/nested.txt': 'nested content', 'worlds/Main/current.txt': 'world data', bedrock_server: 'inert fixture; never executable', 'resource_packs/vanilla/runtime.json': '{}' };
  const run = path.join(directory, 'servers', server.id, 'run');
  if (demo) { server.demoFiles = { ...files }; server.demoDirs = ['notes', 'notes/folder']; }
  else for (const [name, content] of Object.entries(files)) { const file = path.join(run, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const manager = await createManager({ store, dataDir: directory, demo });
  t.after(async () => { store.save = () => {}; server.status = 'stopped'; await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, store, server, run, directory };
}

test('scoped file rename and folder move preserve content and roll back when durable audit fails', async t => {
  const { manager, store, server, run } = await fixture(t);
  let writes = 0; store.save = () => { writes++; };
  const result = await manager.withActor({ username: 'file-operator' }, () => manager.moveFile(server.id, { source: 'notes/a.txt', destination: 'notes/b.txt' }));
  assert.deepEqual(result, { ok: true, source: 'notes/a.txt', destination: 'notes/b.txt' }); assert.equal(writes, 1);
  assert.equal(await fs.readFile(path.join(run, 'notes/b.txt'), 'utf8'), 'keep this text'); assert.equal(await fs.stat(path.join(run, 'notes/a.txt')).catch(() => null), null);
  assert.equal(store.data.activity[0].user, 'file-operator'); assert.match(store.data.activity[0].detail, /notes\/a.txt.*notes\/b.txt/);
  await manager.moveFile(server.id, { source: 'notes/folder', destination: 'renamed-folder' });
  assert.equal(await fs.readFile(path.join(run, 'renamed-folder/nested.txt'), 'utf8'), 'nested content');
  const activity = structuredClone(store.data.activity); store.save = () => { throw new Error('Move persistence failed'); };
  await assert.rejects(manager.moveFile(server.id, { source: 'renamed-folder', destination: 'notes/rollback-test' }), /Move persistence failed/);
  assert.equal(await fs.readFile(path.join(run, 'renamed-folder/nested.txt'), 'utf8'), 'nested content'); assert.equal(await fs.stat(path.join(run, 'notes/rollback-test')).catch(() => null), null); assert.deepEqual(store.data.activity, activity);
});

test('file move allows ordinary live files while rejecting overwrites, escapes, symlinks and protected server state', async t => {
  const { manager, server, run, directory } = await fixture(t);
  await fs.writeFile(path.join(run, 'notes/existing.txt'), 'do not overwrite');
  for (const [source, destination, pattern] of [
    ['notes/a.txt', 'notes/existing.txt', /tồn tại/], ['notes/a.txt', '../escape', /hợp lệ/], ['../outside', 'notes/new.txt', /hợp lệ/],
    ['notes/a.txt', 'missing/new.txt', /tìm thấy/], ['notes/folder', 'notes/folder/nested/new', /chính nó/], ['bedrock_server', 'renamed-runtime', /bảo vệ/],
    ['notes/a.txt', 'bedrock_server', /bảo vệ/], ['resource_packs', 'moved-pack', /bảo vệ/], ['server.properties', 'config-old.properties', /bảo vệ/],
    ['notes/a.txt', 'allowlist.json', /bảo vệ/], ['worlds/Main', 'worlds/Other', /thế giới/], ['worlds', 'worlds-old', /thế giới/], ['notes/a.txt', 'notes/a.txt', /khác nhau/]
  ]) await assert.rejects(manager.moveFile(server.id, { source, destination }), pattern);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.symlink(outside, path.join(run, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.moveFile(server.id, { source: 'escape/secret.txt', destination: 'notes/copied.txt' }), /liên kết/);
  await fs.symlink(outside, path.join(run, 'notes/folder/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.moveFile(server.id, { source: 'notes/folder', destination: 'moved-folder' }), /liên kết/);
  assert.equal(await fs.readFile(path.join(run, 'notes/existing.txt'), 'utf8'), 'do not overwrite');
  server.status = 'running';
  for (const [source, destination, status] of [
    ['worlds/Main', 'worlds/Other', 409], ['notes/a.txt', 'worlds/Main/new.txt', 409],
    ['bedrock_server', 'renamed-runtime', 403], ['notes/a.txt', 'bedrock_server', 403],
    ['server.properties', 'config-old.properties', 409]
  ]) await assert.rejects(manager.moveFile(server.id, { source, destination }), error => error.status === status);
  assert.deepEqual(await manager.moveFile(server.id, { source: 'notes/a.txt', destination: 'notes/c.txt' }), { ok: true, source: 'notes/a.txt', destination: 'notes/c.txt' });
  assert.equal(await fs.readFile(path.join(run, 'notes/c.txt'), 'utf8'), 'keep this text');
  await assert.rejects(fs.stat(path.join(run, 'notes/a.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(run, 'worlds/Main/current.txt'), 'utf8'), 'world data');
  assert.equal(await fs.readFile(path.join(run, 'bedrock_server'), 'utf8'), 'inert fixture; never executable');
  server.status = 'stopped'; server.jobId = 'busy'; await assert.rejects(manager.moveFile(server.id, { source: 'notes/a.txt', destination: 'notes/c.txt' }), error => error.status === 409); delete server.jobId;
  await manager.close(); await assert.rejects(manager.moveFile(server.id, { source: 'notes/a.txt', destination: 'notes/c.txt' }), error => error.status === 503);
});

test('demo file moves are explicitly simulated and retain state on failed commits', async t => {
  const { manager, store, server } = await fixture(t, true);
  await manager.moveFile(server.id, { source: 'notes/folder', destination: 'notes/renamed' });
  assert.equal(server.demoFiles['notes/renamed/nested.txt'], 'nested content'); assert.ok(server.demoDirs.includes('notes/renamed'));
  const before = structuredClone(server); store.save = () => { throw new Error('Demo commit failed'); };
  await assert.rejects(manager.moveFile(server.id, { source: 'notes/renamed', destination: 'notes/final' }), /Demo commit failed/); assert.deepEqual(server, before);
});
