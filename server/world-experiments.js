import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { BEDROCK_WORLD_LIMITS, inspectLevelDat, readBounded } from './bedrock-world-format.js';
import { atomicWrite, fail, safePath } from './safety.js';

// Canonical generated operation messages. Names, paths, native output and pack
// descriptions are opaque parameters; only explicitly nested errors translate.
export const WORLD_OPERATIONS_MESSAGES = Object.freeze([
  ['revision', 'Metadata world đã thay đổi. Tải lại thử nghiệm trước khi lưu.', 'World metadata changed. Reload the experiments before saving.'],
  ['name', 'Tên world không hợp lệ.', 'Invalid world name.'],
  ['compound', 'Trường experiments trong level.dat không phải Compound; chưa thay đổi dữ liệu.', 'The experiments field in level.dat is not a compound; no changes were made.'],
  ['flag-type', 'Thử nghiệm có kiểu native chưa được hỗ trợ; chưa thay đổi dữ liệu.', 'An experiment has an unsupported native type; no changes were made.'],
  ['history-type', 'Lịch sử thử nghiệm có kiểu native chưa được hỗ trợ; chưa thay đổi dữ liệu.', 'Experiment history has an unsupported native type; no changes were made.'],
  ['updated-size', 'level.dat sau cập nhật vượt giới hạn dung lượng metadata.', 'Updated level.dat exceeds the metadata size limit.'],
  ['missing', 'World này chưa có tệp level.dat.', 'This world does not have a level.dat file yet.'],
  ['size', 'level.dat vượt giới hạn dung lượng metadata.', 'level.dat exceeds the metadata size limit.'],
  ['running', 'Dừng server để đổi thử nghiệm; Bedrock ghi lại level.dat khi đang chạy.', 'Stop the server to change experiments; Bedrock rewrites level.dat while running.'],
  ['input', 'Cần revision metadata hiện tại và các cờ thử nghiệm boolean được nhận diện.', 'Provide the current metadata revision and recognized boolean experiment flags.'],
  ['unavailable', 'World/runtime đã cài không có thử nghiệm {0}.', 'The installed world/runtime does not expose experiment {0}.'],
  ['acknowledge', 'Xác nhận thử nghiệm có thể thay đổi vĩnh viễn khả năng tương thích của world trước khi bật.', 'Acknowledge that experiments can permanently change world compatibility before enabling them.'],
  ['backup-required', 'Cần bản backup world đã xác minh trước khi đổi thử nghiệm.', 'A verified world backup is required before changing experiments.'],
  ['backup-unverified', 'Đã hủy đổi thử nghiệm vì chưa xác nhận được bản backup đã xác minh.', 'The experiment change was cancelled because a verified backup could not be confirmed.'],
  ['changed-after-save', 'Metadata world thay đổi sau khi lưu; giữ backup để khôi phục thủ công.', 'World metadata changed after saving; preserve the backup for manual recovery.'],
  ['inspect', 'Đang kiểm tra tính năng thử nghiệm của world', 'Inspecting world experimental features'],
  ['prepare-backup', 'Đang tạo backup đã xác minh trước khi đổi thử nghiệm', 'Creating a verified backup before changing world experiments'],
  ['backup-progress', 'Đang sao lưu world trước khi đổi thử nghiệm', 'Backing up the world before experimental changes'],
  ['manager-stopped', 'Dừng server trước khi đổi thử nghiệm của world.', 'Stop the server before changing world experiments.'],
  ['library-transition', 'Chờ server hoàn tất khởi động hoặc dừng trước khi quản lý thư viện world.', 'Wait until the server has finished starting or stopping before managing its world library.'],
  ['export-session', 'Phiên server đã thay đổi trong lúc xuất world.', 'The server session changed while exporting the world.'],
  ['pack-session', 'Phiên server đã thay đổi trong lúc quản lý Add-on.', 'The server session changed while managing add-ons.'],
  ['export-cancelled', 'Đã hủy xuất world.', 'World export was cancelled.'],
  ['export-storage', 'Không đủ dung lượng trống của server để xuất world nhất quán.', 'Insufficient free server storage for a consistent world export.'],
  ['export-resume', 'Chưa xác minh được native đã tiếp tục lưu sau khi xuất world. Kiểm tra console và gửi save resume: {0}', 'World export could not verify that native saving resumed. Check the console and send save resume: {0}', { nested: [0] }],
  ['reused-pack', 'Đã dùng lại add-on đã cài có nội dung trùng khớp {0} ({1}); giữ nguyên thứ tự pack của world.', 'Reused identical installed add-on {0} ({1}); world pack order was preserved.'],
  ['pack-count', 'World chứa quá nhiều pack; giới hạn là 500 manifest.', 'The world contains too many packs. The limit is 500 manifests.'],
  ['script-outside', 'World chứa mã chạy ngoài Script API pack đã xác minh: {0}.', 'The world contains executable code outside a verified Script API pack: {0}.'],
  ['script-outside-generic', 'World chứa mã chạy ngoài Script API pack đã xác minh.', 'The world contains executable code outside a verified Script API pack.'],
  ['export-changed', 'Dữ liệu world hoặc add-on thay đổi trong lúc xuất; hãy thử lại.', 'World or add-on data changed during export. Try again.'],
  ['export-truncated', 'Dữ liệu world hoặc add-on bị rút ngắn trong lúc xuất.', 'World or add-on data was truncated during export.'],
  ['export-write', 'Không ghi được dữ liệu world tạm.', 'Temporary world data could not be written.'],
  ['compare-changed', 'Add-on thay đổi trong lúc so sánh dữ liệu world; hãy thử lại.', 'The add-on changed while comparing world data. Try again.'],
  ['compare-truncated', 'Add-on bị rút ngắn trong lúc so sánh dữ liệu world.', 'The add-on was truncated while comparing world data.'],
  ['global-root', 'Thư mục add-on dùng chung để nhập world không hợp lệ.', 'The shared add-on directory for world import is invalid.'],
  ['pack-folder', 'World chứa thư mục add-on không hợp lệ.', 'The world contains an invalid add-on directory.'],
  ['global-path', 'Đường dẫn add-on dùng chung không hợp lệ.', 'The shared add-on path is invalid.'],
  ['global-changed', 'Add-on dùng chung đã thay đổi; tải lại trước khi nhập world.', 'The shared add-on changed. Reload before importing the world.'],
  ['compare-limit', 'Dữ liệu so sánh add-on vượt giới hạn nhập world.', 'Add-on comparison data exceeds the world import limit.'],
  ['export-private', 'Dữ liệu xuất world tạm phải nằm ngoài thư mục server đang chạy.', 'Temporary world export data must stay outside the server runtime directory.'],
  ['export-distinct', 'Đường dẫn archive và dữ liệu world tạm phải khác nhau.', 'The archive and temporary world paths must be different.'],
  ['export-existing', 'Đường dẫn xuất world tạm đã tồn tại; hãy thử lại.', 'The temporary world export path already exists. Try again.'],
  ['export-world', 'Phiên thế giới đang chạy không khớp yêu cầu xuất world.', 'The running world session does not match the export request.'],
  ['global-export-path', 'Đường dẫn add-on dùng chung không hợp lệ; không xuất dữ liệu ngoài pack.', 'The shared add-on path is invalid. Data outside the pack cannot be exported.'],
  ['export-pack-changed', 'Add-on đã thay đổi trong lúc xuất world; hãy tải lại rồi thử lại.', 'The add-on changed during world export. Reload and try again.'],
  ['export-limit', 'World kèm add-on vượt giới hạn 2 GiB hoặc 50.000 mục.', 'The world and add-ons exceed 2 GiB or 50,000 entries.'],
  ['export-compress', 'Đang nén world Bedrock để tải xuống', 'Compressing the Bedrock world for download'],
  ['script-language', 'Script API chỉ hỗ trợ language=javascript.', 'Script API requires language=javascript.'],
  ['script-entry', 'Script entry cần là đường dẫn .js tương đối nằm trong pack.', 'The script entry must be a relative .js path inside the pack.'],
  ['script-entry-file', 'Script entry cần là tệp .js thông thường tối đa 16 MiB trong pack.', 'The script entry must be a regular .js file no larger than 16 MiB inside the pack.'],
  ['script-module', 'Module {0} chưa được hỗ trợ; chỉ hỗ trợ data/resources/script.', 'Module {0} is unsupported. Only data/resources/script modules are supported.'],
  ['script-module-missing', 'Module thiếu type; chỉ hỗ trợ data/resources/script.', 'The module type is missing. Only data/resources/script modules are supported.'],
  ['script-kind', 'Mỗi pack phải là behavior (data/script) hoặc resource, không trộn cả hai.', 'A pack must contain behavior (data/script) or resource modules, not both.'],
  ['script-dependency', 'Script dependency cần module_name @minecraft/* và phiên bản API cụ thể.', 'Script dependencies require an @minecraft/* module_name and an exact API version.'],
  ['order-input', 'Thứ tự pack cần loại hợp lệ, revision và danh sách UUID không trùng lặp.', 'Pack ordering requires a valid kind, revision and unique UUID list.'],
  ['order-stale', 'Danh sách pack đã thay đổi; tải lại trước khi sắp xếp.', 'The pack list changed. Reload before reordering.'],
  ['order-current', 'Danh sách pack hiện tại có UUID không hợp lệ hoặc trùng lặp; hãy sửa trước khi sắp xếp.', 'The current pack list has invalid or duplicate UUIDs. Repair it before reordering.'],
  ['order-permutation', 'Sắp xếp phải giữ nguyên toàn bộ pack đã đăng ký.', 'Reordering must preserve every registered pack.'],
  ['remove-snapshot-missing', 'Chưa có ảnh chụp pack khi khởi động; dừng máy chủ trước khi xóa Add-on.', 'The startup pack snapshot is unavailable. Stop the server before removing the add-on.'],
  ['remove-snapshot-invalid', 'Ảnh chụp pack khi khởi động không hợp lệ; dừng máy chủ trước khi xóa Add-on.', 'The startup pack snapshot is invalid. Stop the server before removing the add-on.'],
  ['remove-startup-registered', 'Pack đã được đăng ký khi tiến trình khởi động; dừng máy chủ trước khi xóa Add-on.', 'The pack was registered when this process started. Stop the server before removing the add-on.'],
  ['remove-world-invalid', 'Danh sách pack của world không hợp lệ; dừng máy chủ trước khi xóa Add-on.', 'A world pack list is invalid. Stop the server before removing the add-on.'],
  ['remove-world-registered', 'Pack còn được đăng ký cho một thế giới; dừng máy chủ trước khi xóa Add-on.', 'The pack is still registered for a world. Stop the server before removing the add-on.'],
  ['remove-dependants', 'Một pack đang bật còn phụ thuộc Add-on này; dừng máy chủ trước khi xóa.', 'An enabled pack still depends on this add-on. Stop the server before removing it.'],
  ['remove-path', 'Thư mục Add-on không hợp lệ.', 'The add-on directory is invalid.'],
  ['remove-stale', 'Danh sách pack đã thay đổi; tải lại hoặc dừng máy chủ trước khi xóa.', 'The pack list changed. Reload or stop the server before removing the add-on.'],
  ['remove-path-changed', 'Thư mục Add-on đã thay đổi; tải lại trước khi xóa.', 'The add-on directory changed. Reload before removing it.'],
  ['remove-recheck', 'Danh sách pack đã thay đổi; Add-on chưa được xóa.', 'The pack list changed. The add-on has not been removed.'],
  ['remove-rollback', 'Một thư mục khác đã xuất hiện tại vị trí Add-on; giữ bản cách ly để khôi phục thủ công.', 'Another directory appeared at the add-on path. Preserve the quarantined copy for manual recovery.'],
  ['remove-cleanup', 'Add-on đã được bỏ khỏi thư viện; chưa dọn xong thư mục cách ly.', 'The add-on was removed from the library, but its quarantined directory has not been fully removed.'],
  ['rollback', '; khôi phục metadata thất bại: {0}', '; metadata rollback failed: {0}', { fragment: true, nested: [0] }],
  ['export-cleanup', '; không dọn được dữ liệu xuất world tạm: {0}', '; temporary world export data could not be removed: {0}', { fragment: true, nested: [0] }],
].map(([id, vi, en, extra]) => Object.freeze({ id: `panel.world-operations.${id}`, vi, en, ...extra })));

