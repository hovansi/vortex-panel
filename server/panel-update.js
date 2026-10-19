import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';

const REPOSITORY = 'hovansi/vortex-panel';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MACHINE = /^[a-f0-9]{32}$/i;
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const UPDATE_PROTOCOL_VERSION = '0.20.0';
const pending = new Set(['queued', 'running', 'unknown']);
const secrets = ['password', 'privateKey', 'passphrase'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const shell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const now = () => new Date().toISOString();
const compare = (a, b) => { const left = a.split('.').map(Number), right = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1; return 0; };
const messages = {
  input: ['Confirm the exact approved stable release and every pinned SSH connection.', 'Xác nhận đúng bản phát hành ổn định và kết nối SSH đã ghim cho mọi VPS.'],
  unavailable: ['Source updates require a managed Linux installation running as root.', 'Cập nhật source cần bản cài Linux được quản lý và chạy bằng root.'],
  release: ['The official stable release could not be verified. Refresh the release check before updating.', 'Không xác minh được bản ổn định chính thức. Tải lại thông tin bản phát hành trước khi cập nhật.'],
  busy: ['Finish other system operations and stop every server before updating. Customer workloads are never stopped automatically.', 'Hoàn tất tác vụ hệ thống và dừng mọi server trước khi cập nhật. Hệ thống không tự dừng server của bạn.'],
  stale: ['The release, fleet or installation changed. Refresh the plan and verify SSH again.', 'Bản phát hành, cụm VPS hoặc bản cài đã thay đổi. Tải lại kế hoạch và xác minh SSH lại.'],
  protocol: ['This legacy VPS needs a one-time maintenance upgrade through its worker installer before safe panel updates. Stop its servers, preserve its existing node configuration and data, then upgrade and refresh this plan. The panel will not bypass update admission or stop workloads automatically.', 'VPS cũ này cần nâng cấp bảo trì một lần bằng bộ cài worker trước khi cập nhật an toàn từ panel. Dừng server, giữ nguyên cấu hình node và dữ liệu, nâng cấp rồi tải lại kế hoạch. Panel không bỏ qua khóa cập nhật hoặc tự dừng server.'],
  newer: ['A VPS is newer than the verified stable release. Downgrades are blocked; refresh the release and fleet before updating.', 'Có VPS mới hơn bản ổn định đã xác minh. Không cho hạ phiên bản; tải lại bản phát hành và cụm VPS trước khi cập nhật.'],
  ssh: ['Pinned root SSH must match the exact installation on every VPS.', 'SSH root đã ghim phải khớp đúng bản cài trên từng VPS.'],
  native: ['Source update verification failed. Review the existing request before retrying.', 'Xác minh cập nhật source thất bại. Kiểm tra yêu cầu hiện có trước khi thử lại.'],
  queued: ['Update accepted. Preparing verified source on every VPS before activating any release.', 'Đã nhận cập nhật. Đang chuẩn bị source đã xác minh trên mọi VPS trước khi kích hoạt.'],
  preparing: ['Verifying release assets and installing isolated source dependencies.', 'Đang xác minh gói phát hành và chuẩn bị dependency riêng cho source.'],
  updating: ['Activating this worker before the main panel.', 'Đang kích hoạt bản mới trên VPS phụ trước panel chính.'],
  verifying: ['Independently verifying the worker through a new pinned SSH connection.', 'Đang xác minh độc lập VPS phụ qua kết nối SSH mới đã ghim.'],
  verifying_main: ['Workers are verified. Verifying the already-current main panel without restarting it.', 'Đã xác minh VPS phụ. Đang xác minh panel chính đã dùng bản mới nhất mà không khởi động lại.'],
  verified: ['Worker source and service verified; customer definitions and data identity were preserved.', 'Đã xác minh source và dịch vụ VPS phụ; cấu hình server cùng định danh dữ liệu được giữ nguyên.'],
  handoff: ['Every worker is verified. The main panel will restart shortly; reconnect to verify the result.', 'Đã xác minh mọi VPS phụ. Panel chính sẽ khởi động lại; kết nối lại để kiểm tra kết quả.'],
  completed: ['All linked workers and the main panel are running the verified release.', 'Mọi VPS phụ và panel chính đang chạy bản phát hành đã xác minh.'],
  failed: ['Update stopped. The main panel was kept or its previous source was restored. Already verified workers remain updated.', 'Cập nhật đã dừng. Panel chính được giữ hoặc source cũ đã khôi phục. VPS phụ đã xác minh vẫn giữ bản mới.'],
  unknown: ['The controller lost confirmation. Inspect this existing request; it will never be dispatched again automatically.', 'Panel mất xác nhận. Kiểm tra yêu cầu hiện có; hệ thống không tự gửi lại tác vụ.'],
  persisted: ['Update state could not be saved. No additional activation was dispatched.', 'Không lưu được trạng thái cập nhật. Chưa gửi thêm lệnh kích hoạt.'],
};
const present = key => ({ message: messages[key][0], messageI18n: { id: `panel.fleet-update.${key}`, en: messages[key][0], vi: messages[key][1], params: [] } });
const fail = (key, status = 409, fields = {}) => Object.assign(new Error(messages[key][0]), { code: 'PANEL_UPDATE_' + key.toUpperCase(), status, ...fields });
export const PANEL_UPDATE_MESSAGES = Object.freeze(Object.keys(messages).map(key => present(key).messageI18n));
export function panelUpdateErrorPayload(error, language = 'en') {
  const key = error?.code?.startsWith('PANEL_UPDATE_') ? error.code.slice(13).toLowerCase() : '';
  return messages[key] ? { error: messages[key][language === 'vi' ? 1 : 0], code: error.code, errorI18n: present(key).messageI18n, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) } : null;
}
function strict(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('input', 400); }
function clear(value) { if (value && typeof value === 'object') for (const key of secrets) delete value[key]; }
function validPlan(value, role, nodeId) {
  if (value?.schemaVersion !== 1 || value.role !== role || value.nodeId !== nodeId || !MACHINE.test(value.machineId || '') || !SHA.test(value.revision || '') || !SHA.test(value.installationId || '') || !VERSION.test(value.version || '') || !Array.isArray(value.blockers) || !['ready', 'blocked'].includes(value.status)) throw fail('native', 502);
  return value;
}
function validProof(value, row, job) {
  return value?.schemaVersion === 1 && value.role === (row.local ? 'panel' : 'worker') && value.nodeId === (row.local ? 'local' : row.agentId) && value.machineId === row.observed.machineId && value.installationId === row.observed.installationId && value.requestId === job.requestId && value.version === job.version && value.archiveSHA256 === job.release.archiveSHA256 && ['verified', 'sourceVerified', 'serviceHealthy', 'configurationPreserved', 'dataIdentityPreserved', 'customerDefinitionsPreserved', 'independentlyVerified'].every(key => value[key] === true);
}
function validRollbackProof(value, row, job) {
  return value?.schemaVersion === 1 && value.requestId === job.requestId && value.role === (row.local ? 'panel' : 'worker') && value.nodeId === (row.local ? 'local' : row.agentId) && value.machineId === row.observed.machineId && value.installationId === row.observed.installationId && value.version === row.observed.version && value.rolledBack === true && value.independentlyVerified === true;
}

