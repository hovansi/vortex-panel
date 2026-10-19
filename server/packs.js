import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { extractZip } from './archives.js';
import { atomicWrite, cleanRelative, fail, safePath, walkFiles } from './safety.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = { behavior: 'behavior_packs', resource: 'resource_packs' };
const MAX_UNPACKED = 512 * 1024 ** 2;
const MAX_ENTRIES = 10000;
const SCRIPT_API = /^@minecraft\/[a-z][a-z0-9-]{0,63}$/;
const API_VERSION = /^(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const versionValid = value => Array.isArray(value) && value.length === 3 && value.every(number => Number.isSafeInteger(number) && number >= 0 && number <= 2147483647);
const sameVersion = (a, b) => versionValid(a) && versionValid(b) && a.every((value, index) => value === b[index]);
const exceedsEngine = (minimum, version) => {
  const actual = String(version || '').split('.').slice(0, 3).map(Number);
  if (actual.length !== 3 || actual.some(value => !Number.isInteger(value))) return false;
  for (let index = 0; index < 3; index++) { if (minimum[index] !== actual[index]) return minimum[index] > actual[index]; }
  return false;
};
const worldName = value => { if (typeof value !== 'string' || !value || /[\\/:\0]/.test(value) || ['.', '..'].includes(value)) fail('Tên thế giới không hợp lệ.'); return value; };

export function parsePackManifest(manifest, { serverVersion } = {}) {
  const errors = [];
  const error = text => errors.push(text);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest.json phải là một đối tượng JSON.');
  if (manifest.format_version !== 2) error('Panel hiện hỗ trợ manifest format_version=2.');
  const header = manifest.header || {};
  if (typeof header.name !== 'string' || !header.name.trim() || header.name.length > 256) error('Header cần name dài 1–256 ký tự.');
  if (typeof header.description !== 'string' || header.description.length > 4096) error('Header cần description tối đa 4096 ký tự.');
  if (!UUID.test(header.uuid || '')) error('Header UUID không hợp lệ.');
  if (!versionValid(header.version)) error('Header version cần ba số nguyên không âm.');
  if (!versionValid(header.min_engine_version)) error('Header min_engine_version cần ba số nguyên không âm.');
  else if (exceedsEngine(header.min_engine_version, serverVersion)) error(`Pack yêu cầu Minecraft ${header.min_engine_version.join('.')} trở lên.`);
  if (header.pack_scope !== undefined && !['world', 'global', 'any'].includes(header.pack_scope)) error('Header pack_scope cần world, any hoặc global.');
  if (header.pack_scope === 'global') error('Panel chỉ kích hoạt pack cho thế giới; pack_scope=global không thể gắn vào world.');
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  if (!modules.length || modules.length > 16) error('Manifest cần 1–16 module.');
  const ids = new Set([String(header.uuid || '').toLowerCase()]);
  const kinds = new Set();
  for (const module of modules) {
    if (!module || !UUID.test(module.uuid || '') || ids.has(String(module.uuid).toLowerCase())) error('Module UUID phải hợp lệ và khác mọi header/module UUID trong pack.');
    else ids.add(module.uuid.toLowerCase());
    if (!versionValid(module?.version)) error('Module version cần ba số nguyên không âm.');
    if (module?.type === 'resources') kinds.add('resource');
    else if (module?.type === 'data') kinds.add('behavior');
    else if (module?.type === 'script') {
      kinds.add('behavior');
      if (module.language !== 'javascript') error('Script API chỉ hỗ trợ language=javascript.');
      try {
        if (typeof module.entry !== 'string' || module.entry.length > 240 || cleanRelative(module.entry, { allowRoot: false }) !== module.entry || !module.entry.endsWith('.js')) throw Error();
      } catch { error('Script entry cần là đường dẫn .js tương đối nằm trong pack.'); }
    }
    else error(module?.type ? `Module ${module.type} chưa được hỗ trợ; chỉ hỗ trợ data/resources/script.` : 'Module thiếu type; chỉ hỗ trợ data/resources/script.');
  }
  if (kinds.size !== 1) error('Mỗi pack phải là behavior (data/script) hoặc resource, không trộn cả hai.');
  const dependencies = manifest.dependencies === undefined ? [] : manifest.dependencies;
  if (!Array.isArray(dependencies) || dependencies.length > 64) error('Dependencies phải là danh sách tối đa 64 pack.');
  else for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) error('Dependency cần là một đối tượng JSON.');
    else if (dependency.module_name !== undefined) {
      if (dependency.uuid !== undefined || !SCRIPT_API.test(dependency.module_name) || typeof dependency.version !== 'string' || dependency.version.length > 128 || !API_VERSION.test(dependency.version)) error('Script dependency cần module_name @minecraft/* và phiên bản API cụ thể.');
    }
    else if (!UUID.test(dependency.uuid || '') || !versionValid(dependency.version)) error('Dependency cần header UUID và version gồm ba số nguyên.');
    else if (dependency.uuid.toLowerCase() === String(header.uuid).toLowerCase()) error('Pack không được phụ thuộc chính nó.');
  }
  return {
    uuid: UUID.test(header.uuid || '') ? header.uuid.toLowerCase() : null,
    name: typeof header.name === 'string' ? header.name : '(manifest không hợp lệ)',
    ...(typeof header.name === 'string' ? {} : { generatedName: true }),
    description: typeof header.description === 'string' ? header.description : '',
    version: versionValid(header.version) ? [...header.version] : null,
    minEngineVersion: versionValid(header.min_engine_version) ? [...header.min_engine_version] : null,
    packScope: header.pack_scope || 'any',
    kind: kinds.size === 1 ? [...kinds][0] : null,
    modules: modules.map(module => ({ type: module?.type || null, uuid: typeof module?.uuid === 'string' ? module.uuid.toLowerCase() : null, version: versionValid(module?.version) ? [...module.version] : null, ...(module?.type === 'script' ? { language: module.language, entry: module.entry } : {}) })),
    dependencies: Array.isArray(dependencies) ? dependencies.map(item => ({ ...(item?.uuid ? { uuid: String(item.uuid).toLowerCase() } : {}), ...(item?.module_name ? { module_name: item.module_name } : {}), version: item?.version })) : [],
    errors,
    scripting: modules.some(module => module?.type === 'script'),
    requiresBetaApis: Array.isArray(dependencies) && dependencies.some(dependency => dependency?.module_name && typeof dependency.version === 'string' && /(?:^|-)beta(?:[.-]|$)/.test(dependency.version)),
  };
}

