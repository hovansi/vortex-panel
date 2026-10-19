import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const zoneName = /^(?:[A-Za-z0-9_+-]+\/)*[A-Za-z0-9_+-]+$/;
const messages = {
  TIMEZONE_INPUT: ['Invalid timezone request.', 'Yêu cầu múi giờ không hợp lệ.'],
  TIMEZONE_CONFIRM: ['Review and explicitly confirm the VPS timezone change.', 'Hãy xem lại và xác nhận đổi múi giờ VPS.'],
  TIMEZONE_TARGET: ['The selected VPS does not match this request.', 'VPS được chọn không khớp yêu cầu.'],
  TIMEZONE_INVALID: ['Select a timezone installed on this VPS.', 'Chọn múi giờ được cài trên VPS này.'],
  TIMEZONE_STALE: ['The VPS timezone changed. Refresh before confirming again.', 'Múi giờ VPS đã thay đổi. Hãy tải lại trước khi xác nhận.'],
  TIMEZONE_UNAVAILABLE: ['Changing the VPS timezone requires Linux, systemd and a root service account.', 'Đổi múi giờ VPS cần Linux, systemd và tài khoản dịch vụ root.'],
  TIMEZONE_BUSY: ['Another timezone change is still being verified.', 'Một thay đổi múi giờ khác vẫn đang được xác minh.'],
  TIMEZONE_AUDIT: ['The timezone request could not be saved. No system change was started.', 'Không lưu được yêu cầu múi giờ. Chưa bắt đầu thay đổi hệ thống.'],
  TIMEZONE_RECOVERY: ['A previous timezone operation could not be verified. Review the service journal before another change.', 'Chưa xác minh được thao tác múi giờ trước đó. Hãy xem nhật ký dịch vụ trước khi đổi tiếp.'],
  TIMEZONE_UNKNOWN: ['The timezone result is unknown. Refresh its actual state; the request will not be repeated automatically.', 'Chưa rõ kết quả múi giờ. Hãy tải lại trạng thái thực tế; yêu cầu không tự động gửi lại.'],
  TIMEZONE_CLOSED: ['This service is stopping and cannot change the timezone.', 'Dịch vụ đang dừng và chưa thể thay đổi múi giờ.'],
  TIMEZONE_UPGRADE_REQUIRED: ['Update this worker to use timezone management.', 'Cập nhật VPS phụ này để dùng quản lý múi giờ.'],
};
const metadata = code => ({ id: `panel.timezone.${code.slice(9).toLowerCase()}`, en: messages[code][0], vi: messages[code][1], params: [] });
const problem = (code, status = 409, extra = {}) => Object.assign(new Error(messages[code][0]), { code, status, ...extra });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TIMEZONE_MESSAGES = Object.freeze(Object.keys(messages).map(metadata));
export function timezoneErrorPayload(error, language = 'en') {
  if (!messages[error?.code]) return null;
  const errorI18n = metadata(error.code);
  return { error: errorI18n[language === 'vi' ? 'vi' : 'en'], errorI18n, code: error.code,
    ...(error.outcomeUnknown === true ? { outcomeUnknown: true } : {}), ...(error.timezone ? { timezone: error.timezone } : {}) };
}
export function validateTimezoneRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['nodeId', 'timezone', 'revision', 'requestId', 'confirmed'].includes(key)) || !uuid.test(input.requestId || '')) throw problem('TIMEZONE_INPUT', 400);
  if (input.confirmed !== true) throw problem('TIMEZONE_CONFIRM', 400);
  if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 128) throw problem('TIMEZONE_TARGET', 400);
  if (typeof input.timezone !== 'string' || input.timezone.length > 128 || !zoneName.test(input.timezone) || input.timezone.includes('..')) throw problem('TIMEZONE_INVALID', 400);
  if (!/^[a-f0-9]{64}$/.test(input.revision || '')) throw problem('TIMEZONE_STALE', 409);
  return input;
}

