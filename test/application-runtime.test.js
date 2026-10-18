import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApplicationRuntime, normalizeApplication, publicApplication, applicationKind, isApplication, applicationRevision, applicationEntrypointAllowed, applicationErrorPayload, redactApplicationOutput, APPLICATION_SIGNAL } from '../server/application-runtime.js';
import { applicationEnvironment } from '../server/application-schema.js';
import { APPLICATION_MOUNT_SETUP } from '../server/application-runtime.js';
import { fixtureRuntimePin } from './application-managed-fixture.js';

const SID = '11b238ac-2f4e-41a3-a511-cf382d2de888';
const DATA = '/var/lib/vortex-app-test';
const ROOT = `${DATA}/servers/${SID}`;
const WORK = ROOT + '/run';
const error = code => Object.assign(new Error(code), { code });
const app = (kind = 'nodejs', application = {}) => ({ id: SID, kind, application: normalizeApplication(application, { kind }), status: 'stopped', port: 31000, resourcePolicy: { mode: 'fixed', cpuCores: 0.5, memoryMiB: 512 } });

// An ownership/process model exercises fail-closed control flow on every test
// platform. It does not claim Linux namespaces or cgroups ran on Windows.
class LinuxModel {
  constructor({ prefix = '/usr', probeFail = false, spawnMode = 'success' } = {}) {
    this.nodes = new Map(); this.ino = 20; this.calls = []; this.changes = []; this.users = new Map(); this.groups = new Map(); this.handles = []; this.prefix = prefix; this.probeFail = probeFail; this.spawnMode = spawnMode;
    this.add('/', 'dir');
    for (const dir of [DATA, ROOT, '/proc', '/usr/bin', '/usr/sbin', '/usr/lib64', '/etc/ssl/certs', `${prefix}/bin`, `${prefix}/lib/node_modules/npm/bin`]) this.add(dir, 'dir');
    this.nodes.get(DATA).mode = 0o40700;
    for (const file of ['/usr/bin/unshare', '/usr/bin/setpriv', '/usr/bin/bwrap', '/usr/bin/python3', '/usr/bin/getent', '/usr/sbin/useradd', '/usr/sbin/userdel', '/usr/sbin/groupdel', `${prefix}/bin/node`]) this.add(file, 'file', '', 0o100755);
    this.add(`${prefix}/lib/node_modules/npm/bin/npm-cli.js`, 'file', 'npm');
    for (const file of ['resolv.conf', 'hosts', 'nsswitch.conf', 'passwd', 'group']) this.add('/etc/' + file, 'file', 'safe');
    this.fs = Object.fromEntries(['lstat', 'realpath', 'mkdir', 'mkdtemp', 'chmod', 'chown', 'lchown', 'readdir', 'readFile', 'writeFile', 'rename', 'unlink', 'rm'].map(name => [name, this[name].bind(this)]));
    this.resourceController = { initialize: async () => {}, capabilities: async () => ({ pidsSupported: true }), prepare: async (id, policy, options) => this.handle(id, policy, options) };
  }
  add(name, type = 'file', content = '', mode = type === 'dir' ? 0o40755 : 0o100600) {
    if (name !== '/' && !this.nodes.has(path.posix.dirname(name))) this.add(path.posix.dirname(name), 'dir');
    this.nodes.set(name, { type, content, mode, uid: 0, gid: 0, nlink: 1, ino: ++this.ino, dev: 4 }); return this.nodes.get(name);
  }
  get(name) { const value = this.nodes.get(name); if (!value) throw error('ENOENT'); return value; }
  async lstat(name) { const v = this.get(name); return { size: Buffer.byteLength(v.content), ...v, isDirectory: () => v.type === 'dir', isFile: () => v.type === 'file', isSymbolicLink: () => v.type === 'link' }; }
  async realpath(name) { const v = this.get(name); return v.type === 'link' ? v.content : name; }
  async mkdir(name, options = {}) { if (this.nodes.has(name)) throw error('EEXIST'); this.get(path.posix.dirname(name)); this.add(name, 'dir', '', 0o40000 | (options.mode ?? 0o755)); }
  async mkdtemp(prefix) { const name = prefix + 'owned' + this.ino; await this.mkdir(name, { mode: 0o700 }); return name; }
  async chmod(name, mode) { this.get(name).mode = (this.get(name).mode & ~0o777) | mode; }
  async chown(name, uid, gid) { const v = this.get(name); if (v.type === 'link') throw new Error('followed symlink'); v.uid = uid; v.gid = gid; this.changes.push(name); }
  async lchown(name, uid, gid) { Object.assign(this.get(name), { uid, gid }); this.changes.push(name); }
  async readdir(name) { this.get(name); return [...this.nodes.keys()].filter(v => v !== name && path.posix.dirname(v) === name).map(v => path.posix.basename(v)); }
  async readFile(name) { return this.get(name).content; }
  async writeFile(name, content, options = {}) { if (options.flag === 'wx' && this.nodes.has(name)) throw error('EEXIST'); this.get(path.posix.dirname(name)); this.add(name, 'file', String(content), 0o100000 | (options.mode ?? 0o600)); }
  async rename(source, target) { const value = this.get(source); this.nodes.delete(source); this.nodes.set(target, value); }
  async unlink(name) { this.get(name); this.nodes.delete(name); }
  async rm(name, options = {}) { if (!this.nodes.has(name)) { if (options.force) return; throw error('ENOENT'); } for (const item of [...this.nodes.keys()]) if (item === name || options.recursive && item.startsWith(name + '/')) this.nodes.delete(item); }
  async exec(executable, args, options) {
    this.calls.push({ executable, args, options });
    const tool = path.posix.basename(executable);
    if (tool === 'getent') {
      if (args[1] === 'nobody') return { stdout: 'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n' };
      if (args[1] === 'systemd-resolve') return { stdout: 'systemd-resolve:x:991:991:systemd Resolver:/:/usr/sbin/nologin\n' };
      const value = (args[0] === 'passwd' ? this.users : this.groups).get(args[1]); if (!value) throw error(2); return { stdout: value + '\n' };
    }
    if (tool === 'useradd') { const name = args.at(-1), comment = args[args.indexOf('--comment') + 1]; this.users.set(name, `${name}:x:60001:60001:${comment}:/nonexistent:/usr/sbin/nologin`); this.groups.set(name, `${name}:x:60001:`); return { stdout: '' }; }
    if (tool === 'userdel') { this.users.delete(args[0]); return { stdout: '' }; }
    if (tool === 'groupdel') { this.groups.delete(args[0]); return { stdout: '' }; }
    if (tool === 'node' && args[0] === '--version') return { stdout: 'v22.23.3\n' };
    if (tool === 'python3') return { stdout: args.includes(APPLICATION_SIGNAL) ? JSON.stringify(this.signalResult || { sent: true, signal: 'SIGTERM', pid: 222 }) : args[0] === '--version' ? 'Python 3.12.3\n' : '' };
    if (tool === 'unshare') {
      if (this.probeFail) throw error('EPERM');
      Object.assign(this.add(options.cwd + '/probe', 'file', 'owned'), { uid: 65534, gid: 65534 }, this.probeFile);
      return { stdout: JSON.stringify({ uid: 65534, gid: 65534, groups: '', cwd: '/workspace', map: '65534 65534 1', gidMap: '65534 65534 1', caps: '0000000000000000', capabilities: Object.fromEntries(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(name => [name, '0000000000000000'])), noNewPrivs: 1, outside: false, ...this.probeResult }) };
    }
    throw new Error('Unexpected modeled command');
  }
  handle(id, policy, options) {
    const handle = { id, policy, options, cleaned: false, effective: { cgroupPath: '/cg/owned' }, cleanup: async () => { handle.cleaned = true; if (handle.child && !handle.child.closed) throw new Error('cleanup before close'); }, spawnWithArgs: (executable, args, spawnOptions, execution) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.closed = false; child.signals = [];
      const finish = code => { if (child.closed) return; child.closed = true; child.stdout.end(); child.stderr.end(); child.emit('close', code, null); };
      child.kill = signal => { child.signals.push(signal); queueMicrotask(() => finish(1)); return true; };
      handle.child = child; handle.plan = { executable, args, options: spawnOptions, execution };
      queueMicrotask(() => {
        if (this.spawnMode === 'stall') return;
        if (args.includes('venv')) { this.add(WORK + '/.venv', 'dir'); this.add(WORK + '/.venv/pyvenv.cfg', 'file', 'venv'); }
        if (this.spawnMode === 'fragmented') { child.stdout.write('token=super'); child.stdout.write('secret\n'); }
        if (this.outputLine) child.stdout.write(this.outputLine + '\n');
        if (args.includes('/usr/bin/awk') && this.awkOutput !== undefined) child.stdout.write(this.awkOutput + '\n');
        finish(this.spawnMode === 'failure' ? 1 : 0);
      });
      return { child, ready: Promise.resolve() };
    } }; this.handles.push(handle); return handle;
  }
  runtime(extra = {}) { return createApplicationRuntime({ dataDir: DATA, fs: this.fs, execFile: this.exec.bind(this), platform: 'linux', uid: 0, nodePath: this.prefix + '/bin/node', resourceController: this.resourceController, ...extra }); }
}

