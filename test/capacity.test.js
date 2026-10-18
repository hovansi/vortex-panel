import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCapacity, createCapacityGate, serverCapacityAllocation } from '../server/capacity.js';
import { normalizeStoragePolicy } from '../server/storage-policy.js';

const GIB = 1024 ** 3, MIB = 1024 ** 2;
const NOW = Date.parse('2026-10-15T03:00:00Z');
const host = changes => ({ cpus: 2, memoryTotal: 4 * GIB, memoryAvailable: 4 * GIB, diskTotal: 100 * GIB, diskAvailable: 80 * GIB, ...changes });
const fixed = (id, cpuCores = 0.5, memoryMiB = 512, diskGiB = 5) => ({ id, status: 'stopped', resourcePolicy: { mode: 'fixed', cpuCores, memoryMiB }, storagePolicy: { mode: 'fixed', diskGiB } });
const assess = options => evaluateCapacity({ host: host(), servers: [], now: () => NOW, ...options });

test('capacity preserves ten percent, counts stopped ceilings and separately labels shared minimum credits', () => {
  const shared = { id: 'shared', resourcePolicy: { mode: 'shared' }, admissionReservation: { cpuCores: 0.1, memoryMiB: 512 } };
  const servers = [fixed('stopped', 0.9), shared];
  const result = assess({ servers, candidate: fixed('new', 0.8) });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.capacity.cpu, { totalCores: 2, effectiveTotalCores: 2, reservedCores: 0.2, allocatableCores: 1.8, allocatedCores: 1, availableCores: 0.8 });
  assert.equal(result.capacity.memory.allocatedBytes, 1024 * MIB);
  assert.equal(result.capacity.legacyUnlimitedServerCount, 1);
  assert.deepEqual(serverCapacityAllocation(shared), { cpuCores: 0.1, memoryMiB: 512, diskGiB: null, source: 'shared-reservation' });
  assert.deepEqual(assess({ servers, candidate: fixed('new', 0.81) }).reasons, ['CAPACITY_CPU']);
});

test('resource-only workers have no percentage reserve but still enforce physical capacity and critical RAM pressure', async () => {
  const result = assess({ reserveRatio: 0, candidate: fixed('full-worker', 2, 4096, 80) });
  assert.equal(result.allowed, true);
  assert.equal(result.capacity.reserveRatio, 0);
  assert.equal(result.capacity.cpu.reservedCores, 0);
  assert.equal(result.capacity.cpu.allocatableCores, 2);
  assert.equal(result.capacity.memory.reservedBytes, 0);
  assert.equal(result.capacity.memory.allocatableBytes, 4 * GIB);
  assert.equal(result.capacity.storage.reservedBytes, 0);
  assert.equal(result.capacity.storage.maxNewDiskGiB, 80);
  assert.deepEqual(assess({ reserveRatio: 0, candidate: fixed('too-large', 2.01, 4097, 81) }).reasons, ['CAPACITY_CPU', 'CAPACITY_MEMORY', 'CAPACITY_DISK']);
  assert.deepEqual(assess({ reserveRatio: 0, host: host({ memoryAvailable: 128 * MIB }), candidate: fixed('critical') }).reasons, ['CAPACITY_MEMORY_PRESSURE']);
  const gate = createCapacityGate({ readHost: () => host(), listServers: () => [], reserveRatio: 0, now: () => NOW });
  await gate.run({ candidate: fixed('full-worker', 2, 4096, 80) }, assessment => assert.equal(assessment.capacity.reserveRatio, 0));
  await gate.close();
  for (const reserveRatio of [-0.1, NaN, Infinity, 0.51]) assert.throws(() => assess({ reserveRatio }), { code: 'CAPACITY_INPUT' });
});

test('preallocated images are not subtracted twice from physical disk availability', () => {
  const result = assess({ host: host({ diskAvailable: 20 * GIB }), servers: [fixed('old', 0.1, 512, 80)], candidate: fixed('new', 0.1, 512, 5) });
  assert.equal(result.allowed, true);
  assert.equal(result.capacity.storage.allocatedBytes, 80 * GIB);
  assert.equal(result.capacity.storage.availableBytes, 10 * GIB);
  assert.equal(result.capacity.storage.maxNewDiskGiB, 10);
  assert.equal(result.additionalDiskBytes, 5 * GIB);
  assert.deepEqual(assess({ host: host({ diskAvailable: 20 * GIB }), candidate: fixed('too-large', 0.1, 512, 11) }).reasons, ['CAPACITY_DISK']);
});

