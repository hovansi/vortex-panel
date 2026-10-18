import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createResourceController, normalizeResourcePolicy, RESOURCE_EXEC_WRAPPER } from '../server/resource-control.js';
import { RESOURCE_CONTROL_MESSAGES } from '../server/resource-control-messages.js';
import { localizeApiResponse, formatPanelMessage } from '../server/locale.js';

const SID = '83a9db63-5ec8-4c80-8de9-8310526ea1a1';
const bounds = { cpuCount: 2, memoryTotalMiB: 4096 };
const policy = { mode: 'fixed', cpuCores: 0.29, memoryMiB: 512 };
const controllerRoot = '/cg/system.slice/vortex-test.service';
const systemError = code => Object.assign(new Error(code), { code });

// This models kernel interfaces for control-flow tests only. It is never used
// as evidence that Windows or an ordinary directory enforces resource limits.
class KernelModel {
  constructor() {
    this.dirs = new Map(); this.files = new Map(); this.writes = []; this.removals = []; this.inode = 10;
    this.type = 0x63677270; this.delegate = 'yes'; this.mainPID = 77; this.foreign = false;
    this.addGroup('/cg'); this.addGroup(controllerRoot);
    this.files.set(controllerRoot + '/cgroup.procs', '77\n');
    this.files.set(controllerRoot + '/cgroup.controllers', 'cpu memory pids\n');
    this.files.set('/proc/self/cgroup', '0::/system.slice/vortex-test.service\n');
    this.fs = Object.fromEntries(['readFile', 'writeFile', 'mkdir', 'rmdir', 'realpath', 'lstat', 'statfs', 'access'].map(name => [name, this[name].bind(this)]));
  }
  addGroup(dir) {
    this.dirs.set(dir, { ino: ++this.inode, dev: 4, isDirectory: () => true, isSymbolicLink: () => false });
    for (const [name, value] of Object.entries({ 'cgroup.procs': '', 'cgroup.controllers': 'cpu memory pids', 'cgroup.subtree_control': '', 'cgroup.events': 'populated 0\nfrozen 0\n', 'cpu.max': 'max 100000', 'cpu.stat': 'usage_usec 0\nnr_throttled 0\nthrottled_usec 0\n', 'memory.max': 'max', 'memory.swap.max': 'max', 'memory.oom.group': '0', 'memory.current': '0', 'memory.peak': '0', 'memory.events': 'oom 0\noom_kill 0\n' })) this.files.set(dir + '/' + name, value);
  }
  async statfs() { return { type: this.type }; }
  async access() { if (this.accessError) throw systemError(this.accessError); }
  async realpath(dir) { if (!this.dirs.has(dir)) throw systemError('ENOENT'); return this.escape === dir ? '/foreign' : dir; }
  async lstat(dir) { if (!this.dirs.has(dir)) throw systemError('ENOENT'); return this.dirs.get(dir); }
  async readFile(file) { if (!this.files.has(file)) throw systemError('ENOENT'); return this.files.get(file); }
  async writeFile(file, value) {
    if (this.writeFailure?.(file)) throw systemError('EACCES');
    this.writes.push([file, value]);
    if (file.endsWith('/cgroup.procs')) {
      const pid = Number(value.trim());
      for (const [key, text] of this.files) if (key.endsWith('/cgroup.procs')) this.files.set(key, text.split(/\s+/).filter(x => x && Number(x) !== pid).join('\n'));
      this.files.set(file, value.trim());
      if (pid === 77) this.files.set('/proc/self/cgroup', '0::' + file.slice('/cg'.length, -'/cgroup.procs'.length) + '\n');
    } else if (file.endsWith('/cgroup.subtree_control')) this.files.set(file, value.trim().replaceAll('+', ''));
    else if (file.endsWith('/cgroup.kill')) this.files.set(file.slice(0, -'cgroup.kill'.length) + 'cgroup.events', 'populated 0\nfrozen 0\n');
    else this.files.set(file, this.ignoreWrite === file ? 'incorrect' : value.trim());
  }
  async mkdir(dir) { if (this.dirs.has(dir)) throw systemError('EEXIST'); this.addGroup(dir); }
  async rmdir(dir) {
    if (this.rmdirError) throw systemError(this.rmdirError);
    if (!this.dirs.has(dir)) throw systemError('ENOENT');
    if (/populated 1/.test(this.files.get(dir + '/cgroup.events') || '')) throw systemError('EBUSY');
    this.removals.push(dir); this.dirs.delete(dir);
    for (const name of this.files.keys()) if (name.startsWith(dir + '/')) this.files.delete(name);
  }
  async execFile(file, args) {
    if (file === 'busctl') return { stdout: args[0] === 'call' ? 'o "/org/freedesktop/systemd1/unit/vortex_2dtest_2eservice"\n' : 's "vortex-test.service"\n' };
    assert.equal(file, 'systemctl');
    return { stdout: `Delegate=${this.delegate}\nDelegateControllers=cpu memory\nControlGroup=/system.slice/vortex-test.service\nMainPID=${this.mainPID}\n` };
  }
  controller(extra = {}) { return createResourceController({ platform: 'linux', pid: 77, mountPath: '/cg', procPath: '/proc', bounds, fs: this.fs, execFile: this.execFile.bind(this), pause: async () => {}, ...extra }); }
}