test('application schema preserves legacy Bedrock and constrains literal startup paths/argv', () => {
  assert.equal(applicationKind({}), 'bedrock'); assert.equal(isApplication({ kind: 'python' }), true);
  assert.equal(normalizeApplication(undefined, { kind: 'bedrock' }), null);
  const value = normalizeApplication({ args: ['$(literal); --flag', 'two words'], readiness: 'process' }, { kind: 'nodejs' });
  assert.equal(value.entrypoint, 'server.js'); assert.equal(value.readiness, 'process'); assert.equal(value.args[0], '$(literal); --flag');
  for (const filename of ['../x.js', '/x.js', 'a//x.js', '.hidden/x.js', 'node_modules/x.js', 'x.py', 'a\\x.js']) assert.equal(applicationEntrypointAllowed(filename, 'nodejs'), false);
  assert.throws(() => normalizeApplication({ args: ['line\nnext'] }, { kind: 'python' }), { code: 'APPLICATION_ARGUMENTS' });
  assert.throws(() => normalizeApplication({ readiness: 'shell' }, { kind: 'nodejs' }), { code: 'APPLICATION_INPUT' });
});

function managedModel(model, kind = 'nodejs') {
  const pin = fixtureRuntimePin(kind), prefix = `${DATA}/.application-runtimes/${kind}-${pin.version}/prefix`, pythonVersion = pin.version.split('.').slice(0, 2).join('.');
  const selected = kind === 'nodejs' ? { prefix, executable: '/runtime/node/bin/node', hostExecutable: `${prefix}/bin/node`, nodeDirectory: '/runtime/node/bin', npm: '/runtime/node/lib/node_modules/npm/bin/npm-cli.js' } : { prefix, executable: `/runtime/python/bin/python${pythonVersion}`, hostExecutable: `${prefix}/bin/python${pythonVersion}` };
  model.add(prefix, 'dir'); model.add(selected.hostExecutable, 'file', 'immutable managed executable', 0o100755);
  const store = { prerequisites: async () => ({ ready: true, missing: [] }), installed: async () => selected, ensure: async () => selected, close: async () => {} };
  const runtime = model.runtime({ managedStore: store, catalog: { resolve: async () => pin, snapshot: () => [] } });
  return { runtime, store, pin, selected };
}
function addAwkAlias(model) { model.add('/etc/alternatives', 'dir'); model.add('/usr/bin/mawk', 'file', 'trusted awk', 0o100755); model.add('/usr/bin/awk', 'link', '/usr/bin/mawk'); model.add('/etc/alternatives/awk', 'link', '/usr/bin/mawk'); }
test('Ubuntu core alternatives are exposed only as verified file aliases for every start and installer plan', async () => {
  const model = new LinuxModel(); addAwkAlias(model); const runtime = model.runtime(), server = app();
  await runtime.prepareWorkspace(server, { seed: true }); const first = await runtime.launchPlan(server);
  const setup = plan => JSON.parse(plan.args[plan.args.indexOf(APPLICATION_MOUNT_SETUP) + 1]);
  const selected = setup(first).coreAliases; assert.deepEqual(selected, [{ name: 'awk', source: '/usr/bin/mawk', target: '/mnt/core-awk', ino: model.get('/usr/bin/mawk').ino, dev: 4 }]);
  assert.ok(first.args.some((value, index) => value === '--ro-bind' && first.args[index + 1] === '/mnt/core-awk' && first.args[index + 2] === '/etc/alternatives/awk'));
  assert.equal(first.args.some((value, index) => value === '--ro-bind' && first.args[index + 1] === '/etc/alternatives'), false); assert.equal(selected.some(row => row.name === 'c++'), false);
  model.add('/usr/bin/mawk', 'file', 'replacement trusted executable', 0o100755);
  const second = await runtime.launchPlan(server); assert.notEqual(setup(second).coreAliases[0].ino, selected[0].ino);
  server.application.dependencies = 'auto'; await runtime.installDependencies(server); assert.deepEqual(setup(model.handles.at(-1).plan).coreAliases, setup(second).coreAliases); await runtime.close();
});
test('changed or unsafe alternative endpoints never enter a later application or dependency sandbox', async () => {
  for (const defect of ['outside-usr', 'owner', 'writable', 'hardlink', 'not-executable', 'linked-ancestor', 'alias-owner', 'missing-target']) {
    const model = new LinuxModel(); addAwkAlias(model); const runtime = model.runtime(), server = app(); await runtime.prepareWorkspace(server, { seed: true });
    if (defect === 'outside-usr') { model.add('/root/foreign', 'file', 'outside', 0o100755); model.get('/etc/alternatives/awk').content = '/root/foreign'; }
    if (defect === 'owner') model.get('/usr/bin/mawk').uid = 60001;
    if (defect === 'writable') model.get('/usr/bin/mawk').mode |= 0o020;
    if (defect === 'hardlink') model.get('/usr/bin/mawk').nlink = 2;
    if (defect === 'not-executable') model.get('/usr/bin/mawk').mode = 0o100644;
    if (defect === 'linked-ancestor') model.get('/etc/alternatives').type = 'link';
    if (defect === 'alias-owner') model.get('/etc/alternatives/awk').uid = 60001;
    if (defect === 'missing-target') model.nodes.delete('/usr/bin/mawk');
    await assert.rejects(runtime.launchPlan(server), undefined, defect); assert.equal(model.handles.length, 0, defect); await runtime.close();
  }
});
test('the actual Python builder validates awk inside the nonroot sandbox before configure under its existing resource limits', async () => {
  for (const mode of ['ready', 'wrong-output', 'missing-output']) {
    const model = new LinuxModel(); addAwkAlias(model); const { runtime, store, pin, selected } = managedModel(model, 'python'), server = { ...app('python', { environment: [{ name: 'AWK', value: 'untrusted-user-value' }] }), runtime: pin };
    await runtime.prepareWorkspace(server, { seed: true }); const workspace = WORK + '/official-source'; model.add(workspace, 'dir'); model.add(workspace + '/configure', 'file', 'not executed outside model');
    for (const filename of ['/usr/bin/nice', '/usr/bin/make', '/usr/bin/gcc', '/bin/sh']) model.add(filename, 'file', 'trusted build tool', 0o100755);
    if (mode !== 'missing-output') model.awkOutput = mode === 'ready' ? 'VORTEX_AWK_READY' : 'unconfirmed marker';
    store.ensure = async (_pin, options) => { await options.build({ workspace, onOutput() {}, signal: new AbortController().signal }); return selected; };
    if (mode === 'ready') { const installed = await runtime.ensureRuntime(server); assert.equal(installed.version, pin.version); assert.equal(model.handles.length, 4); assert.ok(model.handles[1].plan.args.includes('./configure')); assert.ok(model.handles[3].plan.args.includes('altinstall')); }
    else { await assert.rejects(runtime.ensureRuntime(server), { code: 'APPLICATION_RUNTIME_BUILD' }); assert.equal(model.handles.length, 1); }
    const smoke = model.handles[0]; assert.ok(smoke.plan.args.includes('/usr/bin/awk')); assert.ok(smoke.plan.args.includes('BEGIN { if (2 + 2 != 4) exit 1; print "VORTEX_AWK_READY" }')); assert.ok(smoke.plan.args.includes('--reuid=60001')); assert.deepEqual(smoke.policy, { mode: 'fixed', cpuCores: 0.5, memoryMiB: 1024 }); assert.equal(smoke.plan.options.env.AWK, undefined); assert.equal(smoke.cleaned, true);
    const aliases = JSON.parse(smoke.plan.args[smoke.plan.args.indexOf(APPLICATION_MOUNT_SETUP) + 1]).coreAliases; assert.equal(aliases[0].source, '/usr/bin/mawk'); await runtime.close();
  }
});
test('managed exact Node pin uses a private root alias and fails closed rather than using host Node when missing', async () => {
  const model = new LinuxModel(), { runtime, store, pin, selected } = managedModel(model), server = { ...app(), runtime: pin };
  await runtime.prepareWorkspace(server, { seed: true }); const plan = await runtime.launchPlan(server);
  assert.equal(plan.runtime.version, pin.version); assert.equal(plan.runtime.mode, 'managed'); assert.equal(plan.args.at(-2), selected.executable);
  assert.ok(plan.args.includes('/mnt/runtime-node')); assert.equal(plan.args.includes(selected.prefix), false);
  const mounts = JSON.parse(plan.args[plan.args.indexOf(APPLICATION_MOUNT_SETUP) + 1]).runtimeMounts; assert.equal(mounts[0].source, selected.prefix); assert.equal(mounts[0].target, '/mnt/runtime-node');
  assert.equal((await runtime.runtimeAvailability(server)).available, true);
  store.installed = async () => null;
  await assert.rejects(runtime.launchPlan(server), { code: 'APPLICATION_RUNTIME_PIN' }); assert.equal((await runtime.runtimeAvailability(server)).available, false);
  assert.equal(model.handles.length, 0); await runtime.close();
});
test('managed Python uses its own exact interpreter and venv even when the legacy host venv is unavailable', async () => {
  const model = new LinuxModel(), ordinaryExec = model.exec.bind(model); model.exec = async (file, args, options) => { if (file === '/usr/bin/python3' && args.join(' ') === '-m venv --help') throw error('ENOENT'); return ordinaryExec(file, args, options); };
  const { runtime, pin, selected } = managedModel(model, 'python'), server = { ...app('python', { startup: { mode: 'python-module', module: 'http.server' }, args: ['31000'] }), runtime: pin };
  assert.equal((await runtime.initialize()).runtimes.python.available, false); await runtime.prepareWorkspace(server, { seed: true });
  await runtime.installDependencies(server); assert.ok(model.handles[0].plan.args.includes(selected.executable));
  const plan = await runtime.launchPlan(server); assert.equal(plan.runtime.version, 'Python ' + pin.version); assert.deepEqual(plan.args.slice(-5), ['/workspace/.venv/bin/python', '-u', '-m', 'http.server', '31000']); assert.ok(plan.args.includes('/mnt/runtime-python'));
  assert.equal((await runtime.runtimeAvailability(server)).available, true); await runtime.close();
});
test('npm script startup is literal, declared in the project manifest and round-trips through public settings', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app('nodejs', { startup: { mode: 'npm-script', script: 'serve:prod' }, args: ['one argument', '--inspect'] });
  await runtime.prepareWorkspace(server, { seed: true }); model.get(WORK + '/package.json').content = JSON.stringify({ scripts: { 'serve:prod': 'node server.js' } });
  model.fs.open = async filename => ({ stat: () => model.lstat(filename), read: async buffer => { const text = Buffer.from(model.get(filename).content); text.copy(buffer); return { bytesRead: text.length }; }, close: async () => {} });
  const plan = await runtime.launchPlan(server); assert.deepEqual(plan.args.slice(-7), ['/usr/bin/node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'run', 'serve:prod', '--', 'one argument', '--inspect']); assert.deepEqual(publicApplication(server.application).startup, { mode: 'npm-script', script: 'serve:prod' });
  server.application.startup.script = 'missing'; await assert.rejects(runtime.launchPlan(server), { code: 'APPLICATION_STARTUP_SCRIPT' });
  for (const startup of [{ mode: 'npm-script', script: '--eval' }, { mode: 'npm-script', script: 'start;id' }, { mode: 'python-module', module: 'a.b' }]) assert.throws(() => normalizeApplication({ startup }, { kind: 'nodejs' }), { code: 'APPLICATION_INPUT' });
  for (const module of ['../outside', '-c', 'a;id', 'a..b', 'a'.repeat(201)]) assert.throws(() => normalizeApplication({ startup: { mode: 'python-module', module } }, { kind: 'python' }), { code: 'APPLICATION_INPUT' });
});
test('project inspection refuses live owned UIDs and private build ledgers block fresh allocations after restart', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app(); await runtime.prepareWorkspace(server, { seed: true });
  const read = model.readFile.bind(model); model.add('/proc/777/status', 'file', 'Uid:\t60001\t60001\t60001\t60001\n'); let manifestReads = 0; model.fs.readFile = async filename => { if (filename.startsWith(WORK)) manifestReads++; return read(filename); };
  await assert.rejects(runtime.inspectProject(server), { code: 'APPLICATION_BUSY' }); assert.equal(manifestReads, 0);
  model.nodes.delete('/proc/777/status'); model.nodes.delete('/proc/777');
  const volume = '11b238ac-2f4e-41a3-a511-cf382d2de889'; model.add(`${DATA}/.application-users/.build-${volume}.json`, 'file', JSON.stringify({ schema: 1, id: volume, serverId: SID, purpose: 'python-runtime-build', createdAt: '2026-10-18T00:00:00.000Z' }));
  await assert.rejects(runtime.assertNoPendingBuilds(), error => error.code === 'APPLICATION_RUNTIME_CLEANUP' && error.cleanupPending[0].volumeId === volume);
  const catalog = await runtime.runtimeCatalog(); assert.equal(catalog.runtimes.nodejs.managedAvailable, false); assert.equal(catalog.cleanupPending.length, 1); await runtime.close();
});
test('unsupported application isolation leaves absent private receipts untouched but still exposes and blocks existing orphan builds', async () => {
  const model = new LinuxModel(), privateRoot = `${DATA}/.application-users`;
  const runtime = model.runtime({ resourceController: { capabilities: async () => ({ pidsSupported: false }) } });
  assert.equal((await runtime.initialize()).supported, false);
  const before = [...model.nodes.keys()];
  await runtime.assertNoPendingBuilds(); const empty = await runtime.runtimeCatalog();
  assert.deepEqual([...model.nodes.keys()], before); assert.equal(model.nodes.has(privateRoot), false); assert.deepEqual(empty.cleanupPending, []); assert.equal(model.calls.length, 0);
  const volume = '11b238ac-2f4e-41a3-a511-cf382d2de889'; model.add(privateRoot, 'dir', '', 0o40700);
  model.add(`${privateRoot}/.build-${volume}.json`, 'file', JSON.stringify({ schema: 1, id: volume, serverId: SID, purpose: 'python-runtime-build', createdAt: '2026-10-18T00:00:00.000Z' }));
  await assert.rejects(runtime.assertNoPendingBuilds(), error => error.code === 'APPLICATION_RUNTIME_CLEANUP' && error.cleanupPending[0].volumeId === volume);
  const pending = await runtime.runtimeCatalog(); assert.equal(pending.supported, false); assert.equal(pending.cleanupPending[0].volumeId, volume); assert.equal(model.calls.length, 0); await runtime.close();
});
test('unsupported isolation never treats unsafe private roots or unreadable or malformed build receipts as absent', async () => {
  const privateRoot = `${DATA}/.application-users`, volume = '11b238ac-2f4e-41a3-a511-cf382d2de889';
  for (const defect of ['symlink', 'owner', 'writable', 'public-mode', 'file', 'ancestor', 'permission', 'io-error', 'malformed', 'ledger-owner', 'ledger-link']) {
    const model = new LinuxModel(), runtime = model.runtime({ resourceController: { capabilities: async () => ({ pidsSupported: false }) } });
    model.add(privateRoot, 'dir', '', 0o40700);
    if (defect === 'symlink') model.add(privateRoot, 'link', '/root/foreign');
    if (defect === 'owner') model.get(privateRoot).uid = 60001;
    if (defect === 'writable') model.get(privateRoot).mode = 0o40722;
    if (defect === 'public-mode') model.get(privateRoot).mode = 0o40755;
    if (defect === 'file') model.add(privateRoot, 'file');
    if (defect === 'ancestor') model.get(DATA).mode = 0o40777;
    if (['permission', 'io-error'].includes(defect)) { const lstat = model.fs.lstat; model.fs.lstat = async name => { if (name === privateRoot) throw error(defect === 'permission' ? 'EACCES' : 'EIO'); return lstat(name); }; }
    if (defect.startsWith('ledger') || defect === 'malformed') { const ledger = `${privateRoot}/.build-${volume}.json`; model.add(ledger, 'file', 'invalid JSON'); if (defect === 'ledger-owner') model.get(ledger).uid = 60001; if (defect === 'ledger-link') model.add(ledger, 'link', '/root/foreign'); }
    await assert.rejects(runtime.assertNoPendingBuilds(), undefined, defect);
    const status = await runtime.runtimeCatalog(); assert.equal(status.supported, false); assert.equal(status.cleanupPending.length, 1, defect); assert.equal(status.cleanupPending[0].reasonCode, 'APPLICATION_RUNTIME_CLEANUP', defect); assert.equal(model.calls.length, 0); await runtime.close();
  }
});
test('dependency metadata compares manifest fingerprints and isolated installers exclude user compiler variables', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app('nodejs', { environment: ['CC', 'CFLAGS', 'MAKEFLAGS'].map(name => ({ name, value: 'user-supplied-not-for-builds' })) }); await runtime.prepareWorkspace(server, { seed: true });
  model.fs.open = async filename => ({ stat: () => model.lstat(filename), read: async buffer => { const text = Buffer.from(model.get(filename).content); text.copy(buffer); return { bytesRead: text.length }; }, close: async () => {} });
  const result = await runtime.installDependencies(server); assert.match(result.manifestFingerprint, /^[a-f0-9]{64}$/); server.dependencyState = { status: 'installed', installedAt: '2026-10-18T00:00:00.000Z', manifestFingerprint: result.manifestFingerprint };
  for (const name of ['CC', 'CFLAGS', 'MAKEFLAGS']) assert.equal(model.handles[0].plan.options.env[name], undefined);
  const current = await runtime.inspectProject(server); assert.equal(current.dependencyState.status, 'installed'); assert.equal(current.dependencyState.manifestChanged, false);
  model.get(WORK + '/package.json').content = JSON.stringify({ dependencies: { 'new-package': '1.2.3' } });
  const stale = await runtime.inspectProject(server); assert.equal(stale.dependencyState.status, 'outdated'); assert.equal(stale.dependencyState.manifestChanged, true); assert.equal(stale.manifests[0].dependencies, 1);
});