// The durable intent is created only after staging is ready. It prevents a new
// service instance from starting customer workloads before native verification.
export function createPanelUpdateIntentProbe({ manager, dataDir, role, nodeId, store }) {
  let ownRelease, ownRequest, firstProbe = true;
  return function restorePanelUpdateIntent() {
    const atBoot = firstProbe; firstProbe = false;
    const filename = path.join(dataDir, '.panel-update-intent.json'); let request;
    try {
      const info = fs.lstatSync(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || process.platform === 'linux' && (info.uid !== 0 || info.mode & 0o077)) throw fail('native', 503);
      const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (value.schemaVersion !== 1 || value.role !== role || value.nodeId !== nodeId || !UUID.test(value.requestId || '') || !MACHINE.test(value.machineId || '') || !SHA.test(value.installationId || '')) throw fail('native', 503);
      request = value.requestId;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!request && role === 'panel') request = store?.data?.panelUpdateJobs?.find(row => pending.has(row.status))?.requestId;
    if (request && request !== ownRequest) { if (ownRelease) throw fail('busy', 503); ownRelease = manager.beginMaintenance({ action: 'update', requestId: request, restore: atBoot }); ownRequest = request; }
    if (!request && ownRelease) { ownRelease(); ownRelease = undefined; ownRequest = undefined; }
  };
}

export function runPanelUpdateHelper(helper, action, input, { timeoutMs = action === 'prepare' ? 15 * 60 * 1000 : 45000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-I', '-B', helper, action, '--role', input.role, '--node-id', input.nodeId, ...(input.requestId && action !== 'prepare' ? ['--request-id', input.requestId] : [])];
    const child = spawnProcess('/usr/bin/python3', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8'); let stdout = '', bytes = 0, settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(JSON.parse(stdout)); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('native', 504, { outcomeUnknown: action === 'launch' })); }, timeoutMs); timer.unref?.();
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 ** 2) { child.kill('SIGKILL'); finish(fail('native', 502)); } else stdout += decoder.write(chunk); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 ** 2) { child.kill('SIGKILL'); finish(fail('native', 502)); } });
    child.once('error', () => finish(fail('unavailable', 503)));
    child.once('close', code => { if (settled) return; stdout += decoder.end(); try { const result = JSON.parse(stdout); if (code !== 0 || result?.ok === false) throw fail('native', 409, { nativeMessage: typeof result?.error === 'string' ? result.error.slice(0, 2048) : undefined }); finish(); } catch (error) { finish(error.code ? error : fail('native', 502)); } });
    child.stdin.end(['prepare', 'attest'].includes(action) ? JSON.stringify(input) : '');
  });
}