class FakeChild extends EventEmitter {
  constructor(pid = 901) { super(); this.pid = pid; this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.stdio = [this.stdin, this.stdout, this.stderr, new PassThrough()]; this.exitCode = null; this.signalCode = null; this.kills = []; }
  close(code = 0, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit('close', code, signal); }
  kill(signal) { this.kills.push(signal); queueMicrotask(() => this.close(null, signal)); return true; }
}
async function initialized(extra = {}) { const kernel = new KernelModel(); const ctl = kernel.controller(extra); const caps = await ctl.initialize(); assert.equal(caps.fixedSupported, true); return { kernel, ctl }; }
function scopedDirectory(kernel) { return [...kernel.dirs.keys()].find(name => name.includes('/vortex-server-')); }

test('policies default to shared; fixed accepts exact CPU fractions and MiB bounds without mutating input', () => {
  assert.deepEqual(normalizeResourcePolicy(undefined, bounds), { mode: 'shared', cpuCores: null, memoryMiB: null });
  assert.deepEqual(normalizeResourcePolicy({ mode: 'shared' }, bounds), { mode: 'shared', cpuCores: null, memoryMiB: null });
  assert.deepEqual(normalizeResourcePolicy(policy, bounds), policy);
  assert.deepEqual(policy, { mode: 'fixed', cpuCores: 0.29, memoryMiB: 512 });
  assert.deepEqual(normalizeResourcePolicy({ mode: 'fixed', cpuCores: 2, memoryMiB: 4096 }, bounds), { mode: 'fixed', cpuCores: 2, memoryMiB: 4096 });
});

test('policies reject unknown keys, shared fixed values, malformed/fractional/out-of-host limits', () => {
  for (const bad of [[], false, {}, { mode: 'shared', cpuCores: 1 }, { mode: 'shared', memoryMiB: 512 }, { ...policy, unexpected: true }, { ...policy, mode: 'reserved' }, { ...policy, cpuCores: '1' }, { ...policy, cpuCores: NaN }, { ...policy, cpuCores: Infinity }, { ...policy, cpuCores: 0.09 }, { ...policy, cpuCores: 2.01 }, { ...policy, cpuCores: 0.291 }, { ...policy, memoryMiB: '512' }, { ...policy, memoryMiB: 255 }, { ...policy, memoryMiB: 4097 }, { ...policy, memoryMiB: 512.5 }]) assert.throws(() => normalizeResourcePolicy(bad, bounds), e => e.status === 400);
});