test('secret updates retain only the same secret key and public snapshots never contain saved values', () => {
  const previous = normalizeApplication({ environment: [{ name: 'TOKEN', value: 'supersecret', secret: true }, { name: 'LABEL', value: 'public' }] }, { kind: 'nodejs' });
  const updated = normalizeApplication({ environment: [{ name: 'TOKEN', secret: true }] }, { kind: 'nodejs', previous });
  assert.equal(updated.environment[0].value, 'supersecret'); assert.equal(publicApplication(updated).environment[0].value, null); assert.equal(publicApplication(updated).environment[0].hasValue, true);
  assert.ok(!JSON.stringify(publicApplication(updated)).includes('supersecret'));
  for (const row of [{ name: 'RENAMED', secret: true }, { name: 'TOKEN', secret: false }]) assert.throws(() => normalizeApplication({ environment: [row] }, { kind: 'nodejs', previous }), { code: 'APPLICATION_SECRET_MISSING' });
  assert.notEqual(applicationRevision(previous), applicationRevision(updated));
});

test('environment allowlist rejects injection/reserved fields, duplicate names and aggregate byte overflow', () => {
  for (const name of ['PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD', 'VORTEX_TOKEN', 'lower', 'A\nB']) assert.throws(() => normalizeApplication({ environment: [{ name, value: 'x' }] }, { kind: 'nodejs' }), { code: 'APPLICATION_ENVIRONMENT' });
  assert.throws(() => normalizeApplication({ environment: [{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }] }, { kind: 'nodejs' }), { code: 'APPLICATION_ENVIRONMENT' });
  assert.throws(() => normalizeApplication({ environment: Array.from({ length: 9 }, (_, n) => ({ name: 'E' + n, value: 'x'.repeat(4096) })) }, { kind: 'nodejs' }), { code: 'APPLICATION_ENVIRONMENT' });
  const value = normalizeApplication({ environment: [{ name: 'TOKEN', value: 'secret', secret: true }] }, { kind: 'nodejs' });
  process.env.VORTEX_APPLICATION_TEST_SENTINEL = 'panel-secret';
  try { const live = applicationEnvironment(value, { port: 31000, username: 'vxapp_test' }); const install = applicationEnvironment(value, { port: 31000, username: 'vxapp_test', install: true }); assert.equal(live.TOKEN, 'secret'); assert.equal(live.VORTEX_APPLICATION_TEST_SENTINEL, undefined); assert.equal(install.TOKEN, undefined); assert.equal(install.NODE_ENV, 'development'); } finally { delete process.env.VORTEX_APPLICATION_TEST_SENTINEL; }
  assert.equal(redactApplicationOutput('secret/public', value), '[redacted]/public');
  assert.equal(redactApplicationOutput('partial sec … [truncated]', value), '[redacted truncated application output]');
  assert.equal(applicationErrorPayload({ code: ['APPLICATION_INPUT'] }), null); assert.equal(applicationErrorPayload({ code: { toString: null } }), null); assert.match(applicationErrorPayload({ code: 'APPLICATION_INPUT' }, 'vi').error, /không hợp lệ/);
});