/** Validate code entry locations without executing, importing or granting API permissions. */
export async function validatePackScriptEntries(root, folder, pack) {
  for (const module of pack.modules || []) {
    if (module.type !== 'script') continue;
    const entry = await safePath(root, `${folder ? folder + '/' : ''}${module.entry}`, { allowRoot: false });
    const stat = await fs.lstat(entry);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 16 * 1024 ** 2) fail('Script entry cần là tệp .js thông thường tối đa 16 MiB trong pack.', 409);
  }
}

async function readJson(root, relative, { optional = false, array = false } = {}) {
  let file;
  try { file = await safePath(root, relative); }
  catch (error) { if (optional && error.status === 404) return { value: array ? [] : null, text: null }; throw error; }
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 256 * 1024) fail(`${relative}: JSON cần là tệp thường tối đa 256 KiB.`, 409);
  const text = await fs.readFile(file, 'utf8');
  let value; try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail(`${relative}: JSON không hợp lệ.`, 409); }
  if (array && (!Array.isArray(value) || value.length > 2000)) fail(`${relative}: cần danh sách tối đa 2000 mục.`, 409);
  return { value, text };
}
async function worldFolders(root) {
  let directory; try { directory = await safePath(root, 'worlds'); } catch (error) { if (error.status === 404) return []; throw error; }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.filter(entry => entry.isDirectory()).length > 100) fail('Công cụ pack hỗ trợ tối đa 100 thế giới trên một server.', 409);
  for (const entry of entries) if (entry.isSymbolicLink()) fail('Thư mục worlds chứa liên kết; không thể quản lý pack an toàn.', 409);
  return entries.filter(entry => entry.isDirectory()).map(entry => worldName(entry.name));
}
async function scanPacks(root, options, { allWorlds = false } = {}) {
  const names = allWorlds ? await worldFolders(root) : [worldName(options.levelName)];
  const roots = Object.entries(KINDS).map(([kind, folder]) => ({ kind, folder, scope: null }));
  for (const name of names) for (const [kind, folder] of Object.entries(KINDS)) roots.push({ kind, folder: `worlds/${name}/${folder}`, scope: name });
  const packs = []; const warnings = [];
  for (const collection of roots) {
    let directory; try { directory = await safePath(root, collection.folder); } catch (error) { if (error.status === 404) continue; warnings.push(error.message); continue; }
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) { warnings.push(`${collection.folder}/${entry.name}: liên kết bị bỏ qua.`); continue; }
      if (!entry.isDirectory()) continue;
      if (packs.length >= 500) fail('Có quá nhiều pack; giới hạn kiểm tra là 500.', 409);
      const folder = cleanRelative(`${collection.folder}/${entry.name}`, { allowRoot: false });
      try {
        const { value } = await readJson(root, `${folder}/manifest.json`);
        const pack = parsePackManifest(value, options);
        if (!pack.errors.length) await validatePackScriptEntries(root, folder, pack);
        if (pack.kind && pack.kind !== collection.kind) pack.errors.push('Loại module không khớp thư mục cài đặt.');
        packs.push({ ...pack, kind: collection.kind, folder, scope: collection.scope, protected: (options.runtimeFiles || []).some(name => name === folder || name.startsWith(folder + '/')), enabled: false });
      } catch (error) { packs.push({ uuid: null, name: entry.name, description: '', version: null, minEngineVersion: null, kind: collection.kind, folder, scope: collection.scope, modules: [], dependencies: [], protected: (options.runtimeFiles || []).some(name => name.startsWith(folder + '/')), enabled: false, errors: [error.message] }); }
    }
  }
  const seen = new Map();
  for (const pack of packs) {
    for (const id of [pack.uuid, ...pack.modules.map(module => module.uuid)].filter(Boolean)) {
      if (seen.has(id)) { pack.errors.push(`UUID trùng với ${seen.get(id).folder}.`); seen.get(id).errors.push(`UUID trùng với ${pack.folder}.`); }
      else seen.set(id, pack);
    }
  }
  return { packs, warnings };
}
async function registrations(root, name) {
  const result = {};
  for (const kind of Object.keys(KINDS)) {
    const relative = `worlds/${worldName(name)}/world_${kind}_packs.json`;
    result[kind] = { relative, ...await readJson(root, relative, { optional: true, array: true }) };
  }
  return result;
}
const registrationRevision = refs => createHash('sha256').update(JSON.stringify(Object.entries(refs).map(([kind, value]) => [kind, value.text]))).digest('hex');
async function writeRegistrations(root, changes, commit = () => {}) {
  const written = [];
  try {
    for (const change of changes) {
      const destination = await safePath(root, change.relative, { allowMissing: true });
      await atomicWrite(destination, JSON.stringify(change.value, null, 2) + '\n'); written.push(change);
    }
    commit();
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        const destination = await safePath(root, change.relative, { allowMissing: true });
        if (change.text === null) await fs.rm(destination, { force: true });
        else await atomicWrite(destination, change.text);
      } catch (rollbackError) { error.message += `; không thể khôi phục ${change.relative}: ${rollbackError.message}`; }
    }
    throw error;
  }
}
const findPack = (packs, uuid) => {
  if (!UUID.test(uuid || '')) fail('Pack UUID không hợp lệ.');
  const found = packs.filter(pack => pack.uuid === uuid.toLowerCase());
  if (found.length !== 1) fail(found.length ? 'UUID pack bị trùng; hãy sửa thủ công trước khi thao tác.' : 'Không tìm thấy pack.', found.length ? 409 : 404);
  return found[0];
};
function dependencyClosure(target, packs) {
  const selected = new Map(); const visiting = new Set();
  const visit = pack => {
    if (visiting.has(pack.uuid)) fail('Panel hiện chưa tự kích hoạt các pack có vòng phụ thuộc.', 409);
    if (selected.has(pack.uuid)) return;
    if (pack.errors.length) fail(`${pack.name}: ${pack.errors.join(' ')}`, 409);
    visiting.add(pack.uuid);
    for (const dependency of pack.dependencies) {
      if (dependency.module_name) continue;
      const required = findPack(packs, dependency.uuid);
      if (!sameVersion(required.version, dependency.version)) fail(`${pack.name} cần ${dependency.uuid} phiên bản ${dependency.version.join('.')}.`, 409);
      visit(required);
    }
    visiting.delete(pack.uuid); selected.set(pack.uuid, pack);
  };
  visit(target); return [...selected.values()];
}

