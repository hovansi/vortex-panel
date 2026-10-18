import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import yauzl from 'yauzl';
import { createStore } from '../server/store.js';
import { createManager } from '../server/manager.js';
import { applicationStarterSources, applicationEnvironment, redactApplicationOutput, applicationIssue } from '../server/application-schema.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';
import { waitJob } from './worlds-fixture.js';
import { fixtureManagedRuntime } from './application-managed-fixture.js';

const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(read, predicate, timeout = 2500) { const end = Date.now() + timeout; while (Date.now() < end) { const value = read(); if (predicate(value)) return value; await tick(); } throw Error('Isolated manager did not reach the expected state'); }
const capabilities = { supported: true, isolation: 'nonroot-bubblewrap', networkIsolated: false, runtimes: { nodejs: { available: true, version: 'v22.15.0', dependenciesAvailable: true }, python: { available: true, version: 'Python 3.12.0', dependenciesAvailable: true } } };
const input = changes => ({ kind: 'nodejs', name: 'Owned application manager fixture', port: 43180, resourcePolicy: { mode: 'fixed', cpuCores: 0.5, memoryMiB: 512 }, storagePolicy: { mode: 'fixed', diskGiB: 1 }, application: { entrypoint: 'server.js', args: ['with spaces', ''], environment: [{ name: 'API_KEY', value: 'fixture-secret-do-not-log', secret: true }], dependencies: 'none', readiness: 'process' }, ...changes });

async function fixture(t, { gate, supported = true, failDependencies = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-application-manager-')), store = createStore(dataDir), calls = [], children = [];
  const run = id => path.join(dataDir, 'servers', id, 'run');
  const storage = createDirectoryStorageFixture(dataDir), ordinaryStats = storage.stats;
  // Only this injected controller reports enforcement for manager branch tests.
  // It remains ordinary fixture directories: this is never kernel quota proof.
  storage.stats = async server => ({ ...await ordinaryStats(server), hardEnforced: true, enforcement: 'synthetic-manager-branch-only' });
  const cap = { supported: true, fixedSupported: true, pidsSupported: true, cpu: { minCores: 0.1, maxCores: 8 }, memory: { minMiB: 256, maxMiB: 16000 }, managedPool: { cpuCores: 7.2, memoryMiB: 14745, reserveRatio: 0.1, kernelEnforced: false } };
  const resources = {
    capabilities: () => cap, initialize: async () => cap,
    prepare: async (id, policy, options) => {
      calls.push(['resources', id, structuredClone(policy), structuredClone(options)]);
      return { policy, effective: { cgroupPath: '/synthetic-no-native-cgroup/' + id }, cleanup: async () => ({ stats: {}, warnings: [] }), stats: async () => ({}),
        spawnWithArgs(executable, args, options, execution) {
          calls.push(['spawn', executable, structuredClone(args), structuredClone(options.env), execution]);
          const child = new EventEmitter(); child.pid = 99999990 + children.length; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
          child.kill = signal => { if (!child.killed) { child.killed = true; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0, signal); }); } return true; };
          children.push(child); return { child, ready: Promise.resolve() };
        },
        spawn() { throw Error('Application must not use the Bedrock spawn path'); },
      };
    },
  };
  const applicationController = {
    ...fixtureManagedRuntime(() => ({ ...capabilities, supported })),
    initialize: async () => capabilities, capabilities: () => ({ ...capabilities, supported }), close: async () => {},
    prepareWorkspace: async (server, { seed = false } = {}) => {
      calls.push(['workspace', server.id, seed]); if (gate && seed) await gate.promise;
      await fs.mkdir(run(server.id), { recursive: true });
      if (seed) for (const [filename, content] of Object.entries(applicationStarterSources(server.kind))) await fs.writeFile(path.join(run(server.id), filename), content, { flag: 'wx' });
    },
    installDependencies: async (server, options) => { calls.push(['dependencies', server.id]); options.onOutput?.('Installing fixture dependencies'); if (failDependencies) throw applicationIssue('APPLICATION_DEPENDENCIES'); return { installed: true, commandsCompleted: 1 }; },
    launchPlan: async server => ({ executable: '/synthetic/setpriv', args: ['--synthetic-bwrap', '/workspace/' + server.application.entrypoint, ...server.application.args], options: { cwd: run(server.id), env: applicationEnvironment(server.application, { port: server.port, username: 'fixture_app', install: true }), shell: false, stdio: ['pipe', 'pipe', 'pipe'] }, stdinPrelude: JSON.stringify(applicationEnvironment(server.application, { port: server.port, username: 'fixture_app' })) + '\n', execution: { cleanEnvironment: true }, runtime: { kind: server.kind, version: 'fixture-runtime', uid: 12345, networkIsolated: false } }),
    redact: (server, line) => redactApplicationOutput(line, server.application), releaseWorkspace: async server => { calls.push(['release', server.id]); return { removed: true }; },
  };
  const network = { initialize: async () => ({ supported: false }), capabilities: () => ({ supported: false }), syncServers: async () => {}, sample: async () => ({}), peek: () => ({ available: false }), close: async () => {} };
  const manager = await createManager({ store, dataDir, demo: false, storageController: storage, resourceController: resources, applicationController, networkMetrics: network, hostReader: directoryFixtureHost });
  const managers = [manager];
  t.after(async () => {
    gate?.resolve(); for (const current of managers) await current.close(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('vortex-application-manager-')); await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store, manager, calls, children, run, cap, applicationController, async reopen() {
    await managers.at(-1).close();
    const reloadedStore = createStore(dataDir), reloadedManager = await createManager({ store: reloadedStore, dataDir, demo: false, storageController: storage, resourceController: resources, applicationController, networkMetrics: network, hostReader: directoryFixtureHost });
    managers.push(reloadedManager); return { store: reloadedStore, manager: reloadedManager };
  } };
}