test('native capability fails closed without Linux/root/PIDs or a successful non-root private-cwd probe', async () => {
  for (const settings of [{ platform: 'win32' }, { uid: 1000 }, { resourceController: { capabilities: () => ({ pidsSupported: false }) } }]) {
    const model = new LinuxModel(), runtime = model.runtime(settings);
    const before = runtime.capabilities(), after = await runtime.initialize();
    for (const value of [before, after]) { assert.equal(value.supported, false); assert.equal(value.reasonI18n.id, 'panel.application.application_unsupported'); assert.equal(value.reason, value.reasonI18n.en); assert.match(value.reasonI18n.vi, /Cách ly ứng dụng/); }
    assert.equal(model.calls.some(v => v.executable.endsWith('/useradd')), false);
  }
  const model = new LinuxModel({ probeFail: true }), diagnostics = [], runtime = model.runtime({ onDiagnostic: item => diagnostics.push(item) }); assert.equal((await runtime.initialize()).supported, false); assert.equal([...model.nodes.keys()].some(v => v.includes('/.probe-')), false); assert.deepEqual(diagnostics, [{ phase: 'nonroot-sandbox-probe', code: 'EPERM' }]);
  await assert.rejects(runtime.prepareWorkspace(app()), { code: 'APPLICATION_UNSUPPORTED' });
});

