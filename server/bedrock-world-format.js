import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fail } from './safety.js';

// This validates the observed Bedrock disk layout, not LevelDB contents or game
// compatibility. The caller owns containment, stopped-server locking and packs.
// Format details are also implemented by community bedrock-level; native BDS
// archives are a separate verification source, not synthetic test fixtures.
export const BEDROCK_WORLD_LIMITS = Object.freeze({ levelBytes: 16 * 1024 ** 2, nbtDepth: 64, nbtTags: 100000, treeEntries: 50000, treeDepth: 128 });
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const metadataTypes = new Map([['LevelName', 8], ['StorageVersion', 3], ['RandomSeed', 4], ['LastPlayed', 4], ['lastOpenedWithVersion', 9], ['MinimumCompatibleClientVersion', 9]]);
const invalidNbt = () => fail('level.dat chứa dữ liệu NBT không hợp lệ, bị cắt ngắn hoặc chưa được hỗ trợ.');
const worldChanged = () => { throw Object.assign(new Error('Dữ liệu thế giới đã thay đổi trong lúc kiểm tra; hãy dừng server và thử lại.'), { status: 409, code: 'WORLD_METADATA_CHANGED' }); };

export function inspectLevelDat(bytes) {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) fail('Đây là dữ liệu thế giới Java; công cụ Worlds chỉ nhận thế giới Minecraft Bedrock.');
  if (bytes.length < 12 || bytes.length > BEDROCK_WORLD_LIMITS.levelBytes) fail('level.dat không có header Bedrock hợp lệ hoặc vượt giới hạn 16 MiB.');
  const formatVersion = bytes.readUInt32LE(0), declaredLength = bytes.readUInt32LE(4);
  if (!formatVersion || declaredLength !== bytes.length - 8) fail('Header hoặc kích thước dữ liệu level.dat không khớp.');
  let cursor = 8, tags = 0;
  const take = length => {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - cursor) invalidNbt();
    const start = cursor; cursor += length; return start;
  };
  const byte = () => bytes.readUInt8(take(1));
  const integer = () => bytes.readInt32LE(take(4));
  const text = () => {
    const length = bytes.readUInt16LE(take(2));
    const start = take(length);
    try { return decoder.decode(bytes.subarray(start, start + length)); } catch { invalidNbt(); }
  };
  const values = Object.create(null);
  function payload(type, depth, capture = false, root = false) {
    if (depth > BEDROCK_WORLD_LIMITS.nbtDepth || ++tags > BEDROCK_WORLD_LIMITS.nbtTags) fail('level.dat vượt giới hạn độ sâu hoặc số lượng thẻ NBT.');
    switch (type) {
      case 1: { const value = bytes.readInt8(take(1)); return capture ? value : undefined; }
      case 2: { const value = bytes.readInt16LE(take(2)); return capture ? value : undefined; }
      case 3: { const value = integer(); return capture ? value : undefined; }
      case 4: { const value = bytes.readBigInt64LE(take(8)); return capture ? value : undefined; }
      case 5: { const value = bytes.readFloatLE(take(4)); return capture ? value : undefined; }
      case 6: { const value = bytes.readDoubleLE(take(8)); return capture ? value : undefined; }
      case 7: { const length = integer(); take(length); return undefined; }
      case 8: { const value = text(); return capture ? value : undefined; }
      case 9: {
        const elementType = byte(), length = integer();
        if (length < 0 || elementType > 12 || (elementType === 0 && length !== 0)) invalidNbt();
        if (length > BEDROCK_WORLD_LIMITS.nbtTags - tags) fail('level.dat vượt giới hạn độ sâu hoặc số lượng thẻ NBT.');
        const keep = capture && elementType === 3 && length <= 16;
        const result = keep ? [] : undefined;
        for (let index = 0; index < length; index++) {
          const value = payload(elementType, depth + 1, keep);
          if (keep) result.push(value);
        }
        return result;
      }
      case 10: {
        const names = new Set();
        while (true) {
          const nextType = byte();
          if (nextType === 0) break;
          if (nextType > 12) invalidNbt();
          const name = text();
          if (names.has(name)) fail('level.dat chứa tên thẻ NBT trùng lặp.');
          names.add(name);
          const keep = root && metadataTypes.get(name) === nextType;
          const value = payload(nextType, depth + 1, keep);
          if (keep && value !== undefined) values[name] = value;
        }
        return undefined;
      }
      case 11: { const length = integer(); if (length < 0) invalidNbt(); take(length * 4); return undefined; }
      case 12: { const length = integer(); if (length < 0) invalidNbt(); take(length * 8); return undefined; }
      default: invalidNbt();
    }
  }
  if (byte() !== 10) fail('level.dat của Bedrock phải có thẻ NBT gốc dạng Compound.');
  text(); payload(10, 0, false, true);
  if (cursor !== bytes.length) fail('level.dat có dữ liệu thừa sau thẻ NBT gốc.');

  const result = { levelDatFormatVersion: formatVersion };
  if (typeof values.LevelName === 'string' && Buffer.byteLength(values.LevelName) <= 1024) result.name = result.displayName = values.LevelName;
  if (Number.isInteger(values.StorageVersion) && values.StorageVersion >= 0) result.storageVersion = values.StorageVersion;
  if (typeof values.RandomSeed === 'bigint') result.seed = values.RandomSeed.toString();
  if (typeof values.LastPlayed === 'bigint' && values.LastPlayed >= 0n && values.LastPlayed <= 8640000000000n) result.lastPlayed = new Date(Number(values.LastPlayed) * 1000).toISOString();
  for (const [field, output] of [['lastOpenedWithVersion', 'lastOpenedVersion'], ['MinimumCompatibleClientVersion', 'minimumCompatibleVersion']]) {
    const value = values[field];
    if (Array.isArray(value) && value.length && value.every(part => Number.isInteger(part) && part >= 0)) result[output] = value;
  }
  return result;
}

