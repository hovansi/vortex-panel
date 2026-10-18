import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAuth } from '../server/auth.js';
import { createStore } from '../server/store.js';
import { createManager } from '../server/manager.js';
import { createNodes } from '../server/nodes.js';
import { createRouter } from '../server/routes.js';
import { applicationErrorPayload, applicationStarterSources } from '../server/application-schema.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';
import { waitJob } from './worlds-fixture.js';
import { fixtureManagedRuntime } from './application-managed-fixture.js';

const capabilities = {
  supported: true, isolation: 'synthetic-http-manager-test-only', networkIsolated: false,
  runtimes: { nodejs: { available: true, version: 'v22.fixture' }, python: { available: true, version: 'Python 3.fixture' } },
};
const password = 'local-placement-fixture-only';
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-local-placement-'));
  const store = createStore(directory), captured = [], received = [], realFetch = globalThis.fetch;
  let manager, nodes, server;
  t.after(async () => {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await nodes?.close(); await manager?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('vortex-local-placement-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return url.hostname === '127.0.0.1' ? realFetch(input, options) : Promise.reject(new Error('External catalog disabled in isolated HTTP fixture'));
  });
  const resourceCapabilities = { supported: true, fixedSupported: true, pidsSupported: true,
    cpu: { minCores: .1, maxCores: 8 }, memory: { minMiB: 256, maxMiB: 16000 },
    managedPool: { cpuCores: 7.2, memoryMiB: 14745, reserveRatio: .1, kernelEnforced: false } };
  const applicationController = {
    ...fixtureManagedRuntime(() => capabilities),
    initialize: async () => capabilities, capabilities: () => capabilities, close: async () => {},
    prepareWorkspace: async (record, { seed = false } = {}) => {
      const run = path.join(directory, 'servers', record.id, 'run');
      await fs.mkdir(run, { recursive: true });
      if (seed) for (const [name, content] of Object.entries(applicationStarterSources(record.kind))) {
        await fs.writeFile(path.join(run, name), content, { flag: 'wx' });
      }
    },
    installDependencies: async () => ({ installed: false, commandsCompleted: 0, testFixture: true }),
    redact: (_record, text) => text,
  };
  manager = await createManager({ store, dataDir: directory, demo: false, hostReader: directoryFixtureHost,
    storageController: createDirectoryStorageFixture(directory), applicationController,
    resourceController: { initialize: async () => resourceCapabilities, capabilities: () => resourceCapabilities },
    networkMetrics: { initialize: async () => ({ supported: false }), capabilities: () => ({ supported: false }), syncServers: async () => {}, sample: async () => ({}), peek: () => ({ available: false }), close: async () => {} },
  });
  await manager.initialize();
  const create = manager.createServer;
  manager.createServer = input => { captured.push(structuredClone(input)); return create(input); };
  nodes = createNodes({ store, dataDir: directory, localManager: manager });
  const auth = createAuth({ store, setupToken: 'local-placement-isolated-setup' });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.path === '/api/servers') received.push(req.body); next(); });
  app.use('/api/auth', auth.router);
  app.use('/api', auth.requireAuth, createRouter(nodes.manager, { store, dataDir: directory }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json(applicationErrorPayload(error) || { error: error.message }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let session;
  async function request(route, body, { anonymous = false, csrf = true } = {}) {
    const response = await realFetch(base + '/api' + route, { method: 'POST', headers: {
      Origin: base, 'Content-Type': 'application/json',
      ...(!anonymous && session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrf } : {}) } : {}),
    }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/auth/setup', { token: 'local-placement-isolated-setup', username: 'placement-admin', password }, { anonymous: true });
  assert.equal(setup.status, 200); session = { cookie: setup.cookie, csrf: setup.data.csrfToken };
  return { manager, nodes, store, captured, received, request };
}
const input = async (kind, extra = {}) => ({ nodeId: 'local', kind, name: `Local ${kind} controller fixture`, port: await freePort(),
  resourcePolicy: { mode: 'fixed', cpuCores: .2, memoryMiB: 256 }, storagePolicy: { mode: 'fixed', diskGiB: 1 },
  application: { entrypoint: kind === 'python' ? 'app.py' : 'server.js', args: ['one argument with spaces', ''], environment: [{ name: 'QA_LITERAL', value: 'opaque text', secret: false }], dependencies: 'none', readiness: 'tcp' }, ...extra });

test('authenticated local controller removes placement nodeId before strict Node.js/Python manager creation and returns real jobs', async t => {
  const f = await fixture(t);
  for (const kind of ['nodejs', 'python']) {
    const body = await input(kind), original = structuredClone(body);
    const response = await f.request('/servers', body);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const { nodeId: _placement, ...expected } = original;
    assert.deepEqual(f.captured.at(-1), expected, 'Only the controller placement field is removed');
    assert.deepEqual(f.received.at(-1), original, 'The original parsed placement request is not changed');
    assert.equal(response.data.server.kind, kind); assert.equal(response.data.server.transport, 'tcp');
    assert.deepEqual(response.data.server.application.args, body.application.args);
    assert.ok(response.data.server.permissions.manage); assert.ok(response.data.job.id);
    assert.ok(['queued', 'running'].includes(response.data.job.status)); assert.ok(response.data.job.progress < 100);
    const complete = await waitJob(f.manager, response.data.job.id);
    assert.equal(complete.status, 'completed'); assert.equal(f.manager.getServer(response.data.server.id).status, 'stopped');
    assert.equal(f.store.data.servers.find(row => row.id === response.data.server.id).application.environment[0].value, 'opaque text');
  }
  t.diagnostic('Real HTTP/auth/CSRF/controller facade/strict manager/store/jobs; injected runtime and ordinary storage fixture never launch apps or claim kernel isolation.');
});

test('local placement forwarding keeps unknown fields/kinds strict and preserves auth/CSRF rejection without creating records', async t => {
  const f = await fixture(t), before = { servers: f.store.data.servers.length, jobs: f.store.data.jobs.length };
  const body = await input('nodejs');
  assert.equal((await f.request('/servers', body, { anonymous: true })).status, 401);
  assert.equal((await f.request('/servers', body, { csrf: false })).status, 403);
  assert.equal(f.captured.length, 0);
  const unknown = { ...body, unexpectedApplicationField: true };
  assert.equal((await f.request('/servers', unknown)).status, 400);
  assert.equal(f.captured.at(-1).unexpectedApplicationField, true, 'Unknown fields reach strict manager validation instead of being silently filtered');
  const badKind = await f.request('/servers', { ...body, kind: 'ruby' });
  assert.equal(badKind.status, 400); assert.equal(badKind.data.code, 'APPLICATION_INPUT');
  assert.deepEqual({ servers: f.store.data.servers.length, jobs: f.store.data.jobs.length }, before);
  const absent = { ...body }; delete absent.nodeId;
  const accepted = await f.request('/servers', absent);
  assert.equal(accepted.status, 201); assert.deepEqual(f.captured.at(-1), absent);
  await waitJob(f.manager, accepted.data.job.id);
});
