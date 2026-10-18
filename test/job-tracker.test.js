import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobTracker } from '../public/job-tracker.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const job = (progress = 5, status = 'running', extra = {}) => ({ id: 'accepted-local-job', status, progress, type: 'install', ...extra });

test('accepted exact-ID POST seed renders synchronously before a deferred direct GET', async t => {
  const pending = deferred(), seen = []; let calls = 0;
  const tracker = createJobTracker({ id: job().id, seed: job(), read: () => { calls++; return pending.promise; }, onJob: value => seen.push(value) });
  t.after(() => tracker.stop()); tracker.start();
  assert.deepEqual(seen.map(value => value.progress), [5]);
  await flush(); assert.equal(calls, 1);
  tracker.start(); await flush(); assert.equal(calls, 1, 'A second start cannot repeat the request');
  pending.resolve(job(100, 'completed')); await flush();
  assert.deepEqual(seen.map(value => value.status), ['running', 'completed']); assert.equal(seen.at(-1).progress, 100);
});

test('mismatched seed/read identity cannot leak into another job modal', async t => {
  const seen = [], errors = [];
  const tracker = createJobTracker({ id: job().id, seed: { ...job(), id: 'different-node:job' }, read: async () => ({ ...job(), id: 'different-node:job' }), onJob: value => seen.push(value), onUnavailable: error => errors.push(error) });
  t.after(() => tracker.stop()); tracker.start(); await flush();
  assert.equal(seen.length, 0); assert.equal(errors.length, 1); assert.equal(errors[0].code, 'JOB_STATUS_IDENTITY');
});

test('dashboard completion aborts an in-flight GET and its older active result cannot regress terminal UI', async t => {
  const pending = deferred(), seen = [], errors = []; let signal;
  const tracker = createJobTracker({ id: job().id, seed: job(10), read: value => { signal = value; return pending.promise; }, onJob: value => seen.push(value), onUnavailable: error => errors.push(error) });
  t.after(() => tracker.stop()); tracker.start(); await flush();
  tracker.observe(job(93)); tracker.observe(job(100, 'completed')); assert.equal(signal.aborted, true);
  pending.resolve(job(20)); await flush();
  assert.deepEqual(seen.map(value => value.progress), [10, 93, 100]); assert.equal(errors.length, 0);
  assert.equal(tracker.observe(job(99, 'failed')), false); tracker.start();
  assert.equal(seen.at(-1).status, 'completed');
});

test('older active snapshots cannot regress phase, workflow progress or measured download bytes', async t => {
  const pending = deferred(), seen = [];
  const tracker = createJobTracker({ id: job().id, seed: job(20, 'running', { phase: 'download', transfer: { loadedBytes: 512, totalBytes: 1024 } }), read: () => pending.promise, onJob: value => seen.push(value) });
  t.after(() => tracker.stop()); tracker.start(); await flush();
  assert.equal(tracker.observe(job(20, 'running', { phase: 'download', transfer: { loadedBytes: 256, totalBytes: 1024 } })), false);
  tracker.observe(job(75, 'running', { phase: 'extract' })); pending.resolve(job(30, 'running', { phase: 'download' })); await flush();
  assert.equal(seen.at(-1).phase, 'extract'); assert.equal(seen.at(-1).progress, 75); assert.equal(Object.hasOwn(seen.at(-1), 'transfer'), false);
  assert.equal(tracker.observe(job(75, 'pending')), false);
});

test('stop aborts request and prevents late callbacks, new requests or restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(), seen = [], errors = []; let signal, calls = 0;
  const tracker = createJobTracker({ id: job().id, seed: job(), read: value => { calls++; signal = value; return pending.promise; }, onJob: value => seen.push(value), onUnavailable: error => errors.push(error) });
  tracker.start(); await flush(); tracker.stop(); assert.equal(signal.aborted, true);
  pending.reject(new Error('late failure')); await flush(); tracker.start(); t.mock.timers.tick(60000); await flush();
  assert.equal(calls, 1); assert.equal(seen.length, 1); assert.equal(errors.length, 0);
});

test('replaced modal or changed actor suppresses late callbacks and aborts the tracking scope', async t => {
  const pending = deferred(), seen = [], errors = []; let current = true, signal;
  const tracker = createJobTracker({ id: job().id, seed: job(), read: value => { signal = value; return pending.promise; }, isCurrent: () => current, onJob: value => seen.push(value), onUnavailable: error => errors.push(error) });
  t.after(() => tracker.stop()); tracker.start(); await flush(); current = false; pending.resolve(job(100, 'completed')); await flush();
  assert.equal(signal.aborted, true); assert.equal(seen.length, 1); assert.equal(errors.length, 0); assert.equal(tracker.observe(job(99)), false);
});