async function boundedFetch(url, maximum, fetchImpl = fetch) {
  for (let redirect = 0; redirect < 6; redirect++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.port && target.port !== '443' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw fail('release', 502);
    const response = await fetchImpl(target, { redirect: 'manual', headers: { Accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'Vortex-Panel-Updater' }, signal: AbortSignal.timeout(45000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel?.(); if (!response.headers.get('location')) throw fail('release', 502); url = new URL(response.headers.get('location'), target).href; continue; }
    if (!response.ok || Number(response.headers.get('content-length')) > maximum) throw fail('release', 502);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maximum) { await response.body.cancel?.().catch(() => {}); throw fail('release', 502); } chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  }
  throw fail('release', 502);
}
export async function discoverPanelRelease({ fetchImpl = fetch } = {}) {
  try {
    const release = JSON.parse((await boundedFetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, 2 * 1024 ** 2, fetchImpl)).toString('utf8'));
    const version = String(release.tag_name || '').slice(1);
    if (!VERSION.test(version) || release.tag_name !== 'v' + version || release.draft !== false || release.prerelease !== false || release.html_url !== `https://github.com/${REPOSITORY}/releases/tag/v${version}` || !Array.isArray(release.assets) || release.assets.length > 30) throw fail('release', 502);
    const names = [`vortex-panel-${version}.zip`, 'release-manifest.json', 'SHA256SUMS', 'install.sh']; const assets = {};
    for (const name of names) {
      const rows = release.assets.filter(row => row.name === name), row = rows[0];
      if (rows.length !== 1 || row.state !== 'uploaded' || row.browser_download_url !== `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}` || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > 128 * 1024 ** 2 || !/^sha256:[a-f0-9]{64}$/.test(row.digest || '')) throw fail('release', 502);
      assets[name] = { bytes: row.size, sha256: row.digest.slice(7), url: row.browser_download_url };
    }
    const manifestBytes = await boundedFetch(assets['release-manifest.json'].url, 4 * 1024 ** 2, fetchImpl);
    if (manifestBytes.length !== assets['release-manifest.json'].bytes || createHash('sha256').update(manifestBytes).digest('hex') !== assets['release-manifest.json'].sha256) throw fail('release', 502);
    const manifest = JSON.parse(manifestBytes);
    const archive = assets[`vortex-panel-${version}.zip`];
    if (manifest.schema !== 1 || manifest.name !== 'vortex-panel' || manifest.repository !== REPOSITORY || manifest.version !== version || manifest.tag !== 'v' + version || manifest.archive?.name !== `vortex-panel-${version}.zip` || manifest.archive?.sha256 !== archive.sha256 || manifest.archive?.bytes !== archive.bytes || !Array.isArray(manifest.inventory) || manifest.sourceFiles !== manifest.inventory.length) throw fail('release', 502);
    return { version, tag: 'v' + version, url: release.html_url, name: String(release.name || `Vortex Panel ${version}`).slice(0, 160), publishedAt: release.published_at || null, notes: String(release.body || '').slice(0, 20000), archiveSHA256: archive.sha256, manifestSHA256: assets['release-manifest.json'].sha256, archiveBytes: archive.bytes, repository: REPOSITORY, verified: true, checkedAt: now() };
  } catch (error) { throw error.code?.startsWith('PANEL_UPDATE_') ? error : fail('release', 502); }
}