test('native-mode manager creates app without Minecraft EULA/version, returns active job first, masks secrets and never fabricates Minecraft files', async t => {
  const gate = deferred(), f = await fixture(t, { gate });
  const accepted = await f.manager.createServer(input());
  assert.equal(accepted.server.kind, 'nodejs'); assert.equal(accepted.server.portV6, null); assert.equal(accepted.server.transport, 'tcp');
  assert.equal(accepted.server.status, 'installing'); assert.ok(['queued', 'running'].includes(accepted.job.status)); assert.ok(accepted.job.progress < 100);
  assert.equal(JSON.stringify(accepted).includes('fixture-secret-do-not-log'), false); assert.equal(f.store.data.servers[0].application.environment[0].value, 'fixture-secret-do-not-log');
  await assert.rejects(f.manager.action(accepted.server.id, 'start'), error => error.status === 409);
  gate.resolve(); const complete = await waitJob(f.manager, accepted.job.id); assert.equal(complete.progress, 100);
  assert.equal(f.manager.getServer(accepted.server.id).status, 'stopped');
  assert.deepEqual((await fs.readdir(f.run(accepted.server.id))).sort(), ['package.json', 'server.js']);
  assert.equal(f.calls.some(row => row[0] === 'dependencies'), false);
});

test('startup revisions retain an omitted secret exactly and reject stale/invalid drafts without modifying durable settings', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id;
  const original = await f.manager.application(id); assert.equal(original.application.environment[0].value, null); assert.equal(original.application.environment[0].hasValue, true);
  const draft = { ...original.application, args: ['still one argument with spaces', ''], environment: [{ name: 'API_KEY', secret: true }] };
  const saved = await f.manager.saveApplication(id, { revision: original.revision, application: draft });
  assert.notEqual(saved.revision, original.revision); assert.equal(f.store.data.servers[0].application.environment[0].value, 'fixture-secret-do-not-log');
  await assert.rejects(f.manager.saveApplication(id, { revision: original.revision, application: { ...draft, args: ['stale must not apply'] } }), error => error.status === 409);
  await assert.rejects(f.manager.saveApplication(id, { revision: saved.revision, application: { ...draft, environment: [{ name: 'RENAMED_KEY', secret: true }] } }), error => error.code === 'APPLICATION_SECRET_MISSING');
  assert.deepEqual((await f.manager.application(id)).application.args, draft.args);
  assert.equal((await f.manager.configuration(id)).network.transport, 'tcp');
});

test('Python creation always prepares its environment even without pip dependencies and never creates Bedrock or Node startup files', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input({ kind: 'python', application: { entrypoint: 'app.py', args: ['one argument'], environment: [], dependencies: 'none', readiness: 'process' } }));
  await waitJob(f.manager, accepted.job.id); assert.equal(accepted.server.kind, 'python'); assert.equal(accepted.server.version, '3.15.0'); assert.equal(accepted.server.runtime.version, '3.15.0');
  assert.equal(f.calls.filter(row => row[0] === 'dependencies').length, 1); assert.deepEqual((await fs.readdir(f.run(accepted.server.id))).sort(), ['app.py', 'requirements.txt']);
  assert.equal(f.manager.getServer(accepted.server.id).status, 'stopped');
});

