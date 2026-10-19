import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const messages = {
  NETWORK_INPUT: ['Review and confirm the current network profile before applying a change.', 'Hãy xem và xác nhận cấu hình mạng hiện tại trước khi thay đổi.'],
  NETWORK_UNAVAILABLE: ['Network tuning needs the managed Linux service running as root and readable kernel settings.', 'Tối ưu mạng cần dịch vụ Linux chạy bằng root và đọc được thiết lập kernel.'],
  NETWORK_UPGRADE_REQUIRED: ['Update this worker to use network profile management.', 'Cập nhật VPS phụ này để dùng quản lý cấu hình mạng.'],
  NETWORK_OWNERSHIP: ['The network profile ownership could not be verified. Existing settings were preserved.', 'Chưa xác minh được quyền quản lý cấu hình mạng. Thiết lập hiện tại được giữ nguyên.'],
  NETWORK_FOREIGN_PROFILE: ['This profile path is managed outside Vortex. Its contents were preserved.', 'Đường dẫn cấu hình này được quản lý ngoài Vortex. Nội dung được giữ nguyên.'],
  NETWORK_PROFILE_CHANGED: ['The saved network profile was changed externally. Review it before restoring or applying another profile.', 'Cấu hình mạng đã được sửa bên ngoài. Kiểm tra trước khi khôi phục hoặc áp dụng cấu hình khác.'],
  NETWORK_RECOVERY: ['An interrupted network change needs review. Restore the owned profile before another apply.', 'Thay đổi mạng bị gián đoạn cần được kiểm tra. Khôi phục cấu hình thuộc Vortex trước khi áp dụng lại.'],
  NETWORK_DRIFT: ['Some network values were changed externally. Restore preserves those values; review the profile before applying again.', 'Một số giá trị mạng đã được sửa bên ngoài. Khôi phục sẽ giữ các giá trị này; kiểm tra cấu hình trước khi áp dụng lại.'],
  NETWORK_STALE: ['Network settings changed since this review. Refresh the profile before confirming.', 'Thiết lập mạng đã đổi sau khi mở bảng này. Tải lại trước khi xác nhận.'],
  NETWORK_BUSY: ['Another network or VPS maintenance operation is in progress.', 'Một thao tác mạng hoặc bảo trì VPS khác đang chạy.'],
  NETWORK_CLOSED: ['The service is stopping. No new network change was accepted.', 'Dịch vụ đang dừng. Chưa nhận thay đổi mạng mới.'],
  NETWORK_AUDIT: ['The network request could not be recorded. No system change was started.', 'Không ghi được yêu cầu mạng. Chưa bắt đầu thay đổi hệ thống.'],
  NETWORK_APPLY_FAILED: ['The network change failed and the applied values were rolled back. Refresh the actual state.', 'Thay đổi mạng thất bại và các giá trị đã áp dụng được hoàn tác. Tải lại trạng thái thực tế.'],
  NETWORK_VERIFY: ['The kernel did not confirm the requested value. Inspect the actual profile before continuing.', 'Kernel chưa xác nhận giá trị yêu cầu. Kiểm tra cấu hình thực tế trước khi tiếp tục.'],
  NETWORK_UNKNOWN: ['The network operation outcome is unknown. Refresh its actual status; it was not automatically retried.', 'Chưa rõ kết quả thao tác mạng. Tải lại trạng thái thực tế; thao tác không được tự thử lại.'],
};
const metadata = code => ({ id: `panel.network.${code.slice(8).toLowerCase()}`, en: messages[code][0], vi: messages[code][1], params: [] });
const fail = (code, status = 409, extra = {}) => Object.assign(new Error(messages[code]?.[0] || messages.NETWORK_UNKNOWN[0]), { code, status, ...extra });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const NETWORK_TUNING_MESSAGES = Object.freeze(Object.keys(messages).map(metadata));
export function validateNetworkTuningRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'revision', 'confirmed'].includes(key)) || !['apply', 'restore'].includes(input.action) || !SHA.test(input.revision || '') || input.confirmed !== true) throw fail('NETWORK_INPUT', 400);
  return input;
}
export function networkTuningErrorPayload(error, language = 'en') {
  if (!messages[error?.code]) return null;
  const errorI18n = metadata(error.code);
  return { code: error.code, error: errorI18n[language === 'vi' ? 'vi' : 'en'], errorI18n,
    ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}), ...(error.network ? { network: error.network } : {}) };
}

export function assertNetworkHelperOwnership(helperPath, io = fs) {
  if (!path.posix.isAbsolute(helperPath) || path.posix.normalize(helperPath) !== helperPath) throw fail('NETWORK_OWNERSHIP');
  for (let parent = path.posix.dirname(helperPath);; parent = path.posix.dirname(parent)) {
    const info = io.lstatSync(parent);
    if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o022) throw fail('NETWORK_OWNERSHIP');
    if (parent === '/') break;
  }
  const info = io.lstatSync(helperPath);
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.mode & 0o022) throw fail('NETWORK_OWNERSHIP');
}

