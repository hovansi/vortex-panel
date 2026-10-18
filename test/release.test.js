import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import yauzl from 'yauzl';
import { buildRelease, collectPublicFiles, main } from '../scripts/release.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repository = 'ExampleOwner/vortex-panel';
const packageScript = fileURLToPath(new URL('../scripts/package.js', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-release-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('vortex-release-'));
    return fs.rm(root, { recursive: true, force: true });
  });
  for (const dir of ['server', 'public', 'deploy', 'scripts', 'docs', 'test', '.github/workflows']) await fs.mkdir(path.join(root, dir), { recursive: true });
  const files = {
    'package.json': JSON.stringify({ name: 'vortex-panel', version: '9.8.7' }),
    'package-lock.json': JSON.stringify({ name: 'vortex-panel', version: '9.8.7', packages: { '': { version: '9.8.7' } } }),
    'README.md': '# Public fixture\n', '.gitignore': 'output/\n.env\n', '.gitattributes': '* text=auto eol=lf\n', '.env.example': 'PORT=3000\n',
    'server/index.js': 'console.log("public fixture");\n', 'public/index.html': '<!doctype html><title>Fixture</title>\n',
    'deploy/bootstrap.sh': "#!/bin/bash\nDEFAULT_REPOSITORY='@VORTEX_REPOSITORY@'\nprintf '%s\\n' \"$DEFAULT_REPOSITORY\"\n",
    'deploy/install.sh': '#!/bin/bash\nexit 0\n', 'scripts/check.js': '// fixture\n', 'docs/OPERATIONS.md': '# Operations\n', 'test/fixture.test.js': '// fixture\n',
    '.github/workflows/ci.yml': 'name: Fixture\non: push\n',
  };
  await Promise.all(Object.entries(files).map(([name, content]) => fs.writeFile(path.join(root, name), content)));
  return root;
}
function entries(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const rows = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(rows));
      zip.on('entry', entry => zip.openReadStream(entry, (failure, stream) => {
        if (failure) return reject(failure);
        const chunks = [];
        stream.on('error', reject);
        stream.on('data', data => chunks.push(data));
        stream.on('end', () => { rows.push({ ...entry, content: Buffer.concat(chunks) }); zip.readEntry(); });
      }));
      zip.readEntry();
    });
  });
}