test('nested zero-parent UID/GID maps require the fresh host inode to prove the original unprivileged identity', async () => {
  for (const outside of [0, 65534]) {
    const model = new LinuxModel(); model.probeResult = { map: `65534 ${outside} 1\n`, gidMap: `65534 ${outside} 1\n` }; assert.equal((await model.runtime().initialize()).supported, true);
  }
  for (const change of [
    { file: { uid: 0 } }, { file: { gid: 0 } }, { file: { uid: 60000 } }, { file: { nlink: 2 } }, { file: { type: 'link' } }, { file: { content: 'foreign' } },
    { result: { map: '65534 60000 1' } }, { result: { gidMap: '65534 60000 1' } }, { result: { map: '65534 0 2' } }, { result: { gidMap: '65534 0 1\n60000 1 1' } }, { result: { map: '0 0 1' } },
    { result: { noNewPrivs: 0 } }, { result: { groups: '65534' } }, { result: { groups: undefined } }, { result: { capabilities: { CapInh: '0', CapPrm: '0', CapEff: '0', CapBnd: '1', CapAmb: '0' } } },
  ]) {
    const model = new LinuxModel(); model.probeFile = change.file; model.probeResult = { map: '65534 0 1', gidMap: '65534 0 1', ...change.result };
    assert.equal((await model.runtime().initialize()).supported, false, JSON.stringify(change));
    assert.equal(model.calls.some(value => value.executable.endsWith('/useradd')), false);
  }
});