function nativeNetworkHelper(helperPath, role, action, input, spawnProcess = spawn) {
  assertNetworkHelperOwnership(helperPath);
  return new Promise((resolve, reject) => {
    let output = '', size = 0, settled = false;
    const child = spawnProcess('/usr/bin/python3', [helperPath, action, '--role', role], { shell: false, windowsHide: true,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('NETWORK_UNKNOWN', 504, { outcomeUnknown: action !== 'inspect' })); }, 20000);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) { child.kill('SIGKILL'); finish(fail('NETWORK_UNKNOWN', 502, { outcomeUnknown: action !== 'inspect' })); }
      else if (stream === child.stdout) output += chunk;
    });
    child.on('error', () => finish(fail('NETWORK_UNAVAILABLE', 503)));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      let value;
      try { value = JSON.parse(output); } catch { return finish(fail('NETWORK_UNKNOWN', 502, { outcomeUnknown: action !== 'inspect' })); }
      if (!value.ok) return finish(fail(messages[value.code] ? value.code : 'NETWORK_UNAVAILABLE'));
      if (!value.network || !SHA.test(value.network.revision || '') || !Array.isArray(value.network.changes) || !Array.isArray(value.network.blockers)) return finish(fail('NETWORK_UNKNOWN', 502, { outcomeUnknown: action !== 'inspect' }));
      finish(null, value.network);
    });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}

export function createHostNetworkTuningController({ role = 'panel', nodeId = 'local', store, manager,
  helperPath = fileURLToPath(new URL('./host-network-tuning.py', import.meta.url)), platform = process.platform, uid = process.getuid?.(),
  instanceId = randomUUID(), invoke } = {}) {
  if (!['panel', 'worker'].includes(role) || typeof nodeId !== 'string' || !nodeId) throw fail('NETWORK_INPUT', 400);
  let closed = false, active;
  const native = async (action, input) => {
    if (!invoke && (platform !== 'linux' || uid !== 0)) throw fail('NETWORK_UNAVAILABLE');
    return invoke ? invoke(action, input) : nativeNetworkHelper(helperPath, role, action, input);
  };
  const publicValue = value => ({ ...value, nodeId, revision: hash([nodeId, role, instanceId, value.revision]), busy: !!active || manager?.maintenanceStatus?.()?.active === true,
    available: value.available === true && !closed, reasonI18n: value.blockers?.[0] && messages[value.blockers[0]] ? metadata(value.blockers[0]) : null });
  async function read() {
    try { return publicValue(await native('inspect')); }
    catch (error) { return { nodeId, available: false, enabled: false, canRestore: false, status: 'unavailable', revision: null,
      current: {}, changes: [], ownedValues: {}, skipped: [], blockers: [messages[error.code] ? error.code : 'NETWORK_UNAVAILABLE'],
      reasonI18n: metadata(messages[error.code] ? error.code : 'NETWORK_UNAVAILABLE'), busy: !!active }; }
  }
  async function perform(input, { user } = {}) {
    const observed = await native('inspect'), before = publicValue(observed);
    if (input.revision !== before.revision) throw fail('NETWORK_STALE', 409, { network: before });
    if (input.action === 'apply' && !before.available || input.action === 'restore' && !before.canRestore) throw fail(messages[before.blockers?.[0]] ? before.blockers[0] : 'NETWORK_UNAVAILABLE', 409, { network: before });
    const actor = user?.username || 'panel-system';
    try { store?.audit?.('host.network.requested', JSON.stringify({ nodeId, action: input.action, revision: input.revision }), actor); }
    catch { throw fail('NETWORK_AUDIT', 503); }
    let result;
    try { result = await native(input.action, { revision: observed.revision, confirmed: true }); }
    catch (error) {
      try { store?.audit?.('host.network.failed', JSON.stringify({ nodeId, action: input.action, outcomeUnknown: error.outcomeUnknown === true }), actor); } catch {}
      throw error;
    }
    const network = publicValue(result);
    try { store?.audit?.('host.network.completed', JSON.stringify({ nodeId, action: input.action, changed: result.changed === true }), actor); }
    catch { network.auditWarning = true; }
    return { ok: true, nodeId, changed: result.changed === true, network };
  }
  return { read, plan: read, request(input, options) {
    try { validateNetworkTuningRequest(input); } catch (error) { return Promise.reject(error); }
    if (closed) return Promise.reject(fail('NETWORK_CLOSED', 503));
    if (active || manager?.maintenanceStatus?.()?.active === true) return Promise.reject(fail('NETWORK_BUSY'));
    let operation;
    try { operation = manager?.withHostOperation ? manager.withHostOperation(() => perform(input, options)) : perform(input, options); }
    catch { return Promise.reject(fail('NETWORK_BUSY')); }
    active = Promise.resolve(operation).finally(() => { active = null; });
    return active;
  }, async close() { closed = true; await active?.catch(() => {}); } };
}