test('Windows never claims fixed enforcement and never reads or mutates cgroup files', async () => {
  let touches = 0;
  const ctl = createResourceController({ platform: 'win32', bounds, fs: new Proxy({}, { get() { touches++; throw new Error('Unexpected cgroup access'); } }) });
  assert.equal((await ctl.initialize()).fixedSupported, false);
  assert.equal((await ctl.capabilities()).sharedSupported, true);
  await assert.rejects(ctl.prepare(SID, policy), e => e.status === 409);
  assert.equal(touches, 0);
});

test('shared launch preserves the direct process and three console pipes without a controller', async () => {
  let command;
  const ctl = createResourceController({ platform: 'win32', bounds, spawn(file, args, opts) { command = { file, args, opts }; const child = new FakeChild(); queueMicrotask(() => child.emit('spawn')); return child; } });
  const h = await ctl.prepare('legacy-id', undefined); const { child, ready } = h.spawn(process.execPath, { env: { TEST: 'real contract' } });
  const effective = await ready; assert.equal(effective.mode, 'shared'); assert.equal(effective.applied, true); assert.equal(effective.kernelEnforced, false); assert.equal(command.file, process.execPath); assert.deepEqual(command.args, []); assert.deepEqual(command.opts.stdio, ['pipe', 'pipe', 'pipe']); assert.equal(child.pid, 901); assert.equal(await h.stats(), null);
  assert.throws(() => h.spawn(process.execPath, {}), e => e.status === 409); assert.equal((await h.cleanup()).mode, 'shared');
});

test('shared launcher controls an actual native Node process with the same PID and stdin/stdout pipes', async () => {
  const ctl = createResourceController({ bounds }); const h = await ctl.prepare('legacy-shared', undefined);
  const { child, ready } = h.spawn(process.execPath, {}); const closed = once(child, 'close'); let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { output += value; });
  const effective = await ready; child.stdin.end("process.stdout.write(JSON.stringify({pid:process.pid,actual:true}));\n");
  const [code] = await closed; assert.equal(code, 0); assert.deepEqual(JSON.parse(output), { pid: child.pid, actual: true }); assert.equal(effective.kernelEnforced, false); assert.equal(effective.mode, 'shared'); await h.cleanup();
});

test('missing cgroup v2, delegation, controllers and ownership fail safely before native launch', async () => {
  for (const tweak of [k => { k.type = 123; }, k => { k.delegate = 'no'; }, k => { k.mainPID = 88; }, k => k.files.set(controllerRoot + '/cgroup.controllers', 'cpu'), k => { k.accessError = 'EACCES'; }]) {
    const k = new KernelModel(); tweak(k); let spawns = 0; const ctl = k.controller({ spawn() { spawns++; throw new Error('Must not execute'); } });
    const caps = await ctl.initialize(); assert.equal(caps.fixedSupported, false); assert.ok(caps.reason); await assert.rejects(ctl.prepare(SID, policy), e => e.status === 409); assert.equal(spawns, 0); assert.equal(k.writes.length, 0);
  }
});

test('initialization discovers the owning service and moves only MainPID before enabling controllers', async () => {
  const { kernel, ctl } = await initialized(); const caps = await ctl.capabilities(); assert.equal(caps.configuredUnit, 'vortex-test.service'); assert.equal(caps.limitsAreReservations, false);
  assert.deepEqual(kernel.writes.slice(0, 2), [[controllerRoot + '/vortex-panel/cgroup.procs', '77\n'], [controllerRoot + '/cgroup.subtree_control', '+cpu +memory\n']]);
  assert.equal(kernel.files.get(controllerRoot + '/cgroup.procs'), ''); assert.equal(kernel.files.get(controllerRoot + '/vortex-panel/cpu.max'), 'max 100000'); assert.equal(kernel.files.get(controllerRoot + '/vortex-panel/memory.max'), 'max');
  await ctl.initialize(); assert.equal(kernel.writes.length, 2);
});

