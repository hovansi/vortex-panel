import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const MiB = 1024 ** 2;
export const LOG_RETENTION_DEFAULTS = Object.freeze({
  activityDays: 7, activityEntries: 100, activityBytes: 256 * 1024,
  finishedJobDays: 7, finishedJobEntries: 50, finishedJobBytes: MiB,
  consoleDays: 30, consoleBytes: 2 * MiB, consoleEntries: 1500,
  consoleMemoryBytes: 2 * MiB, consoleLineBytes: 16384, consoleQueueBytes: 262144,
});
const LEGACY_LOG_RETENTION_DEFAULTS = Object.freeze({ ...LOG_RETENTION_DEFAULTS,
  activityDays: 30, activityEntries: 1000, activityBytes: 2 * MiB,
  finishedJobDays: 30, finishedJobEntries: 200, finishedJobBytes: 4 * MiB,
});
export function migrateLogRetentionSettings(data) {
  const settings = data.settings, policy = settings?.logRetention;
  // A policy explicitly saved by an administrator is user intent, including a
  // deliberate choice of the old defaults. Only untouched legacy defaults move.
  // Older releases only stored a policy following an explicit administrator
  // save. Missing policies automatically use the new defaults; a stored policy
  // is not inferred to be untouched merely because its audit has expired.
  if (!policy || settings.logRetentionCustomized || settings.logRetentionDefaultsVersion !== 1 ||
      data.activity?.some(record => record?.action === 'logs.policy.update') ||
      Object.keys(policy).length !== Object.keys(LEGACY_LOG_RETENTION_DEFAULTS).length ||
      Object.entries(LEGACY_LOG_RETENTION_DEFAULTS).some(([key, value]) => policy[key] !== value)) return false;
  data.settings = { ...settings, logRetention: { ...LOG_RETENTION_DEFAULTS }, logRetentionDefaultsVersion: 2 };
  return true;
}
export const STORE_MAX_LOAD_BYTES = 64 * MiB;
const ranges = Object.freeze({
  activityDays: [1, 365], activityEntries: [100, 10000], activityBytes: [65536, 32 * MiB],
  finishedJobDays: [1, 365], finishedJobEntries: [50, 2000], finishedJobBytes: [262144, 64 * MiB],
  consoleDays: [1, 365], consoleBytes: [MiB, 32 * MiB], consoleEntries: [100, 5000],
  consoleMemoryBytes: [65536, 32 * MiB], consoleLineBytes: [1024, 65536], consoleQueueBytes: [65536, 4 * MiB],
});
export const LOG_RETENTION_RANGES = ranges;
const issue = (message, code = 'LOG_RETENTION_INVALID', status = 400) => Object.assign(new Error(message), { code, status });

export function getLogRetentionPolicy(input) {
  const result = { ...LOG_RETENTION_DEFAULTS };
  if (input && typeof input === 'object' && !Array.isArray(input)) for (const [key, [min, max]] of Object.entries(ranges)) {
    if (Number.isInteger(input[key]) && input[key] >= min && input[key] <= max) result[key] = input[key];
  }
  return result;
}
export function validateLogRetentionPolicy(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(ranges, key))) throw issue('Log retention settings are invalid.');
  const result = getLogRetentionPolicy(previous);
  for (const [key, value] of Object.entries(input)) {
    const [min, max] = ranges[key];
    if (!Number.isInteger(value) || value < min || value > max) throw issue('Log retention values are outside the supported range.');
    result[key] = value;
  }
  if (result.consoleLineBytes > result.consoleQueueBytes || result.consoleLineBytes > result.consoleMemoryBytes || result.consoleLineBytes > result.consoleBytes) throw issue('Console line limit must fit the queue, memory and file limits.');
  return result;
}

export function boundedUtf8Text(value, maxBytes, { marker = ' … [truncated]' } = {}) {
  const text = String(value ?? '');
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw issue('UTF-8 byte limit is invalid.');
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const suffix = Buffer.byteLength(marker) <= maxBytes ? marker : '';
  const budget = maxBytes - Buffer.byteLength(suffix);
  let result = '', bytes = 0;
  for (const point of text) {
    const length = Buffer.byteLength(point);
    if (bytes + length > budget) break;
    result += point; bytes += length;
  }
  return result + suffix;
}

