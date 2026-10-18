import os from 'node:os';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const messages = {
  HOSTNAME_INPUT: ['Hostname changes accept only hostname, optional prettyHostname, revision and confirmed.', 'Đổi hostname chỉ chấp nhận hostname, prettyHostname tùy chọn, revision và confirmed.'],
  HOSTNAME_PRETTY_INVALID: ['The friendly hostname must be text of at most 128 characters and 256 UTF-8 bytes, without control characters or leading/trailing whitespace. An empty value clears it.', 'Tên thân thiện phải là chuỗi tối đa 128 ký tự và 256 byte UTF-8, không chứa ký tự điều khiển hoặc khoảng trắng đầu/cuối. Để trống để xóa tên này.'],
  HOSTNAME_INVALID: ['Use an ASCII DNS hostname of 1–64 characters, with labels of at most 63 characters; letters are normalized to lowercase and localhost is reserved.', 'Dùng hostname DNS ASCII dài 1–64 ký tự, mỗi nhãn tối đa 63 ký tự; chữ cái được chuyển thành chữ thường và localhost được dành riêng.'],
  HOSTNAME_CONFIRM: ['Confirm the operating-system hostname change explicitly.', 'Cần xác nhận rõ việc đổi hostname hệ điều hành.'],
  HOSTNAME_REVISION: ['Read the current hostname before submitting a change.', 'Đọc hostname hiện tại trước khi gửi thay đổi.'],
  HOSTNAME_STALE: ['The hostname changed since this form was opened. Refresh it before trying again.', 'Hostname đã thay đổi sau khi mở biểu mẫu. Hãy tải lại trước khi thử lại.'],
  HOSTNAME_BUSY: ['Another hostname change is in progress. Read the result before retrying.', 'Một thao tác đổi hostname đang chạy. Hãy đọc kết quả trước khi thử lại.'],
  HOSTNAME_CLOSED: ['The hostname service is stopping. No new hostname request was accepted.', 'Dịch vụ hostname đang dừng. Chưa nhận yêu cầu đổi hostname mới.'],
  HOSTNAME_PLATFORM: ['Changing the operating-system hostname requires Linux with systemd.', 'Đổi hostname hệ điều hành cần Linux có systemd.'],
  HOSTNAME_ROOT: ['Changing the operating-system hostname requires the service to run as root.', 'Đổi hostname hệ điều hành cần dịch vụ chạy bằng root.'],
  HOSTNAME_UNAVAILABLE: ['The system hostname service is unavailable; its current static state could not be verified.', 'Dịch vụ hostname hệ thống chưa khả dụng; không xác minh được trạng thái static hiện tại.'],
  HOSTNAME_FAILED: ['The system hostname command failed. No automatic retry or rollback was attempted.', 'Lệnh đổi hostname hệ thống thất bại. Không tự thử lại hoặc tự rollback.'],
  HOSTNAME_VERIFY: ['The requested hostname was not fully verified. Read the actual state before another change.', 'Chưa xác minh đầy đủ hostname yêu cầu. Hãy đọc trạng thái thực tế trước khi đổi tiếp.'],
  HOSTNAME_UNKNOWN: ['The hostname request outcome is unknown. No automatic retry was made; reconnect and inspect it.', 'Chưa rõ kết quả đổi hostname. Không tự thử lại; hãy kết nối lại và kiểm tra.'],
  HOSTNAME_AUDIT: ['The hostname request could not be recorded. The system command was not run.', 'Không ghi được yêu cầu đổi hostname. Lệnh hệ thống chưa được chạy.'],
  HOSTNAME_AUDIT_WARNING: ['The observed hostname result could not be saved to the audit history.', 'Không lưu được kết quả hostname đã quan sát vào lịch sử kiểm tra.'],
  HOSTNAME_VERIFIED_WARNING: ['The command returned an error, but the requested hostname state was independently verified.', 'Lệnh trả lỗi nhưng trạng thái hostname yêu cầu đã được xác minh độc lập.'],
};
export const HOSTNAME_MESSAGES = Object.freeze(Object.entries(messages).map(([code, [en, vi]]) => ({ id: `panel.hostname.${code.slice(9).toLowerCase()}`, en, vi })));
const metadata = code => { const [en, vi] = messages[code]; return { id: `panel.hostname.${code.slice(9).toLowerCase()}`, params: [], en, vi }; };
const failure = (code, status = 400, details = {}) => Object.assign(new Error(messages[code][0]), { code, status, ...details });
const notice = code => ({ message: messages[code][0], metadata: metadata(code) });