test('initialization refuses existing native/direct workers instead of moving foreign processes', async () => {
  const k = new KernelModel(); k.files.set(controllerRoot + '/cgroup.procs', '77\n88\n'); const ctl = k.controller(); const cap = await ctl.initialize(); assert.equal(cap.fixedSupported, false); assert.equal(k.writes.length, 0); assert.equal(k.dirs.has(controllerRoot + '/vortex-panel'), false);
});

test('fixed prepare writes and verifies quota, memory, swap0 and grouped OOM before any spawn', async () => {
  let spawned = 0; const { kernel, ctl } = await initialized({ spawn() { spawned++; } }); const h = await ctl.prepare(SID.toUpperCase(), policy); const scope = scopedDirectory(kernel);
  assert.ok(scope.includes(SID)); assert.equal(kernel.files.get(scope + '/cpu.max'), '29000 100000'); assert.equal(kernel.files.get(scope + '/memory.max'), '536870912'); assert.equal(kernel.files.get(scope + '/memory.swap.max'), '0'); assert.equal(kernel.files.get(scope + '/memory.oom.group'), '1'); assert.equal(spawned, 0); assert.equal(h.effective.applied, false); assert.equal(h.effective.kernelEnforced, false); await h.cleanup(); assert.equal(kernel.dirs.has(scope), false);
});

test('managed pool reserves ten percent and contains both shared and fixed children, leaving supervisor outside', async () => {
  const { kernel, ctl } = await initialized({ reserveRatio: 0.1 });
  const pool = controllerRoot + '/vortex-managed-pool';
  assert.equal(kernel.files.get(pool + '/cpu.max'), '180000 100000');
  assert.equal(kernel.files.get(pool + '/memory.max'), String(Math.floor(4096 * 0.9) * 1048576));
  assert.equal(kernel.files.get(pool + '/memory.swap.max'), '0');
  assert.equal(kernel.files.get(controllerRoot + '/vortex-panel/memory.max'), 'max');
  const shared = await ctl.prepare(SID, { mode: 'shared' });
  const fixed = await ctl.prepare(randomUUID(), policy);
  assert.equal(shared.effective.mode, 'shared');
  assert.equal(shared.effective.cpuCores, 1.8);
  assert.equal(shared.effective.managedPool.shared, true);
  assert.ok(shared.effective.cgroupPath.includes('/vortex-managed-pool/vortex-server-'));
  assert.ok(fixed.effective.cgroupPath.includes('/vortex-managed-pool/vortex-server-'));
  const existing = await ctl.prepare(randomUUID(), { mode: 'fixed', cpuCores: 2, memoryMiB: 4096 });
  assert.equal(existing.policy.cpuCores, 2); assert.equal(existing.policy.memoryMiB, 4096);
  assert.equal(existing.effective.effectiveCpuCores, 1.8);
  assert.equal(existing.effective.effectiveMemoryMiB, Math.floor(4096 * 0.9));
  assert.equal(existing.effective.ancestorConstrained, true);
  await shared.cleanup(); await fixed.cleanup(); await existing.cleanup();
});

test('worker pool uses full effective resources with no percentage withheld and keeps ancestor limits', async () => {
  for (const constrained of [false, true]) {
    const kernel = new KernelModel();
    if (constrained) {
      kernel.files.set('/cg/cpu.max', '150000 100000');
      kernel.files.set('/cg/memory.max', String(2048 * 1048576));
    }
    const ctl = kernel.controller({ reserveRatio: 0 });
    const capability = await ctl.initialize();
    assert.equal(capability.fixedSupported, true);
    assert.equal(capability.managedPool.reserveRatio, 0);
    assert.equal(capability.managedPool.cpuCores, constrained ? 1.5 : 2);
    assert.equal(capability.managedPool.memoryMiB, constrained ? 2048 : 4096);
    const pool = controllerRoot + '/vortex-managed-pool';
    assert.equal(kernel.files.get(pool + '/cpu.max'), `${constrained ? 150000 : 200000} 100000`);
    assert.equal(kernel.files.get(pool + '/memory.max'), String((constrained ? 2048 : 4096) * 1048576));
    const handle = await ctl.prepare(SID, { mode: 'shared' });
    assert.equal(handle.effective.managedPool.reserveRatio, 0);
    assert.equal(handle.effective.cpuCores, constrained ? 1.5 : 2);
    await handle.cleanup();
  }
});

