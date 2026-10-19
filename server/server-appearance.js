import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { fail, safePath } from './safety.js';

// Appearance is panel data, outside the process-writable run directory. BDS
// exposes server-name; partner-server artwork is not a BDS server property.
export const APPEARANCE_LIMITS = Object.freeze({ description: 320, iconBytes: 2 * 1024 ** 2, coverBytes: 6 * 1024 ** 2, iconDimension: 2048, coverDimension: 4096, pixels: 16 * 1024 ** 2 });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const slots = new Set(['icon', 'cover']);
const types = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' });
const digest = value => createHash('sha256').update(value).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const issue = (code, en, vi, status = 400) => { const error = Object.assign(new Error(en), { code, status, errorI18n: { id: `panel.appearance.${code.toLowerCase()}`, en, vi, params: [] } }); throw error; };
const invalid = () => issue('APPEARANCE_IMAGE', 'Choose a valid, non-animated PNG, JPEG or WebP image.', 'Chọn ảnh PNG, JPEG hoặc WebP hợp lệ, không có chuyển động.');
const conflict = () => issue('APPEARANCE_CONFLICT', 'Appearance changed. Reload before saving again.', 'Giao diện máy chủ đã thay đổi. Tải lại trước khi lưu. ', 409);
export function appearanceErrorPayload(error, language = 'en') {
  const metadata = error?.errorI18n;
  if (!/^APPEARANCE_(?:IMAGE|DIMENSIONS|SIZE|DESCRIPTION|CONFLICT|BUSY|STORAGE)$/.test(error?.code || '') || typeof metadata?.en !== 'string' || typeof metadata.vi !== 'string') return null;
  return { error: metadata[language === 'vi' ? 'vi' : 'en'], code: error.code, errorI18n: metadata };
}
function slotName(slot) { if (!slots.has(slot)) fail('Invalid appearance image slot.', 400); return slot; }
function dimensions(width, height, slot) {
  const limit = slot === 'icon' ? APPEARANCE_LIMITS.iconDimension : APPEARANCE_LIMITS.coverDimension;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limit || height > limit || width * height > APPEARANCE_LIMITS.pixels) issue('APPEARANCE_DIMENSIONS', `Image dimensions must be between 1 and ${limit} pixels per side.`, `Mỗi cạnh ảnh phải từ 1 đến ${limit} pixel.`);
  return { width, height };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngImage(bytes, slot) {
  let cursor = 8, header, ended = false, hasData = false, dataEnded = false, palette = false, chunks = 0; const compressed = [];
  while (cursor < bytes.length) {
    if (++chunks > 8192 || cursor + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(cursor), end = cursor + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('ascii', cursor + 4, cursor + 8), content = bytes.subarray(cursor + 8, cursor + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(cursor + 4, cursor + 8 + length)) !== bytes.readUInt32BE(cursor + 8 + length)) invalid();
    if (!header && type !== 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(type)) invalid();
    if (type === 'IHDR') {
      if (header || length !== 13) invalid();
      header = { ...dimensions(content.readUInt32BE(0), content.readUInt32BE(4), slot), depth: content[8], color: content[9], interlace: content[12] };
      if (!({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[header.color] || []).includes(header.depth) || content[10] !== 0 || content[11] !== 0 || ![0, 1].includes(header.interlace)) invalid();
    } else if (type === 'PLTE') { if (palette || hasData || !length || length % 3 || length > 768 || [0, 4].includes(header.color)) invalid(); palette = true; }
    else if (type === 'IDAT') { if (dataEnded || header.color === 3 && !palette) invalid(); hasData = true; compressed.push(content); }
    else { if (hasData) dataEnded = true; if (type === 'IEND') { if (length || !hasData || end !== bytes.length) invalid(); ended = true; } else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') invalid(); }
    cursor = end;
  }
  if (!header || !ended) invalid();
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color], row = Math.ceil(header.width * channels * header.depth / 8);
  let raw;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: Math.min(64 * 1024 ** 2, (row + 8) * (header.height + 16) + 8192) }); } catch { invalid(); }
  if (!header.interlace) {
    if (raw.length !== (row + 1) * header.height) invalid();
    for (let offset = 0; offset < raw.length; offset += row + 1) if (raw[offset] > 4) invalid();
  } else if (!raw.length) invalid();
  return { width: header.width, height: header.height, extension: 'png' };
}
function jpegImage(bytes, slot) {
  let cursor = 2, size, scan = false, ended = false, segments = 0;
  while (cursor < bytes.length) {
    if (++segments > 200000 || bytes[cursor++] !== 0xff) invalid();
    while (bytes[cursor] === 0xff) cursor++;
    const marker = bytes[cursor++];
    if (marker === 0xd9) { if (cursor !== bytes.length || !scan || !size) invalid(); ended = true; break; }
    if (!marker || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || cursor + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(cursor), end = cursor + length;
    if (length < 2 || end > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size || length < 8 || bytes[cursor + 2] !== 8) invalid();
      size = dimensions(bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3), slot);
      const components = bytes[cursor + 7]; if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid();
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid();
    cursor = end;
    if (marker === 0xda) {
      if (!size || length < 6) invalid(); scan = true;
      while (cursor < bytes.length) { if (bytes[cursor] !== 0xff) { cursor++; continue; } const next = bytes[cursor + 1]; if (next === 0 || next >= 0xd0 && next <= 0xd7) { cursor += 2; continue; } if (next === 0xff) { cursor++; continue; } break; }
    }
  }
  if (!ended) invalid();
  return { ...size, extension: 'jpg' };
}
function webpImage(bytes, slot) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let cursor = 12, extended, size, chunks = 0;
  while (cursor < bytes.length) {
    if (++chunks > 32 || cursor + 8 > bytes.length) invalid();
    const type = bytes.toString('ascii', cursor, cursor + 4), length = bytes.readUInt32LE(cursor + 4), start = cursor + 8, end = start + length;
    if (end + (length & 1) > bytes.length || ['ANIM', 'ANMF'].includes(type)) invalid();
    if (type === 'VP8X') { if (cursor !== 12 || length !== 10 || bytes[start] & 0xc3 || bytes.subarray(start + 1, start + 4).some(Boolean)) invalid(); extended = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3), slot); }
    else if (type === 'VP8 ') { if (size || length < 10 || bytes[start] & 1 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) invalid(); size = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff, slot); }
    else if (type === 'VP8L') { if (size || length < 5 || bytes[start] !== 0x2f || bytes[start + 4] & 0xe0) invalid(); const bits = bytes.readUInt32LE(start + 1); size = dimensions(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff), slot); }
    else if (!extended || !['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(type)) invalid();
    cursor = end + (length & 1);
  }
  if (!size || extended && (size.width !== extended.width || size.height !== extended.height)) invalid();
  return { ...size, extension: 'webp' };
}

