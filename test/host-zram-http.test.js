import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';
import { createNodeAgent } from '../server/node-agent.js';
import { validateZramRequest } from '../server/host-zram.js';

const PASSWORD = 'isolated-zram-http-password';
function inertController(nodeId) {
  const requests = [];
  let reads = 0, unknown = false;
  let state = { nodeId, available: true, ownership: 'none', configured: { enabled: false, profile: 'auto' },
    effective: { enabled: false, logicalSizeBytes: 0, swapUsedBytes: 0, residentBytes: 0 },
    physicalMemoryBytes: 2 * 1024 ** 3, recommended: { logicalSizeBytes: 1024 ** 3, residentLimitBytes: 512 * 1024 ** 2 },
    revision: 'a'.repeat(64), busy: false, lastOperation: null };
  return { nodeId, requests, get reads() { return reads; }, setUnknown(value) { unknown = value; },
    async read() { reads++; return structuredClone(state); },
    async request(input, options) {
      validateZramRequest(input);
      assert.equal(input.nodeId, nodeId);
      requests.push({ input: structuredClone(input), user: structuredClone(options.user) });
      if (unknown) {
        state = { ...state, busy: true, lastOperation: { requestId: input.requestId, enabled: input.enabled, status: 'unknown' } };
        throw Object.assign(Error('inert private helper path must not reach browser'), { code: 'ZRAM_UNKNOWN', status: 504, outcomeUnknown: true, zram: structuredClone(state) });
      }
      state = { ...state, ownership: 'vortex', configured: { enabled: input.enabled, profile: 'auto' }, effective: { ...state.effective, enabled: input.enabled },
        revision: input.enabled ? 'b'.repeat(64) : 'c'.repeat(64), lastOperation: { requestId: input.requestId, enabled: input.enabled, status: 'completed' } };
      return { nodeId, replayed: false, operation: state.lastOperation, zram: structuredClone(state) };
    }, async close() {} };
}

