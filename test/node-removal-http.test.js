import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { federationFixture, PASSWORD } from './nodes080-fixture.js';

test('real HTTP uninstall routes require Admin, Origin/CSRF and current-password reauthentication before injected work receives stripped input', async t => {
  const starts = [], verifies = [];
  const operationId = randomUUID();
  const factory = () => ({
    async plan(id) { return { nodeId: id, name: 'Inert uninstall fixture', address: 'fixture.invalid', plan: { schemaVersion: 1, revision: 'a'.repeat(64), status: 'ready', serverCount: 0, blockers: [], components: [] } }; },
    async start(id, input, user) { assert.equal('adminPassword' in input, false); assert.equal(user.role, 'admin'); starts.push({ id, input, user }); return { id: operationId, requestId: operationId, nodeId: id, type: 'node-uninstall', status: 'queued', verified: false }; },
    async verify(id, input, user) { assert.equal('adminPassword' in input, false); assert.equal(user.role, 'admin'); verifies.push({ id, input, user }); return { id, nodeId: input.nodeId, requestId: input.requestId, status: 'unknown', verified: false }; },
    jobs: () => [], getJob: id => ({ id, status: 'unknown', verified: false }), isRemoving: () => false, close() {},
  });
  const f = await federationFixture(t, { nodeRemovalControllerFactory: factory });
  const id = f.agents[0].linked.id, route = `/nodes/${id}/uninstall`;
  const body = { nodeId: id, requestId: operationId, revision: 'a'.repeat(64), confirmed: true, confirmationName: 'Inert uninstall fixture', adminPassword: PASSWORD, ssh: { host: 'fixture.invalid', port: 22, username: 'root', password: 'INERT_SSH_PASSWORD', hostFingerprint: 'SHA256:' + 'a'.repeat(43) } };
  assert.equal((await f.request(route, { actor: null, body })).status, 401);
  for (const role of ['viewer', 'operator']) {
    const actor = await f.createUser('uninstall-' + role, { role, allServers: true });
    assert.equal((await f.request(route, { actor })).status, 403);
    assert.equal((await f.request(route, { actor, body })).status, 403);
    assert.equal((await f.request(`/nodes/uninstall/jobs/${operationId}`, { actor })).status, 403);
  }
  assert.equal((await f.request(route, { body, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request(route, { body, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.request(route, { body: { ...body, adminPassword: 'wrong-current-password' } })).status, 403);
  assert.equal(starts.length, 0);
  assert.equal((await f.request(route)).status, 200);
  const accepted = await f.request(route, { body }); assert.equal(accepted.status, 202); assert.equal(accepted.data.job.verified, false); assert.equal(starts.length, 1);
  assert.equal(starts[0].input.ssh.password, 'INERT_SSH_PASSWORD', 'Only the authenticated operation receives temporary SSH credentials');
  assert.equal(JSON.stringify(f.central.store.data).includes('INERT_SSH_PASSWORD'), false);
  const verifyRoute = `/nodes/uninstall/jobs/${operationId}/verify`, verifyBody = { nodeId: id, requestId: operationId, adminPassword: PASSWORD, ssh: body.ssh };
  assert.equal((await f.request(verifyRoute, { body: { ...verifyBody, adminPassword: 'wrong-current-password' } })).status, 403); assert.equal(verifies.length, 0);
  assert.equal((await f.request(verifyRoute, { body: verifyBody })).status, 202); assert.equal(verifies.length, 1); assert.equal(starts.length, 1);
  assert.equal((await f.request(`/nodes/${id}`, { method: 'DELETE' })).status, 409); assert.equal(f.central.store.data.nodes.length, 2);
  const agent = f.agents[0], operator = { id: 'inert-operator', username: 'inert.operator', role: 'operator', allServers: true, serverIds: [] };
  for (const suffix of ['/plan', '/prepare', '/abort']) {
    const method = suffix === '/plan' ? 'GET' : 'POST';
    const denied = await fetch(agent.endpoint + '/api/node/uninstall' + suffix, { method, headers: { Authorization: 'Bearer ' + agent.token, 'X-Vortex-Actor': Buffer.from(JSON.stringify(operator)).toString('base64url'), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(denied.status, 403);
  }
  t.diagnostic('Sessions, CSRF, administrator password verification, ACL and Agent bearer routes are real. Uninstall controller is injected and inert; no SSH/systemd/filesystem uninstall action ran.');
});
