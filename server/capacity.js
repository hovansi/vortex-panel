import { normalizeStoragePolicy, GIB } from './storage-policy.js';

const MIB = 1024 ** 2;
export const SHARED_ADMISSION_RESERVATION = Object.freeze({ cpuCores: 0.1, memoryMiB: 512 });
const messages = Object.freeze({
  CAPACITY_INPUT: ['Host capacity or allocation data is invalid.', 'Dữ liệu dung lượng máy chủ hoặc cấp phát không hợp lệ.'],
  CAPACITY_CPU: ['There is insufficient CPU capacity for this allocation.', 'Tài nguyên CPU còn lại không đủ để cấp phát.'],
  CAPACITY_MEMORY: ['There is insufficient RAM capacity for this allocation.', 'Dung lượng RAM còn lại không đủ để cấp phát.'],
  CAPACITY_MEMORY_PRESSURE: ['Current free RAM is below the minimum safe headroom. Free memory before starting a server or adding or increasing an allocation.', 'RAM trống hiện dưới mức an toàn tối thiểu. Hãy giải phóng RAM trước khi khởi động server hoặc thêm hay tăng cấp phát.'],
  CAPACITY_MEMORY_HEADROOM: ['The configured RAM ceiling exceeds current pressure-safe headroom. Limits do not reserve dedicated physical RAM.', 'Trần RAM đã chọn vượt phần RAM an toàn hiện tại. Giới hạn không dành riêng RAM vật lý.'],
  CAPACITY_DISK: ['There is insufficient available storage for this operation.', 'Dung lượng lưu trữ còn lại không đủ cho thao tác này.'],
  CAPACITY_CLOSED: ['Capacity admission is shutting down.', 'Bộ cấp phát tài nguyên đang tắt.'],
});
export const CAPACITY_MESSAGES = Object.freeze(Object.entries(messages).map(([code, [en, vi]]) => Object.freeze({ id: `panel.capacity.${code.toLowerCase()}`, en, vi })));
function fail(code, status = 400, assessment) {
  const [en, vi] = messages[code];
  throw Object.assign(new Error(en), { code, status, errorI18n: { id: `panel.capacity.${code.toLowerCase()}`, en, vi, params: [] }, ...(assessment ? { capacity: assessment.capacity } : {}) });
}
export function capacityErrorPayload(error, language = 'en') {
  if (!Object.hasOwn(messages, error?.code)) return null;
  const [en, vi] = messages[error.code];
  return { error: language === 'vi' ? vi : en, errorI18n: { id: `panel.capacity.${error.code.toLowerCase()}`, en, vi, params: [] }, code: error.code };
}
const finite = (value, minimum = 0) => typeof value === 'number' && Number.isFinite(value) && value >= minimum;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const cpuUnits = value => Math.round(value * 100);
function cpu(value, minimum = 0.1) {
  if (!finite(value, minimum) || Math.abs(value * 100 - cpuUnits(value)) > 1e-7) fail('CAPACITY_INPUT');
  return cpuUnits(value);
}

export function serverCapacityAllocation(server) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) fail('CAPACITY_INPUT');
  const policy = server.resourcePolicy || { mode: 'shared' };
  let cpuCores, memoryMiB, source;
  if (policy.mode === 'fixed') {
    cpuCores = cpu(policy.cpuCores) / 100; memoryMiB = policy.memoryMiB; source = 'fixed-ceiling';
  } else if (policy.mode === 'shared') {
    const reservation = server.admissionReservation || SHARED_ADMISSION_RESERVATION;
    cpuCores = cpu(reservation.cpuCores, SHARED_ADMISSION_RESERVATION.cpuCores) / 100;
    memoryMiB = reservation.memoryMiB; source = 'shared-reservation';
    if (memoryMiB < SHARED_ADMISSION_RESERVATION.memoryMiB) fail('CAPACITY_INPUT');
  } else fail('CAPACITY_INPUT');
  if (!integer(memoryMiB, 256) || !Number.isSafeInteger(memoryMiB * MIB)) fail('CAPACITY_INPUT');
  const storage = normalizeStoragePolicy(server.storagePolicy, { legacy: true });
  return { cpuCores, memoryMiB, diskGiB: storage.diskGiB, source };
}