test('lifecycle uses injected app argv and clean environment, requires128-task controller, redacts stdout and locks every app file/config operation while running', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id;
  const previous = process.env.VORTEX_MANAGER_TEST_SECRET; process.env.VORTEX_MANAGER_TEST_SECRET = 'must-not-reach-child';
  try { await f.manager.action(id, 'start'); } finally { if (previous === undefined) delete process.env.VORTEX_MANAGER_TEST_SECRET; else process.env.VORTEX_MANAGER_TEST_SECRET = previous; }
  await until(() => f.manager.getServer(id).status, value => value === 'running');
  const prepared = f.calls.find(row => row[0] === 'resources'), spawn = f.calls.find(row => row[0] === 'spawn');
  assert.deepEqual(prepared[3], { tasksMax: 128 }); assert.deepEqual(spawn[2], ['--synthetic-bwrap', '/workspace/server.js', 'with spaces', '']);
  assert.equal(spawn[3].API_KEY, undefined); assert.equal(JSON.parse(f.children[0].stdin.read().toString()).API_KEY, 'fixture-secret-do-not-log'); assert.equal(f.children[0].stdin.read(), null); assert.equal(spawn[3].VORTEX_MANAGER_TEST_SECRET, undefined); assert.deepEqual(spawn[4], { cleanEnvironment: true });
  f.children[0].stdout.write('fixture-secret-do-not-log is redacted\n'); await tick(); assert.equal(JSON.stringify(f.manager.logs(id)).includes('fixture-secret-do-not-log'), false); assert.match(JSON.stringify(f.manager.logs(id)), /redacted/);
  for (const operation of [() => f.manager.files(id, ''), () => f.manager.readFile(id, 'server.js'), () => f.manager.downloadFile(id, 'server.js'), () => f.manager.writeFile(id, 'server.js', 'no'), () => f.manager.saveApplication(id, {}), () => f.manager.installApplicationDependencies(id), () => f.manager.backup(id)]) await assert.rejects(operation(), error => error.status === 409);
  await f.manager.action(id, 'stop'); assert.equal(f.manager.getServer(id).status, 'stopped'); assert.ok((await f.manager.readFile(id, 'server.js')).content.includes('http'));
});

test('failed dependency job remains failed, preserves source and config, unlocks stopped files and never retries or starts the app', async t => {
  const f = await fixture(t, { failDependencies: true }), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id;
  const before = await f.manager.application(id), source = await fs.readFile(path.join(f.run(id), 'server.js'));
  const job = await f.manager.installApplicationDependencies(id); assert.ok(['queued', 'running'].includes(job.status));
  const failed = await waitJob(f.manager, job.id, 'failed'); assert.ok(failed.progress < 100); assert.equal(f.calls.filter(row => row[0] === 'dependencies').length, 1);
  assert.equal((await f.manager.application(id)).revision, before.revision); assert.deepEqual(await fs.readFile(path.join(f.run(id), 'server.js')), source);
  assert.equal(f.manager.getServer(id).busy, false); assert.notEqual(f.manager.getServer(id).status, 'running'); assert.equal(f.children.length, 0);
  assert.equal((await f.manager.files(id, '')).files.length, 2);
});