// Display labels come from Microsoft's Experiments documentation. Internal names
// are accepted only when present in the installed BDS binary or current world;
// unknown native fields remain visible and byte-for-byte unchanged.
export const WORLD_EXPERIMENTS = Object.freeze([
  { id: 'gametest', name: 'Beta APIs', description: 'Allow beta Script API modules required by some behavior packs.' },
  { id: 'upcoming_creator_features', name: 'Upcoming Creator Features', description: 'Enable upcoming creator features used by supported add-ons.' },
  { id: 'data_driven_biomes', name: 'Custom Biomes', description: 'Allow behavior packs to provide custom biome and world-generation data.' },
  { id: 'experimental_molang_features', name: 'Experimental Molang Features', description: 'Enable experimental Molang queries and expressions.' },
  { id: 'experimental_creator_cameras', name: 'Experimental Creator Camera Features', description: 'Enable the experimental custom camera features.' },
  { id: 'jigsaw_structures', name: 'Data-Driven Jigsaw Structures', description: 'Load data-driven jigsaw structures from behavior packs.' },
  { id: 'experimental_villager_trade', name: 'Villager Trade Rebalancing', description: 'Use the experimental villager trading balance.' },
]);
const HISTORY_KEYS = new Set(['experiments_ever_used', 'saved_with_toggled_experiments']);
const HASH = /^[a-f0-9]{64}$/;
const known = new Map(WORLD_EXPERIMENTS.map(item => [item.id, item]));
const runtimeCache = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const changed = () => fail('Metadata world đã thay đổi. Tải lại thử nghiệm trước khi lưu.', 409);
const validWorld = name => {
  if (typeof name !== 'string' || !name || /[\\/:\0]/.test(name) || ['.', '..'].includes(name)) fail('Tên world không hợp lệ.');
  return name;
};

