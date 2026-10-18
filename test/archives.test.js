import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import archiver from 'archiver';
import { extractZip, zipDirectory } from '../server/archives.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-archives-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
async function zip(destination, entries, store = false) {
  const output = createWriteStream(destination), archive = archiver('zip', { store });
  const complete = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output);
  for (const entry of entries) archive.append(entry.content || '', { name: entry.name, ...(entry.directory ? { type: 'directory', mode: 0o700 } : {}) });
  await Promise.all([archive.finalize(), complete]);
}

test('ZIP extraction verifies CRC-32 including stored-byte corruption and closes writers before rejection', async t => {
  const root = await fixture(t), archive = path.join(root, 'corrupt.zip'), destination = path.join(root, 'unpacked');
  await zip(archive, [{ name: 'notes.txt', content: 'A payload whose CRC must match' }], true);
  const bytes = await fs.readFile(archive), offset = bytes.indexOf(Buffer.from('A payload whose CRC must match'));
  assert.ok(offset >= 0); bytes[offset] ^= 1; await fs.writeFile(archive, bytes);
  await assert.rejects(extractZip(archive, destination), error => error.status === 400 && /CRC-32/.test(error.message));
  await fs.rm(destination, { recursive: true });
  assert.equal(await fs.stat(destination).catch(() => null), null);
});

test('CRC fallback supports the declared Node 22.0 engine range and empty files', async t => {
  const root = await fixture(t), archive = path.join(root, 'crc.zip');
  await zip(archive, [{ name: 'vector.txt', content: '123456789' }, { name: 'empty.txt', content: '' }]);
  const original = zlib.crc32; zlib.crc32 = undefined;
  try { await extractZip(archive, path.join(root, 'fallback')); }
  finally { zlib.crc32 = original; }
  assert.equal(await fs.readFile(path.join(root, 'fallback/vector.txt'), 'utf8'), '123456789');
  assert.equal((await fs.stat(path.join(root, 'fallback/empty.txt'))).size, 0);
});

test('ZIP path validation rejects file-parent collisions in either entry order and filesystem aliases', async t => {
  const root = await fixture(t);
  for (const reverse of [false, true]) {
    const entries = [{ name: 'parent', content: 'a file' }, { name: 'parent/child.txt', content: 'a child' }];
    if (reverse) entries.reverse(); const archive = path.join(root, `prefix-${reverse}.zip`); await zip(archive, entries);
    await assert.rejects(extractZip(archive, path.join(root, `prefix-${reverse}`)), error => error.status === 400 && /xung đột/.test(error.message));
  }
  const alias = path.join(root, 'case.zip'); await zip(alias, [{ name: 'A.txt', content: 'A' }, { name: 'a.txt', content: 'a' }]);
  if (process.platform === 'win32') await assert.rejects(extractZip(alias, path.join(root, 'case')), error => error.status === 400 && /trùng/.test(error.message));
  else { await extractZip(alias, path.join(root, 'case')); assert.equal(await fs.readFile(path.join(root, 'case/A.txt'), 'utf8'), 'A'); }
});

test('ZIP extraction refuses destination and ancestor symlinks without touching outside files', async t => {
  const root = await fixture(t), outside = path.join(root, 'outside'), destination = path.join(root, 'unpacked');
  await fs.mkdir(outside); await fs.mkdir(destination); await fs.writeFile(path.join(outside, 'secret.txt'), 'keep');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(outside, path.join(destination, 'escape'), type);
  const archive = path.join(root, 'safe-paths.zip'); await zip(archive, [{ name: 'escape/secret.txt', content: 'replaced' }]);
  await assert.rejects(extractZip(archive, destination), error => error.status === 403 && /liên kết/.test(error.message));
  await fs.symlink(outside, path.join(root, 'linked-root'), type);
  await assert.rejects(extractZip(archive, path.join(root, 'linked-root')), error => error.status === 403);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'keep');
});

test('compression preserves empty directories and zero-byte files while traversal quotas stop before output creation', async t => {
  const root = await fixture(t), source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'folder/empty/nested'), { recursive: true }); await fs.writeFile(path.join(source, 'empty.txt'), '');
  const archive = path.join(root, 'directories.zip'); await zipDirectory(source, archive, { includeEmptyDirectories: true });
  const names = await extractZip(archive, path.join(root, 'result'));
  assert.ok(names.includes('folder/empty/nested')); assert.ok((await fs.stat(path.join(root, 'result/folder/empty/nested'))).isDirectory());
  assert.equal((await fs.stat(path.join(root, 'result/empty.txt'))).size, 0);
  const tooMany = path.join(root, 'too-many.zip'); await assert.rejects(zipDirectory(source, tooMany, { maxEntries: 2 }), /vượt giới hạn/);
  assert.equal(await fs.stat(tooMany).catch(() => null), null);
  const explicit = path.join(root, 'late-directory.zip'); await zip(explicit, [{ name: 'dir/file.txt', content: 'kept' }, { name: 'dir/', directory: true }]);
  await extractZip(explicit, path.join(root, 'late')); assert.equal(await fs.readFile(path.join(root, 'late/dir/file.txt'), 'utf8'), 'kept');
});

test('extraction entry quota includes implicit parents and returns unique physical paths for nested archive accounting', async t => {
  const root = await fixture(t), archive = path.join(root, 'implicit.zip');
  await zip(archive, [{ name: 'a/b/c.txt', content: 'one' }, { name: 'd/e/f.txt', content: 'two' }]);
  await assert.rejects(extractZip(archive, path.join(root, 'limited'), { maxEntries: 3 }), error => error.status === 400 && /ngầm định/.test(error.message));
  assert.equal(await fs.stat(path.join(root, 'limited/d')).catch(() => null), null);
  const paths = await extractZip(archive, path.join(root, 'allowed'), { maxEntries: 6 });
  assert.deepEqual(paths, ['a', 'a/b', 'a/b/c.txt', 'd', 'd/e', 'd/e/f.txt']);
  const explicit = path.join(root, 'explicit.zip'); await zip(explicit, [{ name: 'a/b.txt', content: 'kept' }, { name: 'a/', directory: true }]);
  assert.deepEqual(await extractZip(explicit, path.join(root, 'no-double-count'), { maxEntries: 2 }), ['a', 'a/b.txt']);
});