const recordBytes = record => Buffer.byteLength(JSON.stringify(record)) + 1;
const sameRows = (before, after) => before.length === after.length && before.every((row, i) => row === after[i]) ? before : after;
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;

export function protectedHistoryRows(data, { isRecoveryAnchor = () => false } = {}) {
  const jobs = new Set(), activity = new Set(), references = new Set();
  const recoveryServers = new Set(), verificationServers = new Set();
  for (const server of data.servers || []) {
    for (const key of ['jobId', 'cloneJobId']) if (server[key]) references.add(server[key]);
    if (server.restoreRecoveryRequired) recoveryServers.add(server.id);
    if (server.backupVerificationFailure) verificationServers.add(server.id);
  }
  for (const schedule of data.schedules || []) if (schedule.lastJobId) references.add(schedule.lastJobId);
  for (const record of data.jobs || []) {
    const finished = ['completed', 'failed', 'cancelled'].includes(record?.status);
    if (!finished || references.has(record?.id) || (record?.operationCompleted && record?.completionStatusPersisted === false) || record?.recoveryRequired || record?.result?.cleanupPending) jobs.add(record);
    if (record?.type === 'restore' && recoveryServers.delete(record.serverId)) jobs.add(record);
    if (record?.type === 'backup-verify' && record.status === 'failed' && verificationServers.delete(record.serverId)) jobs.add(record);
    if (!jobs.has(record) && isRecoveryAnchor(record)) jobs.add(record);
  }
  const pendingRecovery = new Set((data.servers || []).filter(server => server.restoreRecoveryRequired).map(server => server.id));
  for (const record of data.activity || []) if (record?.action === 'restore.failed' && pendingRecovery.delete(record.serverId)) activity.add(record);
  for (const record of data.activity || []) if (!activity.has(record) && isRecoveryAnchor(record)) activity.add(record);
  return { jobs, activity };
}

function pruneRecords(records, protectedRows, { entries, bytes, days, nowMs, timeField }) {
  const protectedBytes = [...protectedRows].reduce((sum, row) => sum + recordBytes(row), 0);
  let remainingBytes = Math.max(0, bytes - protectedBytes), remainingEntries = entries;
  const cutoff = nowMs - days * 86400000, kept = [];
  const newestFirst = [...records].sort((a, b) => {
    const first = timestamp(a?.[timeField] || a?.createdAt), second = timestamp(b?.[timeField] || b?.createdAt);
    return (Number.isFinite(second) ? second : 0) - (Number.isFinite(first) ? first : 0);
  });
  for (const record of newestFirst) {
    if (protectedRows.has(record)) { kept.push(record); continue; }
    const time = timestamp(record?.[timeField] || record?.createdAt);
    if (Number.isFinite(time) && time < cutoff) continue;
    const size = recordBytes(record);
    if (remainingEntries <= 0 || size > remainingBytes) continue;
    kept.push(record); remainingEntries--; remainingBytes -= size;
  }
  return {
    records: sameRows(records, kept), removed: records.length - kept.length,
    bytes: kept.reduce((sum, row) => sum + recordBytes(row), 0),
    protectedEntries: protectedRows.size, protectedBytes,
    protectedOverBudget: protectedBytes > bytes || protectedRows.size > entries,
  };
}

export function retainStoreHistory(data, policy = getLogRetentionPolicy(data.settings?.logRetention), { nowMs = Date.now(), isRecoveryAnchor } = {}) {
  const protectedRows = protectedHistoryRows(data, { isRecoveryAnchor });
  const activity = pruneRecords(data.activity || [], protectedRows.activity, { entries: policy.activityEntries, bytes: policy.activityBytes, days: policy.activityDays, nowMs, timeField: 'time' });
  const jobs = pruneRecords(data.jobs || [], protectedRows.jobs, { entries: policy.finishedJobEntries, bytes: policy.finishedJobBytes, days: policy.finishedJobDays, nowMs, timeField: 'finishedAt' });
  return { activity: activity.records, jobs: jobs.records, stats: { activity: { ...activity, records: undefined }, jobs: { ...jobs, records: undefined } } };
}

