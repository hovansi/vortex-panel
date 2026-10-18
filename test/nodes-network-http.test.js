import test from 'node:test';
import assert from 'node:assert/strict';
import { federationFixture, COLLISION_ID } from './nodes080-fixture.js';

test('network-access HTTP is administrator-only before forwarding, maps selected node identity and refuses unconfirmed writes without executing UFW changes', async t => {
  const f = await federationFixture(t);
  const viewer = await f.createUser('network-viewer', { role: 'viewer', allServers: true });
  const operator = await f.createUser('network-operator', { role: 'operator', allServers: true });
  const received = [];
  f.agents[0].runtime.server.prependListener('request', req => { if (/^\/api\/servers\/[^/]+\/network-access(?:\?|$)/.test(req.url)) received.push({ method: req.method, actor: req.headers['x-vortex-actor'] }); });
  for (const actor of [null, viewer, operator]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const before = received.length;
      const response = await f.request(`/servers/${f.remote(0)}/network-access`, { actor, method, ...(method === 'GET' ? {} : { body: { revision: '0'.repeat(64), confirmed: true } }) });
      assert.equal(response.status, actor ? 403 : 401); assert.equal(received.length, before);
    }
  }
  const local = await f.request(`/servers/${COLLISION_ID}/network-access`);
  const other = await f.request(`/servers/${f.remote(1)}/network-access`);
  const remote = await f.request(`/servers/${f.remote(0)}/network-access`, { headers: { 'X-Vortex-Actor': Buffer.from(JSON.stringify({ id: 'forged', username: 'forged', role: 'viewer', allServers: true, serverIds: [] })).toString('base64url') } });
  assert.equal(local.status, 200); assert.equal(remote.status, 200);
  assert.equal(local.data.serverId, COLLISION_ID); assert.equal(remote.data.serverId, f.remote(0));
  assert.ok(['active', 'inactive', 'unavailable'].includes(remote.data.status)); assert.ok(Array.isArray(remote.data.ports));
  assert.ok(remote.data.owner.endsWith(':' + COLLISION_ID)); assert.notEqual(remote.data.owner, local.data.owner);
  for (const privateField of ['raw', 'rows', 'hostRules', 'foreignRules', 'stdout', 'stderr']) assert.equal(Object.hasOwn(remote.data, privateField), false);
  for (const row of remote.data.ports) {
    for (const key of Object.keys(row)) assert.ok(['family', 'port', 'protocol', 'purpose', 'purposeI18n', 'state'].includes(key));
    assert.ok(row.protocol && row.port && row.family && row.purpose && row.state);
  }
  const actor = JSON.parse(Buffer.from(received.at(-1).actor, 'base64url'));
  assert.equal(actor.username, 'nodes-admin'); assert.equal(actor.role, 'admin');
  assert.ok(remote.data.messageI18n.en && remote.data.messageI18n.vi);
  // Invalid input is rejected before observe/exec on every platform. Never run
  // a valid firewall mutation in this HTTP fixture, even if Linux root has UFW.
  for (const method of ['POST', 'DELETE']) {
    const denied = await f.request(`/servers/${f.remote(0)}/network-access`, { method, body: {} });
    assert.equal(denied.status, 400); assert.ok(denied.data.errorI18n?.en && denied.data.errorI18n?.vi);
  }
  const after = await f.request(`/servers/${f.remote(0)}/network-access`);
  assert.equal(after.data.revision, remote.data.revision); assert.deepEqual(after.data.managedRules, remote.data.managedRules);
  const localAfter = await f.request(`/servers/${COLLISION_ID}/network-access`);
  assert.equal(localAfter.data.revision, local.data.revision); assert.deepEqual(localAfter.data.managedRules, local.data.managedRules);
  const otherAfter = await f.request(`/servers/${f.remote(1)}/network-access`);
  assert.equal(otherAfter.data.revision, other.data.revision); assert.deepEqual(otherAfter.data.managedRules, other.data.managedRules);
  const direct = await fetch(f.agents[0].endpoint + `/api/servers/${COLLISION_ID}/network-access`, { headers: {
    Authorization: 'Bearer ' + f.agents[0].token,
    'X-Vortex-Actor': Buffer.from(JSON.stringify({ id: viewer.user.id, username: viewer.user.username, role: 'viewer', allServers: true, serverIds: [] })).toString('base64url'),
  } });
  assert.equal(direct.status, 403); await direct.arrayBuffer();
  t.diagnostic('Real session/CSRF/proxy/agent authorization and read-only firewall inspection. No valid UFW mutation runs in this fixture; actual rule changes require the separately authorized Linux acceptance.');
});