export function createPanelUpdateController({ store, nodes, manager, dataDir, projectDir, ssh, discover, emit = () => {}, native,
  releaseDiscovery = discoverPanelRelease, platform = process.platform, uid = process.getuid?.(), pollIntervalMs = 1500, operationTimeoutMs = 20 * 60 * 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!store || !nodes || !manager || !dataDir || !projectDir) throw new Error('Fleet update requires the durable store, fixed roots and linked node registry.');
  const invoke = native || ((action, input) => runPanelUpdateHelper(path.join(projectDir, 'server/fleet-update.py'), action, input));
  const checks = new Map(), tasks = new Map(), reconciliations = new Map(); let closed = false, admission = false, cachedRelease, cachedAt = 0, releaseLock;
  store.data.panelUpdateJobs ||= []; if (!Array.isArray(store.data.panelUpdateJobs)) throw fail('native', 503);
  let recovered = false;
  for (const job of store.data.panelUpdateJobs) if (['queued', 'running'].includes(job.status)) { Object.assign(job, { status: 'unknown', outcomeUnknown: true, ...present('unknown') }); recovered = true; }
  if (recovered) store.save();
  const currentName = () => store.data.settings.localNodeName || 'Vortex Panel';
  const members = () => [...store.data.nodes.map(row => {
    const observed = nodes.stateOf?.(row), version = observed?.snapshot?.version;
    return { nodeId: row.id, name: row.name, local: false, agentId: row.agentId, host: new URL(row.endpoint).hostname, address: row.publicAddress || new URL(row.endpoint).hostname, version: typeof version === 'string' && VERSION.test(version) ? version : null, versionStale: observed?.online !== true, versionObservedAt: observed?.sampledAt || observed?.lastSeen || null, serverCount: row.inventory?.length || 0 };
  }), { nodeId: 'local', name: currentName(), local: true, address: process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '', serverCount: store.data.servers.length }];
  const membership = () => store.data.nodes.map(row => [row.id, row.agentId, row.name, row.endpoint, row.tokenEncrypted, row.fingerprint]);
  const revisionFor = (local, release) => digest([local.revision, currentName(), membership(), release.version, release.archiveSHA256, release.manifestSHA256]);
  const base = row => ({ schemaVersion: 1, role: row.local ? 'panel' : 'worker', nodeId: row.local ? 'local' : row.agentId });
  const get = id => store.data.panelUpdateJobs.find(row => row.id === id) || (() => { throw fail('input', 404); })();
  const publicJob = job => {
    const result = copy(Object.fromEntries(['id', 'requestId', 'type', 'scope', 'adminOnly', 'serverId', 'panelName', 'revision', 'version', 'release', 'status', 'phase', 'progress', 'verified', 'createdAt', 'updatedAt', 'finishedAt', 'nodes', 'handoff', 'message', 'messageI18n', 'outcomeUnknown', 'nativeMessage'].filter(key => job[key] !== undefined).map(key => [key, job[key]])));
    result.nodes = result.nodes.map(row => ({ ...row, verified: validProof(row.proof, row, job), recoveryPath: row.alreadyCurrent ? `${row.local ? '/opt/vortex-panel' : '/opt/vortex-node'}/current` : `${row.local ? '/opt/vortex-panel' : '/opt/vortex-node'}/updates/${job.requestId}`, verificationCommand: row.alreadyCurrent ? null : `/usr/bin/python3 -I -B ${helperFor(row, job.requestId)} verify --role ${row.local ? 'panel' : 'worker'} --node-id ${row.local ? 'local' : row.agentId} --request-id ${job.requestId}` }));
    return result;
  };
  function change(job, fields, nodeId, rowFields) {
    const before = copy(job), previous = store.data.panelUpdateJobs;
    if (nodeId) Object.assign(job.nodes.find(row => row.nodeId === nodeId), rowFields);
    Object.assign(job, fields, { updatedAt: now() }); let terminal = 0;
    store.data.panelUpdateJobs = previous.filter(row => pending.has(row.status) || terminal++ < 20);
    try { store.save(); } catch { for (const key of Object.keys(job)) delete job[key]; Object.assign(job, before); store.data.panelUpdateJobs = previous; throw fail('persisted', 503); }
    emit({ type: 'update' });
  }
  async function latest(refresh = false) { if (!refresh && cachedRelease && Date.now() - cachedAt < 60 * 60 * 1000) return cachedRelease; const value = await releaseDiscovery(); if (!value?.verified || !VERSION.test(value.version || '') || !SHA.test(value.archiveSHA256 || '') || !SHA.test(value.manifestSHA256 || '')) throw fail('release', 502); cachedRelease = value; cachedAt = Date.now(); return value; }
  async function localPlan() { if (platform !== 'linux' || uid !== 0) throw fail('unavailable'); return validPlan(await invoke('plan', { role: 'panel', nodeId: 'local' }), 'panel', 'local'); }
  async function plan({ refresh = false } = {}) {
    for (const job of store.data.panelUpdateJobs.filter(row => pending.has(row.status) && ['handoff', 'recovering'].includes(row.phase))) await reconcileMain(job).catch(() => {});
    let local, release, blockers = []; try { local = await localPlan(); blockers.push(...local.blockers); } catch { blockers.push({ code: 'UPDATE_UNAVAILABLE', ...present('unavailable') }); }
    try { release = await latest(refresh); } catch { blockers.push({ code: 'UPDATE_RELEASE', ...present('release') }); }
    const rows = members();
    for (const row of rows) {
      const servers = row.local ? store.data.servers : store.data.nodes.find(node => node.id === row.nodeId)?.inventory || [];
      row.blockers = servers.some(server => !['stopped', 'error'].includes(server.status) || server.busy) ? [{ code: 'UPDATE_SERVERS_RUNNING', ...present('busy') }] : [];
      if (row.local && local) { row.version = local.version; row.blockers = [...local.blockers]; }
      row.needsUpdate = Boolean(release && row.version && compare(release.version, row.version) > 0);
      row.updateProtocolRequired = Boolean(!row.local && row.version && compare(row.version, UPDATE_PROTOCOL_VERSION) < 0);
      if (row.updateProtocolRequired) row.blockers.push({ code: 'UPDATE_PROTOCOL_REQUIRED', ...present('protocol') });
      if (release && row.version && compare(row.version, release.version) > 0) row.blockers.push({ code: 'UPDATE_NEWER_VERSION', ...present('newer') });
      if (row.blockers.length) blockers.push({ nodeId: row.nodeId, ...row.blockers[0] });
      row.sshRequired = true;
    }
    const existing = store.data.panelUpdateJobs.find(row => pending.has(row.status));
    if (existing) blockers.push({ code: 'UPDATE_PENDING', ...present('unknown') });
    const currentVersion = local?.version || JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
    const mainUpdateRequired = Boolean(release && compare(release.version, currentVersion) > 0), laggingNodeIds = rows.filter(row => row.needsUpdate).map(row => row.nodeId);
    const available = Boolean(release && compare(release.version, currentVersion) >= 0 && (mainUpdateRequired || laggingNodeIds.length));
    return { update: { schemaVersion: 1, currentVersion, latestVersion: release?.version || null, available, availableReason: available ? mainUpdateRequired ? 'panel' : 'fleet' : 'current', mainUpdateRequired, laggingNodeIds, bootstrapRequiredNodeIds: rows.filter(row => row.updateProtocolRequired).map(row => row.nodeId), status: blockers.length ? 'blocked' : available ? 'ready' : 'current', release: release || null, revision: local && release ? revisionFor(local, release) : null, nodes: rows, blockers, latestJobId: existing?.id || store.data.panelUpdateJobs[0]?.id || null, policy: { sourceOnly: true, workersFirst: true, mainRestartRequired: mainUpdateRequired, requiresStoppedServers: true, changesRuntimeVersions: false, automaticWorkloadStop: false } } };
  }
  async function stage(connection, callback) {
    const parent = await connection.lstat('/run'); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o022) throw fail('ssh');
    const filename = path.join(projectDir, 'server/fleet-update.py'), info = await fsp.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256 * 1024) throw fail('native', 503);
    const content = await fsp.readFile(filename), sha256 = createHash('sha256').update(content).digest('hex'), root = '/run/vortex-update-check-' + randomUUID();
    await connection.mkdir(root, 0o700);
    try {
      await connection.write(root + '/helper.py', content, 0o600);
      const inspect = `import os,stat,hashlib;p=${JSON.stringify(root + '/helper.py')};s=os.lstat(p);assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077 and hashlib.sha256(open(p,'rb').read()).hexdigest()==${JSON.stringify(sha256)}`;
      await connection.exec('/usr/bin/python3 -I -c ' + shell(inspect), { timeoutMs: 30000 });
      return await callback(root + '/helper.py');
    } finally {
      const cleanup = `import os,stat,hashlib;r=${JSON.stringify(root)};p=r+'/helper.py';s=os.lstat(p);assert os.path.realpath(r)==r and os.stat(r).st_uid==0 and not os.stat(r).st_mode&0o077 and set(os.listdir(r))=={'helper.py'} and stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and hashlib.sha256(open(p,'rb').read()).hexdigest()==${JSON.stringify(sha256)};os.unlink(p);os.rmdir(r)`;
      await connection.exec('/usr/bin/python3 -I -c ' + shell(cleanup), { timeoutMs: 30000, allowFailure: true }).catch(() => {});
    }
  }
  async function remote(connection, helper, action, input) {
    const body = ['prepare', 'attest'].includes(action);
    const command = `/usr/bin/python3 -I -B ${shell(helper)} ${action} --role ${shell(input.role)} --node-id ${shell(input.nodeId)}${input.requestId && !body ? ' --request-id ' + shell(input.requestId) : ''}${body ? " <<'VORTEX_UPDATE_REQUEST'\n" + JSON.stringify(input) + '\nVORTEX_UPDATE_REQUEST' : ''}`;
    const result = await connection.exec(command, { timeoutMs: action === 'prepare' ? 15 * 60 * 1000 : 45000, maxBytes: 8 * 1024 ** 2, allowFailure: true });
    let value; try { value = JSON.parse(result.stdout); } catch { throw fail('native', 502, { outcomeUnknown: action === 'launch' }); }
    if (result.code !== 0 || value?.ok === false) throw fail('native', 409, { nativeMessage: typeof value?.error === 'string' ? value.error.slice(0, 2048) : undefined, ...(action === 'launch' ? { outcomeUnknown: true } : {}) });
    return value;
  }
  async function withConnection(credentials, callback) { if (closed || typeof ssh !== 'function') throw fail('unavailable', 503); return ssh(copy(credentials), callback); }
  function bind(row, value, local) {
    validPlan(value, row.local ? 'panel' : 'worker', row.local ? 'local' : row.agentId);
    if (value.blockers.some(row => row.code === 'UPDATE_PROTOCOL_REQUIRED')) throw fail('protocol');
    if (value.status !== 'ready') throw fail('busy');
    if (row.local) { if (value.machineId !== local.machineId || value.revision !== local.revision) throw fail('ssh'); }
    else { const credentials = nodes.credentials(nodes.get(row.nodeId)); if (value.machineId === local.machineId || value.tokenHash !== createHash('sha256').update(credentials.token).digest('hex')) throw fail('ssh'); }
    return value;
  }
  const checkKey = (user, id) => `${user.id || user.username}:${id}`;
  async function check(input, user) {
    strict(input, ['nodeId', 'ssh']); strict(input.ssh, ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint']);
    const row = members().find(value => value.nodeId === input.nodeId); if (!row) throw fail('input', 400);
    if (!input.ssh.hostFingerprint) { if (typeof discover !== 'function' || Object.keys(input.ssh).some(key => !['host', 'port'].includes(key))) throw fail('input', 400); return { nodeId: row.nodeId, ...await discover(input.ssh) }; }
    try {
      if (input.ssh.username !== 'root') throw fail('ssh', 400);
      const local = await localPlan(), release = await latest();
      const observed = await withConnection(input.ssh, connection => stage(connection, helper => remote(connection, helper, 'plan', base(row)).then(value => bind(row, value, local))));
      if (!row.local && compare(observed.version, UPDATE_PROTOCOL_VERSION) < 0) throw fail('protocol');
      if (compare(release.version, observed.version) < 0) throw fail('stale');
      checks.set(checkKey(user, row.nodeId), { at: Date.now(), target: { host: input.ssh.host, port: input.ssh.port ?? 22, hostFingerprint: input.ssh.hostFingerprint }, observed, fleetRevision: revisionFor(local, release) });
      return { nodeId: row.nodeId, authenticated: true, hostFingerprint: input.ssh.hostFingerprint, version: observed.version, machineId: observed.machineId, serverCount: observed.serverCount, status: observed.status, blockers: observed.blockers };
    } finally { clear(input.ssh); }
  }
  const helperFor = (row, requestId) => `${row.local ? '/opt/vortex-panel' : '/opt/vortex-node'}/updates/${requestId}/helper.py`;
  const requestFor = (row, job) => ({ ...base(row), requestId: job.requestId, revision: row.observed.revision, installationId: row.observed.installationId, version: job.version, manifestSHA256: job.release.manifestSHA256, archiveSHA256: job.release.archiveSHA256 });
  async function reconcileMain(job) {
    if (reconciliations.has(job.id)) return reconciliations.get(job.id);
    const task = performReconcileMain(job).finally(() => reconciliations.delete(job.id));
    reconciliations.set(job.id, task); return task;
  }
  async function performReconcileMain(job) {
    if (!['handoff', 'recovering'].includes(job.phase) || !pending.has(job.status) || !job.nodes.filter(row => !row.local).every(row => validProof(row.proof, row, job))) return;
    const row = job.nodes.find(value => value.local); if (!row?.observed) return;
    const status = await invoke('status', { ...base(row), requestId: job.requestId }).catch(() => null);
    if (status?.status === 'completed') {
      const proof = await invoke('verify', { ...base(row), requestId: job.requestId });
      if (!validProof(proof, row, job)) throw fail('native', 502);
      change(job, { status: 'completed', phase: 'completed', progress: 100, verified: true, outcomeUnknown: false, finishedAt: now(), ...present('completed') }, row.nodeId, { status: 'completed', proof, progress: 100 });
      releaseLock?.(); releaseLock = undefined;
    } else if (status?.status === 'failed' && status.rolledBack === true) {
      const proof = await invoke('verify-rollback', { ...base(row), requestId: job.requestId });
      if (!validRollbackProof(proof, row, job)) throw fail('native', 502);
      change(job, { status: 'failed', phase: 'failed', outcomeUnknown: false, finishedAt: now(), ...present('failed') }, row.nodeId, { status: 'failed', rolledBack: true, rollbackProof: proof }); releaseLock?.(); releaseLock = undefined;
    }
  }
  async function execute(job, credentials) {
    const prepared = new Set(); let dispatched, preparing, verifyingCurrentMain = false;
    try {
      for (const row of job.nodes) {
        if (closed) throw fail('busy');
        if (row.local && row.observed.version === job.version) { change(job, {}, row.nodeId, { alreadyCurrent: true }); continue; }
        change(job, { status: 'running', phase: 'preparing', ...present('preparing') }, row.nodeId, { status: 'preparing', progress: 10 });
        const request = requestFor(row, job);
        if (!row.local && row.observed.version === job.version) {
          const proof = await withConnection(credentials.get(row.nodeId), connection => stage(connection, helper => remote(connection, helper, 'attest', request)));
          if (!validProof(proof, row, job)) throw fail('native', 502);
          change(job, {}, row.nodeId, { status: 'completed', progress: 100, alreadyCurrent: true, proof });
          continue;
        }
        preparing = row.nodeId;
        if (row.local) await invoke('prepare', request);
        else await withConnection(credentials.get(row.nodeId), connection => stage(connection, async helper => { const current = bind(row, await remote(connection, helper, 'plan', base(row)), await localPlan()); if (current.revision !== row.observed.revision) throw fail('stale'); await remote(connection, helper, 'prepare', request); }));
        prepared.add(row.nodeId); preparing = undefined; change(job, { progress: Math.floor(30 * prepared.size / job.nodes.length) }, row.nodeId, { status: 'prepared', progress: 30 });
      }
      for (const row of job.nodes.filter(value => !value.local && !value.alreadyCurrent)) {
        if (closed) throw fail('busy');
        dispatched = row.nodeId;
        change(job, { phase: 'updating', ...present('updating') }, row.nodeId, { status: 'running', progress: 45 });
        await withConnection(credentials.get(row.nodeId), connection => remote(connection, helperFor(row, job.requestId), 'launch', { ...base(row), requestId: job.requestId }));
        const started = Date.now(); let status;
        while (!closed && Date.now() - started < operationTimeoutMs) {
          await sleep(pollIntervalMs);
          status = await withConnection(credentials.get(row.nodeId), connection => remote(connection, helperFor(row, job.requestId), 'status', { ...base(row), requestId: job.requestId }));
          if (['completed', 'failed', 'unknown'].includes(status.status)) break;
        }
        if (status?.status === 'failed' && status.rolledBack === true) {
          const proof = await withConnection(credentials.get(row.nodeId), connection => remote(connection, helperFor(row, job.requestId), 'verify-rollback', { ...base(row), requestId: job.requestId }));
          if (!validRollbackProof(proof, row, job)) throw fail('native', 502, { outcomeUnknown: true });
          prepared.delete(row.nodeId); dispatched = undefined;
          change(job, {}, row.nodeId, { status: 'failed', rolledBack: true, rollbackProof: proof });
          throw fail('native');
        }
        if (status?.status !== 'completed') throw fail('native', 409, { outcomeUnknown: true });
        change(job, { phase: 'verifying', ...present('verifying') }, row.nodeId, { progress: 85 });
        const proof = await withConnection(credentials.get(row.nodeId), connection => remote(connection, helperFor(row, job.requestId), 'verify', { ...base(row), requestId: job.requestId }));
        if (!validProof(proof, row, job)) throw fail('native', 502, { outcomeUnknown: true });
        prepared.delete(row.nodeId); dispatched = undefined;
        change(job, { progress: 30 + Math.floor(55 * (job.nodes.filter(value => !value.local && value.proof).length + 1) / Math.max(1, job.nodes.length - 1)), ...present('verified') }, row.nodeId, { status: 'completed', progress: 100, proof });
      }
      if (closed) throw fail('busy');
      const main = job.nodes.find(row => row.local);
      if (main.alreadyCurrent) {
        verifyingCurrentMain = true;
        change(job, { phase: 'verifying', progress: 95, ...present('verifying_main') }, main.nodeId, { status: 'running', progress: 85 });
        const proof = await withConnection(credentials.get(main.nodeId), connection => stage(connection, helper => remote(connection, helper, 'attest', requestFor(main, job))));
        if (closed || !validProof(proof, main, job)) throw fail('native', 502, { outcomeUnknown: true });
        change(job, { status: 'completed', phase: 'completed', progress: 100, verified: true, outcomeUnknown: false, finishedAt: now(), ...present('completed') }, main.nodeId, { status: 'completed', proof, progress: 100 });
        releaseLock?.(); releaseLock = undefined; return;
      }
      dispatched = main.nodeId;
      change(job, { phase: 'handoff', progress: 90, handoff: true, ...present('handoff') }, main.nodeId, { status: 'scheduled', progress: 50 });
      await invoke('launch', { ...base(main), requestId: job.requestId });
      // The detached native helper survives this controller's service restart.
      // Only a fresh process inspecting its completed receipt may report green.
    } catch (error) {
      let unknown = Boolean(dispatched || verifyingCurrentMain || error.outcomeUnknown);
      if (preparing) {
        const row = job.nodes.find(value => value.nodeId === preparing);
        try {
          const status = row.local ? await invoke('status', { ...base(row), requestId: job.requestId }) : await withConnection(credentials.get(row.nodeId), connection => stage(connection, helper => remote(connection, helper, 'status', { ...base(row), requestId: job.requestId })));
          if (status.status === 'prepared') prepared.add(row.nodeId);
          else if (!['absent', 'failed', 'cancelled'].includes(status.status)) unknown = true;
        } catch { unknown = true; }
      }
      for (const row of job.nodes.filter(value => prepared.has(value.nodeId) && value.nodeId !== dispatched)) {
        try { if (row.local) await invoke('abort', { ...base(row), requestId: job.requestId }); else await withConnection(credentials.get(row.nodeId), connection => remote(connection, helperFor(row, job.requestId), 'abort', { ...base(row), requestId: job.requestId })); }
        catch { unknown = true; }
      }
      change(job, { status: unknown ? 'unknown' : job.nodes.some(row => row.proof) ? 'partial' : 'failed', phase: 'failed', outcomeUnknown: unknown, finishedAt: now(), ...(error.nativeMessage ? { nativeMessage: error.nativeMessage } : {}), ...present(unknown ? 'unknown' : 'failed') });
      if (!unknown) { releaseLock?.(); releaseLock = undefined; }
    } finally { for (const value of credentials.values()) clear(value); credentials.clear(); tasks.delete(job.id); }
  }
  async function start(input, user) {
    strict(input, ['revision', 'version', 'requestId', 'confirmedUpdate', 'connections']);
    if (!SHA.test(input.revision || '') || !VERSION.test(input.version || '') || !UUID.test(input.requestId || '') || input.confirmedUpdate !== true || !Array.isArray(input.connections)) throw fail('input', 400);
    const old = store.data.panelUpdateJobs.find(job => job.requestId === input.requestId); if (old) { for (const row of input.connections) clear(row?.ssh); return publicJob(old); }
    if (closed || admission || store.data.panelUpdateJobs.some(job => pending.has(job.status))) throw fail('busy');
    admission = true; const credentials = new Map(); let lock;
    try {
      const local = await localPlan(), release = await latest(true), rows = members();
      if (local.status !== 'ready' || compare(release.version, local.version) < 0 || release.version !== input.version || revisionFor(local, release) !== input.revision || input.connections.length !== rows.length) throw fail('stale');
      for (const value of input.connections) {
        strict(value, ['nodeId', 'ssh']); strict(value.ssh, ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint']);
        const row = rows.find(row => row.nodeId === value.nodeId), check = checks.get(checkKey(user, value.nodeId));
        if (!row || credentials.has(value.nodeId) || !check || Date.now() - check.at > 10 * 60 * 1000 || check.fleetRevision !== input.revision || value.ssh.username !== 'root' || digest({ host: value.ssh.host, port: value.ssh.port ?? 22, hostFingerprint: value.ssh.hostFingerprint }) !== digest(check.target)) throw fail('ssh');
        row.observed = copy(check.observed); row.sshTarget = copy(check.target); credentials.set(row.nodeId, copy(value.ssh));
        if (!row.local && compare(row.observed.version, UPDATE_PROTOCOL_VERSION) < 0) throw fail('protocol');
        if (compare(release.version, row.observed.version) < 0) throw fail('stale');
      }
      if (!rows.some(row => compare(release.version, row.observed.version) > 0)) throw fail('stale');
      lock = (nodes.beginFleetUpdate || nodes.beginFleetRemoval)?.call(nodes, { action: 'update', requestId: input.requestId }) || manager.beginMaintenance({ action: 'update', requestId: input.requestId });
      const job = { id: input.requestId, requestId: input.requestId, type: 'panel-update', scope: 'host', adminOnly: true, serverId: null, panelName: currentName(), revision: input.revision, version: release.version, release: copy(release), status: 'queued', phase: 'queued', progress: 0, verified: false, createdAt: now(), updatedAt: now(), nodes: rows.map(row => ({ ...row, status: 'queued', progress: 0 })), ...present('queued') };
      store.data.panelUpdateJobs.unshift(job);
      try { store.save(); } catch { store.data.panelUpdateJobs = store.data.panelUpdateJobs.filter(row => row !== job); throw fail('persisted', 503); }
      releaseLock = lock; lock = undefined; checks.clear();
      const task = Promise.resolve().then(() => execute(job, credentials)); tasks.set(job.id, task); task.catch(() => {}); emit({ type: 'update' });
      return publicJob(job);
    } catch (error) { for (const value of credentials.values()) clear(value); credentials.clear(); throw error; }
    finally { lock?.(); admission = false; for (const row of input.connections) clear(row?.ssh); }
  }
  async function recover(input, user) {
    strict(input, ['requestId', 'connections', 'cancelPrepared']);
    if (!UUID.test(input.requestId || '') || !Array.isArray(input.connections) || input.cancelPrepared !== true) throw fail('input', 400);
    const job = get(input.requestId); const credentials = new Map();
    if (!pending.has(job.status) || tasks.has(job.id) || input.connections.length !== job.nodes.length || admission || closed) throw fail('busy');
    admission = true;
    try {
      for (const item of input.connections) {
        strict(item, ['nodeId', 'ssh']); strict(item.ssh, ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint']);
        const row = job.nodes.find(value => value.nodeId === item.nodeId);
        if (!row?.sshTarget || credentials.has(row.nodeId) || item.ssh.username !== 'root' || digest({ host: item.ssh.host, port: item.ssh.port ?? 22, hostFingerprint: item.ssh.hostFingerprint }) !== digest(row.sshTarget)) throw fail('ssh');
        credentials.set(row.nodeId, copy(item.ssh));
      }
      let unresolved = false;
      for (const row of job.nodes) {
        const read = (action, input) => withConnection(credentials.get(row.nodeId), connection => stage(connection, helper => remote(connection, helper, action, input)));
        let status;
        try {
          status = await read('status', { ...base(row), requestId: job.requestId });
          if (status.status === 'completed') {
            const proof = await read('verify', { ...base(row), requestId: job.requestId }); if (!validProof(proof, row, job)) throw fail('native');
            change(job, {}, row.nodeId, { status: 'completed', progress: 100, proof });
          } else if (status.status === 'failed' && status.rolledBack === true) {
            const proof = await read('verify-rollback', { ...base(row), requestId: job.requestId }); if (!validRollbackProof(proof, row, job)) throw fail('native');
            change(job, {}, row.nodeId, { status: 'failed', rolledBack: true, rollbackProof: proof });
          } else if (row.alreadyCurrent && status.status === 'absent') {
            const proof = await read('attest', requestFor(row, job)); if (!validProof(proof, row, job)) throw fail('native');
            change(job, {}, row.nodeId, { status: 'completed', progress: 100, proof });
          } else if (['absent', 'prepared', 'cancelled'].includes(status.status) || status.status === 'scheduled' && status.canCancel === true) {
            if (status.status === 'prepared' || status.status === 'scheduled') await read('abort', { ...base(row), requestId: job.requestId });
            const observed = await read('plan', base(row));
            if (observed.revision !== row.observed.revision || observed.installationId !== row.observed.installationId || observed.machineId !== row.observed.machineId || observed.serviceHealthy !== true) throw fail('native');
            change(job, {}, row.nodeId, { status: 'cancelled', unchangedVerified: true });
          } else unresolved = true;
        } catch { unresolved = true; }
      }
      if (unresolved) change(job, { status: 'unknown', outcomeUnknown: true, ...present('unknown') });
      else {
        const completed = job.nodes.every(row => validProof(row.proof, row, job));
        change(job, { status: completed ? 'completed' : job.nodes.some(row => row.proof) ? 'partial' : 'failed', phase: completed ? 'completed' : 'failed', outcomeUnknown: false, verified: completed, progress: completed ? 100 : job.progress, finishedAt: now(), ...present(completed ? 'completed' : 'failed') });
        releaseLock?.(); releaseLock = undefined;
      }
      return publicJob(job);
    } finally { admission = false; for (const value of credentials.values()) clear(value); credentials.clear(); for (const item of input.connections) clear(item?.ssh); }
  }
  return {
    plan, check, start, recover,
    async job(id) { const job = get(id); await reconcileMain(job); return publicJob(job); },
    jobs: () => store.data.panelUpdateJobs.map(publicJob),
    isActive: () => admission || store.data.panelUpdateJobs.some(row => pending.has(row.status)),
    async close() { closed = true; checks.clear(); for (const job of store.data.panelUpdateJobs.filter(row => ['queued', 'running'].includes(row.status))) change(job, { status: 'unknown', outcomeUnknown: true, ...present('unknown') }); },
  };
}