export function boundConsoleEntry(input, limits = LOG_RETENTION_DEFAULTS) {
  const entry = {
    ...(typeof input?.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.id) ? { id: input.id } : {}),
    ...(typeof input?.runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.runId) ? { runId: input.runId } : {}),
    time: boundedUtf8Text(input?.time || new Date().toISOString(), 80, { marker: '' }),
    level: boundedUtf8Text(input?.level || 'info', 16, { marker: '' }),
    source: boundedUtf8Text(input?.source || 'panel', 32, { marker: '' }),
    message: boundedUtf8Text(input?.message ?? '', limits.consoleLineBytes - 256),
  };
  // JSON escaping can expand a control character sixfold. Bound the actual
  // serialized UTF-8 line, not only JavaScript string length or message bytes.
  const original = entry.message;
  let low = 0, high = Buffer.byteLength(original);
  while (recordBytes(entry) > limits.consoleLineBytes && low <= high) {
    const middle = Math.floor((low + high) / 2);
    entry.message = boundedUtf8Text(original, middle);
    if (recordBytes(entry) <= limits.consoleLineBytes) low = middle + 1;
    else high = middle - 1;
  }
  if (recordBytes(entry) > limits.consoleLineBytes) entry.message = boundedUtf8Text(original, Math.max(0, high));
  return entry;
}

function selectConsoleEntries(entries, limits, nowMs = Date.now()) {
  const cutoff = nowMs - limits.consoleDays * 86400000, reversed = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0 && reversed.length < limits.consoleEntries; i--) {
    const input = entries[i];
    if (!input || typeof input !== 'object' || typeof input.message !== 'string') continue;
    const time = timestamp(input.time); if (Number.isFinite(time) && time < cutoff) continue;
    const row = boundConsoleEntry(input, limits), size = recordBytes(row);
    if (bytes + size > Math.min(limits.consoleMemoryBytes, limits.consoleBytes)) break;
    reversed.push({ input, entry: row, bytes: size }); bytes += size;
  }
  return reversed.reverse();
}

export function trimConsoleEntries(entries, limits = LOG_RETENTION_DEFAULTS, { nowMs = Date.now() } = {}) {
  return selectConsoleEntries(entries, limits, nowMs).map(row => row.entry);
}

export function createBoundedConsoleRing({ limits = () => LOG_RETENTION_DEFAULTS } = {}) {
  const policy = () => typeof limits === 'function' ? limits() : limits;
  let entries = [], bytes = 0;
  const prune = () => {
    const current = policy(), cutoff = Date.now() - current.consoleDays * 86400000;
    while (entries.length && (entries.length > current.consoleEntries || bytes > Math.min(current.consoleMemoryBytes, current.consoleBytes) || (Number.isFinite(timestamp(entries[0].entry.time)) && timestamp(entries[0].entry.time) < cutoff))) bytes -= entries.shift().bytes;
  };
  return {
    append(input) { const entry = boundConsoleEntry(input, policy()); const size = recordBytes(entry); entries.push({ entry, bytes: size }); bytes += size; prune(); return entry; },
    replace(input) { entries = []; bytes = 0; for (const row of trimConsoleEntries(input, policy())) this.append(row); },
    snapshot() { prune(); return entries.map(row => ({ ...row.entry })); },
    stats() { prune(); return { entries: entries.length, bytes, budgetBytes: Math.min(policy().consoleMemoryBytes, policy().consoleBytes) }; },
  };
}

const normalizedPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function consoleLocation(serverRoot, { missing = false } = {}) {
  const absolute = path.resolve(serverRoot), rootStat = await fs.lstat(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || normalizedPath(await fs.realpath(absolute)) !== normalizedPath(absolute)) throw issue('Panel console path must be a real server directory.', 'LOG_PATH_UNSAFE', 403);
  const filename = path.join(absolute, 'console.log');
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw issue('Panel console log must be a regular unlinked file.', 'LOG_PATH_UNSAFE', 403);
    return { filename, stat };
  } catch (error) { if (missing && error.code === 'ENOENT') return { filename, stat: null }; throw error; }
}

