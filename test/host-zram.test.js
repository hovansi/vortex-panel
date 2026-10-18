import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHostZramController, validateZramRequest, hostZramErrorPayload } from '../server/host-zram.js';
import { evaluateCapacity } from '../server/capacity.js';
import { parseHostMemory } from '../server/host-telemetry.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
async function fixture(t, changes = {}) {
  const dataDir = changes.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-zram-'));
  const calls = [], gates = [], releases = [], audits = [];
  let state = { available: true, ownership: 'none', physicalMemoryBytes: 2 * GIB, configured: { enabled: false, profile: 'auto' },
    effective: { enabled: false, logicalSizeBytes: 0, swapUsedBytes: 0, residentBytes: 0 },
    recommended: { logicalSizeBytes: GIB, residentLimitBytes: 512 * MIB }, revision: 'a'.repeat(64) };
  const controller = createHostZramController({ dataDir,
    store: { audit(...args) { audits.push(args); } },
    manager: { beginMaintenance(value) { gates.push(value); return () => releases.push(value); } },
    inspect: async () => structuredClone(state),
    apply: async input => { calls.push(input); state = { ...state, ownership: 'vortex', configured: { enabled: input.enabled, profile: 'auto' },
      effective: { ...state.effective, enabled: input.enabled }, revision: input.enabled ? 'b'.repeat(64) : 'c'.repeat(64),
      operation: { requestId: input.requestId, status: 'completed' } }; return structuredClone(state); }, ...changes });
  if (!changes.dataDir) t.after(async () => { await controller.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { controller, dataDir, calls, gates, releases, audits, setState(value) { state = value; }, getState() { return structuredClone(state); },
    input: async enabled => ({ nodeId: 'local', enabled, profile: 'auto', confirmed: true, requestId: randomUUID(), revision: (await controller.read()).revision }) };
}

test('zram request accepts no password, device, size, command or unconfirmed change at the worker boundary', async t => {
  const f = await fixture(t), valid = await f.input(true);
  assert.equal(validateZramRequest(valid), valid);
  for (const key of ['password', 'device', 'size', 'command', 'helperPath', 'force']) assert.throws(() => validateZramRequest({ ...valid, [key]: 'anything' }), { code: 'ZRAM_INPUT' });
  assert.throws(() => validateZramRequest({ ...valid, enabled: 1 }), { code: 'ZRAM_INPUT' });
  assert.throws(() => validateZramRequest({ ...valid, profile: 'custom' }), { code: 'ZRAM_INPUT' });
  assert.throws(() => validateZramRequest({ ...valid, confirmed: false }), { code: 'ZRAM_CONFIRM' });
  assert.throws(() => validateZramRequest({ ...valid, requestId: '$(reboot)' }), { code: 'ZRAM_INPUT' });
});

test('durable intent precedes helper, successful mutation releases exclusion and duplicate UUID does not execute twice', async t => {
  const f = await fixture(t), input = await f.input(true);
  const result = await f.controller.request(input, { user: { username: 'admin' } });
  assert.equal(result.operation.status, 'completed'); assert.equal(result.zram.busy, false);
  assert.equal(result.zram.effective.enabled, true); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].role, 'panel'); assert.equal(f.calls[0].revision, 'a'.repeat(64));
  assert.equal(f.gates[0].action, 'zram'); assert.equal(f.releases.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'zram-operations.json'), 'utf8'));
  assert.equal(saved.records[0].requestId, input.requestId); assert.equal(saved.records[0].status, 'completed');
  assert.equal((await f.controller.request(input)).replayed, true); assert.equal(f.calls.length, 1);
  await assert.rejects(f.controller.request({ ...input, enabled: false }), { code: 'ZRAM_INPUT' });
});