test('four public release assets have exact checksums, audited ZIP inventory and asset-only repository binding', async t => {
  const root = await fixture(t);
  const result = await buildRelease({ root, repository });
  assert.equal(result.version, '9.8.7');
  assert.deepEqual((await fs.readdir(result.destination)).sort(), ['SHA256SUMS', 'install.sh', 'release-manifest.json', 'vortex-panel-9.8.7.zip']);
  const manifest = JSON.parse(await fs.readFile(path.join(result.destination, 'release-manifest.json'), 'utf8'));
  const checksums = (await fs.readFile(path.join(result.destination, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n');
  assert.equal(checksums.length, 3);
  for (const line of checksums) {
    assert.match(line, /^[a-f0-9]{64}  [A-Za-z0-9.-]+$/);
    const [digest, name] = line.split('  ');
    assert.equal(hash(await fs.readFile(path.join(result.destination, name))), digest);
  }
  const rows = await entries(await fs.readFile(path.join(result.destination, result.archive)));
  assert.deepEqual(rows.map(row => row.fileName), manifest.inventory.map(row => row.path));
  for (const row of rows) {
    const recorded = manifest.inventory.find(item => item.path === row.fileName);
    assert.equal(hash(row.content), recorded.sha256);
    assert.equal(row.content.length, recorded.bytes);
    assert.equal(row.compressionMethod, 0);
    assert.equal(row.lastModFileDate, 33); // 1980-01-01 in DOS date format.
    assert.equal(row.lastModFileTime, 0);
    assert.equal((row.externalFileAttributes >>> 16) & 0o777, row.fileName.startsWith('deploy/') && row.fileName.endsWith('.sh') ? 0o755 : 0o644);
  }
  assert.match(rows.find(row => row.fileName === 'deploy/bootstrap.sh').content.toString(), /@VORTEX_REPOSITORY@/);
  assert.equal(manifest.bootstrap.name, 'install.sh');
  assert.match(await fs.readFile(path.join(result.destination, 'install.sh'), 'utf8'), /DEFAULT_REPOSITORY='ExampleOwner\/vortex-panel'/);
  assert.doesNotMatch(JSON.stringify(manifest), new RegExp(root.replaceAll('\\', '\\\\')));
});

test('source mtimes, filesystem permissions and excluded backups do not change any release bytes', async t => {
  const root = await fixture(t);
  const first = await buildRelease({ root, repository, output: 'output/first' });
  await fs.utimes(path.join(root, 'server/index.js'), new Date('2021-02-03T04:05:06Z'), new Date('2021-02-03T04:05:06Z'));
  await fs.chmod(path.join(root, 'server/index.js'), 0o755);
  for (const name of ['server/index.js.bk', 'docs/OPERATIONS.md.bk12', 'scripts/old.js.bk-snapshot', 'server/old.js.backup', 'server/draft.tmp', 'server/runtime.log', 'server/private.pem', 'server/private.key', 'server/private.p12', 'server/private.pfx', 'server/id_rsa', 'server/id_ed25519', 'server/old.orig', 'server/editor~', 'server/.DS_Store', 'server/generated.pyc']) await fs.writeFile(path.join(root, name), 'SYNTHETIC_PRIVATE_MUST_NOT_SHIP');
  await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_PRIVATE_MUST_NOT_SHIP');
  await fs.mkdir(path.join(root, 'deploy/__pycache__'));
  await fs.writeFile(path.join(root, 'deploy/__pycache__/generated.pyc'), 'SYNTHETIC_BYTECODE_MUST_NOT_SHIP');
  for (const name of ['output', 'data', 'node_modules', '.playwright-cli']) { await fs.mkdir(path.join(root, name), { recursive: true }); await fs.writeFile(path.join(root, name, 'private.fixture'), 'SYNTHETIC_PRIVATE_MUST_NOT_SHIP'); }
  const second = await buildRelease({ root, repository, output: 'output/second' });
  for (const name of await fs.readdir(first.destination)) assert.deepEqual(await fs.readFile(path.join(first.destination, name)), await fs.readFile(path.join(second.destination, name)), name);
  assert.ok((await collectPublicFiles(root)).every(file => !/\.bk|private\.fixture|^\.env$/.test(file.name)));
});

test('symlinks, nested private files, hardlinks and non-workflow GitHub entries fail before artifacts', async t => {
  for (const defect of ['symlink', 'private', 'hardlink', 'workflow', 'hidden', 'nested-github', 'hidden-workflow']) {
    const root = await fixture(t);
    if (defect === 'symlink') await fs.symlink(path.join(root, 'docs'), path.join(root, 'server/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    if (defect === 'private') await fs.writeFile(path.join(root, 'server/.env'), 'SYNTHETIC_PRIVATE');
    if (defect === 'hardlink') await fs.link(path.join(root, 'server/index.js'), path.join(root, 'server/linked.js'));
    if (defect === 'workflow') await fs.writeFile(path.join(root, '.github/workflows/credential.json'), '{}');
    if (defect === 'hidden') await fs.writeFile(path.join(root, 'server/.hidden'), '{}');
    if (defect === 'nested-github') { await fs.mkdir(path.join(root, 'server/.github')); await fs.writeFile(path.join(root, 'server/.github/file.js'), '{}'); }
    if (defect === 'hidden-workflow') await fs.writeFile(path.join(root, '.github/workflows/.hidden.yml'), '{}');
    await assert.rejects(buildRelease({ root, repository }), /SOURCE_SYMLINK_REFUSED|PRIVATE_SOURCE_ENTRY_REFUSED|SOURCE_FILE_MUST_BE_BOUNDED_REGULAR|UNEXPECTED_WORKFLOW_ENTRY|UNEXPECTED_HIDDEN_SOURCE_ENTRY/);
    await assert.rejects(fs.stat(path.join(root, 'output')), { code: 'ENOENT' });
  }
});

test('version, repository, bootstrap sentinel and output admission fail closed without overwriting an artifact', async t => {
  const root = await fixture(t);
  for (const value of [undefined, '../owner/repo', 'owner/repo;command', 'https://github.com/owner/repo', 'owner/repo\ncommand']) await assert.rejects(buildRelease({ root, repository: value }), /EXPLICIT_GITHUB_REPOSITORY_REQUIRED/);
  await assert.rejects(main(['--repository', repository, '--repository', repository]), /EXPECTED_REPOSITORY_AND_OPTIONAL_NEW_OUTPUT/);
  await assert.rejects(buildRelease({ root, repository, output: 'server/generated' }), /RELEASE_OUTPUT_MUST_BE_NEW_CHILD_OF_OUTPUT/);
  await fs.writeFile(path.join(root, 'deploy/bootstrap.sh'), "DEFAULT_REPOSITORY='missing-sentinel'\n");
  await assert.rejects(buildRelease({ root, repository }), /EXACT_BOOTSTRAP_SENTINEL_REQUIRED/);
  await fs.writeFile(path.join(root, 'deploy/bootstrap.sh'), "DEFAULT_REPOSITORY='@VORTEX_REPOSITORY@'\n");
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '9.8.6', packages: { '': { version: '9.8.6' } } }));
  await assert.rejects(buildRelease({ root, repository }), /LOCKFILE_VERSION_DIFFERS/);
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ version: '9.8.7', packages: { '': { version: '9.8.7' } } }));
  const built = await buildRelease({ root, repository });
  const archiveBefore = await fs.readFile(path.join(built.destination, built.archive));
  await assert.rejects(buildRelease({ root, repository }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(built.destination, built.archive)), archiveBefore);
});

test('legacy npm package shares the allowlist and refuses replacing its existing version archive', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'server/index.js.bk'), 'SYNTHETIC_BACKUP');
  const first = spawnSync(process.execPath, [packageScript], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(first.status, 0, first.stderr);
  const filename = path.join(root, 'output/vortex-panel-9.8.7.zip');
  const bytes = await fs.readFile(filename);
  const rows = await entries(bytes);
  assert.ok(rows.some(row => row.fileName === '.github/workflows/ci.yml'));
  assert.ok(rows.every(row => !/\.bk|^output\//.test(row.fileName)));
  const second = spawnSync(process.execPath, [packageScript], { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(second.status, 0);
  assert.deepEqual(await fs.readFile(filename), bytes);
});
