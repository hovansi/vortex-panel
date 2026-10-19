import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import archiver from 'archiver';

const ROOT_FILES = ['package.json', 'package-lock.json', 'README.md', '.gitignore', '.gitattributes', '.env.example'];
const OPTIONAL_FILES = ['LICENSE', 'LICENSE.md', 'NOTICE'];
const SOURCE_DIRECTORIES = ['server', 'public', 'deploy'];
const BUILD_FILES = ['scripts/check.js', 'scripts/package.js', 'scripts/release.js'];
const DOCUMENT_FILES = ['API.md', 'ASSETS.md', 'I18N.md', 'INSTALL.md', 'NODE-AGENT.md', 'NODE-PROVISIONING.md', 'NODES.md', 'ONLINE-BACKUPS.md', 'OPERATIONS.md', 'OPERATIONS-090.md', 'PANEL-UPDATES.md', 'SERVER-APPEARANCE.md', 'PORTS-0155.md', 'README.vi.md', 'RESOURCE-CONTROL.md', 'SERVER-MESSAGES.md', 'THIRD_PARTY.md', 'WORLDS.md', 'applications.md', 'publication.md'];
const PRIVATE_NAMES = new Set(['output', 'data', 'node_modules', '.playwright-cli', '__pycache__', 'coverage', '.git', '.env', 'vortex-access.json', 'live-client-api.py']);
const EXCLUDED_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.ds_store', 'thumbs.db']);
const EXCLUDED_SUFFIX = /(?:\.bk[^/]*|\.bak|\.backup|\.orig|~|\.tmp|\.log|\.pem|\.key|\.p12|\.pfx|\.pyc)$/i;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BOOTSTRAP_SENTINEL = "DEFAULT_REPOSITORY='@VORTEX_REPOSITORY@'";
const FIXED_DATE = new Date('1980-01-01T00:00:00.000Z');
const LIMITS = { files: 4096, fileBytes: 4 * 1024 ** 2, expandedBytes: 64 * 1024 ** 2, zipBytes: 32 * 1024 ** 2 };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const need = (value, code) => { if (!value) throw new Error(code); };
const same = (left, right) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);

