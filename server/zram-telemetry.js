import fs from 'node:fs';

const PROC = '/proc/swaps';
const MAX_READ = 128 * 1024;
const MAX_AREAS = 128;
const BASE = Object.freeze({ schemaVersion: 1, scope: 'host-zram-swap', source: '/proc/swaps + sysfs' });
const validInteger = text => /^(0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text));

export function unavailableZramTelemetry(now = Date.now) {
  return { ...BASE, available: false, status: 'unavailable', logicalSizeBytes: null, swapUsedBytes: null,
    algorithms: null, complete: false, observedAt: new Date(now()).toISOString() };
}

function readBounded(io, filename, maximum) {
  const fd = io.openSync(filename, 'r');
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = io.readSync(fd, buffer, size, buffer.length - size, null);
      if (!Number.isInteger(count) || count < 0) throw Error('Invalid observation');
      if (!count) break;
      size += count;
    }
    if (size > maximum) throw Error('Observation exceeds its bound');
    const value = buffer.subarray(0, size).toString('utf8');
    if (value.includes('\ufffd') || value.includes('\0')) throw Error('Invalid observation text');
    return value;
  } finally { io.closeSync(fd); }
}

function swaps(text) {
  const lines = text.trimEnd().split('\n');
  if (lines.shift()?.trim().split(/\s+/).join(' ') !== 'Filename Type Size Used Priority') throw Error('Invalid swap header');
  const result = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || !['file', 'partition'].includes(fields[1]) || !validInteger(fields[2]) || !validInteger(fields[3])
      || !/^-?(0|[1-9][0-9]*)$/.test(fields[4]) || !Number.isSafeInteger(Number(fields[4]))) throw Error('Invalid swap row');
    const filename = fields[0].replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));
    if (!filename.startsWith('/') || filename.includes('\0') || filename.length > 4096 || /\\(?![0-7]{3})/.test(fields[0])
      || result.has(filename) || result.size >= MAX_AREAS) throw Error('Invalid swap identity');
    const size = Number(fields[2]) * 1024, used = Number(fields[3]) * 1024;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(used) || used > size) throw Error('Invalid swap counters');
    result.set(filename, { filename, type: fields[1], size, used, priority: fields[4] });
  }
  return result;
}

function identity(info) { return `${info.dev}:${info.ino}:${info.rdev}`; }
function kernelDevice(rdev) {
  const value = BigInt(rdev);
  // Linux dev_t encoding, including major/minor bits above the original 8:8 layout.
  const major = ((value & 0xfff00n) >> 8n) | ((value & 0xfffff00000000000n) >> 32n);
  const minor = (value & 0xffn) | ((value & 0xffffff00000n) >> 12n);
  return `${major}:${minor}`;
}

function classify(io, row) {
  const before = io.statSync(row.filename, { bigint: true });
  if (before.isFile()) return { kind: 'other', verify() { if (identity(io.statSync(row.filename, { bigint: true })) !== identity(before)) throw Error('Swap file changed'); } };
  if (!before.isBlockDevice()) throw Error('Unknown swap medium');
  const device = kernelDevice(before.rdev), link = `/sys/dev/block/${device}`, directory = io.realpathSync(link);
  if (!directory.startsWith('/sys/devices/') || directory.includes('/../')) throw Error('Unknown kernel block identity');
  const sysinfo = io.statSync(directory, { bigint: true });
  if (!sysinfo.isDirectory() || readBounded(io, `${directory}/dev`, 64).trim() !== device) throw Error('Kernel block identity changed');
  const name = directory.slice(directory.lastIndexOf('/') + 1);
  return { kind: /^zram(0|[1-9][0-9]{0,5})$/.test(name) ? 'zram' : 'other', device, directory,
    verify() {
      if (identity(io.statSync(row.filename, { bigint: true })) !== identity(before) || io.realpathSync(link) !== directory
        || identity(io.statSync(directory, { bigint: true })) !== identity(sysinfo)
        || readBounded(io, `${directory}/dev`, 64).trim() !== device) throw Error('Kernel block identity changed');
    } };
}

function algorithm(io, directory) {
  const text = readBounded(io, `${directory}/comp_algorithm`, 4096).trim();
  const values = text.split(/\s+/), selected = values.filter(value => /^\[[A-Za-z0-9_.+-]{1,64}\]$/.test(value));
  if (selected.length !== 1 || values.some(value => !/^(?:[A-Za-z0-9_.+-]{1,64}|\[[A-Za-z0-9_.+-]{1,64}\])$/.test(value))) throw Error('Unknown primary algorithm');
  return selected[0].slice(1, -1);
}

// Observation is independent of control ownership: no device allocation, helper,
// subprocess, module loading or sysfs writes belong in this reader.
export function readZramTelemetry({ io = fs, platform = process.platform, now = Date.now } = {}) {
  const unavailable = () => unavailableZramTelemetry(now);
  if (platform !== 'linux') return unavailable();
  try {
    const first = swaps(readBounded(io, PROC, MAX_READ)), classified = new Map(), devices = new Set(), algorithms = new Set();
    let algorithmsComplete = true;
    for (const row of first.values()) {
      const observed = classify(io, row);
      if (observed.device && devices.has(observed.device)) throw Error('Duplicate kernel swap identity');
      if (observed.device) devices.add(observed.device);
      classified.set(row.filename, observed);
      if (observed.kind === 'zram') {
        try { algorithms.add(algorithm(io, observed.directory)); } catch { algorithmsComplete = false; }
      }
    }
    const latest = swaps(readBounded(io, PROC, MAX_READ));
    if (first.size !== latest.size) throw Error('Active swap set changed');
    let logicalSizeBytes = 0, swapUsedBytes = 0, active = false;
    for (const [filename, row] of latest) {
      const before = first.get(filename), observed = classified.get(filename);
      if (!before || before.size !== row.size || before.type !== row.type || before.priority !== row.priority) throw Error('Active swap set changed');
      observed.verify();
      if (observed.kind !== 'zram') continue;
      active = true; logicalSizeBytes += row.size; swapUsedBytes += row.used;
      if (!Number.isSafeInteger(logicalSizeBytes) || !Number.isSafeInteger(swapUsedBytes)) throw Error('Unsafe swap total');
    }
    return { ...BASE, available: true, status: active ? 'active' : 'inactive', logicalSizeBytes, swapUsedBytes,
      algorithms: algorithmsComplete ? [...algorithms].sort() : null, complete: algorithmsComplete, observedAt: new Date(now()).toISOString() };
  } catch { return unavailable(); }
}