export function validateHostname(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 ||
      !value.split('.').every(label => label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) throw failure('HOSTNAME_INVALID');
  // Validate ASCII first. Unicode folding and implicit whitespace trimming are
  // deliberately excluded from this operating-system mutation boundary.
  const canonical = value.toLowerCase();
  if (['localhost', 'localhost.localdomain'].includes(canonical)) throw failure('HOSTNAME_INVALID');
  return canonical;
}
function validateChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['hostname', 'prettyHostname', 'revision', 'confirmed'].includes(key))) throw failure('HOSTNAME_INPUT');
  const canonical = validateHostname(input.hostname);
  if (Object.hasOwn(input, 'prettyHostname')) validatePrettyHostname(input.prettyHostname);
  if (input.confirmed !== true) throw failure('HOSTNAME_CONFIRM');
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) throw failure('HOSTNAME_REVISION');
  return canonical;
}
export function validatePrettyHostname(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 128 || Buffer.byteLength(value, 'utf8') > 256 || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) || value !== value.trim()) throw failure('HOSTNAME_PRETTY_INVALID');
  return value;
}
function safeText(value, maximum = 1024) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r?\n$/, '');
  return Buffer.byteLength(text) <= maximum && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}
function appendWarning(target, code) {
  const value = notice(code);
  target.warnings = [...(target.warnings || []), value.message];
  target.warningsI18n = [...(target.warningsI18n || []), value.metadata];
  return target;
}
export function hostnameErrorPayload(error, language = 'en') {
  if (!messages[error?.code]) return null;
  const text = metadata(error.code), locale = language === 'vi' ? 'vi' : 'en';
  return { error: text[locale], errorI18n: text, code: error.code,
    ...(error.hostname ? { hostname: error.hostname } : {}),
    ...(typeof error.changed === 'boolean' ? { changed: error.changed } : {}),
    ...(error.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    ...(error.warnings ? { warnings: error.warnings, warningsI18n: error.warningsI18n } : {}) };
}

let nativeChangeInProgress = false;
export function createHostnameController({ platform = process.platform, uid = process.getuid?.(),
  hostname = () => os.hostname(), execFile = promisify(nodeExecFile), now = Date.now, command = '/usr/bin/hostnamectl' } = {}) {
  let closed = false, active;
  const options = { timeout: 8000, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true, shell: false,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: 'cat' } };
  const snapshot = (values, reasonCode = null) => {
    const reason = reasonCode ? notice(reasonCode) : null;
    return { ...values, editable: !reasonCode, prettyEditable: !reasonCode, reason: reason?.message || null, reasonI18n: reason?.metadata || null,
      revision: values.static !== null && values.transient !== null && values.pretty !== null && values.current !== null
        ? createHash('sha256').update(JSON.stringify([values.current, values.static, values.transient, values.pretty])).digest('hex') : null,
      sampledAt: new Date(now()).toISOString() };
  };
  async function read() {
    let current; try { current = safeText(hostname(), 255); } catch { current = null; }
    const unknown = { current, static: null, transient: null, pretty: null };
    if (platform !== 'linux') return snapshot(unknown, 'HOSTNAME_PLATFORM');
    try {
      const values = await Promise.all(['static', 'transient', 'pretty'].map(async mode => {
        const result = await execFile(command, ['--no-ask-password', `--${mode}`], options);
        const value = safeText(result.stdout); if (value === null) throw new Error('Invalid hostname metadata'); return value;
      }));
      if (current === null) return snapshot(unknown, 'HOSTNAME_UNAVAILABLE');
      return snapshot({ current, static: values[0], transient: values[1], pretty: values[2] }, uid === 0 ? null : 'HOSTNAME_ROOT');
    } catch { return snapshot(unknown, 'HOSTNAME_UNAVAILABLE'); }
  }
  async function performChange(input, { beforeApply } = {}) {
    const target = validateChange(input);
    const prettyRequested = Object.hasOwn(input, 'prettyHostname');
    const normalization = { requestedHostname: input.hostname, canonicalHostname: target, normalized: input.hostname !== target, prettyRequested, ...(prettyRequested ? { requestedPrettyHostname: input.prettyHostname } : {}) };
    if (nativeChangeInProgress) throw failure('HOSTNAME_BUSY', 409);
    nativeChangeInProgress = true;
    try {
      const before = await read();
      if (!before.editable) throw failure(platform !== 'linux' ? 'HOSTNAME_PLATFORM' : uid !== 0 ? 'HOSTNAME_ROOT' : 'HOSTNAME_UNAVAILABLE', 409, { hostname: before });
      if (before.revision !== input.revision) throw failure('HOSTNAME_STALE', 409, { hostname: before });
      const dnsMatches = value => value.current === target && value.static === target && value.transient === target;
      if (dnsMatches(before) && (!prettyRequested || before.pretty === input.prettyHostname)) return { ok: true, changed: false, prettyPreserved: true, hostname: before, ...normalization };
      await beforeApply?.(before, normalization);
      let commandError = false;
      if (!dnsMatches(before)) {
        try { await execFile(command, ['--no-ask-password', '--static', '--transient', 'set-hostname', target], options); }
        catch { commandError = true; }
        const dnsAfter = await read();
        if (!dnsMatches(dnsAfter)) throw failure(commandError ? 'HOSTNAME_FAILED' : 'HOSTNAME_VERIFY', 502,
          { hostname: dnsAfter, ...(dnsAfter.revision !== null && dnsAfter.revision !== before.revision ? { changed: true } : {}), outcomeUnknown: commandError || dnsAfter.revision === null });
      }
      if (prettyRequested && before.pretty !== input.prettyHostname) {
        try { await execFile(command, ['--no-ask-password', '--pretty', 'set-hostname', input.prettyHostname], options); }
        catch { commandError = true; }
      }
      const after = await read();
      const verified = dnsMatches(after) && after.pretty === (prettyRequested ? input.prettyHostname : before.pretty);
      if (!verified) throw failure(commandError ? 'HOSTNAME_FAILED' : 'HOSTNAME_VERIFY', 502,
        { hostname: after, ...(after.revision !== null && after.revision !== before.revision ? { changed: true } : {}), outcomeUnknown: commandError || after.revision === null });
      const result = { ok: true, changed: true, previousHostname: before.current, prettyPreserved: after.pretty === before.pretty, hostname: after, ...normalization };
      return commandError ? appendWarning(result, 'HOSTNAME_VERIFIED_WARNING') : result;
    } finally { nativeChangeInProgress = false; }
  }
  return { read, change(input, hooks) {
    if (closed) return Promise.reject(failure('HOSTNAME_CLOSED', 503));
    if (active) return Promise.reject(failure('HOSTNAME_BUSY', 409));
    const operation = performChange(input, hooks); active = operation;
    return operation.finally(() => { if (active === operation) active = null; });
  }, async close() { closed = true; await active?.catch(() => {}); } };
}