export async function inspectPacks(root, options) {
  const result = await scanPacks(root, options);
  let exists = false;
  try { exists = (await fs.stat(await safePath(root, `worlds/${worldName(options.levelName)}`))).isDirectory(); } catch (error) { if (error.status !== 404) throw error; }
  let refs = null;
  if (exists) {
    try {
      refs = await registrations(root, options.levelName);
      for (const pack of result.packs) {
        const priority = refs[pack.kind].value.findIndex(entry => String(entry?.pack_id).toLowerCase() === pack.uuid && sameVersion(entry?.version, pack.version));
        pack.enabled = priority >= 0;
        pack.priority = priority >= 0 ? priority + 1 : null;
      }
    } catch (error) { result.warnings.push(error.message); }
  }
  for (const pack of result.packs) for (const dependency of pack.dependencies) {
    if (dependency.module_name) continue;
    const required = result.packs.filter(item => item.uuid === dependency.uuid);
    if (required.length !== 1 || !sameVersion(required[0].version, dependency.version)) pack.errors.push(`Chưa có dependency hợp lệ ${dependency.uuid}.`);
  }
  const stacks = Object.fromEntries(Object.keys(KINDS).map(kind => [kind, (refs?.[kind].value || []).map((entry, index) => {
    const pack = result.packs.find(item => item.kind === kind && item.uuid === String(entry?.pack_id).toLowerCase() && sameVersion(item.version, entry?.version));
    return { uuid: entry?.pack_id || null, version: entry?.version || null, priority: index + 1, name: pack?.name || entry?.pack_id || null, folder: pack?.folder || null, missing: !pack, protected: pack?.protected || false, valid: Boolean(pack && !pack.errors.length) };
  })]));
  return { ...result, stacks, revision: refs ? registrationRevision(refs) : null, observedAt: new Date().toISOString(), registrationSource: 'world-pack-json', priorityOrder: 'highest-first', runtimeValidation: 'content-log', world: { name: options.levelName, exists }, limits: { compressedMB: 100, unpackedMB: 512, entries: MAX_ENTRIES, manifests: 20 } };
}