test('transient GET failures retain accepted progress, back off up to5s, then recover without operation replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [], errors = []; let calls = 0;
  const tracker = createJobTracker({ id: job().id, seed: job(15), intervalMs: 1000, read: async () => { calls++; if (calls <= 4) throw new Error('temporary GET failure'); return job(100, 'completed'); }, onJob: value => seen.push(value), onUnavailable: error => errors.push(error) });
  tracker.start(); await flush(); assert.equal(calls, 1); assert.equal(seen.at(-1).progress, 15);
  for (const delay of [1000, 2000, 4000, 5000]) { t.mock.timers.tick(delay - 1); await flush(); const previous = calls; t.mock.timers.tick(1); await flush(); assert.equal(calls, previous + 1); }
  assert.equal(errors.length, 4); assert.equal(calls, 5); assert.equal(seen.at(-1).status, 'completed');
  t.mock.timers.tick(60000); await flush(); assert.equal(calls, 5);
});

test('a12s request timeout aborts the GET, reports unavailability and permits one subsequent retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [], errors = []; let calls = 0, signal;
  const tracker = createJobTracker({ id: job().id, seed: job(8), read: value => { calls++; signal = value; if (calls > 1) return Promise.resolve(job(100, 'completed')); return new Promise((_, reject) => value.addEventListener('abort', () => reject(value.reason), { once: true })); }, onJob: value => seen.push(value), onUnavailable: error => errors.push(error) });
  tracker.start(); await flush(); t.mock.timers.tick(11999); await flush(); assert.equal(errors.length, 0); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(signal.aborted, true); assert.equal(errors[0].code, 'JOB_STATUS_TIMEOUT'); assert.equal(seen.at(-1).progress, 8);
  t.mock.timers.tick(1000); await flush(); assert.equal(calls, 2); assert.equal(seen.at(-1).status, 'completed');
});

test('a terminal seed requires no status read and a failed job never displays100%', () => {
  const seen = []; let calls = 0;
  const tracker = createJobTracker({ id: job().id, seed: job(100, 'failed'), read: async () => { calls++; return job(); }, onJob: value => seen.push(value) });
  tracker.start(); assert.equal(calls, 0); assert.equal(seen[0].status, 'failed'); assert.equal(seen[0].progress, 99);
});

test('a pending GET remains the only flight while dashboard observations and polling intervals pass', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred(), seen = []; let calls = 0;
  const tracker = createJobTracker({ id: job().id, seed: job(), read: () => { calls++; return pending.promise; }, onJob: value => seen.push(value) });
  t.after(() => tracker.stop()); tracker.start(); await flush();
  for (let i = 0; i < 9; i++) { tracker.observe(job(20 + i)); tracker.start(); t.mock.timers.tick(1000); await flush(); }
  assert.equal(calls, 1); assert.equal(seen.at(-1).progress, 28);
  pending.resolve(job(50)); await flush(); t.mock.timers.tick(999); await flush(); assert.equal(calls, 1);
  tracker.stop();
});

test('an obsolete actor/modal before start receives neither the accepted seed nor a GET', () => {
  const seen = []; let calls = 0;
  const tracker = createJobTracker({ id: job().id, seed: job(), isCurrent: () => false, read: async () => { calls++; return job(); }, onJob: value => seen.push(value) });
  tracker.start(); assert.equal(calls, 0); assert.equal(seen.length, 0); assert.equal(tracker.observe(job(50)), false);
});

test('successful unchanged status after a read failure clears unavailability once without duplicate terminal emission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = []; let calls = 0, unavailable = false;
  const tracker = createJobTracker({ id: job().id, seed: job(15), read: async () => { calls++; if (calls === 2) throw new Error('Temporary status read failure'); return calls === 4 ? job(100, 'completed') : job(15); }, onJob: value => { seen.push(value); unavailable = false; }, onUnavailable: () => { unavailable = true; } });
  t.after(() => tracker.stop()); tracker.start(); await flush(); assert.equal(calls, 1); assert.equal(seen.length, 1, 'Ordinary identical success remains deduplicated');
  t.mock.timers.tick(1000); await flush(); assert.equal(unavailable, true); assert.equal(seen.length, 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(unavailable, false, 'An unchanged but successful GET proves status reads recovered'); assert.equal(seen.length, 2); assert.equal(seen.at(-1).progress, 15);
  t.mock.timers.tick(1000); await flush(); assert.equal(seen.at(-1).status, 'completed'); assert.equal(seen.length, 3, 'Terminal observation emits once before stopping');
  t.mock.timers.tick(60000); await flush(); assert.equal(calls, 4); assert.equal(seen.length, 3);
});