test('invalid server IDs cannot escape the delegated resource subtree', async () => {
  const { ctl, kernel } = await initialized(); const before = kernel.dirs.size; await assert.rejects(ctl.prepare('../outside', policy), e => e.status === 400); assert.equal(kernel.dirs.size, before);
});

test('kernel limit write or readback failure does not spawn and removes only its empty group', async () => {
  for (const kind of ['write', 'readback']) {
    const { ctl, kernel } = await initialized();
    if (kind === 'write') kernel.writeFailure = file => file.includes('/vortex-server-') && file.endsWith('/memory.max');
    else { const old = kernel.writeFile.bind(kernel); kernel.fs.writeFile = async (file, value) => { if (file.includes('/vortex-server-') && file.endsWith('/cpu.max')) kernel.ignoreWrite = file; return old(file, value); }; }
    await assert.rejects(ctl.prepare(SID, policy), e => e.status === 409); assert.equal(kernel.removals.length, 1); assert.equal(scopedDirectory(kernel), undefined); assert.ok(kernel.dirs.has(controllerRoot + '/vortex-panel'));
  }
});

test('failed empty-group cleanup remains explicit with its owned pending path', async () => {
  const { ctl, kernel } = await initialized(); kernel.writeFailure = file => file.includes('/vortex-server-') && file.endsWith('/memory.max'); kernel.rmdirError = 'EIO';
  await assert.rejects(ctl.prepare(SID, policy), e => e.status === 409 && e.cleanupPending.includes('/vortex-server-'));
  assert.ok(scopedDirectory(kernel));
});

test('fixed launcher uses positional arguments, sanitized Bash environment and same-PID acknowledgement', async () => {
  let command, child;
  const { ctl, kernel } = await initialized({ spawn(file, args, opts) { command = { file, args, opts }; child = new FakeChild(); queueMicrotask(() => { child.emit('spawn'); child.stdio[3].write(`${args[6]}:${child.pid}\n`); }); return child; } });
  const h = await ctl.prepare(SID, policy); const out = h.spawn('/run/space and $literal/bedrock_server', { cwd: '/run/space and $literal', env: { BASH_ENV: '/bad', ENV: '/bad', LD_LIBRARY_PATH: '/run/space and $literal' } }); const effective = await out.ready;
  assert.equal(command.file, '/bin/bash'); assert.equal(command.args[4], '/run/space and $literal/bedrock_server'); assert.equal(command.args[1], RESOURCE_EXEC_WRAPPER); assert.equal(command.opts.env.BASH_ENV, undefined); assert.equal(command.opts.env.ENV, undefined); assert.equal(command.opts.env.LD_LIBRARY_PATH, '/run/space and $literal'); assert.deepEqual(command.opts.stdio, ['pipe', 'pipe', 'pipe', 'pipe']); assert.equal(out.child.pid, 901); assert.equal(effective.applied, true); assert.equal(effective.kernelEnforced, true); assert.equal(effective.cpuQuotaMicros, 29000); assert.equal(effective.memoryMaxBytes, 536870912);
  await assert.rejects(h.cleanup(), e => e.status === 409); child.close(); await h.cleanup(); assert.equal(scopedDirectory(kernel), undefined);
});

test('denied/malformed/early-closed attachment rejects readiness and never reports fixed applied', async () => {
  for (const kind of ['wrongpid', 'closed', 'exit']) {
    let child;
    const { ctl } = await initialized({ spawn(_file, args) { child = new FakeChild(); queueMicrotask(() => { child.emit('spawn'); if (kind === 'wrongpid') child.stdio[3].write(`${args[6]}:999\n`); else if (kind === 'closed') child.stdio[3].end(); else child.close(78); }); return child; } });
    const h = await ctl.prepare(SID, policy); const { ready } = h.spawn('/run/bedrock_server', {}); await assert.rejects(ready, e => e.status === 409); assert.equal(h.effective.applied, false); assert.equal(h.effective.kernelEnforced, false); await new Promise(resolve => setImmediate(resolve)); await h.cleanup();
  }
});

