import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const units = Object.freeze({ panel: 'vortex-panel.service', worker: 'vortex-node.service' });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['completed', 'failed']);
const messages = {
  ZRAM_INPUT: ['Invalid system memory assistance request.', 'Yêu cầu hỗ trợ bộ nhớ hệ thống không hợp lệ.'],
  ZRAM_CONFIRM: ['Review and explicitly confirm this system memory change.', 'Hãy xem lại và xác nhận thay đổi bộ nhớ hệ thống.'],
  ZRAM_TARGET: ['The selected VPS changed. Refresh its details.', 'VPS được chọn đã thay đổi. Hãy tải lại chi tiết.'],
  ZRAM_STALE: ['The VPS configuration changed. Refresh before confirming again.', 'Cấu hình VPS đã thay đổi. Hãy tải lại trước khi xác nhận.'],
  ZRAM_UNAVAILABLE: ['System memory assistance requires the managed Linux service with administrator privileges.', 'Hỗ trợ bộ nhớ hệ thống cần dịch vụ Linux được quản lý với quyền quản trị.'],
  ZRAM_MODULE: ['The running VPS kernel is missing compressed-memory support. Install its matching system modules before enabling this feature.', 'Kernel đang chạy trên VPS chưa có hỗ trợ bộ nhớ nén. Cần cài mô-đun phù hợp với kernel trước khi bật tính năng này.'],
  ZRAM_EXTERNAL: ['An existing memory assistance configuration is managed outside Vortex and is preserved.', 'Cấu hình hỗ trợ bộ nhớ hiện tại được quản lý ngoài Vortex và sẽ được giữ nguyên.'],
  ZRAM_OWNERSHIP: ['Ownership could not be verified. Existing system memory settings are preserved.', 'Chưa xác minh được quyền quản lý. Các thiết lập bộ nhớ hiện tại được giữ nguyên.'],
  ZRAM_PRESSURE: ['There is insufficient free physical RAM to disable memory assistance safely. Reduce memory use and try again.', 'RAM vật lý còn trống chưa đủ để tắt hỗ trợ bộ nhớ an toàn. Hãy giảm mức sử dụng bộ nhớ rồi thử lại.'],
  ZRAM_BUSY: ['Another VPS maintenance or server operation is in progress.', 'Một thao tác bảo trì VPS hoặc xử lý máy chủ khác đang chạy.'],
  ZRAM_AUDIT: ['The operation could not be saved. No new system change was started.', 'Không lưu được thao tác. Chưa bắt đầu thay đổi hệ thống mới.'],
  ZRAM_RECOVERY: ['A previous system memory operation could not be verified. Changes remain paused; an administrator must inspect the service log.', 'Chưa xác minh được thao tác bộ nhớ hệ thống trước đó. Các thay đổi vẫn tạm dừng; quản trị viên cần kiểm tra nhật ký dịch vụ.'],
  ZRAM_SYSTEM: ['The system could not complete this change. Refresh its actual status before trying again.', 'Hệ thống chưa hoàn tất thay đổi. Hãy tải lại trạng thái thực tế trước khi thử lại.'],
  ZRAM_UNKNOWN: ['The operation outcome is unknown. Refresh its status; do not submit it again automatically.', 'Chưa xác định được kết quả thao tác. Hãy tải lại trạng thái; không tự động gửi lại.'],
  ZRAM_CLOSED: ['This service is stopping and cannot change system memory assistance.', 'Dịch vụ đang dừng và chưa thể thay đổi hỗ trợ bộ nhớ hệ thống.'],
};
const metadata = code => ({ id: `panel.zram.${code.slice(5).toLowerCase()}`, en: messages[code][0], vi: messages[code][1], params: [] });
const problem = (code, status = 409, extra = {}) => Object.assign(new Error(messages[code]?.[0] || messages.ZRAM_UNKNOWN[0]), { code, status, ...extra });
export const ZRAM_MESSAGES = Object.freeze(Object.keys(messages).map(metadata));
export function hostZramErrorPayload(error, language = 'en') {
  if (!messages[error?.code]) return null;
  const errorI18n = metadata(error.code);
  return { code: error.code, error: errorI18n[language === 'vi' ? 'vi' : 'en'], errorI18n,
    ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(error.zram ? { zram: error.zram } : {}) };
}
export const systemMemoryErrorPayload = hostZramErrorPayload;
export function validateZramRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['nodeId', 'enabled', 'profile', 'confirmed', 'revision', 'requestId'].includes(key)) || typeof input.enabled !== 'boolean' || input.profile !== 'auto') throw problem('ZRAM_INPUT', 400);
  if (input.confirmed !== true) throw problem('ZRAM_CONFIRM', 400);
  if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 128) throw problem('ZRAM_TARGET', 400);
  if (!/^[a-f0-9]{64}$/.test(input.revision || '')) throw problem('ZRAM_STALE', 409);
  if (!uuid.test(input.requestId || '')) throw problem('ZRAM_INPUT', 400);
  return input;
}

