import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createResourceController } from '../server/resource-control.js';

const ID = 'cff5224f-82d5-4d46-baf8-1ac42abc70d6';
const bounds = { cpuCount: 2, memoryTotalMiB: 4096 };
const policy = { mode: 'fixed', cpuCores: 0.5, memoryMiB: 512 };

test('direct application argv and explicit clean environment reach a real Node child without panel environment', async () => {
  process.env.VORTEX_APP_LAUNCH_TEST_SECRET = 'must-not-inherit';
  const controller = createResourceController({ platform: 'win32', bounds });
  const handle = await controller.prepare(ID, { mode: 'shared' });
  const literal = '$(not a shell); two words & %PATH%';
  try {
    const script = 'process.stdout.write(JSON.stringify({arg:process.argv[1],sentinel:process.env.VORTEX_APP_LAUNCH_TEST_SECRET??null,allowed:process.env.APP_ALLOWED,pid:process.pid}));';
    const { child, ready } = handle.spawnWithArgs(process.execPath, ['-e', script, literal], { env: { APP_ALLOWED: 'only-this', BASH_ENV: '/forbidden', ENV: '/forbidden' } }, { cleanEnvironment: true });
    let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output += chunk); const done = once(child, 'close'); await ready; const [code] = await done;
    assert.equal(code, 0); assert.deepEqual(JSON.parse(output), { arg: literal, sentinel: null, allowed: 'only-this', pid: child.pid });
  } finally { delete process.env.VORTEX_APP_LAUNCH_TEST_SECRET; await handle.cleanup(); }
});

test('application argv shape/byte bounds reject unsafe requests before any spawn', async () => {
  let launches = 0;
  const controller = createResourceController({ platform: 'win32', bounds, spawn() { launches++; throw new Error('must not launch'); } });
  const handle = await controller.prepare(ID, { mode: 'shared' });
  for (const args of [null, 'a b', ['bad\0value'], [123], ['x'.repeat(16385)], Array(257).fill('x'), Array(9).fill('x'.repeat(16384))]) assert.throws(() => handle.spawnWithArgs(process.execPath, args, {}, { cleanEnvironment: true }), error => error.status === 400);
  assert.equal(launches, 0); await handle.cleanup();
});

