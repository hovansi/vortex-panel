import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const BEDROCK_RUNTIME_BUNDLE_FILES = Object.freeze(['deploy/bedrock-box64-arm64.tar.xz', 'deploy/bedrock-box64-arm64.json']);
const ARCHIVE_LIMIT = 16 * 1024 ** 2, METADATA_LIMIT = 64 * 1024, HASH = /^[a-f0-9]{64}$/;
const SOURCE = Object.freeze({ commit: '2f130fab1d6e1a4ee8a71dc60cfdfcc839ad192a', sha256: 'ce844041092de3f44316bd1c033a3cc10024e5f798c1a8e8a58f046c6d967981' });
const BASELINE = Object.freeze({ os: 'ubuntu', version: '22.04', glibc: '2.35' });
const LICENSE = Object.freeze({ path: 'licenses/Box64-LICENSE', sha256: '18731c3637a3dfc5859be67db7d315d438c531396a4ed15a9c88421b520e7883' });
const need = (value, code) => { if (!value) throw new Error(code); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const same = (left, right) => ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => left[key] === right[key]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function bytesFrom(filename, maximum, before) {
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= maximum && (process.platform === 'win32' || !(before.mode & 0o022)), 'BEDROCK_BUNDLE_BOUNDED_REGULAR_FILE_REQUIRED');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    need(same(before, await handle.stat()), 'BEDROCK_BUNDLE_FILE_CHANGED');
    const content = Buffer.alloc(before.size); let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      need(bytesRead > 0, 'BEDROCK_BUNDLE_FILE_CHANGED'); offset += bytesRead;
    }
    need(content.length === before.size && same(before, await handle.stat()) && same(before, await fs.lstat(filename)), 'BEDROCK_BUNDLE_FILE_CHANGED');
    return content;
  } finally { await handle.close(); }
}

export async function collectBedrockRuntimeBundle(sourceRoot, { required = false } = {}) {
  need(typeof required === 'boolean', 'BEDROCK_BUNDLE_REQUIREMENT_INVALID');
  const root = path.resolve(sourceRoot), deploy = path.join(root, 'deploy');
  for (const directory of [root, deploy]) {
    const info = await fs.lstat(directory);
    need(info.isDirectory() && !info.isSymbolicLink() && path.resolve(await fs.realpath(directory)) === directory, 'BEDROCK_BUNDLE_CANONICAL_SOURCE_REQUIRED');
  }
  const stats = await Promise.all(BEDROCK_RUNTIME_BUNDLE_FILES.map(async name => {
    try { return await fs.lstat(path.join(root, name)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  if (stats.every(value => value === null)) { need(!required, 'BEDROCK_RUNTIME_BUNDLE_REQUIRED'); return []; }
  need(stats.every(Boolean), 'BEDROCK_RUNTIME_BUNDLE_PAIR_REQUIRED');
  const [archive, content] = await Promise.all(BEDROCK_RUNTIME_BUNDLE_FILES.map((name, index) => bytesFrom(path.join(root, name), index === 0 ? ARCHIVE_LIMIT : METADATA_LIMIT, stats[index])));
  let metadata;
  try { metadata = JSON.parse(content.toString('utf8')); } catch { throw new Error('BEDROCK_RUNTIME_BUNDLE_METADATA_INVALID'); }
  need(keys(metadata, ['schema', 'engine', 'version', 'hostArch', 'guestArch', 'pageSize', 'profile', 'source', 'baseline', 'archive', 'executable', 'license']) && metadata.schema === 1 && metadata.engine === 'box64' && metadata.version === '0.4.4' && metadata.hostArch === 'arm64' && metadata.guestArch === 'x64' && metadata.pageSize === 4096 && metadata.profile === 'generic-arm64-v1', 'BEDROCK_RUNTIME_BUNDLE_METADATA_INVALID');
  need(keys(metadata.source, Object.keys(SOURCE)) && Object.entries(SOURCE).every(([key, value]) => metadata.source[key] === value), 'BEDROCK_RUNTIME_BUNDLE_SOURCE_PIN_INVALID');
  need(keys(metadata.baseline, Object.keys(BASELINE)) && Object.entries(BASELINE).every(([key, value]) => metadata.baseline[key] === value), 'BEDROCK_RUNTIME_BUNDLE_BASELINE_INVALID');
  need(keys(metadata.executable, ['path', 'sha256']) && metadata.executable.path === 'bin/box64' && HASH.test(metadata.executable.sha256), 'BEDROCK_RUNTIME_BUNDLE_EXECUTABLE_INVALID');
  need(keys(metadata.license, Object.keys(LICENSE)) && Object.entries(LICENSE).every(([key, value]) => metadata.license[key] === value), 'BEDROCK_RUNTIME_BUNDLE_LICENSE_INVALID');
  need(keys(metadata.archive, ['name', 'bytes', 'sha256']) && metadata.archive.name === 'bedrock-box64-arm64.tar.xz' && Number.isSafeInteger(metadata.archive.bytes) && metadata.archive.bytes === archive.length && archive.length <= ARCHIVE_LIMIT && HASH.test(metadata.archive.sha256) && sha256(archive) === metadata.archive.sha256 && archive.subarray(0, 6).toString('hex') === 'fd377a585a00', 'BEDROCK_RUNTIME_BUNDLE_ARCHIVE_INVALID');
  return [archive, content].map((bytes, index) => ({ name: BEDROCK_RUNTIME_BUNDLE_FILES[index], content: bytes, bytes: bytes.length, sha256: sha256(bytes), mode: 0o100644 }));
}