async function zipNames(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error); const names = []; zip.on('entry', entry => { names.push(entry.fileName); zip.readEntry(); }); zip.on('error', reject); zip.on('end', () => resolve(names)); zip.readEntry();
  }));
}
test('actual source backup ZIP excludes generated dependency/cache trees including unsafe symlinks and advertises reinstall semantics', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id, run = f.run(id);
  for (const folder of ['node_modules/pkg', '.venv/bin', '.home/cache']) { await fs.mkdir(path.join(run, folder), { recursive: true }); await fs.writeFile(path.join(run, folder, 'excluded.txt'), 'do not back up generated files'); }
  await fs.symlink(path.join(f.dataDir, 'not-a-source-target'), path.join(run, 'node_modules', 'unsafe-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const job = await f.manager.backup(id); await waitJob(f.manager, job.id); const backup = f.manager.backups(id)[0];
  const names = await zipNames(path.join(f.dataDir, 'servers', id, 'backups', backup.id + '.zip'));
  assert.ok(names.includes('server.js')); assert.ok(names.includes('package.json')); assert.equal(names.some(name => /^(?:node_modules|\.venv|\.home)(?:\/|$)/.test(name)), false);
  assert.equal(backup.dependenciesRequireInstall, true); assert.deepEqual(backup.excludes, ['node_modules/', '.venv/', '.home/']); assert.equal(backup.kind, 'nodejs');
});

test('app downloads are immutable snapshots under the stopped-file lock and reject files above100MiB before returning content', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id, filename = path.join(f.run(id), 'server.js');
  const source = await fs.readFile(filename), download = await f.manager.downloadFile(id, 'server.js');
  assert.ok(Buffer.isBuffer(download.content)); assert.equal(download.path, undefined); assert.deepEqual(download.content, source);
  await fs.writeFile(filename, 'mutated after snapshot'); assert.deepEqual(download.content, source);
  const oversized = await fs.open(path.join(f.run(id), 'oversized.bin'), 'w'); await oversized.truncate(100 * 1024 ** 2 + 1); await oversized.close();
  await assert.rejects(f.manager.downloadFile(id, 'oversized.bin'), error => error.status === 413);
});

test('unsupported sandbox or missing PID delegation rejects create before server/job/disk records exist', async t => {
  const unsupported = await fixture(t, { supported: false });
  await assert.rejects(unsupported.manager.createServer(input()), error => error.code === 'APPLICATION_UNSUPPORTED'); assert.equal(unsupported.store.data.servers.length, 0); assert.equal(unsupported.store.data.jobs.length, 0);
  const pids = await fixture(t); pids.cap.pidsSupported = false;
  await assert.rejects(pids.manager.createServer(input()), error => error.code === 'APPLICATION_UNSUPPORTED'); assert.equal(pids.store.data.servers.length, 0); assert.equal(pids.calls.length, 0);
});

test('a real foreign TCP listener rejects application creation before any job, server or storage allocation', async t => {
  const f = await fixture(t), listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen({host:'127.0.0.1',port:0}, resolve); });
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = listener.address().port;
  await assert.rejects(f.manager.createServer(input({port})), error => error.status === 409 && /TCP/.test(error.message));
  assert.equal(f.store.data.servers.length, 0); assert.equal(f.store.data.jobs.length, 0);
  assert.equal(f.calls.some(row => row[0] === 'workspace'), false);
});

