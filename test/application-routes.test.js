import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { createRouter } from '../server/routes.js';
import { createNodeRouter, remoteServerRouteAllowed } from '../server/node-routes.js';
import { NODE_RUNTIME_FILES } from '../server/node-runtime.js';
import { applicationIssue, normalizeApplication } from '../server/application-schema.js';
import { COLLISION_ID, federationFixture } from './nodes080-fixture.js';

const admin = { id: 'admin', role: 'admin', username: 'routes-admin', allServers: true };
const operator = { id: 'operator', role: 'operator', username: 'routes-operator', serverIds: ['app'] };
const viewer = { id: 'viewer', role: 'viewer', username: 'routes-viewer', serverIds: ['app'] };
const capabilities = { supported: true, isolation: 'nonroot-bubblewrap', networkIsolated: false, runtimes: { nodejs: { available: true, version: '22.fixture' }, python: { available: true, version: '3.fixture' } } };
const record = id => ({ id, kind: id === 'bedrock' ? 'bedrock' : 'nodejs', name: 'Inert HTTP route fixture', status: 'stopped' });

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return async (route, { actor = admin, method = 'GET', body, headers = {} } = {}) => {
    const multipart = body instanceof FormData;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'X-Fixture-Actor': actor ? JSON.stringify(actor) : '', ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
}
function session(app) {
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: req.headers['x-fixture-actor'] ? JSON.parse(req.headers['x-fixture-actor']) : null }; req.panelLanguage = req.headers['accept-language'] === 'vi' ? 'vi' : 'en'; next(); });
}
function errors(app) { app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code })); }

test('actual application HTTP routes preserve ACLs, safe envelopes, argument boundaries and dependency job acknowledgement', async t => {
  const calls = [], app = express(); session(app);
  const configuration = id => ({ server: record(id), application: { entrypoint: 'server.js', args: ['one argument with spaces', ''], environment: [{ name: 'API_SECRET', secret: true, hasValue: true }] }, revision: 'fixture-revision', capabilities });
  const manager = {
    getServer: record,
    applicationCapabilities: async () => { calls.push(['capabilities']); return capabilities; },
    application: async id => { calls.push(['read', id]); return configuration(id); },
    saveApplication: async (id, body) => { calls.push(['save', id, body]); return configuration(id); },
    installApplicationDependencies: async (id, body) => { calls.push(['dependencies', id, body]); return { id: 'owned-job', serverId: id, status: 'queued', type: 'application-dependencies' }; },
  };
  app.use('/api', createRouter(manager)); errors(app); const request = await listen(t, app);
  assert.equal((await request('/api/application-runtimes', { actor: null })).status, 401);
  for (const actor of [viewer, operator]) assert.equal((await request('/api/application-runtimes', { actor })).status, 403);
  assert.deepEqual((await request('/api/application-runtimes')).data, { applicationRuntime: capabilities });
  const read = await request('/api/servers/app/application', { actor: viewer });
  assert.equal(read.status, 200); assert.equal(read.data.server.permissions.manage, false);
  assert.equal(JSON.stringify(read.data).includes('secret-value-not-in-response'), false);
  const input = { revision: 'fixture-revision', application: { entrypoint: 'server.js', args: ['one argument with spaces', ''], environment: [{ name: 'API_SECRET', secret: true }] } };
  assert.equal((await request('/api/servers/app/application', { actor: viewer, method: 'PATCH', body: input })).status, 403);
  assert.equal((await request('/api/servers/other/application', { actor: operator })).status, 403);
  const saved = await request('/api/servers/app/application', { actor: operator, method: 'PATCH', body: input });
  assert.equal(saved.status, 200); assert.equal(saved.data.server.permissions.manage, true); assert.deepEqual(calls.find(row => row[0] === 'save'), ['save', 'app', input]);
  assert.equal((await request('/api/servers/app/dependencies', { actor: viewer, method: 'POST', body: {} })).status, 403);
  const job = await request('/api/servers/app/dependencies', { actor: operator, method: 'POST', body: { revision: 'fixture-revision' } });
  assert.equal(job.status, 202); assert.equal(job.data.job.status, 'queued'); assert.deepEqual(calls.find(row => row[0] === 'dependencies'), ['dependencies', 'app', { revision: 'fixture-revision' }]);
  assert.equal(calls.filter(row => row[0] === 'save').length, 1); assert.equal(calls.filter(row => row[0] === 'dependencies').length, 1);
});

