import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { NODE_INSTALLER_FILES, NODE_INSTALLER_OPTIONAL_FILES } from './node-runtime.js';
import { collectBedrockRuntimeBundle } from './bedrock-runtime-bundle.js';

export async function buildNodeBundle(projectDir, destination) {
  const root = await fs.realpath(projectDir), files = [];
  const bedrockAssets = await collectBedrockRuntimeBundle(root);
  let sourceBytes = 0;
  const add = async relative => {
    const filename = path.join(root, relative), stat = await fs.lstat(filename);
    // Every component must be real: lstat of only the leaf would still follow
    // a symlinked server/public/deploy parent into unrelated private files.
    let ancestor = path.dirname(filename);
    while (ancestor !== root) {
      const directory = await fs.lstat(ancestor);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Node bundle source directories must be real directories.');
      ancestor = path.dirname(ancestor);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 ** 2) throw new Error('Node bundle sources must be bounded regular files without links.');
    sourceBytes += stat.size;
    if (files.length >= 10000 || sourceBytes > 128 * 1024 ** 2) throw new Error('Node source bundle exceeds its safe size or entry limit.');
    files.push({ relative: relative.split(path.sep).join('/'), filename });
  };
  for (const relative of NODE_INSTALLER_FILES) await add(relative);
  for (const asset of bedrockAssets) {
    if (!NODE_INSTALLER_OPTIONAL_FILES.includes(asset.name)) throw new Error('Unexpected optional node installer asset.');
    sourceBytes += asset.bytes;
    if (files.length >= 10000 || sourceBytes > 128 * 1024 ** 2) throw new Error('Node source bundle exceeds its safe size or entry limit.');
    files.push({ relative: asset.name, content: asset.content });
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const filename = typeof destination === 'string' ? path.resolve(destination) : null;
  if (!filename && (!destination || typeof destination.write !== 'function')) throw new Error('A bundle destination path or writable stream is required.');
  const handle = filename ? await fs.open(filename, 'wx', 0o600) : null;
  const owned = handle ? await handle.stat() : null;
  const output = handle ? handle.createWriteStream() : destination;
  const archive = archiver('zip', { zlib: { level: 6 } }), hash = createHash('sha256'); let bytes = 0;
  const counter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  archive.on('warning', error => archive.destroy(error));
  const completed = pipeline(archive, counter, output);
  try {
    for (const file of files) {
      if (file.content) archive.append(file.content, { name: file.relative, mode: 0o100644 });
      else archive.file(file.filename, { name: file.relative });
    }
    await Promise.all([archive.finalize(), completed]);
    return { ...(filename ? { path: filename } : {}), bytes, sha256: hash.digest('hex'), files: files.length };
  } catch (error) {
    archive.abort(); archive.destroy(); await completed.catch(() => {});
    // A path is created exclusively by this call; pre-existing files are never
    // removed. The failed owned candidate is not a usable deployment archive.
    if (filename && owned) { const actual = await fs.lstat(filename).catch(() => null); if (actual?.isFile() && !actual.isSymbolicLink() && actual.ino === owned.ino && actual.dev === owned.dev) await fs.unlink(filename).catch(() => {}); }
    throw error;
  }
}
