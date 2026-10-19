import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractZip, zipDirectory } from './archives.js';
import { inspectBedrockWorld } from './bedrock-world-format.js';
import { snapshotLiveServer } from './live-backup.js';
import { parsePackManifest, validatePackScriptEntries } from './packs.js';
import { fail, safePath, validateProperties } from './safety.js';

export const WORLD_LIMITS = Object.freeze({ compressedMB: 1024, unpackedMB: 2048, entries: 50000, maxWorlds: 100 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const executable = /\.(?:js|mjs|cjs|ts|tsx|jsx|wasm|exe|dll|so(?:\.\d+)*|sh|bash|bat|cmd|ps1|py|rb|php|pl)$/i;
const sameVersion = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 && a.every((value, index) => value === b[index]);

export function validateWorldName(input) {
  validateProperties({ 'level-name': input });
  if (typeof input !== 'string' || input !== input.trim() || Buffer.byteLength(input) > 255 || /[\x00-\x1f\x7f<>"|?*]/.test(input) || /[. ]$/.test(input) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input) || /^\.(?:vortex|world)-/i.test(input)) fail('Tên thế giới phải là tên thư mục hợp lệ, tối đa 255 byte và không có ký tự điều khiển.');
  return input;
}

export function validateWorldSeed(input = '') {
  if (typeof input !== 'string' || input !== input.trim() || Buffer.byteLength(input) > 2048 || /[\x00-\x1f\x7f]/.test(input)) fail('Seed phải là chuỗi tối đa 2048 byte, không có khoảng trắng đầu/cuối hoặc ký tự điều khiển.');
  return input;
}

async function jsonFile(root, relative, optional = false) {
  let file;
  try { file = await safePath(root, relative); }
  catch (error) { if (optional && error.status === 404) return null; throw error; }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 256 * 1024) fail(`${relative}: JSON của world phải là tệp thường không quá 256 KiB.`);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); let bytes;
  const unchanged = current => current.isFile() && current.nlink === 1 && current.dev === stat.dev && current.ino === stat.ino && current.size === stat.size && current.mtimeMs === stat.mtimeMs && current.ctimeMs === stat.ctimeMs;
  const changed = () => { throw Object.assign(new Error('Dữ liệu thế giới đã thay đổi trong lúc kiểm tra; hãy dừng server và thử lại.'), { status: 409, code: 'WORLD_METADATA_CHANGED' }); };
  try {
    if (!unchanged(await handle.stat())) changed();
    bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const read = await handle.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
    if (count !== stat.size || !unchanged(await handle.stat())) changed();
    bytes = bytes.subarray(0, count);
  } finally { await handle.close(); }
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(`${relative}: JSON của world không phải UTF-8 hợp lệ.`); }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { fail(`${relative}: JSON của world không hợp lệ.`); }
}

// Keep native data/resource/Script API bundles intact. Code is never executed by
// the panel; encrypted packs and host executables are rejected rather than lost.
async function inspectWorldPacks(root, { serverVersion, globalPacks = [] } = {}) {
  const embedded = [];
  for (const [kind, folder] of [['behavior', 'behavior_packs'], ['resource', 'resource_packs']]) {
    let directory;
    try { directory = await safePath(root, folder); }
    catch (error) { if (error.status === 404) continue; throw error; }
    if (!(await fs.lstat(directory)).isDirectory()) fail(`${folder}: thư mục pack của world không hợp lệ.`);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`${folder}/${entry.name}: mỗi pack của world phải là thư mục thông thường.`);
      if (embedded.length >= 500) fail('World chứa quá nhiều pack; giới hạn là 500 manifest.');
      const relative = `${folder}/${entry.name}`;
      const pack = parsePackManifest(await jsonFile(root, `${relative}/manifest.json`), { serverVersion });
      if (pack.errors.length) fail(`${relative}: pack của world không được hỗ trợ: ${pack.errors[0]}`);
      if (pack.kind !== kind) fail(`${relative}: loại pack không khớp thư mục world.`);
      await validatePackScriptEntries(root, relative, pack);
      embedded.push({ ...pack, folder: relative, embedded: true });
    }
  }
  const available = [...globalPacks, ...embedded];
  const globalIds = new Set(globalPacks.flatMap(pack => [pack.uuid, ...(pack.modules || []).map(module => module.uuid)]).filter(id => typeof id === 'string' && UUID.test(id)).map(id => id.toLowerCase()));
  const ids = new Set();
  for (const pack of embedded) {
    for (const id of [pack.uuid, ...pack.modules.map(module => module.uuid)]) {
      if (ids.has(id)) fail('World có UUID pack hoặc module bị trùng.');
      if (globalIds.has(id)) fail(`${pack.name}: UUID pack hoặc module của world trùng với pack dùng chung; không tự ghi đè hoặc bỏ pack.`);
      ids.add(id);
    }
  }
  const visiting = new Set(), visited = new Set(), requiredGlobalPacks = new Map();
  const globals = new Set(globalPacks);
  function check(pack) {
    if (visiting.has(pack.uuid)) fail('World chứa pack có vòng phụ thuộc; panel chưa hỗ trợ.');
    if (visited.has(pack.uuid)) return;
    if (pack.errors?.length) fail(`${pack.name}: pack của world không được hỗ trợ: ${pack.errors[0]}`);
    if (globals.has(pack)) requiredGlobalPacks.set(pack.uuid, pack);
    visiting.add(pack.uuid);
    for (const dependency of pack.dependencies || []) {
      if (dependency.module_name) continue;
      const matches = available.filter(item => item.uuid === dependency.uuid);
      if (matches.length !== 1 || !sameVersion(matches[0].version, dependency.version)) fail(`${pack.name}: world thiếu pack phụ thuộc đúng UUID và phiên bản.`);
      check(matches[0]);
    }
    visiting.delete(pack.uuid); visited.add(pack.uuid);
  }
  for (const pack of embedded) check(pack);
  let enabledPacks = 0;
  for (const kind of ['behavior', 'resource']) {
    const relative = `world_${kind}_packs.json`, references = await jsonFile(root, relative, true);
    if (references === null) continue;
    if (!Array.isArray(references) || references.length > 2000) fail(`${relative}: danh sách pack của world không hợp lệ.`);
    const referenced = new Set();
    for (const reference of references) {
      if (!reference || !UUID.test(reference.pack_id || '') || !Array.isArray(reference.version) || reference.version.length !== 3 || reference.version.some(value => !Number.isSafeInteger(value) || value < 0)) fail(`${relative}: tham chiếu pack của world không hợp lệ.`);
      const id = reference.pack_id.toLowerCase();
      if (referenced.has(id)) fail(`${relative}: tham chiếu pack của world bị trùng.`);
      referenced.add(id);
      const matches = available.filter(pack => pack.uuid === id && pack.kind === kind);
      if (matches.length !== 1 || !sameVersion(matches[0].version, reference.version)) fail(`${relative}: world thiếu pack đã đăng ký đúng UUID và phiên bản.`);
      check(matches[0]); enabledPacks++;
    }
  }
  return { embeddedPacks: embedded.length, enabledPacks, scriptFolders: embedded.filter(pack => pack.kind === 'behavior' && pack.scripting).map(pack => pack.folder), requiredGlobalPacks: [...requiredGlobalPacks.values()] };
}

