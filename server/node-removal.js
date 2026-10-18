import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as nativeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/i;
const active = new Set(['queued', 'running', 'unknown', 'partial']);
const shell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const copy = value => structuredClone(value);
const fail = (message, status = 409, fields = {}) => Object.assign(new Error(message), { status, code: 'NODE_REMOVAL', ...fields });
const timestamp = () => new Date().toISOString();
const REMOVAL_FAILURE = { id: 'panel.node-removal.failed', en: 'Vortex uninstall could not be completed. Review the removal plan and operation result.', vi: 'Chưa thể hoàn tất gỡ Vortex. Hãy kiểm tra điều kiện gỡ và kết quả tác vụ.' };
const translated = [
  ['Move or remove all game servers before uninstalling this VPS. No worlds will be deleted by uninstall.', 'Hãy di chuyển hoặc xóa các máy chủ trò chơi trước khi gỡ Vortex khỏi VPS. Thao tác gỡ không xóa world.'],
  ['This data directory contains panel accounts and cannot be removed as worker data.', 'Thư mục dữ liệu này có tài khoản panel nên không thể dọn như dữ liệu VPS liên kết.'],
  ['Wait for all worker jobs and recovery work to finish.', 'Hãy chờ các tác vụ và công việc khôi phục trên VPS hoàn tất.'],
  ['Other processes still use the worker source or data.', 'Vẫn có tiến trình khác đang sử dụng chương trình hoặc dữ liệu của VPS liên kết.'],
  ['A storage mount remains inside the worker paths; it was preserved.', 'Vẫn còn vùng lưu trữ đang được sử dụng trong thư mục Vortex; dữ liệu được giữ nguyên.'],
  ['Server folders or storage images remain and require review before uninstall.', 'Vẫn còn thư mục máy chủ hoặc dữ liệu lưu trữ cần kiểm tra trước khi gỡ.'],
  ['Owned compressed swap cannot be safely deactivated with current memory headroom.', 'RAM trống hiện tại chưa đủ để tắt an toàn phần hỗ trợ bộ nhớ do Vortex quản lý.'],
  ['Verified worker service, identity, connection or empty inventory.', 'Dịch vụ, thông tin định danh, kết nối hoặc danh mục máy chủ rỗng đã được xác minh.'],
  ['Exact Vortex graceful-shutdown service override.', 'Thiết lập thời gian dừng dịch vụ do Vortex tạo đã được xác minh.'],
  ['Exact tagged controller firewall ownership receipt.', 'Biên nhận chính xác của quy tắc tường lửa kết nối panel do Vortex tạo.'],
  ['Exact tagged rule created by worker enrollment.', 'Quy tắc tường lửa có nhãn được tạo khi liên kết VPS.'],
  ['Verified worker network-counter identity.', 'Thông tin bộ đếm lưu lượng riêng của VPS liên kết đã được xác minh.'],
  ['The worker validates exclusive ownership before removing its counter table.', 'Vortex xác minh quyền quản lý riêng trước khi gỡ bộ đếm lưu lượng.'],
  ['Exact installer ownership receipt.', 'Biên nhận cài đặt xác nhận thành phần này do Vortex tạo.'],
  ['Ownership or content changed after installation.', 'Quyền quản lý hoặc nội dung đã thay đổi sau khi cài đặt.'],
  ['Installer ownership receipt; copied to the private operation before removal.', 'Biên nhận cài đặt đã được sao chép vào hồ sơ tác vụ riêng trước khi gỡ.'],
  ['Unrecorded files and diagnostic/recovery data are preserved; empty owned directories are removed only when safe.', 'Giữ nguyên các tệp chưa có bằng chứng sở hữu và dữ liệu chẩn đoán/khôi phục; chỉ dọn thư mục riêng đã rỗng khi an toàn.'],
  ['Separate panel installation is outside this worker identity; its data and configuration are preserved.', 'Bản panel riêng nằm ngoài phạm vi VPS liên kết này; giữ nguyên dữ liệu và cấu hình của bản panel đó.'],
  ['Shared Node.js, system packages and untagged firewall rules have no exclusive ownership receipt.', 'Giữ nguyên Node.js dùng chung, gói hệ thống và quy tắc tường lửa chưa có biên nhận sở hữu riêng.'],
  ['The host also has a main panel; its shared OS helper is preserved.', 'VPS còn có panel chính nên giữ nguyên công cụ hệ thống dùng chung của panel.'],
  ['Verified compressed swap owned by this worker.', 'Phần hỗ trợ bộ nhớ đã được xác minh thuộc VPS liên kết này.'],
  ['Separate or foreign compressed swap is preserved.', 'Giữ nguyên phần hỗ trợ bộ nhớ do phần mềm khác quản lý.'],
  ['Directory contains unrecorded files.', 'Thư mục còn chứa tệp chưa có bằng chứng sở hữu.'],
  ['Verified uninstall requires the standard managed Linux worker layout.', 'Tính năng gỡ có xác minh cần VPS Linux được cài theo cấu trúc chuẩn của Vortex.'],
  ['An existing uninstall requires verification. Open its operation status; do not submit another uninstall.', 'Một lượt gỡ trước đó đang cần xác minh. Hãy mở trạng thái tác vụ và không gửi lượt gỡ mới.'],
  ['Queued for verified worker uninstall.', 'Đã xếp hàng gỡ Vortex có xác minh khỏi VPS.'],
  ['Checking the verified SSH host against this enrolled worker.', 'Đang đối chiếu VPS SSH đã xác nhận với VPS liên kết này.'],
  ['Pausing new operations before uninstalling this empty worker.', 'Đang tạm dừng tác vụ mới trước khi gỡ Vortex khỏi VPS không còn máy chủ.'],
  ['The detached worker cleanup is running. The VPS remains linked until verified.', 'Tác vụ dọn Vortex đang chạy độc lập. VPS vẫn được giữ liên kết đến khi xác minh xong.'],
  ['Independently verifying the stopped service and removed worker components.', 'Đang kiểm tra độc lập việc dừng dịch vụ và gỡ các thành phần Vortex.'],
  ['Some worker components remain. This VPS stays linked for recovery.', 'Một số thành phần Vortex vẫn còn. Giữ liên kết VPS để kiểm tra và khôi phục.'],
  ['Worker removal was verified; saving the completed link removal.', 'Đã xác minh việc gỡ Vortex; đang lưu kết quả gỡ liên kết.'],
  ['Vortex worker was uninstalled and this VPS was removed. Shared or unproven components listed in the result were preserved.', 'Đã gỡ dịch vụ Vortex và xóa liên kết VPS. Các thành phần dùng chung hoặc chưa có bằng chứng sở hữu trong danh sách kết quả vẫn được giữ nguyên.'],
  ['The cleanup stopped before completion. Existing recovery material was retained.', 'Tác vụ dọn chưa hoàn tất. Hồ sơ và dữ liệu phục vụ khôi phục vẫn được giữ nguyên.'],
  ['Uninstall outcome is unknown. This VPS stays linked; verify the existing operation through SSH without repeating it.', 'Chưa xác định được kết quả gỡ. VPS vẫn được liên kết; hãy xác minh tác vụ hiện có qua SSH và không chạy lại thao tác gỡ.'],
  ['SSH identity or uninstall preflight failed. No worker cleanup was dispatched.', 'Chưa xác minh được VPS SSH hoặc điều kiện gỡ. Chưa chạy thao tác dọn Vortex.'],
  ['Independent SSH verification could not confirm completion. The existing uninstall was not run again.', 'Kiểm tra SSH độc lập chưa xác nhận hoàn tất. Thao tác gỡ hiện có không được chạy lại.'],
  ['The panel restarted during uninstall. Verify this operation through SSH; it will not run again automatically.', 'Panel đã khởi động lại khi đang gỡ. Hãy xác minh tác vụ qua SSH; thao tác gỡ sẽ không tự chạy lại.'],
  ['The panel stopped during uninstall. Verify the retained operation through SSH; it will not run again automatically.', 'Panel đã dừng khi đang gỡ. Hãy xác minh hồ sơ tác vụ qua SSH; thao tác gỡ sẽ không tự chạy lại.'],
  ['The prepared worker remained intact. Uninstall was canceled without running cleanup.', 'VPS vẫn còn nguyên sau bước chuẩn bị. Đã hủy lượt gỡ mà không chạy thao tác dọn.'],
];
const removalTranslations = new Map(translated.map(([en, vi]) => [en, { id: 'panel.node-removal.copy.' + createHash('sha256').update(en).digest('hex').slice(0, 16), en, vi, params: [] }]));
export const REMOVAL_MESSAGES = Object.freeze([Object.freeze(REMOVAL_FAILURE), ...removalTranslations.values()]);
const decorate = value => {
  if (Array.isArray(value)) return value.map(decorate);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decorate(item)]));
  for (const field of ['message', 'reason']) if (removalTranslations.has(result[field])) result[field + 'I18n'] = copy(removalTranslations.get(result[field]));
  return result;
};
export function nodeRemovalErrorPayload(error, language = 'en') { if (error?.code !== 'NODE_REMOVAL') return null; return { error: REMOVAL_FAILURE[language === 'vi' ? 'vi' : 'en'], code: error.code, errorI18n: { ...REMOVAL_FAILURE, params: [] }, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) }; }
const scrub = input => { if (input && typeof input === 'object') for (const key of ['password', 'privateKey', 'passphrase', 'adminPassword']) delete input[key]; };
function strict(input, fields) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) throw fail('Invalid VPS uninstall request.', 400); }
function sshIdentity(input) {
  strict(input, ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint']);
  if (typeof input.host !== 'string' || input.host.length > 253 || !/^[A-Za-z0-9.:[\]-]+$/.test(input.host) || typeof input.hostFingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(input.hostFingerprint) || input.username !== undefined && input.username !== 'root' || input.port !== undefined && (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535)) throw fail('A pinned root SSH connection is required.', 400);
  return { host: input.host, port: input.port ?? 22, username: 'root', hostFingerprint: input.hostFingerprint.replace(/=+$/, '') };
}
function safePlan(value, node) {
  if (!value || value.schemaVersion !== 1 || value.agentId !== node.agentId || !SHA.test(value.revision || '') || !['ready', 'blocked', 'unsupported'].includes(value.status) || !Array.isArray(value.blockers) || !Array.isArray(value.components) || value.components.length > 50000 || !Number.isSafeInteger(value.serverCount) || value.serverCount < 0) throw fail('The worker returned an incompatible uninstall inventory.', 502);
  return value;
}
const validProof = (value, job) => value?.schemaVersion === 1 && value.nodeId === job.agentId && value.requestId === job.requestId && value.verified === true && value.inventoryEmpty === true && value.serviceRemoved === true && value.filesVerified === true && value.processesAbsent === true && value.mountsAbsent === true && value.firewallRemoved === true && value.networkCountersRemoved === true && value.zramRemoved === true && Array.isArray(value.remainingOwnedPaths) && value.remainingOwnedPaths.length === 0;

export function createNodeRemovalAgent({ nodeId, dataDir, manager, configFile = '/etc/vortex-node.json', execFile = promisify(nativeExecFile), platform = process.platform, uid = process.getuid?.(), helperPath = new URL('./node-removal.py', import.meta.url) } = {}) {
  if (!UUID.test(nodeId || '') || !dataDir || !manager) throw new Error('Worker removal requires a fixed node identity and manager.');
  const filename = path.join(dataDir, '.removal-intent.json');
  const helper = helperPath instanceof URL ? fileURLToPath(helperPath) : path.resolve(helperPath);
  let intent, release, busy = false, ready;
  const initialize = () => ready ||= (async () => {
    try {
      const info = fs.lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536 || process.platform === 'linux' && (info.uid !== 0 || info.mode & 0o077)) throw new Error('Unsafe removal intent');
      intent = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (intent.nodeId !== nodeId || !UUID.test(intent.requestId || '') || !SHA.test(intent.revision || '')) throw new Error('Invalid removal intent');
      release = manager.beginMaintenance({ action: 'uninstall', requestId: intent.requestId, restore: true });
    } catch (error) { if (error.code !== 'ENOENT') throw fail('An unresolved worker uninstall intent requires administrator review.', 503); }
  })();
  async function plan() {
    await initialize();
    if (platform !== 'linux' || uid !== 0 || configFile !== '/etc/vortex-node.json') return decorate({ schemaVersion: 1, agentId: nodeId, revision: createHash('sha256').update(nodeId).digest('hex'), status: 'unsupported', serverCount: manager.listServers().length, blockers: [{ code: 'REMOVAL_UNSUPPORTED', message: 'Verified uninstall requires the standard managed Linux worker layout.' }], components: [], sshRequired: true, legacyOwnership: true, fullyClean: false });
    const { stdout } = await execFile('/usr/bin/python3', [helper, 'plan', '--node-id', nodeId], { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: false });
    const value = JSON.parse(stdout);
    if (value.agentId !== nodeId || !SHA.test(value.revision || '')) throw fail('Worker ownership inventory could not be verified.', 502);
    return decorate({ ...value, ...(intent ? { pendingOperation: { requestId: intent.requestId } } : {}) });
  }
  async function prepare(input) {
    strict(input, ['nodeId', 'revision', 'requestId', 'confirmed']);
    if (input.nodeId !== nodeId || !UUID.test(input.requestId || '') || !SHA.test(input.revision || '') || input.confirmed !== true) throw fail('Confirm the selected worker and its current uninstall plan.', 400);
    await initialize();
    if (intent) {
      if (intent.requestId === input.requestId && intent.revision === input.revision) return { accepted: true, nodeId, requestId: intent.requestId, revision: intent.revision };
      throw fail('Another uninstall is already pending.');
    }
    if (busy) throw fail('Another uninstall check is already pending.');
    busy = true;
    try {
      const current = await plan();
      if (current.status !== 'ready' || current.serverCount !== 0 || current.revision !== input.revision) throw fail('The worker uninstall inventory changed; refresh it before continuing.');
      release = manager.beginMaintenance({ action: 'uninstall', requestId: input.requestId });
      if (manager.listServers().length) { release(); release = null; throw fail('A game server was admitted while the uninstall plan was being checked.'); }
      const frozen = await plan();
      if (frozen.status !== 'ready' || frozen.revision !== input.revision || frozen.serverCount !== 0) { release(); release = null; throw fail('Worker inventory changed before the admission freeze.'); }
      const next = { nodeId, requestId: input.requestId, revision: input.revision, createdAt: timestamp() };
      let descriptor;
      try { descriptor = fs.openSync(filename, 'wx', 0o600); fs.writeFileSync(descriptor, JSON.stringify(next)); fs.fsyncSync(descriptor); }
      catch (error) { release?.(); release = null; if (descriptor !== undefined) fs.unlinkSync(filename); throw error; }
      finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
      intent = next;
      if (process.platform === 'linux') { const directory = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
      return { accepted: true, nodeId, requestId: intent.requestId, revision: intent.revision };
    } catch (error) { if (!intent) { release?.(); release = null; } throw error; }
    finally { busy = false; }
  }
  async function abort(input) {
    strict(input, ['nodeId', 'requestId']); await initialize();
    if (input.nodeId !== nodeId || !UUID.test(input.requestId || '') || !intent || input.requestId !== intent.requestId) throw fail('The uninstall operation does not match this worker.');
    // This API releases only an intact, active worker. A detached helper must
    // re-read this intent immediately before any effect, preventing later use.
    const current = await plan();
    if (current.status !== 'ready' || current.serverCount !== 0) throw fail('The worker cannot safely cancel this uninstall.');
    await execFile('/usr/bin/python3', [helper, 'abort', '--node-id', nodeId, '--request-id', intent.requestId], { timeout: 30000, maxBuffer: 65536, windowsHide: true, shell: false });
    intent = null; release?.(); release = null;
    return { ok: true, nodeId };
  }
  return { initialize, plan, prepare, abort, close() {} };
}

export function createNodeRemovalController({ nodes, store, dataDir, projectDir, ssh, emit = () => {}, pollIntervalMs = 1000, operationTimeoutMs = 11 * 60 * 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!nodes || !store) throw new Error('Verified node removal requires nodes and a durable store.');
  const tasks = new Map(); let closed = false, admissionTail = Promise.resolve();
  store.data.nodeRemovalJobs ||= [];
  if (!Array.isArray(store.data.nodeRemovalJobs)) throw new Error('Invalid node removal history.');
  let recovered = false;
  for (const job of store.data.nodeRemovalJobs) if (['queued', 'running'].includes(job.status)) { Object.assign(job, { status: 'unknown', phase: 'review', outcomeUnknown: true, message: 'The panel restarted during uninstall. Verify this operation through SSH; it will not run again automatically.' }); recovered = true; }
  if (recovered) store.save();
  const publicJob = job => decorate({ ...Object.fromEntries(['id', 'requestId', 'type', 'adminOnly', 'scope', 'serverId', 'nodeId', 'status', 'phase', 'progress', 'message', 'createdAt', 'finishedAt', 'verified', 'outcomeUnknown', 'retained', 'warnings', 'recoveryPath', 'completionStatusPersisted'].filter(key => job[key] !== undefined).map(key => [key, copy(job[key])])), cleanupScope: 'active-worker-components', retainedComponents: copy(job.retained || []) });
  const get = id => store.data.nodeRemovalJobs.find(job => job.id === id) || (() => { throw fail('Uninstall job was not found.', 404); })();
  function change(job, fields) {
    const old = { ...job }, rows = store.data.nodeRemovalJobs;
    Object.assign(job, fields);
    let completed = 0; store.data.nodeRemovalJobs = rows.filter(row => active.has(row.status) || row.completionStatusPersisted === false || completed++ < 50);
    try { store.save(); } catch (error) { Object.keys(job).forEach(key => { if (!Object.hasOwn(old, key)) delete job[key]; }); Object.assign(job, old); store.data.nodeRemovalJobs = rows; throw error; }
    emit({ type: 'update' });
  }
  function selected(id) { if (id === 'local' || !UUID.test(id || '')) throw fail('The main panel VPS cannot be removed through linked-VPS management.', 400); return nodes.get(id); }
  async function plan(id, { operationId } = {}) {
    const node = selected(id);
    const value = await nodes.call(node, { path: '/api/node/uninstall/plan', timeoutMs: 35000, maxBytes: 16 * 1024 * 1024 });
    const observed = decorate(safePlan(value.plan || value, node));
    if (node.removalOperationId && node.removalOperationId !== operationId) return decorate({ nodeId: node.id, name: node.name, address: node.publicAddress || new URL(node.endpoint).hostname, plan: { ...observed, status: 'blocked', latestJobId: node.removalOperationId, blockers: [...observed.blockers, { code: 'REMOVAL_PENDING', message: 'An existing uninstall requires verification. Open its operation status; do not submit another uninstall.' }] } });
    return { nodeId: node.id, name: node.name, address: node.publicAddress || new URL(node.endpoint).hostname, plan: observed };
  }
  const command = (helper, action, job, revision = false) => `/usr/bin/python3 ${shell(helper)} ${action} --node-id ${shell(job.agentId)} --request-id ${shell(job.requestId)}${revision ? ` --revision ${shell(job.revision)}` : ''}`;
  async function verified(connection, job, user) {
    if (closed) throw fail('Uninstall verification was interrupted by panel shutdown.', 503, { outcomeUnknown: true });
    change(job, { status: 'running', phase: 'verifying', progress: 90, message: 'Independently verifying the stopped service and removed worker components.' });
    const checked = await connection.exec(command(job.helperPath, 'verify', job), { timeoutMs: 35000, maxBytes: 16 * 1024 * 1024 });
    let proof; try { proof = JSON.parse(checked.stdout); } catch { throw fail('The independent uninstall proof is unavailable.', 502); }
    if (proof?.schemaVersion === 1 && proof.nodeId === job.agentId && proof.requestId === job.requestId && proof.safeToCancel === true && proof.inventoryEmpty === true && proof.activeWorkerVerified === true && proof.revision === job.revision && proof.fingerprint === job.fingerprint) {
      const node = selected(job.nodeId);
      await nodes.call(node, { path: '/api/node/uninstall/abort', method: 'POST', body: { nodeId: job.agentId, requestId: job.requestId }, headers: { 'X-Vortex-Actor': nodes.actorHeader(node, user) } });
      await nodes.cancelRemoval(job.nodeId, job.requestId, user);
      change(job, { status: 'failed', phase: 'complete', progress: 0, outcomeUnknown: false, verified: false, finishedAt: timestamp(), message: 'The prepared worker remained intact. Uninstall was canceled without running cleanup.' });
      return;
    }
    if (!validProof(proof, job)) {
      change(job, { status: 'partial', phase: 'review', outcomeUnknown: false, verified: false, retained: proof.retained || [], message: 'Some worker components remain. This VPS stays linked for recovery.', finishedAt: timestamp() });
      return;
    }
    if (closed) throw fail('The panel stopped before verified completion was committed.', 503, { outcomeUnknown: true });
    change(job, { verified: true, retained: proof.retained || [], proof, message: 'Worker removal was verified; saving the completed link removal.' });
    await nodes.completeRemoval(job.nodeId, job.requestId, user, proof, () => Object.assign(job, { status: 'completed', phase: 'complete', progress: 100, verified: true, outcomeUnknown: false, finishedAt: timestamp(), message: 'Vortex worker was uninstalled and this VPS was removed. Shared or unproven components listed in the result were preserved.' }));
    emit({ type: 'update' });
    // Never recursively remove a workspace. Unexpected files remain as
    // explicit recovery material; the application already holds durable proof.
    const cleanup = `rm -f -- ${shell(job.helperPath)} ${shell(job.workspace + '/host-zram.reference.py')} ${shell(job.recoveryPath)}; rmdir -- ${shell(job.workspace)}`;
    try { const result = await connection.exec(cleanup, { allowFailure: true }); if (result.code !== 0) throw new Error('retained'); }
    catch { change(job, { warnings: ['Verified removal completed; the private temporary receipt directory remains on the VPS.'] }); }
  }
  async function work(job, input, user) {
    let dispatchAttempted = false, prepared = false, prepareAttempted = false;
    try {
      await ssh(input, async connection => {
        change(job, { status: 'running', phase: 'checking', progress: 10, message: 'Checking the verified SSH host against this enrolled worker.' });
        const current = await plan(job.nodeId, { operationId: job.requestId });
        if (current.plan.revision !== job.revision || current.plan.status !== 'ready' || current.plan.serverCount !== 0) throw fail('The uninstall plan changed before SSH cleanup.');
        const sshPlan = await connection.exec(`/usr/bin/python3 /opt/vortex-node/current/server/node-removal.py plan --node-id ${shell(job.agentId)}`, { timeoutMs: 35000, maxBytes: 16 * 1024 * 1024 });
        const observed = JSON.parse(sshPlan.stdout);
        if (observed.agentId !== job.agentId || observed.revision !== job.revision || observed.fingerprint !== job.fingerprint || observed.status !== 'ready' || observed.serverCount !== 0) throw fail('The SSH host identity, TLS certificate or empty inventory does not match this VPS.');
        if (closed) throw fail('The panel stopped before preparing uninstall.', 503);
        const base = '/var/lib/vortex-node-removal';
        const setup = `set -eu; [ "$(id -u)" = 0 ]; [ ! -L ${base} ]; if [ ! -e ${base} ]; then mkdir -m 700 -- ${base}; fi; [ "$(stat -c '%u:%a' -- ${base})" = '0:700' ]; mkdir -m 700 -- ${shell(job.workspace)}`;
        await connection.exec(setup);
        const helper = await fsp.readFile(path.join(projectDir, 'server/node-removal.py'));
        await connection.write(job.helperPath, helper, 0o600);
        const actual = await connection.exec(`sha256sum -- ${shell(job.helperPath)}`);
        if (actual.stdout.split(/\s/)[0] !== createHash('sha256').update(helper).digest('hex')) throw fail('The private uninstall helper transfer could not be verified.', 502);
        const zramReference = await fsp.readFile(path.join(projectDir, 'server/host-zram.py'));
        const referencePath = job.workspace + '/host-zram.reference.py';
        await connection.write(referencePath, zramReference, 0o600);
        const referenceActual = await connection.exec(`sha256sum -- ${shell(referencePath)}`);
        if (referenceActual.stdout.split(/\s/)[0] !== createHash('sha256').update(zramReference).digest('hex')) throw fail('The packaged memory-helper reference transfer could not be verified.', 502);
        change(job, { phase: 'quiescing', progress: 25, message: 'Pausing new operations before uninstalling this empty worker.' });
        const node = selected(job.nodeId);
        if (closed) throw fail('The panel stopped before preparing uninstall.', 503);
        prepareAttempted = true;
        let accepted;
        try { accepted = await nodes.call(node, { path: '/api/node/uninstall/prepare', method: 'POST', body: { nodeId: job.agentId, revision: job.revision, requestId: job.requestId, confirmed: true }, timeoutMs: 35000, headers: { 'X-Vortex-Actor': nodes.actorHeader(node, user) } }); }
        catch (error) { if (error.body && error.status >= 400 && error.status < 500) prepareAttempted = false; throw error; }
        if (accepted.accepted !== true || accepted.requestId !== job.requestId || accepted.nodeId !== job.agentId) throw fail('The worker admission freeze was not confirmed.', 502);
        prepared = true;
        change(job, { phase: 'removing', progress: 35, message: 'The detached worker cleanup is running. The VPS remains linked until verified.' });
        dispatchAttempted = true;
        if (closed) throw fail('The panel stopped before dispatch.', 503, { outcomeUnknown: true });
        await connection.exec(`/usr/bin/systemd-run --quiet --no-ask-password --collect --unit=vortex-node-remove-${job.requestId} --property=Type=oneshot --property=TimeoutStartSec=600s ${command(job.helperPath, 'execute', job, true)}`, { timeoutMs: 15000 });
        const deadline = Date.now() + operationTimeoutMs;
        while (Date.now() < deadline && !closed) {
          let result;
          try { result = JSON.parse((await connection.read(job.recoveryPath, 16 * 1024 * 1024)).toString('utf8')); }
          catch (error) { if (error.code !== 2 && error.code !== 'ENOENT') throw error; }
          if (result) {
            if (result.nodeId !== job.agentId || result.requestId !== job.requestId) throw fail('The private uninstall result belongs to another operation.', 502);
            if (result.status === 'completed' || result.status === 'removed') { await verified(connection, job, user); return; }
            if (['failed', 'partial'].includes(result.status)) {
              change(job, { status: result.status, phase: 'review', verified: false, retained: result.retained || [], outcomeUnknown: false, finishedAt: timestamp(), message: 'The cleanup stopped before completion. Existing recovery material was retained.' });
              if (result.effectStarted === false) {
                await nodes.call(node, { path: '/api/node/uninstall/abort', method: 'POST', body: { nodeId: job.agentId, requestId: job.requestId }, headers: { 'X-Vortex-Actor': nodes.actorHeader(node, user) } });
                await nodes.cancelRemoval(job.nodeId, job.requestId, user);
              }
              return;
            }
          }
          await sleep(pollIntervalMs);
        }
        throw fail('Uninstall outcome is unknown. Reconnect through SSH to verify this operation.', 504, { outcomeUnknown: true });
      });
    } catch {
      if (job.status !== 'completed') {
        try { change(job, { status: dispatchAttempted || prepared || prepareAttempted ? 'unknown' : 'failed', phase: 'review', verified: false, outcomeUnknown: dispatchAttempted || prepared || prepareAttempted, finishedAt: timestamp(), message: dispatchAttempted || prepared || prepareAttempted ? 'Uninstall outcome is unknown. This VPS stays linked; verify the existing operation through SSH without repeating it.' : 'SSH identity or uninstall preflight failed. No worker cleanup was dispatched.' }); }
        catch { Object.assign(job, { status: 'unknown', outcomeUnknown: true, completionStatusPersisted: false }); }
        if (!dispatchAttempted && !prepared && !prepareAttempted) await nodes.cancelRemoval(job.nodeId, job.requestId, user).catch(() => {});
      }
    } finally { scrub(input); tasks.delete(job.id); }
  }
  async function startImmediate(id, input, user) {
    strict(input, ['nodeId', 'revision', 'requestId', 'confirmed', 'confirmationName', 'ssh']);
    if (closed || user?.role !== 'admin') throw fail('Administrator authentication is required.', 403);
    if (typeof ssh !== 'function') throw fail('Verified SSH uninstall is unavailable in this runtime.', 409);
    if (input.nodeId !== id || !UUID.test(input.requestId || '') || !SHA.test(input.revision || '') || input.confirmed !== true) throw fail('Confirm the selected VPS and its current uninstall plan.', 400);
    const existing = store.data.nodeRemovalJobs.find(job => job.requestId === input.requestId);
    if (existing) { if (existing.nodeId !== id || existing.revision !== input.revision) throw fail('This request identifier belongs to a different uninstall.'); scrub(input.ssh); return publicJob(existing); }
    const node = selected(id);
    if (input.confirmationName !== node.name || !input.ssh || typeof input.ssh !== 'object') throw fail('Type the exact VPS name and provide a pinned SSH administrator connection.', 400);
    const current = await plan(id);
    if (current.plan.status !== 'ready' || current.plan.serverCount !== 0 || current.plan.revision !== input.revision) throw fail('The uninstall inventory is blocked or has changed.');
    const sshTarget = sshIdentity(input.ssh);
    const job = { id: input.requestId, requestId: input.requestId, type: 'node-uninstall', adminOnly: true, scope: 'nodes', serverId: null, nodeId: id, agentId: node.agentId, fingerprint: nodes.credentials(node).fingerprint || current.plan.fingerprint, revision: input.revision, sshTarget, status: 'queued', phase: 'checking', progress: 0, message: 'Queued for verified worker uninstall.', createdAt: timestamp(), verified: false, workspace: `/var/lib/vortex-node-removal/${input.requestId}` };
    job.helperPath = job.workspace + '/helper.py'; job.recoveryPath = job.workspace + '/result.json';
    const old = store.data.nodeRemovalJobs; store.data.nodeRemovalJobs = [job, ...old];
    try { await nodes.beginRemoval(id, job.requestId, user); }
    catch (error) { store.data.nodeRemovalJobs = old; throw error; }
    const privateInput = { ...input.ssh }; scrub(input.ssh);
    const task = Promise.resolve().then(() => work(job, privateInput, { id: user.id, username: user.username, role: user.role }));
    tasks.set(job.id, task); emit({ type: 'update' }); return publicJob(job);
  }
  function start(id, input, user) { const run = admissionTail.then(() => startImmediate(id, input, user)); admissionTail = run.catch(() => {}); return run; }
  async function verify(id, input, user) {
    strict(input, ['nodeId', 'requestId', 'ssh']);
    const job = get(id);
    if (closed || user?.role !== 'admin') throw fail('Administrator authentication is required.', 403);
    if (job.nodeId !== input.nodeId || job.requestId !== input.requestId || !input.ssh || typeof input.ssh !== 'object' || JSON.stringify(sshIdentity(input.ssh)) !== JSON.stringify(job.sshTarget)) throw fail('The verification target or pinned SSH host does not match this uninstall.', 400);
    if (job.status === 'completed') { scrub(input.ssh); return publicJob(job); }
    if (job.status === 'failed' && !job.outcomeUnknown) { scrub(input.ssh); return publicJob(job); }
    if (tasks.has(job.id)) throw fail('This uninstall already has an active verifier.');
    const privateInput = { ...input.ssh }; scrub(input.ssh);
    const task = (async () => {
      try { await ssh(privateInput, connection => verified(connection, job, user)); }
      catch { try { change(job, { status: 'unknown', phase: 'review', outcomeUnknown: true, verified: false, message: 'Independent SSH verification could not confirm completion. The existing uninstall was not run again.' }); } catch { job.completionStatusPersisted = false; } }
      finally { scrub(privateInput); tasks.delete(job.id); }
    })();
    tasks.set(job.id, task); return publicJob(job);
  }
  return { plan, start, verify, jobs: () => store.data.nodeRemovalJobs.map(publicJob), getJob: id => publicJob(get(id)), isRemoving: id => store.data.nodeRemovalJobs.some(job => job.nodeId === id && active.has(job.status)), async close() { closed = true; for (const job of store.data.nodeRemovalJobs) if (tasks.has(job.id) && job.status !== 'completed') { try { change(job, { status: 'unknown', phase: 'review', outcomeUnknown: true, message: 'The panel stopped during uninstall. Verify the retained operation through SSH; it will not run again automatically.' }); } catch { job.completionStatusPersisted = false; } } await Promise.race([Promise.allSettled([...tasks.values()]), new Promise(resolve => { const timer = setTimeout(resolve, 4000); timer.unref?.(); })]); } };
}
