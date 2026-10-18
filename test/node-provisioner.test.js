import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import ssh2 from 'ssh2';
import yauzl from 'yauzl';
import { createNodeProvisioner } from '../server/node-provisioner.js';
import { buildNodeBundle } from '../server/node-bundle.js';
import { NODE_RUNTIME_FILES, NODE_INSTALLER_FILES } from '../server/node-runtime.js';

const { Server, utils } = ssh2, STATUS = utils.sftp.STATUS_CODE;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(callback, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = callback(); if (value) return value; await pause(20); } throw new Error('Fixture timed out'); }
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
async function project(root) {
  for (const name of ['server', 'public', 'deploy', 'scripts', 'docs', 'test', 'output', 'data']) { await fs.mkdir(path.join(root, name), { recursive: true }); await fs.writeFile(path.join(root, name, 'source.js'), 'public source fixture'); }
  for (const name of ['package.json', 'package-lock.json', 'README.md', '.env.example']) await fs.writeFile(path.join(root, name), 'public root fixture');
  for (const name of ['.env.local', 'private.pem', 'backup.bk.1', 'node.json']) await fs.writeFile(path.join(root, 'server', name), 'NEVER_BUNDLE_PRIVATE_FIXTURE');
  for (const relative of NODE_INSTALLER_FILES) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'public worker fixture');
  }
  for (const relative of ['server/index.js', 'server/auth.js', 'public/index.html', 'deploy/install.sh']) await fs.writeFile(path.join(root, relative), 'NEVER_BUNDLE_PANEL_FIXTURE');
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-provision-test-')), projectDir = path.join(root, 'project'), dataDir = path.join(root, 'data'); await fs.mkdir(dataDir); await project(projectDir);
  const openssl = process.platform === 'win32' && syncFs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=Provision fixture', '-keyout', path.join(root, 'tls.key'), '-out', path.join(root, 'tls.crt')], { stdio: 'ignore', windowsHide: true });
  const cert = await fs.readFile(path.join(root, 'tls.crt')), hostKey = rsa(), userKey = rsa(), publicUserKey = utils.parseKey(userKey);
  const hostFingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/, ''), password = 'private-fixture-password-' + randomUUID(), bearer = randomBytes(32).toString('base64url'), agentId = randomUUID();
  const files = new Map(), directories = new Set(['/etc', '/etc/vortex-node']), clients = new Set(), commands = [], linked = [], closedFiles = [];
  let authCalls = 0, installs = 0, heldReads = 0, lock = false, failSave = false, persisted, controllerRule = false;
  const config = { schemaVersion: 1, nodeId: agentId, token: bearer, host: '0.0.0.0', port: options.agentPort || 8443, dataDir: '/var/lib/vortex-node', tls: { certFile: '/etc/vortex-node/tls.crt', keyFile: '/etc/vortex-node/tls.key' } };
  const seedConfig = () => { files.set('/etc/vortex-node.json', Buffer.from(JSON.stringify(config))); files.set('/etc/vortex-node/tls.crt', cert); };
  if (options.existing) seedConfig();
  const attributes = filename => { const directory = directories.has(filename); if (!directory && !files.has(filename)) return null; return { mode: directory ? 0o40700 : 0o100600, uid: 0, gid: 0, size: directory ? 0 : files.get(filename).length, atime: 0, mtime: 0 }; };
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      authCalls++;
      if (ctx.username === 'root' && ctx.method === 'password' && ctx.password === password) return ctx.accept();
      if (ctx.username === 'root' && ctx.method === 'publickey' && ctx.key.data.equals(publicUserKey.getPublicSSH()) && (!ctx.signature || publicUserKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) return ctx.accept();
      ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, _reject, info) => {
        commands.push(info.command); const stream = accept(); let result = '', code = 0;
        if (info.command.includes('VORTEX_PREFLIGHT_V1')) result = `VORTEX_PREFLIGHT_V1\nuid=${options.nonroot ? 1000 : 0}\nos=ubuntu\nversion=24.04\narch=x86_64\ndisk=17179869184\nmemory=8589934592\nsystemd=1\nexisting=${options.existing ? 1 : 0}\n`;
        else if (info.command.startsWith('node /opt/vortex-node/current/')) { if (options.unhealthy) code = 1; else result = JSON.stringify({ ok: true, nodeId: agentId, processId: 42 }); }
        else if (info.command.includes('mkdir /run/vortex-node-provision.lock')) { if (lock) code = 73; else lock = true; }
        else if (info.command.includes('ss -H')) result = options.occupied ? 'LISTEN occupied fixture' : '';
        else if (info.command.startsWith('stat -c')) result = '100:1:0\n';
        else if (info.command.startsWith('sha256sum')) { const entry = [...files.keys()].find(name => name.endsWith('/source.zip')); result = createHash('sha256').update(files.get(entry)).digest('hex') + '  source.zip\n'; }
        else if (info.command.startsWith('umask 077; nohup')) {
          installs++; const stage = info.command.match(/\/root\/\.vortex-node-provision-[a-f0-9-]{36}/)[0], runner = files.get(stage + '/run.sh').toString();
          assert.equal(runner.includes(password), false); assert.equal(runner.includes(userKey), false); assert.equal(runner.includes(bearer), false);
          config.port = Number(runner.match(/--port (\d+)/)[1]); seedConfig();
          files.set(stage + '/installer.log', Buffer.from('intentional private installer token ' + bearer));
          if (!options.holdInstall) { files.set(stage + '/status', Buffer.from(String(options.installFailure ? 1 : 0))); lock = false; }
          result = '12345';
        } else if (info.command === 'LC_ALL=C ufw status numbered') result = options.ufwActive ? `Status: active\n${controllerRule ? `[ 1] ${config.port}/tcp ALLOW IN 203.0.113.25 # vortex-agent:${agentId}\n` : ''}` : 'Status: inactive';
        else if (info.command.includes('LC_ALL=C ufw status')) result = options.ufwActive ? 'active' : 'inactive';
        else if (info.command.includes('SSH_CONNECTION')) result = '203.0.113.25';
        else if (info.command.startsWith('/usr/bin/python3 -c ')) { const encoded = info.command.match(/'([A-Za-z0-9+/=]+)'$/)?.[1], record = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); assert.equal(record.nodeId, agentId); assert.equal(record.rule.comment, 'vortex-agent:' + agentId); files.set('/etc/vortex-node/firewall-owner.json', Buffer.from(JSON.stringify({ schemaVersion: 1, nodeId: agentId, rules: [record.rule] }))); }
        else if (info.command.startsWith('ufw allow')) { assert.equal(info.command, `ufw allow from '203.0.113.25' to any port ${config.port} proto tcp comment 'vortex-agent:${agentId}'`); controllerRule = true; }
        else if (info.command.includes('rm -rf --')) { const stage = info.command.match(/\/root\/\.vortex-node-provision-[a-f0-9-]{36}/)[0]; for (const name of files.keys()) if (name.startsWith(stage + '/')) files.delete(name); directories.delete(stage); }
        else if (info.command.includes('rmdir /run/vortex-node-provision.lock')) lock = false;
        else { code = 1; }
        if (result) stream.write(result); if (code) stream.stderr.write(password + ' ' + bearer + ' must never escape'); stream.exit(code); stream.end();
      });
      session.on('sftp', accept => {
        const io = accept(), handles = new Map(); let next = 1;
        const guard = (reqid, callback) => Promise.resolve().then(callback).catch(() => io.status(reqid, STATUS.FAILURE));
        const stat = (reqid, filename) => { const attr = attributes(filename); attr ? io.attrs(reqid, attr) : io.status(reqid, STATUS.NO_SUCH_FILE); };
        io.on('LSTAT', stat); io.on('STAT', stat);
        io.on('MKDIR', (reqid, filename) => { directories.add(filename); io.status(reqid, STATUS.OK); });
        io.on('OPEN', (reqid, filename, flags) => {
          const mode = utils.sftp.flagsToString(flags); if (mode?.includes('x') && files.has(filename)) return io.status(reqid, STATUS.FAILURE); if (mode?.startsWith('w')) files.set(filename, Buffer.alloc(0));
          if (!files.has(filename)) return io.status(reqid, STATUS.NO_SUCH_FILE);
          const handle = Buffer.alloc(4); handle.writeUInt32BE(next); handles.set(next++, filename); io.handle(reqid, handle);
        });
        io.on('FSTAT', (reqid, handle) => stat(reqid, handles.get(handle.readUInt32BE(0))));
        io.on('WRITE', (reqid, handle, offset, chunk) => guard(reqid, () => { const filename = handles.get(handle.readUInt32BE(0)), old = files.get(filename), next = Buffer.alloc(Math.max(old.length, offset + chunk.length)); old.copy(next); chunk.copy(next, offset); files.set(filename, next); if (!options.holdUpload || !filename.endsWith('/source.zip')) io.status(reqid, STATUS.OK); }));
        io.on('READ', (reqid, handle, offset, length) => { const filename = handles.get(handle.readUInt32BE(0)); if (options.holdRead && filename.endsWith(options.holdRead)) { heldReads++; return; } const content = files.get(filename); if (!content || offset >= content.length) io.status(reqid, STATUS.EOF); else io.data(reqid, content.subarray(offset, offset + length)); });
        io.on('CLOSE', (reqid, handle) => {
          const filename = handles.get(handle.readUInt32BE(0)); handles.delete(handle.readUInt32BE(0));
          if (options.closeDisconnect && filename === '/etc/vortex-node.json') { client.end(); return; }
          const respond = () => { closedFiles.push(filename); io.status(reqid, STATUS.OK); };
          if (options.closeDelayMs) setTimeout(respond, options.closeDelayMs); else respond();
        });
        io.on('SETSTAT', reqid => io.status(reqid, STATUS.OK)); io.on('FSETSTAT', reqid => io.status(reqid, STATUS.OK));
        io.on('error', () => {});
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const existingCentralId = randomUUID(), store = { data: { nodeProvisionJobs: options.history || [], nodes: options.linked ? [{ id: existingCentralId, agentId, grantsMarker: 'preserve grants' }] : [] }, save() { if (failSave) throw Object.assign(new Error(password), { code: 'ENOSPC' }); persisted = JSON.stringify(this.data); } };
  const nodes = { async add(input, user) { linked.push({ input: structuredClone(input), user, method: 'add', closedAtLink: [...closedFiles] }); if (options.linkFailure) throw new Error(password); return { id: randomUUID() }; }, async update(id, input, user) { linked.push({ id, input: structuredClone(input), user, method: 'update', closedAtLink: [...closedFiles] }); return { id }; } };
  const events = [], provisioner = createNodeProvisioner({ nodes, store, projectDir, dataDir, emit: event => events.push(event), connectTimeoutMs: 1500, commandTimeoutMs: options.commandTimeoutMs || 1500, transferTimeoutMs: options.transferTimeoutMs || 3000, installTimeoutMs: 3000, pollIntervalMs: 20 });
  const access = { host: '127.0.0.1', port: server.address().port, username: 'root', password }, admin = { id: randomUUID(), username: 'fixture-admin', role: 'admin' };
  t.after(async () => { await provisioner.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { provisioner, access, admin, hostFingerprint, password, bearer, userKey, linked, existingCentralId, store, events, commands, files, root, projectDir, dataDir, authCalls: () => authCalls, installs: () => installs, heldReads: () => heldReads, persisted: () => persisted, failSave: () => { failSave = true; } };
}

test('SSH host discovery sends no user authentication; confirmed password/key checks work and changed host rejects before credentials', async t => {
  const f = await fixture(t);
  const discovered = await f.provisioner.check(f.access); assert.equal(discovered.hostFingerprint, f.hostFingerprint); assert.equal(discovered.requiresHostConfirmation, true); assert.equal(f.authCalls(), 0);
  const checked = await f.provisioner.check({ ...f.access, hostFingerprint: f.hostFingerprint }); assert.equal(checked.authenticated, true); assert.equal(checked.compatible, true); assert.equal(checked.host.root, true);
  const before = f.authCalls(); await assert.rejects(f.provisioner.check({ ...f.access, hostFingerprint: 'SHA256:' + 'A'.repeat(43) }), { code: 'PROVISION_HOST_CHANGED' }); assert.equal(f.authCalls(), before);
  const keyed = { ...f.access, privateKey: f.userKey, hostFingerprint: f.hostFingerprint }; delete keyed.password;
  assert.equal((await f.provisioner.check(keyed)).compatible, true); assert.equal(JSON.stringify(checked).includes(f.password), false); assert.equal(JSON.stringify(checked).includes(f.bearer), false);
});

test('one-time pinned removal SSH transport reads private files, exclusively creates helpers and always discards credentials', async t => {
  const f = await fixture(t, { existing: true }), input = { ...f.access, hostFingerprint: f.hostFingerprint };
  const original = Buffer.from(f.files.get('/etc/vortex-node.json'));
  await f.provisioner.withSSH(input, async connection => {
    assert.deepEqual(await connection.read('/etc/vortex-node.json'), original);
    await assert.rejects(connection.write('/etc/vortex-node.json', Buffer.from('must not replace existing private configuration')));
    assert.deepEqual(await connection.read('/etc/vortex-node.json'), original);
    await connection.write('/etc/vortex-node/removal-helper-fixture.py', Buffer.from('inert helper fixture'));
    assert.equal((await connection.read('/etc/vortex-node/removal-helper-fixture.py')).toString(), 'inert helper fixture');
  });
  assert.equal(input.password, undefined); assert.deepEqual(f.files.get('/etc/vortex-node.json'), original); assert.equal(f.installs(), 0);
  const before = f.authCalls();
  await assert.rejects(f.provisioner.withSSH({ ...f.access, hostFingerprint: 'SHA256:' + 'A'.repeat(43) }, () => { throw new Error('must not reach changed host'); }), { code: 'PROVISION_HOST_CHANGED' });
  assert.equal(f.authCalls(), before);
});

test('real SSH/SFTP uploads hashed source, launches a modeled detached install, narrows UFW and links without persisting secrets', async t => {
  const f = await fixture(t, { ufwActive: true }), accepted = f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Node fixture', agentPort: 9443 }, f.admin);
  assert.equal(accepted.status, 'queued'); assert.equal(accepted.serverId, null); assert.equal(accepted.adminOnly, true); assert.equal(JSON.stringify(accepted).includes(f.password), false);
  const done = await waitFor(() => { const job = f.provisioner.getJob(accepted.id); return ['completed', 'failed'].includes(job.status) && job; });
  assert.equal(done.status, 'completed', done.message); assert.equal(done.progress, 100); assert.equal(f.installs(), 1); assert.equal(f.linked[0].input.token === f.bearer, true); assert.equal(f.linked[0].input.endpoint, 'https://127.0.0.1:9443'); assert.equal(f.linked[0].input.fingerprint.length, 64);
  for (const output of [f.persisted(), JSON.stringify(f.provisioner.jobs()), JSON.stringify(f.events), f.commands.join('\n')]) for (const secret of [f.password, f.bearer, f.userKey]) assert.equal(output.includes(secret), false);
  assert.ok(f.commands.some(command => command.startsWith('ufw allow from'))); assert.ok(f.commands.some(command => command.includes('sha256sum'))); assert.ok(done.transfer.loadedBytes > 0); assert.equal(done.transfer.percent, 100);
  const receipt = JSON.parse(f.files.get('/etc/vortex-node/firewall-owner.json').toString()); assert.equal(receipt.rules.length, 1); assert.equal(receipt.rules[0].source, '203.0.113.25'); assert.equal(receipt.rules[0].port, 9443);
  t.diagnostic('Real localhost SSH2 authentication/exec/SFTP bytes; remote Ubuntu/APT/systemd installer effects are explicitly modeled, not deployed.');
});

test('healthy installed agents are reused without installation and an existing central identity/grants stay bound', async t => {
  const f = await fixture(t, { existing: true, linked: true, agentPort: 9555 }), record = f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Reuse fixture' }, f.admin);
  const done = await waitFor(() => { const job = f.provisioner.getJob(record.id); return ['completed', 'failed'].includes(job.status) && job; });
  assert.equal(done.status, 'completed', done.message); assert.equal(f.installs(), 0); assert.equal(f.linked[0].method, 'update'); assert.equal(f.linked[0].id, f.existingCentralId); assert.equal(done.nodeId, f.existingCentralId); assert.equal(f.store.data.nodes[0].grantsMarker, 'preserve grants'); assert.equal(f.linked[0].input.endpoint, 'https://127.0.0.1:9555');
});

test('unhealthy existing agents and occupied ports fail safely without installation or linking', async t => {
  for (const scenario of [{ existing: true, unhealthy: true }, { occupied: true }]) {
    const f = await fixture(t, scenario), record = f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Refuse fixture' }, f.admin);
    const done = await waitFor(() => { const job = f.provisioner.getJob(record.id); return job.status === 'failed' && job; }); assert.equal(f.installs(), 0); assert.equal(f.linked.length, 0); assert.equal(done.outcomeUnknown, false); assert.equal(JSON.stringify(done).includes(f.password), false);
  }
});

test('closing after detached launch marks unknown/interrupted and never sends remote kill or retries', async t => {
  const f = await fixture(t, { holdInstall: true }), record = f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Detached fixture' }, f.admin);
  await waitFor(() => f.installs() === 1); await f.provisioner.close(); const done = f.provisioner.getJob(record.id);
  assert.equal(done.status, 'failed'); assert.equal(done.phase, 'interrupted'); assert.equal(done.outcomeUnknown, true); assert.equal(f.installs(), 1); assert.equal(f.linked.length, 0); assert.equal(f.commands.some(command => /\bkill\b/.test(command)), false); assert.equal(f.commands.some(command => command.includes('rm -rf --')), false);
});

test('queue acceptance is durable, credentials stay out of failed saves and restarts mark active history interrupted', async t => {
  const f = await fixture(t); f.failSave();
  assert.throws(() => f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Never accepted' }, f.admin), { code: 'PROVISION_PERSIST' }); assert.equal(f.provisioner.jobs().length, 0); assert.equal(f.authCalls(), 0);
  const old = Array.from({ length: 25 }, (_, index) => ({ id: randomUUID(), status: index === 0 ? 'running' : 'completed', createdAt: new Date().toISOString() }));
  const restart = await fixture(t, { history: old }); assert.equal(restart.provisioner.jobs()[0].phase, 'interrupted'); assert.equal(restart.provisioner.jobs()[0].outcomeUnknown, true);
  assert.equal(restart.provisioner.jobs().length, 20);
});

test('two accepted jobs are the maximum, duplicate hosts are blocked and invalid inputs never initiate SSH', async t => {
  const f = await fixture(t), input = { ...f.access, hostFingerprint: f.hostFingerprint, name: 'Concurrency fixture' };
  for (const change of [{ host: 'host; touch /tmp/unsafe' }, { username: 'root;unsafe' }, { publicAddress: 'host:invalid-port' }, { agentPort: 22 }, { hostFingerprint: null }]) assert.throws(() => f.provisioner.start({ ...input, ...change }, f.admin), { status: 400 });
  assert.equal(f.authCalls(), 0); f.provisioner.start(input, f.admin); assert.throws(() => f.provisioner.start(input, f.admin), { code: 'PROVISION_LIMIT' });
  const nextPort = f.access.port === 65535 ? 65534 : f.access.port + 1; f.provisioner.start({ ...input, port: nextPort }, f.admin);
  assert.throws(() => f.provisioner.start({ ...input, port: nextPort === 65535 ? 65533 : nextPort + 1 }, f.admin), { code: 'PROVISION_LIMIT' }); await f.provisioner.close(); assert.equal(f.provisioner.jobs().length, 2); assert.ok(f.provisioner.jobs().every(job => job.phase === 'interrupted'));
});

test('controller close during SFTP upload cleans only its owned prelaunch stage/lock and never runs installer', async t => {
  const f = await fixture(t, { holdUpload: true }), job = f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Upload abort fixture' }, f.admin);
  await waitFor(() => [...f.files.keys()].some(name => name.endsWith('/source.zip') && f.files.get(name).length));
  await f.provisioner.close(); assert.equal(f.installs(), 0); assert.equal(f.provisioner.getJob(job.id).phase, 'interrupted'); assert.equal(f.files.size, 0);
  assert.ok(f.commands.some(command => command.includes('rmdir /run/vortex-node-provision.lock'))); assert.ok(f.commands.some(command => command.includes('rm -rf --')));
});

test('healthy SSH cannot hold stalled SFTP uploads or reads forever, and close cancels a pending private read', async t => {
  const upload = await fixture(t, { holdUpload: true, transferTimeoutMs: 250 });
  const accepted = upload.provisioner.start({ ...upload.access, hostFingerprint: upload.hostFingerprint, name: 'Upload deadline fixture' }, upload.admin);
  const failed = await waitFor(() => { const job = upload.provisioner.getJob(accepted.id); return job.status === 'failed' && job; });
  assert.match(failed.message, /timed out/); assert.equal(failed.outcomeUnknown, false); assert.equal(upload.installs(), 0);
  await waitFor(() => upload.files.size === 0); assert.ok(upload.commands.some(command => command.includes('rmdir /run/vortex-node-provision.lock')));

  const read = await fixture(t, { holdRead: '/status', commandTimeoutMs: 600 });
  const readJob = read.provisioner.start({ ...read.access, hostFingerprint: read.hostFingerprint, name: 'Read deadline fixture' }, read.admin);
  const timedOut = await waitFor(() => { const job = read.provisioner.getJob(readJob.id); return job.status === 'failed' && job; });
  assert.ok(read.heldReads() > 0); assert.match(timedOut.message, /timed out/); assert.equal(timedOut.outcomeUnknown, true); assert.equal(read.installs(), 1); assert.equal(read.linked.length, 0);
  assert.equal(read.commands.some(command => command.includes('rm -rf --')), false);

  const closing = await fixture(t, { existing: true, holdRead: '/vortex-node.json' });
  const closingJob = closing.provisioner.start({ ...closing.access, hostFingerprint: closing.hostFingerprint, name: 'Read close fixture' }, closing.admin);
  await waitFor(() => closing.heldReads() > 0); const started = Date.now(); await closing.provisioner.close();
  assert.ok(Date.now() - started < 1200); assert.equal(closing.provisioner.getJob(closingJob.id).phase, 'interrupted'); assert.equal(closing.linked.length, 0);
});

test('actual SSH/SFTP delayed file CLOSE and disconnect after EOF cannot crash the controller subprocess or falsely complete', () => {
  const prefix = syncFs.readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\ntest\(/)[0];
  const scenario = `
const cleanups = [], context = { after(callback) { cleanups.push(callback); } };
try {
  const delayed = await fixture(context, { existing: true, closeDelayMs: 180 });
  const first = delayed.provisioner.start({ ...delayed.access, hostFingerprint: delayed.hostFingerprint, name: 'Delayed CLOSE fixture' }, delayed.admin);
  const complete = await waitFor(() => { const job = delayed.provisioner.getJob(first.id); return ['completed', 'failed'].includes(job.status) && job; });
  assert.equal(complete.status, 'completed');
  assert.ok(delayed.linked[0].closedAtLink.includes('/etc/vortex-node.json'));
  assert.ok(delayed.linked[0].closedAtLink.includes('/etc/vortex-node/tls.crt'));
  const disconnected = await fixture(context, { existing: true, closeDisconnect: true });
  const second = disconnected.provisioner.start({ ...disconnected.access, hostFingerprint: disconnected.hostFingerprint, name: 'EOF CLOSE disconnect fixture' }, disconnected.admin);
  const failure = await waitFor(() => { const job = disconnected.provisioner.getJob(second.id); return job.status === 'failed' && job; });
  assert.equal(failure.outcomeUnknown, false); assert.equal(disconnected.linked.length, 0); assert.match(failure.message, /SSH connection or authentication failed/);
  await pause(300);
  console.log(JSON.stringify({ delayedCloseAwaited: true, disconnectFailedBeforeLink: true, processAlive: true }));
} finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
`;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', prefix + scenario], { cwd: path.resolve('test'), timeout: 30000, windowsHide: true, encoding: 'utf8', maxBuffer: 65536 });
  assert.deepEqual(JSON.parse(output.trim()), { delayedCloseAwaited: true, disconnectFailedBeforeLink: true, processAlive: true });
});

test('HTTPS linking failure reports installed-but-unlinked honestly and retains only a private installer recovery path', async t => {
  const f = await fixture(t, { linkFailure: true }), record = f.provisioner.start({ ...f.access, hostFingerprint: f.hostFingerprint, name: 'Link failure fixture' }, f.admin);
  const failed = await waitFor(() => { const job = f.provisioner.getJob(record.id); return job.status === 'failed' && job; });
  assert.equal(f.installs(), 1); assert.equal(failed.outcomeUnknown, false); assert.match(failed.message, /installation completed.*HTTPS/); assert.match(failed.recoveryPath, /^\/root\/\.vortex-node-provision-[a-f0-9-]{36}\/installer\.log$/); assert.equal(failed.nodeId, undefined);
  for (const secret of [f.password, f.bearer, f.userKey]) assert.equal(JSON.stringify(failed).includes(secret), false);
});

test('worker bundle contains only runtime/installer files, supports stream hashing and never overwrites a destination', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'agent.zip'), bundle = await buildNodeBundle(f.projectDir, destination), entries = [];
  const bytes = await fs.readFile(destination); assert.equal(bundle.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(bytes.includes(Buffer.from('NEVER_BUNDLE_PRIVATE_FIXTURE')), false); assert.equal(bytes.includes(Buffer.from('NEVER_BUNDLE_PANEL_FIXTURE')), false);
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => { if (error) return reject(error); zip.on('entry', entry => { entries.push(entry.fileName); zip.readEntry(); }); zip.on('end', resolve); zip.on('error', reject); zip.readEntry(); }));
  assert.deepEqual(entries.slice().sort(), [...NODE_INSTALLER_FILES].sort()); assert.equal(entries.some(entry => /^(?:data|output)\//.test(entry)), false); await assert.rejects(buildNodeBundle(f.projectDir, destination), { code: 'EEXIST' }); assert.deepEqual(await fs.readFile(destination), bytes);
  const output = new PassThrough(), chunks = []; output.on('data', chunk => chunks.push(chunk)); const streamed = await buildNodeBundle(f.projectDir, output); assert.equal(streamed.bytes, Buffer.concat(chunks).length); assert.equal(streamed.files, NODE_INSTALLER_FILES.length);
});

test('worker manifest includes every relative runtime import and excludes panel startup, account setup and web assets', async () => {
  const files = new Set(NODE_RUNTIME_FILES), root = new URL('../', import.meta.url);
  for (const relative of files) {
    assert.equal((await fs.stat(new URL(relative, root))).isFile(), true, relative);
    if (!relative.endsWith('.js')) continue;
    const source = await fs.readFile(new URL(relative, root), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\()(['"])(\.[^'"]+)\1/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[2]));
      assert.equal(files.has(dependency), true, `${relative} imports ${dependency}`);
    }
  }
  for (const relative of ['server/index.js', 'server/auth.js', 'server/node-provisioner.js', 'public/index.html', 'public/app.js', 'deploy/install.sh']) assert.equal(files.has(relative), false, relative);
});

test('worker bundle rejects linked source directories and hardlinked manifest files before creating an archive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-worker-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project'); await project(projectDir);
  const destination = path.join(root, 'linked.zip');
  const linked = path.join(root, 'linked-server');
  await fs.rename(path.join(projectDir, 'server'), linked);
  await fs.symlink(linked, path.join(projectDir, 'server'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(buildNodeBundle(projectDir, destination), /source directories/);
  assert.equal(await fs.stat(destination).then(() => true, () => false), false);
  await fs.unlink(path.join(projectDir, 'server')); await fs.rename(linked, path.join(projectDir, 'server'));
  await fs.link(path.join(projectDir, 'package.json'), path.join(root, 'package-link'));
  await assert.rejects(buildNodeBundle(projectDir, destination), /regular files without links/);
  assert.equal(await fs.stat(destination).then(() => true, () => false), false);
});
