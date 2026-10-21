import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import ssh2 from 'ssh2';
import { buildNodeBundle } from './node-bundle.js';
import { normalizeArchitecture } from '../public/runtime-platform.js';
const { Client, utils } = ssh2;

const activeStatus = new Set(['queued', 'running']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const issue = (code, status = 502) => Object.assign(new Error(code), { code, status });
const messages = {
  queued: ['Queued for secure SSH provisioning.', 'Đã xếp hàng cài node qua SSH.'],
  connecting: ['Connecting to the verified SSH host.', 'Đang kết nối SSH tới host đã xác nhận.'],
  preflight: ['Checking Ubuntu, root access, resources and existing agent.', 'Đang kiểm tra Ubuntu, quyền root, tài nguyên và agent hiện có.'],
  bundle: ['Building the public agent source bundle.', 'Đang chuẩn bị gói source agent công khai.'],
  upload: ['Uploading the agent bundle over SFTP.', 'Đang tải gói agent qua SFTP.'],
  bootstrap: ['Installing the remote unpacking dependency.', 'Đang chuẩn bị công cụ giải nén trên VPS.'],
  unpack: ['Verifying and unpacking the uploaded source.', 'Đang xác minh và giải nén source đã tải.'],
  install: ['The detached Ubuntu installer is running.', 'Installer Ubuntu đang chạy độc lập trên VPS.'],
  linking: ['Verifying HTTPS identity and linking the node.', 'Đang kiểm tra HTTPS và liên kết node.'],
  completed: ['Agent is healthy and linked to the panel.', 'Agent hoạt động và đã được liên kết với panel.'],
  interrupted: ['Controller stopped or restarted. Remote installation may continue; check this VPS before retrying.', 'Panel đã dừng hoặc khởi động lại. Cài đặt trên VPS có thể vẫn tiếp tục; hãy kiểm tra VPS trước khi thử lại.'],
  PROVISION_INPUT: ['Invalid SSH provisioning settings.', 'Thông tin cài node qua SSH không hợp lệ.'],
  PROVISION_FINGERPRINT: ['Confirm the SSH host fingerprint from the check step before installing.', 'Hãy xác nhận fingerprint SSH từ bước kiểm tra trước khi cài.'],
  PROVISION_HOST_CHANGED: ['SSH host key changed. No authentication was sent to the changed host.', 'Khóa host SSH đã thay đổi. Chưa gửi thông tin đăng nhập tới host bị đổi khóa.'],
  PROVISION_SSH: ['SSH connection or authentication failed. Check address, port and credentials.', 'Kết nối hoặc đăng nhập SSH thất bại. Kiểm tra địa chỉ, cổng và thông tin đăng nhập.'],
  PROVISION_TIMEOUT: ['Provisioning timed out. Remote installation may still be running; do not repeat it automatically.', 'Cài đặt quá thời gian chờ. Installer trên VPS có thể vẫn chạy; không tự động chạy lại.'],
  PROVISION_PREFLIGHT: ['This host requires Ubuntu 22.04+, x64 or ARM64, root and systemd, with at least 2 GiB free disk and 1 GiB RAM.', 'VPS cần Ubuntu 22.04+, x64 hoặc ARM64, root và systemd, tối thiểu 2 GiB đĩa trống và 1 GiB RAM.'],
  PROVISION_EXISTING_UNHEALTHY: ['An existing agent configuration or service is unhealthy. It was not overwritten.', 'Cấu hình hoặc dịch vụ agent hiện có không hoạt động. Chưa ghi đè cài đặt đó.'],
  PROVISION_PORT: ['The selected agent TCP port is already occupied.', 'Cổng TCP đã chọn cho agent đang được sử dụng.'],
  PROVISION_LOCKED: ['Another installation is already running on this VPS.', 'VPS này đang có một lượt cài đặt khác.'],
  PROVISION_TRANSFER: ['The private source transfer or SHA-256 verification failed.', 'Tải source riêng hoặc xác minh SHA-256 thất bại.'],
  PROVISION_INSTALL: ['The remote installer failed. Its private log was retained on the VPS.', 'Installer trên VPS thất bại. Log riêng đã được giữ lại trên VPS.'],
  PROVISION_LINK: ['Agent installation completed, but the panel could not verify its HTTPS connection. Check the selected port and VPS/cloud firewall, then check/reconnect this VPS.', 'Đã cài agent nhưng panel chưa xác minh được kết nối HTTPS. Kiểm tra cổng và firewall VPS/cloud rồi kiểm tra hoặc kết nối lại VPS.'],
  PROVISION_LIMIT: ['At most two provisioning jobs may run at once.', 'Chỉ chạy tối đa hai tác vụ cài node cùng lúc.'],
  PROVISION_CLOSED: ['The provisioning service is stopping.', 'Dịch vụ cài node đang dừng.'],
  PROVISION_PERSIST: ['Could not persist provisioning state. Inspect node status before retrying.', 'Không lưu được trạng thái cài node. Hãy kiểm tra trạng thái node trước khi thử lại.'],
};
function presentation(key) { const [en, vi] = messages[key] || messages.PROVISION_INSTALL; return { message: en, messageI18n: { id: `panel.node-provision.${key.toLowerCase()}`, en, vi, params: [] } }; }
export function nodeProvisionErrorPayload(error, language = 'en') {
  const key = typeof error === 'string' ? Object.keys(messages).find(key => key === error || messages[key][0] === error) : error?.code;
  if (!key || !Object.hasOwn(messages, key) || !key.startsWith('PROVISION_')) return null;
  const content = presentation(key); return { error: content.messageI18n[language === 'vi' ? 'vi' : 'en'], errorI18n: content.messageI18n };
}
function fail(code, status) { const error = issue(code, status); const content = presentation(code); error.message = content.message; error.errorI18n = content.messageI18n; throw error; }
const shell = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function fingerprint(value, required = false) {
  if (value === undefined || value === null || value === '') { if (required) fail('PROVISION_FINGERPRINT', 400); return null; }
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value) || Buffer.from(value.slice(7), 'base64').length !== 32) fail('PROVISION_FINGERPRINT', 400);
  return 'SHA256:' + Buffer.from(value.slice(7), 'base64').toString('base64').replace(/=+$/, '');
}
function validate(input, install = false) {
  const fields = ['host', 'port', 'username', 'password', 'privateKey', 'passphrase', 'hostFingerprint', ...(install ? ['name', 'location', 'publicAddress', 'agentPort'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) fail('PROVISION_INPUT', 400);
  let host = input.host;
  if (typeof host !== 'string' || host.length > 253 || host !== host.trim()) fail('PROVISION_INPUT', 400);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!net.isIP(host) && (!/^[A-Za-z0-9.-]+$/.test(host) || !host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) fail('PROVISION_INPUT', 400);
  const port = input.port ?? 22, username = input.username ?? 'root';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(username)) fail('PROVISION_INPUT', 400);
  const hasPassword = typeof input.password === 'string' && input.password.length > 0, hasKey = typeof input.privateKey === 'string' && input.privateKey.length > 0;
  if (hasPassword === hasKey || hasPassword && (input.password.length > 4096 || input.password.includes('\0')) || hasKey && Buffer.byteLength(input.privateKey) > 65536 || input.passphrase !== undefined && (typeof input.passphrase !== 'string' || input.passphrase.length > 4096 || !hasKey)) fail('PROVISION_INPUT', 400);
  if (hasKey) { const parsed = utils.parseKey(input.privateKey, input.passphrase); if (parsed instanceof Error || Array.isArray(parsed) && parsed.length !== 1) fail('PROVISION_INPUT', 400); }
  const result = { host, port, username, ...(hasPassword ? { password: input.password } : { privateKey: input.privateKey, ...(input.passphrase ? { passphrase: input.passphrase } : {}) }), hostFingerprint: fingerprint(input.hostFingerprint, install) };
  if (install) {
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name && !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) || input.location !== undefined && (typeof input.location !== 'string' || input.location.length > 120 || /[\x00-\x1f\x7f]/.test(input.location))) fail('PROVISION_INPUT', 400);
    const agentPort = input.agentPort ?? 8443;
    let publicAddress = input.publicAddress || host;
    if (typeof publicAddress === 'string' && publicAddress.startsWith('[') && publicAddress.endsWith(']')) publicAddress = publicAddress.slice(1, -1);
    if (!Number.isInteger(agentPort) || agentPort < 1024 || agentPort > 65535 || typeof publicAddress !== 'string' || publicAddress.length > 253 || !net.isIP(publicAddress) && (!/^[A-Za-z0-9.-]+$/.test(publicAddress) || !publicAddress.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) fail('PROVISION_INPUT', 400);
    Object.assign(result, { name: input.name?.trim() || '', location: input.location?.trim() || '', publicAddress, agentPort });
  }
  return result;
}
const PREFLIGHT = `set -eu
printf 'VORTEX_PREFLIGHT_V1\\n'
printf 'uid=%s\\n' "$(id -u)"
printf 'os=%s\\n' "$(sed -n 's/^ID=//p' /etc/os-release | tr -d '\"')"
printf 'version=%s\\n' "$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '\"')"
printf 'arch=%s\\n' "$(uname -m)"
printf 'userspace=%s\\n' "$(dpkg --print-architecture 2>/dev/null || true)"
printf 'disk=%s\\n' "$(df -Pk /var/lib | awk 'NR==2 {printf "%.0f",$4*1024}')"
printf 'memory=%s\\n' "$(awk '/^MemTotal:/ {printf "%.0f",$2*1024}' /proc/meminfo)"
if command -v systemctl >/dev/null 2>&1; then printf 'systemd=1\\n'; else printf 'systemd=0\\n'; fi
if [ -e /etc/vortex-node.json ] || [ -L /etc/vortex-node.json ] || [ -e /etc/systemd/system/vortex-node.service ]; then printf 'existing=1\\n'; else printf 'existing=0\\n'; fi
`;