async function inspectNames(root, relative = '', state = { entries: 0, bytes: 0, scriptFiles: [] }) {
  if (relative.split('/').length > 128) fail('World có đường dẫn quá sâu.');
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (++state.entries > WORLD_LIMITS.entries) fail('World vượt giới hạn 50.000 mục.');
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('World chứa liên kết hoặc tệp đặc biệt; thao tác bị từ chối.', 409);
    if (/^(?:keys|server_identity_key\.pem|bedrock_server(?:\.exe)?)$/i.test(entry.name) || (!relative && /^(?:server\.properties|allowlist\.json|permissions\.json)$/i.test(entry.name))) fail('Archive world chứa identity hoặc cấu hình server; hãy chỉ nhập dữ liệu world.');
    const nativeScript = entry.isFile() && entry.name.endsWith('.js');
    if (nativeScript) state.scriptFiles.push(name);
    if ((executable.test(entry.name) && !nativeScript) || /^(?:content\.key|contents\.json)$/i.test(entry.name)) fail(`World chứa mã chạy hoặc pack mã hóa chưa được hỗ trợ: ${name}.`);
    if (entry.isDirectory()) await inspectNames(root, name, state);
    else {
      if (entry.name === 'level.dat' && relative && (await fs.lstat(path.join(root, relative, 'db')).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.isDirectory()) fail('Archive chứa nhiều world; hãy nhập từng world riêng.');
      state.bytes += (await fs.lstat(path.join(root, name))).size;
      if (state.bytes > WORLD_LIMITS.unpackedMB * 1024 ** 2) fail('World vượt giới hạn dữ liệu 2 GiB.');
    }
  }
  return state;
}