/** Validated little-endian NBT with exact raw ranges; opaque tags need no serializer. */
export function parseLevelDatTags(bytes) {
  const metadata = inspectLevelDat(bytes);
  let cursor = 8;
  const number = (method, count) => { const value = bytes[method](cursor); cursor += count; return value; };
  const text = () => { const count = number('readUInt16LE', 2), value = bytes.subarray(cursor, cursor + count).toString('utf8'); cursor += count; return value; };
  function payload(type, trace = true) {
    const result = {};
    switch (type) {
      case 1: result.value = number('readInt8', 1); break;
      case 2: result.value = number('readInt16LE', 2); break;
      case 3: result.value = number('readInt32LE', 4); break;
      case 4: result.value = number('readBigInt64LE', 8); break;
      case 5: result.value = number('readFloatLE', 4); break;
      case 6: result.value = number('readDoubleLE', 8); break;
      case 7: { const length = number('readInt32LE', 4); cursor += length; break; }
      case 8: result.value = text(); break;
      case 9: {
        const element = number('readUInt8', 1), length = number('readInt32LE', 4);
        for (let index = 0; index < length; index++) payload(element, false);
        break;
      }
      case 10: {
        if (trace) result.children = [];
        while (bytes[cursor] !== 0) { const child = named(trace); if (trace) result.children.push(child); }
        cursor++;
        break;
      }
      case 11: { const length = number('readInt32LE', 4); cursor += length * 4; break; }
      case 12: { const length = number('readInt32LE', 4); cursor += length * 8; break; }
    }
    return result;
  }
  function named(trace = true) {
    const start = cursor, type = number('readUInt8', 1), name = text(), payloadStart = cursor;
    const value = payload(type, trace);
    return { type, name, start, payloadStart, ...value, end: cursor };
  }
  return { metadata, formatVersion: bytes.readUInt32LE(0), root: named() };
}

