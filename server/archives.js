import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, Writable } from 'node:stream';
import zlib from 'node:zlib';
import path from 'node:path';
import { pipeline, finished } from 'node:stream/promises';
import yauzl from 'yauzl';
import archiver from 'archiver';
import { cleanRelative, fail, safePath } from './safety.js';

// zlib.crc32 is native from Node 22.2; retain the Node 22.0/22.1 engine range.
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes, previous = 0) {
  if (zlib.crc32) return zlib.crc32(bytes, previous);
  let value = previous ^ 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function archiveName(input) {
  const relative = cleanRelative(input, { allowRoot: false });
  if (Buffer.byteLength(relative) > 4096 || relative.split('/').length > 128) fail('Đường dẫn ZIP quá dài hoặc quá sâu.');
  if (process.platform === 'win32' && relative.split('/').some(part => /[<>"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('ZIP có tên không hợp lệ trên filesystem Windows.');
  return relative;
}

function archiveError(error) {
  if (error.status) return error;
  // Restrict classification to yauzl format errors and corrupt DEFLATE data.
  // Filesystem errors (ENOENT, EACCES, ENOSPC, EIO, ...) stay server errors.
  const invalidPath = /^(?:invalid relative path|absolute path|invalid characters in fileName)/i.test(error.message || '');
  const invalidFormat = /^(?:Invalid comment length|invalid (?:zip64 end of central directory record|central directory file header|local file header) signature|multi-disk zip files|End of central directory record signature not found|strong encryption|zip64 extended information|unsupported compression method|entry is encrypted|file data overflows file bounds|unexpected EOF|extra field length exceeds|compressed\/uncompressed size mismatch|too many bytes in the stream|not enough bytes in the stream)/i.test(error.message || '');
  if ((!error.code && (invalidPath || invalidFormat)) || ['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(error.code)) {
    const detail = String(error.message).slice(0, 512);
    error.status = 400;
    error.message = invalidPath ? 'ZIP chứa đường dẫn không an toàn; không cho phép traversal hoặc đường dẫn tuyệt đối.' : `ZIP không hợp lệ hoặc chưa được hỗ trợ: ${detail}`;
  }
  return error;
}

async function processZip(archivePath, destination, { maxBytes = 2 * 1024 ** 3, maxEntries = 50000 } = {}) {
  if (destination !== null) {
    const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing?.isSymbolicLink()) fail('Không giải nén vào liên kết tượng trưng.', 403);
    await fs.mkdir(destination, { recursive: true });
  }
  const zip = await new Promise((resolve, reject) => yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(archiveError(error)) : resolve(value)));
  const logicalPaths = new Map();
  const types = new Map(), parents = new Set();
  let bytes = 0;
  let entries = 0;
  let fileCount = 0;
  return new Promise((resolve, reject) => {
    let done = false, active = null, currentStream = null;
    const abort = error => {
      if (done) return;
      done = true;
      currentStream?.destroy(error);
      zip.close();
      // A caller may remove its staging directory immediately after rejection.
      // Let the active writer finish closing before handing control back.
      Promise.resolve(active).catch(() => {}).then(() => reject(archiveError(error)));
    };
    zip.on('error', abort);
    zip.on('end', () => { if (!done) { done = true; resolve({ paths: [...logicalPaths.values()], entries: logicalPaths.size, files: fileCount, unpackedBytes: bytes }); } });
    zip.on('entry', entry => {
      const task = (async () => {
        const relative = archiveName(entry.fileName);
        const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
        const directory = entry.fileName.endsWith('/');
        if (++entries > maxEntries || types.has(key)) fail('ZIP có quá nhiều tệp hoặc đường dẫn trùng lặp.');
        if (!directory && parents.has(key)) fail('ZIP có xung đột tệp và thư mục.');
        const parts = key.split('/');
        for (let depth = 1; depth < parts.length; depth++) {
          const parent = parts.slice(0, depth).join('/');
          if (types.get(parent) === 'file') fail('ZIP có xung đột tệp và thư mục.');
          parents.add(parent);
          if (!logicalPaths.has(parent)) logicalPaths.set(parent, relative.split('/').slice(0, depth).join('/'));
          if (logicalPaths.size > maxEntries) fail('ZIP vượt giới hạn số tệp và thư mục, kể cả thư mục cha ngầm định.');
        }
        if (!logicalPaths.has(key)) logicalPaths.set(key, relative);
        if (logicalPaths.size > maxEntries) fail('ZIP vượt giới hạn số tệp và thư mục, kể cả thư mục cha ngầm định.');
        types.set(key, directory ? 'directory' : 'file');
        const mode = entry.externalFileAttributes >>> 16;
        const type = mode & 0o170000;
        if ((entry.generalPurposeBitFlag & 1) || type === 0o120000 || (type && type !== 0o100000 && type !== 0o040000)) fail('ZIP chứa tệp mã hóa, liên kết hoặc tệp đặc biệt.');
        if ((directory && type === 0o100000) || (!directory && (type === 0o040000 || (entry.externalFileAttributes & 0x10)))) fail('ZIP có loại tệp/thư mục không khớp đường dẫn.');
        if (directory && (entry.uncompressedSize !== 0 || entry.crc32 !== 0)) fail('ZIP có dữ liệu thư mục không hợp lệ.');
        bytes += entry.uncompressedSize;
        if (bytes > maxBytes || entry.uncompressedSize > maxBytes || (entry.compressedSize === 0 && entry.uncompressedSize > 0)) fail(`ZIP vượt quá giới hạn giải nén ${Math.floor(maxBytes / 1024 ** 2)} MiB.`);
        const target = destination === null ? null : await safePath(destination, relative, { allowMissing: true });
        if (done) return;
        if (directory) { if (target !== null) await fs.mkdir(target, { recursive: true }); }
        else {
          fileCount++;
          if (target !== null) await fs.mkdir(path.dirname(target), { recursive: true });
          if (done) return;
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          currentStream = stream;
          if (done) { stream.destroy(); return; }
          let streamed = 0, checksum = 0;
          const verify = new Transform({ transform(chunk, encoding, callback) {
            streamed += chunk.length;
            if (streamed > entry.uncompressedSize || streamed > maxBytes) return callback(Object.assign(new Error('ZIP vượt giới hạn kích thước.'), { status: 400 }));
            checksum = crc32(chunk, checksum); callback(null, chunk);
          } });
          const output = target === null ? new Writable({ write(chunk, encoding, callback) { callback(); } }) : createWriteStream(target, { flags: 'wx', mode: 0o600 });
          await pipeline(stream, verify, output);
          currentStream = null;
          if (streamed !== entry.uncompressedSize || checksum !== entry.crc32) fail(`ZIP hỏng: CRC-32 hoặc kích thước không khớp cho ${relative}.`);
        }
      })();
      active = task;
      task.then(() => { active = null; if (!done) zip.readEntry(); }, abort);
    });
    zip.readEntry();
  });
}

export async function extractZip(archivePath, destination, options) {
  return (await processZip(archivePath, destination, options)).paths;
}

// Validate every path and CRC through the same parser as extraction, without
// writing a second copy of a potentially large backup to the data volume.
export async function verifyZip(archivePath, options) {
  return processZip(archivePath, null, options);
}

export async function validateBedrockPackage(root) {
  const executable = path.join(root, 'bedrock_server');
  const stat = await fs.stat(executable).catch(() => null);
  if (!stat?.isFile() || stat.size < 1000) fail('ZIP phải chứa bedrock_server Linux ở thư mục gốc.');
  const handle = await fs.open(executable, 'r');
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) fail('Gói Bedrock phải là bản Linux x86-64 (ELF).');
  } finally { await handle.close(); }
  const properties = await fs.stat(path.join(root, 'server.properties')).catch(() => null);
  if (!properties?.isFile() || properties.size > 256 * 1024) fail('ZIP thiếu server.properties hợp lệ (tối đa 256 KiB).');
  await fs.chmod(executable, 0o700);
}

export async function zipDirectory(root, destination, { exclude = () => false, progress = () => {}, maxBytes = 2 * 1024 ** 3, maxEntries = 50000, includeEmptyDirectories = false, signal } = {}) {
  const files = [], directories = [];
  let bytes = 0, count = 0;
  const aborted = () => Object.assign(new Error('ZIP creation was cancelled.', { cause: signal?.reason }), { name: 'AbortError', code: 'ABORT_ERR', status: 499 });
  const check = () => { if (signal?.aborted) throw aborted(); };
  check();
  async function scan(relative = '', depth = 0) {
    check();
    if (depth > 128) fail('Thư mục ZIP quá sâu.');
    let children = 0;
    const handle = await fs.opendir(path.join(root, relative));
    for await (const entry of handle) {
      check();
      children++;
      const name = archiveName(relative ? `${relative}/${entry.name}` : entry.name);
      // Excluded dependency/cache trees must not be traversed: generated
      // environments can contain symlinks while source archives reject them.
      if (exclude(name)) continue;
      if (entry.isSymbolicLink()) fail('Server chứa liên kết tượng trưng; không thể nén an toàn.', 409);
      if (!entry.isFile() && !entry.isDirectory()) fail('Server chứa tệp đặc biệt; không thể nén an toàn.', 409);
      if (++count > maxEntries) fail(`Dữ liệu ZIP vượt giới hạn ${maxEntries} mục; mặc định 50.000 mục.`);
      if (entry.isDirectory()) await scan(name, depth + 1);
      else if (!exclude(name)) {
        const stat = await fs.stat(path.join(root, name)); check(); bytes += stat.size;
        if (bytes > maxBytes) fail(`Dữ liệu ZIP vượt giới hạn ${maxBytes} byte.`);
        files.push({ name, stat });
      }
    }
    check();
    if (!children && relative && includeEmptyDirectories && !exclude(relative)) directories.push(relative);
  }
  await scan(); check();
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const archive = archiver('zip', { zlib: { level: 6 } });
  let failure = null, input = null, rejectEntry = null;
  const stop = error => {
    if (failure) return;
    failure = error; rejectEntry?.(error);
    input?.destroy(); archive.abort(); archive.destroy(); output.destroy();
  };
  const closed = new Promise(resolve => output.once('close', () => {
    if (!output.writableFinished && !failure) stop(Object.assign(new Error('ZIP output closed before completion.'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    resolve();
  }));
  const checkWork = () => { if (failure) throw failure; check(); };
  const abort = () => stop(aborted());
  const report = ({ entries }) => {
    if (failure) return;
    try { progress(files.length + directories.length ? Math.round(entries.processed / (files.length + directories.length) * 90) : 90); }
    catch (error) { stop(error); }
  };
  output.on('error', stop); archive.on('error', stop); archive.on('warning', stop); archive.on('progress', report);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkWork(); archive.pipe(output);
    // Own one source stream at a time: aborting archiver alone deliberately
    // lets its active worker finish, which can keep compressing a large file.
    for (const file of files) {
      checkWork();
      input = createReadStream(path.join(root, file.name));
      const source = input, sourceClosed = new Promise(resolve => source.once('close', resolve));
      source.on('error', stop);
      let entry;
      const processed = new Promise((resolve, reject) => { entry = resolve; rejectEntry = reject; archive.once('entry', entry); });
      try {
        archive.append(source, { name: file.name, stats: file.stat });
        await processed; await sourceClosed; checkWork();
      } finally {
        archive.removeListener('entry', entry); rejectEntry = null;
        if (failure) source.destroy();
        await sourceClosed; source.removeListener('error', stop); input = null;
      }
    }
    for (let index = 0; index < directories.length; index++) {
      checkWork(); archive.append('', { name: directories[index] + '/', type: 'directory', mode: 0o700 });
      if (index % 128 === 127) { await new Promise(resolve => setImmediate(resolve)); checkWork(); }
    }
    checkWork();
    await Promise.race([archive.finalize(), closed]);
    await closed; checkWork();
  } catch (error) {
    stop(error); await closed; throw failure;
  } finally {
    signal?.removeEventListener('abort', abort); archive.removeListener('progress', report);
  }
}
