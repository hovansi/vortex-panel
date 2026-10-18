import test from 'node:test';
import assert from 'node:assert/strict';
import { federationFixture, eventually } from './nodes080-fixture.js';
import { PORT_ALLOCATION_POLICY } from '../server/port-allocation.js';

test('remote automatic create and clone use only the selected agent, return its reserved ports, and do not create local records', async t => {
  const f = await federationFixture(t, { demoAgents: true });
  const beforeLocal = structuredClone(f.central.store.data.servers), beforeOther = structuredClone(f.agents[1].store.data.servers);
  const created = await f.request('/servers', { body: { nodeId: f.agents[0].linked.id, name: 'Automatic remote world', version: '1.26.52.3', eula: true, portAllocation: 'auto' } });
  assert.equal(created.status, 201); assert.ok(created.data.server.id.startsWith(f.agents[0].linked.id + ':'));
  assert.ok(created.data.server.port >= 20000 && created.data.server.port <= 59999);
  await eventually(() => assert.equal(f.agents[0].runtime.manager.getServer(created.data.server.id.split(':')[1]).status, 'stopped'));
  const cloned = await f.request(`/servers/${created.data.server.id}/clone`, { body: { name: 'Automatic remote copy', eula: true } });
  assert.equal(cloned.status, 201); assert.notEqual(cloned.data.server.port, created.data.server.port);
  await eventually(() => assert.equal(f.agents[0].runtime.manager.getServer(cloned.data.server.id.split(':')[1]).status, 'stopped'));
  assert.deepEqual(f.central.store.data.servers, beforeLocal); assert.deepEqual(f.agents[1].store.data.servers, beforeOther);
  const node = (await f.central.nodes.publicNodes()).find(row => row.id === f.agents[0].linked.id);
  assert.deepEqual(node.portAllocation, PORT_ALLOCATION_POLICY);
  assert.equal(node.nextPort, null); assert.equal(node.nextPortV6, null); assert.equal(node.nextApplicationPort, null);
  t.diagnostic('Real controller/authenticated HTTP agent/CSRF/proxy/metadata. Bedrock install/clone explicitly use demo execution; no native bind or game-client claim.');
});

test('a missing or downgraded agent capability rejects automatic create and clone before mutation, while manual compatibility remains usable', async t => {
  const f = await federationFixture(t, { demoAgents: true }), selected = f.agents[0];
  const originalDashboard = selected.runtime.manager.dashboard.bind(selected.runtime.manager);
  const cached = (await f.central.nodes.publicNodes()).find(row => row.id === selected.linked.id);
  assert.equal(cached.portAllocation.supported, true);
  t.mock.method(selected.runtime.manager, 'dashboard', async () => { const value = await originalDashboard(); delete value.capabilities.portAllocation; return value; });
  let creates = 0, clones = 0;
  const create = selected.runtime.manager.createServer.bind(selected.runtime.manager), clone = selected.runtime.manager.cloneServer.bind(selected.runtime.manager);
  t.mock.method(selected.runtime.manager, 'createServer', input => { creates++; return create(input); });
  t.mock.method(selected.runtime.manager, 'cloneServer', (id, input) => { clones++; return clone(id, input); });
  for (const [url, body] of [['/servers', { nodeId: selected.linked.id, name: 'Must not create', version: '1.26.52.3', eula: true, portAllocation: 'auto' }], [`/servers/${f.remote(0)}/clone`, { name: 'Must not clone', eula: true }]]) {
    const response = await f.request(url, { body }); assert.equal(response.status, 409); assert.match(response.data.error, /does not support automatic port allocation/); assert.doesNotMatch(response.data.error, /outcome is unknown/);
  }
  assert.equal(creates, 0); assert.equal(clones, 0); assert.equal(selected.store.data.servers.length, 2); assert.equal(selected.store.data.jobs.length, 0);
  await f.central.nodes.refresh(selected.linked.id, { force: true });
  assert.equal((await f.central.nodes.publicNodes()).find(row => row.id === selected.linked.id).portAllocation, null);
  const manual = await f.request('/servers', { body: { nodeId: selected.linked.id, name: 'Legacy manual request', version: '1.26.52.3', eula: true, port: 42000, portV6: 42001 } });
  assert.equal(manual.status, 201); assert.equal(manual.data.server.port, 42000); assert.equal(creates, 1);
  await eventually(() => assert.equal(selected.runtime.manager.getServer(manual.data.server.id.split(':')[1]).status, 'stopped'));
});
