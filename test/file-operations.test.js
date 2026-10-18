import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { createManager } from '../server/manager.js';
import { extractZip } from '../server/archives.js';

async function fixture(t, demo = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-files-'));
  const server = { id: randomUUID(), name: 'File tools', version: '1.20.0.0', channel: 'stable', transport: 'raknet', port: 30000, portV6: 30001, maxPlayers: 20, status: 'stopped', runtimeFiles: ['bedrock_server', 'resource_packs/vanilla/runtime.json'] };
  const store = { data: { servers: [server], versions: [], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  const files = { 'server.properties': 'level-name=Main\n', 'notes/a.txt': 'first', 'notes/b.txt': 'second', 'notes/folder/nested.txt': 'nested', 'worlds/Main/current.txt': 'world', 'keys/server_identity_key.pem': 'identity fixture', bedrock_server: 'inert fixture', 'resource_packs/vanilla/runtime.json': '{}' };
  const run = path.join(directory, 'servers', server.id, 'run');
  if (demo) { server.demoFiles = files; server.demoDirs = ['notes', 'notes/folder', 'notes/empty', 'out']; }
  else {
    for (const [name, content] of Object.entries(files)) { const target = path.join(run, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); }
    await fs.mkdir(path.join(run, 'notes/empty')); await fs.mkdir(path.join(run, 'out'));
  }
  const manager = await createManager({ store, dataDir: directory, demo });
  t.after(async () => { store.save = () => {}; server.status = 'stopped'; delete server.jobId; await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, store, server, run, directory };
}
const absent = target => fs.lstat(target).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
async function zip(files, target) {
  const archive = archiver('zip', { zlib: { level: 0 } }); const output = createWriteStream(target);
  const complete = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output); for (const [name, content] of Object.entries(files)) archive.append(content, { name }); await archive.finalize(); await complete;
}

test('batch copy/move preserve complete trees and empty directories; all sources preflight before activation', async t => {
  const { manager, server, run } = await fixture(t);
  await manager.copyFiles(server.id, { sources: ['notes/a.txt', 'notes/folder', 'notes/empty'], destination: 'out' });
  assert.equal(await fs.readFile(path.join(run, 'out/a.txt'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(run, 'out/folder/nested.txt'), 'utf8'), 'nested');
  assert.ok((await fs.stat(path.join(run, 'out/empty'))).isDirectory());
  assert.equal(await fs.readFile(path.join(run, 'notes/a.txt'), 'utf8'), 'first');
  await manager.moveFile(server.id, { sources: ['out/folder', 'out/empty'], destination: '' });
  assert.ok(await absent(path.join(run, 'out/folder'))); assert.ok((await fs.stat(path.join(run, 'empty'))).isDirectory());
  await assert.rejects(manager.moveFile(server.id, { sources: ['notes/b.txt', 'keys/server_identity_key.pem'], destination: 'out' }), error => error.status === 403);
  assert.equal(await fs.readFile(path.join(run, 'notes/b.txt'), 'utf8'), 'second'); assert.ok(await absent(path.join(run, 'out/b.txt')));
  await assert.rejects(manager.copyFiles(server.id, { sources: ['notes', 'notes/a.txt'], destination: 'out' }), /trùng/);
  await assert.rejects(manager.copyFiles(server.id, { sources: ['notes/a.txt', 'out/a.txt'], destination: '' }), /cùng tên/);
  await assert.rejects(manager.moveFile(server.id, { sources: ['notes'], destination: 'notes/folder' }), /chính nó/);
});

test('batch activation and durable failures roll back every moved/copied target', async t => {
  const { manager, store, server, run, directory } = await fixture(t);
  const rename = fs.rename; let rejected = false;
  fs.rename = async (source, target) => { if (!rejected && target === path.join(run, 'out/b.txt')) { rejected = true; throw Object.assign(new Error('Second activation failed'), { code: 'EIO' }); } return rename(source, target); };
  try { await assert.rejects(manager.moveFile(server.id, { sources: ['notes/a.txt', 'notes/b.txt'], destination: 'out' }), /Second activation/); } finally { fs.rename = rename; }
  for (const name of ['a.txt', 'b.txt']) { assert.ok(await absent(path.join(run, 'out', name))); assert.ok((await fs.stat(path.join(run, 'notes', name))).isFile()); }
  const before = structuredClone(store.data.activity); store.save = () => { throw new Error('Durable file commit failed'); };
  await assert.rejects(manager.copyFiles(server.id, { sources: ['notes/a.txt', 'notes/folder'], destination: 'out' }), /Durable file commit/);
  assert.ok(await absent(path.join(run, 'out/a.txt'))); assert.ok(await absent(path.join(run, 'out/folder')));
  await assert.rejects(manager.moveFile(server.id, { sources: ['notes/a.txt', 'notes/b.txt'], destination: 'out' }), /Durable file commit/);
  assert.ok(await absent(path.join(run, 'out/a.txt'))); assert.equal(await fs.readFile(path.join(run, 'notes/a.txt'), 'utf8'), 'first');
  assert.deepEqual(store.data.activity, before); assert.deepEqual((await fs.readdir(path.join(directory, 'servers', server.id))).filter(name => name.startsWith('.file-op-')), []);
});

test('ZIP compress/extract preserve server-relative paths and empty directories without overwrites', async t => {
  const { manager, server, run, directory } = await fixture(t);
  const compressed = await manager.compressFiles(server.id, { sources: ['notes/a.txt', 'notes/folder', 'notes/empty'], destination: 'out/selected.zip' });
  assert.equal(compressed.demo, false); const downloaded = await manager.downloadFile(server.id, 'out/selected.zip');
  assert.equal(downloaded.path, path.join(run, 'out/selected.zip')); assert.ok((await fs.stat(downloaded.path)).size > 0);
  const independent = path.join(directory, 'independent'); await extractZip(downloaded.path, independent);
  assert.equal(await fs.readFile(path.join(independent, 'notes/a.txt'), 'utf8'), 'first'); assert.ok((await fs.stat(path.join(independent, 'notes/empty'))).isDirectory());
  await manager.extractFiles(server.id, { source: 'out/selected.zip', destination: 'out/unpacked' });
  assert.equal(await fs.readFile(path.join(run, 'out/unpacked/notes/folder/nested.txt'), 'utf8'), 'nested');
  assert.ok((await fs.stat(path.join(run, 'out/unpacked/notes/empty'))).isDirectory());
  await assert.rejects(manager.extractFiles(server.id, { source: 'out/selected.zip', destination: 'out/unpacked' }), /tồn tại/);
  await assert.rejects(manager.compressFiles(server.id, { sources: ['notes'], destination: 'notes/recursive.zip' }), /bên trong/);
  await assert.rejects(manager.compressFiles(server.id, { sources: ['notes'], destination: 'out/selected.zip' }), /tồn tại/);
});

test('ZIP activation rolls back on audit failure and unsafe archives never reach live destinations', async t => {
  const { manager, store, server, run, directory } = await fixture(t);
  await manager.compressFiles(server.id, { sources: ['notes/folder'], destination: 'out/valid.zip' });
  const before = structuredClone(store.data.activity); store.save = () => { throw new Error('ZIP commit failed'); };
  await assert.rejects(manager.compressFiles(server.id, { sources: ['notes/a.txt'], destination: 'out/failed.zip' }), /ZIP commit failed/); assert.ok(await absent(path.join(run, 'out/failed.zip')));
  await assert.rejects(manager.extractFiles(server.id, { source: 'out/valid.zip', destination: 'out/failed-extract' }), /ZIP commit failed/); assert.ok(await absent(path.join(run, 'out/failed-extract'))); assert.deepEqual(store.data.activity, before);
  store.save = () => {};
  await zip({ bedrock_server: 'protected runtime' }, path.join(run, 'out/runtime.zip'));
  await assert.rejects(manager.extractFiles(server.id, { source: 'out/runtime.zip', destination: 'out/runtime' }), /bảo vệ/); assert.ok(await absent(path.join(run, 'out/runtime')));
  await zip({ 'keys/server_identity_key.pem': 'key' }, path.join(run, 'out/identity.zip'));
  await assert.rejects(manager.extractFiles(server.id, { source: 'out/identity.zip', destination: 'out/identity' }), /Identity/); assert.ok(await absent(path.join(run, 'out/identity')));
  await zip({ 'xx/x.txt': 'unsafe' }, path.join(run, 'out/traversal.zip'));
  const bytes = await fs.readFile(path.join(run, 'out/traversal.zip')); for (let offset = bytes.indexOf(Buffer.from('xx/x.txt')); offset >= 0; offset = bytes.indexOf(Buffer.from('xx/x.txt'), offset + 1)) bytes.write('../x.txt', offset); await fs.writeFile(path.join(run, 'out/traversal.zip'), bytes);
  await assert.rejects(manager.extractFiles(server.id, { source: 'out/traversal.zip', destination: 'out/traversal' }), error => error.status === 400); assert.ok(await absent(path.join(run, 'out/traversal')));
  assert.deepEqual((await fs.readdir(path.join(directory, 'servers', server.id))).filter(name => name.startsWith('.file-op-')), []);
});

test('editor revisions reject stale writes, preserve bytes on failed commit and reject invalid UTF-8', async t => {
  const { manager, store, server, run } = await fixture(t);
  const original = await manager.readFile(server.id, 'notes/a.txt'); assert.match(original.revision, /^[a-f0-9]{64}$/);
  await assert.rejects(manager.writeFile(server.id, original.path, 'new', { requireRevision: true }), error => error.status === 428);
  const saved = await manager.writeFile(server.id, original.path, 'new', { revision: original.revision, requireRevision: true }); assert.notEqual(saved.revision, original.revision);
  await assert.rejects(manager.writeFile(server.id, original.path, 'stale', { revision: original.revision }), error => error.status === 409); assert.equal(await fs.readFile(path.join(run, original.path), 'utf8'), 'new');
  await manager.deleteFile(server.id, 'notes/b.txt');
  await assert.rejects(manager.writeFile(server.id, 'notes/b.txt', 'resurrected', { revision: original.revision, requireRevision: true }), error => error.status === 404); assert.ok(await absent(path.join(run, 'notes/b.txt')));
  await assert.rejects(manager.writeFile(server.id, 'notes/missing.txt', 'new', { requireRevision: true }), error => error.status === 404); assert.ok(await absent(path.join(run, 'notes/missing.txt')));
  store.save = () => { throw new Error('Editor commit failed'); };
  await assert.rejects(manager.writeFile(server.id, original.path, 'failed', { revision: saved.revision }), /Editor commit failed/); assert.equal(await fs.readFile(path.join(run, original.path), 'utf8'), 'new');
  store.save = () => {};
  const invalid = Buffer.from([0xff, 0xfe, 0x41]); await fs.writeFile(path.join(run, 'notes/binary.bin'), invalid);
  await assert.rejects(manager.readFile(server.id, 'notes/binary.bin'), /UTF-8/); await assert.rejects(manager.writeFile(server.id, 'notes/binary.bin', 'mangled'), /UTF-8/); assert.deepEqual(await fs.readFile(path.join(run, 'notes/binary.bin')), invalid);
  await assert.rejects(manager.writeFile(server.id, 'keys/server_identity_key.pem', 'overwrite'), error => error.status === 403);
  await assert.rejects(manager.writeFile(server.id, 'resource_packs/vanilla/runtime.json', '{}'), error => error.status === 403);
  if (process.platform === 'win32') await assert.rejects(manager.writeFile(server.id, 'KEYS/SERVER_IDENTITY_KEY.PEM', 'overwrite'), error => error.status === 403);
});

test('managed text editor returns the actual normalized configuration and player JSON with matching revision', async t => {
  for (const demo of [false, true]) {
    const { manager, server, run } = await fixture(t, demo);
    const config = 'level-name=Main\nserver-port=30000\nserver-portv6=30001\ntransport=raknet\nmax-players=20\nenable-lan-visibility=false\nmojang-custom-setting=preserved\n';
    if (demo) { server.demoFiles['server.properties'] = config; server.demoFiles['allowlist.json'] = '[]\n'; }
    else { await fs.writeFile(path.join(run, 'server.properties'), config); await fs.writeFile(path.join(run, 'allowlist.json'), '[]\n'); }
    const oldConfig = await manager.readFile(server.id, 'server.properties');
    const proposed = 'difficulty=hard\n';
    const savedConfig = await manager.writeFile(server.id, oldConfig.path, proposed, { revision: oldConfig.revision, requireRevision: true });
    const committedConfig = await manager.readFile(server.id, oldConfig.path);
    assert.notEqual(savedConfig.content, proposed); assert.match(savedConfig.content, /mojang-custom-setting=preserved/); assert.match(savedConfig.content, /difficulty=hard/);
    assert.equal(savedConfig.content, committedConfig.content); assert.equal(savedConfig.revision, committedConfig.revision);
    const oldPlayers = await manager.readFile(server.id, 'allowlist.json');
    const submittedPlayers = '[{"name":"  Friend  ","xuid":"000123"}]';
    const savedPlayers = await manager.writeFile(server.id, oldPlayers.path, submittedPlayers, { revision: oldPlayers.revision, requireRevision: true });
    const committedPlayers = await manager.readFile(server.id, oldPlayers.path);
    assert.notEqual(savedPlayers.content, submittedPlayers); assert.deepEqual(JSON.parse(savedPlayers.content), [{ name: 'Friend', ignoresPlayerLimit: false, xuid: '123' }]);
    assert.equal(savedPlayers.content, committedPlayers.content); assert.equal(savedPlayers.revision, committedPlayers.revision);
  }
});

test('create, recursive mkdir, upload and delete roll back durable failures and refuse overwrites', async t => {
  const { manager, store, server, run, directory } = await fixture(t);
  const upload = path.join(directory, 'upload.bin'); await fs.writeFile(upload, Buffer.from([0, 1, 2, 3]));
  store.save = () => { throw new Error('CRUD commit failed'); };
  await assert.rejects(manager.createFile(server.id, { path: 'out/new.txt', content: 'new' }), /CRUD commit/); assert.ok(await absent(path.join(run, 'out/new.txt')));
  await assert.rejects(manager.mkdir(server.id, 'new/empty/deep'), /CRUD commit/); assert.ok(await absent(path.join(run, 'new')));
  await assert.rejects(manager.upload(server.id, 'out', 'new.bin', upload), /CRUD commit/); assert.ok(await absent(path.join(run, 'out/new.bin')));
  await assert.rejects(manager.deleteFile(server.id, 'notes/folder'), /CRUD commit/); assert.equal(await fs.readFile(path.join(run, 'notes/folder/nested.txt'), 'utf8'), 'nested');
  store.save = () => {};
  await manager.mkdir(server.id, 'new/empty/deep'); assert.ok((await fs.stat(path.join(run, 'new/empty/deep'))).isDirectory());
  await manager.createFile(server.id, { path: 'out/new.txt', content: 'new' }); await manager.upload(server.id, 'out', 'new.bin', upload);
  assert.deepEqual(await fs.readFile(path.join(run, 'out/new.bin')), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(manager.createFile(server.id, { path: 'out/new.txt', content: 'replace' }), error => error.status === 409);
  await assert.rejects(manager.upload(server.id, 'out', 'new.txt', upload), error => error.status === 409);
  await assert.rejects(manager.mkdir(server.id, 'notes'), error => error.status === 409);
  await assert.rejects(manager.deleteFile(server.id, 'worlds'), /thế giới/);
  await assert.rejects(manager.deleteFile(server.id, 'keys'), /Identity/);
});

test('quota, symlink and exclusive server locks reject work before mutation', async t => {
  const { manager, server, run, directory } = await fixture(t);
  const huge = path.join(run, 'notes/huge.bin'); await fs.writeFile(huge, ''); await fs.truncate(huge, 2 * 1024 ** 3 + 1);
  await assert.rejects(manager.copyFiles(server.id, { sources: ['notes/huge.bin'], destination: 'out' }), /2 GiB/); assert.ok(await absent(path.join(run, 'out/huge.bin'))); await fs.rm(huge);
  await assert.rejects(manager.compressFiles(server.id, { sources: Array(1001).fill('notes/a.txt'), destination: 'out/over.zip' }), /1.000/);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.txt'), 'outside'); await fs.symlink(outside, path.join(run, 'notes/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.copyFiles(server.id, { sources: ['notes'], destination: 'out' }), /liên kết/); assert.ok(await absent(path.join(run, 'out/notes')));
  const rename = fs.rename; let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const reached = new Promise(resolve => { entered = resolve; });
  fs.rename = async (source, target) => { if (target === path.join(run, 'out/a.txt')) { entered(); await gate; } return rename(source, target); };
  const copying = manager.copyFiles(server.id, { sources: ['notes/a.txt'], destination: 'out' }); await reached;
  assert.equal(manager.getServer(server.id).busy, true);
  try { await assert.rejects(manager.createFile(server.id, { path: 'out/other.txt', content: '' }), error => error.status === 409); await assert.rejects(manager.action(server.id, 'start'), error => error.status === 409); } finally { release(); await copying; fs.rename = rename; }
  assert.equal(manager.getServer(server.id).busy, false);
  server.status = 'running'; await manager.compressFiles(server.id, { sources: ['notes/a.txt'], destination: 'out/running.zip' }); assert.ok(await fs.stat(path.join(run, 'out/running.zip')));
  server.status = 'stopped'; await manager.close(); await assert.rejects(manager.createFile(server.id, { path: 'out/closed.txt', content: '' }), error => error.status === 503);
});

test('demo copy, ZIP and text CRUD are simulated snapshots with transactional metadata rollback', async t => {
  const { manager, store, server, directory } = await fixture(t, true);
  await manager.copyFiles(server.id, { sources: ['notes/folder', 'notes/empty'], destination: 'out' });
  await manager.compressFiles(server.id, { sources: ['notes/a.txt', 'notes/empty'], destination: 'out/demo.zip' });
  await manager.extractFiles(server.id, { source: 'out/demo.zip', destination: 'out/unpacked' });
  assert.equal(server.demoFiles['out/unpacked/notes/a.txt'], 'first'); assert.ok(server.demoDirs.includes('out/unpacked/notes/empty'));
  await assert.rejects(manager.downloadFile(server.id, 'out/demo.zip'), /mô phỏng/); await assert.rejects(manager.readFile(server.id, 'out/demo.zip'), /mô phỏng/);
  const edited = await manager.readFile(server.id, 'notes/b.txt'); await manager.deleteFile(server.id, edited.path);
  await assert.rejects(manager.writeFile(server.id, edited.path, 'resurrected', { revision: edited.revision, requireRevision: true }), error => error.status === 404);
  assert.equal(Object.hasOwn(server.demoFiles, edited.path), false);
  const before = structuredClone(server); store.save = () => { throw new Error('Demo durable commit failed'); };
  for (const operation of [() => manager.createFile(server.id, { path: 'out/new.txt', content: '' }), () => manager.mkdir(server.id, 'new/empty'), () => manager.deleteFile(server.id, 'notes/folder'), () => manager.compressFiles(server.id, { sources: ['notes/a.txt'], destination: 'out/failed.zip' }), () => manager.extractFiles(server.id, { source: 'out/demo.zip', destination: 'out/failed' })]) { await assert.rejects(operation(), /Demo durable commit/); assert.deepEqual(server, before); }
  assert.deepEqual(await fs.readdir(directory), []);
});