test('the actual fixed Node probe parses kernel groups/capabilities without treating effective GID as a supplementary group', async () => {
  const model = new LinuxModel(); assert.equal((await model.runtime().initialize()).supported, true);
  const invocation = model.calls.find(value => value.executable === '/usr/bin/unshare'), source = invocation.args.at(-1), writes = [];
  let output;
  const status = 'Groups:\t\nNStgid:\t1\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n';
  const files = { '/proc/self/status': status, '/proc/self/uid_map': '65534 0 1\n', '/proc/self/gid_map': '65534 0 1\n' };
  vm.runInNewContext(source, { require: () => ({ readFileSync: name => files[name], readdirSync: () => { throw error('EACCES'); }, writeFileSync: (...args) => writes.push(args) }), process: { getuid: () => 65534, getgid: () => 65534, getgroups: () => [65534], cwd: () => '/workspace' }, console: { log: value => { output = JSON.parse(value); } } });
  assert.equal(output.groups, ''); assert.equal(output.noNewPrivs, 1); assert.equal(output.gidMap, '65534 0 1\n');
  assert.equal(Object.values(output.capabilities).every(value => value === '0000000000000000'), true);
  assert.equal(writes[0][0], '/workspace/probe'); assert.equal(writes[0][2].flag, 'wx'); assert.equal(writes[0][2].mode, 0o600);
});

test('workspace ownership is limited to run and launch drops privilege before the required sandbox', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app('nodejs', { environment: [{ name: 'TOKEN', value: 'supersecret', secret: true }] });
  model.add(ROOT + '/identity.json', 'file', 'private'); model.add(ROOT + '/backups', 'dir');
  const capabilities = await runtime.initialize(); assert.equal(capabilities.supported, true); assert.equal(capabilities.reason, null); assert.equal(capabilities.reasonI18n, null); const prepared = await runtime.prepareWorkspace(server, { seed: true });
  assert.equal(prepared.uid, 60001); assert.equal(model.get(ROOT).uid, 0); assert.equal(model.get(ROOT + '/identity.json').uid, 0); assert.equal(model.get(ROOT + '/backups').uid, 0);
  assert.ok(model.changes.filter(v => !v.includes('/.probe-')).every(v => v === WORK || v.startsWith(WORK + '/')));
  const plan = await runtime.launchPlan(server); assert.equal(plan.executable, '/usr/bin/unshare'); assert.deepEqual(plan.args.slice(0, 7), ['--mount', '--propagation', 'private', '--', '/usr/bin/python3', '-I', '-c']); assert.equal(plan.args.includes('--fork'), false); assert.ok(plan.args.indexOf('--reuid=60001') < plan.args.indexOf('/usr/bin/bwrap'));
  for (const required of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--no-new-privs', '--die-with-parent']) assert.ok(plan.args.includes(required));
  assert.equal(plan.options.env.TOKEN, undefined); assert.equal(JSON.parse(plan.stdinPrelude).TOKEN, 'supersecret'); assert.equal(plan.args.join(' ').includes('supersecret'), false); assert.deepEqual(plan.execution, { cleanEnvironment: true }); assert.equal(plan.options.shell, false); assert.equal(plan.runtime.networkIsolated, false);
  assert.ok(plan.args.includes('-I')); assert.ok(plan.args.indexOf('/usr/bin/bwrap') < plan.args.lastIndexOf('/usr/bin/python3')); assert.equal(plan.stdinPrelude.split('\n').length, 2);
  assert.equal(plan.args.at(-1), '/workspace/server.js');
  const escaped = { ...server, application: normalizeApplication({ environment: Array.from({ length: 8 }, (_, i) => ({ name: 'E' + i, value: '\\'.repeat(4094), secret: true })) }, { kind: 'nodejs' }) };
  const largePlan = await runtime.launchPlan(escaped); assert.ok(Buffer.byteLength(largePlan.stdinPrelude) > 65536); assert.ok(Buffer.byteLength(largePlan.stdinPrelude) < 96 * 1024);
});

test('Ubuntu DNS stub trusts only the exact read-only systemd-resolve service-owned configuration', async () => {
  const prepare = () => {
    const model = new LinuxModel(); model.add('/run/systemd/resolve', 'dir'); Object.assign(model.get('/run/systemd/resolve'), { uid: 991, gid: 991 });
    model.add('/run/systemd/resolve/stub-resolv.conf', 'file', 'nameserver 127.0.0.53\n', 0o100644); Object.assign(model.get('/run/systemd/resolve/stub-resolv.conf'), { uid: 991, gid: 991 }); model.add('/etc/resolv.conf', 'link', '/run/systemd/resolve/stub-resolv.conf', 0o120777); return model;
  };
  const valid = prepare(); assert.equal((await valid.runtime().initialize()).supported, true);
  for (const mutate of [m => { m.get('/run/systemd/resolve').uid = 990; }, m => { m.get('/run/systemd/resolve/stub-resolv.conf').uid = 990; }, m => { m.get('/run/systemd/resolve').mode |= 0o002; }, m => { m.get('/run/systemd/resolve/stub-resolv.conf').mode |= 0o020; }, m => { m.get('/run/systemd/resolve/stub-resolv.conf').nlink = 2; }, m => { m.get('/run/systemd/resolve/stub-resolv.conf').content = 'x'.repeat(65537); }, m => { m.get('/run/systemd/resolve/stub-resolv.conf').type = 'link'; m.get('/run/systemd/resolve/stub-resolv.conf').content = '/etc/hosts'; }, m => { m.get('/etc/resolv.conf').content = '/run/systemd/resolve/foreign.conf'; m.add('/run/systemd/resolve/foreign.conf', 'file', 'x'); }]) {
    const model = prepare(); mutate(model); const cap = await model.runtime().initialize(); assert.equal(cap.supported, false); assert.equal(cap.diagnosticPhase, 'system-files');
  }
});

