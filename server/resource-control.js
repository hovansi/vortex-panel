import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resourceControlMessage as m } from './resource-control-messages.js';

const runFile = promisify(execFile);
const CGROUP2_MAGIC = 0x63677270;
const kernelPath = path.posix;
const PERIOD = 100000;
const MIB = 1048576;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIT = /^[a-zA-Z0-9_.@:-]+\.service$/;
const shared = () => ({ mode: 'shared', cpuCores: null, memoryMiB: null });
const error = (message, status = 409, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { status });
const hostBounds = () => ({ cpuCount: os.availableParallelism?.() || os.cpus().length || 1, memoryTotalMiB: Math.floor(os.totalmem() / MIB) });

// These are ceilings, not reservations or admission promises.
export function normalizeResourcePolicy(input, bounds = hostBounds()) {
  if (input === undefined || input === null) return shared();
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'cpuCores', 'memoryMiB'].includes(key))) throw error(m('policy_fields'), 400);
  if (!['shared', 'fixed'].includes(input.mode)) throw error(m('policy_mode'), 400);
  if (input.mode === 'shared') {
    if (input.cpuCores != null || input.memoryMiB != null) throw error(m('shared_fields'), 400);
    return shared();
  }
  const maxCores = Math.max(1, Math.floor(bounds.cpuCount));
  const maxMiB = Math.floor(bounds.memoryTotalMiB);
  const cpu = input.cpuCores, memory = input.memoryMiB;
  if (typeof cpu !== 'number' || !Number.isFinite(cpu) || cpu < 0.1 || cpu > maxCores || Math.abs(cpu * 100 - Math.round(cpu * 100)) > 1e-8) throw error(m('cpu_limit', maxCores), 400);
  if (typeof memory !== 'number' || !Number.isSafeInteger(memory) || memory < 256 || memory > maxMiB) throw error(m('memory_limit', maxMiB), 400);
  return { mode: 'fixed', cpuCores: Math.round(cpu * 100) / 100, memoryMiB: memory };
}

// No shell interpolation: all paths, limits and the acknowledgement token are
// positional arguments. The native executable cannot run until self-attachment
// and the kernel control files have been verified. exec preserves the same PID.
export const RESOURCE_EXEC_WRAPPER = String.raw`set -eu
scope=$1
executable=$2
relative=$3
token=$4
quota=$5
memory=$6
resource_fail() { printf '%s\n' 'Vortex resource control: attachment or kernel limit verification failed before Bedrock execution.' >&2; exit 78; }
printf '%s\n' "$$" > "$scope/cgroup.procs" || resource_fail
actual=
while IFS=: read -r hierarchy controllers location; do
  if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then actual=$location; fi
done < /proc/self/cgroup
[ "$actual" = "$relative" ] || resource_fail
read -r actual_quota actual_period < "$scope/cpu.max" || resource_fail
[ "$actual_quota" = "$quota" ] && [ "$actual_period" = 100000 ] || resource_fail
[ "$(<"$scope/memory.max")" = "$memory" ] || resource_fail
[ "$(<"$scope/memory.swap.max")" = 0 ] || resource_fail
[ "$(<"$scope/memory.oom.group")" = 1 ] || resource_fail
printf '%s:%s\n' "$token" "$$" >&3 || resource_fail
exec 3>&-
shift 6
exec "$executable" "$@"`;

function parsePairs(text) {
  const result = {};
  for (const line of String(text).trim().split('\n')) {
    const [key, raw] = line.trim().split(/\s+/);
    if (key && /^\d+$/.test(raw || '')) result[key] = Number(raw);
  }
  return result;
}
function unifiedPath(text) {
  const line = String(text).split('\n').find(value => value.startsWith('0::'));
  if (!line) throw error(m('hierarchy'));
  const relative = line.slice(3);
  if (!relative.startsWith('/') || relative.includes('\0') || relative.split('/').some(part => ['.', '..'].includes(part))) throw error(m('process_path'));
  return relative;
}
const absent = e => ['ENOENT', 'ESRCH'].includes(e?.code);