async function readConsoleWindow(serverRoot, limits) {
  const { filename, stat } = await consoleLocation(serverRoot, { missing: true });
  if (!stat) return { records: [], expiredEntries: 0, unreadBytes: 0 };
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw issue('Panel console log changed during access.', 'LOG_PATH_UNSAFE', 403);
    const size = Math.min(opened.size, limits.consoleBytes), buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, opened.size - size);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (opened.size > size) lines.shift();
    const records = []; let expiredEntries = 0;
    const cutoff = Date.now() - limits.consoleDays * 86400000;
    for (const line of lines) if (line && Buffer.byteLength(line) <= limits.consoleLineBytes) {
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || typeof record.message !== 'string') continue;
        records.push(record);
        if (Number.isFinite(timestamp(record.time)) && timestamp(record.time) < cutoff) expiredEntries++;
      } catch {}
    }
    return { records, expiredEntries, unreadBytes: opened.size - bytesRead };
  } finally { await handle.close(); }
}

export async function readConsoleTail(serverRoot, limits = LOG_RETENTION_DEFAULTS) {
  return trimConsoleEntries((await readConsoleWindow(serverRoot, limits)).records, limits);
}

async function replaceConsole(serverRoot, entries) {
  const { filename } = await consoleLocation(serverRoot, { missing: true });
  const temporary = path.join(path.dirname(filename), `.vortex-console-${randomUUID()}.tmp`);
  let created = false, handle;
  try {
    const text = entries.map(entry => JSON.stringify(entry) + '\n').join('');
    handle = await fs.open(temporary, 'wx', 0o600); created = true;
    await handle.writeFile(text); await handle.close(); handle = undefined;
    await consoleLocation(serverRoot, { missing: true });
    await fs.rename(temporary, filename);
    return Buffer.byteLength(text);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createBoundedConsoleWriter({ serverRoot, limits = () => LOG_RETENTION_DEFAULTS, onWarning = () => {} }) {
  const policy = () => typeof limits === 'function' ? limits() : limits;
  let queue = [], queuedBytes = 0, inFlightBytes = 0, running = null, closed = false, maintenance = false;
  let writtenBytes = 0, writtenEntries = 0, droppedEntries = 0, droppedBytes = 0, writeFailures = 0, warned = false, fileBytes = null, compactions = 0, lastErrorCode = null;
  let processedEntries = 0, processedBytes = 0, retentionEvictedKnownEntries = 0, retentionEvictedKnownBytes = 0, retentionUnreadBytes = 0;
  const warn = error => { if (!warned) { warned = true; try { onWarning(error); } catch {} } };
  const drop = item => { droppedEntries++; droppedBytes += item.bytes; };
  const pump = () => {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (queue.length || maintenance) {
        const batch = queue; queue = []; inFlightBytes = queuedBytes; queuedBytes = 0;
        const maintain = maintenance; maintenance = false;
        try {
          const current = policy(), { filename, stat } = await consoleLocation(serverRoot, { missing: true });
          const overflow = (stat?.size || 0) + inFlightBytes > current.consoleBytes;
          const window = maintain || overflow ? await readConsoleWindow(serverRoot, current) : null;
          let persistedBatch = batch;
          if (overflow || (maintain && window.expiredEntries > 0)) {
            // Keep headroom after size overflow, so the next small append does
            // not rewrite the entire file again. Age-only maintenance applies
            // upper bounds without shrinking an unchanged, under-budget log.
            const target = overflow ? Math.max(1, Math.floor(current.consoleBytes * 0.75)) : current.consoleBytes;
            const inputs = [...window.records, ...batch.map(item => item.entry)];
            const selected = selectConsoleEntries(inputs, { ...current, consoleBytes: target });
            const retained = new Set(selected.map(row => row.input));
            fileBytes = await replaceConsole(serverRoot, selected.map(row => row.entry)); compactions++;
            persistedBatch = batch.filter(item => retained.has(item.entry));
            for (const input of inputs) if (!retained.has(input)) { retentionEvictedKnownEntries++; retentionEvictedKnownBytes += recordBytes(input); }
            // A bounded tail cannot count entries in older, unread bytes.
            retentionUnreadBytes += window.unreadBytes;
          } else if (batch.length) {
            const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600);
            try {
              const opened = await handle.stat();
              if (!opened.isFile() || opened.nlink > 1 || (stat && (opened.ino !== stat.ino || opened.dev !== stat.dev))) throw issue('Panel console log changed during append.', 'LOG_PATH_UNSAFE', 403);
              await handle.writeFile(batch.map(item => item.line).join(''));
              fileBytes = opened.size + inFlightBytes;
            } finally { await handle.close(); }
          } else fileBytes = stat?.size || 0;
          processedBytes += inFlightBytes; processedEntries += batch.length;
          writtenBytes += persistedBatch.reduce((sum, item) => sum + item.bytes, 0); writtenEntries += persistedBatch.length; warned = false; lastErrorCode = null;
        } catch (error) { writeFailures++; fileBytes = null; lastErrorCode = error.code || 'LOG_WRITE_FAILED'; for (const item of batch) drop(item); warn(error); }
        finally { inFlightBytes = 0; }
      }
    }).finally(() => { running = null; if (queue.length || maintenance) pump(); });
    return running;
  };
  return {
    append(input) {
      if (closed) return false;
      const current = policy(), entry = boundConsoleEntry(input, current), line = JSON.stringify(entry) + '\n', item = { entry, line, bytes: Buffer.byteLength(line) };
      while (queue.length && queuedBytes + inFlightBytes + item.bytes > current.consoleQueueBytes) { const previous = queue.shift(); queuedBytes -= previous.bytes; drop(previous); }
      if (queuedBytes + inFlightBytes + item.bytes > current.consoleQueueBytes) { drop(item); warn(issue('Console log queue is full; some persisted entries were dropped.', 'LOG_QUEUE_OVERFLOW', 503)); return false; }
      queue.push(item); queuedBytes += item.bytes; pump(); return true;
    },
    async drain() { while (running || queue.length || maintenance) await (running || pump()); },
    async close() { closed = true; await this.drain(); },
    async maintain() { maintenance = true; await pump(); },
    async readTail() { await this.drain(); return readConsoleTail(serverRoot, policy()); },
    stats() { return { queuedBytes, inFlightBytes, queueBudgetBytes: policy().consoleQueueBytes, queuedEntries: queue.length, writtenBytes, writtenEntries, processedEntries, processedBytes, retentionEvictedKnownEntries, retentionEvictedKnownBytes, retentionUnreadBytes, fileBytes, fileBudgetBytes: policy().consoleBytes, compactionTargetBytes: Math.max(1, Math.floor(policy().consoleBytes * 0.75)), compactions, droppedEntries, droppedBytes, writeFailures, lastErrorCode, closed }; },
  };
}