function hostValues(host) {
  if (!host || typeof host !== 'object') fail('CAPACITY_INPUT');
  const cpuCount = host.cpuCount ?? host.cpus;
  const memoryTotalBytes = host.memoryTotalBytes ?? host.memoryTotal;
  const memoryAvailableBytes = host.memoryAvailableBytes ?? host.memoryAvailable ?? (integer(host.memoryUsed) && integer(memoryTotalBytes) ? memoryTotalBytes - host.memoryUsed : undefined);
  const diskTotalBytes = host.diskTotalBytes ?? host.diskTotal;
  const diskAvailableBytes = host.diskAvailableBytes ?? host.diskAvailable ?? (integer(host.diskUsed) && integer(diskTotalBytes) ? diskTotalBytes - host.diskUsed : undefined);
  if (!integer(cpuCount, 1) || !integer(memoryTotalBytes, 1) || !integer(memoryAvailableBytes) || memoryAvailableBytes > memoryTotalBytes || !integer(diskTotalBytes, 1) || !integer(diskAvailableBytes) || diskAvailableBytes > diskTotalBytes) fail('CAPACITY_INPUT', 503);
  const effectiveCpuCount = host.limits?.effectiveCpuCores ?? cpuCount;
  const effectiveMemoryBytes = host.limits?.memoryMaxBytes ?? memoryTotalBytes;
  if (!finite(effectiveCpuCount, 0.001) || !integer(effectiveMemoryBytes, 1)) fail('CAPACITY_INPUT', 503);
  return { cpuCount, effectiveCpuCount: Math.min(cpuCount, effectiveCpuCount), memoryTotalBytes, effectiveMemoryBytes: Math.min(memoryTotalBytes, effectiveMemoryBytes), memoryAvailableBytes, memorySource: host.memoryAvailableBytes !== undefined || host.memoryAvailable !== undefined ? 'mem-available' : 'host-memory-used', diskTotalBytes, diskAvailableBytes };
}

function managedMemory(server, now, maximum) {
  if (!['running', 'starting', 'stopping'].includes(server.status) || !integer(server.pid, 1)) return 0;
  const sample = server.capacityUsage || (server.telemetry ? { memoryBytes: server.telemetry.memory?.usedBytes, sampledAt: server.telemetry.sampledAt } : null);
  if (!sample || !integer(sample.memoryBytes) || sample.memoryBytes > maximum) return 0;
  const stamp = typeof sample.sampledAt === 'number' ? sample.sampledAt : Date.parse(sample.sampledAt);
  if (!Number.isFinite(stamp) || stamp > now + 1000 || now - stamp > 15000) return 0;
  return sample.memoryBytes;
}