test('RAM allocation budget remains ninety percent of total despite OS use and managed sample changes', () => {
  const physical = 2 * GIB, available = Math.floor(1.4 * GIB), budget = physical - Math.ceil(physical * 0.1);
  const maximum = Math.floor(budget / MIB);
  const result = assess({ host: host({ memoryTotal: physical, memoryAvailable: available }), candidate: fixed('all', 0.1, maximum) });
  assert.equal(result.allowed, true); assert.equal(result.capacity.memory.allocatableBytes, budget);
  assert.equal(result.capacity.memory.availableBytes, budget); assert.equal(result.capacity.memory.reservedBytes, Math.ceil(physical * 0.1));
  assert.equal(result.capacity.memory.currentMemAvailableBytes, available);
  assert.ok(result.capacity.memory.pressureSafeAvailableBytes < budget);
  assert.deepEqual(result.warnings, ['CAPACITY_MEMORY_HEADROOM']);
  assert.equal(result.capacity.memory.limitsAreReservations, false);
  assert.deepEqual(assess({ host: host({ memoryTotal: physical, memoryAvailable: available }), candidate: fixed('too-large', 0.1, maximum + 1) }).reasons, ['CAPACITY_MEMORY']);
  const nominal = assess({ host: host({ memoryTotal: 2_000_000_000, memoryAvailable: 1_400_000_000 }) }).capacity.memory;
  assert.equal(nominal.totalBytes, 2_000_000_000); assert.equal(nominal.allocatableBytes, 1_800_000_000);
  assert.ok(nominal.allocatableBytes / GIB < 1.8, 'Nominal GB must not be relabelled as GiB');
});

test('measured pressure remains separate and stale or dead managed samples cannot inflate headroom', () => {
  const managed = { ...fixed('old', 0.1, 1024), status: 'running', pid: 123, capacityUsage: { memoryBytes: GIB, sampledAt: NOW - 2000 } };
  const result = assess({ host: host({ memoryAvailable: 2 * GIB }), servers: [managed], candidate: fixed('new', 0.1, 1536) });
  assert.equal(result.allowed, true);
  assert.equal(result.capacity.memory.managedUsedBytes, GIB);
  assert.equal(result.capacity.memory.externalUsedBytes, GIB);
  assert.equal(result.capacity.memory.pressureAware, true);
  const stale = assess({ host: host({ memoryAvailable: 2 * GIB }), servers: [{ ...managed, capacityUsage: { memoryBytes: GIB, sampledAt: NOW - 16000 } }], candidate: fixed('new', 0.1, 1024) });
  assert.equal(stale.capacity.memory.managedUsedBytes, 0);
  assert.deepEqual(stale.reasons, []); assert.equal(stale.allowed, true);
  assert.deepEqual(stale.warnings, ['CAPACITY_MEMORY_HEADROOM']);
  assert.equal(stale.capacity.memory.availableBytes, result.capacity.memory.availableBytes);
  assert.equal(stale.capacity.memory.allocatableBytes, result.capacity.memory.allocatableBytes);
  assert.ok(stale.capacity.memory.pressureSafeAvailableBytes < result.capacity.memory.pressureSafeAvailableBytes);
  const dead = assess({ host: host({ memoryAvailable: 2 * GIB }), servers: [{ ...managed, pid: null }], candidate: fixed('new', 0.1, 1024) });
  assert.equal(dead.capacity.memory.managedUsedBytes, 0);
});

test('only critical observed RAM headroom blocks new or increased ceilings; safe decreases remain available', () => {
  const critical = host({ memoryTotal: 2 * GIB, memoryAvailable: 128 * MIB });
  const denied = assess({ host: critical, candidate: fixed('new', 0.1, 512) });
  assert.deepEqual(denied.reasons, ['CAPACITY_MEMORY_PRESSURE']); assert.equal(denied.capacity.memory.minimumSafeBytes, 256 * MIB);
  assert.equal(denied.capacity.memory.criticalHeadroomBytes, 0); assert.equal(denied.capacity.memory.allocatableBytes, 2 * GIB - Math.ceil(0.2 * GIB));
  const old = fixed('old', 0.1, 1024);
  for (const amount of [512, 1024]) assert.equal(assess({ host: critical, servers: [old], replaceServerId: old.id, candidate: fixed(old.id, 0.1, amount) }).allowed, true);
  assert.deepEqual(assess({ host: critical, servers: [old], replaceServerId: old.id, candidate: fixed(old.id, 0.1, 1536) }).reasons, ['CAPACITY_MEMORY_PRESSURE']);
  const safe = host({ memoryTotal: 2 * GIB, memoryAvailable: Math.ceil(0.2 * GIB) + 256 * MIB });
  assert.equal(assess({ host: safe, candidate: fixed('all', 0.1, 1843) }).allowed, true);
  assert.equal(assess({ host: critical }).capacity.memory.pressureWarning, true);
});

test('legacy unlimited storage may remain only when editing that existing legacy server', () => {
  const legacy = { id: 'legacy', resourcePolicy: { mode: 'shared' } };
  const result = assess({ servers: [legacy], replaceServerId: 'legacy', candidate: { ...legacy, resourcePolicy: { mode: 'fixed', cpuCores: 0.5, memoryMiB: 768 }, storagePolicy: { mode: 'unlimited', diskGiB: null } } });
  assert.equal(result.allowed, true); assert.equal(result.additionalDiskBytes, 0);
  assert.equal(result.allocation.diskGiB, null);
  assert.throws(() => assess({ candidate: { ...legacy, storagePolicy: { mode: 'unlimited' } } }), { code: 'STORAGE_POLICY' });
  assert.throws(() => assess({ servers: [fixed('fixed')], replaceServerId: 'fixed', candidate: { ...legacy, storagePolicy: { mode: 'unlimited' } } }), { code: 'STORAGE_POLICY' });
  assert.equal(assess({ servers: [fixed('fixed')], replaceServerId: 'fixed', candidate: fixed('fixed', 0.5, 512, 8) }).additionalDiskBytes, 3 * GIB);
});

