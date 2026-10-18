import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { normalizeStoragePolicy, storageLimitBytes } from './storage-policy.js';

export { normalizeStoragePolicy, storageLimitBytes } from './storage-policy.js';
const executeFile = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOOLS = Object.freeze({ fallocate: '/usr/bin/fallocate', mkfs: '/usr/sbin/mkfs.ext4', findmnt: '/usr/bin/findmnt', losetup: '/usr/sbin/losetup', mount: '/usr/bin/mount', umount: '/usr/bin/umount', blkid: '/usr/sbin/blkid', fsinfo: '/usr/sbin/dumpe2fs', fsck: '/usr/sbin/e2fsck', resize: '/usr/sbin/resize2fs', du: '/usr/bin/du' });
const messages = Object.freeze({
  STORAGE_INPUT: ['Storage settings or server identity are invalid.', 'Thiết lập lưu trữ hoặc định danh server không hợp lệ.'],
  STORAGE_UNSUPPORTED: ['Fixed storage requires Linux root, mount capability and the ext4 tools.', 'Lưu trữ giới hạn cần Linux root, quyền mount và công cụ ext4.'],
  STORAGE_PATH: ['The owned storage path changed or is unsafe.', 'Đường dẫn lưu trữ riêng đã thay đổi hoặc không an toàn.'],
  STORAGE_EXISTS: ['Storage already exists; it will not be overwritten.', 'Lưu trữ đã tồn tại; panel không ghi đè.'],
  STORAGE_MISSING: ['The fixed storage image or ownership record is missing.', 'Thiếu image lưu trữ giới hạn hoặc bản ghi sở hữu.'],
  STORAGE_FOREIGN: ['The mount does not belong to this server image.', 'Mount không thuộc image lưu trữ của server này.'],
  STORAGE_UNMOUNTED_DATA: ['The unmounted directory contains data; it will not be hidden by a mount.', 'Thư mục chưa mount đang có dữ liệu; panel không mount đè để che dữ liệu.'],
  STORAGE_ALLOCATION: ['The storage image is not fully allocated on the physical disk.', 'Image lưu trữ chưa được cấp phát đủ trên đĩa vật lý.'],
  STORAGE_BUSY: ['Storage is still mounted or busy; no forced unmount is used.', 'Lưu trữ vẫn đang mount hoặc đang được dùng; panel không ép unmount.'],
  STORAGE_GROW_ONLY: ['Fixed storage can only grow; shrinking is not supported.', 'Lưu trữ giới hạn chỉ có thể tăng, không hỗ trợ thu nhỏ.'],
  STORAGE_IO: ['The storage operation failed. Existing data was retained where possible.', 'Thao tác lưu trữ thất bại. Dữ liệu hiện có được giữ lại khi có thể.'],
  STORAGE_CLOSED: ['The storage controller is shutting down.', 'Bộ quản lý lưu trữ đang tắt.'],
});
export const STORAGE_MESSAGES = Object.freeze(Object.entries(messages).map(([code, [en, vi]]) => Object.freeze({ id: `panel.storage.${code.toLowerCase()}`, en, vi })));
function issue(code, status = 409, fields = {}) {
  const [en, vi] = messages[code];
  return Object.assign(new Error(en), { code, status, errorI18n: { id: `panel.storage.${code.toLowerCase()}`, en, vi, params: [] }, ...fields });
}
export function storageErrorPayload(error, language = 'en') {
  if (!Object.hasOwn(messages, error?.code)) return null;
  const [en, vi] = messages[error.code];
  return { error: language === 'vi' ? vi : en, code: error.code, errorI18n: { id: `panel.storage.${error.code.toLowerCase()}`, en, vi, params: [] }, ...(error.cleanupPending ? { cleanupPending: error.cleanupPending } : {}) };
}
const absent = error => error?.code === 'ENOENT';
const stamp = stat => ({ dev: stat.dev, ino: stat.ino });
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const bad = code => { throw issue(code); };

