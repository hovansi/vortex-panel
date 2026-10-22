import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const issue = (message, status, code) => Object.assign(new Error(message), { status, code });
const unavailable = () => issue('This download reservation is no longer available.', 409, 'DOWNLOAD_CANCELLED');
const invalid = () => issue('The prepared download artifact is invalid.', 500, 'DOWNLOAD_ARTIFACT_INVALID');
const closedIssue = () => issue('Prepared downloads are shutting down.', 503, 'DOWNLOAD_CLOSED');
const cleanupIssue = () => issue('A prepared download artifact could not be cleaned up.', 500, 'DOWNLOAD_CLEANUP_FAILED');
const pathKey = filename => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);

export function createDownloadArtifacts({ ttlMs = 30 * 60000, maxArtifacts = 8, maxPerServer = 2 } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 2147483647 || !Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 || !Number.isSafeInteger(maxPerServer) || maxPerServer < 1) throw new RangeError('Invalid prepared download limits.');
  const entries = new Map();
  let timer = null, closed = false, closing;
  const publicResult = entry => ({ ...entry.public });
  const schedule = () => {
    clearTimeout(timer); timer = null;
    if (closed) return;
    let next = Infinity;
    for (const entry of entries.values()) if (entry.state === 'published') next = Math.min(next, entry.expiresAt);
    if (next !== Infinity) { timer = setTimeout(sweep, Math.max(1, next - Date.now())); timer.unref?.(); }
  };
  const dispose = entry => {
    if (entry.cleanupPromise) return entry.cleanupPromise;
    if (entry.leases) return Promise.resolve();
    if (!entry.result?.cleanup) { entries.delete(entry.id); schedule(); return Promise.resolve(); }
    entry.state = 'disposing';
    entry.cleanupPromise = Promise.resolve().then(() => entry.result.cleanup()).then(() => {
      entries.delete(entry.id); schedule();
    }, () => {
      // Failed cleanup continues occupying capacity instead of growing disk use.
      entry.state = 'cleanup-failed'; schedule(); throw cleanupIssue();
    });
    entry.cleanupPromise.catch(() => {});
    return entry.cleanupPromise;
  };
  function sweep() {
    const now = Date.now();
    for (const entry of entries.values()) if (entry.state === 'published' && entry.expiresAt <= now) { entry.state = 'expired'; dispose(entry).catch(() => {}); }
    schedule();
  }
  const capture = result => result && typeof result === 'object' ? { path: result.path, name: result.name, cleanup: typeof result.cleanup === 'function' ? result.cleanup : null } : null;
  const valid = result => result && typeof result.path === 'string' && path.isAbsolute(result.path) && typeof result.name === 'string' && result.name.length > 0 && Buffer.byteLength(result.name) <= 1024 && !/[\/\\\x00-\x1f\x7f]/.test(result.name) && result.cleanup;
  const reserve = serverId => {
    if (closed) throw closedIssue();
    if (typeof serverId !== 'string' || !serverId) throw issue('A server is required for a prepared download.', 400, 'DOWNLOAD_SERVER_REQUIRED');
    sweep();
    if (entries.size >= maxArtifacts || [...entries.values()].filter(entry => entry.serverId === serverId).length >= maxPerServer) throw issue('Prepared download capacity is full. Wait for an existing download to expire.', 409, 'DOWNLOAD_CAPACITY');
    const entry = { id: randomUUID(), serverId, state: 'reserved', leases: 0, cancelled: false, result: null, input: null, publishPromise: null, cleanupPromise: null };
    entries.set(entry.id, entry);
    const publish = result => {
      if (entry.publishPromise) {
        if (entry.input === result) return entry.publishPromise;
        // A repeated call must never delete the artifact already owned here.
        return Promise.resolve().then(async () => {
          const extra = capture(result);
          if (extra?.cleanup && (typeof entry.result?.path !== 'string' || typeof extra.path !== 'string' || pathKey(extra.path) !== pathKey(entry.result.path))) { try { await extra.cleanup(); } catch { throw cleanupIssue(); } }
          throw unavailable();
        });
      }
      entry.input = result;
      entry.publishPromise = (async () => {
        try {
          entry.result = capture(result);
          if (!valid(entry.result)) throw invalid();
          if (closed) throw closedIssue();
          if (entry.cancelled || entries.get(entry.id) !== entry) throw unavailable();
          const stat = await fs.lstat(entry.result.path);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !Number.isSafeInteger(stat.size)) throw invalid();
          if (closed) throw closedIssue();
          if (entry.cancelled || entries.get(entry.id) !== entry) throw unavailable();
          entry.expiresAt = Date.now() + ttlMs;
          entry.public = { id: entry.id, name: entry.result.name, size: stat.size, expiresAt: new Date(entry.expiresAt).toISOString() };
          entry.state = 'published'; schedule(); return publicResult(entry);
        } catch (error) {
          const failure = closed ? closedIssue() : entry.cancelled ? unavailable() : ['DOWNLOAD_CLOSED', 'DOWNLOAD_CANCELLED', 'DOWNLOAD_ARTIFACT_INVALID'].includes(error?.code) ? error : invalid();
          entry.cancelled = true;
          await dispose(entry).catch(() => {});
          throw failure;
        }
      })();
      return entry.publishPromise;
    };
    const cancel = () => {
      if (entry.state === 'published') return Promise.resolve();
      entry.cancelled = true;
      return dispose(entry);
    };
    return { publish, cancel };
  };
  const acquire = (serverId, id) => {
    if (closed) throw closedIssue();
    const entry = entries.get(id);
    if (!entry || entry.serverId !== serverId || !entry.public) throw issue('Prepared download not found.', 404, 'DOWNLOAD_NOT_FOUND');
    if (entry.state !== 'published' || entry.expiresAt <= Date.now()) {
      if (entry.state === 'published') entry.state = 'expired';
      dispose(entry).catch(() => {}); schedule();
      throw issue('This prepared download has expired. Prepare it again.', 410, 'DOWNLOAD_EXPIRED');
    }
    entry.leases++;
    let release;
    return { path: entry.result.path, name: entry.result.name, cleanup: () => release ??= Promise.resolve().then(() => {
      entry.leases--;
      if (closed || entry.state !== 'published' || entry.expiresAt <= Date.now()) { if (entry.state === 'published') entry.state = 'expired'; return dispose(entry); }
    }) };
  };
  const close = () => {
    if (closing) return closing;
    closed = true; clearTimeout(timer); timer = null;
    const work = [];
    for (const entry of entries.values()) {
      // Existing leases may still be opening their native download streams.
      entry.cancelled = true; work.push(dispose(entry));
      if (entry.publishPromise) work.push(entry.publishPromise.catch(() => {}));
    }
    closing = Promise.allSettled(work).then(results => { entries.clear(); if (results.some(result => result.status === 'rejected')) throw cleanupIssue(); });
    return closing;
  };
  return { reserve, acquire, close };
}
