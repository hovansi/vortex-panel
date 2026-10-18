import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZip } from './archives.js';
import { inspectBedrockWorld } from './bedrock-world-format.js';
import { parsePackManifest } from './packs.js';
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
  if (!stat.isFile() || stat.size > 256 * 1024) fail(`${relative}: JSON của world phải là tệp thường không quá 256 KiB.`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)); }
  catch { fail(`${relative}: JSON của world không phải UTF-8 hợp lệ.`); }
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { fail(`${relative}: JSON của world không hợp lệ.`); }
}

// Imported worlds may contain ordinary data/resource packs. Keep the complete
// bundle, but reject unsupported code/encryption instead of silently stripping it.
async function inspectWorldPacks(root, { serverVersion, globalPacks = [] } = {}) {
  const embedded = [];
  for (const [kind, folder] of [['behavior', 'behavior_packs'], ['resource', 'resource_packs']]) {
    let directory;
    try { directory = await safePath(root, folder); }
    catch (error) { if (error.status === 404) continue; throw error; }
    if (!(await fs.lstat(directory)).isDirectory()) fail(`${folder}: thư mục pack của world không hợp lệ.`);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail(`${folder}/${entry.name}: mỗi pack của world phải là thư mục thông thường.`);
      if (embedded.length >= 20) fail('World chứa quá nhiều pack; giới hạn là 20 manifest.');
      const relative = `${folder}/${entry.name}`;
      const pack = parsePackManifest(await jsonFile(root, `${relative}/manifest.json`), { serverVersion });
      if (pack.errors.length) fail(`${relative}: pack của world không được hỗ trợ: ${pack.errors[0]}`);
      if (pack.kind !== kind) fail(`${relative}: loại pack không khớp thư mục world.`);
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
  const visiting = new Set(), visited = new Set();
  function check(pack) {
    if (visiting.has(pack.uuid)) fail('World chứa pack có vòng phụ thuộc; panel chưa hỗ trợ.');
    if (visited.has(pack.uuid)) return;
    if (pack.errors?.length) fail(`${pack.name}: pack của world không được hỗ trợ: ${pack.errors[0]}`);
    visiting.add(pack.uuid);
    for (const dependency of pack.dependencies || []) {
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
  return { embeddedPacks: embedded.length, enabledPacks };
}

async function inspectNames(root, relative = '', state = { entries: 0, bytes: 0 }) {
  if (relative.split('/').length > 128) fail('World có đường dẫn quá sâu.');
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (++state.entries > WORLD_LIMITS.entries) fail('World vượt giới hạn 50.000 mục.');
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('World chứa liên kết hoặc tệp đặc biệt; thao tác bị từ chối.', 409);
    if (/^(?:keys|server_identity_key\.pem|bedrock_server(?:\.exe)?)$/i.test(entry.name) || (!relative && /^(?:server\.properties|allowlist\.json|permissions\.json)$/i.test(entry.name))) fail('Archive world chứa identity hoặc cấu hình server; hãy chỉ nhập dữ liệu world.');
    if (executable.test(entry.name) || /^(?:content\.key|contents\.json)$/i.test(entry.name)) fail(`World chứa mã chạy hoặc pack mã hóa chưa được hỗ trợ: ${name}.`);
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
  return { metadata: { ...metadata, ...packs }, size: totals.bytes, modified: stat.mtime.toISOString(), warnings: [...(metadata.warnings || [])] };
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
  return { root, ...(await inspectSupportedWorld(root, options)) };
}