test('attachment timeout kills only the owned wrapper and leaves fixed unapplied', async () => {
  let child; const { ctl } = await initialized({ readinessTimeoutMs: 10, spawn() { child = new FakeChild(); queueMicrotask(() => child.emit('spawn')); return child; } }); const h = await ctl.prepare(SID, policy); await assert.rejects(h.spawn('/run/bedrock_server', {}).ready, e => e.status === 409); assert.deepEqual(child.kills, ['SIGKILL']); assert.equal(h.effective.kernelEnforced, false); await new Promise(resolve => setImmediate(resolve)); await h.cleanup();
});

test('scope replacement prevents cleanup/kill of another cgroup', async () => {
  const { ctl, kernel } = await initialized(); const h = await ctl.prepare(SID, policy); const scope = scopedDirectory(kernel); kernel.dirs.get(scope).ino++;
  await assert.rejects(h.cleanup(), e => e.status === 409 && Boolean(e.cleanupPending)); assert.equal(kernel.removals.length, 0); assert.equal(kernel.writes.some(([file]) => file.endsWith('/cgroup.kill')), false);
});

test('cleanup rechecks owned scope after optional statistics and before kill or removal', async () => {
  for (const timing of ['statistics', 'before-kill', 'before-removal', 'after-kill', 'root-during-statistics']) {
    const { ctl, kernel } = await initialized();
    const handle = await ctl.prepare(SID, policy), scope = scopedDirectory(kernel);
    const originalStat = kernel.fs.lstat, originalRead = kernel.fs.readFile, originalWrite = kernel.fs.writeFile;
    let scopeReads = 0, replaced = false;
    const replace = () => {
      if (replaced) return;
      replaced = true;
      const target = timing === 'root-during-statistics' ? controllerRoot : scope;
      kernel.dirs.set(target, { ...kernel.dirs.get(target), ino: 999999 });
    };
    kernel.fs.lstat = async file => {
      if (file === scope && ++scopeReads === 2 && ['statistics', 'root-during-statistics'].includes(timing)) replace();
      return originalStat(file);
    };
    kernel.fs.readFile = async file => {
      if (file === scope + '/cgroup.events' && ['before-kill', 'before-removal'].includes(timing)) replace();
      return originalRead(file);
    };
    kernel.fs.writeFile = async (file, value) => {
      await originalWrite(file, value);
      if (file === scope + '/cgroup.kill' && timing === 'after-kill') replace();
    };
    if (['before-kill', 'after-kill'].includes(timing)) kernel.files.set(scope + '/cgroup.events', 'populated 1\n');
    await assert.rejects(handle.cleanup(), error => error.status === 409 && Boolean(error.cleanupPending), timing);
    assert.equal(replaced, true, timing);
    assert.equal(kernel.dirs.has(scope), true, timing);
    assert.equal(kernel.removals.includes(scope), false, timing);
    assert.equal(kernel.writes.filter(([file]) => file === scope + '/cgroup.kill').length, timing === 'after-kill' ? 1 : 0, timing);
  }
});

test('optional statistics I/O failure remains a warning only while scope identity is current', async () => {
  const { ctl, kernel } = await initialized();
  const handle = await ctl.prepare(SID, policy), scope = scopedDirectory(kernel), originalRead = kernel.fs.readFile;
  kernel.fs.readFile = async file => { if (file === scope + '/cpu.stat') throw systemError('EIO'); return originalRead(file); };
  const result = await handle.cleanup();
  assert.equal(result.removed, true);
  assert.deepEqual(localizeApiResponse('/api/servers/a/start', result, 'en').warnings, ['Resource statistics could not be captured before cleanup: EIO']);
  assert.deepEqual(localizeApiResponse('/api/servers/a/start', result, 'vi').warnings, ['Không ghi nhận được thống kê tài nguyên trước khi dọn: EIO']);
});