test('app-kind guard rejects Minecraft-only APIs before handlers, multipart staging or inaccessible record lookup while preserving generic tools', async t => {
  let lookups = 0, stages = 0, legacyReads = 0; const app = express(); session(app);
  const manager = {
    getServer: id => { lookups++; return record(id); }, uploadStagingDirectory: () => { stages++; throw Error('must not stage'); },
    properties: async () => { legacyReads++; return { 'server-name': 'Minecraft' }; },
    configuration: async id => ({ server: record(id) }), logs: () => ['generic stdout'], files: async () => ({ files: [] }), backups: () => [], backupLimits: () => ({ count: 3 }),
  };
  app.use('/api', createRouter(manager)); errors(app); const request = await listen(t, app);
  const minecraft = [
    ['GET', '/properties'], ['PUT', '/properties'], ['GET', '/players'], ['PUT', '/players'], ['GET', '/worlds'], ['POST', '/worlds/import'], ['GET', '/worlds/Main/export'],
    ['GET', '/packs'], ['POST', '/packs/import'], ['PATCH', '/packs/uuid'], ['GET', '/gameplay'], ['POST', '/gamerules/query'], ['PATCH', '/gamerules'],
    ['POST', '/announcement'], ['POST', '/player-actions'], ['POST', '/update'], ['GET', '/versions'], ['POST', '/clone'],
  ];
  for (const [method, suffix] of minecraft) {
    const response = await request('/api/servers/app' + suffix, { method, ...(method === 'GET' ? {} : { body: {} }) });
    assert.equal(response.status, 409, suffix); assert.equal(response.data.code, 'APPLICATION_KIND', suffix);
  }
  const vi = await request('/api/servers/app/worlds', { headers: { 'Accept-Language': 'vi' } }); assert.match(vi.data.error, /chỉ dành/);
  for (const suffix of ['/packs/import', '/worlds/import']) {
    const body = new FormData(); body.set('file', new Blob(['inert rejected upload']), 'never-stage.zip');
    assert.equal((await request('/api/servers/app' + suffix, { method: 'POST', body })).data.code, 'APPLICATION_KIND');
  }
  const before = lookups; assert.equal((await request('/api/servers/other/worlds', { actor: operator })).status, 403); assert.equal(lookups, before);
  for (const suffix of ['/configuration', '/logs', '/files', '/backups']) assert.equal((await request('/api/servers/app' + suffix)).status, 200, suffix);
  assert.equal((await request('/api/servers/bedrock/properties')).status, 200); assert.equal(legacyReads, 1); assert.equal(stages, 0);
});

test('node runtime capabilities stay node-scoped, admin-only and forward only the authenticated actor', async t => {
  const calls = [], app = express(); session(app);
  const node = { id: 'remote-node' }, nodes = {
    manager: { demo: true, applicationCapabilities: async () => capabilities },
    requireAvailable: id => { assert.equal(id, node.id); return node; },
    actorHeader: (_node, actor) => { assert.equal(actor.id, admin.id); return 'trusted-controller-actor'; },
    call: async (target, options) => { calls.push({ target, options }); return { applicationRuntime: { ...capabilities, supported: false, reason: 'Actual remote sandbox unavailable' } }; },
  };
  app.use('/api/nodes', createNodeRouter(nodes, {})); errors(app); const request = await listen(t, app);
  for (const actor of [viewer, operator]) assert.equal((await request('/api/nodes/remote-node/application-runtimes', { actor })).status, 403);
  assert.deepEqual((await request('/api/nodes/local/application-runtimes')).data, { nodeId: 'local', applicationRuntime: capabilities });
  const remote = await request('/api/nodes/remote-node/application-runtimes', { headers: { 'Accept-Language': 'vi', 'X-Vortex-Actor': 'forged-browser-header' } });
  assert.equal(remote.data.nodeId, node.id); assert.equal(remote.data.applicationRuntime.supported, false); assert.equal(calls.length, 1);
  assert.equal(calls[0].options.path, '/api/application-runtimes'); assert.deepEqual(calls[0].options.headers, { 'X-Vortex-Actor': 'trusted-controller-actor', 'Accept-Language': 'vi' });
});

