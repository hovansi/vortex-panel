import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/i;
const MACHINE = /^[a-f0-9]{32}$/i;
const busy = new Set(['queued', 'running', 'unknown', 'partial']);
const secretFields = ['password', 'privateKey', 'passphrase'];
const shell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const messages = {
  input: ['Confirm the current removal plan, exact panel name and permanent data erasure.', 'Xác nhận kế hoạch hiện tại, chính xác tên panel và việc xóa dữ liệu vĩnh viễn.'],
  unavailable: ['Verified uninstall requires a managed Linux installation and root access.', 'Tính năng gỡ có xác minh cần bản cài Linux được quản lý và quyền root.'],
  busy: ['Another system, server or uninstall operation needs to finish first.', 'Cần hoàn tất thao tác hệ thống, máy chủ hoặc lượt gỡ trước đó.'],
  stale: ['The fleet or installation changed. Refresh the plan and verify every SSH connection again.', 'Cụm VPS hoặc bản cài đã thay đổi. Tải lại kế hoạch và xác minh lại mọi kết nối SSH.'],
  ssh: ['Pinned root SSH access must match the exact installation on every listed VPS.', 'SSH root với khóa đã ghim phải khớp chính xác bản cài trên từng VPS đã liệt kê.'],
  native: ['The native removal check failed. The main panel is kept until every worker is independently verified.', 'Kiểm tra gỡ ở cấp hệ điều hành thất bại. Panel chính được giữ tới khi xác minh độc lập mọi VPS phụ.'],
  queued: ['Removal accepted. Checking every VPS before erasing any data.', 'Đã nhận yêu cầu. Đang kiểm tra mọi VPS trước khi xóa dữ liệu.'],
  checking: ['Verifying pinned SSH hosts and frozen installation identities.', 'Đang xác minh host SSH đã ghim và định danh bản cài đã chốt.'],
  removing: ['Removing this worker before the main panel.', 'Đang gỡ VPS phụ này trước panel chính.'],
  verifying: ['Independently verifying this VPS through a new pinned SSH connection.', 'Đang xác minh độc lập VPS qua kết nối SSH mới với khóa đã ghim.'],
  removed: ['Worker removal independently verified. The main panel has not been removed yet.', 'Đã xác minh độc lập việc gỡ VPS phụ. Panel chính chưa được gỡ.'],
  handoff: ['Every linked worker was verified. Main cleanup is scheduled; this panel will disconnect. Keep the SSH verification receipt.', 'Đã xác minh mọi VPS phụ. Đã lên lịch dọn máy chính; panel sẽ mất kết nối. Hãy giữ biên nhận kiểm tra qua SSH.'],
  interrupted: ['The controller stopped during removal. Inspect the existing request through SSH; it will not be sent again automatically.', 'Panel dừng khi đang gỡ. Kiểm tra yêu cầu hiện có qua SSH; thao tác không tự được gửi lại.'],
  failed: ['Removal stopped. The main panel was kept. Inspect the affected VPS and existing receipt before another attempt.', 'Tác vụ gỡ đã dừng và giữ lại panel chính. Kiểm tra VPS liên quan cùng biên nhận hiện có trước khi thử lại.'],
  launchUnknown: ['Main removal dispatch may have succeeded, but its response was lost. Verify the existing request through SSH; it will not be sent again automatically.', 'Có thể đã giao lệnh gỡ máy chính nhưng mất phản hồi. Kiểm tra yêu cầu hiện có qua SSH; thao tác không tự được gửi lại.'],
  persisted: ['Removal state could not be saved. No additional uninstall was dispatched.', 'Không lưu được trạng thái gỡ. Chưa gửi thêm lệnh gỡ nào.'],
};
const present = key => ({ message: messages[key][0], messageI18n: { id: `panel.fleet-removal.${key}`, en: messages[key][0], vi: messages[key][1], params: [] } });
const fail = (key, status = 409, fields = {}) => Object.assign(new Error(messages[key][0]), { code: 'PANEL_REMOVAL_' + key.toUpperCase(), status, ...fields });
export const PANEL_REMOVAL_MESSAGES = Object.freeze(Object.keys(messages).map(key => present(key).messageI18n));
export function panelRemovalErrorPayload(error, language = 'en') {
  const key = error?.code?.startsWith('PANEL_REMOVAL_') ? error.code.slice(14).toLowerCase() : '';
  if (!messages[key]) return null;
  return { error: messages[key][language === 'vi' ? 1 : 0], code: error.code, errorI18n: present(key).messageI18n, ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}) };
}
function strict(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('input', 400);
}
function clear(value) { if (value && typeof value === 'object') for (const key of secretFields) delete value[key]; }
function identity(plan, role, nodeId) {
  if (!plan || plan.schemaVersion !== 1 || plan.role !== role || plan.nodeId !== nodeId || !MACHINE.test(plan.machineId || '') || !SHA.test(plan.panelId || '') || !SHA.test(plan.revision || '') || !['ready', 'blocked'].includes(plan.status) || !Array.isArray(plan.blockers) || !Array.isArray(plan.components) || !Number.isSafeInteger(plan.serverCount) || plan.serverCount < 0) throw fail('native', 502);
  return plan;
}
function validProof(proof, expected) {
  return proof?.schemaVersion === 1 && proof.role === expected.role && proof.nodeId === expected.nodeId && proof.machineId === expected.machineId && proof.panelId === expected.panelId && proof.requestId === expected.requestId && proof.revision === expected.revision && proof.outcomeStatus === 'completed' && proof.verified === true
    && ['inventoryEmpty', 'serviceRemoved', 'filesVerified', 'processesAbsent', 'mountsAbsent', 'firewallRemoved', 'networkCountersRemoved', 'zramRemoved', 'accountsRemoved'].every(key => proof[key] === true)
    && Array.isArray(proof.remainingOwnedPaths) && proof.remainingOwnedPaths.length === 0;
}
function publicPlan(plan) {
  return { serverCount: plan.serverCount, components: plan.components.map(row => Object.fromEntries(['kind', 'path', 'action', 'reason'].filter(key => typeof row[key] === 'string').map(key => [key, row[key]]))), blockers: plan.blockers, retained: plan.retained || [], baselineRestorable: plan.baselineRestorable === true };
}
export function restoreFleetRemovalIntent({ manager, dataDir, role, nodeId, store }) {
  const filename = path.join(dataDir, '.fleet-removal-intent.json');
  let requestId;
  try {
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536 || process.platform === 'linux' && (info.uid !== 0 || info.mode & 0o077)) throw fail('native', 503);
    const intent = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (intent.schemaVersion !== 1 || intent.role !== role || intent.nodeId !== nodeId || !UUID.test(intent.requestId || '') || !MACHINE.test(intent.machineId || '') || !SHA.test(intent.panelId || '') || !SHA.test(intent.revision || '') || intent.confirmedErase !== true) throw fail('native', 503);
    requestId = intent.requestId;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!requestId && role === 'panel') requestId = store?.data?.panelRemovalJobs?.find(row => busy.has(row.status))?.requestId;
  if (requestId) { if (!UUID.test(requestId)) throw fail('native', 503); manager.beginMaintenance({ action: 'uninstall', requestId, restore: true }); }
}
export function runPanelRemovalHelper(helper, action, input, { timeoutMs = 45000, spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('/usr/bin/python3', ['-I', '-B', helper, action], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, settled = false; const decoder = new StringDecoder('utf8');
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(JSON.parse(stdout)); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(fail('native', 504)); }, timeoutMs); timer.unref?.();
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) { child.kill('SIGKILL'); finish(fail('native', 502)); } else stdout += decoder.write(chunk); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 ** 2) { child.kill('SIGKILL'); finish(fail('native', 502)); } });
    child.once('error', () => finish(fail('unavailable', 503)));
    child.once('close', code => { if (settled) return; stdout += decoder.end(); try { if (code !== 0 || JSON.parse(stdout)?.ok === false) throw fail('native', 409); finish(); } catch { finish(fail('native', 409)); } });
    child.stdin.end(JSON.stringify(input));
  });
}