export async function inspectSupportedWorld(root, options) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('World phải là thư mục thông thường.', 409);
  const [metadata, totals] = await Promise.all([inspectBedrockWorld(root), inspectNames(root)]);
  const packs = await inspectWorldPacks(root, options);
  const unsupported = totals.scriptFiles.find(name => !packs.scriptFolders.some(folder => name.startsWith(folder + '/')));
  if (unsupported) fail(`World chứa mã chạy ngoài Script API pack đã xác minh: ${unsupported}.`);
  return { metadata: { ...metadata, embeddedPacks: packs.embeddedPacks, enabledPacks: packs.enabledPacks }, size: totals.bytes, entries: totals.entries, modified: stat.mtime.toISOString(), warnings: [...(metadata.warnings || [])] };
}

async function planExportTree(root, guard) {
  const files = [], directories = []; let bytes = 0, entries = 0;
  async function scan(relative = '', depth = 0) {
    guard();
    if (depth > 128) fail('World có đường dẫn quá sâu.', 409);
    const folder = relative ? await safePath(root, relative) : root;
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('World chứa liên kết hoặc tệp đặc biệt; thao tác bị từ chối.', 409);
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (++entries > WORLD_LIMITS.entries) fail('World vượt giới hạn 50.000 mục.', 409);
      if (entry.isDirectory() && !entry.isSymbolicLink()) { directories.push(name); await scan(name, depth + 1); }
      else {
        const filename = await safePath(root, name), item = await fs.lstat(filename);
        if (!item.isFile() || item.isSymbolicLink() || item.nlink > 1) fail('World chứa liên kết hoặc tệp đặc biệt; thao tác bị từ chối.', 409);
        if ((bytes += item.size) > WORLD_LIMITS.unpackedMB * 1024 ** 2) fail('World vượt giới hạn dữ liệu 2 GiB.', 409);
        files.push({ relative: name, stat: item });
      }
    }
  }
  await scan(); return { root, files, directories, bytes, entries };
}

async function copyExportTree(plan, destination, guard) {
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  for (const name of plan.directories) { guard(); await fs.mkdir(path.join(destination, name), { mode: 0o700 }); }
  for (const file of plan.files) {
    guard(); const filename = await safePath(plan.root, file.relative);
    const input = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); let output;
    const unchanged = stat => stat.isFile() && stat.nlink === 1 && stat.ino === file.stat.ino && stat.dev === file.stat.dev && stat.size === file.stat.size && stat.mtimeMs === file.stat.mtimeMs && stat.ctimeMs === file.stat.ctimeMs;
    try {
      if (!unchanged(await input.stat())) fail('Dữ liệu world hoặc add-on thay đổi trong lúc xuất; hãy thử lại.', 409);
      output = await fs.open(path.join(destination, file.relative), 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(Math.min(1024 ** 2, Math.max(1, file.stat.size)));
      for (let offset = 0; offset < file.stat.size;) {
        guard(); const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.stat.size - offset), offset);
        if (!bytesRead) fail('Dữ liệu world hoặc add-on bị rút ngắn trong lúc xuất.', 409);
        let written = 0;
        while (written < bytesRead) { const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written); if (!bytesWritten) fail('Không ghi được dữ liệu world tạm.', 409); written += bytesWritten; }
        offset += bytesRead;
      }
      if (!unchanged(await input.stat())) fail('Dữ liệu world hoặc add-on thay đổi trong lúc xuất; hãy thử lại.', 409);
    } finally { try { await output?.close(); } finally { await input.close(); } }
  }
}

