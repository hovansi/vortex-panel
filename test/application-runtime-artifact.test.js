import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { APPLICATION_RUNTIME_ARTIFACT } from '../server/application-runtime-artifact.js';
const exec = promisify(execFile), python = process.platform === 'win32' ? 'python' : 'python3';
// O_NOFOLLOW is a Linux production requirement; Windows fixtures cannot open
// POSIX descriptors, so only that OS boundary is injected for archive testing.
const helper = `import os\nos.umask(0o077)\nif not hasattr(os, 'O_NOFOLLOW'): os.O_NOFOLLOW = 0\n` + APPLICATION_RUNTIME_ARTIFACT;
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-runtime-artifact-')); t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vortex-runtime-artifact-')); await fs.rm(root, { recursive: true, force: true }); }); return root; }
async function archive(root, rows) {
  const filename = path.join(root, 'source.tar.xz');
  const script = `import io, json, sys, tarfile\nwith tarfile.open(sys.argv[1], 'w:xz') as stream:\n for row in json.loads(sys.argv[2]):\n  item=tarfile.TarInfo(row['name']); item.mode=0o755 if row.get('executable') else 0o644\n  if row.get('type')=='symlink': item.type=tarfile.SYMTYPE; item.linkname=row['target']; stream.addfile(item)\n  elif row.get('type')=='hardlink': item.type=tarfile.LNKTYPE; item.linkname=row['target']; stream.addfile(item)\n  else:\n   data=row.get('content','file').encode(); item.size=len(data); stream.addfile(item, io.BytesIO(data))`;
  await exec(python, ['-I', '-c', script, filename, JSON.stringify(rows)], { timeout: 10000, maxBuffer: 65536, windowsHide: true }); return filename;
}
const run = (...args) => exec(python, ['-I', '-c', helper, ...args], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
test('actual trusted artifact code extracts and promotes bounded ordinary publisher files without executing their contents', async t => {
  const root = await fixture(t), file = await archive(root, [{ name: 'runtime/bin/node', executable: true, content: 'not executed' }, { name: 'runtime/lib/module.js', content: 'not executed either' }]), extracted = path.join(root, 'extracted'), ready = path.join(root, 'ready');
  assert.equal(JSON.parse((await run('extract', file, extracted, 'runtime', '10000')).stdout).ok, true);
  assert.equal(JSON.parse((await run('promote', path.join(extracted, 'runtime'), ready, root, '10000')).stdout).ok, true);
  assert.equal(await fs.readFile(path.join(ready, 'bin/node'), 'utf8'), 'not executed');
  if (process.platform !== 'win32') for (const filename of [ready, path.join(ready, 'bin'), path.join(ready, 'lib')]) assert.equal((await fs.stat(filename)).mode & 0o777, 0o755, 'promoted directories must remain traversable under service UMask=0077');
});
test('traversal, absolute members, link ancestors, escaping symlinks, hardlinks, duplicate members and expansion overflow fail before extraction', async t => {
  const rows = [
    [{ name: 'runtime/../outside' }], [{ name: '/runtime/absolute' }], [{ name: 'different/file' }],
    [{ name: 'runtime/link', type: 'symlink', target: '../../outside' }],
    [{ name: 'runtime/link', type: 'symlink', target: 'safe' }, { name: 'runtime/link/child' }],
    [{ name: 'runtime/hard', type: 'hardlink', target: 'runtime/original' }],
    [{ name: 'runtime/file' }, { name: 'runtime/file' }], [{ name: 'runtime/file', content: 'x'.repeat(101) }],
  ];
  for (let index = 0; index < rows.length; index++) { const root = await fixture(t), file = await archive(root, rows[index]), extracted = path.join(root, 'extracted'); await assert.rejects(run('extract', file, extracted, 'runtime', '100')); await assert.rejects(fs.lstat(extracted), { code: 'ENOENT' }); }
});
test('promotion rejects a top-level source link and an ancestor link before copying any outside file', async t => {
  for (const mode of ['root', 'ancestor']) {
    const root = await fixture(t), outside = path.join(root, 'outside'), anchor = path.join(root, 'build'), destination = path.join(root, 'ready'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'must never be copied'); await fs.mkdir(anchor);
    let source;
    if (mode === 'root') { source = path.join(anchor, 'python'); await fs.symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir'); }
    else { const link = path.join(anchor, 'output'); await fs.mkdir(path.join(outside, 'python')); await fs.writeFile(path.join(outside, 'python/private.txt'), 'must never be copied'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); source = path.join(link, 'python'); }
    await assert.rejects(run('promote', source, destination, anchor, '10000')); await assert.rejects(fs.lstat(destination), { code: 'ENOENT' }); assert.equal(await fs.readFile(path.join(outside, 'private.txt'), 'utf8'), 'must never be copied');
  }
});
test('official Node internal npm symlink layout survives extraction and promotion while chained escapes are rejected', async t => {
  const root = await fixture(t), file = await archive(root, [{ name: 'runtime/lib/node_modules/npm/bin/npm-cli.js', content: 'trusted internal target' }, { name: 'runtime/bin/npm', type: 'symlink', target: '../lib/node_modules/npm/bin/npm-cli.js' }]), extracted = path.join(root, 'extracted'), ready = path.join(root, 'ready');
  if (process.platform === 'win32') {
    // Windows without SeCreateSymbolicLinkPrivilege cannot create POSIX file
    // links. Exercise the actual validator/extractor with that one primitive
    // modeled; the same test runs real links on Ubuntu, with no skip.
    const boundary = `import os, json, sys\nlinks=[]\ndef link(target, filename): links.append({'target':target,'filename':filename})\nos.symlink=link\n`;
    const program = boundary + helper.replace("print(json.dumps({'ok': True}))", "print(json.dumps({'ok': True, 'links': links}))");
    const result = await exec(python, ['-I', '-c', program, 'extract', file, extracted, 'runtime', '10000'], { timeout: 10000, maxBuffer: 65536, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout).links, [{ target: '../lib/node_modules/npm/bin/npm-cli.js', filename: path.join(extracted, 'runtime/bin/npm') }]); assert.equal(await fs.readFile(path.join(extracted, 'runtime/lib/node_modules/npm/bin/npm-cli.js'), 'utf8'), 'trusted internal target');
    t.diagnostic('Windows models only file-symlink creation; Ubuntu executes actual internal-link extraction/promotion.');
  } else {
    await run('extract', file, extracted, 'runtime', '10000'); await run('promote', path.join(extracted, 'runtime'), ready, root, '10000');
    assert.equal(await fs.readFile(path.join(ready, 'bin/npm'), 'utf8'), 'trusted internal target');
  }
  const escapeRoot = await fixture(t), escape = await archive(escapeRoot, [{ name: 'runtime/a', type: 'symlink', target: 'b' }, { name: 'runtime/b', type: 'symlink', target: '../../outside' }]);
  await assert.rejects(run('extract', escape, path.join(escapeRoot, 'extracted'), 'runtime', '10000'));
});