// A fixed-size, fully preallocated filesystem is enforced even for root native
// writers. No project quota/rootfs remount or host-global fstab edits are used.
// The server root is mounted, keeping run/backup/staging renames inside one FS.
export function createStorageController(options = {}) {
  const io = options.fs || fs, command = options.execFile || executeFile;
  const platform = options.platform || process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const tools = { ...TOOLS, ...options.tools };
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || 'data');
  const images = path.join(dataDir, '.storage'), servers = path.join(dataDir, 'servers');
  const now = options.now || Date.now;
  const makeUUID = options.randomUUID || randomUUID;
  const timeout = options.commandTimeoutMs ?? 300000;
  const statsCache = new Map(), operations = new Map(), mountChecks = new Map();
  let initialized = false, initializePromise, unsupported = null, closed = false;

  function names(server) {
    if (!server || !UUID.test(server.id || '')) throw issue('STORAGE_INPUT', 400);
    const id = server.id.toLowerCase();
    return { id, image: path.join(images, `${id}.img`), recordPath: path.join(images, `${id}.json`), target: path.join(servers, id) };
  }
  async function exists(filename) { try { return await io.lstat(filename); } catch (error) { if (absent(error)) return null; throw error; } }
  async function canonical(filename) {
    if (!path.isAbsolute(filename)) bad('STORAGE_PATH');
    let current = path.parse(filename).root;
    for (const component of filename.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await io.lstat(current);
      if (stat.isSymbolicLink()) bad('STORAGE_PATH');
    }
    if (await io.realpath(filename) !== filename) bad('STORAGE_PATH');
  }
  async function directory(filename, { create = false, privateMode = true } = {}) {
    if (!await exists(filename)) {
      if (!create) bad('STORAGE_MISSING');
      await canonical(path.dirname(filename));
      await io.mkdir(filename, { mode: 0o700 });
    }
    await canonical(filename);
    const stat = await io.lstat(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (privateMode && (stat.mode & 0o077) !== 0)) bad('STORAGE_PATH');
    return stat;
  }
  async function regular(filename, expectedIdentity = null) {
    await canonical(filename);
    const stat = await io.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || (expectedIdentity && !same(stamp(stat), expectedIdentity))) bad('STORAGE_PATH');
    return stat;
  }
  async function run(tool, args, extra = {}) {
    return command(tools[tool], args, { timeout, maxBuffer: 262144, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, ...extra });
  }
  function capability() {
    return { supported: initialized, fixedSupported: initialized, enforcement: initialized ? 'loop-ext4' : null, reason: initialized ? null : unsupported || messages.STORAGE_UNSUPPORTED[0], minDiskGiB: 1, maxDiskGiB: 65536, defaultDiskGiB: 5, growOnly: true, includesFilesystemMetadata: true, legacyUnlimitedSupported: true, physicalPreallocation: true };
  }
  async function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      try {
        if (platform !== 'linux' || uid !== 0) bad('STORAGE_UNSUPPORTED');
        const capSysAdmin = options.capSysAdmin ?? Boolean(BigInt(`0x${(await io.readFile('/proc/self/status', 'utf8')).match(/^CapEff:\s*([a-f0-9]+)$/im)?.[1] || '0'}`) & (1n << 21n));
        if (!capSysAdmin) bad('STORAGE_UNSUPPORTED');
        await directory(dataDir); await directory(images, { create: true }); await directory(servers, { create: true });
        for (const tool of Object.keys(tools)) await io.access(tools[tool], 1);
        initialized = true; unsupported = null;
      } catch { initialized = false; unsupported = messages.STORAGE_UNSUPPORTED[0]; }
      return capability();
    })();
    return initializePromise;
  }
  async function requireReady() {
    if (closed) throw issue('STORAGE_CLOSED', 503);
    if (!initialized) throw issue('STORAGE_UNSUPPORTED');
    await directory(dataDir); await directory(images); await directory(servers);
  }
  async function writeRecord(filename, value, { create = false } = {}) {
    const temporary = path.join(images, `.record-${makeUUID()}.tmp`);
    const before = await exists(filename);
    if (create && before) bad('STORAGE_EXISTS');
    if (before) await regular(filename);
    let identity;
    try {
      await io.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
      identity = stamp(await regular(temporary));
      const handle = await io.open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      if (before) await regular(filename, stamp(before));
      else if (await exists(filename)) bad('STORAGE_EXISTS');
      await io.rename(temporary, filename);
    } finally {
      const stat = await exists(temporary);
      if (stat && identity && same(stamp(stat), identity)) await io.unlink(temporary);
    }
  }
  async function load(server) {
    const entry = names(server);
    await directory(images); await directory(servers);
    const stat = await exists(entry.recordPath);
    if (!stat) bad('STORAGE_MISSING');
    await regular(entry.recordPath);
    if (stat.size > 16384) bad('STORAGE_PATH');
    let record;
    try { record = JSON.parse(await io.readFile(entry.recordPath, 'utf8')); } catch { bad('STORAGE_PATH'); }
    if (record.schemaVersion !== 1 || record.serverId !== entry.id || !UUID.test(record.filesystemUUID || '') || !Number.isSafeInteger(record.bytes) || record.bytes < 1024 ** 3 || (record.pendingGrowBytes !== null && (!Number.isSafeInteger(record.pendingGrowBytes) || record.pendingGrowBytes <= record.bytes))) bad('STORAGE_PATH');
    const imageStat = await regular(entry.image);
    if (imageStat.size !== record.bytes && imageStat.size !== record.pendingGrowBytes) bad('STORAGE_PATH');
    return { ...entry, record, imageIdentity: stamp(imageStat), imageStat };
  }
  async function absentPair(server) {
    const entry = names(server);
    const image = await exists(entry.image), record = await exists(entry.recordPath);
    if (image || record) return false;
    if (await exists(entry.target)) {
      await directory(entry.target);
      if (await mountEntry(entry.target)) bad('STORAGE_FOREIGN');
    }
    if ((await loops()).some(loop => String(loop['back-file'] || '').replace(/ \(deleted\)$/, '') === entry.image)) bad('STORAGE_BUSY');
    return true;
  }
  async function filesystem(entry) {
    await regular(entry.image, entry.imageIdentity);
    const { stdout } = await run('fsinfo', ['-h', entry.image]);
    const uuid = stdout.match(/^Filesystem UUID:\s*([a-f0-9-]+)\s*$/im)?.[1];
    const blocks = Number(stdout.match(/^Block count:\s*(\d+)\s*$/im)?.[1]);
    const blockSize = Number(stdout.match(/^Block size:\s*(\d+)\s*$/im)?.[1]);
    const bytes = blocks * blockSize;
    if (uuid?.toLowerCase() !== entry.record.filesystemUUID.toLowerCase() || !Number.isSafeInteger(bytes) || bytes < entry.record.bytes || bytes > (entry.record.pendingGrowBytes || entry.record.bytes)) bad('STORAGE_FOREIGN');
    return { uuid, bytes };
  }
  async function mountEntry(target) {
    let result;
    try { result = await run('findmnt', ['--json', '--mountpoint', target, '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS,UUID'], { timeout: 10000 }); }
    catch (error) { if (Number(error.code) === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) return null; throw error; }
    let rows;
    try { rows = JSON.parse(result.stdout).filesystems; } catch { bad('STORAGE_FOREIGN'); }
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].target !== target) bad('STORAGE_FOREIGN');
    return rows[0];
  }
  async function loops() {
    const { stdout } = await run('losetup', ['--json', '--list', '--output', 'NAME,BACK-FILE,OFFSET,SIZELIMIT,AUTOCLEAR'], { timeout: 10000 });
    try { const rows = JSON.parse(stdout).loopdevices; if (!Array.isArray(rows)) bad('STORAGE_FOREIGN'); return rows; }
    catch { bad('STORAGE_FOREIGN'); }
  }
  async function ownedMount(entry, mounted) {
    if (mounted === undefined) mounted = await mountEntry(entry.target);
    if (!mounted) return null;
    if (mounted.fstype !== 'ext4' || !/^\/dev\/loop\d+$/.test(mounted.source || '') || !['rw', 'nodev', 'nosuid'].every(flag => String(mounted.options || '').split(',').includes(flag))) bad('STORAGE_FOREIGN');
    const candidates = (await loops()).filter(row => row.name === mounted.source);
    if (candidates.length !== 1 || candidates[0]['back-file'] !== entry.image || Number(candidates[0].offset) !== 0 || Number(candidates[0].sizelimit) !== 0 || (mounted.uuid && mounted.uuid.toLowerCase() !== entry.record.filesystemUUID.toLowerCase())) bad('STORAGE_FOREIGN');
    await regular(entry.image, entry.imageIdentity);
    return mounted;
  }
  async function allocated(entry) {
    const stat = await regular(entry.image, entry.imageIdentity);
    if (!Number.isSafeInteger(stat.blocks) || stat.blocks * 512 < stat.size) bad('STORAGE_ALLOCATION');
    return stat;
  }
  async function point(entry, { create = false } = {}) {
    await directory(entry.target, { create });
    if ((await io.readdir(entry.target)).length) bad('STORAGE_UNMOUNTED_DATA');
  }
  async function ensure(entry) {
    await filesystem(entry); await allocated(entry);
    const existing = await mountEntry(entry.target);
    if (existing) { await ownedMount(entry, existing); return; }
    await point(entry, { create: true });
    await run('mount', ['--types', 'ext4', '--options', 'loop,nodev,nosuid,noatime,nodiscard,noinit_itable', '--', entry.image, entry.target]);
    if (!await ownedMount(entry)) bad('STORAGE_FOREIGN');
    await io.chmod(entry.target, 0o700);
  }
  async function lock(server, callback, mountPolicy = null) {
    const { id } = names(server);
    const active = operations.get(id), check = mountChecks.get(id);
    if (active) {
      // Only callers awaiting this exact verification may share its result.
      // Mutators and different desired policies retain exclusive admission.
      if (mountPolicy !== null && check?.policy === mountPolicy && check.operation === active) {
        if (closed) throw issue('STORAGE_CLOSED', 503);
        return { ...await active };
      }
      throw issue('STORAGE_BUSY');
    }
    const operation = Promise.resolve().then(callback);
    operations.set(id, operation);
    if (mountPolicy !== null) mountChecks.set(id, { policy: mountPolicy, operation });
    try { return await operation; } finally {
      if (mountChecks.get(id)?.operation === operation) mountChecks.delete(id);
      operations.delete(id); statsCache.delete(id);
    }
  }
  const desiredBytes = server => storageLimitBytes(server.storagePolicy, { legacy: true });
  async function fixedStats(server, entry = null) {
    entry ||= await load(server);
    const mounted = await ownedMount(entry);
    if (!mounted) throw issue('STORAGE_MISSING');
    const info = entry.record.pendingGrowBytes ? await filesystem(entry) : { bytes: entry.record.bytes };
    await allocated(entry);
    const stat = await io.statfs(entry.target);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize), availableBytes = Number(stat.bavail) * Number(stat.bsize);
    if (![totalBytes, availableBytes].every(Number.isSafeInteger) || totalBytes < 0 || availableBytes < 0 || availableBytes > totalBytes || totalBytes > info.bytes) bad('STORAGE_FOREIGN');
    return { mode: 'fixed', limitBytes: info.bytes, totalBytes, usedBytes: totalBytes - availableBytes, availableBytes, hardEnforced: true, enforcement: 'loop-ext4', reason: null, desiredLimitBytes: desiredBytes(server), needsGrow: desiredBytes(server) > info.bytes, sampledAt: new Date(now()).toISOString() };
  }
  async function legacyStats(server) {
    const entry = names(server);
    await canonical(dataDir); await canonical(servers); await canonical(entry.target);
    const stat = await io.lstat(entry.target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) bad('STORAGE_PATH');
    const { stdout } = await run('du', ['--summarize', '--one-file-system', '--block-size=1', '--', entry.target], { timeout: 15000 });
    const match = stdout.match(/^(\d+)\s/); const usedBytes = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(usedBytes)) throw issue('STORAGE_IO');
    return { mode: 'unlimited', limitBytes: null, totalBytes: null, usedBytes, availableBytes: null, hardEnforced: false, enforcement: null, reason: 'This existing directory has no kernel-enforced storage limit.', sampledAt: new Date(now()).toISOString() };
  }
  async function stats(server, { fresh = false } = {}) {
    const entry = names(server), policy = normalizeStoragePolicy(server.storagePolicy, { legacy: true });
    const key = JSON.stringify(policy), cached = statsCache.get(entry.id), ttl = 5000;
    if (!fresh && cached?.key === key && now() - cached.time < ttl) return { ...await cached.promise };
    const promise = (policy.mode === 'fixed' ? fixedStats(server) : legacyStats(server)).catch(() => ({ mode: policy.mode, limitBytes: null, totalBytes: null, usedBytes: null, availableBytes: null, hardEnforced: false, enforcement: null, reason: 'Storage usage or mount verification is unavailable.', sampledAt: new Date(now()).toISOString() }));
    statsCache.set(entry.id, { key, time: now(), promise });
    return { ...await promise };
  }
  return {
    initialize,
    capabilities: async () => capability(),
    stats,
    async provision(server) {
      return lock(server, async () => {
        await requireReady();
        const policy = normalizeStoragePolicy(server.storagePolicy), bytes = storageLimitBytes(policy), entry = names(server);
        if (await exists(entry.image) || await exists(entry.recordPath) || await mountEntry(entry.target)) bad('STORAGE_EXISTS');
        await point(entry, { create: true });
        const record = { schemaVersion: 1, serverId: entry.id, filesystemUUID: makeUUID(), bytes, pendingGrowBytes: null, createdAt: new Date(now()).toISOString() };
        if (!UUID.test(record.filesystemUUID)) bad('STORAGE_INPUT');
        let imageIdentity = null, recordIdentity = null;
        try {
          await io.writeFile(entry.image, '', { flag: 'wx', mode: 0o600 }); imageIdentity = stamp(await regular(entry.image));
          await run('fallocate', ['--length', String(bytes), '--', entry.image]);
          await regular(entry.image, imageIdentity);
          await run('mkfs', ['-q', '-t', 'ext4', '-F', '-m', '0', '-U', record.filesystemUUID, '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', entry.image]);
          const owned = { ...entry, record, imageIdentity };
          await filesystem(owned); await allocated(owned);
          await writeRecord(entry.recordPath, record, { create: true }); recordIdentity = stamp(await regular(entry.recordPath));
          await ensure(owned);
          return await fixedStats({ ...server, storagePolicy: policy }, owned);
        } catch (cause) {
          const error = issue(Object.hasOwn(messages, cause?.code) ? cause.code : 'STORAGE_IO', cause?.status || 409, { cause });
          try {
            const owned = { ...entry, record, imageIdentity };
            const mounted = await mountEntry(entry.target);
            if (mounted) { await ownedMount(owned, mounted); await run('umount', ['--', entry.target]); }
            if ((await loops()).some(loop => loop['back-file'] === entry.image)) bad('STORAGE_BUSY');
            if (imageIdentity && await exists(entry.image)) { await regular(entry.image, imageIdentity); await io.unlink(entry.image); }
            if (recordIdentity) { await regular(entry.recordPath, recordIdentity); await io.unlink(entry.recordPath); }
          } catch { error.cleanupPending = `.storage/${entry.id}.img`; }
          throw error;
        }
      });
    },
    async ensureMounted(server) {
      const policy = normalizeStoragePolicy(server.storagePolicy, { legacy: true });
      if (policy.mode === 'unlimited') return stats(server);
      // Snapshot the validated identity/policy before any asynchronous work.
      const target = { id: names(server).id, storagePolicy: policy };
      return lock(target, async () => { await requireReady(); const entry = await load(target); await ensure(entry); return fixedStats(target, entry); }, JSON.stringify(policy));
    },
    async isMounted(server) {
      if (normalizeStoragePolicy(server.storagePolicy, { legacy: true }).mode === 'unlimited') return false;
      await requireReady(); if (await absentPair(server)) return false;
      return Boolean(await ownedMount(await load(server)));
    },
    async growthAdditionalBytes(server, requestedPolicy = server.storagePolicy) {
      await requireReady();
      const policy = normalizeStoragePolicy(requestedPolicy), target = storageLimitBytes(policy), entry = await load(server);
      if (target < entry.record.bytes || (entry.record.pendingGrowBytes && entry.record.pendingGrowBytes !== target)) bad('STORAGE_GROW_ONLY');
      const image = await regular(entry.image, entry.imageIdentity);
      if (!Number.isSafeInteger(image.blocks) || image.blocks < 0) bad('STORAGE_ALLOCATION');
      return Math.max(0, target - Math.min(target, image.blocks * 512));
    },
    async unmount(server) {
      if (normalizeStoragePolicy(server.storagePolicy, { legacy: true }).mode === 'unlimited') return { ok: true, unmounted: false };
      return lock(server, async () => {
        await requireReady(); if (await absentPair(server)) return { ok: true, unmounted: false, absent: true };
        const entry = await load(server), mounted = await ownedMount(entry);
        if (!mounted) { await point(entry); return { ok: true, unmounted: false }; }
        try { await run('umount', ['--', entry.target]); } catch { throw issue('STORAGE_BUSY'); }
        if (await mountEntry(entry.target)) bad('STORAGE_BUSY');
        await point(entry); return { ok: true, unmounted: true };
      });
    },
    // Call only AFTER the server metadata deletion commits. Until then unmount
    // keeps both image and record intact, allowing the manager to roll back.
    async remove(server) {
      if (normalizeStoragePolicy(server.storagePolicy, { legacy: true }).mode === 'unlimited') return { ok: true, removed: false };
      return lock(server, async () => {
        await requireReady(); if (await absentPair(server)) return { ok: true, removed: false, absent: true };
        const entry = await load(server);
        if (await exists(entry.target)) { await directory(entry.target); if (await mountEntry(entry.target)) bad('STORAGE_BUSY'); }
        if ((await loops()).some(loop => loop['back-file'] === entry.image)) bad('STORAGE_BUSY');
        await regular(entry.image, entry.imageIdentity); const recordStat = await regular(entry.recordPath);
        await io.unlink(entry.image); await regular(entry.recordPath, stamp(recordStat)); await io.unlink(entry.recordPath);
        return { ok: true, removed: true };
      });
    },
    // Manager must durably record the desired larger policy BEFORE this job.
    // In-place filesystem growth cannot be reversed by shrinking on an error.
    // A private pendingGrowBytes marker makes interrupted growth retryable.
    async grow(server, requestedPolicy = server.storagePolicy) {
      return lock(server, async () => {
        await requireReady(); const policy = normalizeStoragePolicy(requestedPolicy), targetBytes = storageLimitBytes(policy), entry = await load(server);
        if (targetBytes !== desiredBytes(server) || targetBytes < entry.record.bytes || (entry.record.pendingGrowBytes && entry.record.pendingGrowBytes !== targetBytes)) bad('STORAGE_GROW_ONLY');
        let current = await filesystem(entry);
        const resizeNeeded = current.bytes !== targetBytes;
        const mounted = await ownedMount(entry);
        if (mounted) { try { await run('umount', ['--', entry.target]); } catch { throw issue('STORAGE_BUSY'); } }
        if (await mountEntry(entry.target)) bad('STORAGE_BUSY');
        await point(entry);
        if (resizeNeeded && !entry.record.pendingGrowBytes) { entry.record = { ...entry.record, pendingGrowBytes: targetBytes }; await writeRecord(entry.recordPath, entry.record); }
        try {
          await regular(entry.image, entry.imageIdentity);
          // Explicit same-size retries also repair a physically sparse owned
          // image, after the manager admits its fresh remaining block cost.
          await run('fallocate', ['--length', String(targetBytes), '--', entry.image]);
          await allocated(entry);
          if (resizeNeeded) {
            try { await run('fsck', ['-f', '-p', '-E', 'nodiscard', entry.image]); } catch (error) { if (Number(error.code) !== 1) throw error; }
            // resize2fs normally leaves new inode tables for ext4lazyinit.
            // That later WRITE_ZEROES can punch holes in a loop backing file
            // after an apparently successful mount. Initialize synchronously,
            // and make libext2fs write zeroes without unmapping reserved space.
            const resizeEnvironment = { ...process.env, LC_ALL: 'C', RESIZE2FS_FORCE_ITABLE_INIT: '1', UNIX_IO_NOZEROOUT: '1' };
            delete resizeEnvironment.RESIZE2FS_FORCE_LAZY_ITABLE_INIT;
            await run('resize', ['-f', entry.image], { env: resizeEnvironment });
          }
          current = await filesystem(entry); if (current.bytes !== targetBytes) bad('STORAGE_IO');
          // Reclaim no reservations as durable completion until the enlarged
          // filesystem is physically allocated after all ext4 utilities ran.
          await run('fallocate', ['--length', String(targetBytes), '--', entry.image]);
          await allocated(entry);
          if (entry.record.bytes !== targetBytes || entry.record.pendingGrowBytes) {
            entry.record = { ...entry.record, bytes: targetBytes, pendingGrowBytes: null };
            await writeRecord(entry.recordPath, entry.record);
          }
          await ensure(entry); return fixedStats(server, entry);
        } catch (cause) {
          const error = issue(Object.hasOwn(messages, cause?.code) ? cause.code : 'STORAGE_IO', cause?.status || 409, { desiredLimitBytes: targetBytes, growthPending: true });
          // Preserve image/record and make a best effort to remount the actual
          // existing filesystem; the manager must still block start if smaller.
          try { await ensure(await load(server)); } catch { error.cleanupPending = `.storage/${entry.id}.img`; }
          throw error;
        }
      });
    },
    async close() { closed = true; await Promise.allSettled([...operations.values()]); },
  };
}