const packSignature = pack => JSON.stringify({ uuid: pack.uuid, kind: pack.kind, version: pack.version, modules: pack.modules, dependencies: pack.dependencies });
async function exportTreeDigest(plan) {
  const hash = createHash('sha256');
  for (const directory of [...plan.directories].sort()) hash.update(JSON.stringify(['directory', directory]) + '\n');
  for (const file of [...plan.files].sort((a, b) => a.relative.localeCompare(b.relative, 'en'))) {
    hash.update(JSON.stringify(['file', file.relative, file.stat.size]) + '\n');
    const input = await fs.open(await safePath(plan.root, file.relative), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const unchanged = stat => stat.isFile() && stat.nlink === 1 && stat.ino === file.stat.ino && stat.dev === file.stat.dev && stat.size === file.stat.size && stat.mtimeMs === file.stat.mtimeMs && stat.ctimeMs === file.stat.ctimeMs;
    try {
      if (!unchanged(await input.stat())) fail('Add-on thay đổi trong lúc so sánh dữ liệu world; hãy thử lại.', 409);
      const buffer = Buffer.allocUnsafe(Math.min(1024 ** 2, Math.max(1, file.stat.size)));
      for (let offset = 0; offset < file.stat.size;) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, file.stat.size - offset), offset);
        if (!bytesRead) fail('Add-on bị rút ngắn trong lúc so sánh dữ liệu world.', 409);
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (!unchanged(await input.stat())) fail('Add-on thay đổi trong lúc so sánh dữ liệu world; hãy thử lại.', 409);
    } finally { await input.close(); }
  }
  return hash.digest('hex');
}

async function assertExportPlanUnchanged(plan) {
  const observed = await planExportTree(plan.root, () => {});
  const signature = value => JSON.stringify({ directories: [...value.directories].sort(), files: value.files.map(file => [file.relative, file.stat.dev, file.stat.ino, file.stat.size, file.stat.mtimeMs, file.stat.ctimeMs]).sort((a, b) => a[0].localeCompare(b[0], 'en')) });
  if (signature(observed) !== signature(plan)) fail('Add-on thay đổi trong lúc so sánh dữ liệu world; hãy thử lại.', 409);
}