test('stale target, changed revision, foreign ownership and busy maintenance never reach the helper', async t => {
  const f = await fixture(t), input = await f.input(true);
  await assert.rejects(f.controller.request({ ...input, nodeId: randomUUID() }), { code: 'ZRAM_TARGET' });
  await assert.rejects(f.controller.request({ ...input, revision: '0'.repeat(64) }), { code: 'ZRAM_STALE' });
  assert.equal(f.calls.length, 0); assert.equal(f.gates.length, 0);
  f.setState({ ...f.getState(), available: false, reasonCode: 'ZRAM_EXTERNAL', ownership: 'external' });
  await assert.rejects(f.controller.request(await f.input(true)), { code: 'ZRAM_EXTERNAL' });
  assert.equal(f.calls.length, 0);
  const busy = await fixture(t, { manager: { beginMaintenance() { throw Error('inflight backup'); } } });
  await assert.rejects(busy.controller.request(await busy.input(true)), { code: 'ZRAM_BUSY' });
  assert.equal(busy.calls.length, 0);
});

test('concurrent requests are excluded before yielding to the helper and audit failure cannot mutate OS', async t => {
  let releaseApply, entered;
  const admitted = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { apply: input => { entered(); return new Promise(resolve => { releaseApply = () => resolve({ ...f.getState(), configured: { enabled: true, profile: 'auto' }, effective: { enabled: true }, revision: 'b'.repeat(64) }); }); } });
  const input = await f.input(true), pending = f.controller.request(input);
  await admitted;
  await assert.rejects(f.controller.request({ ...input, requestId: randomUUID() }), { code: 'ZRAM_BUSY' });
  releaseApply(); await pending;
  const failed = await fixture(t, { store: { audit() { throw Error('private disk path'); } } });
  await assert.rejects(failed.controller.request(await failed.input(true)), error => {
    const payload = hostZramErrorPayload(error, 'vi'); assert.equal(payload.code, 'ZRAM_AUDIT');
    assert.equal(payload.error, payload.errorI18n.vi); assert.equal(JSON.stringify(payload).includes('private'), false); return true;
  });
  assert.equal(failed.calls.length, 0); assert.equal(failed.releases.length, 1);
});

test('known pressure refusal preserves observed state and releases admission', async t => {
  const f = await fixture(t, { apply: async () => { throw Object.assign(Error('pressure'), { code: 'ZRAM_PRESSURE', status: 409 }); } });
  f.setState({ ...f.getState(), ownership: 'vortex', configured: { enabled: true, profile: 'auto' }, effective: { enabled: true, swapUsedBytes: GIB, residentBytes: 400 * MIB } });
  await assert.rejects(f.controller.request(await f.input(false)), error => error.code === 'ZRAM_PRESSURE' && error.zram.effective.enabled === true && error.zram.busy === false);
  assert.equal(f.releases.length, 1); assert.equal((await f.controller.read()).lastOperation.status, 'failed');
});

test('uncertain helper outcome holds maintenance, never replays OS action and reconciles only matching terminal observation', async t => {
  let attempts = 0;
  const f = await fixture(t, { apply: async () => { attempts++; throw Object.assign(Error('timeout'), { code: 'ZRAM_UNKNOWN', outcomeUnknown: true, status: 504 }); } });
  const input = await f.input(true);
  await assert.rejects(f.controller.request(input), error => error.outcomeUnknown && error.zram.busy);
  assert.equal(f.releases.length, 0);
  assert.equal((await f.controller.request(input)).operation.status, 'unknown'); assert.equal(attempts, 1);
  await assert.rejects(f.controller.request(await f.input(false)), { code: 'ZRAM_BUSY' });
  f.setState({ ...f.getState(), operation: { requestId: randomUUID(), status: 'completed' } });
  assert.equal((await f.controller.read()).busy, true);
  f.setState({ ...f.getState(), configured: { enabled: true, profile: 'auto' }, effective: { enabled: true }, operation: { requestId: input.requestId, status: 'completed' } });
  assert.equal((await f.controller.read()).busy, false); assert.equal(f.releases.length, 1);
  assert.equal((await f.controller.read()).lastOperation.status, 'completed');
});