export function createNodeProvisioner({ nodes, store, projectDir, dataDir, emit = () => {}, sshClientFactory = () => new Client(), connectTimeoutMs = 20000, commandTimeoutMs = 15000, transferTimeoutMs = 10 * 60 * 1000, installTimeoutMs = 60 * 60 * 1000, pollIntervalMs = 2000 } = {}) {
  for (const value of [connectTimeoutMs, commandTimeoutMs, transferTimeoutMs, installTimeoutMs, pollIntervalMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60 * 1000) throw new Error('Invalid provisioning deadline.');
  const tasks = new Map(), connections = new Set(), pendingHosts = new Set(), sessions = new Map(); let closed = false, checks = 0;
  store.data.nodeProvisionJobs ||= [];
  if (!Array.isArray(store.data.nodeProvisionJobs)) throw new Error('Invalid node provisioning history.');
  const previous = store.data.nodeProvisionJobs;
  const retain = rows => { let finished = 0; return rows.filter(job => activeStatus.has(job.status) || job.completionStatusPersisted === false || finished++ < 20); };
  const interrupted = retain(previous.map(job => activeStatus.has(job.status) ? { ...job, status: 'failed', phase: 'interrupted', ...presentation('interrupted'), finishedAt: new Date().toISOString(), outcomeUnknown: true } : job));
  if (interrupted.length !== previous.length || interrupted.some((job, i) => job !== previous[i])) { store.data.nodeProvisionJobs = interrupted; try { store.save(); } catch (error) { store.data.nodeProvisionJobs = previous; throw error; } }
  function trim() { return retain(store.data.nodeProvisionJobs); }
  const publicJob = job => Object.fromEntries(['id', 'type', 'adminOnly', 'scope', 'serverId', 'status', 'progress', 'phase', 'message', 'messageI18n', 'createdAt', 'finishedAt', 'nodeId', 'transfer', 'outcomeUnknown', 'recoveryPath', 'completionStatusPersisted', 'warnings'].filter(key => job[key] !== undefined).map(key => [key, structuredClone(job[key])]));
  const changed = () => emit({ type: 'update' });
  function transition(job, fields) {
    const old = { ...job }, oldRows = store.data.nodeProvisionJobs;
    Object.assign(job, fields); store.data.nodeProvisionJobs = trim();
    try { store.save(); } catch { for (const key of Object.keys(job)) if (!Object.hasOwn(old, key)) delete job[key]; Object.assign(job, old); store.data.nodeProvisionJobs = oldRows; fail('PROVISION_PERSIST', 500); }
    changed();
  }
  function step(job, phase, progress, fields = {}) { transition(job, { status: 'running', phase, progress: Math.max(job.progress, progress), ...presentation(phase), ...fields }); }
  async function discoverHost(input) {
    const client = sshClientFactory(); connections.add(client);
    return new Promise((resolve, reject) => {
      let observed, done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); client.destroy(); connections.delete(client); observed ? resolve({ hostFingerprint: observed, requiresHostConfirmation: true, authenticated: false, host: null, existingAgent: null }) : reject(issue('PROVISION_SSH')); };
      const timer = setTimeout(finish, connectTimeoutMs); timer.unref();
      client.on('error', finish); client.once('close', finish);
      try { client.connect({ host: input.host, port: input.port, username: 'vortex-host-key-discovery', readyTimeout: connectTimeoutMs, hostVerifier(key) { observed = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); queueMicrotask(finish); return false; } }); } catch { finish(); }
    });
  }
  async function connect(input, signal) {
    if (closed || signal?.aborted) fail('PROVISION_CLOSED', 503);
    const client = sshClientFactory(); connections.add(client); let observed = null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => finish(issue('PROVISION_CLOSED', 503));
      const finish = error => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); if (error) { client.destroy(); connections.delete(client); reject(error); } else resolve({ client, hostFingerprint: observed }); };
      client.once('ready', () => finish());
      client.on('error', () => { if (!settled) finish(issue(observed && input.hostFingerprint && observed !== input.hostFingerprint ? 'PROVISION_HOST_CHANGED' : 'PROVISION_SSH')); });
      client.once('close', () => { connections.delete(client); sessions.delete(client); if (!settled) finish(issue('PROVISION_SSH')); });
      signal?.addEventListener('abort', abort, { once: true });
      try { client.connect({ host: input.host, port: input.port, username: input.username, ...(input.password !== undefined ? { password: input.password } : { privateKey: input.privateKey, passphrase: input.passphrase }), readyTimeout: connectTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3, hostVerifier(key) { observed = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); if (!input.hostFingerprint) return true; const a = Buffer.from(observed), b = Buffer.from(input.hostFingerprint); return a.length === b.length && timingSafeEqual(a, b); } }); }
      catch { finish(issue('PROVISION_SSH')); }
    });
  }
  function exec(client, command, { signal, timeoutMs = commandTimeoutMs, maxBytes = 65536, allowFailure = false } = {}) {
    return new Promise((resolve, reject) => {
      let channel, done = false, size = 0, stdout = '', stderr = '';
      const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) channel?.destroy(); error ? reject(error) : resolve(value); };
      const abort = () => finish(issue('PROVISION_CLOSED', 503));
      const timer = setTimeout(() => finish(issue('PROVISION_TIMEOUT', 504)), timeoutMs); timer.unref(); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      client.exec(command, (error, stream) => {
        if (error) return finish(issue('PROVISION_SSH')); channel = stream;
        if (done) { stream.destroy(); return; }
        const append = (chunk, isError) => { size += chunk.length; if (size > maxBytes) return finish(issue('PROVISION_SSH')); if (isError) stderr += chunk.toString('utf8'); else stdout += chunk.toString('utf8'); };
        stream.on('data', chunk => append(chunk, false)); stream.stderr.on('data', chunk => append(chunk, true)); stream.once('error', () => finish(issue('PROVISION_SSH')));
        stream.once('close', code => finish(code !== 0 && !allowFailure ? issue('PROVISION_SSH') : null, { code, stdout, stderr }));
      });
    });
  }
  const sftp = client => new Promise((resolve, reject) => {
    let done = false; const timer = setTimeout(() => { done = true; reject(issue('PROVISION_TIMEOUT', 504)); }, commandTimeoutMs); timer.unref();
    // Pending SFTP operations receive failures through their callbacks. Keep a
    // session observer as well so its final protocol-error event cannot become
    // an unhandled emitter after the last operation/session has been closed.
    client.sftp((error, value) => { clearTimeout(timer); if (done) { value?.on('error', () => {}); value?.end(); return; } done = true; if (error) return reject(issue('PROVISION_SSH')); const active = sessions.get(client) || new Set(); active.add(value); sessions.set(client, active); value.on('error', () => {}); value.once('close', () => active.delete(value)); resolve(value); });
  });
  const operation = (target, method, ...args) => new Promise((resolve, reject) => { let done = false; const timer = setTimeout(() => { done = true; reject(issue('PROVISION_TIMEOUT', 504)); }, commandTimeoutMs); timer.unref(); try { target[method](...args, (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); }); } catch { clearTimeout(timer); reject(issue('PROVISION_SSH')); } });
  async function readRemote(io, filename, maxBytes, { privateFile = false, signal } = {}) {
    let timer, aborted = false, cancel;
    const deadline = new Promise((_, reject) => {
      cancel = () => { aborted = true; io.end(); reject(issue('PROVISION_CLOSED', 503)); };
      timer = setTimeout(() => { aborted = true; io.end(); reject(issue('PROVISION_TIMEOUT', 504)); }, commandTimeoutMs); timer.unref();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    try {
      return await Promise.race([deadline, (async () => {
        if (aborted) fail('PROVISION_CLOSED', 503);
        const stat = await operation(io, 'lstat', filename);
        if (aborted) fail('PROVISION_CLOSED', 503);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || privateFile && (stat.uid !== 0 || stat.mode & 0o077)) fail('PROVISION_EXISTING_UNHEALTHY', 409);
        // ssh2 ReadStream may emit a late CLOSE error after its async iterator
        // has ended. Use bounded callback reads and await the file CLOSE before
        // returning bytes or ending the SFTP session; every late callback has
        // its own error consumer even when the deadline has already rejected.
        const handle = await operation(io, 'open', filename, 'r');
        try {
          const chunks = []; let bytes = 0;
          while (true) {
            if (aborted) fail('PROVISION_CLOSED', 503);
            const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - bytes));
            const count = await operation(io, 'read', handle, buffer, 0, buffer.length, bytes);
            if (!Number.isInteger(count) || count < 0 || count > buffer.length) fail('PROVISION_SSH');
            if (count === 0) return Buffer.concat(chunks, bytes);
            bytes += count; if (bytes > maxBytes) fail('PROVISION_SSH'); chunks.push(buffer.subarray(0, count));
          }
        } finally { if (!aborted) await operation(io, 'close', handle); }
      })()]);
    } catch (error) {
      if (error.code === 2 || error.code === 'ENOENT' || messages[error.code]) throw error;
      throw issue('PROVISION_SSH');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  async function preflight(client, signal) {
    const { stdout } = await exec(client, PREFLIGHT, { signal });
    if (!stdout.startsWith('VORTEX_PREFLIGHT_V1\n')) fail('PROVISION_PREFLIGHT', 409);
    const fields = Object.fromEntries(stdout.trim().split('\n').slice(1).map(line => line.split('=')));
    const host = { os: fields.os, version: fields.version, arch: fields.arch, userspaceArch: fields.userspace, root: fields.uid === '0', diskAvailableBytes: Number(fields.disk), memoryTotalBytes: Number(fields.memory), systemd: fields.systemd === '1' };
    const compatible = host.os === 'ubuntu' && /^\d+\.\d+$/.test(host.version || '') && Number(host.version) >= 22.04 && normalizeArchitecture(host.arch)!==null && normalizeArchitecture(host.arch)===normalizeArchitecture(host.userspaceArch) && host.root && host.systemd && Number.isSafeInteger(host.diskAvailableBytes) && host.diskAvailableBytes >= 2 * 1024 ** 3 && Number.isSafeInteger(host.memoryTotalBytes) && host.memoryTotalBytes >= 1024 ** 3;
    let existingAgent = { installed: fields.existing === '1', healthy: false };
    if (existingAgent.installed && compatible) {
      const health = await exec(client, 'node /opt/vortex-node/current/server/node-cli.js check --config /etc/vortex-node.json', { signal, allowFailure: true });
      if (health.code === 0) { try { const value = JSON.parse(health.stdout); if (value.ok === true && UUID.test(value.nodeId || '')) existingAgent = { installed: true, healthy: true, nodeId: value.nodeId, processId: value.processId }; } catch {} }
    }
    return { host, compatible, existingAgent };
  }
  async function check(input) {
    if (closed) fail('PROVISION_CLOSED', 503);
    if (checks >= 4) fail('PROVISION_LIMIT', 409);
    const settings = validate(input); checks++; let client;
    try { if (!settings.hostFingerprint) return await discoverHost(settings); const connected = await connect(settings); client = connected.client; const result = await preflight(client); return { hostFingerprint: connected.hostFingerprint, requiresHostConfirmation: false, authenticated: true, ...result }; }
    catch (error) { fail(closed ? 'PROVISION_CLOSED' : messages[error.code] ? error.code : 'PROVISION_SSH', closed ? 503 : error.status || 502); }
    finally { checks--; client?.destroy(); for (const key of ['password', 'privateKey', 'passphrase']) delete settings[key]; }
  }
  async function connectionRecord(client, signal) {
    const io = await sftp(client);
    try {
      const config = JSON.parse((await readRemote(io, '/etc/vortex-node.json', 65536, { privateFile: true, signal })).toString('utf8'));
      if (!UUID.test(config.nodeId || '') || !/^[A-Za-z0-9_-]{43,256}$/.test(config.token || '') || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !config.tls || typeof config.tls.certFile !== 'string' || !/^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\x00-\x1f]+$/.test(config.tls.certFile)) fail('PROVISION_EXISTING_UNHEALTHY', 409);
      const cert = new X509Certificate(await readRemote(io, config.tls.certFile, 512 * 1024, { signal }));
      return { agentId: config.nodeId, token: config.token, port: config.port, fingerprint: createHash('sha256').update(cert.raw).digest('hex').toUpperCase() };
    } finally { io.end(); }
  }
  async function allowControllerFirewall(client, port, nodeId, signal) {
    const status = await exec(client, 'if command -v ufw >/dev/null 2>&1 && LC_ALL=C ufw status | grep -q "^Status: active"; then printf active; else printf inactive; fi', { signal });
    if (status.stdout.trim() !== 'active') return;
    const address = (await exec(client, 'printf \'%s\' "${SSH_CONNECTION%% *}"', { signal })).stdout.trim();
    if (!net.isIP(address)) fail('PROVISION_LINK', 502);
    const owner = `vortex-agent:${nodeId}`;
    const before = (await exec(client, 'LC_ALL=C ufw status numbered', { signal })).stdout;
    if (!/^Status: active\s*$/m.test(before)) fail('PROVISION_LINK', 502);
    // UFW can replace the comment of an existing tuple. Never claim or alter
    // a pre-existing rule, including one created manually without a comment.
    const tuple = line => {
      const match = line.match(/^\[\s*\d+\]\s+(\d+)\/tcp(?:\s+\(v6\))?\s+ALLOW\s+IN\s+(\S+)(?:\s+#\s*(.*))?\s*$/);
      return match && Number(match[1]) === port && match[2] === address;
    };
    if (before.split(/\r?\n/).some(tuple)) return;
    const record = Buffer.from(JSON.stringify({ schemaVersion: 1, nodeId, rule: { source: address, port, protocol: 'tcp', comment: owner } })).toString('base64');
    const receipt = `import os,json,stat,sys,uuid,pathlib,base64
p=pathlib.Path('/etc/vortex-node/firewall-owner.json');root=p.parent
s=root.lstat();assert stat.S_ISDIR(s.st_mode) and s.st_uid==0 and not s.st_mode&0o077
v=json.loads(base64.b64decode(sys.argv[1]));old={'schemaVersion':1,'nodeId':v['nodeId'],'rules':[]}
if p.exists() or p.is_symlink():
 s=p.lstat();assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and not s.st_mode&0o077 and s.st_size<65536
 old=json.loads(p.read_text());assert old.get('schemaVersion')==1 and old.get('nodeId')==v['nodeId'] and isinstance(old.get('rules'),list) and len(old['rules'])<64
if v['rule'] not in old['rules']:old['rules'].append(v['rule'])
t=root/('.firewall-owner-'+str(uuid.uuid4())+'.tmp');f=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
with os.fdopen(f,'w') as out:json.dump(old,out);out.flush();os.fsync(out.fileno())
os.replace(t,p)
`;
    // Persist exclusive ownership intent before the rule can be created. The
    // unique comment and exact tuple are checked independently at uninstall.
    await exec(client, `/usr/bin/python3 -c ${shell(receipt)} ${shell(record)}`, { signal });
    // Only the authenticated SSH peer's observed IP, never a user-supplied
    // address or a global allow rule. Cloud firewall policies remain external.
    await exec(client, `ufw allow from ${shell(address)} to any port ${port} proto tcp comment ${shell(owner)}`, { signal });
    const after = (await exec(client, 'LC_ALL=C ufw status numbered', { signal })).stdout;
    if (!after.split(/\r?\n/).some(line => tuple(line) && line.trim().endsWith('# ' + owner))) fail('PROVISION_LINK', 502);
  }
  async function cleanup(client, stage, identity) {
    if (!/^\/root\/\.vortex-node-provision-[a-f0-9-]{36}$/.test(stage) || !/^\d+:\d+:0$/.test(identity)) return;
    await exec(client, `[ ! -L ${shell(stage)} ] && [ "$(realpath -- ${shell(stage)})" = ${shell(stage)} ] && [ "$(stat -c '%i:%d:%u' -- ${shell(stage)})" = ${shell(identity)} ] && rm -rf -- ${shell(stage)}`, { allowFailure: true }).catch(() => {});
  }
  async function work(job, input, user, control) {
    let client, io, localBundle, localInfo, stage, stageIdentity, detached = false, completed = false, lockOwned = false;
    const signal = control.signal, hostKey = `${input.host}:${input.port}`;
    const releaseRemoteLock = async () => { if (client && lockOwned && !detached) await exec(client, `[ ! -L /run/vortex-node-provision.lock ] && [ "$(cat /run/vortex-node-provision.lock/owner 2>/dev/null)" = ${shell(job.id)} ] && rm -f /run/vortex-node-provision.lock/owner && rmdir /run/vortex-node-provision.lock`, { allowFailure: true }).catch(() => {}); };
    try {
      step(job, 'connecting', 2); ({ client } = await connect(input, signal));
      const abort = () => { for (const active of sessions.get(client) || []) active.end(); }; signal.addEventListener('abort', abort, { once: true });
      step(job, 'preflight', 5); const checked = await preflight(client, signal);
      if (!checked.compatible) fail('PROVISION_PREFLIGHT', 409);
      if (checked.existingAgent.installed && !checked.existingAgent.healthy) fail('PROVISION_EXISTING_UNHEALTHY', 409);
      if (!checked.existingAgent.installed) {
        const acquired = await exec(client, `umask 077; mkdir /run/vortex-node-provision.lock 2>/dev/null || exit 73; printf '%s' ${shell(job.id)} > /run/vortex-node-provision.lock/owner`, { signal, allowFailure: true });
        if (acquired.code !== 0) fail('PROVISION_LOCKED', 409); lockOwned = true;
        const occupied = await exec(client, `command -v ss >/dev/null 2>&1 && ss -H -ltn 'sport = :${input.agentPort}'`, { signal });
        if (occupied.stdout.trim()) fail('PROVISION_PORT', 409);
        step(job, 'bundle', 10); localBundle = path.join(dataDir, `.node-provision-${job.id}.zip`);
        const bundle = await buildNodeBundle(projectDir, localBundle); localInfo = await fs.lstat(localBundle);
        io = await sftp(client); stage = `/root/.vortex-node-provision-${job.id}`;
        await operation(io, 'mkdir', stage, { mode: 0o700 });
        const stat = await operation(io, 'lstat', stage); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o077) fail('PROVISION_TRANSFER');
        const identity = await exec(client, `stat -c '%i:%d:%u' -- ${shell(stage)}`, { signal }); stageIdentity = identity.stdout.trim(); if (!/^\d+:\d+:0$/.test(stageIdentity)) fail('PROVISION_TRANSFER');
        step(job, 'upload', 15, { transfer: { loadedBytes: 0, totalBytes: bundle.bytes, percent: 0 } });
        let lastUpdate = 0;
        await new Promise((resolve, reject) => {
          let done = false, timer; const finish = error => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); if (error) io.end(); error ? reject(error) : resolve(); }, cancel = () => finish(issue('PROVISION_CLOSED', 503));
          timer = setTimeout(() => finish(issue('PROVISION_TIMEOUT', 504)), transferTimeoutMs); timer.unref();
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) return cancel();
          io.fastPut(localBundle, `${stage}/source.zip`, { mode: 0o600, step(loaded) { if (Date.now() - lastUpdate < 250 && loaded !== bundle.bytes) return; lastUpdate = Date.now(); try { step(job, 'upload', 15 + Math.floor(loaded / bundle.bytes * 15), { transfer: { loadedBytes: loaded, totalBytes: bundle.bytes, percent: Math.floor(loaded / bundle.bytes * 100) } }); } catch (error) { io.end(); finish(error); } } }, error => finish(error ? issue('PROVISION_TRANSFER') : null));
        });
        const verified = await exec(client, `sha256sum -- ${shell(stage + '/source.zip')}`, { signal }); if (verified.stdout.split(/\s/)[0] !== bundle.sha256) fail('PROVISION_TRANSFER');
        const endpoint = `https://${net.isIP(input.host) === 6 ? '[' + input.host + ']' : input.host}:${input.agentPort}`;
        const runner = `#!/bin/bash\nset +e\numask 077\nrelease_lock() { if [ ! -L /run/vortex-node-provision.lock ] && [ "$(cat /run/vortex-node-provision.lock/owner 2>/dev/null)" = ${shell(job.id)} ]; then rm -f /run/vortex-node-provision.lock/owner; rmdir /run/vortex-node-provision.lock 2>/dev/null; fi; }\ntrap release_lock EXIT\n( set -e; printf bootstrap > ${shell(stage + '/phase')}; if ! command -v unzip >/dev/null 2>&1; then apt-get -o DPkg::Lock::Timeout=120 update; DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y unzip; fi; printf unpack > ${shell(stage + '/phase')}; mkdir ${shell(stage + '/source')}; unzip -q ${shell(stage + '/source.zip')} -d ${shell(stage + '/source')}; printf install > ${shell(stage + '/phase')}; bash ${shell(stage + '/source/deploy/install-node.sh')} --endpoint ${shell(endpoint)} --port ${input.agentPort} ) > ${shell(stage + '/installer.log')} 2>&1\nresult=$?\nprintf '%s' "$result" > ${shell(stage + '/status.tmp')}\nmv -- ${shell(stage + '/status.tmp')} ${shell(stage + '/status')}\n`;
        await operation(io, 'writeFile', `${stage}/run.sh`, runner, { mode: 0o600 });
        step(job, 'install', 35, { recoveryPath: `${stage}/installer.log`, transfer: { loadedBytes: bundle.bytes, totalBytes: bundle.bytes, percent: 100 } });
        // Sending exec may start the detached process even if the reply is
        // lost. From this point never delete its source or release its lock.
        detached = true;
        const launch = await exec(client, `umask 077; nohup /bin/bash ${shell(stage + '/run.sh')} </dev/null >${shell(stage + '/launch.log')} 2>&1 & printf '%s' "$!"`, { signal });
        if (!/^[1-9]\d*$/.test(launch.stdout.trim())) fail('PROVISION_INSTALL');
        const began = Date.now(); let status;
        while (status === undefined) {
          if (signal.aborted) fail('PROVISION_CLOSED', 503);
          if (Date.now() - began > installTimeoutMs) fail('PROVISION_TIMEOUT', 504);
          try { const text = (await readRemote(io, stage + '/status', 32, { signal })).toString('utf8').trim(); if (!/^\d{1,3}$/.test(text)) fail('PROVISION_INSTALL'); status = Number(text); }
          catch (error) { if (error.code !== 2 && error.code !== 'ENOENT') throw error; }
          if (status === undefined) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, pollIntervalMs); const abort = () => { clearTimeout(timer); reject(issue('PROVISION_CLOSED', 503)); }; signal.addEventListener('abort', abort, { once: true }); setTimeout(() => signal.removeEventListener('abort', abort), pollIntervalMs + 1).unref(); });
        }
        completed = true; if (status !== 0) fail('PROVISION_INSTALL'); io.end(); io = null;
      }
      step(job, 'linking', 90); const record = await connectionRecord(client, signal);
      await allowControllerFirewall(client, record.port, record.agentId, signal);
      const endpoint = `https://${net.isIP(input.host) === 6 ? '[' + input.host + ']' : input.host}:${record.port}`;
      const payload = { ...(input.name ? { name: input.name } : {}), endpoint, token: record.token, fingerprint: record.fingerprint, publicAddress: input.publicAddress, location: input.location };
      const existing = (store.data.nodes || []).find(node => node.agentId === record.agentId);
      let linked;
      try { linked = existing ? await nodes.update(existing.id, payload, user) : await nodes.add(payload, user); } catch { fail('PROVISION_LINK', 502); }
      delete record.token; delete payload.token;
      transition(job, { nodeId: linked.id, status: 'completed', phase: 'completed', progress: 100, ...presentation('completed'), finishedAt: new Date().toISOString(), completionStatusPersisted: true });
      if (stage && completed) await cleanup(client, stage, stageIdentity);
    } catch (error) {
      const code = signal.aborted || closed ? 'interrupted' : messages[error.code] ? error.code : 'PROVISION_INSTALL';
      const fields = { status: 'failed', phase: code === 'interrupted' ? 'interrupted' : 'failed', ...presentation(code), finishedAt: new Date().toISOString(), outcomeUnknown: detached && !completed || code === 'interrupted', completionStatusPersisted: true };
      try { transition(job, fields); } catch { Object.assign(job, fields, { completionStatusPersisted: false }); changed(); }
    } finally {
      await releaseRemoteLock(); io?.end();
      if (stage && stageIdentity && !detached && client) await cleanup(client, stage, stageIdentity);
      client?.destroy(); connections.delete(client);
      if (localBundle && localInfo) { const actual = await fs.lstat(localBundle).catch(() => null); if (actual?.isFile() && !actual.isSymbolicLink() && actual.ino === localInfo.ino && actual.dev === localInfo.dev) await fs.unlink(localBundle).catch(() => {}); }
      for (const key of ['password', 'privateKey', 'passphrase']) delete input[key]; pendingHosts.delete(hostKey); tasks.delete(job.id);
    }
  }
  function start(input, user) {
    if (closed) fail('PROVISION_CLOSED', 503);
    if (user?.role !== 'admin') fail('PROVISION_INPUT', 403);
    const settings = validate(input, true), hostKey = `${settings.host}:${settings.port}`;
    if (tasks.size >= 2 || pendingHosts.has(hostKey)) fail('PROVISION_LIMIT', 409);
    const record = { id: randomUUID(), type: 'node-provision', adminOnly: true, scope: 'nodes', serverId: null, status: 'queued', progress: 0, phase: 'queued', ...presentation('queued'), createdAt: new Date().toISOString(), finishedAt: null };
    const before = store.data.nodeProvisionJobs; store.data.nodeProvisionJobs = [record, ...before];
    try { store.data.nodeProvisionJobs = trim(); store.save(); } catch { store.data.nodeProvisionJobs = before; fail('PROVISION_PERSIST', 500); }
    const control = new AbortController(); pendingHosts.add(hostKey);
    const task = Promise.resolve().then(() => work(record, settings, { id: user.id, username: user.username, role: user.role }, control));
    tasks.set(record.id, { task, control }); changed(); return publicJob(record);
  }
  // Destructive worker removal uses a fresh authenticated, pinned SSH session.
  // Credentials are never added to a job, node record, command or log.
  async function withSSH(input, callback) {
    if (closed) fail('PROVISION_CLOSED', 503);
    const settings = validate(input); settings.hostFingerprint = fingerprint(settings.hostFingerprint, true);
    let client, io;
    try {
      ({ client } = await connect(settings)); io = await sftp(client);
      return await callback({
        exec: (command, options) => exec(client, command, options),
        read: async (filename, maximum = 65536) => readRemote(io, filename, maximum, { privateFile: true }),
        mkdir: (filename, mode = 0o700) => operation(io, 'mkdir', filename, { mode }),
        write: (filename, content, mode = 0o600) => operation(io, 'writeFile', filename, content, { mode, flag: 'wx' }),
        lstat: filename => operation(io, 'lstat', filename),
      });
    } finally { io?.end(); client?.destroy(); for (const key of ['password', 'privateKey', 'passphrase']) { delete settings[key]; if (input && typeof input === 'object') delete input[key]; } }
  }
  async function close() { if (closed) return; closed = true; for (const { control } of tasks.values()) control.abort(); await Promise.allSettled([...tasks.values()].map(value => value.task)); for (const connection of connections) connection.destroy(); }
  return { check, withSSH, async discover(input) { if (closed) fail('PROVISION_CLOSED', 503); if (!input || Object.keys(input).some(key => !['host', 'port'].includes(key))) fail('PROVISION_INPUT', 400); const settings = validate({ host: input.host, port: input.port, username: 'root', password: 'discovery-unused' }); if (checks >= 4) fail('PROVISION_LIMIT', 409); checks++; try { return await discoverHost(settings); } catch { fail('PROVISION_SSH'); } finally { checks--; } }, start, jobs: () => store.data.nodeProvisionJobs.map(publicJob), getJob(id) { const record = store.data.nodeProvisionJobs.find(job => job.id === id); if (!record) fail('PROVISION_INPUT', 404); return publicJob(record); }, close };
}