// This is admission accounting, separate from sampled consumption. Fixed
// cgroup ceilings and shared minimum credits are counted even while stopped.
// Existing preallocated images already reduce statfs available space, so their
// displayed allocatedBytes must never be subtracted from that free space again.
export function evaluateCapacity({ host, servers = [], candidate = null, replaceServerId = null, additionalDiskBytes, reserveRatio = 0.1, minimumMemoryMiB = 256, now = Date.now } = {}) {
  if (!Array.isArray(servers) || !finite(reserveRatio) || reserveRatio > 0.5 || !integer(minimumMemoryMiB, 256) || !Number.isSafeInteger(minimumMemoryMiB * MIB) || typeof now !== 'function') fail('CAPACITY_INPUT');
  const total = hostValues(host);
  const retained = servers.filter(server => replaceServerId === null || server.id !== replaceServerId);
  if (replaceServerId !== null && servers.filter(server => server.id === replaceServerId).length !== 1) fail('CAPACITY_INPUT');
  const identifiers = servers.map(server => server.id);
  if (identifiers.some(id => typeof id !== 'string' || !id) || new Set(identifiers).size !== identifiers.length) fail('CAPACITY_INPUT');
  const allocated = retained.map(server => ({ server, allocation: serverCapacityAllocation(server) }));
  const prior = replaceServerId === null ? null : servers.find(server => server.id === replaceServerId);
  const legacyReplacement = Boolean(prior && normalizeStoragePolicy(prior.storagePolicy, { legacy: true }).mode === 'unlimited' && (candidate?.storagePolicy === undefined || candidate?.storagePolicy?.mode === 'unlimited'));
  const allocation = candidate ? serverCapacityAllocation({ ...candidate, storagePolicy: normalizeStoragePolicy(candidate.storagePolicy, { legacy: legacyReplacement }) }) : null;
  let allocatedCpu = 0, allocatedMemory = 0, allocatedDisk = 0, legacyUnlimitedServerCount = 0;
  for (const row of allocated) {
    allocatedCpu += cpuUnits(row.allocation.cpuCores); allocatedMemory += row.allocation.memoryMiB * MIB;
    if (row.allocation.diskGiB === null) legacyUnlimitedServerCount++;
    else allocatedDisk += row.allocation.diskGiB * GIB;
  }
  if (![allocatedCpu, allocatedMemory, allocatedDisk].every(value => Number.isSafeInteger(value))) fail('CAPACITY_INPUT');
  const cpuBudget = Math.floor(total.effectiveCpuCount * 100 * (1 - reserveRatio) + 1e-8);
  const memoryReserve = Math.ceil(total.effectiveMemoryBytes * reserveRatio);
  const nowMs = now();
  if (!Number.isFinite(nowMs)) fail('CAPACITY_INPUT', 503);
  // Synchronous callers provide a fresh /proc read. When a sampler supplies a
  // timestamp, never admit from an old observation or replace unknown RAM by 0.
  const sampleStamp = host.memorySampledAt ?? host.sampledAt;
  const sampleMs = sampleStamp === undefined ? nowMs : typeof sampleStamp === 'number' ? sampleStamp : Date.parse(sampleStamp);
  if (!Number.isFinite(sampleMs) || sampleMs > nowMs + 1000 || nowMs - sampleMs > 15000) fail('CAPACITY_INPUT', 503);
  const managedUsed = Math.min(total.memoryTotalBytes - total.memoryAvailableBytes, servers.reduce((sum, server) => sum + managedMemory(server, nowMs, total.memoryTotalBytes), 0));
  const externalUsed = Math.max(0, total.memoryTotalBytes - total.memoryAvailableBytes - managedUsed);
  // Admission counts configured ceilings; they are not dedicated reservations.
  // OS/application consumption must not shrink this stable allocation budget.
  // The control-panel host retains 10%; resource-only workers retain no ratio.
  const memoryAllocatable = total.effectiveMemoryBytes - memoryReserve;
  const physicalMemoryReserve = Math.ceil(total.memoryTotalBytes * reserveRatio);
  const pressureBudget = Math.max(0, Math.min(memoryAllocatable, total.memoryTotalBytes - physicalMemoryReserve - externalUsed));
  const pressureSafeAvailable = Math.max(0, pressureBudget - allocatedMemory);
  const criticalHeadroom = Math.max(0, Math.min(total.memoryAvailableBytes - physicalMemoryReserve, memoryAllocatable - managedUsed));
  const diskReserve = Math.ceil(total.diskTotalBytes * reserveRatio);
  const diskFree = Math.max(0, total.diskAvailableBytes - diskReserve);
  let diskRequest = additionalDiskBytes;
  if (diskRequest === undefined) {
    if (!allocation) diskRequest = 0;
    else {
      const previous = prior;
      const previousStorage = previous ? normalizeStoragePolicy(previous.storagePolicy, { legacy: true }) : null;
      // Growing an existing preallocated image only needs its size delta.
      // Legacy migration needs the entire new image while old files remain.
      diskRequest = allocation.diskGiB === null ? 0 : Math.max(0, allocation.diskGiB * GIB - (previousStorage?.mode === 'fixed' ? previousStorage.diskGiB * GIB : 0));
    }
  }
  if (!integer(diskRequest)) fail('CAPACITY_INPUT');
  const capacity = {
    reserveRatio,
    cpu: { totalCores: total.cpuCount, effectiveTotalCores: total.effectiveCpuCount, reservedCores: (total.effectiveCpuCount * 100 - cpuBudget) / 100, allocatableCores: cpuBudget / 100, allocatedCores: allocatedCpu / 100, availableCores: Math.max(0, cpuBudget - allocatedCpu) / 100 },
    memory: { totalBytes: total.memoryTotalBytes, effectiveTotalBytes: total.effectiveMemoryBytes, reservedBytes: memoryReserve, allocatableBytes: memoryAllocatable, allocatedBytes: allocatedMemory, availableBytes: Math.max(0, memoryAllocatable - allocatedMemory), pressureSafeAvailableBytes: pressureSafeAvailable, criticalHeadroomBytes: criticalHeadroom, minimumSafeBytes: minimumMemoryMiB * MIB, currentMemAvailableBytes: total.memoryAvailableBytes, externalUsedBytes: externalUsed, managedUsedBytes: managedUsed, observedAvailableBytes: total.memoryAvailableBytes, pressureAware: true, pressureWarning: memoryAllocatable - allocatedMemory > pressureSafeAvailable, pressureSource: total.memorySource, pressureSampledAt: new Date(sampleMs).toISOString(), limitsAreReservations: false },
    storage: { totalBytes: total.diskTotalBytes, reservedBytes: diskReserve, allocatableBytes: total.diskTotalBytes - diskReserve, allocatedBytes: allocatedDisk, availableBytes: diskFree, maxNewDiskGiB: Math.floor(diskFree / GIB) },
    sharedReservation: { ...SHARED_ADMISSION_RESERVATION }, legacyUnlimitedServerCount, sampledAt: new Date(nowMs).toISOString(),
  };
  const reasons = [];
  if (allocation && cpuUnits(allocation.cpuCores) > cpuBudget - allocatedCpu) reasons.push('CAPACITY_CPU');
  if (allocation && allocation.memoryMiB * MIB > memoryAllocatable - allocatedMemory) reasons.push('CAPACITY_MEMORY');
  const increasesMemory = allocation && (!prior || allocation.memoryMiB > serverCapacityAllocation(prior).memoryMiB);
  if (increasesMemory && criticalHeadroom < minimumMemoryMiB * MIB) reasons.push('CAPACITY_MEMORY_PRESSURE');
  if (diskRequest > diskFree) reasons.push('CAPACITY_DISK');
  const warnings = allocation && allocation.memoryMiB * MIB > pressureSafeAvailable ? ['CAPACITY_MEMORY_HEADROOM'] : [];
  return { allowed: reasons.length === 0, reasons, warnings, capacity, allocation, additionalDiskBytes: diskRequest };
}

