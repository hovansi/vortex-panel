import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const round = value => Math.round(value * 100) / 100;
export function parseHostCPU(text) {
  const row = text.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).slice(0, 8).map(number);
  if (!row || row.length < 4 || row.some(value => value === null)) return null;
  // guest/guest_nice are already included in user/nice; do not add them again.
  return { total: row.reduce((a, b) => a + b, 0), idle: row[3] + (row[4] || 0),
    busy: row[0] + row[1] + row[2] + (row[5] || 0) + (row[6] || 0), iowait: row[4] || 0, steal: row[7] || 0 };
}
export function parseHostMemory(text) {
  const values = Object.fromEntries([...text.matchAll(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/gm)].map(row => [row[1], Number(row[2]) * 1024]));
  if (!values.MemTotal || !Number.isSafeInteger(values.MemTotal)) return null;
  const freeBytes = clamp(values.MemFree || 0, 0, values.MemTotal);
  const availableBytes = clamp(values.MemAvailable ?? freeBytes, 0, values.MemTotal);
  return { totalBytes: values.MemTotal, usedBytes: values.MemTotal - availableBytes, availableBytes, freeBytes,
    source: 'proc-meminfo', usedDefinition: 'total-minus-available', availableEstimated: values.MemAvailable === undefined,
    swapTotalBytes: values.SwapTotal || 0, swapUsedBytes: Math.max(0, (values.SwapTotal || 0) - (values.SwapFree || 0)) };
}
export function parseHostNetwork(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const row = line.match(/^\s*([A-Za-z0-9_.:-]{1,64}):\s*(.+)$/); if (!row) continue;
    const values = row[2].trim().split(/\s+/); if (values.length < 16) continue;
    const rxBytes = number(values[0]), txBytes = number(values[8]);
    if (rxBytes !== null && txBytes !== null) rows.push({ name: row[1], rxBytes, txBytes });
  }
  return rows;
}
export function defaultRouteInterfaces(ipv4 = '', ipv6 = '') {
  const found = new Set();
  for (const line of ipv4.split('\n')) {
    const row = line.trim().split(/\s+/);
    if (row.length >= 8 && row[1] === '00000000' && row[7] === '00000000' && (parseInt(row[3], 16) & 1)) found.add(row[0]);
  }
  for (const line of ipv6.split('\n')) {
    const row = line.trim().split(/\s+/);
    if (row.length >= 10 && row[0] === '0'.repeat(32) && row[1] === '00' && (parseInt(row[8], 16) & 1)) found.add(row.at(-1));
  }
  return [...found].filter(name => name !== 'lo' && /^[A-Za-z0-9_.:-]{1,64}$/.test(name));
}
export function countCPUSet(text = '') {
  if (!text.trim()) return null;
  let count = 0;
  for (const range of text.trim().split(',')) {
    const match = range.match(/^(\d+)(?:-(\d+))?$/); if (!match) return null;
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (last < first || last > 1048576) return null;
    count += last - first + 1;
  }
  return count || null;
}