test('failed preparation retains a replacement scope for recovery instead of removing it', async () => {
  const { ctl, kernel } = await initialized(), originalRead = kernel.fs.readFile;
  let scope;
  kernel.fs.readFile = async file => {
    if (file.includes('/vortex-server-') && file.endsWith('/cpu.max')) {
      scope = file.slice(0, -'/cpu.max'.length);
      kernel.dirs.set(scope, { ...kernel.dirs.get(scope), ino: 999999 });
      return 'incorrect';
    }
    return originalRead(file);
  };
  let failure;
  await assert.rejects(ctl.prepare(SID, policy), error => { failure = error; return error.status === 409 && error.cleanupPending === scope; });
  assert.equal(kernel.dirs.has(scope), true);
  assert.equal(kernel.removals.includes(scope), false);
  const body = { error: failure.message };
  assert.equal(localizeApiResponse('/api/servers/a/start', body, 'vi').error, failure.message);
  assert.equal(localizeApiResponse('/api/servers/a/start', body, 'en').error, `Cannot apply fixed resource limits before server execution: The cpu.max limit could not be verified. The server has not been started.; The empty resource area at ${scope} could not be cleaned up: The server resource area changed. The operation was stopped to protect your data.`);
});

test('real preparation plus native cleanup failure preserves opaque system error text in both locales', async () => {
  const { ctl, kernel } = await initialized();
  kernel.writeFailure = file => file.includes('/vortex-server-') && file.endsWith('/memory.max');
  kernel.rmdirError = 'EIO: Không tìm thấy server./opaque';
  let failure;
  await assert.rejects(ctl.prepare(SID, policy), error => { failure = error; return error.status === 409 && Boolean(error.cleanupPending); });
  const body = { error: failure.message };
  assert.equal(localizeApiResponse('/api/servers/a/start', body, 'vi').error, failure.message);
  assert.equal(localizeApiResponse('/api/servers/a/start', body, 'en').error, `Cannot apply fixed resource limits before server execution: EACCES; The empty resource area at ${failure.cleanupPending} could not be cleaned up: ${kernel.rmdirError}`);
});

test('real resource failures translate generated causes in EN and retain canonical VI', async () => {
  for (const kind of ['kernel-readback', 'replaced-scope']) {
    const { ctl, kernel } = await initialized();
    let failure;
    if (kind === 'kernel-readback') {
      const originalWrite = kernel.fs.writeFile;
      kernel.fs.writeFile = async (file, value) => { if (file.includes('/vortex-server-') && file.endsWith('/cpu.max')) kernel.ignoreWrite = file; return originalWrite(file, value); };
      await assert.rejects(ctl.prepare(SID, policy), error => { failure = error; return error.status === 409; });
    } else {
      const handle = await ctl.prepare(SID, policy), scope = scopedDirectory(kernel);
      kernel.dirs.get(scope).ino++;
      await assert.rejects(handle.cleanup(), error => { failure = error; return error.status === 409; });
    }
    const body = { error: failure.message }, en = localizeApiResponse('/api/servers/a/start', body, 'en'), vi = localizeApiResponse('/api/servers/a/start', body, 'vi');
    assert.equal(vi.error, failure.message);
    assert.equal(en.error.includes('Không xác minh được'), false);
    assert.equal(en.error.includes('Vùng tài nguyên'), false);
    assert.match(en.error, kind === 'kernel-readback' ? /The cpu\.max limit could not be verified\. The server has not been started\.$/ : /The server resource area changed\. The operation was stopped to protect your data\.$/);
    assert.equal(en.errorI18n.vi, failure.message);
    assert.equal(body.error, failure.message, 'localization must not mutate the canonical error');
  }
});