async function regularStat(filename, missingMessage) {
  let stat;
  try { stat = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') fail(missingMessage); throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Thế giới chứa liên kết tượng trưng, thư mục sai vị trí hoặc tệp đặc biệt.');
  return stat;
}

export async function readBounded(filename, maxBytes, missingMessage, limitMessage) {
  const before = await regularStat(filename, missingMessage);
  if (before.size > maxBytes) fail(limitMessage);
  // Explicit buffers keep reads bounded even if another process grows a file
  // between lstat and read. O_NOFOLLOW protects the leaf on supported systems.
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) worldChanged();
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs) worldChanged();
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

async function inspectTree(root) {
  let entries = 0, fileCount = 0, bytes = 0;
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.pop();
    for await (const entry of await fs.opendir(directory)) {
      if (++entries > BEDROCK_WORLD_LIMITS.treeEntries) fail('Thế giới vượt giới hạn 50.000 tệp và thư mục.');
      const absolute = path.join(directory, entry.name), stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail('Thế giới chứa liên kết tượng trưng, thư mục sai vị trí hoặc tệp đặc biệt.');
      if (stat.isDirectory()) {
        if (depth + 1 > BEDROCK_WORLD_LIMITS.treeDepth) fail('Cây thư mục thế giới vượt giới hạn độ sâu.');
        pending.push({ directory: absolute, depth: depth + 1 });
      } else {
        fileCount++; bytes += stat.size;
        if (!Number.isSafeInteger(bytes)) fail('Kích thước thế giới vượt giới hạn số nguyên an toàn.');
      }
    }
  }
  return { fileCount, entries, bytes, size: bytes };
}

/** Read-only inspection: bounded metadata parsing and on-disk LevelDB layout. */
export async function inspectBedrockWorld(root) {
  if (typeof root !== 'string' || !root || root.includes('\0')) fail('Đường dẫn thế giới không hợp lệ.');
  let stat;
  try { stat = await fs.lstat(root); } catch (error) { if (error.code === 'ENOENT') fail('Không tìm thấy thư mục thế giới Bedrock.'); throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Thư mục thế giới Bedrock không hợp lệ hoặc là liên kết tượng trưng.');
  const worldRoot = await fs.realpath(root);
  const tree = await inspectTree(worldRoot);
  const level = await readBounded(path.join(worldRoot, 'level.dat'), BEDROCK_WORLD_LIMITS.levelBytes, 'Thế giới thiếu level.dat của Minecraft Bedrock.', 'level.dat vượt giới hạn 16 MiB.');
  const metadata = inspectLevelDat(level);
  const database = path.join(worldRoot, 'db');
  const databaseStat = await fs.lstat(database).catch(error => { if (error.code === 'ENOENT') fail('Thế giới thiếu thư mục db của Minecraft Bedrock; thế giới Java không được hỗ trợ.'); throw error; });
  if (!databaseStat.isDirectory() || databaseStat.isSymbolicLink()) fail('Thư mục db của thế giới Bedrock không hợp lệ.');
  const current = await readBounded(path.join(database, 'CURRENT'), 128, 'Database Bedrock thiếu tệp db/CURRENT.', 'Tệp db/CURRENT vượt giới hạn kích thước.');
  const pointer = current.toString('ascii');
  if (!/^MANIFEST-\d{6,20}\r?\n?$/.test(pointer) || current.some(value => value > 127)) fail('Tệp db/CURRENT chứa tên MANIFEST không hợp lệ.');
  const manifest = await regularStat(path.join(database, pointer.replace(/\r?\n$/, '')), 'Database Bedrock thiếu tệp MANIFEST được CURRENT tham chiếu.');
  if (manifest.size === 0) fail('Tệp MANIFEST của database Bedrock không được rỗng.');
  let hasRecords = false;
  for await (const entry of await fs.opendir(database)) {
    const record = await fs.lstat(path.join(database, entry.name));
    if (!record.isFile() || record.isSymbolicLink()) fail('Database Bedrock chứa thư mục, liên kết hoặc tệp đặc biệt chưa được hỗ trợ.');
    if (/^\d{6,20}\.(?:ldb|sst|log)$/.test(entry.name) && record.size > 0) hasRecords = true;
  }
  if (!hasRecords) fail('Database Bedrock không có tệp dữ liệu .ldb, .sst hoặc .log hợp lệ.');
  return { ...metadata, ...tree, modified: stat.mtime.toISOString(), warnings: [], validation: 'bedrock-metadata-and-leveldb-layout' };
}