const commandOptions = Object.freeze({ timeout: 15000, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true, shell: false,
  env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' } });

// No shell, arbitrary executable, path or clock-setting argument is accepted.
// The only mutable value must also occur in timedatectl's installed zone list.
export function createHostTimezoneController({ dataDir, store, nodeId = 'local', role = 'panel', platform = process.platform,
  uid = process.getuid?.(), instanceId = randomUUID(), now = Date.now, execFile = promisify(nodeExecFile), syncEnvironment = true } = {}) {
  if (!dataDir || !['panel', 'worker'].includes(role) || typeof nodeId !== 'string' || !nodeId) throw Error('Managed role, node identity and data directory are required.');
  const filename = path.join(dataDir, 'timezone-operations.json');
  let initialized = false, records = [], originalTimezone = null, storageFailure = false, closed = false, flight = null;
  let last = null, zones = [], zonesAt = -Infinity;
  const stamp = () => new Date(now()).toISOString();
  const copy = value => value == null ? value : structuredClone(value);
  const pending = () => records.findLast(row => ['running', 'unknown'].includes(row.status));
  function save() {
    const temp = `${filename}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      const retained = records.filter((row, index) => row.instanceId === instanceId || index >= records.length - 32);
      fs.writeFileSync(fd, JSON.stringify({ schema: 1, nodeId, role, originalTimezone, records: retained }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, filename);
      if (process.platform === 'linux') { const directory = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  }
  function init() {
    if (initialized) return;
    initialized = true;
    try {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (value.schema !== 1 || value.nodeId !== nodeId || value.role !== role || !Array.isArray(value.records) || value.records.length > 512 || typeof value.originalTimezone !== 'string' || !zoneName.test(value.originalTimezone)) throw Error('Invalid timezone journal');
      for (const row of value.records) if (!uuid.test(row.requestId || '') || typeof row.timezone !== 'string' || !zoneName.test(row.timezone) || typeof row.previousTimezone !== 'string' || !zoneName.test(row.previousTimezone) || !['running', 'completed', 'unknown'].includes(row.status) || !/^[a-f0-9]{64}$/.test(row.revision || '') || typeof row.instanceId !== 'string') throw Error('Invalid timezone record');
      if (value.records.filter(row => ['running', 'unknown'].includes(row.status)).length > 1) throw Error('Ambiguous timezone journal');
      records = value.records; originalTimezone = value.originalTimezone;
      if (pending()) pending().status = 'unknown';
    } catch (error) { if (error.code !== 'ENOENT') storageFailure = true; }
  }
  async function observe() {
    if (platform !== 'linux' || uid !== 0) throw problem('TIMEZONE_UNAVAILABLE');
    const value = await execFile('/usr/bin/timedatectl', ['show', '--property=Timezone', '--value'], commandOptions);
    const timezone = value.stdout.trim();
    if (!timezone || timezone.length > 128 || !zoneName.test(timezone)) throw problem('TIMEZONE_UNAVAILABLE');
    if (!zones.length || now() - zonesAt >= 300000) {
      const result = await execFile('/usr/bin/timedatectl', ['list-timezones', '--no-pager'], commandOptions);
      const installed = result.stdout.trim().split(/\r?\n/);
      if (installed.length > 4096 || !installed.length || installed.some(zone => !zone || zone.length > 128 || !zoneName.test(zone))) throw problem('TIMEZONE_UNAVAILABLE');
      zones = [...new Set(installed)].sort(); zonesAt = now();
    }
    // UTC is a supported systemd alias even on installations that omit it from
    // the list. Keep the exact observed alias selectable without rewriting it.
    if (!zones.includes(timezone)) zones = [...zones, timezone].sort();
    if (syncEnvironment) process.env.TZ = timezone;
    return { timezone, observedAt: stamp() };
  }
  const revision = timezone => hash([nodeId, role, instanceId, timezone]);
  function publicState(observed, reasonCode = null, includeZones = true) {
    const reason = storageFailure ? 'TIMEZONE_RECOVERY' : closed ? 'TIMEZONE_CLOSED' : reasonCode;
    const result = { nodeId, available: !reason, timezone: observed?.timezone || last?.timezone || null, observedAt: observed?.observedAt || last?.observedAt || null,
      revision: revision(observed?.timezone || last?.timezone || null), busy: !!pending() || !!flight, lastOperation: copy(records.at(-1) || null),
      reason: reason ? messages[reason][0] : null, reasonI18n: reason ? metadata(reason) : null };
    if (includeZones) result.zones = [...zones];
    return result;
  }
  async function read({ includeZones = true } = {}) {
    init();
    let observed;
    try { observed = await observe(); }
    catch { return publicState(null, 'TIMEZONE_UNAVAILABLE', includeZones); }
    const active = pending();
    if (active && active.status === 'unknown' && active.timezone === observed.timezone && !storageFailure) {
      active.status = 'completed'; active.completedAt = stamp(); active.reconciled = true;
      try { save(); store.audit('host.timezone.reconciled', JSON.stringify({ nodeId, requestId: active.requestId, timezone: active.timezone }), active.actor); }
      catch { storageFailure = true; }
    }
    last = observed;
    return publicState(observed, null, includeZones);
  }
  async function perform(input, user) {
    const before = await read();
    if (!before.available) throw problem(storageFailure ? 'TIMEZONE_RECOVERY' : 'TIMEZONE_UNAVAILABLE', 409, { timezone: before });
    if (before.revision !== input.revision) throw problem('TIMEZONE_STALE', 409, { timezone: before });
    if (!zones.includes(input.timezone)) throw problem('TIMEZONE_INVALID', 400);
    if (records.filter(row => row.instanceId === instanceId).length >= 128) throw problem('TIMEZONE_AUDIT', 503);
    const row = { requestId: input.requestId, timezone: input.timezone, previousTimezone: before.timezone, revision: input.revision, instanceId,
      actor: user?.username || 'panel-system', status: 'running', requestedAt: stamp() };
    originalTimezone ||= before.timezone;
    try { store.audit('host.timezone.requested', JSON.stringify({ nodeId, requestId: row.requestId, from: row.previousTimezone, to: row.timezone }), row.actor); records.push(row); save(); }
    catch { records = records.filter(record => record !== row); throw problem('TIMEZONE_AUDIT', 503); }
    let commandError;
    if (before.timezone !== input.timezone) try { await execFile('/usr/bin/timedatectl', ['--no-ask-password', 'set-timezone', input.timezone], commandOptions); }
    catch (error) { commandError = error; }
    let observed;
    try { observed = await observe(); } catch {}
    if (observed?.timezone !== input.timezone) {
      row.status = 'unknown'; row.errorCode = 'TIMEZONE_UNKNOWN';
      try { save(); store.audit('host.timezone.unknown', JSON.stringify({ nodeId, requestId: row.requestId, timezone: row.timezone }), row.actor); } catch { storageFailure = true; }
      if (observed) last = observed;
      throw problem('TIMEZONE_UNKNOWN', commandError?.killed ? 504 : 502, { outcomeUnknown: true, timezone: publicState(observed) });
    }
    last = observed; row.status = 'completed'; row.completedAt = stamp();
    if (commandError) row.commandWarning = true;
    try { save(); store.audit('host.timezone.completed', JSON.stringify({ nodeId, requestId: row.requestId, timezone: row.timezone }), row.actor); }
    catch { storageFailure = true; throw problem('TIMEZONE_RECOVERY', 503, { timezone: publicState(observed) }); }
    return { nodeId, replayed: false, changed: before.timezone !== input.timezone, operation: copy(row), timezone: { ...publicState(observed), busy: false } };
  }
  return { read, current() { return publicState(last, last ? null : 'TIMEZONE_UNAVAILABLE', false); },
    request(input, { user } = {}) {
      validateTimezoneRequest(input); init();
      if (input.nodeId !== nodeId) return Promise.reject(problem('TIMEZONE_TARGET'));
      const previous = records.find(row => row.requestId === input.requestId);
      if (previous) {
        if (previous.timezone !== input.timezone || previous.revision !== input.revision) return Promise.reject(problem('TIMEZONE_INPUT', 400));
        return read().then(timezone => ({ nodeId, replayed: true, operation: copy(previous), timezone }));
      }
      if (closed) return Promise.reject(problem('TIMEZONE_CLOSED', 503));
      if (flight || pending()) return Promise.reject(problem('TIMEZONE_BUSY'));
      flight = perform(input, user).finally(() => { flight = null; });
      return flight;
    }, async close() { closed = true; await flight?.catch(() => {}); } };
}