function experimentCompound(parsed) {
  const tag = parsed.root.children.find(entry => entry.name === 'experiments');
  if (tag && tag.type !== 10) fail('Trường experiments trong level.dat không phải Compound; chưa thay đổi dữ liệu.', 409);
  return tag || null;
}
const namedByte = (name, enabled) => {
  const text = Buffer.from(name), header = Buffer.alloc(3);
  header[0] = 1; header.writeUInt16LE(text.length, 1);
  return Buffer.concat([header, text, Buffer.from([Number(enabled)])]);
};
const namedCompound = (name, children) => {
  const text = Buffer.from(name), header = Buffer.alloc(3);
  header[0] = 10; header.writeUInt16LE(text.length, 1);
  return Buffer.concat([header, text, ...children, Buffer.from([0])]);
};

/** Pure patch: only selected byte tags and sticky native history are replaced. */
export function patchLevelDatExperiments(bytes, flags) {
  const parsed = parseLevelDatTags(bytes), compound = experimentCompound(parsed), entries = compound?.children || [];
  const pending = new Map(Object.entries(flags)), enabling = [...pending.values()].some(value => value === true);
  const chunks = [];
  for (const entry of entries) {
    if (pending.has(entry.name)) {
      if (entry.type !== 1 || ![0, 1].includes(entry.value)) fail('Thử nghiệm có kiểu native chưa được hỗ trợ; chưa thay đổi dữ liệu.', 409);
      chunks.push(namedByte(entry.name, pending.get(entry.name))); pending.delete(entry.name);
    } else if (enabling && HISTORY_KEYS.has(entry.name)) {
      if (entry.type !== 1 || ![0, 1].includes(entry.value)) fail('Lịch sử thử nghiệm có kiểu native chưa được hỗ trợ; chưa thay đổi dữ liệu.', 409);
      chunks.push(namedByte(entry.name, true));
    } else chunks.push(bytes.subarray(entry.start, entry.end));
  }
  for (const [name, value] of pending) chunks.push(namedByte(name, value));
  if (enabling) for (const name of HISTORY_KEYS) if (!entries.some(entry => entry.name === name)) chunks.push(namedByte(name, true));
  const replacement = namedCompound('experiments', chunks);
  const payload = compound
    ? Buffer.concat([bytes.subarray(8, compound.start), replacement, bytes.subarray(compound.end)])
    : Buffer.concat([bytes.subarray(8, parsed.root.end - 1), replacement, bytes.subarray(parsed.root.end - 1)]);
  if (payload.length + 8 > BEDROCK_WORLD_LIMITS.levelBytes) fail('level.dat sau cập nhật vượt giới hạn dung lượng metadata.', 413);
  const header = Buffer.from(bytes.subarray(0, 8)); header.writeUInt32LE(payload.length, 4);
  const result = Buffer.concat([header, payload]);
  inspectLevelDat(result);
  return result;
}

