import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const units = Object.freeze({ panel: 'bedrock-panel.service', worker: 'vortex-node.service' });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const pending = new Set(['accepted', 'dispatching', 'scheduled']);
const messages = {
  POWER_INPUT: ['Power requests accept only nodeId, action, confirmed, revision and requestId.', 'Yêu cầu khởi động lại chỉ chấp nhận nodeId, action, confirmed, revision và requestId.'],
  POWER_CONFIRM: ['Confirm this restart explicitly. Running game servers will briefly disconnect and resume after startup.', 'Cần xác nhận khởi động lại. Máy chủ trò chơi đang chạy sẽ tạm ngắt kết nối và được mở lại sau khi khởi động.'],
  POWER_STALE: ['This service has changed since the dialog opened. Refresh its status before trying again.', 'Dịch vụ đã thay đổi sau khi mở hộp thoại. Hãy tải lại trạng thái trước khi thử lại.'],
  POWER_TARGET: ['The selected VPS does not match this request. Refresh the VPS list.', 'VPS được chọn không khớp yêu cầu. Hãy tải lại danh sách VPS.'],
  POWER_REQUEST_ID: ['Use a new request identifier for each confirmed operation.', 'Dùng mã yêu cầu mới cho mỗi thao tác được xác nhận.'],
  POWER_BUSY: ['Another restart or server operation is in progress. Wait for it to finish.', 'Một thao tác khởi động lại hoặc xử lý máy chủ đang chạy. Hãy chờ hoàn tất.'],
  POWER_CLOSED: ['This service is stopping and cannot accept a new restart.', 'Dịch vụ đang dừng và chưa thể nhận yêu cầu khởi động lại mới.'],
  POWER_UNAVAILABLE: ['Restart controls require the managed Linux service with administrator privileges.', 'Tính năng khởi động lại cần dịch vụ Linux được quản lý với quyền quản trị.'],
  POWER_AUDIT: ['The restart request could not be saved. No system action was scheduled.', 'Không lưu được yêu cầu khởi động lại. Chưa lên lịch thao tác hệ thống.'],
  POWER_SCHEDULE_FAILED: ['The system could not schedule this restart. Review the service log before trying again.', 'Hệ thống không lên lịch được lần khởi động lại này. Hãy xem nhật ký dịch vụ trước khi thử lại.'],
  POWER_INTERRUPTED: ['The connection ended before the restart was scheduled. This request will not be sent again automatically.', 'Kết nối đã kết thúc trước khi lên lịch khởi động lại. Yêu cầu này sẽ không tự động gửi lại.'],
  POWER_NOT_COMPLETED: ['The requested restart was not observed within three minutes. New changes remain paused; an administrator must inspect the service log.', 'Chưa ghi nhận lần khởi động lại sau ba phút. Các thay đổi mới vẫn tạm dừng; quản trị viên cần kiểm tra nhật ký dịch vụ.'],
  POWER_UNKNOWN: ['The restart outcome is unknown. Reconnect and inspect its status; do not repeat the operation automatically.', 'Chưa xác định được kết quả khởi động lại. Hãy kết nối lại và kiểm tra trạng thái; không tự động gửi lại thao tác.'],
  POWER_REBOOT_PENDING: ['A previous VPS reboot could not be verified. Changes remain paused until a new boot is observed; an administrator must inspect the VPS.', 'Chưa xác minh được lần khởi động lại VPS trước đó. Các thay đổi vẫn tạm dừng đến khi ghi nhận lần khởi động mới; quản trị viên cần kiểm tra VPS.'],
};
const metadata = code => ({ id: `panel.power.${code.slice(6).toLowerCase()}`, params: [], en: messages[code][0], vi: messages[code][1] });
const fail = (code, status = 400, extra = {}) => Object.assign(new Error(messages[code][0]), { code, status, ...extra });
export const POWER_MESSAGES = Object.freeze(Object.keys(messages).map(code => metadata(code)));
export function systemPowerErrorPayload(error, language = 'en') {
  if (!messages[error?.code]) return null;
  const errorI18n = metadata(error.code);
  return { error: errorI18n[language === 'vi' ? 'vi' : 'en'], errorI18n, code: error.code,
    ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(error.power ? { power: error.power } : {}) };
}
export function validatePowerRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['nodeId', 'action', 'confirmed', 'revision', 'requestId'].includes(key)) || !['restart-service', 'reboot'].includes(input.action)) throw fail('POWER_INPUT');
  if (input.confirmed !== true) throw fail('POWER_CONFIRM');
  if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 128) throw fail('POWER_TARGET');
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) throw fail('POWER_STALE', 409);
  if (typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw fail('POWER_REQUEST_ID');
  return input;
}