// Cgroup interface model only; native enforcement is a separate Linux gate.
class PidsKernel {
  constructor({ delegated = true, controllers = true, badReadback = false } = {}) {
    this.dirs = new Map(); this.files = new Map(); this.writes = []; this.next = 4; this.delegated = delegated; this.badReadback = badReadback;
    this.group('/cg'); this.group('/cg/system.slice/app.service');
    if (!controllers) this.files.set('/cg/system.slice/app.service/cgroup.controllers', 'cpu memory');
    this.files.set('/cg/system.slice/app.service/cgroup.procs', '77\n'); this.files.set('/proc/self/cgroup', '0::/system.slice/app.service\n');
    this.fs = Object.fromEntries(['readFile', 'writeFile', 'mkdir', 'rmdir', 'realpath', 'lstat', 'statfs', 'access'].map(key => [key, this[key].bind(this)]));
  }
  group(name) {
    this.dirs.set(name, { ino: ++this.next, dev: 7, isDirectory: () => true, isSymbolicLink: () => false });
    for (const [key, value] of Object.entries({ 'cgroup.controllers': 'cpu memory pids', 'cgroup.procs': '', 'cgroup.subtree_control': '', 'cgroup.events': 'populated 0\nfrozen 0', 'cpu.max': 'max 100000', 'memory.max': 'max', 'memory.swap.max': 'max', 'memory.oom.group': '0', 'pids.max': 'max', 'cpu.stat': 'usage_usec 0', 'memory.stat': 'anon 0', 'memory.current': '0', 'memory.peak': '0', 'memory.events': 'oom 0\noom_kill 0' })) this.files.set(name + '/' + key, value);
  }
  async readFile(name) { if (!this.files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return this.files.get(name); }
  async writeFile(name, value) {
    this.writes.push([name, value]);
    if (name.endsWith('/cgroup.procs')) {
      for (const [key, old] of this.files) if (key.endsWith('/cgroup.procs')) this.files.set(key, old.split(/\s+/).filter(v => v && v !== value.trim()).join('\n'));
      this.files.set(name, value.trim()); if (value.trim() === '77') this.files.set('/proc/self/cgroup', '0::' + name.slice(3, -'/cgroup.procs'.length) + '\n');
    } else if (name.endsWith('/cgroup.subtree_control')) this.files.set(name, value.trim().replaceAll('+', ''));
    else this.files.set(name, this.badReadback && name.endsWith('/pids.max') ? 'max' : value.trim());
  }
  async mkdir(name) { if (this.dirs.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); this.group(name); }
  async rmdir(name) { this.dirs.delete(name); for (const key of [...this.files.keys()]) if (key.startsWith(name + '/')) this.files.delete(key); }
  async realpath(name) { await this.lstat(name); return name; }
  async lstat(name) { if (!this.dirs.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return this.dirs.get(name); }
  async statfs() { return { type: 0x63677270 }; }
  async access() {}
  async execFile(file, args) {
    if (file === 'busctl') return { stdout: args[0] === 'call' ? 'o "/org/freedesktop/systemd1/unit/app_2eservice"\n' : 's "app.service"\n' };
    return { stdout: `Delegate=yes\nDelegateControllers=cpu memory${this.delegated ? ' pids' : ''}\nControlGroup=/system.slice/app.service\nMainPID=77\n` };
  }
  controller(extra = {}) { return createResourceController({ platform: 'linux', pid: 77, mountPath: '/cg', procPath: '/proc', bounds, fs: this.fs, execFile: this.execFile.bind(this), pause: async () => {}, ...extra }); }
}

test('application task ceiling requires delegated pids and verifies pids.max before launch', async () => {
  const kernel = new PidsKernel(), controller = kernel.controller(); assert.equal((await controller.initialize()).pidsSupported, true);
  const handle = await controller.prepare(ID, policy, { tasksMax: 128 });
  assert.equal(handle.effective.tasksMax, 128); assert.ok(kernel.writes.some(([file, value]) => file.endsWith('/pids.max') && value === '128\n')); assert.ok(kernel.writes.some(([file, value]) => file.endsWith('/cgroup.subtree_control') && value.includes('+pids'))); await handle.cleanup();
  for (const setup of [{ delegated: false }, { controllers: false }, { badReadback: true }]) {
    const model = new PidsKernel(setup); let spawned = 0; const ctl = model.controller({ spawn() { spawned++; } }); await ctl.initialize(); await assert.rejects(ctl.prepare(ID, policy, { tasksMax: 128 }), error => error.status === 409); assert.equal(spawned, 0);
  }
});

test('fixed application wrapper keeps literal arguments and no inherited environment before attachment acknowledgement', async () => {
  let call, child;
  const kernel = new PidsKernel(), controller = kernel.controller({ spawn(file, args, options) {
    call = { file, args, options }; child = new EventEmitter(); child.pid = 901; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()]; child.kill = () => true;
    queueMicrotask(() => child.stdio[3].write(`${args[6]}:901\n`)); return child;
  } });
  await controller.initialize(); const handle = await controller.prepare(ID, policy, { tasksMax: 128 });
  process.env.VORTEX_APP_LAUNCH_TEST_SECRET = 'private';
  try { const launched = handle.spawnWithArgs('/usr/bin/setpriv', ['--reuid=1234', '/usr/bin/bwrap', '--', '/runtime/node/bin/node', 'literal;$(x)'], { env: { PORT: '31000' } }, { cleanEnvironment: true }); await launched.ready; assert.equal(call.file, '/bin/bash'); assert.deepEqual(call.args.slice(-5), ['--reuid=1234', '/usr/bin/bwrap', '--', '/runtime/node/bin/node', 'literal;$(x)']); assert.equal(call.options.env.VORTEX_APP_LAUNCH_TEST_SECRET, undefined); assert.equal(call.options.env.PORT, '31000'); child.emit('close', 0, null); await handle.cleanup(); } finally { delete process.env.VORTEX_APP_LAUNCH_TEST_SECRET; }
});