/** Exact, optimistic permutation: missing packs and unknown registration fields survive. */
export async function reorderPacks(root, kind, input, options) {
  if (!Object.hasOwn(KINDS, kind) || !input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['packIds', 'revision'].includes(key)) || !Array.isArray(input.packIds) || input.packIds.length > 2000 || input.packIds.some(uuid => typeof uuid !== 'string' || !UUID.test(uuid)) || new Set(input.packIds.map(uuid => uuid.toLowerCase())).size !== input.packIds.length || !/^[a-f0-9]{64}$/.test(input.revision || '')) fail('Thứ tự pack cần loại hợp lệ, revision và danh sách UUID không trùng lặp.');
  const refs = await registrations(root, options.levelName);
  if (registrationRevision(refs) !== input.revision) fail('Danh sách pack đã thay đổi; tải lại trước khi sắp xếp.', 409);
  const original = refs[kind], byId = new Map();
  for (const entry of original.value) {
    const uuid = typeof entry?.pack_id === 'string' ? entry.pack_id.toLowerCase() : '';
    if (!UUID.test(uuid) || byId.has(uuid)) fail('Danh sách pack hiện tại có UUID không hợp lệ hoặc trùng lặp; hãy sửa trước khi sắp xếp.', 409);
    byId.set(uuid, entry);
  }
  const ids = input.packIds.map(uuid => uuid.toLowerCase());
  if (ids.length !== byId.size || ids.some(uuid => !byId.has(uuid))) fail('Sắp xếp phải giữ nguyên toàn bộ pack đã đăng ký.', 409);
  const value = ids.map(uuid => byId.get(uuid));
  if (value.every((entry, index) => entry === original.value[index])) return { ...await inspectPacks(root, options), changed: false };
  await writeRegistrations(root, [{ ...original, value }], options.onCommit);
  return { ...await inspectPacks(root, options), changed: true, appliesOn: 'next-world-load' };
}