// Import-only normalization of a private staging tree. A portable .mcworld may
// embed the exact global packs already installed on this server. Reuse those
// only after every file/empty directory matches; differing or ambiguous UUIDs
// still fail ordinary world validation. Live/global data is never rewritten.
async function reuseIdenticalImportedPacks(root, options) {
  if (!path.isAbsolute(options.globalRoot || '') || path.resolve(options.globalRoot) === path.resolve(root)) fail('Thư mục add-on dùng chung để nhập world không hợp lệ.', 409);
  // Validate the complete untrusted archive before normalization can remove a
  // candidate folder. This retains encryption/host-code/identity rejections and
  // does not turn malformed pack data into a generic missing-manifest error.
  await inspectNames(root);
  const reused = [], pending = [], importedIds = new Set(); let bytes = 0, entries = 0, packs = 0;
  for (const kind of ['behavior', 'resource']) {
    let collection;
    try { collection = await safePath(root, `${kind}_packs`); }
    catch (error) { if (error.status === 404) continue; throw error; }
    for (const entry of await fs.readdir(collection, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail('World chứa thư mục add-on không hợp lệ.', 409);
      if (++packs > 500) fail('World chứa quá nhiều pack; giới hạn là 500 manifest.', 409);
      const relative = `${kind}_packs/${entry.name}`, imported = parsePackManifest(await jsonFile(root, `${relative}/manifest.json`), options);
      for (const id of [imported.uuid, ...imported.modules.map(module => module.uuid)].filter(Boolean)) {
        if (importedIds.has(id)) fail('World có UUID pack hoặc module bị trùng.', 409);
        importedIds.add(id);
      }
      const matches = (options.globalPacks || []).filter(pack => pack.uuid === imported.uuid);
      if (matches.length !== 1 || imported.errors.length) continue;
      const global = matches[0];
      if (global.errors?.length || global.kind !== kind || !sameVersion(global.version, imported.version)) continue;
      if (typeof global.folder !== 'string' || !global.folder.startsWith(`${kind}_packs/`) || global.folder.split('/').length !== 2) fail('Đường dẫn add-on dùng chung không hợp lệ.', 409);
      const current = parsePackManifest(await jsonFile(options.globalRoot, `${global.folder}/manifest.json`), options);
      if (current.errors.length || packSignature(current) !== packSignature(global)) fail('Add-on dùng chung đã thay đổi; tải lại trước khi nhập world.', 409);
      const importedRoot = await safePath(root, relative), globalRoot = await safePath(options.globalRoot, global.folder);
      await validatePackScriptEntries(root, relative, imported);
      const candidateNames = await inspectNames(importedRoot);
      if (candidateNames.scriptFiles.length && !(kind === 'behavior' && imported.scripting)) fail('World chứa mã chạy ngoài Script API pack đã xác minh.', 409);
      const candidate = await planExportTree(importedRoot, () => {}), installed = await planExportTree(globalRoot, () => {});
      bytes += candidate.bytes + installed.bytes; entries += candidate.entries + installed.entries;
      if (bytes > WORLD_LIMITS.unpackedMB * 1024 ** 2 * 2 || entries > WORLD_LIMITS.entries * 2) fail('Dữ liệu so sánh add-on vượt giới hạn nhập world.', 409);
      if (candidate.bytes !== installed.bytes || candidate.entries !== installed.entries || await exportTreeDigest(candidate) !== await exportTreeDigest(installed)) continue;
      await assertExportPlanUnchanged(candidate); await assertExportPlanUnchanged(installed);
      pending.push({ candidate, installed, relative, pack: global });
    }
  }
  for (const item of pending) { await assertExportPlanUnchanged(item.candidate); await assertExportPlanUnchanged(item.installed); }
  for (const item of pending) {
    await fs.rm(await safePath(root, item.relative), { recursive: true, force: false });
    reused.push({ uuid: item.pack.uuid, name: item.pack.name, kind: item.pack.kind, version: [...item.pack.version], source: 'identical-installed-global' });
  }
  return reused;
}

// The manager owns the server operation lock and native command queue for the
// whole preparation. Its caller also owns the returned download until cleanup.
// Active LevelDB files must come from Bedrock's exact save-query byte manifest;
// a normal filesystem ZIP of a running world is not a consistent export.
export async function createWorldExport({ runRoot, name, destination, snapshot, options, live = null, guard = () => {}, reserveWorkspace = async () => {}, progress = () => {} }) {
  validateWorldName(name); guard();
  const original = await worldTarget(runRoot, name);
  snapshot ||= destination + '.snapshot';
  for (const filename of [destination, snapshot]) {
    const relative = path.relative(runRoot, filename);
    if (!path.isAbsolute(filename) || !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail('Dữ liệu xuất world tạm phải nằm ngoài thư mục server đang chạy.', 409);
  }
  if (path.resolve(destination) === path.resolve(snapshot)) fail('Đường dẫn archive và dữ liệu world tạm phải khác nhau.', 409);
  for (const filename of [destination, ...(snapshot ? [snapshot] : [])]) {
    const existing = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) fail('Đường dẫn xuất world tạm đã tồn tại; hãy thử lại.', 409);
  }
  let source = original, cleaned = false; const releases = [];
  const reserve = async bytes => { const release = await reserveWorkspace(bytes); if (release) releases.push(release); };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      const results = await Promise.allSettled([fs.rm(destination, { force: true }), ...(snapshot ? [fs.rm(snapshot, { recursive: true, force: true })] : [])]);
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    } finally { for (const release of releases.splice(0)) release(); }
  };
  try {
    if (live) {
      if (live.worldName !== name || !snapshot || !live.console) fail('Phiên thế giới đang chạy không khớp yêu cầu xuất world.', 409);
      const prefix = `worlds/${name}`;
      await snapshotLiveServer({ root: runRoot, destination: snapshot, worldName: name, console: live.console,
        // Traverse only the selected world. Other worlds, server identities,
        // runtime binaries and global configuration never enter a .mcworld.
        exclude: relative => relative !== 'worlds' && relative !== prefix && !relative.startsWith(prefix + '/'),
        guard: () => { guard(); live.guard?.(); }, releaseGuard: live.releaseGuard || live.guard || (() => {}), progress,
        reserveWorkspace: reserve
      });
      source = await worldTarget(snapshot, name);
    }
    guard();
    const inspected = await inspectSupportedWorld(source, options);
    const packSet = await inspectWorldPacks(source, options), globalPlans = [];
    if (inspected.metadata.embeddedPacks + packSet.requiredGlobalPacks.length > 500) fail('World chứa quá nhiều pack; giới hạn là 500 manifest.', 409);
    let plannedBytes = inspected.size, plannedEntries = inspected.entries;
    for (const pack of packSet.requiredGlobalPacks) {
      guard();
      if (!['behavior', 'resource'].includes(pack.kind) || typeof pack.folder !== 'string' || !pack.folder.startsWith(`${pack.kind}_packs/`) || pack.folder.split('/').length !== 2) fail('Đường dẫn add-on dùng chung không hợp lệ; không xuất dữ liệu ngoài pack.', 409);
      const folder = await safePath(runRoot, pack.folder), current = parsePackManifest(await jsonFile(runRoot, `${pack.folder}/manifest.json`), { serverVersion: options?.serverVersion });
      if (current.errors.length || current.uuid !== pack.uuid || current.kind !== pack.kind || !sameVersion(current.version, pack.version)) fail('Add-on đã thay đổi trong lúc xuất world; hãy tải lại rồi thử lại.', 409);
      const plan = await planExportTree(folder, guard);
      plannedBytes += plan.bytes; plannedEntries += plan.entries + 2;
      if (plannedBytes > WORLD_LIMITS.unpackedMB * 1024 ** 2 || plannedEntries > WORLD_LIMITS.entries) fail('World kèm add-on vượt giới hạn 2 GiB hoặc 50.000 mục.', 409);
      globalPlans.push({ pack, plan });
    }
    guard();
    if (!live) {
      const plan = await planExportTree(original, guard);
      await reserve((plan.bytes + globalPlans.reduce((bytes, item) => bytes + item.plan.bytes, 0)) * 2 + plannedEntries * 16384 + 1024 ** 2); guard();
      await fs.mkdir(snapshot, { mode: 0o700 }); await fs.mkdir(path.join(snapshot, 'worlds'), { mode: 0o700 });
      source = path.join(snapshot, 'worlds', name); await copyExportTree(plan, source, guard);
    } else if (globalPlans.length) await reserve(globalPlans.reduce((bytes, item) => bytes + item.plan.bytes * 2 + (item.plan.entries + 2) * 16384, 0));
    for (const { pack, plan } of globalPlans) {
      guard(); const collection = path.join(source, `${pack.kind}_packs`);
      await fs.mkdir(collection, { recursive: true, mode: 0o700 });
      await copyExportTree(plan, path.join(collection, `vortex-export-${pack.uuid}`), guard);
    }
    // Validate the self-contained result without access to host-global packs.
    // This proves every UUID dependency is portable and retains reference order.
    await inspectSupportedWorld(source, { ...options, globalPacks: [] });
    guard();
    // Native saving has already resumed before metadata validation/compression.
    // ZIP progress callbacks run from an EventEmitter, so cancellation checks
    // stay at awaited boundaries rather than throwing from an event listener.
    await zipDirectory(source, destination, { includeEmptyDirectories: true, maxBytes: WORLD_LIMITS.unpackedMB * 1024 ** 2, maxEntries: WORLD_LIMITS.entries,
      progress: value => progress(20 + value * 0.8, 'Đang nén world Bedrock để tải xuống') });
    guard();
    if (snapshot) await fs.rm(snapshot, { recursive: true, force: true });
    return { path: destination, name: `${name}.mcworld`, consistency: live ? 'native-online' : 'quiescent-world', embeddedGlobalPacks: globalPlans.length, cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { error.message += `; không dọn được dữ liệu xuất world tạm: ${cleanupError.message}`; }
    throw error;
  }
}