/** Probe the exact installed binary, not a guessed table tied to version numbers. */
export async function probeWorldExperiments(runRoot) {
  let filename;
  try { filename = await safePath(runRoot, 'bedrock_server'); }
  catch (error) { if (error.status === 404) return []; throw error; }
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || before.size > 1024 ** 3) return [];
  const key = `${before.dev}:${before.ino}:${before.mtimeMs}:${before.size}`, cached = runtimeCache.get(filename);
  if (cached?.key === key) return [...cached.ids];
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const found = new Set(), needles = WORLD_EXPERIMENTS.map(({ id }) => ({ id, bytes: Buffer.from(`\0${id}\0`) }));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) changed();
    const chunk = Buffer.alloc(512 * 1024), tailLength = Math.max(...needles.map(item => item.bytes.length));
    let tail = Buffer.alloc(0), position = 0;
    while (position < before.size && found.size !== needles.length) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (!bytesRead) changed();
      position += bytesRead;
      const combined = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      for (const item of needles) if (!found.has(item.id) && combined.includes(item.bytes)) found.add(item.id);
      tail = Buffer.from(combined.subarray(Math.max(0, combined.length - tailLength)));
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) changed();
  } finally { await handle.close(); }
  const ids = [...found];
  if (runtimeCache.size > 128) runtimeCache.delete(runtimeCache.keys().next().value);
  runtimeCache.set(filename, { key, ids });
  return [...ids];
}

async function readWorld(runRoot, options) {
  const relative = `worlds/${validWorld(options.levelName)}/level.dat`;
  const filename = await safePath(runRoot, relative);
  const bytes = await readBounded(filename, BEDROCK_WORLD_LIMITS.levelBytes, 'World này chưa có tệp level.dat.', 'level.dat vượt giới hạn dung lượng metadata.');
  return { filename, bytes, revision: digest(bytes), parsed: parseLevelDatTags(bytes) };
}
const nativeFlags = parsed => {
  const compound = experimentCompound(parsed), result = new Map();
  for (const tag of compound?.children || []) result.set(tag.name, tag);
  return result;
};
function resultFor(loaded, options, supported) {
  const tags = nativeFlags(loaded.parsed), ids = new Set([...known.keys(), ...tags.keys()]);
  const experiments = [...ids].filter(id => !HISTORY_KEYS.has(id)).map(id => {
    const item = known.get(id), tag = tags.get(id), recognized = Boolean(item), valid = !tag || tag.type === 1 && [0, 1].includes(tag.value);
    const available = recognized && valid && (supported.has(id) || Boolean(tag));
    return { id, name: item?.name || id, description: item?.description || 'Native experiment preserved by the panel.', enabled: tag ? tag.type === 1 ? tag.value === 1 : null : false, recognized, available, editable: !options.running && available, source: tag ? 'world' : supported.has(id) ? 'installed-runtime' : 'unavailable', nativeType: tag?.type ?? null };
  });
  return { world: { name: options.levelName, exists: true }, revision: loaded.revision, source: 'level.dat', observedAt: new Date().toISOString(), running: Boolean(options.running), experiments, history: Object.fromEntries([...HISTORY_KEYS].map(name => [name, tags.get(name)?.value === 1])), appliesOn: 'next-world-load', restartRequired: true, backupRequired: true };
}