test('restart restores an unfinished durable operation before allowing mutations', async t => {
  const first = await fixture(t, { apply: async () => { throw Object.assign(Error('interrupted'), { code: 'ZRAM_UNKNOWN', outcomeUnknown: true }); } });
  const input = await first.input(true); await assert.rejects(first.controller.request(input));
  const restored = await fixture(t, { dataDir: first.dataDir });
  assert.equal((await restored.controller.read()).busy, true);
  assert.equal(restored.gates[0].restore, true); assert.equal(restored.gates[0].requestId, input.requestId);
  await assert.rejects(restored.controller.request(await restored.input(true)), { code: 'ZRAM_BUSY' });
  restored.setState({ ...restored.getState(), operation: { requestId: input.requestId, status: 'failed', errorCode: 'ZRAM_SYSTEM' } });
  assert.equal((await restored.controller.read()).busy, false); assert.equal(restored.releases.length, 1);
  await restored.controller.close();
});

test('a corrupted durable journal freezes host admission instead of merely hiding the zram buttons', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-zram-corrupt-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'zram-operations.json'), '{partial private journal');
  const f = await fixture(t, { dataDir });
  const status = await f.controller.read();
  assert.equal(status.available, false); assert.equal(status.busy, true);
  assert.equal(status.reasonI18n.id, 'panel.zram.recovery');
  assert.equal(f.gates.length, 1); assert.equal(f.gates[0].restore, true);
  assert.equal(f.gates[0].action, 'zram'); assert.equal(f.releases.length, 0);
  await assert.rejects(f.controller.request({ nodeId: 'local', enabled: true, profile: 'auto', confirmed: true, requestId: randomUUID(), revision: status.revision }), { code: 'ZRAM_BUSY' });
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.readFile(path.join(dataDir, 'zram-operations.json'), 'utf8'), '{partial private journal');
  await f.controller.close();
});

test('an unfinished helper journal restores exclusion even if the controller journal is absent', async t => {
  const f = await fixture(t), requestId = randomUUID();
  f.setState({ ...f.getState(), operation: { requestId, enabled: true, status: 'running' } });
  const state = await f.controller.read();
  assert.equal(state.busy, true); assert.equal(state.lastOperation.requestId, requestId);
  assert.equal(f.gates[0].restore, true); assert.equal(f.gates[0].requestId, requestId);
  await assert.rejects(f.controller.request(await f.input(false)), { code: 'ZRAM_BUSY' });
  assert.equal(f.calls.length, 0);
  f.setState({ ...f.getState(), operation: { requestId, enabled: true, status: 'failed' } });
  assert.equal((await f.controller.read()).busy, false);
  assert.equal(f.releases.length, 1);
});

test('power and removal maintenance is visible in zram status without changing stable revision', async t => {
  let maintenance = null;
  const f = await fixture(t, { manager: { maintenanceStatus: () => maintenance, beginMaintenance() { if (maintenance) throw Error('power pending'); return () => {}; } } });
  const before = await f.controller.read();
  assert.equal(before.busy, false);
  maintenance = { active: true, action: 'reboot', requestId: randomUUID() };
  const during = await f.controller.read();
  assert.equal(during.busy, true); assert.equal(during.revision, before.revision);
  await assert.rejects(f.controller.request(await f.input(true)), { code: 'ZRAM_BUSY' });
  assert.equal(f.calls.length, 0);
  maintenance = null;
  assert.equal((await f.controller.read()).busy, false);
});