const commandOptions = { timeout: 8000, maxBuffer: 16384, encoding: 'utf8', windowsHide: true, shell: false,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: 'cat', SYSTEMD_COLORS: '0' } };
function assertHelperOwnership(helperPath, io = fs) {
  if (!path.posix.isAbsolute(helperPath) || path.posix.normalize(helperPath) !== helperPath) throw problem('ZRAM_OWNERSHIP');
  for (let parent = path.posix.dirname(helperPath);; parent = path.posix.dirname(parent)) {
    const info = io.lstatSync(parent);
    if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o022) throw problem('ZRAM_OWNERSHIP');
    if (parent === '/') break;
  }
  const stat = io.lstatSync(helperPath), bundled = fileURLToPath(new URL('./host-zram.py', import.meta.url));
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || stat.mode & 0o022 || createHash('sha256').update(io.readFileSync(helperPath)).digest('hex') !== createHash('sha256').update(io.readFileSync(bundled)).digest('hex')) throw problem('ZRAM_OWNERSHIP');
}
export async function probeHostZramCapabilities({ role, processId = process.pid, platform = process.platform, uid = process.getuid?.(),
  helperPath = '/usr/local/libexec/vortex-host-zram.py', execFile = promisify(nodeExecFile), io = fs } = {}) {
  if (!units[role] || platform !== 'linux' || uid !== 0) throw problem('ZRAM_UNAVAILABLE', 409);
  for (const executable of ['/usr/bin/python3', '/usr/sbin/modprobe', '/usr/sbin/mkswap', '/usr/sbin/swapon', '/usr/sbin/swapoff', '/usr/sbin/zramctl', '/usr/sbin/blkid']) io.accessSync(executable, fs.constants.X_OK);
  assertHelperOwnership(helperPath, io);
  io.accessSync('/run/systemd/system');
  try { await execFile('/usr/bin/systemd-detect-virt', ['--container', '--quiet'], commandOptions); throw problem('ZRAM_UNAVAILABLE'); }
  catch (error) { if (error.code !== 1) throw problem('ZRAM_UNAVAILABLE'); }
  try { await execFile('/usr/sbin/modprobe', ['--dry-run', '--ignore-install', 'zram', 'num_devices=0'], commandOptions); }
  catch { throw problem('ZRAM_MODULE'); }
  const result = await execFile('/usr/bin/systemctl', ['--no-ask-password', 'show', units[role], '--property=MainPID', '--property=ActiveState', '--property=TimeoutStopUSec'], commandOptions);
  const value = Object.fromEntries(result.stdout.trim().split('\n').map(row => row.split('=')));
  const grace = value.TimeoutStopUSec || '', factors = { us: 0.000001, ms: 0.001, s: 1, min: 60, h: 3600, d: 86400 };
  const seconds = [...grace.matchAll(/([\d.]+)(us|ms|s|min|h|d)/g)].reduce((sum, match) => sum + Number(match[1]) * factors[match[2]], 0);
  if (Number(value.MainPID) !== processId || value.ActiveState !== 'active' || grace !== 'infinity' && seconds < 180) throw problem('ZRAM_UNAVAILABLE');
  assertHelperOwnership(helperPath, io);
  return { available: true, serviceId: units[role] };
}
function nativeHelper(helperPath, action, value) {
  assertHelperOwnership(helperPath);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [helperPath, action], { ...commandOptions, timeout: undefined, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, settled = false, timer;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(problem('ZRAM_UNKNOWN', 504, { outcomeUnknown: true })); }, action === 'apply' ? 150000 : 15000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { size += chunk.length; if (size > 65536) { child.kill('SIGKILL'); finish(problem('ZRAM_UNKNOWN', 502, { outcomeUnknown: true })); } else if (stream === child.stdout) output += chunk; });
    child.on('error', () => finish(problem('ZRAM_UNAVAILABLE', 503)));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      let result;
      try { result = JSON.parse(output); } catch { return finish(problem('ZRAM_UNKNOWN', 502, { outcomeUnknown: action === 'apply' })); }
      if (!result.ok) return finish(problem(messages[result.code] ? result.code : 'ZRAM_UNKNOWN', 409, { outcomeUnknown: result.outcomeUnknown === true }));
      finish(null, result.zram);
    });
    child.stdin.end(JSON.stringify(value));
  });
}