test('federated application APIs cross the actual controller and authenticated agent with opaque ID mapping and remote ACLs', async t => {
  const f = await federationFixture(t), target = f.agents[0], seen = [];
  Object.assign(target.store.data.servers.find(row => row.id === COLLISION_ID), { kind: 'python', transport: 'tcp', portV6: null, udpPorts: null, debugPort: null, application: normalizeApplication({}, { kind: 'python' }) });
  await f.central.nodes.refresh(target.linked.id, { force: true });
  const result = id => ({ server: target.runtime.manager.getServer(id), application: { entrypoint: 'app.py', args: ['one argument'], environment: [] }, revision: 'remote-revision', capabilities });
  target.runtime.manager.applicationCapabilities = async () => capabilities;
  target.runtime.manager.application = async id => { seen.push(['read', id]); return result(id); };
  target.runtime.manager.saveApplication = async (id, input) => { seen.push(['save', id, input]); return result(id); };
  target.runtime.manager.installApplicationDependencies = async (id, input) => { seen.push(['install', id, input]); return { id: '4b2d54ef-c731-413f-b553-58099883e46b', serverId: id, status: 'queued', type: 'application-dependencies' }; };
  const viewerActor = await f.createUser('application-viewer', { serverIds: [f.remote(0)] });
  const operatorActor = await f.createUser('application-operator', { role: 'operator', serverIds: [f.remote(0)] });
  const base = `/servers/${f.remote(0)}`;
  const read = await f.request(base + '/application', { actor: viewerActor }); assert.equal(read.status, 200); assert.equal(read.data.server.id, f.remote(0)); assert.equal(read.data.server.permissions.manage, false);
  assert.equal((await f.request(base + '/application', { actor: viewerActor, method: 'PATCH', body: {} })).status, 403);
  const input = { revision: 'remote-revision', application: { entrypoint: 'app.py', args: ['one argument'], environment: [] } };
  const saved = await f.request(base + '/application', { actor: operatorActor, method: 'PATCH', body: input }); assert.equal(saved.status, 200); assert.equal(saved.data.server.permissions.manage, true);
  const installed = await f.request(base + '/dependencies', { actor: operatorActor, body: { revision: 'remote-revision' } }); assert.equal(installed.status, 202); assert.equal(installed.data.job.serverId, f.remote(0)); assert.equal(installed.data.job.status, 'queued');
  assert.deepEqual(seen, [['read', COLLISION_ID], ['save', COLLISION_ID, input], ['install', COLLISION_ID, { revision: 'remote-revision' }]]);
  assert.equal((await f.request(base + '/worlds', { actor: viewerActor })).data.code, 'APPLICATION_KIND');
  assert.equal((await f.request(`/nodes/${target.linked.id}/application-runtimes`, { actor: operatorActor })).status, 403);
  const caps = await f.request(`/nodes/${target.linked.id}/application-runtimes`); assert.equal(caps.status, 200); assert.equal(caps.data.nodeId, target.linked.id); assert.deepEqual(caps.data.applicationRuntime, capabilities);
  f.central.manager.application = target.runtime.manager.application = async () => { throw applicationIssue('APPLICATION_ENVIRONMENT', 400); };
  for (const language of ['en', 'vi']) for (const id of [COLLISION_ID, f.remote(0)]) {
    const rejected = await f.request(`/servers/${id}/application`, { headers: { 'Accept-Language': language } });
    assert.equal(rejected.status, 400); assert.equal(rejected.data.code, 'APPLICATION_ENVIRONMENT'); assert.equal(rejected.data.error, rejected.data.errorI18n[language]);
  }
  t.diagnostic('These are actual loopback HTTP agent/controller routes with inert manager responses, not native app or sandbox execution claims.');
});

test('worker runtime manifest includes application modules and every recursive relative import without panel assets', async () => {
  const files = new Set(NODE_RUNTIME_FILES), root = new URL('../', import.meta.url);
  for (const expected of ['server/application-runtime.js', 'server/application-schema.js']) assert.ok(files.has(expected));
  for (const relative of files) {
    if (!relative.endsWith('.js')) continue;
    const source = await fs.readFile(new URL(relative, root), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\()(['"])(\.[^'"]+)\1/g)) assert.ok(files.has(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[2]))), `${relative}: ${match[2]}`);
  }
  assert.equal(files.has('public/application-workspace.js'), false); assert.equal(files.has('server/index.js'), false);
  for (const [method, suffix] of [['GET', '/application'], ['PATCH', '/application'], ['POST', '/dependencies']]) assert.equal(remoteServerRouteAllowed(method, suffix), true);
  for (const [method, suffix] of [['PUT', '/application'], ['DELETE', '/dependencies'], ['POST', '/application/run-shell'], ['GET', '/application-runtimes']]) assert.equal(remoteServerRouteAllowed(method, suffix), false);
});