export async function importPacks(root, archive, options) {
  const extension = path.extname(options.filename || '').toLowerCase();
  if (!['.mcpack', '.mcaddon'].includes(extension)) fail('Chỉ nhận tệp .mcpack hoặc .mcaddon.');
  if ((await fs.stat(archive)).size > 100 * 1024 ** 2) fail('Archive pack vượt 100 MiB.');
  const staging = path.join(path.dirname(root), `.packs-import-${randomUUID()}`);
  const moved = [];
  try {
    const outer = path.join(staging, 'outer');
    let entries = (await extractZip(archive, outer, { maxBytes: MAX_UNPACKED, maxEntries: MAX_ENTRIES })).length;
    const outerFiles = await walkFiles(outer); let bytes = 0;
    for (const name of outerFiles) bytes += (await fs.stat(path.join(outer, name))).size;
    if (outerFiles.some(name => /\.mcworld$|\.mcaddon$/i.test(name))) fail('Công cụ chỉ cài pack; archive chứa .mcworld hoặc .mcaddon lồng chưa được hỗ trợ.');
    const manifests = outerFiles.filter(name => path.posix.basename(name) === 'manifest.json').map(name => path.join(outer, name));
    const nested = outerFiles.filter(name => /\.mcpack$/i.test(name));
    if (extension === '.mcpack' && nested.length) fail('.mcpack phải chứa một manifest trực tiếp, không chứa archive lồng.');
    if (nested.length > 20) fail('Archive có quá nhiều pack lồng; giới hạn 20.');
    for (const name of nested) {
      const nestedRoot = path.join(staging, `nested-${randomUUID()}`);
      const extracted = await extractZip(path.join(outer, name), nestedRoot, { maxBytes: MAX_UNPACKED - bytes, maxEntries: MAX_ENTRIES - entries });
      entries += extracted.length;
      const files = await walkFiles(nestedRoot);
      for (const file of files) bytes += (await fs.stat(path.join(nestedRoot, file))).size;
      if (files.some(file => /\.(?:mcpack|mcaddon|mcworld)$/i.test(file))) fail('Chỉ hỗ trợ một lớp .mcpack lồng trong .mcaddon.');
      manifests.push(...files.filter(file => path.posix.basename(file) === 'manifest.json').map(file => path.join(nestedRoot, file)));
    }
    if (!manifests.length || manifests.length > 20 || (extension === '.mcpack' && manifests.length !== 1)) fail('Archive cần 1–20 pack; .mcpack cần đúng một manifest.json.');
    const installed = await scanPacks(root, options, { allWorlds: true });
    const candidates = [];
    for (const filename of manifests) {
      if ((await fs.stat(filename)).size > 256 * 1024) fail('Manifest vượt 256 KiB.');
      let manifest; try { manifest = JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); } catch { fail('manifest.json không hợp lệ.'); }
      const pack = parsePackManifest(manifest, options);
      if (pack.errors.length) fail(`${pack.name}: ${pack.errors.join(' ')}`);
      const source = path.dirname(filename);
      await validatePackScriptEntries(source, '', pack);
      if (manifests.some(other => other !== filename && path.dirname(other).startsWith(source + path.sep))) fail('Không cho phép các thư mục pack chồng lồng nhau.');
      candidates.push({ ...pack, source, folder: `${KINDS[pack.kind]}/vortex-${pack.uuid}`, scope: null, protected: false, enabled: false });
    }
    const ids = new Set(installed.packs.flatMap(pack => [pack.uuid, ...pack.modules.map(module => module.uuid)]).filter(Boolean));
    for (const pack of candidates) for (const id of [pack.uuid, ...pack.modules.map(module => module.uuid)]) { if (ids.has(id)) fail(`UUID ${id} đã tồn tại; không ghi đè pack bất biến.`, 409); ids.add(id); }
    const available = [...installed.packs.filter(pack => pack.scope === null || pack.scope === options.levelName), ...candidates];
    for (const pack of candidates) dependencyClosure(pack, available);
    for (const pack of candidates) {
      const target = await safePath(root, pack.folder, { allowMissing: true });
      if (await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) fail('Thư mục pack đã tồn tại; không ghi đè.', 409);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.rename(pack.source, target); moved.push(target);
    }
    options.onCommit?.();
    return { packs: candidates.map(({ source, ...pack }) => pack), warnings: ['Pack chưa được bật. Khả năng hoạt động và các experiment cần kiểm tra qua content log sau khi khởi động.'] };
  } catch (error) {
    for (const target of moved.reverse()) await fs.rm(target, { recursive: true, force: true }).catch(rollbackError => { error.message += `; không thể dọn pack: ${rollbackError.message}`; });
    throw error;
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
}