export function inspectAppearanceImage(bytes, slot, mimeType) {
  slotName(slot);
  const limit = slot === 'icon' ? APPEARANCE_LIMITS.iconBytes : APPEARANCE_LIMITS.coverBytes;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) issue('APPEARANCE_SIZE', `Choose an image no larger than ${limit / 1024 ** 2} MiB.`, `Chọn ảnh không lớn hơn ${limit / 1024 ** 2} MiB.`, 413);
  let image;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) image = pngImage(bytes, slot);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) image = jpegImage(bytes, slot);
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') image = webpImage(bytes, slot);
  else invalid();
  const detected = types[image.extension];
  if (typeof mimeType !== 'string' || mimeType.split(';')[0].trim().toLowerCase() !== detected) invalid();
  return { ...image, mimeType: detected, bytes: bytes.length, sha256: digest(bytes) };
}

function mediaRecord(value, slot) {
  if (!value || !plain(value) || !HASH.test(value.sha256 || '') || types[value.extension] !== value.mimeType || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > (slot === 'icon' ? APPEARANCE_LIMITS.iconBytes : APPEARANCE_LIMITS.coverBytes)) return null;
  try { dimensions(value.width, value.height, slot); } catch { return null; }
  return { sha256: value.sha256, extension: value.extension, mimeType: value.mimeType, bytes: value.bytes, width: value.width, height: value.height };
}
export function publicServerAppearance(server) {
  const source = plain(server?.appearance) ? server.appearance : {};
  const description = typeof source.description === 'string' && source.description.length <= APPEARANCE_LIMITS.description && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(source.description) ? source.description : '';
  const value = { schema: 1, description, accent: /^#[a-f0-9]{6}$/i.test(source.accent || '') ? source.accent.toLowerCase() : '#a998ff', icon: mediaRecord(source.icon, 'icon'), cover: mediaRecord(source.cover, 'cover') };
  return { ...value, revision: digest(JSON.stringify(value)) };
}
export function validateAppearanceChanges(input, current) {
  if (!plain(input) || Object.keys(input).some(key => !['description', 'accent', 'revision'].includes(key)) || !Object.keys(input).some(key => key !== 'revision')) fail('Invalid appearance update.', 400);
  if (typeof input.revision !== 'string' || input.revision !== current.revision) conflict();
  const changes = {};
  if (input.description !== undefined) {
    if (typeof input.description !== 'string' || input.description.length > APPEARANCE_LIMITS.description || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input.description)) issue('APPEARANCE_DESCRIPTION', 'Use a plain description of up to 320 characters on one line.', 'Dùng miêu tả văn bản thuần, tối đa 320 ký tự trên một dòng.');
    changes.description = input.description.trim();
  }
  if (input.accent !== undefined) { if (typeof input.accent !== 'string' || !/^#[a-f0-9]{6}$/i.test(input.accent)) fail('Use a six-digit hexadecimal accent color.', 400); changes.accent = input.accent.toLowerCase(); }
  return { ...current, ...changes };
}

export function createServerAppearance({ dataDir, getServer, commit, emit = () => {} }) {
  if (typeof getServer !== 'function' || typeof commit !== 'function' || typeof dataDir !== 'string') throw Error('Invalid appearance controller context.');
  const locks = new Set();
  const get = id => { if (!UUID.test(id)) fail('Invalid appearance server identity.', 400); return getServer(id); };
  async function directory(id, create = false) {
    const serverRoot = await safePath(dataDir, `servers/${id}`);
    if (!(await fs.lstat(serverRoot)).isDirectory()) fail('Server appearance storage is unavailable.', 409);
    const result = await safePath(serverRoot, 'appearance', { allowMissing: create });
    if (create) await fs.mkdir(result, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(result); if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.uid !== process.getuid?.() || stat.mode & 0o022)) fail('Unsafe appearance directory.', 409);
    return result;
  }
  async function exclusive(id, callback) {
    get(id); if (locks.has(id)) issue('APPEARANCE_BUSY', 'An appearance change is in progress. Wait for it to finish.', 'Một thay đổi giao diện đang được xử lý. Đợi thao tác hoàn tất.', 409);
    locks.add(id); try { return await callback(); } finally { locks.delete(id); }
  }
  function requireRevision(input, value) { if (!plain(input) || Object.keys(input).some(key => key !== 'revision') || typeof input.revision !== 'string' || input.revision !== value.revision) conflict(); }
  async function save(server, value) {
    const appearance = { schema: 1, description: value.description, accent: value.accent, icon: value.icon, cover: value.cover };
    await commit(server, appearance);
    try { emit({ type: 'update' }); } catch {}
    return { appearance: publicServerAppearance(server) };
  }
  async function readFile(id, record) {
    const root = await directory(id), filename = await safePath(root, `${record.sha256}.${record.extension}`);
    const before = await fs.lstat(filename);
    if (!before.isFile() || before.nlink !== 1 || before.size !== record.bytes) fail('Appearance image is unavailable or changed.', 409);
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!same(before, await handle.stat())) fail('Appearance image changed.', 409);
      const content = await handle.readFile();
      if (!same(before, await handle.stat()) || !same(before, await fs.lstat(filename)) || content.length !== record.bytes || digest(content) !== record.sha256) fail('Appearance image changed.', 409);
      return content;
    } finally { await handle.close(); }
  }
  async function cleanup(id, record, next) {
    if (!record || [next.icon, next.cover].some(value => value?.sha256 === record.sha256)) return;
    try { await readFile(id, record); await fs.unlink(path.join(await directory(id), `${record.sha256}.${record.extension}`)); }
    catch (error) { if (!['ENOENT'].includes(error.code) && error.status !== 404) return 'The new appearance was saved, but an old image could not be removed. Review the managed appearance folder.'; }
  }
  async function assertRoom(root, additional) {
    let bytes = 0, count = 0;
    for (const name of await fs.readdir(root)) {
      const stat = await fs.lstat(path.join(root, name));
      if (!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('Appearance storage contains an unrecognized entry. Review it before uploading again.', 409);
      bytes += stat.size; count++;
    }
    if (count > 8 || bytes + additional > 20 * 1024 ** 2) issue('APPEARANCE_STORAGE', 'Old appearance images need to be reviewed before another upload. The existing images were kept.', 'Cần kiểm tra ảnh giao diện cũ trước khi tải thêm. Các ảnh hiện tại được giữ nguyên.', 409);
  }
  return {
    read(id) { return { appearance: publicServerAppearance(get(id)), limits: { ...APPEARANCE_LIMITS } }; },
    update: (id, input) => exclusive(id, async () => { const server = get(id); return save(server, validateAppearanceChanges(input, publicServerAppearance(server))); }),
    upload: (id, slot, bytes, mimeType, input) => exclusive(id, async () => {
      slotName(slot); const server = get(id), current = publicServerAppearance(server); requireRevision(input, current);
      const record = inspectAppearanceImage(bytes, slot, mimeType), root = await directory(id, true), filename = path.join(root, `${record.sha256}.${record.extension}`);
      await assertRoom(root, bytes.length);
      let created = false;
      try {
        let handle;
        try { handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); created = true; await handle.writeFile(bytes); await handle.sync(); }
        catch (error) { if (error.code !== 'EEXIST') throw error; await readFile(id, record); }
        finally { await handle?.close(); }
        get(id); const result = await save(server, { ...current, [slot]: record });
        const warning = await cleanup(id, current[slot], result.appearance); return warning ? { ...result, warnings: [warning] } : result;
      } catch (error) { if (created) await fs.unlink(filename).catch(() => {}); throw error; }
    }),
    remove: (id, slot, input) => exclusive(id, async () => {
      slotName(slot); const server = get(id), current = publicServerAppearance(server); requireRevision(input, current);
      const result = await save(server, { ...current, [slot]: null }), warning = await cleanup(id, current[slot], result.appearance);
      return warning ? { ...result, warnings: [warning] } : result;
    }),
    async media(id, slot) {
      slotName(slot); const value = publicServerAppearance(get(id)), record = value[slot]; if (!record) fail('Appearance image was not found.', 404);
      return { content: await readFile(id, record), mimeType: record.mimeType, revision: record.sha256, name: `${slot}.${record.extension}` };
    },
  };
}