test('foreign accounts and unsafe descendants are preserved before any workspace chown', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app(); await runtime.initialize();
  const scope = (await import('node:crypto')).createHash('sha256').update(DATA).digest('hex').slice(0, 8), name = `vxapp_${scope}_${SID.replaceAll('-', '').slice(0, 16)}`;
  model.users.set(name, `${name}:x:60001:60001:foreign:/nonexistent:/usr/sbin/nologin`);
  await assert.rejects(runtime.prepareWorkspace(server), { code: 'APPLICATION_ACCOUNT' }); assert.equal(model.users.get(name).includes('foreign'), true); assert.equal(model.calls.some(v => v.executable.endsWith('/userdel')), false);
  model.users.delete(name); await runtime.prepareWorkspace(server, { seed: true });
  model.add(WORK + '/valid.txt', 'file', 'valid'); model.add(WORK + '/hardlink', 'file', 'foreign').nlink = 2;
  const before = model.changes.length; await assert.rejects(runtime.prepareWorkspace(server), { code: 'APPLICATION_PATH' }); assert.equal(model.changes.length, before); assert.equal(model.get(WORK + '/valid.txt').uid, 0);
});

test('trusted private Node distribution is bound narrowly and its bundled npm uses the same runtime', async () => {
  const prefix = '/opt/vortex-node/tools/node-v22.23.3-linux-x64', model = new LinuxModel({ prefix }), runtime = model.runtime(), server = app();
  assert.equal((await runtime.initialize()).supported, true); await runtime.prepareWorkspace(server, { seed: true });
  const plan = await runtime.launchPlan(server); assert.ok(plan.args.includes('/mnt/runtime-node')); assert.ok(!plan.args.includes('/opt')); assert.equal(plan.args.at(-2), '/runtime/node/bin/node'); assert.equal(JSON.parse(plan.args[plan.args.indexOf(APPLICATION_MOUNT_SETUP) + 1]).runtimeMounts[0].source, prefix);
  await runtime.installDependencies(server); const call = model.handles[0].plan; assert.deepEqual(call.args.slice(-5), ['/runtime/node/bin/node', '/runtime/node/lib/node_modules/npm/bin/npm-cli.js', 'install', '--no-audit', '--no-fund']); assert.equal(model.handles[0].options.tasksMax, 128);
});

test('dependency jobs choose npm ci with a lock and omit custom secrets while redacting split log output', async () => {
  const model = new LinuxModel({ spawnMode: 'fragmented' }), runtime = model.runtime(), server = app('nodejs', { environment: [{ name: 'TOKEN', value: 'supersecret', secret: true }] });
  await runtime.prepareWorkspace(server, { seed: true }); model.add(WORK + '/package-lock.json', 'file', '{}'); const lines = [];
  const result = await runtime.installDependencies(server, { onOutput: line => lines.push(line) }); assert.equal(result.commandsCompleted, 1); assert.deepEqual(lines, ['token=[redacted]']);
  assert.ok(model.handles[0].plan.args.includes('ci')); assert.equal(model.handles[0].plan.options.env.TOKEN, undefined); assert.equal(model.handles[0].cleaned, true);
  assert.equal(model.handles[0].plan.stdinPrelude, undefined);
});

test('Python dependency job creates a final-path venv and startup uses its interpreter without shell activation', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app('python'); await runtime.prepareWorkspace(server, { seed: true });
  const result = await runtime.installDependencies(server); assert.equal(result.commandsCompleted, 2); assert.deepEqual(model.handles[0].plan.args.slice(-4), ['/usr/bin/python3', '-m', 'venv', '/workspace/.venv']);
  assert.ok(model.handles[1].plan.args.includes('/workspace/.venv/bin/python')); const plan = await runtime.launchPlan(server); assert.deepEqual(plan.args.slice(-3), ['/workspace/.venv/bin/python', '-u', '/workspace/app.py']);
});

test('dependency failures/abort kill the owned process and wait for close before resource cleanup', async () => {
  for (const mode of ['failure', 'stall', 'abort']) {
    const model = new LinuxModel({ spawnMode: mode === 'abort' ? 'stall' : mode }), runtime = model.runtime({ installTimeoutMs: mode === 'abort' ? 1000 : 25 }), server = app(); await runtime.prepareWorkspace(server, { seed: true });
    const controller = new AbortController(), installing = runtime.installDependencies(server, { signal: controller.signal });
    if (mode === 'abort') setImmediate(() => controller.abort());
    await assert.rejects(installing, { code: 'APPLICATION_DEPENDENCIES' }); assert.equal(model.handles[0].child.closed, true); assert.equal(model.handles[0].cleaned, true); if (mode !== 'failure') assert.ok(model.handles[0].child.signals.includes('SIGTERM')); await runtime.close();
  }
});

test('live dedicated UID prevents ownership changes and account release only removes the verified identity', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app(); await runtime.prepareWorkspace(server, { seed: true });
  model.add('/proc/77', 'dir'); model.add('/proc/77/status', 'file', 'Uid:\t60001\t60001\t60001\t60001\n');
  await assert.rejects(runtime.prepareWorkspace(server), { code: 'APPLICATION_BUSY' }); await assert.rejects(runtime.releaseWorkspace(server), { code: 'APPLICATION_BUSY' }); assert.equal(model.users.size, 1);
  await model.rm('/proc/77', { recursive: true }); const [name, original] = [...model.users.entries()][0]; model.users.set(name, original.replace('vortex-app,', 'foreign,'));
  await assert.rejects(runtime.releaseWorkspace(server), { code: 'APPLICATION_ACCOUNT' }); assert.equal(model.calls.some(v => v.executable.endsWith('/userdel')), false); model.users.set(name, original);
  const result = await runtime.releaseWorkspace(server); assert.equal(result.removed, true); assert.equal(model.users.size, 0); assert.equal(model.groups.size, 0); assert.equal(model.calls.find(v => v.executable.endsWith('/userdel')).args.length, 1);
  assert.equal((await runtime.releaseWorkspace(server)).alreadyAbsent, true); assert.equal(model.get(WORK + '/server.js').content.includes('http'), true);
});