test('latest-runtime resolution failure accepts no server/job and never silently uses the available host runtime', async t => {
  const f = await fixture(t); let resolutions = 0;
  f.applicationController.resolveRuntime = async () => { resolutions++; throw applicationIssue('APPLICATION_RUNTIME_CATALOG', 502); };
  await assert.rejects(f.manager.createServer(input()), { code: 'APPLICATION_RUNTIME_CATALOG' });
  assert.equal(resolutions, 1); assert.equal(f.store.data.servers.length, 0); assert.equal(f.store.data.jobs.length, 0); assert.equal(f.calls.length, 0);
});
test('new app pins exact official runtime and task records actual bounded redacted output, phase changes and startup configuration', async t => {
  const f = await fixture(t); let resolved, installed;
  const originalResolve = f.applicationController.resolveRuntime;
  f.applicationController.resolveRuntime = async kind => { resolved = await originalResolve(kind); return resolved; };
  f.applicationController.ensureRuntime = async (server, options) => { installed = structuredClone(server.runtime); for (const suffix of 'abcdefghijklmnopqrstuvwxy') options.onProgress?.({ phase: 'runtime-' + suffix }); return {}; };
  f.applicationController.installDependencies = async (server, options) => { for (let n = 0; n < 300; n++) options.onOutput?.(`line${n} fixture-secret-do-not-log ${'x'.repeat(500)}`); return { installed: true, commandsCompleted: 1, kind: server.kind, version: server.runtime.version }; };
  const accepted = await f.manager.createServer(input({ application: { ...input().application, dependencies: 'auto', startup: { mode: 'npm-script', script: 'start' } } }));
  assert.deepEqual(f.store.data.servers[0].runtime, resolved); assert.equal(accepted.server.version, resolved.version); assert.equal(accepted.server.runtime.source, 'nodejs.org'); assert.equal(Object.hasOwn(accepted.server.runtime, 'url'), false);
  const done = await waitJob(f.manager, accepted.job.id); assert.equal(done.status, 'completed'); assert.deepEqual(installed, resolved); assert.ok(Date.parse(done.startedAt) >= Date.parse(done.createdAt)); assert.ok(Date.parse(done.finishedAt) >= Date.parse(done.startedAt));
  assert.deepEqual(done.subject, { name: input().name, kind: 'nodejs' }); assert.equal(done.phaseHistory.length, 16); assert.equal(done.phaseHistory.at(-1).phase, 'complete'); assert.ok(done.phaseHistory.every(row => Number.isFinite(Date.parse(row.at))));
  assert.equal(done.output.truncated, true); assert.ok(done.output.lines.length <= 200); assert.ok(Buffer.byteLength(done.output.lines.join('\n')) <= 65536); assert.equal(JSON.stringify(done).includes('fixture-secret-do-not-log'), false); assert.ok(done.output.lines.some(line => line.includes('[redacted]')));
  assert.deepEqual(done.result.startup, { mode: 'npm-script', script: 'start' }); assert.equal(done.result.runtime.version, resolved.version); assert.equal(done.result.port, accepted.server.port);
});
test('legacy runtime/startup config stays byte-equivalent on read; stopped inspection holds a lease against start and never inspects running files', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const raw = f.store.data.servers[0], id = raw.id; delete raw.runtime; raw.version = 'v22.15.0';
  const projection = () => JSON.stringify({ kind: raw.kind, version: raw.version, runtime: raw.runtime, application: raw.application, resourcePolicy: raw.resourcePolicy, storagePolicy: raw.storagePolicy, port: raw.port });
  const before = projection(), gate = deferred(); let inspections = 0;
  f.applicationController.inspectProject = async () => { inspections++; await gate.promise; return { manifests: [], packages: [], runtime: { mode: 'legacy', version: raw.version } }; };
  const reading = f.manager.application(id); await until(() => inspections, value => value === 1);
  await assert.rejects(f.manager.action(id, 'start'), error => error.status === 409); gate.resolve(); const read = await reading; assert.equal(read.project.inspectionAvailable, true); assert.equal(projection(), before); assert.equal(Object.hasOwn(raw.application, 'startup'), false); assert.equal(Object.hasOwn(raw, 'runtime'), false);
  raw.status = 'running'; const active = await f.manager.application(id); assert.equal(inspections, 1); assert.equal(active.project.inspectionAvailable, false); assert.equal(active.project.inspectedAt, read.project.inspectedAt); assert.equal(projection(), before); raw.status = 'stopped';
});
test('restart-pending runtime cleanup blocks creation, resource growth and start while keeping monitoring available', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id;
  f.applicationController.assertNoPendingBuilds = async () => { throw applicationIssue('APPLICATION_RUNTIME_CLEANUP', 409, { cleanupPending: [{ volumeId: 'fixture-owned-build' }] }); };
  await assert.rejects(f.manager.createServer(input({ name: 'Blocked new allocation', port: 43181 })), { code: 'APPLICATION_RUNTIME_CLEANUP' });
  await assert.rejects(f.manager.updateServer(id, { resourcePolicy: { mode: 'fixed', cpuCores: 0.6, memoryMiB: 768 } }), { code: 'APPLICATION_RUNTIME_CLEANUP' });
  await assert.rejects(f.manager.action(id, 'start'), { code: 'APPLICATION_RUNTIME_CLEANUP' });
  assert.equal(f.manager.listServers().length, 1); assert.equal((await f.manager.application(id)).server.id, id); assert.equal(f.children.length, 0);
});

test('running project summaries preserve verified outdated dependencies until a different installation actually completes', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const raw = f.store.data.servers[0], id = raw.id;
  raw.dependencyState = { status: 'installed', installedAt: '2026-10-18T01:00:00.000Z', manifestFingerprint: 'a'.repeat(64) };
  let inspections = 0;
  f.applicationController.inspectProject = async () => { inspections++; return { manifests: [], packages: [], dependencyState: { status: 'outdated', installedAt: raw.dependencyState.installedAt, manifestChanged: true, kind: raw.kind, manifest: 'package.json' } }; };
  const inspected = await f.manager.application(id); assert.equal(inspected.project.dependencyState.status, 'outdated'); assert.equal(inspections, 1);
  raw.status = 'running'; const running = await f.manager.application(id); assert.equal(running.project.inspectionAvailable, false); assert.equal(running.project.dependencyState.status, 'outdated'); assert.equal(running.project.dependencyState.manifestChanged, true); assert.equal(running.project.inspectedAt, inspected.project.inspectedAt); assert.equal(inspections, 1);
  raw.dependencyState = { status: 'installed', installedAt: '2026-10-18T02:00:00.000Z', manifestFingerprint: 'b'.repeat(64) };
  const reinstalled = await f.manager.application(id); assert.equal(reinstalled.project.dependencyState.status, 'installed'); assert.equal(reinstalled.project.dependencyState.installedAt, raw.dependencyState.installedAt); assert.equal(reinstalled.project.dependencyState.manifestChanged, undefined); assert.equal(inspections, 1); raw.status = 'stopped';
});