export function createPanelRemovalController({ store, nodes, manager, dataDir, projectDir, ssh, discover, emit = () => {}, native,
  platform = process.platform, uid = process.getuid?.(), pollIntervalMs = 1500, operationTimeoutMs = 20 * 60 * 1000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!store || !nodes || !manager || !dataDir || !projectDir) throw new Error('Fleet removal requires a durable store, fixed source/data roots and node registry.');
  const invoke = native || ((action, input) => runPanelRemovalHelper(path.join(projectDir, 'server/fleet-removal.py'), action, input));
  const checks = new Map(), tasks = new Map(); let closed = false, admission = false;
  store.data.panelRemovalJobs ||= [];
  if (!Array.isArray(store.data.panelRemovalJobs)) throw fail('native', 503);
  let recovered = false;
  for (const job of store.data.panelRemovalJobs) if (['queued', 'running'].includes(job.status)) { Object.assign(job, { status: 'unknown', outcomeUnknown: true, ...present('interrupted') }); recovered = true; }
  if (recovered) store.save();
  const currentName = () => store.data.settings.localNodeName || 'Vortex Panel';
  const get = id => store.data.panelRemovalJobs.find(row => row.id === id) || (() => { throw fail('input', 404); })();
  const publicJob = job => clone(Object.fromEntries(['id', 'requestId', 'type', 'scope', 'adminOnly', 'serverId', 'panelName', 'revision', 'status', 'phase', 'progress', 'verified', 'createdAt', 'updatedAt', 'finishedAt', 'nodes', 'handoff', 'message', 'messageI18n', 'outcomeUnknown'].filter(key => job[key] !== undefined).map(key => [key, job[key]])));
  const members = () => [...store.data.nodes.map(row => ({ nodeId: row.id, name: row.name, local: false, agentId: row.agentId, address: row.publicAddress || new URL(row.endpoint).hostname, host: new URL(row.endpoint).hostname, serverCount: row.inventory.length })), { nodeId: 'local', name: currentName(), local: true, address: process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '', serverCount: store.data.servers.length }];
  const membership = () => store.data.nodes.map(row => [row.id, row.agentId, row.name, row.endpoint, row.tokenEncrypted, row.fingerprint]);
  const revisionFor = local => digest([local.revision, currentName(), membership()]);
  function change(job, fields, nodeId, nodeFields) {
    const before = clone(job), oldRows = store.data.panelRemovalJobs;
    if (nodeId) Object.assign(job.nodes.find(row => row.nodeId === nodeId), nodeFields);
    Object.assign(job, fields, { updatedAt: now() });
    let terminal = 0;
    store.data.panelRemovalJobs = oldRows.filter(row => busy.has(row.status) || terminal++ < 20);
    try { store.save(); } catch { for (const key of Object.keys(job)) delete job[key]; Object.assign(job, before); store.data.panelRemovalJobs = oldRows; throw fail('persisted', 503); }
    emit({ type: 'update' });
  }
  function previousProof(nodeId) {
    for (const job of store.data.panelRemovalJobs) {
      const row = job.nodes?.find(item => item.nodeId === nodeId && item.proof?.verified === true);
      if (row?.proof) return row.proof;
    }
    return null;
  }
  function base(row) { return { schemaVersion: 1, role: row.local ? 'panel' : 'worker', nodeId: row.local ? 'local' : row.agentId }; }
  async function localPlan() {
    if (platform !== 'linux' || uid !== 0) throw fail('unavailable', 409);
    return identity(await invoke('plan', { schemaVersion: 1, role: 'panel', nodeId: 'local' }), 'panel', 'local');
  }
  async function plan() {
    const rows = members(); let local, blockers = [];
    try { local = await localPlan(); blockers = local.blockers.filter(row => row.code !== 'FLEET_WORKERS'); }
    catch { blockers = [{ code: 'FLEET_UNAVAILABLE', message: messages.unavailable[0], messageI18n: present('unavailable').messageI18n }]; }
    for (const row of rows) {
      if (row.local && local) Object.assign(row, publicPlan(local), { blockers });
      else if (row.local) Object.assign(row, { components: [], blockers, sshRequired: true });
      else Object.assign(row, { components: [{ kind: 'managed-data', path: '/var/lib/vortex-node', action: 'erase', reason: 'Includes every managed server, world, backup and runtime cache.' }, { kind: 'service', path: 'vortex-node.service', action: 'remove' }], blockers: [], sshRequired: true });
    }
    const pending = store.data.panelRemovalJobs.find(row => busy.has(row.status));
    if (pending) blockers = [...blockers, { code: 'FLEET_PENDING', message: messages.busy[0], messageI18n: present('busy').messageI18n }];
    return { plan: { schemaVersion: 1, panelName: currentName(), mainNodeId: 'local', revision: local ? revisionFor(local) : digest([currentName(), membership()]), status: blockers.length ? 'blocked' : 'ready', nodes: rows, blockers, latestJobId: pending?.id, baselineRestorable: local?.baselineRestorable === true } };
  }
  async function references() {
    const files = ['server/firewall_native.py', 'server/fleet-removal.py', 'server/host-zram.py', 'server/network-metrics.js', 'server/safety.js', 'deploy/application-isolation.py'];
    const result = [];
    for (const name of files) {
      const filename = path.join(projectDir, name), info = await fsp.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2 * 1024 ** 2) throw fail('native', 503);
      const content = await fsp.readFile(filename);
      result.push({ name: path.basename(name), content, sha256: createHash('sha256').update(content).digest('hex') });
    }
    return result;
  }
  async function stage(connection, callback) {
    const parent = await connection.lstat('/run');
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o022) throw fail('ssh', 409);
    const root = '/run/vortex-fleet-check-' + randomUUID(), files = await references();
    await connection.mkdir(root, 0o700);
    try {
      for (const file of files) await connection.write(root + '/' + file.name, file.content, 0o600);
      const manifest = files.map(file => [root + '/' + file.name, file.sha256]);
      const inspection = `import hashlib,json,os,stat;items=json.loads(${JSON.stringify(JSON.stringify(manifest))});assert all((lambda s:stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077)(os.lstat(p)) and hashlib.sha256(open(p,'rb').read()).hexdigest()==h for p,h in items)`;
      await connection.exec('/usr/bin/python3 -I -c ' + shell(inspection), { timeoutMs: 30000 });
      return await callback(root + '/fleet-removal.py');
    } finally {
      const cleanup = `import hashlib,os,stat;root=${JSON.stringify(root)};expected=${JSON.stringify(files.map(file => [file.name, file.sha256]))};assert os.path.realpath(root)==root and os.stat(root).st_uid==0 and not os.stat(root).st_mode&0o077;assert set(os.listdir(root))<=set(n for n,h in expected);[(os.unlink(root+'/'+n)) for n,h in expected if os.path.exists(root+'/'+n) and (lambda s:stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1)(os.lstat(root+'/'+n)) and hashlib.sha256(open(root+'/'+n,'rb').read()).hexdigest()==h];os.rmdir(root)`;
      // Removal is restricted to these freshly transferred, hash-verified files.
      // A changed stage is retained instead of recursively deleting unknown data.
      await connection.exec('/usr/bin/python3 -I -c ' + shell(cleanup), { timeoutMs: 30000, allowFailure: true }).catch(() => {});
    }
  }
  async function remote(connection, helper, action, request) {
    const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
    const command = `/usr/bin/python3 -I -B ${shell(helper)} ${action} <<'VORTEX_REMOVAL_REQUEST'\n${JSON.stringify(request)}\nVORTEX_REMOVAL_REQUEST`;
    // A quoted heredoc carries only validated identity metadata; no credentials.
    if (encoded.length > 8 * 1024 ** 2) throw fail('input', 400);
    const result = await connection.exec(command, { timeoutMs: action === 'prepare' ? 120000 : 45000, maxBytes: 32 * 1024 ** 2, allowFailure: true });
    let value; try { value = JSON.parse(result.stdout); } catch { throw fail('native', 502); }
    if (result.code !== 0 || value?.ok === false) throw fail('native', 409, { nativeMessage: typeof value?.error === 'string' ? value.error.slice(0, 2048) : undefined });
    return value;
  }
  async function withConnection(credentials, callback) {
    if (closed) throw fail('busy', 503);
    if (typeof ssh !== 'function') throw fail('unavailable', 503);
    return ssh(clone(credentials), callback);
  }
  function bindPlan(row, value, primary) {
    identity(value, row.local ? 'panel' : 'worker', row.local ? 'local' : row.agentId);
    if (row.local) { if (value.machineId !== primary.machineId || value.panelId !== primary.panelId || value.revision !== primary.revision) throw fail('ssh', 409); }
    else {
      const selected = nodes.get(row.nodeId), credentials = nodes.credentials(selected);
      const expected = createHash('sha256').update(credentials.token).digest('hex');
      if (value.machineId === primary.machineId || value.tokenHash !== expected || credentials.fingerprint && String(value.certFingerprint).replaceAll(':', '').toLowerCase() !== credentials.fingerprint.toLowerCase()) throw fail('ssh', 409);
    }
    if (value.blockers.some(item => item.code !== 'FLEET_WORKERS')) throw fail('native', 409);
    return value;
  }
  const checkKey = (user, id) => `${user.id || user.username}:${id}`;
  async function check(input, user) {
    strict(input, ['nodeId', 'ssh']);
    const row = members().find(item => item.nodeId === input.nodeId);
    if (!row) throw fail('input', 400);
    strict(input.ssh, ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint']);
    if (!input.ssh.hostFingerprint) {
      if (typeof discover !== 'function' || Object.keys(input.ssh).some(key => !['host', 'port'].includes(key))) throw fail('input', 400);
      return { nodeId: row.nodeId, ...await discover(input.ssh) };
    }
    if (input.ssh.username !== 'root') throw fail('ssh', 400);
    try {
      const primary = await localPlan();
      const observed = await withConnection(input.ssh, connection => stage(connection, async helper => {
        const old = previousProof(row.nodeId);
        if (old && !row.local) {
          const proof = await remote(connection, `/run/vortex-fleet-removal/${old.requestId}/helper.py`, 'verify', old);
          if (!validProof(proof, old)) throw fail('native', 409);
          return { ...old, previousProof: proof, status: 'ready', blockers: [], serverCount: 0, components: [] };
        }
        return bindPlan(row, await remote(connection, helper, 'plan', base(row)), primary);
      }));
      checks.set(checkKey(user, row.nodeId), { at: Date.now(), target: { host: input.ssh.host, port: input.ssh.port ?? 22, hostFingerprint: input.ssh.hostFingerprint }, plan: observed, fleetRevision: revisionFor(primary) });
      return { nodeId: row.nodeId, hostFingerprint: input.ssh.hostFingerprint, authenticated: true, host: { root: true }, ...publicPlan(observed) };
    } finally { clear(input.ssh); }
  }
  function requestFor(row, observed, requestId, proofs = []) {
    return { ...base(row), requestId, machineId: observed.machineId, panelId: observed.panelId, revision: observed.revision, confirmedErase: true, workerProofs: row.local ? proofs : [] };
  }
  const workspace = id => `/run/vortex-fleet-removal/${id}/helper.py`;
  const verificationCommand = id => `sudo /usr/bin/python3 -I ${workspace(id)} verify --request-id ${id}`;
  function proofForJob(proof) {
    return clone(Object.fromEntries(['schemaVersion', 'role', 'nodeId', 'machineId', 'panelId', 'requestId', 'revision', 'verified', 'inventoryEmpty', 'serviceRemoved', 'filesVerified', 'processesAbsent', 'mountsAbsent', 'firewallRemoved', 'networkCountersRemoved', 'zramRemoved', 'accountsRemoved', 'remainingOwnedPaths', 'baselineRestored', 'outcomeStatus', 'receiptPath'].map(key => [key, proof[key]])));
  }
  async function run(job, credentials, primary) {
    let dispatched = false, dispatchAttempted = false, effects = false;
    const proofs = [], observations = new Map(), rows = members();
    try {
      change(job, { status: 'running', phase: 'checking', progress: 3, ...present('checking') });
      const machines = new Set();
      // Recheck every pinned host before dispatching the first erase operation.
      for (const row of rows) {
        const checked = checks.get(checkKey({ id: job.actorId }, row.nodeId));
        const observed = await withConnection(credentials.get(row.nodeId), connection => stage(connection, async helper => {
          if (checked.plan.previousProof) {
            const proof = await remote(connection, workspace(checked.plan.requestId), 'verify', checked.plan);
            if (!validProof(proof, checked.plan)) throw fail('native', 409);
            return { ...checked.plan, previousProof: proof };
          }
          const current = bindPlan(row, await remote(connection, helper, 'plan', base(row)), primary);
          if (current.revision !== checked.plan.revision) throw fail('stale', 409);
          return current;
        }));
        if (closed || machines.has(observed.machineId)) throw fail('ssh', 409);
        machines.add(observed.machineId); observations.set(row.nodeId, observed);
      }
      if (revisionFor(await localPlan()) !== job.revision) throw fail('stale', 409);
      const workers = rows.filter(row => !row.local);
      for (const [index, row] of workers.entries()) {
        if (closed) throw fail('busy', 503);
        const observed = observations.get(row.nodeId), request = requestFor(row, observed, job.requestId);
        let proof;
        if (observed.previousProof) proof = observed.previousProof;
        else {
          change(job, { phase: 'removing', progress: 8 + Math.floor(72 * index / Math.max(1, workers.length)), ...present('removing') }, row.nodeId, { status: 'running', phase: 'preparing', progress: 5, ...present('removing') });
          await withConnection(credentials.get(row.nodeId), connection => stage(connection, async helper => {
            const prepared = await remote(connection, helper, 'prepare', request);
            if (prepared.requestId !== job.requestId || prepared.status !== 'prepared' || prepared.ok !== true) throw fail('native', 502);
            effects = true;
            if (closed) throw fail('busy', 503);
            await remote(connection, workspace(job.requestId), 'launch', request);
            const deadline = Date.now() + operationTimeoutMs;
            while (!closed && Date.now() < deadline) {
              const status = await remote(connection, workspace(job.requestId), 'status', request);
              if (status.status === 'completed') return;
              if (['partial', 'failed'].includes(status.status)) throw fail('native', 409, { nativeMessage: typeof status.error === 'string' ? status.error.slice(0, 2048) : undefined });
              change(job, {}, row.nodeId, { phase: status.phase || 'removing', progress: status.phase === 'packages' ? 75 : 35 });
              await sleep(pollIntervalMs);
            }
            throw fail('native', 504, { outcomeUnknown: true });
          }));
          change(job, { phase: 'verifying', ...present('verifying') }, row.nodeId, { status: 'verifying', phase: 'verifying', progress: 90, ...present('verifying') });
          proof = await withConnection(credentials.get(row.nodeId), connection => remote(connection, workspace(job.requestId), 'verify', request));
          if (!validProof(proof, request)) throw fail('native', 409);
        }
        const safeProof = proofForJob({ ...proof, revision: observed.revision }); proofs.push({ ...safeProof, linkId: row.nodeId });
        change(job, { progress: 8 + Math.floor(72 * (index + 1) / Math.max(1, workers.length)), ...present('removed') }, row.nodeId, { status: 'completed', phase: 'complete', progress: 100, verified: true, proof: safeProof, receiptPath: proof.receiptPath, verificationCommand: verificationCommand(proof.requestId), ...present('removed') });
        clear(credentials.get(row.nodeId));
      }
      if (closed || revisionFor(await localPlan()) !== job.revision) throw fail('stale', 409);
      const main = rows.find(row => row.local), observed = observations.get('local'), request = requestFor(main, observed, job.requestId, proofs);
      change(job, { phase: 'handoff', progress: 90, ...present('handoff') }, 'local', { status: 'running', phase: 'preparing', progress: 5 });
      await withConnection(credentials.get('local'), connection => stage(connection, async helper => {
        const prepared = await remote(connection, helper, 'prepare', request);
        if (prepared.status !== 'prepared' || prepared.ok !== true || prepared.requestId !== job.requestId) throw fail('native', 502);
        effects = true;
        change(job, { handoff: { ...job.handoff, status: 'prepared', ...present('handoff') } });
        if (closed) throw fail('busy', 503);
        change(job, { handoff: { ...job.handoff, status: 'dispatching', attemptedAt: now(), ...present('handoff') } });
        dispatchAttempted = true;
        await remote(connection, workspace(job.requestId), 'launch', request); dispatched = true;
      }));
      change(job, { phase: 'main-dispatched', progress: 95, handoff: { ...job.handoff, status: 'dispatched', dispatchedAt: now(), ...present('handoff') }, ...present('handoff') }, 'local', { status: 'dispatched', phase: 'removing', progress: 10 });
    } catch (error) {
      const status = dispatchAttempted ? 'unknown' : effects ? 'partial' : 'failed';
      const failureMessage = present(dispatchAttempted ? 'launchUnknown' : 'failed');
      const target = job.nodes.find(row => ['running', 'verifying', 'dispatched'].includes(row.status));
      try { change(job, { status, phase: 'review', progress: Math.min(job.progress, 95), outcomeUnknown: effects, finishedAt: now(), ...(dispatchAttempted ? { handoff: { ...job.handoff, status: 'unknown', ...failureMessage } } : {}), ...failureMessage }, target?.nodeId, target ? { status, phase: 'review', detail: error.nativeMessage || messages.native[0], ...failureMessage } : undefined); } catch {}
      if (!effects) job.release?.();
    } finally {
      for (const input of credentials.values()) clear(input);
      checks.clear();
    }
  }
  async function start(input, user) {
    strict(input, ['requestId', 'revision', 'confirmationName', 'eraseData', 'acknowledged', 'ssh']);
    if (!UUID.test(input.requestId || '') || !SHA.test(input.revision || '') || input.confirmationName !== currentName() || input.eraseData !== true || input.acknowledged !== true || !Array.isArray(input.ssh)) throw fail('input', 400);
    const duplicate = store.data.panelRemovalJobs.find(job => job.requestId === input.requestId);
    if (duplicate) { for (const item of input.ssh) clear(item); if (duplicate.actorId !== (user.id || user.username) || duplicate.revision !== input.revision) throw fail('stale', 409); return publicJob(duplicate); }
    if (closed || admission || store.data.panelRemovalJobs.some(job => busy.has(job.status))) throw fail('busy', 409);
    admission = true; let release;
    const credentials = new Map();
    try {
      const primary = await localPlan(), rows = members();
      if (revisionFor(primary) !== input.revision || primary.blockers.some(row => row.code !== 'FLEET_WORKERS') || input.ssh.length !== rows.length) throw fail('stale', 409);
      for (const item of input.ssh) {
        strict(item, ['nodeId', 'host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint']);
        if (credentials.has(item.nodeId) || !rows.some(row => row.nodeId === item.nodeId) || item.username !== 'root') throw fail('input', 400);
        const check = checks.get(checkKey(user, item.nodeId));
        if (!check || Date.now() - check.at > 10 * 60 * 1000 || check.fleetRevision !== input.revision || check.target.host !== item.host || check.target.port !== (item.port ?? 22) || check.target.hostFingerprint !== item.hostFingerprint) throw fail('ssh', 409);
        const { nodeId, ...value } = item; credentials.set(nodeId, clone(value));
      }
      release = nodes.beginFleetRemoval ? nodes.beginFleetRemoval({ action: 'uninstall', requestId: input.requestId }) : manager.beginMaintenance({ action: 'uninstall', requestId: input.requestId });
      const job = { id: input.requestId, requestId: input.requestId, type: 'panel-uninstall', scope: 'host', adminOnly: true, serverId: null, actorId: user.id || user.username, revision: input.revision, panelName: currentName(), status: 'queued', phase: 'queued', progress: 0, verified: false, createdAt: now(), updatedAt: now(), ...present('queued'),
        nodes: rows.map(row => ({ nodeId: row.nodeId, name: row.name, local: row.local, status: 'pending', phase: 'queued', progress: 0, verified: false, receiptPath: `/run/vortex-fleet-removal/${input.requestId}/result.json`, verificationCommand: verificationCommand(input.requestId) })),
        handoff: { expectedDisconnect: true, status: 'pending', receiptPath: `/run/vortex-fleet-removal/${input.requestId}/result.json`, verificationCommand: verificationCommand(input.requestId) } };
      Object.defineProperty(job, 'release', { value: release, enumerable: false, configurable: true });
      const previous = store.data.panelRemovalJobs; store.data.panelRemovalJobs = [job, ...previous];
      try { store.audit('panel.uninstall.accepted', JSON.stringify({ requestId: job.id, nodes: rows.map(row => ({ id: row.nodeId, name: row.name })), permanentDataErasure: true }), user.username); }
      catch { store.data.panelRemovalJobs = previous; throw fail('persisted', 503); }
      const task = Promise.resolve().then(() => run(job, credentials, primary)).finally(() => tasks.delete(job.id)); tasks.set(job.id, task);
      emit({ type: 'update' }); return publicJob(job);
    } catch (error) { release?.(); for (const input of credentials.values()) clear(input); throw error; }
    finally { admission = false; for (const item of input.ssh) clear(item); }
  }
  return { plan, check, start, jobs: () => store.data.panelRemovalJobs.map(publicJob), getJob: id => publicJob(get(id)), isActive: () => admission || store.data.panelRemovalJobs.some(job => busy.has(job.status)),
    async close() { if (closed) return; closed = true; checks.clear(); for (const job of store.data.panelRemovalJobs) if (tasks.has(job.id) && job.phase !== 'main-dispatched') { try { change(job, { status: 'unknown', outcomeUnknown: true, ...present('interrupted') }); } catch {} } await Promise.race([Promise.allSettled([...tasks.values()]), new Promise(resolve => { const timer = setTimeout(resolve, 4000); timer.unref?.(); })]); } };
}