test('shutdown during a pending workspace check cannot register or spawn a dependency job afterward', async () => {
  const model = new LinuxModel(), runtime = model.runtime(), server = app(); await runtime.prepareWorkspace(server, { seed: true });
  let entered, unblock; const waiting = new Promise(resolve => entered = resolve), gate = new Promise(resolve => unblock = resolve), realRead = model.fs.readdir;
  model.fs.readdir = async filename => { if (filename === '/proc') { entered(); await gate; } return realRead(filename); };
  const installing = runtime.installDependencies(server); const rejected = assert.rejects(installing, { code: 'APPLICATION_CLOSED' }); await waiting; const closing = runtime.close(); unblock(); await closing; await rejected; assert.equal(model.handles.length, 0);
  await assert.rejects(runtime.prepareWorkspace(server), { code: 'APPLICATION_CLOSED' });
});

test('graceful application signaling requires the verified owned cgroup and static UID before invoking the pidfd helper', async () => {
  const model = new LinuxModel(), runtime = model.runtime({ cgroupRoot: '/cg' }), server = app(); await runtime.prepareWorkspace(server, { seed: true });
  const relative = '/system.slice/vortex.service/vortex-managed-pool/vortex-server-' + SID + '-12121212-1212-4121-8121-121212121212'; model.add('/cg' + relative, 'dir');
  let checked = 0; const resourceHandle = { effective: { cgroupPath: relative, kernelEnforced: true, applied: true }, stats: async () => { checked++; } };
  const result = await runtime.signalApplication(server, { resourceHandle, supervisorPid: 111 }); assert.deepEqual(result, { sent: true, signal: 'SIGTERM', pid: 222 }); assert.equal(checked, 1);
  const command = model.calls.find(row => row.args.includes(APPLICATION_SIGNAL)); assert.deepEqual(command.args.slice(0, 2), ['-I', '-c']); const expected = JSON.parse(command.args.at(-1)); assert.equal(expected.uid, 60001); assert.equal(expected.supervisor, 111); assert.equal(expected.relative, relative); assert.equal(expected.npmScript, false); assert.equal(command.options.env.TOKEN, undefined);
  model.signalResult = { sent: false, reason: 'not-running' }; assert.deepEqual(await runtime.signalApplication(server, { resourceHandle, supervisorPid: 111 }), model.signalResult);
  const before = model.calls.length;
  await assert.rejects(runtime.signalApplication(server, { resourceHandle, supervisorPid: 111, signal: 'SIGKILL' }), { code: 'APPLICATION_SIGNAL' });
  await assert.rejects(runtime.signalApplication(server, { resourceHandle: { ...resourceHandle, effective: { ...resourceHandle.effective, cgroupPath: relative.replace(SID, 'foreign') } }, supervisorPid: 111 }), { code: 'APPLICATION_SIGNAL' }); assert.equal(model.calls.length, before + 2, 'Only passwd/group ownership reads occur for a mismatched cgroup; the signal helper does not run');
});

test('npm signaling requests verified application roots and validates bounded full or partial receipts without changing Python signals', async () => {
  const model = new LinuxModel(), runtime = model.runtime({ cgroupRoot: '/cg' }), server = app('nodejs', { startup: { mode: 'npm-script', script: 'start' } }); await runtime.prepareWorkspace(server, { seed: true });
  const relative = '/system.slice/vortex.service/vortex-managed-pool/vortex-server-' + SID + '-12121212-1212-4121-8121-121212121212'; model.add('/cg' + relative, 'dir');
  const resourceHandle = { effective: { cgroupPath: relative, kernelEnforced: true, applied: true }, stats: async () => {} };
  const complete = { sent: true, signal: 'SIGTERM', pid: 444, pids: [444, 666] }; model.signalResult = complete;
  assert.deepEqual(await runtime.signalApplication(server, { resourceHandle, supervisorPid: 111 }), complete);
  assert.equal(JSON.parse(model.calls.find(row => row.args.includes(APPLICATION_SIGNAL)).args.at(-1)).npmScript, true);
  const partial = { sent: true, signal: 'SIGTERM', pid: 444, pids: [444], partial: true, pendingPids: [666] }; model.signalResult = partial;
  assert.deepEqual(await runtime.signalApplication(server, { resourceHandle, supervisorPid: 111 }), partial);
  for (const receipt of [{ ...complete, pids: undefined }, { ...complete, pids: [] }, { ...complete, pids: [444, 444] }, { ...complete, pid: 666 }, { ...complete, pids: [444, 1] }, { ...complete, pids: Array(129).fill(444) }, { ...partial, pendingPids: [444] }, { ...partial, pendingPids: [] }, { ...partial, pendingPids: [666, 666] }, { ...partial, pendingPids: [1] }, { ...partial, pendingPids: undefined }, { ...partial, partial: false }]) {
    model.signalResult = receipt; await assert.rejects(runtime.signalApplication(server, { resourceHandle, supervisorPid: 111 }), { code: 'APPLICATION_SIGNAL' });
  }
  model.signalResult = { ...partial, pids: Array.from({ length: 128 }, (_, index) => 444 + index) }; await assert.rejects(runtime.signalApplication(server, { resourceHandle, supervisorPid: 111 }), { code: 'APPLICATION_SIGNAL' });
  await runtime.close();
  const pythonModel = new LinuxModel(), pythonRuntime = pythonModel.runtime({ cgroupRoot: '/cg' }), pythonServer = app('python', { startup: { mode: 'python-module', module: 'app' } }); await pythonRuntime.prepareWorkspace(pythonServer, { seed: true }); pythonModel.add('/cg' + relative, 'dir');
  assert.deepEqual(await pythonRuntime.signalApplication(pythonServer, { resourceHandle, supervisorPid: 111 }), { sent: true, signal: 'SIGTERM', pid: 222 });
  assert.equal(JSON.parse(pythonModel.calls.find(row => row.args.includes(APPLICATION_SIGNAL)).args.at(-1)).npmScript, false); await pythonRuntime.close();
});