export function createResourceController(options = {}) {
  // Dependency injection is for isolated tests. No option comes from API input.
  const io = options.fs || fs;
  const launch = options.spawn || spawn;
  const command = options.execFile || runFile;
  const platform = options.platform || process.platform;
  const pid = options.pid || process.pid;
  const mount = options.mountPath || '/sys/fs/cgroup';
  const proc = options.procPath || '/proc';
  const bounds = options.bounds || hostBounds();
  const reserveRatio = options.reserveRatio ?? null;
  if (reserveRatio !== null && (!Number.isFinite(reserveRatio) || reserveRatio < 0 || reserveRatio >= 1)) throw error('Invalid managed resource reserve ratio.', 400);
  let poolLimits = reserveRatio === null ? null : { cpuCores: Math.floor(bounds.cpuCount * (1 - reserveRatio) * 100) / 100, memoryMiB: Math.floor(bounds.memoryTotalMiB * (1 - reserveRatio)) };
  const nowUUID = options.randomUUID || randomUUID;
  const pause = options.pause || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const readinessMs = options.readinessTimeoutMs ?? 10000;
  let configuredUnit = options.unit || null, root = null, rootIdentity = null, initialized = false, initializePromise = null;
  let unavailableReason = null;
  let pidsSupported = false;
  const handles = new Set();

  function capability(supported, reason = null) {
    return { sharedSupported: true, fixedSupported: supported, supported, pidsSupported: supported && pidsSupported, enforcement: supported ? 'cgroup-v2' : null, reason, configuredUnit, controllers: ['cpu', 'memory', ...(pidsSupported?['pids']:[])], cpu: { minCores: 0.1, maxCores: poolLimits?.cpuCores ?? Math.max(1, Math.floor(bounds.cpuCount)), stepCores: 0.01 }, memory: { minMiB: 256, maxMiB: poolLimits?.memoryMiB ?? Math.floor(bounds.memoryTotalMiB) }, managedPool: poolLimits ? { ...poolLimits, reserveRatio, kernelEnforced: supported } : null, limitsAreReservations: false, ancestorLimitsApply: true };
  }
  async function text(file) { return (await io.readFile(file, 'utf8')).trim(); }
  async function safeDirectory(directory) {
    const real = await io.realpath(directory);
    if (real !== directory || (directory !== mount && !directory.startsWith(mount + '/'))) throw error(m('linked_directory'));
    const info = await io.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw error(m('real_directory'));
    return { ino: info.ino, dev: info.dev };
  }
  async function assertRootIdentity() {
    if (!root || !rootIdentity) throw error(m('not_initialized'));
    const actual = await safeDirectory(root);
    if (actual.ino !== rootIdentity.ino || actual.dev !== rootIdentity.dev) throw error(m('root_changed'));
  }
  async function assertScopeIdentity(scope, expected) {
    await assertRootIdentity();
    const actual = await safeDirectory(scope);
    if (actual.ino !== expected.ino || actual.dev !== expected.dev) throw error(m('scope_replaced'));
  }
  async function discover() {
    if (platform !== 'linux') throw error(m('linux_required'));
    if ((await io.statfs(mount)).type !== CGROUP2_MAGIC) throw error(m('filesystem'));
    const location = unifiedPath(await io.readFile(kernelPath.join(proc, 'self/cgroup'), 'utf8'));
    if (!configuredUnit) {
      const reply = await command('busctl', ['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnitByPID', 'u', String(pid)], { timeout: 3000, maxBuffer: 65536 });
      const object = reply.stdout.trim().match(/^o "(\/org\/freedesktop\/systemd1\/unit\/[a-zA-Z0-9_]+)"$/)?.[1];
      if (!object) throw error(m('unit_identify'));
      const id = await command('busctl', ['get-property', 'org.freedesktop.systemd1', object, 'org.freedesktop.systemd1.Unit', 'Id'], { timeout: 3000, maxBuffer: 65536 });
      const encoded = id.stdout.trim().match(/^s (".*")$/)?.[1];
      if (!encoded) throw error(m('unit_identity'));
      configuredUnit = JSON.parse(encoded);
    }
    if (!UNIT.test(configuredUnit)) throw error(m('unit_service'));
    const reply = await command('systemctl', ['show', configuredUnit, '--property=Delegate', '--property=DelegateControllers', '--property=ControlGroup', '--property=MainPID'], { timeout: 3000, maxBuffer: 65536 });
    const info = Object.fromEntries(reply.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (!['yes', 'true'].includes(info.Delegate)) throw error(m('enable_delegate'));
    if (Number(info.MainPID) !== pid) throw error(m('main_pid'));
    const control = info.ControlGroup;
    if (!control || control === '/' || !control.startsWith('/') || control.includes('\0') || control.split('/').some(part => ['.', '..'].includes(part))) throw error(m('unit_group'));
    if (location !== control && location !== control + '/vortex-panel') throw error(m('outside_group'));
    const candidate = kernelPath.join(mount, control.slice(1));
    const identity = await safeDirectory(candidate);
    const controllers = (await text(kernelPath.join(candidate, 'cgroup.controllers'))).split(/\s+/);
    if (!['cpu', 'memory'].every(name => controllers.includes(name))) throw error(m('controllers'));
    const requested = (info.DelegateControllers || '').split(/\s+/).filter(Boolean);
    if (requested.length && !['cpu', 'memory'].every(name => requested.includes(name))) throw error(m('delegate_controllers'));
    await io.access(candidate, constants.W_OK | constants.X_OK);
    return { directory: candidate, identity, control, location, pids: controllers.includes('pids') && (!requested.length || requested.includes('pids')) };
  }
  async function initialize() {
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      try {
        const found = await discover();
        const direct = (await text(kernelPath.join(found.directory, 'cgroup.procs'))).split(/\s+/).filter(Boolean).map(Number);
        if (direct.some(value => value !== pid)) throw error(m('early_initialize'));
        const leaf = kernelPath.join(found.directory, 'vortex-panel');
        try { await io.mkdir(leaf); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
        await safeDirectory(leaf);
        const leafPids = (await text(kernelPath.join(leaf, 'cgroup.procs'))).split(/\s+/).filter(Boolean).map(Number);
        if (leafPids.some(value => value !== pid)) throw error(m('unexpected_manager'));
        if (found.location !== found.control + '/vortex-panel') await io.writeFile(kernelPath.join(leaf, 'cgroup.procs'), String(pid) + '\n');
        if (unifiedPath(await io.readFile(kernelPath.join(proc, 'self/cgroup'), 'utf8')) !== found.control + '/vortex-panel') throw error(m('move_manager'));
        if (await text(kernelPath.join(found.directory, 'cgroup.procs'))) throw error(m('parent_not_empty'));
        pidsSupported = found.pids;
        await io.writeFile(kernelPath.join(found.directory, 'cgroup.subtree_control'), `+cpu +memory${pidsSupported?' +pids':''}\n`);
        const enabled = (await text(kernelPath.join(found.directory, 'cgroup.subtree_control'))).split(/\s+/);
        if (!['cpu', 'memory', ...(pidsSupported ? ['pids'] : [])].every(name => enabled.includes(name))) throw error(m('enable_failed'));
        // Keep the supervisor leaf unlimited. Inherited ancestor limits
        // still apply; this does not promise machine-wide exclusive capacity.
        if (await text(kernelPath.join(leaf, 'cpu.max')) !== 'max 100000' || await text(kernelPath.join(leaf, 'memory.max')) !== 'max') throw error(m('manager_limited'));
        root = found.directory; rootIdentity = found.identity;
        if (poolLimits) {
          let cpuCeiling = bounds.cpuCount, memoryCeiling = bounds.memoryTotalMiB;
          for (let ancestor = found.directory; ; ancestor = kernelPath.dirname(ancestor)) {
            for (const file of ['cpu.max', 'memory.max']) {
              let value; try { value = await text(kernelPath.join(ancestor, file)); } catch (cause) { if (absent(cause)) continue; throw cause; }
              if (file === 'cpu.max') { const [quota, period] = value.split(/\s+/); if (quota !== 'max' && Number(quota) > 0 && Number(period) > 0) cpuCeiling = Math.min(cpuCeiling, Number(quota) / Number(period)); }
              else if (value !== 'max' && Number(value) > 0) memoryCeiling = Math.min(memoryCeiling, Number(value) / MIB);
            }
            if (ancestor === mount) break;
            if (!ancestor.startsWith(mount + '/')) throw error('Resource ancestor escaped the cgroup mount.');
          }
          poolLimits = { cpuCores: Math.floor(cpuCeiling * (1 - reserveRatio) * 100) / 100, memoryMiB: Math.floor(memoryCeiling * (1 - reserveRatio)) };
          if (poolLimits.cpuCores < 0.01 || poolLimits.memoryMiB < 1) throw error('No managed resources remain after the host reserve.');
          const pool = kernelPath.join(root, 'vortex-managed-pool');
          try { await io.mkdir(pool); } catch (e) { if (e.code !== 'EEXIST') throw e; }
          const identity = await safeDirectory(pool);
          if (await text(kernelPath.join(pool, 'cgroup.procs'))) throw error('Managed pool contains unexpected direct processes.');
          const values = { 'cpu.max': `${Math.round(poolLimits.cpuCores * PERIOD)} ${PERIOD}`, 'memory.max': String(poolLimits.memoryMiB * MIB), 'memory.swap.max': '0', 'memory.oom.group': '0', 'cgroup.subtree_control': `+cpu +memory${pidsSupported?' +pids':''}` };
          for (const [file, value] of Object.entries(values)) {
            await io.writeFile(kernelPath.join(pool, file), value + '\n');
            const expected = file === 'cgroup.subtree_control' ? `cpu memory${pidsSupported?' pids':''}` : value;
            if (await text(kernelPath.join(pool, file)) !== expected) throw error(m('kernel_ack', file));
          }
          root = pool; rootIdentity = identity;
        }
        initialized = true; unavailableReason = null;
        return capability(true);
      } catch (e) {
        unavailableReason = e.message || m('unavailable');
        return capability(false, unavailableReason);
      }
    })();
    return initializePromise;
  }
  async function capabilities() {
    if (!initialized) return capability(false, unavailableReason || m('startup_initialize'));
    try { await assertRootIdentity(); return capability(true); }
    catch (e) { return capability(false, e.message); }
  }

  function baseEffective(policy, fixed = false, cgroupPath = null) {
    return { mode: policy.mode, applied: false, kernelEnforced: false, enforcement: fixed ? 'cgroup-v2' : null, cpuCores: policy.cpuCores, memoryMiB: policy.memoryMiB, cpuQuotaMicros: fixed ? Math.round(policy.cpuCores * PERIOD) : null, cpuPeriodMicros: fixed ? PERIOD : null, memoryMaxBytes: fixed ? policy.memoryMiB * MIB : null, swapMaxBytes: fixed ? 0 : null, cgroupPath, limitsAreReservations: false, ancestorLimitsApply: true };
  }
  async function prepare(serverId, input, {tasksMax}={}) {
    const policy = normalizeResourcePolicy(input, bounds);
    if(tasksMax!==undefined&&(!Number.isInteger(tasksMax)||tasksMax<16||tasksMax>512||!pidsSupported))throw error('Per-application task limits are unavailable or invalid.',409);
    if (policy.mode === 'shared' && !poolLimits) return makeSharedHandle(policy);
    if (!UUID.test(serverId || '')) throw error(m('uuid'), 400);
    const cap = await capabilities();
    if (!cap.fixedSupported) throw error(cap.reason || m('fixed_unavailable'));
    await assertRootIdentity();
    const name = `vortex-server-${serverId.toLowerCase()}-${nowUUID()}`;
    if (!/^vortex-server-[0-9a-f-]+$/.test(name)) throw error(m('generated_id'));
    const scope = kernelPath.join(root, name);
    let scopeIdentity, created = false;
    try {
      await io.mkdir(scope);
      created = true;
      scopeIdentity = await safeDirectory(scope);
      const applied = policy.mode === 'shared' ? { ...poolLimits, mode: 'shared' } : policy;
      const values = { 'cpu.max': `${Math.round(applied.cpuCores * PERIOD)} ${PERIOD}`, 'memory.max': String(applied.memoryMiB * MIB), 'memory.swap.max': '0', 'memory.oom.group': '1', ...(tasksMax?{'pids.max':String(tasksMax)}:{}) };
      for (const [file, value] of Object.entries(values)) { await io.writeFile(kernelPath.join(scope, file), value + '\n'); if (await text(kernelPath.join(scope, file)) !== value) throw error(m('kernel_ack', file)); }
      const handle = makeFixedHandle(applied, scope, scopeIdentity);
        if (tasksMax) handle.effective.tasksMax = tasksMax;
      handle.policy = { ...policy };
      if (poolLimits) {
        handle.effective.managedPool = { ...poolLimits, reserveRatio, shared: policy.mode === 'shared' };
        // Existing ceilings survive an upgrade; the common ancestor still
        // enforces the smaller pool. Admission rejects new over-allocation.
        handle.effective.effectiveCpuCores = Math.min(applied.cpuCores, poolLimits.cpuCores);
        handle.effective.effectiveMemoryMiB = Math.min(applied.memoryMiB, poolLimits.memoryMiB);
        handle.effective.ancestorConstrained = applied.cpuCores > poolLimits.cpuCores || applied.memoryMiB > poolLimits.memoryMiB;
      }
      handles.add(handle); return handle;
    } catch (cause) {
      const problem = error(m('apply_failed', cause.message), 409, cause);
      if (scopeIdentity) {
        try { await assertScopeIdentity(scope, scopeIdentity); await io.rmdir(scope); }
        catch (cleanupError) { problem.cleanupPending = scope; problem.message += '; ' + m('prepare_cleanup', scope, cleanupError.message); }
      }
      else if (created) problem.cleanupPending = scope;
      throw problem;
    }
  }
  function validateSpawn(executable, opts) {
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) throw error(m('executable'), 400);
    if (!opts || typeof opts !== 'object' || opts.shell || opts.detached) throw error(m('direct_execution'), 400);
    if (opts.stdio && (opts.stdio.length !== 3 || opts.stdio.some(value => value !== 'pipe'))) throw error(m('streams'), 400);
  }
  function validateArguments(args) {
    if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16384) || args.reduce((size,value)=>size+Buffer.byteLength(value),0)>131072) throw error('Invalid direct process arguments.',400);
  }
  function makeSharedHandle(policy) {
    const effective = baseEffective(policy); let used = false;
    return { policy: { ...policy }, effective,
      spawn(executable, opts = {}) { return this.spawnWithArgs(executable, [], opts); },
      spawnWithArgs(executable, args, opts = {}, {cleanEnvironment=false}={}) {
        validateArguments(args);
        validateSpawn(executable, opts); if (used) throw error(m('handle_once')); used = true;
        const env=cleanEnvironment?{...(opts.env||{})}:opts.env?{...opts.env}:undefined;
        if(env){delete env.BASH_ENV;delete env.ENV;}
        const child = launch(executable, args, { ...opts, ...(env?{env}:{}), shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
        const ready = new Promise((resolve, reject) => { child.once('spawn', () => { effective.applied = true; resolve({ ...effective }); }); child.once('error', reject); });
        return { child, ready };
      },
      async stats() { return null; },
      async cleanup() { return { ok: true, removed: false, mode: 'shared' }; },
    };
  }
  function makeFixedHandle(policy, scope, scopeIdentity) {
    const relative = '/' + kernelPath.relative(mount, scope);
    const effective = baseEffective(policy, true, relative);
    let used = false, child = null, childClosed = false, removed = false, lastStats = null;
    async function assertScope() {
      await assertScopeIdentity(scope, scopeIdentity);
    }
    async function stats() {
      if (removed) return lastStats;
      await assertScope();
      const cpu = parsePairs(await text(kernelPath.join(scope, 'cpu.stat')));
      const events = parsePairs(await text(kernelPath.join(scope, 'memory.events')));
      let anonymous = null;
      try { const memory = parsePairs(await text(kernelPath.join(scope, 'memory.stat'))); anonymous = Number.isSafeInteger(memory.anon) ? memory.anon : null; } catch (e) { if (!absent(e)) throw e; }
      let peak = null;
      try { peak = Number(await text(kernelPath.join(scope, 'memory.peak'))); } catch (e) { if (!absent(e)) throw e; }
      lastStats = { memoryCurrentBytes: Number(await text(kernelPath.join(scope, 'memory.current'))), memoryAnonymousBytes: anonymous, memoryPeakBytes: peak, cpuUsageUsec: cpu.usage_usec || 0, nrThrottled: cpu.nr_throttled || 0, throttledUsec: cpu.throttled_usec || 0, memoryMaxEvents: events.max || 0, oomKills: events.oom_kill || 0, oomEvents: events.oom || 0, effective: { ...effective } };
      return { ...lastStats, effective: { ...effective } };
    }
    const handle = { policy: { ...policy }, effective, stats,
      spawn(executable, opts = {}) { return this.spawnWithArgs(executable, [], opts); },
      spawnWithArgs(executable, args, opts = {}, {cleanEnvironment=false}={}) {
        validateArguments(args);
        validateSpawn(executable, opts); if (used || removed) throw error(m('handle_once')); used = true;
        const env = { ...(cleanEnvironment?{}:process.env), ...(opts.env || {}) }; delete env.BASH_ENV; delete env.ENV;
        const token = nowUUID();
        if (!UUID.test(token)) throw error(m('ack_identity'));
        child = launch('/bin/bash', ['-c', RESOURCE_EXEC_WRAPPER, 'vortex-resource-exec', scope, executable, relative, token, String(effective.cpuQuotaMicros), String(effective.memoryMaxBytes), ...args], { ...opts, env, shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
        child.once('close', () => { childClosed = true; });
        const ready = new Promise((resolve, reject) => {
          let settled = false, frame = '', timer;
          const finish = (problem) => {
            if (settled) return; settled = true; clearTimeout(timer);
            if (problem) { if (!childClosed && child.pid) child.kill('SIGKILL'); reject(problem); }
            else { effective.applied = true; effective.kernelEnforced = true; resolve({ ...effective }); }
          };
          timer = setTimeout(() => finish(error(m('attach_timeout'))), readinessMs);
          child.once('error', cause => finish(error(m('launcher_start', cause.message), 409, cause)));
          child.once('close', (code, signal) => finish(error(m('launcher_exit', code, signal || 'none'))));
          const gate = child.stdio[3];
          if (!gate) return finish(error(m('ack_channel')));
          gate.setEncoding('utf8');
          gate.on('data', chunk => {
            frame += chunk;
            if (frame.length > 200) return finish(error(m('ack_invalid')));
            if (!frame.includes('\n')) return;
            if (frame !== `${token}:${child.pid}\n`) return finish(error(m('ack_pid')));
            finish();
          });
          gate.once('error', cause => finish(error(m('ack_failed'), 409, cause)));
          gate.once('end', () => { if (!settled) finish(error(m('ack_closed'))); });
        });
        return { child, ready };
      },
      async cleanup() {
        if (removed) return { ok: true, removed: true, alreadyRemoved: true };
        if (child?.pid && !childClosed) throw error(m('active_cleanup'));
        try {
          await assertScope();
          const warnings = [];
          try { await stats(); } catch (e) { warnings.push(m('stats_cleanup', e.message)); }
          await assertScope();
          let events = parsePairs(await text(kernelPath.join(scope, 'cgroup.events')));
          if (events.populated) {
            // Only this launch's inode-verified group may be killed after its
            // direct child has closed. Never enumerate/replay arbitrary PIDs.
            await assertScope();
            await io.writeFile(kernelPath.join(scope, 'cgroup.kill'), '1\n');
            for (let count = 0; count < 40 && events.populated; count++) { await pause(50); events = parsePairs(await text(kernelPath.join(scope, 'cgroup.events'))); }
            if (events.populated) throw error(m('descendants'));
          }
          await assertScope();
          await io.rmdir(scope); removed = true; effective.applied = false; effective.kernelEnforced = false; handles.delete(handle); return { ok: true, removed: true, stats: lastStats, warnings };
        } catch (cause) {
          if (absent(cause)) { removed = true; effective.applied = false; effective.kernelEnforced = false; handles.delete(handle); return { ok: true, removed: true, alreadyRemoved: true, stats: lastStats }; }
          const problem = error(m('cleanup_failed', relative, cause.message), 409, cause); problem.cleanupPending = relative; throw problem;
        }
      },
    };
    return handle;
  }
  return { initialize, capabilities, prepare, normalize: input => normalizeResourcePolicy(input, bounds) };
}