test('resource nested metadata translates panel causes while paths and native errors stay opaque', () => {
  const path = 'Không tìm thấy server./opaque: path', native = 'EACCES: Không tìm thấy server./opaque';
  for (const [id, params] of [['apply_failed', [native]], ['stats_cleanup', [native]], ['cleanup_failed', [path, native]], ['prepare_cleanup', [path, native]], ['prepare_cleanup_suffix', [path, native]]]) {
    const translated = formatPanelMessage('panel.resource.' + id, params);
    assert.ok(translated.en.endsWith(native));
    if (id.includes('cleanup') && id !== 'stats_cleanup') assert.ok(translated.en.includes(path));
    assert.deepEqual(translated.params, params);
  }
  assert.equal(formatPanelMessage('panel.resource.stats_cleanup', ['Vùng tài nguyên của server đã thay đổi. Thao tác được dừng để bảo vệ dữ liệu.']).en, 'Resource statistics could not be captured before cleanup: The server resource area changed. The operation was stopped to protect your data.');
});

test('kernel stats expose real counter values and cleanup can kill only owned descendants after direct child close', async () => {
  let child; const { ctl, kernel } = await initialized({ spawn(_file, args) { child = new FakeChild(); queueMicrotask(() => child.stdio[3].write(`${args[6]}:${child.pid}\n`)); return child; } }); const h = await ctl.prepare(SID, policy); await h.spawn('/run/bedrock_server', {}).ready; const scope = scopedDirectory(kernel);
  kernel.files.set(scope + '/cpu.stat', 'usage_usec 1234\nnr_throttled 7\nthrottled_usec 8910\n'); kernel.files.set(scope + '/memory.current', '123456'); kernel.files.set(scope + '/memory.peak', '200000'); kernel.files.set(scope + '/memory.events', 'oom 2\noom_kill 1\n');
  const stats = await h.stats(); assert.equal(stats.cpuUsageUsec, 1234); assert.equal(stats.nrThrottled, 7); assert.equal(stats.throttledUsec, 8910); assert.equal(stats.memoryCurrentBytes, 123456); assert.equal(stats.oomKills, 1); assert.equal(stats.oomEvents, 2); assert.equal(stats.effective.kernelEnforced, true);
  child.close(); kernel.files.set(scope + '/cgroup.events', 'populated 1\n'); const cleanup = await h.cleanup(); assert.equal(cleanup.ok, true); assert.equal(kernel.writes.filter(([file]) => file.endsWith('/cgroup.kill')).length, 1); assert.equal(await h.stats() !== null, true); assert.ok(kernel.dirs.has(controllerRoot + '/vortex-panel')); assert.equal((await h.cleanup()).alreadyRemoved, true);
});

test('controller/manager replacement is reported unsupported and prevents subsequent fixed prepare', async () => {
  const { ctl, kernel } = await initialized(); kernel.dirs.get(controllerRoot).ino++; assert.equal((await ctl.capabilities()).fixedSupported, false); await assert.rejects(ctl.prepare(SID, policy), e => e.status === 409);
});

test('spawn contract rejects shell/detached/extra console streams before execution', async () => {
  const { ctl } = await initialized(); const h = await ctl.prepare(SID, policy);
  for (const opts of [{ shell: true }, { detached: true }, { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }]) assert.throws(() => h.spawn('/run/bedrock_server', opts), e => e.status === 400);
  assert.throws(() => h.spawn('relative-bedrock', {}), e => e.status === 400); await h.cleanup();
});

test('resource errors provide exact canonical VI and EN templates with identical placeholders', () => {
  const ids = new Set(); assert.equal(RESOURCE_CONTROL_MESSAGES.length, 55);
  for (const row of RESOURCE_CONTROL_MESSAGES) { assert.ok(row.vi && row.en); assert.equal(ids.has(row.id), false); ids.add(row.id); assert.deepEqual((row.vi.match(/\{\d+\}/g) || []).sort(), (row.en.match(/\{\d+\}/g) || []).sort()); }
});