const commandOptions = { timeout: 8000, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true, shell: false,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' } };

// These arguments never contain user input except a validated UUID in a private
// job name. The service target is selected exclusively from the role allowlist.
export function systemPowerCommand(role, action, requestId) {
  if (!units[role] || !['restart-service', 'reboot'].includes(action) || !uuid.test(requestId || '')) throw fail('POWER_INPUT');
  return { command: '/usr/bin/systemd-run', args: ['--quiet', '--no-ask-password', `--unit=vortex-power-${requestId}`, '--on-active=2s', '--timer-property=AccuracySec=1s', '--property=Type=oneshot', '--property=TimeoutStartSec=180s', '/usr/bin/systemctl', '--no-ask-password', ...(action === 'reboot' ? ['reboot'] : ['restart', units[role]])] };
}

export function createSystemPowerController({ role = 'panel', nodeId = 'local', dataDir, store, manager,
  platform = process.platform, uid = process.getuid?.(), processId = process.pid, instanceId = randomUUID(),
  bootId: injectedBootId,
  now = Date.now, execFile = promisify(nodeExecFile), probe, dispatch, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!units[role] || !dataDir || typeof nodeId !== 'string' || !nodeId) throw new Error('A fixed managed service role, node identity and data directory are required.');
  const serviceId = units[role], filename = path.join(dataDir, 'power-operations.json');
  let initialized, bootId = injectedBootId ?? null, records = [], closed = false, lock = false, active, timer, releaseMaintenance, storageFailure = false;
  const clone = value => value == null ? value : structuredClone(value);
  const recordTime = () => new Date(now()).toISOString();
  const revision = () => createHash('sha256').update(JSON.stringify([nodeId, serviceId, instanceId, bootId, processId])).digest('hex');
  function save() {
    const temp = `${filename}.${processId}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      // Retain every ID from the current generation, even after repeated failed
      // attempts; older generations are already rejected by their revision.
      const retained = records.filter((row, index) => row.baseline.instanceId === instanceId || index >= records.length - 256);
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, nodeId, serviceId, records: retained })); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      fs.renameSync(temp, filename);
      // fsync the directory where supported so an acknowledged intent survives
      // abrupt reboot as well as an orderly service restart.
      if (process.platform === 'linux') { const directory = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    } finally { if (fd !== null && fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  function audit(action, row) {
    if (typeof store?.audit !== 'function') throw fail('POWER_AUDIT', 503);
    store.audit(`host.power.${action}`, JSON.stringify({ nodeId, serviceId, requestId: row.requestId, action: row.action, status: row.status }), row.actor || 'panel-system');
  }
  async function init() {
    if (initialized) return initialized;
    initialized = (async () => {
      if (injectedBootId === undefined) try { bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { bootId = null; }
      try {
        const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (data.schema !== 1 || data.nodeId !== nodeId || data.serviceId !== serviceId || !Array.isArray(data.records) || data.records.length > 8192) throw new Error('Invalid power journal');
        records = data.records;
        for (const row of records) {
          if (!uuid.test(row.requestId || '') || !['restart-service', 'reboot'].includes(row.action) || !row.baseline || typeof row.baseline.instanceId !== 'string') throw new Error('Invalid power journal');
          if (!(pending.has(row.status) || row.status === 'unknown') || row.baseline.instanceId === instanceId) continue;
          const observed = row.action === 'reboot' ? bootId && bootId !== row.baseline.bootId : instanceId !== row.baseline.instanceId;
          row.status = observed && row.dispatchStartedAt ? 'completed' : 'unknown'; row.completedAt = recordTime();
          if (row.status === 'unknown') row.error = 'POWER_UNKNOWN';
          else delete row.error;
          try { audit(row.status, row); } catch {}
        }
        save();
      } catch (error) { if (error.code !== 'ENOENT') storageFailure = true; }
      const unresolvedReboot = records.filter(row => row.action === 'reboot' && row.status === 'unknown' && row.dispatchStartedAt && row.baseline.bootId === bootId).at(-1);
      if (!storageFailure && unresolvedReboot) {
        active = unresolvedReboot;
        try {
          releaseMaintenance = await manager.beginMaintenance({ action: 'reboot', requestId: unresolvedReboot.requestId, restore: true });
          if (typeof releaseMaintenance !== 'function') throw new Error('Missing restored admission lock');
        } catch { throw fail('POWER_REBOOT_PENDING', 503); }
      }
    })();
    return initialized;
  }
  async function nativeProbe() {
    if (platform !== 'linux' || uid !== 0 || !bootId) return { available: false, reasonCode: 'POWER_UNAVAILABLE' };
    try {
      fs.accessSync('/run/systemd/system'); fs.accessSync('/usr/bin/systemd-run', fs.constants.X_OK);
      const result = await execFile('/usr/bin/systemctl', ['--no-ask-password', 'show', serviceId, '--property=MainPID', '--property=ActiveState', '--property=TimeoutStopUSec'], commandOptions);
      const values = Object.fromEntries(String(result.stdout).trim().split('\n').map(line => line.split('=')));
      const grace = String(values.TimeoutStopUSec || '');
      const durations = [...grace.matchAll(/([\d.]+)(us|ms|s|min|h|d)/g)];
      const seconds = durations.reduce((sum, match) => sum + Number(match[1]) * ({ us: 0.000001, ms: 0.001, s: 1, min: 60, h: 3600, d: 86400 }[match[2]]), 0);
      if (Number(values.MainPID) !== processId || values.ActiveState !== 'active' || grace !== 'infinity' && seconds < 60) return { available: false, reasonCode: 'POWER_UNAVAILABLE' };
      return { available: true };
    } catch { return { available: false, reasonCode: 'POWER_UNAVAILABLE' }; }
  }
  async function read() {
    await init();
    const capabilities = closed ? { available: false, reasonCode: 'POWER_CLOSED' } : storageFailure ? { available: false, reasonCode: 'POWER_AUDIT' } : await (probe || nativeProbe)();
    const reasonCode = capabilities.reasonCode || (active?.action === 'reboot' && active.status === 'unknown' ? 'POWER_REBOOT_PENDING' : null);
    return { nodeId, role, serviceId, instanceId, bootId, processId, revision: revision(), busy: !!active || manager?.maintenanceStatus?.()?.active === true, available: capabilities.available === true && !closed && !storageFailure,
      actions: capabilities.available === true && !closed && !storageFailure ? ['restart-service', 'reboot'] : [], reason: reasonCode ? messages[reasonCode]?.[0] || messages.POWER_UNAVAILABLE[0] : null,
      reasonI18n: reasonCode && messages[reasonCode] ? metadata(reasonCode) : null, lastOperation: clone(records.at(-1) || null) };
  }
  function release() { clearTimer(timer); timer = null; releaseMaintenance?.(); releaseMaintenance = null; active = null; }
  function result(row, power, replayed) { return { nodeId, accepted: pending.has(row.status), replayed, operation: clone(row), power }; }
  async function request(input, { user } = {}) {
    validatePowerRequest(input);
    if (input.nodeId !== nodeId) throw fail('POWER_TARGET', 409);
    await init();
    const previous = records.find(row => row.requestId === input.requestId);
    if (previous) {
      if (previous.action !== input.action || previous.baseline.revision !== input.revision) throw fail('POWER_REQUEST_ID', 409);
      return result(previous, await read(), true);
    }
    if (closed) throw fail('POWER_CLOSED', 503);
    if (lock || active) throw fail('POWER_BUSY', 409);
    lock = true;
    try {
      const before = await read();
      if (before.revision !== input.revision) throw fail('POWER_STALE', 409, { power: before });
      if (!before.available) throw fail(storageFailure ? 'POWER_AUDIT' : 'POWER_UNAVAILABLE', 409, { power: before });
      if (records.filter(row => row.baseline.instanceId === instanceId).length >= 7936) throw fail('POWER_AUDIT', 503);
      if (typeof manager?.beginMaintenance !== 'function') throw fail('POWER_BUSY', 409);
      try { releaseMaintenance = await manager.beginMaintenance({ action: input.action, requestId: input.requestId }); }
      catch { throw fail('POWER_BUSY', 409); }
      if (typeof releaseMaintenance !== 'function') throw fail('POWER_BUSY', 409);
      const row = { requestId: input.requestId, action: input.action, status: 'accepted', requestedAt: recordTime(), actor: user?.username || 'panel-system', baseline: { instanceId, bootId, revision: before.revision } };
      try { audit('requested', row); records.push(row); save(); }
      catch { records = records.filter(item => item !== row); release(); throw fail('POWER_AUDIT', 503); }
      active = row;
      return result(row, await read(), false);
    } finally { lock = false; }
  }
  async function failed(row, code) {
    row.status = 'failed'; row.error = code; row.completedAt = recordTime();
    try { save(); audit('failed', row); } catch { storageFailure = true; }
    release();
  }
  async function unknown(row, code) {
    row.status = 'unknown'; row.error = code; row.observedAt = recordTime();
    try { save(); audit('unknown', row); } catch { storageFailure = true; }
    // The transient job may already exist, including a reboot queued by
    // systemd. Keep admission paused until a new process/boot observes it.
  }
  async function performDispatch(requestId) {
    await init();
    if (!active || active.requestId !== requestId || active.status !== 'accepted') return;
    const row = active;
    if (closed) return failed(row, 'POWER_INTERRUPTED');
    row.status = 'dispatching'; row.dispatchStartedAt = recordTime();
    try { save(); audit('dispatching', row); }
    catch { await failed(row, 'POWER_AUDIT'); return; }
    try {
      const native = systemPowerCommand(role, row.action, row.requestId);
      await (dispatch ? dispatch({ ...native, action: row.action, serviceId, requestId: row.requestId }) : execFile(native.command, native.args, commandOptions));
      row.status = 'scheduled'; row.scheduledAt = recordTime();
      try { save(); audit('scheduled', row); } catch { storageFailure = true; }
      timer = setTimer(() => { void unknown(row, 'POWER_NOT_COMPLETED'); }, 180000); timer?.unref?.();
    } catch (error) {
      if (['ENOENT', 'EACCES'].includes(error.code)) await failed(row, 'POWER_SCHEDULE_FAILED');
      else await unknown(row, 'POWER_UNKNOWN');
    }
  }
  let flight;
  return { read, request, dispatch(requestId) { return flight ||= performDispatch(requestId).finally(() => { flight = null; }); },
    async cancel(requestId) { if (active?.requestId === requestId && active.status === 'accepted') await failed(active, 'POWER_INTERRUPTED'); },
    async close() { closed = true; clearTimer(timer); await flight; if (active?.status === 'accepted') await failed(active, 'POWER_INTERRUPTED'); } };
}

export async function sendPowerRequest(controller, req, res, nodeId) {
  const value = await controller.request(req.body, { user: req.session?.user });
  if (!value.replayed && value.accepted) {
    // Never dispatch merely because a handler received a request. Flush its
    // durable acceptance first, then let systemd perform graceful shutdown.
    res.once('finish', () => { void controller.dispatch(value.operation.requestId).catch(() => {}); });
    res.once('close', () => { if (!res.writableFinished) void controller.cancel(value.operation.requestId).catch(() => {}); });
  }
  res.status(value.accepted ? 202 : 200).json({ ...value, nodeId: nodeId || value.nodeId });
}