export async function changeHostname(controller, input, { store, user, nodeId = 'local' } = {}) {
  let requested = false, canonicalTarget, prettyTarget;
  const audit = (action, value) => store?.audit?.(action, JSON.stringify({ nodeId, ...value }), user?.username || 'panel-system');
  try {
    const result = await controller.change(input, { beforeApply: (before, normalization) => {
      canonicalTarget = normalization.canonicalHostname;
      prettyTarget = normalization.prettyRequested ? normalization.requestedPrettyHostname : undefined;
      try { audit('host.hostname.request', { from: before.current, to: canonicalTarget, ...(prettyTarget !== undefined ? { prettyFrom: before.pretty, prettyTo: prettyTarget } : {}) }); requested = true; }
      catch { throw failure('HOSTNAME_AUDIT', 503); }
    } });
    if (result.changed) {
      try { audit('host.hostname.changed', { from: result.previousHostname, to: result.hostname.current, ...(prettyTarget !== undefined ? { prettyTo: result.hostname.pretty } : {}) }); }
      catch { appendWarning(result, 'HOSTNAME_AUDIT_WARNING'); }
    }
    return result;
  } catch (error) {
    if (requested) try { audit('host.hostname.failed', { to: canonicalTarget, ...(prettyTarget !== undefined ? { prettyTo: prettyTarget } : {}), outcomeUnknown: error.outcomeUnknown === true }); }
    catch { appendWarning(error, 'HOSTNAME_AUDIT_WARNING'); }
    throw error;
  }
}