export function createHostZramController({ role = 'panel', nodeId = 'local', dataDir, store, manager,
  helperPath = '/usr/local/libexec/vortex-host-zram.py', platform = process.platform, uid = process.getuid?.(), processId = process.pid,
  instanceId = randomUUID(), execFile = promisify(nodeExecFile), inspect, apply, now = Date.now } = {}) {
  if (!units[role] || !dataDir || typeof nodeId !== 'string' || !nodeId) throw new Error('Managed role, node identity and data directory are required.');
  const filename = path.join(dataDir, 'zram-operations.json');
  let records = [], initialized = false, closed = false, locked = false, storageFailure = false, releaseMaintenance, active, flight;
  const time = () => new Date(now()).toISOString();
  const copy = value => value == null ? value : structuredClone(value);
  function save() {
    const temp = `${filename}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, nodeId, role, records: records.filter((r, i) => r.instanceId === instanceId || i >= records.length - 64) }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, filename);
      if (process.platform === 'linux') { const directory = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  function init() {
    if (initialized) return;
    initialized = true;
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (value.schema !== 1 || value.nodeId !== nodeId || value.role !== role || !Array.isArray(value.records) || value.records.length > 512) throw Error('Invalid zram journal');
      for (const row of value.records) if (!uuid.test(row.requestId || '') || typeof row.enabled !== 'boolean' || !['running', 'completed', 'failed', 'unknown'].includes(row.status) || !/^[a-f0-9]{64}$/.test(row.revision || '') || typeof row.instanceId !== 'string') throw Error('Invalid zram record');
      records = value.records;
      active = records.findLast(row => !terminal.has(row.status));
      if (active) active.status = 'unknown';
    } catch (error) { if (error.code !== 'ENOENT') storageFailure = true; }
  }
  async function capability() {
    return probeHostZramCapabilities({ role, processId, platform, uid, helperPath, execFile });
  }
  async function observe() {
    if (inspect) return inspect();
    await capability();
    return nativeHelper(helperPath, 'inspect', { role, nodeId });
  }
  function publicValue(value) {
    const reasonCode = storageFailure ? 'ZRAM_RECOVERY' : closed ? 'ZRAM_CLOSED' : value.reasonCode;
    return { nodeId, available: value.available === true && !storageFailure && !closed, reason: reasonCode ? messages[reasonCode]?.[0] || messages.ZRAM_UNAVAILABLE[0] : null,
      reasonI18n: reasonCode && messages[reasonCode] ? metadata(reasonCode) : null, ownership: value.ownership || 'none',
      physicalMemoryBytes: value.physicalMemoryBytes, configured: value.configured || { enabled: false, profile: 'auto' },
      effective: copy(value.effective) || { enabled: false, logicalSizeBytes: 0, swapUsedBytes: 0, originalDataBytes: null, compressedDataBytes: null, residentBytes: 0 },
      swapSummary: copy(value.swapSummary) || null,
      observedAt: typeof value.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.observedAt) ? value.observedAt : null,
      recommended: value.recommended,
      revision: hash([nodeId, role, instanceId, value.revision]), busy: !!active || locked || manager?.maintenanceStatus?.()?.active === true, lastOperation: copy(records.at(-1) || null) };
  }
  function release() { releaseMaintenance?.(); releaseMaintenance = null; active = null; }
  async function read() {
    init();
    // A damaged intent journal can hide an OS operation that outlived the
    // process. Keep the same host exclusion as an observed unknown operation.
    if (storageFailure && !active) active = { requestId: randomUUID(), status: 'unknown', errorCode: 'ZRAM_RECOVERY' };
    let observed;
    try { observed = await observe(); }
    catch (error) { observed = { available: false, reasonCode: messages[error.code] ? error.code : 'ZRAM_UNAVAILABLE', physicalMemoryBytes: os.totalmem(), revision: 'unavailable' }; }
    if (!active && ['running', 'unknown'].includes(observed.operation?.status) && uuid.test(observed.operation.requestId || '') && typeof observed.operation.enabled === 'boolean') {
      active = { requestId: observed.operation.requestId, enabled: observed.operation.enabled, status: 'unknown', requestedAt: time(),
        revision: hash([nodeId, role, instanceId, observed.revision]), instanceId, actor: 'recovered-host-operation', errorCode: 'ZRAM_UNKNOWN' };
      records.push(active);
      try { save(); } catch { storageFailure = true; }
    }
    if (active && active.status === 'unknown' && observed.operation?.requestId === active.requestId && terminal.has(observed.operation.status)) {
      Object.assign(active, { status: observed.operation.status, completedAt: time(), ...(observed.operation.errorCode ? { errorCode: observed.operation.errorCode } : {}) });
      try { save(); release(); } catch { storageFailure = true; }
    }
    if (active && !releaseMaintenance) {
      releaseMaintenance = await manager.beginMaintenance({ action: 'zram', requestId: active.requestId, restore: true });
      if (typeof releaseMaintenance !== 'function') throw problem('ZRAM_BUSY');
    }
    return publicValue(observed);
  }
  async function perform(input, user) {
    const before = await read();
    if (input.revision !== before.revision) throw problem('ZRAM_STALE', 409, { zram: before });
    if (!before.available) throw problem(storageFailure ? 'ZRAM_AUDIT' : before.reasonI18n?.id === metadata('ZRAM_EXTERNAL').id ? 'ZRAM_EXTERNAL' : 'ZRAM_UNAVAILABLE', 409, { zram: before });
    if (records.filter(row => row.instanceId === instanceId).length >= 256) throw problem('ZRAM_AUDIT', 503);
    const observed = await observe();
    if (publicValue(observed).revision !== before.revision) throw problem('ZRAM_STALE');
    try { releaseMaintenance = await manager.beginMaintenance({ action: 'zram', requestId: input.requestId }); }
    catch { throw problem('ZRAM_BUSY'); }
    if (typeof releaseMaintenance !== 'function') throw problem('ZRAM_BUSY');
    const row = { requestId: input.requestId, enabled: input.enabled, status: 'running', requestedAt: time(), revision: input.revision, instanceId, actor: user?.username || 'panel-system' };
    try { store.audit('host.zram.requested', JSON.stringify({ nodeId, requestId: row.requestId, enabled: row.enabled }), row.actor); records.push(row); save(); }
    catch { records = records.filter(r => r !== row); release(); throw problem('ZRAM_AUDIT', 503); }
    active = row;
    try {
      const result = await (apply ? apply({ ...input, role, revision: observed.revision }) : nativeHelper(helperPath, 'apply', { ...input, role, revision: observed.revision }));
      if (!result || result.effective?.enabled !== input.enabled || result.configured?.enabled !== input.enabled) throw problem('ZRAM_UNKNOWN', 502, { outcomeUnknown: true });
      row.status = 'completed'; row.completedAt = time(); save();
      store.audit('host.zram.completed', JSON.stringify({ nodeId, requestId: row.requestId, enabled: row.enabled }), row.actor);
      release();
      return { nodeId, replayed: false, operation: copy(row), zram: { ...publicValue(result), busy: manager?.maintenanceStatus?.()?.active === true } };
    } catch (cause) {
      const unknown = cause.outcomeUnknown === true || !messages[cause.code];
      row.status = unknown ? 'unknown' : 'failed'; row.errorCode = messages[cause.code] ? cause.code : 'ZRAM_UNKNOWN'; row.completedAt = time();
      try { save(); store.audit(`host.zram.${row.status}`, JSON.stringify({ nodeId, requestId: row.requestId, enabled: row.enabled }), row.actor); }
      catch { storageFailure = true; }
      if (!unknown) release();
      const zram = await read();
      if (!active) zram.busy = manager?.maintenanceStatus?.()?.active === true;
      throw problem(row.errorCode, cause.status || 409, { outcomeUnknown: unknown, zram });
    }
  }
  return { read, request(input, { user } = {}) {
    validateZramRequest(input); init();
    if (input.nodeId !== nodeId) return Promise.reject(problem('ZRAM_TARGET'));
    const previous = records.find(row => row.requestId === input.requestId);
    if (previous) {
      if (previous.enabled !== input.enabled || previous.revision !== input.revision) return Promise.reject(problem('ZRAM_INPUT'));
      return read().then(zram => ({ nodeId, replayed: true, operation: copy(previous), zram }));
    }
    if (closed) return Promise.reject(problem('ZRAM_CLOSED', 503));
    if (locked || active) return Promise.reject(problem('ZRAM_BUSY'));
    locked = true;
    flight = perform(input, user).finally(() => { locked = false; flight = null; });
    return flight;
  }, async close() { closed = true; await flight; } };
}

export async function sendZramRequest(controller, req, res, nodeId) {
  const value = await controller.request(req.body, { user: req.session?.user });
  res.json({ ...value, nodeId: nodeId || value.nodeId });
}