export async function inspectWorldExperiments(runRoot, options) {
  const supported = new Set(options.supportedKeys || await probeWorldExperiments(runRoot));
  let loaded;
  try { loaded = await readWorld(runRoot, options); }
  catch (error) {
    if (error.status === 404) return { world: { name: options.levelName, exists: false }, revision: null, source: 'level.dat', running: Boolean(options.running), experiments: [], appliesOn: 'next-world-load', restartRequired: true, backupRequired: true };
    throw error;
  }
  return resultFor(loaded, options, supported);
}

export async function saveWorldExperiments(runRoot, input, options) {
  if (options.running) fail('Dừng server để đổi thử nghiệm; Bedrock ghi lại level.dat khi đang chạy.', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'flags', 'acknowledgeExperimental'].includes(key)) || !HASH.test(input.revision || '') || !input.flags || typeof input.flags !== 'object' || Array.isArray(input.flags) || !Object.keys(input.flags).length || Object.keys(input.flags).length > WORLD_EXPERIMENTS.length || Object.entries(input.flags).some(([id, value]) => !known.has(id) || typeof value !== 'boolean') || input.acknowledgeExperimental !== undefined && typeof input.acknowledgeExperimental !== 'boolean') fail('Cần revision metadata hiện tại và các cờ thử nghiệm boolean được nhận diện.');
  const supported = new Set(options.supportedKeys || await probeWorldExperiments(runRoot)), loaded = await readWorld(runRoot, options);
  if (loaded.revision !== input.revision) changed();
  const current = resultFor(loaded, options, supported), flags = {};
  for (const [id, enabled] of Object.entries(input.flags)) {
    const item = current.experiments.find(row => row.id === id);
    if (!item?.available) fail(`World/runtime đã cài không có thử nghiệm ${id}.`, 409);
    if (item.enabled !== enabled) flags[id] = enabled;
  }
  if (!Object.keys(flags).length) return { ...current, changed: false, backup: null };
  if (Object.values(flags).some(Boolean) && input.acknowledgeExperimental !== true) fail('Xác nhận thử nghiệm có thể thay đổi vĩnh viễn khả năng tương thích của world trước khi bật.', 409);
  if (typeof options.beforeWrite !== 'function') fail('Cần bản backup world đã xác minh trước khi đổi thử nghiệm.', 409);
  const bytes = patchLevelDatExperiments(loaded.bytes, flags);
  const backup = await options.beforeWrite({ world: options.levelName, revision: loaded.revision });
  if (!backup || typeof backup !== 'object' || typeof backup.id !== 'string' || !backup.id || backup.integrity?.status !== 'verified' || !HASH.test(backup.sha256 || '')) fail('Đã hủy đổi thử nghiệm vì chưa xác nhận được bản backup đã xác minh.', 409);
  options.assertStopped?.();
  const latest = await readWorld(runRoot, options);
  if (latest.revision !== loaded.revision) changed();
  await atomicWrite(loaded.filename, bytes);
  try { await options.onCommit?.({ backup: backup.id, flags }); }
  catch (error) {
    try {
      const written = await readWorld(runRoot, options);
      if (written.revision !== digest(bytes)) fail('Metadata world thay đổi sau khi lưu; giữ backup để khôi phục thủ công.', 409);
      await atomicWrite(loaded.filename, loaded.bytes);
    } catch (rollback) { error.message += `; khôi phục metadata thất bại: ${rollback.message}`; }
    throw error;
  }
  return { ...await inspectWorldExperiments(runRoot, { ...options, supportedKeys: [...supported] }), changed: true, backup, changedFlags: flags };
}