export function assertProductionFiles(files) {
  const forbiddenPath = /(?:^|\/)(?:test|tests|fixtures|mocks|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[a-z]+$/i;
  const retiredMode = /\bdemo\b|\bdemo[A-Z_][A-Za-z0-9_]*\b|\bDEMO_MODE\b|\bsimulated\b|\bNODE_TEST_CONTEXT\b|\bVORTEX_TEST_[A-Z_]+\b/;
  for (const file of files) {
    need(!forbiddenPath.test(file.name), 'DEVELOPMENT_FILES_REFUSED');
    if (/^(?:server|public)\/.*\.(?:js|html|css|py)$/.test(file.name)) {
      const text = file.content.toString('utf8');
      need(!/\bdemo\b/i.test(text) && !retiredMode.test(text), 'NON_PRODUCTION_MODE_REFUSED: ' + file.name);
    }
  }
  const pkg = JSON.parse(files.find(file => file.name === 'package.json')?.content.toString('utf8') || '{}');
  need(!Object.hasOwn(pkg.scripts || {}, 'demo') && !Object.hasOwn(pkg.scripts || {}, 'test'), 'DEVELOPMENT_COMMANDS_REFUSED');
}

async function directory(filename) {
  const info = await fs.lstat(filename);
  need(info.isDirectory() && !info.isSymbolicLink(), 'SOURCE_DIRECTORY_MUST_BE_REGULAR');
}

async function sourceBytes(filename) {
  const before = await fs.lstat(filename);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= LIMITS.fileBytes, 'SOURCE_FILE_MUST_BE_BOUNDED_REGULAR');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    need(same(before, await handle.stat()), 'SOURCE_FILE_CHANGED');
    const bytes = await handle.readFile();
    need(bytes.length === before.size && same(before, await handle.stat()) && same(before, await fs.lstat(filename)), 'SOURCE_FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}

export async function collectPublicFiles(sourceRoot = process.cwd()) {
  const root = path.resolve(sourceRoot);
  await directory(root);
  need(path.resolve(await fs.realpath(root)) === root, 'CANONICAL_SOURCE_ROOT_REQUIRED');
  const files = [];
  const names = new Set();
  let bytes = 0;
  async function add(name) {
    need(!path.isAbsolute(name) && !/[\\:\0]/.test(name) && !name.split('/').some(part => part === '.' || part === '..'), 'SOURCE_PATH_UNSAFE');
    const filename = path.join(root, ...name.split('/'));
    const info = await fs.lstat(filename);
    need(!info.isSymbolicLink(), 'SOURCE_SYMLINK_REFUSED');
    if (info.isDirectory() && PRIVATE_NAMES.has(path.posix.basename(name).toLowerCase())) return;
    if (EXCLUDED_SUFFIX.test(path.posix.basename(name)) || EXCLUDED_NAMES.has(path.posix.basename(name).toLowerCase())) return;
    need(/^[A-Za-z0-9_.\/-]+$/.test(name), 'SOURCE_PATH_UNSAFE');
    need(!name.split('/').some(part => PRIVATE_NAMES.has(part.toLowerCase())), 'PRIVATE_SOURCE_ENTRY_REFUSED');
    if (info.isDirectory()) {
      for (const entry of (await fs.readdir(filename)).sort()) await add(`${name}/${entry}`);
      return;
    }
    need(info.isFile(), 'SOURCE_SPECIAL_ENTRY_REFUSED');
    const workflow = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml$/.test(name);
    need(ROOT_FILES.includes(name) || workflow || !name.split('/').some(part => part.startsWith('.')), 'UNEXPECTED_HIDDEN_SOURCE_ENTRY');
    if (name.startsWith('.github/')) need(workflow, 'UNEXPECTED_WORKFLOW_ENTRY');
    need(!names.has(name.toLowerCase()), 'SOURCE_CASE_COLLISION');
    names.add(name.toLowerCase());
    const content = await sourceBytes(filename);
    bytes += content.length;
    need(files.length < LIMITS.files && bytes <= LIMITS.expandedBytes, 'PUBLIC_SOURCE_BOUND');
    files.push({ name, content, bytes: content.length, sha256: sha256(content), mode: name.startsWith('deploy/') && name.endsWith('.sh') ? 0o100755 : 0o100644 });
  }
  for (const name of ROOT_FILES) await add(name);
  for (const name of OPTIONAL_FILES) {
    try { await fs.lstat(path.join(root, name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await add(name);
  }
  for (const name of SOURCE_DIRECTORIES) { await directory(path.join(root, name)); await add(name); }
  await directory(path.join(root, 'scripts'));
  await directory(path.join(root, 'docs'));
  for (const name of [...BUILD_FILES, ...DOCUMENT_FILES.map(name => `docs/${name}`)]) await add(name);
  await directory(path.join(root, 'docs/assets'));
  await add('docs/assets');
  try {
    await fs.lstat(path.join(root, '.github'));
    await directory(path.join(root, '.github'));
    await directory(path.join(root, '.github/workflows'));
    await add('.github/workflows');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  assertProductionFiles(files);
  return files;
}

export async function buildZip(destination, files) {
  const handle = await fs.open(destination, 'wx', 0o644);
  const output = handle.createWriteStream();
  const zip = archiver('zip', { store: true, forceLocalTime: false });
  const done = new Promise((resolve, reject) => {
    output.once('close', resolve); output.once('error', reject);
    zip.once('error', reject); zip.once('warning', reject);
  });
  zip.pipe(output);
  for (const file of files) zip.append(file.content, { name: file.name, date: FIXED_DATE, mode: file.mode });
  try { await Promise.all([zip.finalize(), done]); } catch (error) { zip.abort(); output.destroy(); throw error; }
  const info = await fs.stat(destination);
  need(info.isFile() && info.size <= LIMITS.zipBytes, 'PUBLIC_ZIP_BOUND');
  return { bytes: info.size, sha256: sha256(await fs.readFile(destination)) };
}

async function newOutput(root, requested) {
  const destination = path.resolve(root, requested);
  const relative = path.relative(root, destination);
  need(relative && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative.split(path.sep)[0] === 'output' && relative.split(path.sep).length > 1, 'RELEASE_OUTPUT_MUST_BE_NEW_CHILD_OF_OUTPUT');
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await directory(current);
  }
  await fs.mkdir(destination);
  await directory(destination);
  return destination;
}

export async function buildRelease({ root: sourceRoot = process.cwd(), repository, output } = {}) {
  need(typeof repository === 'string' && REPOSITORY.test(repository), 'EXPLICIT_GITHUB_REPOSITORY_REQUIRED');
  const root = path.resolve(sourceRoot);
  const files = await collectPublicFiles(root);
  const version = JSON.parse(files.find(file => file.name === 'package.json').content.toString('utf8')).version;
  need(typeof version === 'string' && version.length <= 64 && VERSION.test(version), 'STABLE_PACKAGE_VERSION_REQUIRED');
  const lock = JSON.parse(files.find(file => file.name === 'package-lock.json').content.toString('utf8'));
  need(lock.version === version && lock.packages?.['']?.version === version, 'LOCKFILE_VERSION_DIFFERS');
  const sourceBootstrap = files.find(file => file.name === 'deploy/bootstrap.sh');
  need(sourceBootstrap, 'BOOTSTRAP_SOURCE_REQUIRED');
  const source = sourceBootstrap.content.toString('utf8');
  need(source.split(BOOTSTRAP_SENTINEL).length === 2 && /^DEFAULT_REPOSITORY='@VORTEX_REPOSITORY@'\r?$/m.test(source), 'EXACT_BOOTSTRAP_SENTINEL_REQUIRED');
  const bootstrap = Buffer.from(source.replace(BOOTSTRAP_SENTINEL, `DEFAULT_REPOSITORY='${repository}'`));
  const destination = await newOutput(root, output || `output/release/v${version}`);
  const archiveName = `vortex-panel-${version}.zip`;
  const archive = await buildZip(path.join(destination, archiveName), files);
  await fs.writeFile(path.join(destination, 'install.sh'), bootstrap, { flag: 'wx', mode: 0o755 });
  const manifest = {
    schema: 1, name: 'vortex-panel', version, repository, tag: `v${version}`,
    archive: { name: archiveName, ...archive },
    bootstrap: { name: 'install.sh', bytes: bootstrap.length, sha256: sha256(bootstrap), repositoryBound: true },
    sourceFiles: files.length,
    inventory: files.map(({ name, bytes, sha256: hash, mode }) => ({ path: name, bytes, sha256: hash, mode })),
    reproducibility: { timestamp: FIXED_DATE.toISOString(), order: 'ascending ASCII path', modes: 'deploy shell scripts 0755; other files 0644', compression: 'stored (no compression)', sourceBytesPreserved: true },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(destination, 'release-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o644 });
  const sums = [[archiveName, archive.sha256], ['install.sh', sha256(bootstrap)], ['release-manifest.json', sha256(manifestBytes)]];
  await fs.writeFile(path.join(destination, 'SHA256SUMS'), sums.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, hash]) => `${hash}  ${name}\n`).join(''), { flag: 'wx', mode: 0o644 });
  return { version, repository, destination, files: files.length, archive: archiveName, archiveSHA256: archive.sha256 };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    need((key === '--repository' || key === '--output') && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--') && !(key.slice(2) in options), 'EXPECTED_REPOSITORY_AND_OPTIONAL_NEW_OUTPUT');
    options[key.slice(2)] = argv[index + 1];
  }
  return buildRelease(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
