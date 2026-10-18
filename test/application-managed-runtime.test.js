import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createManagedRuntimeStore } from '../server/application-managed-runtime.js';
import { fixtureRuntimePin } from './application-managed-fixture.js';

const bytes = Buffer.from('official archive fixture; extraction is injected, not native proof');
async function fixture(t, { failDownload = false, failArtifact = false, beforeFetch, wrongLength = false, slowDownload = false, downloadTimeoutMs, timeoutMs } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-managed-cache-')), modes = new Map(), calls = [];
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('vortex-managed-cache-')); await fs.rm(directory, { recursive: true, force: true }); });
  // Windows does not implement POSIX UID/mode. This explicit adapter tests
  // cache control flow only; archive tests below run the actual trusted code.
  const info = value => Object.assign(value, { uid: 0, gid: 0, mode: (value.mode & ~0o777) | 0o755 });
  const io = { ...fs, lstat: async filename => { const stat = info(await fs.lstat(filename)); stat.mode = (stat.mode & ~0o777) | (modes.get(filename) ?? (stat.isDirectory() ? 0o755 : 0o644)); return stat; }, mkdir: async (filename, options) => { await fs.mkdir(filename, options); modes.set(filename, options?.mode ?? 0o755); }, chmod: async (filename, mode) => { await fs.chmod(filename, mode); modes.set(filename, mode); } };
  const pin = { ...fixtureRuntimePin('nodejs'), sha256: createHash('sha256').update(bytes).digest('hex') };
  const request = async (url, options) => { calls.push(['fetch', url]); assert.equal(options.redirect, 'error'); await beforeFetch?.(); if (failDownload) throw Error('fixtureTLSfailure');
    if (slowDownload) { let timer; return new Response(new ReadableStream({ start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array([1])), 5); options.signal.addEventListener('abort', () => { clearInterval(timer); controller.error(Error('bounded fixture transfer aborted')); }, { once: true }); }, cancel() { clearInterval(timer); } })); }
    return new Response(bytes, { headers: { 'content-length': String(bytes.length + (wrongLength ? 1 : 0)) } }); };
  const nativeStore = createManagedRuntimeStore({ dataDir: directory, fs: io, fetch: request, downloadTimeoutMs, timeoutMs, canonical: async () => {}, trustedFile: async filename => { if (filename.startsWith(directory)) await fs.lstat(filename); return filename; }, command: async (_python, args) => {
    if (_python === '/usr/bin/pkg-config') return { stdout: '' };
    const mode = args[3]; calls.push(['artifact', mode]); if (failArtifact) throw Error('fixtureArtifactFailure');
    if (mode === 'extract') { const target = path.join(args[5], args[6]); await fs.mkdir(path.join(target, 'bin'), { recursive: true }); await fs.mkdir(path.join(target, 'lib/node_modules/npm/bin'), { recursive: true }); await fs.writeFile(path.join(target, 'bin/node'), 'fixture executable'); await fs.writeFile(path.join(target, 'lib/node_modules/npm/bin/npm-cli.js'), 'fixture npm'); }
    else if (mode === 'promote') await fs.cp(args[4], args[5], { recursive: true, errorOnExist: true, force: false });
    else throw Error('Unexpected trusted artifact invocation'); return { stdout: '{"ok":true}' };
  } });
  const store = { ...nativeStore, ensure: (pin, options) => nativeStore.ensure(pin, { validate: async () => {}, ...options }) };
  t.after(() => store.close()); let held = 0;
  const reserve = async resources => { calls.push(['reserve', resources]); held++; return () => { held--; calls.push(['release']); }; };
  return { store, pin, calls, reserve, directory, held: () => held };
}
test('simultaneous exact-runtime installs share one verified download/promotion and release one admission reservation', async t => {
  let resume, entered; const gate = new Promise(resolve => { resume = resolve; }), fetchEntered = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { beforeFetch: () => { entered(); return gate; } });
  const operations = [f.store.ensure(f.pin, { reserve: f.reserve }), f.store.ensure(f.pin, { reserve: f.reserve })];
  const completed = Promise.all(operations); completed.catch(() => {}); let entryTimer;
  try {
    await Promise.race([fetchEntered, new Promise((_, reject) => { entryTimer = setTimeout(() => reject(Error('Managed runtime fixture did not enter fetch within 2 seconds.')), 2000); })]);
    clearTimeout(entryTimer); assert.equal(f.calls.filter(row => row[0] === 'fetch').length, 1); assert.equal(f.held(), 1); resume();
    const [a, b] = await completed; assert.equal(a.prefix, b.prefix); assert.equal(f.held(), 0);
    assert.equal(f.calls.filter(row => row[0] === 'artifact' && row[1] === 'promote').length, 1);
    assert.equal((await f.store.ensure(f.pin, { reserve: f.reserve })).prefix, a.prefix); assert.equal(f.calls.filter(row => row[0] === 'fetch').length, 1);
    assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtime-builds')), []);
    await assert.rejects(f.store.ensure({ ...f.pin, sha256: 'f'.repeat(64) }, { reserve: f.reserve }), { code: 'APPLICATION_RUNTIME_PIN' });
  } finally { clearTimeout(entryTimer); resume(); await Promise.allSettled(operations); }
});
test('checksum mismatch, truncated transfer and download failures leave no ready cache and release all reservations', async t => {
  for (const settings of [{ failDownload: true }, { wrongLength: true }, {}]) {
    const f = await fixture(t, settings); const pin = settings.failDownload || settings.wrongLength ? f.pin : { ...f.pin, sha256: '0'.repeat(64) };
    await assert.rejects(f.store.ensure(pin, { reserve: f.reserve }), { code: 'APPLICATION_RUNTIME_DOWNLOAD' }); assert.equal(f.held(), 0);
    assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtimes')), []); assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtime-builds')), []);
  }
});
test('artifact failure, promotion process-drain rejection and capacity rejection never publish partial runtimes', async t => {
  for (const mode of ['artifact', 'drain', 'admission']) {
    const f = await fixture(t, { failArtifact: mode === 'artifact' });
    await assert.rejects(f.store.ensure(f.pin, { reserve: mode === 'admission' ? async () => { throw Error('capacity fixture rejected'); } : f.reserve, beforePromote: mode === 'drain' ? async () => { throw Error('owned builder UID still live'); } : undefined }));
    assert.equal(f.held(), 0); assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtimes')), []); assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtime-builds')), []);
    if (mode === 'admission') assert.equal(f.calls.some(row => row[0] === 'fetch'), false);
    if (mode === 'drain') assert.equal(f.calls.some(row => row[0] === 'artifact' && row[1] === 'promote'), false);
  }
});
test('missing Python prerequisites reject before reservation or official source download', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-python-prerequisites-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); const modes = new Map();
  const io = { ...fs, mkdir: async (name, options) => { await fs.mkdir(name, options); modes.set(name, options.mode); }, lstat: async name => { const stat = await fs.lstat(name); return Object.assign(stat, { mode: (stat.mode & ~0o777) | (modes.get(name) ?? 0o755) }); } };
  let network = 0, admission = 0; const store = createManagedRuntimeStore({ dataDir: directory, fs: io, canonical: async () => {}, trustedFile: async () => { throw Error('missing'); }, fetch: async () => { network++; throw Error('must not download'); }, command: async () => { throw Error('must not execute'); } });
  await assert.rejects(store.ensure(fixtureRuntimePin('python'), { reserve: async () => { admission++; } }), { code: 'APPLICATION_RUNTIME_TOOLS' }); assert.equal(network, 0); assert.equal(admission, 0); await store.close();
});
test('Python prerequisites require a trusted host awk executable before admitting a source build', async () => {
  let network = 0; const store = createManagedRuntimeStore({ dataDir: '/inert-prerequisite-fixture', trustedFile: async filename => { if (filename === '/usr/bin/awk') throw Error('missing awk'); return filename; }, command: async executable => { assert.equal(executable, '/usr/bin/pkg-config'); return { stdout: '' }; }, fetch: async () => { network++; throw Error('must not download'); } });
  const prerequisites = await store.prerequisites(); assert.equal(prerequisites.ready, false); assert.deepEqual(prerequisites.missing, ['/usr/bin/awk']); assert.equal(network, 0); await store.close();
});
test('Python source uses a separate bounded volume; failed drain/cleanup retains reservation and quarantines the ledger', async t => {
  for (const mode of ['success', 'close-failed', 'undrained']) {
    const f = await fixture(t), pin = { ...fixtureRuntimePin('python'), sha256: f.pin.sha256 }, volume = path.join(f.directory, 'hard-volume-fixture'); await fs.mkdir(volume); let closed = 0, quarantined = 0;
    const operation = f.store.ensure(pin, { reserve: f.reserve, volume: async () => ({ path: volume, quarantine: () => quarantined++, close: async () => { closed++; if (mode === 'close-failed') throw Object.assign(Error('owned mount still busy'), { cleanupPending: 'owned-volume' }); await fs.rm(volume, { recursive: true }); } }), build: async ({ workspace }) => {
      assert.ok(workspace.startsWith(volume + path.sep));
      if (mode === 'undrained') throw Object.assign(Error('owned cgroup has not drained'), { cleanupPending: 'owned-cgroup' });
      const prefix = path.join(workspace, 'output/runtime/python'); await fs.mkdir(path.join(prefix, 'bin'), { recursive: true }); await fs.writeFile(path.join(prefix, 'bin/python3.15'), 'not a real executable'); return prefix;
    } });
    if (mode === 'success') { assert.equal((await operation).executable, '/runtime/python/bin/python3.15'); assert.equal(f.held(), 0); assert.equal(closed, 1); await assert.rejects(fs.lstat(volume), { code: 'ENOENT' }); }
    else { await assert.rejects(operation); assert.equal(f.held(), 1); assert.equal(f.calls.filter(row => row[0] === 'release').length, 0); assert.equal(closed, mode === 'undrained' ? 0 : 1); assert.equal(quarantined, mode === 'undrained' ? 1 : 0); assert.equal((await fs.lstat(volume)).isDirectory(), true); }
    const reservation = f.calls.find(row => row[0] === 'reserve')[1]; assert.equal(reservation.diskBytes, 6 * 1024 ** 3); assert.equal(reservation.volumeBytes, 3 * 1024 ** 3); assert.equal(reservation.memoryMiB, 1024);
  }
});
test('failed sandbox validation never publishes a ready cache and a later attempt must reverify the official artifact', async t => {
  const f = await fixture(t); let checked = 0;
  await assert.rejects(f.store.ensure(f.pin, { reserve: f.reserve, validate: async selected => { checked++; assert.ok(selected.prefix.includes('.ready-')); throw Error('nonroot fixed runtime validation failed'); } }));
  assert.equal(checked, 1); assert.equal(f.held(), 0); assert.equal(await f.store.installed(f.pin), null); assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtimes')), []);
  await f.store.ensure(f.pin, { reserve: f.reserve, validate: async () => { checked++; } }); assert.equal(checked, 2); assert.equal(f.calls.filter(row => row[0] === 'fetch').length, 2);
});
test('overall download deadline aborts a continuously progressing slow stream and releases its reservation', async t => {
  const f = await fixture(t, { slowDownload: true, timeoutMs: 50, downloadTimeoutMs: 100 });
  await assert.rejects(f.store.ensure(f.pin, { reserve: f.reserve }), { code: 'APPLICATION_RUNTIME_DOWNLOAD' }); assert.equal(f.held(), 0); assert.deepEqual(await fs.readdir(path.join(f.directory, '.application-runtime-builds')), []); assert.equal(f.calls.some(row => row[0] === 'artifact'), false);
});
