const terminal = job => ['completed', 'failed', 'error', 'interrupted', 'cancelled'].includes(job?.status);
const ranks = { pending: 0, queued: 1, running: 2, completed: 3, failed: 3, error: 3, interrupted: 3, cancelled: 3 };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const copyJob = job => ({ ...job, ...(job.transfer && typeof job.transfer === 'object' && !Array.isArray(job.transfer) ? { transfer: { ...job.transfer } } : {}) });

// read(signal) must perform only an authorized GET and honor AbortSignal.
// The tracker never creates, retries or otherwise mutates an operation.
export function createJobTracker({ id, seed, read, onJob = () => {}, onUnavailable = () => {}, isCurrent = () => true, intervalMs = 1000 }) {
  if (typeof id !== 'string' || !id || typeof read !== 'function' || typeof onJob !== 'function' || typeof onUnavailable !== 'function' || typeof isCurrent !== 'function' || !finite(intervalMs) || intervalMs <= 0) throw new TypeError('Invalid job tracker options.');
  const interval = Math.min(5000, intervalMs);
  let started = false, stopped = false, latest = null, timer = null, flight = null, failures = 0;
  const valid = job => job && typeof job === 'object' && !Array.isArray(job) && job.id === id && typeof job.status === 'string' && Object.hasOwn(ranks, job.status);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer); timer = null;
    if (flight) { clearTimeout(flight.timeout); flight.controller.abort(); }
  }
  function current() {
    if (stopped) return false;
    try { if (isCurrent()) return true; } catch {}
    stop(); return false;
  }
  function unavailable(error) {
    if (!current()) return;
    try { onUnavailable(error); } catch {}
  }
  function emit() {
    if (!current()) return;
    try { onJob(copyJob(latest)); } catch (error) { unavailable(error); }
  }
  function nextJob(job) {
    if (!valid(job) || terminal(latest)) return null;
    const progress = finite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : latest?.progress || 0;
    if (!terminal(job) && latest) {
      if (progress < latest.progress || ranks[job.status] < ranks[latest.status]) return null;
      if (['download', 'runtime-download'].includes(job.phase) && latest.phase === job.phase && finite(job.transfer?.loadedBytes) && finite(latest.transfer?.loadedBytes) && job.transfer.loadedBytes < latest.transfer.loadedBytes) return null;
    }
    const next = copyJob({ ...latest, ...job, progress: job.status === 'completed' ? 100 : Math.min(99, Math.max(latest?.progress || 0, progress)) });
    // Job records are complete snapshots. A subsequent phase without transfer
    // metadata must clear the previous download meter.
    if (!job.transfer) delete next.transfer;
    return next;
  }
  function observe(job) {
    if (!current()) return false;
    const next = nextJob(job);
    if (!next || JSON.stringify(next) === JSON.stringify(latest)) return false;
    latest = next;
    if (started) { emit(); if (terminal(latest)) stop(); }
    return true;
  }
  function schedule() {
    if (!current() || !started || terminal(latest)) return;
    const delay = Math.min(5000, interval * 2 ** Math.min(10, Math.max(0, failures - 1)));
    timer = setTimeout(() => { timer = null; void poll(); }, delay);
  }
  async function poll() {
    if (!current() || !started || flight || terminal(latest)) return;
    const controller = new AbortController(), request = { controller, timeout: null };
    flight = request;
    const timedOut = new Promise((_, reject) => {
      request.timeout = setTimeout(() => {
        const error = Object.assign(new Error('Operation status request timed out.'), { name: 'TimeoutError', code: 'JOB_STATUS_TIMEOUT' });
        controller.abort(error); reject(error);
      }, 12000);
    });
    try {
      const job = await Promise.race([Promise.resolve().then(() => read(controller.signal)), timedOut]);
      if (!current() || flight !== request) return;
      if (!valid(job)) throw Object.assign(new Error('Operation status identity is invalid.'), { code: 'JOB_STATUS_IDENTITY' });
      const recovering = failures > 0;
      failures = 0;
      const observed = observe(job);
      // A successful unchanged snapshot is still evidence that a previous
      // status-read outage recovered. Emit once so the UI clears its retry
      // notice, while terminal observe() keeps its single emission + stop.
      if (recovering && !observed && current() && latest && !terminal(latest)) emit();
    } catch (error) {
      if (current() && flight === request) { failures++; unavailable(error); }
    } finally {
      clearTimeout(request.timeout);
      if (flight === request) flight = null;
      schedule();
    }
  }
  // An accepted POST seed is useful even before global dashboard history catches
  // up. Ignore a seed for any other operation, including a different node.
  if (valid(seed)) latest = nextJob(seed);
  function start() {
    if (started || !current()) return;
    started = true;
    if (latest) { emit(); if (terminal(latest)) { stop(); return; } }
    void poll();
  }
  return { start, observe, stop };
}