export async function setPackEnabled(root, uuid, enabled, options) {
  if (typeof enabled !== 'boolean') fail('enabled phải là boolean.');
  const catalog = await scanPacks(root, options); const pack = findPack(catalog.packs, uuid);
  let world; try { world = await safePath(root, `worlds/${worldName(options.levelName)}`); } catch (error) { if (error.status === 404) fail('Thế giới chưa tồn tại; hãy khởi động Bedrock một lần để tạo thế giới.', 409); throw error; }
  if (!(await fs.stat(world)).isDirectory()) fail('Thế giới chưa tồn tại; hãy khởi động Bedrock một lần để tạo thế giới.', 409);
  const refs = await registrations(root, options.levelName);
  const changes = new Map();
  if (enabled) {
    for (const selected of dependencyClosure(pack, catalog.packs)) {
      const current = changes.get(selected.kind) || structuredClone(refs[selected.kind]);
      const existing = current.value.find(entry => String(entry?.pack_id).toLowerCase() === selected.uuid);
      if (existing) existing.version = [...selected.version];
      else current.value.push({ pack_id: selected.uuid, version: [...selected.version] });
      changes.set(selected.kind, current);
    }
  } else {
    for (const dependant of catalog.packs) if (dependant.uuid !== pack.uuid && dependant.dependencies.some(dependency => dependency.uuid === pack.uuid) && refs[dependant.kind].value.some(entry => String(entry?.pack_id).toLowerCase() === dependant.uuid)) fail(`${dependant.name} đang bật và cần pack này; hãy tắt pack phụ thuộc trước.`, 409);
    changes.set(pack.kind, { ...refs[pack.kind], value: refs[pack.kind].value.filter(entry => String(entry?.pack_id).toLowerCase() !== pack.uuid) });
  }
  await writeRegistrations(root, [...changes.values()], options.onCommit);
  return { pack: { ...pack, enabled }, activated: enabled ? dependencyClosure(pack, catalog.packs).map(item => item.uuid) : [], world: { name: options.levelName, exists: true } };
}

export async function removePack(root, uuid, options) {
  const catalog = await scanPacks(root, options, { allWorlds: true }); const pack = findPack(catalog.packs, uuid);
  if (pack.protected) fail('Pack runtime/Mojang được bảo vệ; hãy dùng cập nhật phiên bản.', 403);
  if (options.running) return removeInactivePack(root, pack, catalog, options);
  const changes = [];
  for (const name of await worldFolders(root)) {
    const refs = await registrations(root, name);
    const local = catalog.packs.filter(item => item.scope === null || item.scope === name);
    for (const dependant of local) if (dependant.uuid !== pack.uuid && dependant.dependencies.some(dependency => dependency.uuid === pack.uuid) && refs[dependant.kind].value.some(entry => String(entry?.pack_id).toLowerCase() === dependant.uuid)) fail(`${dependant.name} trong thế giới ${name} đang cần pack này. Tắt pack phụ thuộc trước.`, 409);
    for (const registration of Object.values(refs)) if (registration.value.some(entry => String(entry?.pack_id).toLowerCase() === pack.uuid)) changes.push({ ...registration, value: registration.value.filter(entry => String(entry?.pack_id).toLowerCase() !== pack.uuid) });
  }
  const source = await safePath(root, pack.folder); const trash = path.join(path.dirname(root), `.packs-trash-${randomUUID()}`);
  await fs.rename(source, trash);
  try { await writeRegistrations(root, changes, options.onCommit); }
  catch (error) { await fs.rename(trash, source).catch(rollbackError => { error.message += `; không thể khôi phục thư mục pack: ${rollbackError.message}`; }); throw error; }
  await fs.rm(trash, { recursive: true, force: true });
  return { ok: true, worldsUpdated: changes.length };
}