test('native controls remain unavailable on non-Linux and demo; no helper or ownership file is created', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-zram-disabled-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  for (const options of [{ platform: 'win32', uid: 0 }, { platform: 'linux', uid: 1000 }, { platform: 'linux', uid: 0, demo: true }]) {
    const controller = createHostZramController({ dataDir, ...options });
    assert.equal((await controller.read()).available, false);
    await assert.rejects(controller.request({ nodeId: 'local', enabled: true, profile: 'auto', confirmed: true, revision: (await controller.read()).revision, requestId: randomUUID() }), { code: 'ZRAM_UNAVAILABLE' });
    await controller.close();
  }
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test('swap and zram never inflate physical admission or bypass critical physical RAM pressure', () => {
  const memory = parseHostMemory('MemTotal: 2097152 kB\nMemAvailable: 131072 kB\nSwapTotal: 2147483648 kB\nSwapFree: 2147483648 kB\n');
  assert.equal(memory.totalBytes, 2 * GIB); assert.equal(memory.availableBytes, 128 * MIB); assert.equal(memory.swapTotalBytes, 2 * 1024 * GIB);
  const physical = { cpus: 2, memoryTotal: memory.totalBytes, memoryAvailable: memory.availableBytes, diskTotal: 100 * GIB, diskAvailableBytes: 80 * GIB };
  const candidate = { id: 'new', resourcePolicy: { mode: 'fixed', cpuCores: 0.5, memoryMiB: 2049 }, storagePolicy: { mode: 'fixed', diskGiB: 5 } };
  for (const reserveRatio of [0, 0.1]) {
    const now = () => 1792141200000;
    const base = evaluateCapacity({ host: physical, reserveRatio, candidate, now });
    const expanded = evaluateCapacity({ host: { ...physical, swapTotal: 200 * GIB, swapAvailable: 200 * GIB, swapTotalBytes: 200 * GIB,
      zram: { logicalSizeBytes: 200 * GIB, residentLimitBytes: 100 * GIB }, memory: { swapTotalBytes: 200 * GIB } }, reserveRatio, candidate, now });
    assert.deepEqual(expanded, base); assert.ok(base.reasons.includes('CAPACITY_MEMORY'));
    assert.ok(base.reasons.includes('CAPACITY_MEMORY_PRESSURE')); assert.ok(base.capacity.memory.allocatableBytes <= 2 * GIB);
  }
});

test('Python helper validates conservative sizing, foreign ownership and refusal paths without touching host OS', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const { stdout } = await promisify(execFile)(python, ['test/host-zram-helper.py'], { timeout: 30000, maxBuffer: 65536, windowsHide: true });
  assert.match(stdout, /helper safety checks passed/);
});

test('Python statistics keep swap slots, original data, compressed payload and physical allocator usage distinct', async () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const { stderr } = await promisify(execFile)(python, ['test/host-zram-statistics.py'], { timeout: 30000, maxBuffer: 65536, windowsHide: true });
  assert.match(stderr, /Ran 9 tests/); assert.match(stderr, /\bOK\b/);
});

test('zram public status preserves additive host swap buckets without exposing device paths or sharing mutable observations', async t => {
  const f = await fixture(t), observed = f.getState();
  observed.effective = { ...observed.effective, originalDataBytes: 1052672, compressedDataBytes: 204800, residentBytes: 516096 };
  observed.observedAt = '2026-10-17T06:00:00Z';
  observed.swapSummary = { source: '/proc/swaps', scope: 'host', totalBytes: GIB, usedBytes: MIB, zram: { totalBytes: GIB, usedBytes: MIB, areas: 1 }, other: { totalBytes: 0, usedBytes: 0, areas: 0 }, unknown: { totalBytes: 0, usedBytes: 0, areas: 0 }, complete: true };
  const controller = createHostZramController({ dataDir: f.dataDir, inspect: async () => observed }); t.after(() => controller.close());
  const result = await controller.read(); assert.deepEqual(result.swapSummary, observed.swapSummary);
  assert.equal(result.observedAt, observed.observedAt);
  assert.equal(result.effective.originalDataBytes, 1052672); assert.equal(result.effective.compressedDataBytes, 204800); assert.equal(result.effective.residentBytes, 504*1024);
  result.swapSummary.zram.usedBytes = 99; result.effective.compressedDataBytes = 0;
  assert.equal((await controller.read()).swapSummary.zram.usedBytes, MIB); assert.equal((await controller.read()).effective.compressedDataBytes, 204800);
  assert.equal('path' in result.swapSummary.zram, false);
  observed.observedAt = undefined; assert.equal((await controller.read()).observedAt, null);
});