export async function existingWorldNames(runRoot) {
  let root;
  try { root = await safePath(runRoot, 'worlds'); }
  catch (error) { if (error.status === 404) return []; throw error; }
  const entries = (await fs.readdir(root, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.vortex-delete-server-') && (entry.isDirectory() || entry.isSymbolicLink()));
  if (entries.length > WORLD_LIMITS.maxWorlds) fail('Panel hỗ trợ tối đa 100 world trên một server.', 409);
  return entries.map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'en'));
}

export async function worldTarget(runRoot, name, { missing = false } = {}) {
  validateWorldName(name);
  const target = await safePath(runRoot, `worlds/${name}`, { allowMissing: missing });
  const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (missing) {
    if (stat) fail('Tên world đã tồn tại; hãy chọn tên mới, không ghi đè dữ liệu.', 409);
  } else if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('Không tìm thấy thư mục world hợp lệ.', 404);
  return target;
}

export async function unpackWorld(archive, filename, staging, options) {
  if (typeof filename !== 'string' || !['.mcworld', '.zip'].includes(path.extname(filename).toLowerCase())) fail('Chỉ nhận world Bedrock .mcworld hoặc .zip.');
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WORLD_LIMITS.compressedMB * 1024 ** 2) fail('Archive world phải là tệp thường không quá 1 GiB.');
  await extractZip(archive, staging, { maxBytes: WORLD_LIMITS.unpackedMB * 1024 ** 2, maxEntries: WORLD_LIMITS.entries });
  const entries = await fs.readdir(staging, { withFileTypes: true });
  let root = staging;
  const rootLevel = entries.some(entry => entry.name === 'level.dat' && entry.isFile());
  if (!rootLevel) {
    if (entries.length !== 1 || !entries[0].isDirectory()) fail('ZIP phải chứa đúng một world Bedrock ở gốc hoặc trong một thư mục bọc.');
    root = await safePath(staging, entries[0].name);
  } else {
    // Additional data folders are allowed; another level.dat identifies an
    // ambiguous multi-world archive and must never be silently ignored.
    for (const entry of entries.filter(entry => entry.isDirectory())) if (await fs.lstat(path.join(staging, entry.name, 'level.dat')).catch(() => null)) fail('Archive chứa nhiều world; hãy nhập từng world riêng.');
  }
  const reusedGlobalPacks = options?.reuseIdenticalGlobalPacks === true ? await reuseIdenticalImportedPacks(root, options) : [];
  const inspected = await inspectSupportedWorld(root, options);
  return { root, ...inspected, ...(reusedGlobalPacks.length ? { reusedGlobalPacks, warnings: [...inspected.warnings, ...reusedGlobalPacks.map(pack => `Đã dùng lại add-on đã cài có nội dung trùng khớp ${pack.name} (${pack.uuid}); giữ nguyên thứ tự pack của world.`)] } : {}) };
}