async function fixture(t, { remote = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-zram-http-'));
  const realFetch = globalThis.fetch;
  const network = t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return url.hostname === '127.0.0.1' ? realFetch(input, options) : Promise.reject(Error('External network disabled in isolated zram HTTP fixture'));
  });
  const local = inertController('local');
  const app = await createApp({ dataDir: path.join(root, 'panel'), demo: false, setupToken: 'isolated-zram-http-setup', zramController: local });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let admin, agent, worker, linked;
  t.after(async () => { try { await app.close(); await agent?.close(); } finally { network.mock.restore(); await fs.rm(root, { recursive: true, force: true }); } });
  async function request(route, { actor = admin, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await realFetch(base + '/api' + route, { method, headers: { Origin: base, ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  const setup = await request('/auth/setup', { actor: null, body: { token: 'isolated-zram-http-setup', username: 'zram-admin', password: PASSWORD } });
  assert.equal(setup.status, 200);
  admin = { cookie: setup.cookie, csrfToken: setup.data.csrfToken };
  async function user(role) {
    const username = 'zram-' + role;
    assert.equal((await request('/auth/users', { body: { username, password: PASSWORD, role, allServers: true, serverIds: [] } })).status, 201);
    const login = await request('/auth/login', { actor: null, body: { username, password: PASSWORD } });
    assert.equal(login.status, 200); return { cookie: login.cookie, csrfToken: login.data.csrfToken };
  }
  if (remote) {
    const nodeId = randomUUID(), token = randomBytes(32).toString('base64url');
    worker = inertController(nodeId);
    agent = await createNodeAgent({ dataDir: path.join(root, 'worker'), nodeId, token, demo: true, zramController: worker });
    await new Promise(resolve => agent.server.listen(0, '127.0.0.1', resolve));
    const result = await request('/nodes', { body: { name: 'Isolated zram worker', endpoint: `http://127.0.0.1:${agent.server.address().port}`, token, fingerprint: null, publicAddress: '192.0.2.80', location: 'isolated fixture' } });
    assert.equal(result.status, 201); linked = result.data.node;
  }
  async function input(nodeId = 'local', enabled = true) {
    const status = await request('/nodes/' + nodeId + '/zram'); assert.equal(status.status, 200);
    return { nodeId, enabled, profile: 'auto', confirmed: true, revision: status.data.zram.revision, requestId: randomUUID(), password: PASSWORD };
  }
  return { app, base, local, get worker() { return worker; }, get linked() { return linked; }, request, user, input };
}

test('real zram HTTP routes enforce login, administrator role, origin, CSRF, explicit confirmation and current password', async t => {
  const f = await fixture(t), input = await f.input();
  const actors = [];
  for (const role of ['operator', 'viewer']) actors.push(await f.user(role));
  for (const route of ['/host/zram', '/nodes/local/zram']) {
    assert.equal((await f.request(route, { actor: null })).status, 401);
    assert.equal((await f.request(route, { actor: null, body: input })).status, 401);
    for (const actor of actors) {
      assert.equal((await f.request(route, { actor })).status, 403);
      assert.equal((await f.request(route, { actor, body: input })).status, 403);
    }
  }
  assert.equal((await f.request('/nodes/local/zram', { body: input, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/nodes/local/zram', { body: input, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.request('/nodes/local/zram', { body: { ...input, confirmed: false } })).status, 400);
  assert.equal((await f.request('/nodes/local/zram', { body: { ...input, password: 'wrong password' } })).status, 403);
  assert.equal((await f.request('/nodes/local/zram', { body: { ...input, nodeId: randomUUID() } })).status, 409);
  assert.equal((await f.request('/nodes/local/zram', { body: { ...input, device: '/dev/zram0' } })).status, 400);
  assert.equal(f.local.requests.length, 0);
});

test('local GET is read-only and both POST aliases strip password before the private controller boundary', async t => {
  const f = await fixture(t), initialReads = f.local.reads;
  for (const route of ['/host/zram', '/nodes/local/zram']) {
    const result = await f.request(route);
    assert.equal(result.status, 200); assert.equal(result.data.nodeId, 'local'); assert.match(result.headers.get('cache-control'), /no-store/);
  }
  assert.equal(f.local.reads, initialReads + 2); assert.equal(f.local.requests.length, 0);
  const enabled = await f.request('/nodes/local/zram', { body: await f.input() });
  assert.equal(enabled.status, 200); assert.equal(enabled.data.operation.status, 'completed'); assert.equal(enabled.data.zram.effective.enabled, true);
  const disabled = await f.request('/host/zram', { body: await f.input('local', false) });
  assert.equal(disabled.status, 200); assert.equal(disabled.data.zram.effective.enabled, false);
  assert.equal(f.local.requests.length, 2);
  for (const call of f.local.requests) {
    assert.equal(Object.hasOwn(call.input, 'password'), false); assert.equal(JSON.stringify(call).includes(PASSWORD), false);
    assert.equal(call.user.username, 'zram-admin'); assert.equal(call.user.role, 'admin');
  }
});

test('remote zram uses actual authenticated node route, translates target IDs and never forwards the admin password', async t => {
  const f = await fixture(t, { remote: true }), id = f.linked.id, input = await f.input(id);
  assert.notEqual(id, f.worker.nodeId);
  assert.equal((await f.request('/nodes/' + id + '/zram')).data.zram.nodeId, id);
  assert.equal(f.worker.requests.length, 0);
  assert.equal((await f.request('/nodes/' + id + '/zram', { body: { ...input, password: 'incorrect' } })).status, 403);
  assert.equal(f.worker.requests.length, 0);
  const result = await f.request('/nodes/' + id + '/zram', { body: input });
  assert.equal(result.status, 200); assert.equal(result.data.nodeId, id); assert.equal(result.data.zram.nodeId, id);
  assert.equal(f.worker.requests.length, 1);
  const accepted = f.worker.requests[0];
  assert.notEqual(accepted.input.nodeId, id); assert.equal(accepted.input.nodeId, f.worker.nodeId);
  assert.equal(accepted.user.username, 'zram-admin'); assert.equal(accepted.user.role, 'admin');
  assert.equal(Object.hasOwn(accepted.input, 'password'), false); assert.equal(JSON.stringify(accepted).includes(PASSWORD), false);
  assert.equal((await f.request('/nodes/' + id + '/zram', { body: { ...input, nodeId: accepted.input.nodeId, requestId: randomUUID() } })).status, 409);
  assert.equal(f.worker.requests.length, 1);
});

test('local and remote unknown outcomes retain structured metadata and GET follow-up does not repeat a mutation', async t => {
  const f = await fixture(t, { remote: true });
  t.mock.method(console, 'error', () => {});
  for (const [id, controller] of [['local', f.local], [f.linked.id, f.worker]]) {
    controller.setUnknown(true);
    const result = await f.request('/nodes/' + id + '/zram', { body: await f.input(id), headers: { 'Accept-Language': 'vi' } });
    assert.equal(result.status, 504); assert.equal(result.data.code, 'ZRAM_UNKNOWN'); assert.equal(result.data.outcomeUnknown, true);
    assert.equal(result.data.error, result.data.errorI18n.vi); assert.equal(result.data.zram.busy, true);
    assert.equal(result.data.zram.nodeId, id); assert.equal(result.data.zram.lastOperation.status, 'unknown');
    assert.equal(JSON.stringify(result.data).includes('inert private helper'), false); assert.equal(JSON.stringify(result.data).includes(PASSWORD), false);
    const writes = controller.requests.length;
    const observed = await f.request('/nodes/' + id + '/zram');
    assert.equal(observed.status, 200); assert.equal(observed.data.zram.lastOperation.status, 'unknown');
    assert.equal(controller.requests.length, writes);
  }
});

test('a remote transport timeout reports unknown and never retries the OS request automatically', async t => {
  const f = await fixture(t, { remote: true }), input = await f.input(f.linked.id);
  t.mock.method(console, 'error', () => {});
  const call = f.app.nodes.call.bind(f.app.nodes); let posts = 0;
  t.mock.method(f.app.nodes, 'call', (node, options) => {
    if (options.path === '/api/node/zram' && options.method === 'POST') { posts++; throw Object.assign(Error('inert transport ended'), { status: 504 }); }
    return call(node, options);
  });
  const result = await f.request('/nodes/' + f.linked.id + '/zram', { body: input });
  assert.equal(result.status, 504); assert.equal(result.data.code, 'ZRAM_UNKNOWN'); assert.equal(result.data.outcomeUnknown, true);
  assert.equal(posts, 1); assert.equal(f.worker.requests.length, 0);
});