test('invalid or missing physical capacity and duplicate managed identity fail closed', () => {
  assert.throws(() => assess({ host: host({ memoryAvailable: undefined }) }), { code: 'CAPACITY_INPUT', status: 503 });
  assert.throws(() => assess({ host: host({ diskAvailable: -1 }) }), { code: 'CAPACITY_INPUT', status: 503 });
  for (const sampledAt of [NOW - 15001, NOW + 1001, 'not-a-date', null]) assert.throws(() => assess({ host: host({ sampledAt }), candidate: fixed('new') }), { code: 'CAPACITY_INPUT', status: 503 });
  assert.equal(assess({ host: host({ sampledAt: NOW - 1000 }), candidate: fixed('new') }).allowed, true);
  assert.throws(() => assess({ servers: [fixed('same'), fixed('same')] }), { code: 'CAPACITY_INPUT' });
  assert.throws(() => assess({ servers: [{ id: 'shared', admissionReservation: { cpuCores: 0.01, memoryMiB: 1 } }] }), { code: 'CAPACITY_INPUT' });
  assert.deepEqual(normalizeStoragePolicy(), { mode: 'fixed', diskGiB: 5 });
  assert.deepEqual(normalizeStoragePolicy(undefined, { legacy: true }), { mode: 'unlimited', diskGiB: null });
});

test('ancestor fractional CPU and RAM ceilings constrain admission without mislabelling physical totals', () => {
  const result = assess({ host: host({ limits: { effectiveCpuCores: 0.5, memoryMaxBytes: GIB } }), candidate: fixed('small', 0.4, 768) });
  assert.equal(result.allowed, true);
  assert.equal(result.capacity.cpu.totalCores, 2); assert.equal(result.capacity.cpu.effectiveTotalCores, 0.5);
  assert.equal(result.capacity.cpu.allocatableCores, 0.45); assert.equal(result.capacity.cpu.reservedCores, 0.05);
  assert.equal(result.capacity.memory.totalBytes, 4 * GIB); assert.equal(result.capacity.memory.effectiveTotalBytes, GIB);
  assert.deepEqual(assess({ host: host({ limits: { effectiveCpuCores: 0.5, memoryMaxBytes: GIB } }), candidate: fixed('large', 0.5, 1024) }).reasons, ['CAPACITY_CPU', 'CAPACITY_MEMORY']);
});

test('serialized admission sees a committed predecessor and cannot spend the same CPU budget twice', async () => {
  const rows = []; let reads = 0, started, finish;
  const waiting = new Promise(resolve => { started = resolve; });
  const blocker = new Promise(resolve => { finish = resolve; });
  const gate = createCapacityGate({ readHost: async () => { reads++; return host(); }, listServers: () => rows, now: () => NOW });
  const first = gate.run({ candidate: fixed('first', 1) }, async () => { started(); await blocker; rows.push(fixed('first', 1)); return 'committed'; });
  await waiting;
  const second = gate.run({ candidate: fixed('second', 1) }, () => assert.fail('Overbooked callback must not run'));
  await Promise.resolve(); assert.equal(reads, 1);
  finish(); assert.equal(await first, 'committed');
  await assert.rejects(second, { code: 'CAPACITY_CPU', status: 409 });
  assert.equal(reads, 2); await gate.close();
  await assert.rejects(gate.run({}, () => {}), { code: 'CAPACITY_CLOSED' });
});

test('serialized ceiling admission cannot spend remaining RAM twice even when both full ceilings fit observed free memory', async () => {
  const rows = [], h = host({ memoryTotal: 2 * GIB, memoryAvailable: Math.floor(1.4 * GIB) });
  const gate = createCapacityGate({ readHost: () => h, listServers: () => rows, now: () => NOW });
  const first = gate.run({ candidate: fixed('first', 0.1, 1024) }, () => { rows.push(fixed('first', 0.1, 1024)); return true; });
  const second = gate.run({ candidate: fixed('second', 0.1, 1024) }, () => assert.fail('Cannot overspend the stable logical budget'));
  assert.equal(await first, true); await assert.rejects(second, { code: 'CAPACITY_MEMORY', status: 409 }); await gate.close();
});

test('a rolled-back admission callback releases the gate for the next fresh assessment', async () => {
  const gate = createCapacityGate({ readHost: () => host(), listServers: () => [], now: () => NOW });
  await assert.rejects(gate.run({ candidate: fixed('a') }, () => { throw new Error('durable commit failed'); }), /durable commit failed/);
  assert.equal(await gate.run({ candidate: fixed('b') }, result => result.allowed), true);
  await gate.close();
});