export function createUtf8LineConsumer({ maxBytes = LOG_RETENTION_DEFAULTS.consoleLineBytes, onLine }) {
  const decoder = new StringDecoder('utf8');
  let buffered = '', bytes = 0, overflow = false;
  const marker = ' … [truncated]';
  const finish = () => {
    let line = buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered;
    if (overflow) line = boundedUtf8Text(line, maxBytes - Buffer.byteLength(marker), { marker: '' }) + marker;
    buffered = ''; bytes = 0; overflow = false;
    if (line.trim()) onLine(line);
  };
  const consume = text => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
      if (!overflow) {
        // Retain a prefix only. Never concatenate an unbounded partial line.
        const part = text.slice(offset, Math.min(end, offset + maxBytes + 1));
        const room = maxBytes - bytes, bounded = boundedUtf8Text(part, room, { marker: '' });
        buffered += bounded; bytes += Buffer.byteLength(bounded);
        if (offset + part.length < end || bounded.length < part.length) overflow = true;
      }
      if (newline < 0) break;
      finish(); offset = newline + 1;
    }
  };
  return {
    write(chunk) { consume(Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk) ? decoder.write(chunk) : String(chunk)); },
    end() { consume(decoder.end()); if (buffered || overflow) finish(); },
    stats() { return { bufferedBytes: bytes, limitBytes: maxBytes, overflow }; },
  };
}

export function nativeLogRetentionPolicy(properties = {}) {
  return {
    automaticallyDeleted: false,
    contentLogEnabled: properties['content-log-file-enabled'] === 'true',
    diagnosticsAutoStart: properties['diagnostics-capture-auto-start'] === 'true',
    diagnosticsMaxFiles: Number.isFinite(Number(properties['diagnostics-capture-max-files'])) ? Number(properties['diagnostics-capture-max-files']) : null,
    diagnosticsMaxFileSize: Number.isFinite(Number(properties['diagnostics-capture-max-file-size'])) ? Number(properties['diagnostics-capture-max-file-size']) : null,
    scope: 'Only the panel-owned console.log is compacted. Native content logs, diagnostics, world databases, backups and user files are not deleted by this policy.',
    journaldManagedByPanel: false,
  };
}