export function createHostSampler({ platform = process.platform, osApi = os, readFile = fs.readFile.bind(fs), statfs = fs.statfs.bind(fs), stat = fs.stat.bind(fs),
  procRoot = '/proc', sysRoot = '/sys', monotonic = () => performance.now(), now = Date.now, location = () => ({ status: 'disabled', label: '' }), minIntervalMs = 500 } = {}) {
  let previousCPU, previousNetwork, cached, lastAt = -Infinity, flight;
  const read = async filename => { try { return await readFile(filename, 'utf8'); } catch { return ''; } };
  async function constraints(totalCores) {
    let effectiveCpuCores = Math.min(totalCores, osApi.availableParallelism?.() || totalCores), memoryMaxBytes = null;
    let cgroupPath = null;
    if (platform === 'linux') {
      const entry = (await read(path.join(procRoot, 'self/cgroup'))).split('\n').find(row => row.startsWith('0::'))?.slice(3);
      if (entry?.startsWith('/') && !entry.split('/').includes('..') && !entry.includes('\0')) {
        cgroupPath = entry; const base = path.resolve(sysRoot, 'fs/cgroup'); let current = path.resolve(base, '.' + entry);
        if (current === base || current.startsWith(base + path.sep)) {
          while (true) {
            const [cpu, cpus, memory] = await Promise.all(['cpu.max', 'cpuset.cpus.effective', 'memory.max'].map(name => read(path.join(current, name))));
            const [quota, period] = cpu.trim().split(/\s+/).map(number);
            if (quota !== null && period > 0) effectiveCpuCores = Math.min(effectiveCpuCores, quota / period);
            const set = countCPUSet(cpus); if (set) effectiveCpuCores = Math.min(effectiveCpuCores, set);
            const limit = number(memory.trim()); if (limit !== null) memoryMaxBytes = memoryMaxBytes === null ? limit : Math.min(memoryMaxBytes, limit);
            if (current === base) break; current = path.dirname(current);
          }
        }
      }
    }
    return { scope: 'process-ancestor-cgroups', cgroupVersion: cgroupPath ? 2 : null, effectiveCpuCores: round(effectiveCpuCores), memoryMaxBytes,
      constrained: effectiveCpuCores < totalCores || memoryMaxBytes !== null, limitsAreReservations: false };
  }
  async function sample(dataDir) {
    const at = monotonic(), sampledAt = new Date(now()).toISOString(), cpus = osApi.cpus(), totalCores = cpus.length || 1;
    const [cpuText, memoryText, networkText, route4, route6, releaseText, limits] = await Promise.all([
      platform === 'linux' ? read(path.join(procRoot, 'stat')) : '', platform === 'linux' ? read(path.join(procRoot, 'meminfo')) : '',
      platform === 'linux' ? read(path.join(procRoot, 'net/dev')) : '', platform === 'linux' ? read(path.join(procRoot, 'net/route')) : '',
      platform === 'linux' ? read(path.join(procRoot, 'net/ipv6_route')) : '', platform === 'linux' ? read('/etc/os-release') : '', constraints(totalCores),
    ]);
    const parsedCPU = parseHostCPU(cpuText), source = parsedCPU ? 'proc-stat' : 'os-cpus';
    const totals = parsedCPU || cpus.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      busy: sum.busy + Object.entries(cpu.times).reduce((total, [name, value]) => total + (name === 'idle' ? 0 : value), 0) }), { idle: 0, total: 0, busy: 0 });
    const elapsedCPU = previousCPU ? at - previousCPU.at : null;
    const deltaTotal = previousCPU ? totals.total - previousCPU.total : 0, deltaIdle = previousCPU ? totals.idle - previousCPU.idle : 0,
      deltaBusy = previousCPU ? totals.busy - previousCPU.busy : 0, deltaSteal = parsedCPU && previousCPU?.source === source ? totals.steal - previousCPU.steal : null,
      deltaIOWait = parsedCPU && previousCPU?.source === source ? totals.iowait - previousCPU.iowait : null;
    // A virtual CPU denied by the hypervisor is not executing work. I/O wait
    // is also not execution; Linux documents that its counter may decrease.
    // Reject such an interval rather than manufacturing a busy percentage.
    const validCPU = previousCPU && previousCPU.totalCores === totalCores && elapsedCPU > 0 && deltaTotal > 0 && deltaIdle >= 0 && deltaBusy >= 0
      && (deltaSteal === null || deltaSteal >= 0) && (deltaIOWait === null || deltaIOWait >= 0) && previousCPU.source === source;
    const percent = validCPU ? clamp(100 * deltaBusy / deltaTotal, 0, 100) : null;
    const stealPercent = validCPU && deltaSteal !== null ? clamp(100 * deltaSteal / deltaTotal, 0, 100) : null;
    const iowaitPercent = validCPU && deltaIOWait !== null ? clamp(100 * deltaIOWait / deltaTotal, 0, 100) : null;
    previousCPU = { ...totals, source, at, totalCores };
    const memory = parseHostMemory(memoryText) || { totalBytes: osApi.totalmem(), usedBytes: osApi.totalmem() - osApi.freemem(), availableBytes: osApi.freemem(), freeBytes: osApi.freemem(), source: 'os-memory', usedDefinition: 'total-minus-available', availableEstimated: true };
    let disk = { totalBytes: null, usedBytes: null, freeBytes: null, availableBytes: null, reservedBytes: null, path: path.resolve(dataDir), source: 'statfs' };
    try { const row = await statfs(dataDir); disk = { ...disk, totalBytes: row.blocks * row.bsize, usedBytes: Math.max(0, (row.blocks - row.bfree) * row.bsize), freeBytes: row.bfree * row.bsize, availableBytes: row.bavail * row.bsize, reservedBytes: Math.max(0, (row.bfree - row.bavail) * row.bsize) }; } catch {}
    const observed = parseHostNetwork(networkText), defaults = defaultRouteInterfaces(route4, route6);
    let interfaces = observed.filter(row => defaults.includes(row.name)), selection = 'default-route';
    if (!interfaces.length && platform === 'linux') {
      selection = 'physical';
      interfaces = (await Promise.all(observed.filter(row => row.name !== 'lo').map(async row => {
        try { await stat(path.join(sysRoot, 'class/net', row.name, 'device')); return row; } catch { return null; }
      }))).filter(Boolean);
    }
    interfaces.sort((a, b) => a.name.localeCompare(b.name));
    const rxBytes = interfaces.length ? interfaces.reduce((a, b) => a + b.rxBytes, 0) : null;
    const txBytes = interfaces.length ? interfaces.reduce((a, b) => a + b.txBytes, 0) : null;
    const key = interfaces.map(row => row.name).join(','), elapsedNetwork = previousNetwork ? at - previousNetwork.at : null;
    const validRate = previousNetwork && interfaces.length && previousNetwork.key === key && elapsedNetwork > 0 && interfaces.every(row => {
      const previous = previousNetwork.interfaces.find(item => item.name === row.name);
      return previous && row.rxBytes >= previous.rxBytes && row.txBytes >= previous.txBytes;
    });
    const network = { supported: interfaces.length > 0, scope: 'host-network-namespace', source: 'proc-net-dev', selection, interfaces, rxBytes, txBytes,
      rxBytesPerSecond: validRate ? round((rxBytes - previousNetwork.rxBytes) * 1000 / elapsedNetwork) : null,
      txBytesPerSecond: validRate ? round((txBytes - previousNetwork.txBytes) * 1000 / elapsedNetwork) : null,
      sampleDurationMs: validRate ? round(elapsedNetwork) : null, sampledAt, countersSince: 'interface-initialization', includesOtherProcesses: true };
    previousNetwork = { key, rxBytes, txBytes, interfaces, at };
    const geo = location();
    return { hostname: osApi.hostname(), platform, arch: osApi.arch(), kernel: osApi.release(), release: releaseText.match(/^PRETTY_NAME="?(.*?)"?$/m)?.[1] || osApi.type(),
      cpus: totalCores, cpuPercent: percent, memoryTotal: memory.totalBytes, memoryUsed: memory.usedBytes, memoryAvailable: memory.availableBytes,
      uptime: osApi.uptime(), diskTotal: disk.totalBytes, diskUsed: disk.usedBytes, diskAvailable: disk.availableBytes, load: osApi.loadavg(),
      nodeVersion: process.version, user: osApi.userInfo().username, root: process.getuid?.() === 0, sampledAt,
      cpu: { percent, usedCores: percent === null ? null : percent * totalCores / 100, totalCores, model: cpus[0]?.model || '', source, scope: 'host',
        stealPercent, iowaitPercent, percentDefinition: 'execution-excludes-steal-iowait', sampleDurationMs: percent === null ? null : round(elapsedCPU) },
      memory, disk, network, limits, location: geo, publicAddress: geo.publicAddress || null };
  }
  return async dataDir => {
    if (flight) return flight;
    if (cached && monotonic() - lastAt < minIntervalMs) return cached;
    flight = sample(dataDir).then(value => { cached = value; lastAt = monotonic(); return value; }).finally(() => { flight = null; });
    return flight;
  };
}