for (const kind of ['nodejs', 'python']) for (const managed of [true, false]) {
  test(`${managed ? 'managed' : 'legacy'} ${kind} runtime version survives start, stop and durable manager reload`, async t => {
    const f = await fixture(t), accepted = await f.manager.createServer(input({ kind, application: { entrypoint: kind === 'nodejs' ? 'server.js' : 'app.py', args: [], environment: [], dependencies: 'none', readiness: 'process' } }));
    await waitJob(f.manager, accepted.job.id); const id = accepted.server.id, raw = f.store.data.servers[0];
    if (!managed) { delete raw.runtime; raw.version = capabilities.runtimes[kind].version; f.store.save(); }
    const pin = structuredClone(raw.runtime), application = structuredClone(raw.application), expected = managed ? pin.version : capabilities.runtimes[kind].version;
    const launch = f.applicationController.launchPlan;
    f.applicationController.launchPlan = async server => {
      const plan = await launch(server), version = managed ? kind === 'python' ? `Python ${pin.version}` : pin.version : capabilities.runtimes[kind].version;
      return { ...plan, runtime: { ...plan.runtime, mode: managed ? 'managed' : 'legacy', version } };
    };
    f.applicationController.resolveRuntime = async () => { throw Error('Starting an existing app must not resolve a new runtime'); };
    f.applicationController.ensureRuntime = async () => { throw Error('Starting an existing app must not install another runtime'); };
    let current = { manager: f.manager, store: f.store };
    const check = () => {
      const server = current.manager.getServer(id), stored = current.store.data.servers.find(row => row.id === id);
      assert.equal(server.version, expected); assert.equal(stored.version, expected); assert.deepEqual(stored.application, application);
      if (managed) { assert.deepEqual(stored.runtime, pin); assert.equal(server.runtime.version, pin.version); }
      else { assert.equal(Object.hasOwn(stored, 'runtime'), false); assert.equal(server.runtime, null); }
    };
    for (let cycle = 0; cycle < 2; cycle++) {
      await current.manager.action(id, 'start');
      await until(() => current.manager.getServer(id).status, value => value === 'running'); check();
      await current.manager.action(id, 'stop'); assert.equal(current.manager.getServer(id).status, 'stopped'); check();
      if (cycle === 0) {
        // A0157 Python record can already carry the display label. Loading it
        // preserves history; the next explicit start restores its exact pin.
        const historical = managed && kind === 'python' ? `Python ${pin.version}` : expected;
        current.store.data.servers.find(row => row.id === id).version = historical; current.store.save();
        current = await f.reopen(); assert.equal(current.manager.getServer(id).version, historical);
        assert.deepEqual(current.store.data.servers.find(row => row.id === id).runtime, pin);
      }
    }
    assert.equal(f.children.length, 2);
  });
}

test('partially acknowledged application SIGTERM waits for child shutdown without an immediate supervisor kill', async t => {
  const f = await fixture(t), accepted = await f.manager.createServer(input()); await waitJob(f.manager, accepted.job.id); const id = accepted.server.id;
  await f.manager.action(id, 'start'); await until(() => f.manager.getServer(id).status, value => value === 'running');
  f.applicationController.signalApplication = async () => {
    setImmediate(() => { f.children[0].stdout.end(); f.children[0].stderr.end(); f.children[0].emit('close', 0, null); });
    return { sent: true, signal: 'SIGTERM', pid: 444, pids: [444], partial: true, pendingPids: [666] };
  };
  await f.manager.action(id, 'stop'); assert.equal(f.manager.getServer(id).status, 'stopped'); assert.equal(f.children[0].killed, false);
  assert.match(JSON.stringify(f.manager.logs(id)), /SIGTERM reached 1 application process\(es\); 1 delivery failed\. Waiting before forced cleanup\./);
});