// Starting an already configured server does not allocate its ceiling again or
// revalidate grandfathered policy totals. Only observed critical pressure can
// deny this step; unknown/stale observations already fail closed above.
export function assertMemoryHeadroom(options = {}) {
  const { capacity } = evaluateCapacity({ ...options, candidate: null, replaceServerId: null });
  if (capacity.memory.criticalHeadroomBytes < capacity.memory.minimumSafeBytes) fail('CAPACITY_MEMORY_PRESSURE', 409, { capacity });
  return capacity;
}

// Hold this gate through volume and metadata activation, not through a native
// runtime's lifetime. Every waiter takes a fresh host/list snapshot after its
// predecessor commits or rolls back; concurrent creates cannot spend one budget.
export function createCapacityGate({ readHost, listServers, reserveRatio = 0.1, minimumMemoryMiB = 256, now = Date.now } = {}) {
  if (typeof readHost !== 'function' || typeof listServers !== 'function') fail('CAPACITY_INPUT');
  let tail = Promise.resolve(), closed = false;
  async function assess(request = {}) {
    const host = await readHost(), servers = await listServers();
    return evaluateCapacity({ ...request, host, servers, reserveRatio, minimumMemoryMiB, now });
  }
  return {
    snapshot: () => assess(),
    async run(request, callback) {
      if (closed) fail('CAPACITY_CLOSED', 503);
      if (typeof callback !== 'function') fail('CAPACITY_INPUT');
      const previous = tail; let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      try {
        if (closed) fail('CAPACITY_CLOSED', 503);
        const result = await assess(request);
        if (!result.allowed) fail(result.reasons[0], 409, result);
        return await callback(result);
      } finally { release(); }
    },
    async close() { closed = true; await tail; },
  };
}