function startupRegistrationIds(stacks) {
  if (!stacks || typeof stacks !== 'object' || Array.isArray(stacks)) fail('Chưa có ảnh chụp pack khi khởi động; dừng máy chủ trước khi xóa Add-on.', 409);
  const ids = new Set();
  for (const kind of Object.keys(KINDS)) {
    const entries = stacks[kind];
    if (!Array.isArray(entries) || entries.length > 2000) fail('Ảnh chụp pack khi khởi động không hợp lệ; dừng máy chủ trước khi xóa Add-on.', 409);
    for (const entry of entries) {
      const uuid = typeof entry?.uuid === 'string' ? entry.uuid.toLowerCase() : '';
      if (!UUID.test(uuid) || !versionValid(entry?.version) || ids.has(uuid)) fail('Ảnh chụp pack khi khởi động không hợp lệ; dừng máy chủ trước khi xóa Add-on.', 409);
      ids.add(uuid);
    }
  }
  return ids;
}
async function inactiveRemovalProof(root, pack, catalog, options) {
  await options.assertLive?.();
  if (startupRegistrationIds(options.startupStacks).has(pack.uuid)) fail('Pack đã được đăng ký khi tiến trình khởi động; dừng máy chủ trước khi xóa Add-on.', 409);
  const records = [];
  for (const name of (await worldFolders(root)).sort()) {
    let refs;
    try { refs = await registrations(root, name); }
    catch { fail('Danh sách pack của world không hợp lệ; dừng máy chủ trước khi xóa Add-on.', 409); }
    const worldIds = new Set();
    for (const kind of Object.keys(KINDS)) {
      const ids = new Set();
      for (const entry of refs[kind].value) {
        const uuid = typeof entry?.pack_id === 'string' ? entry.pack_id.toLowerCase() : '';
        if (!UUID.test(uuid) || !versionValid(entry?.version) || ids.has(uuid)) fail('Danh sách pack của world không hợp lệ; dừng máy chủ trước khi xóa Add-on.', 409);
        ids.add(uuid); worldIds.add(uuid);
      }
      if (ids.has(pack.uuid)) fail('Pack còn được đăng ký cho một thế giới; dừng máy chủ trước khi xóa Add-on.', 409);
      records.push([name, kind, refs[kind].text]);
    }
    for (const dependant of catalog.packs) {
      if ((dependant.scope === null || dependant.scope === name) && worldIds.has(dependant.uuid) && dependant.dependencies.some(dependency => dependency.uuid === pack.uuid)) fail('Một pack đang bật còn phụ thuộc Add-on này; dừng máy chủ trước khi xóa.', 409);
    }
  }
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
async function removeInactivePack(root, pack, catalog, options) {
  const proof = await inactiveRemovalProof(root, pack, catalog, options), source = await safePath(root, pack.folder), before = await fs.lstat(source);
  if (!before.isDirectory() || before.isSymbolicLink()) fail('Thư mục Add-on không hợp lệ.', 409);
  const trash = path.join(path.dirname(root), `.packs-trash-${randomUUID()}`);
  if (await inactiveRemovalProof(root, pack, catalog, options) !== proof) fail('Danh sách pack đã thay đổi; tải lại hoặc dừng máy chủ trước khi xóa.', 409);
  const current = await fs.lstat(await safePath(root, pack.folder));
  if (current.dev !== before.dev || current.ino !== before.ino || !current.isDirectory()) fail('Thư mục Add-on đã thay đổi; tải lại trước khi xóa.', 409);
  await fs.rename(source, trash);
  try {
    if (await inactiveRemovalProof(root, pack, catalog, options) !== proof) fail('Danh sách pack đã thay đổi; Add-on chưa được xóa.', 409);
    await options.onCommit?.();
  } catch (error) {
    try {
      if (await fs.lstat(source).catch(value => { if (value.code === 'ENOENT') return null; throw value; })) fail('Một thư mục khác đã xuất hiện tại vị trí Add-on; giữ bản cách ly để khôi phục thủ công.', 409);
      await fs.rename(trash, source);
    } catch (rollback) { error.message += `; không thể khôi phục thư mục pack: ${rollback.message}`; }
    throw error;
  }
  try { await fs.rm(trash, { recursive: true, force: true }); }
  catch { return { ok: true, worldsUpdated: 0, removedWhileRunning: true, cleanupPending: true, warnings: ['Add-on đã được bỏ khỏi thư viện; chưa dọn xong thư mục cách ly.'] }; }
  return { ok: true, worldsUpdated: 0, removedWhileRunning: true };
}
