import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createNodes } from '../server/nodes.js';
import { createStore } from '../server/store.js';
import { normalizeApplication, applicationErrorPayload } from '../server/application-schema.js';
import { federationFixture, COLLISION_ID } from './nodes080-fixture.js';

test('federated application snapshots/acknowledgements retain kind and exact protocol reservations across refresh and offline cache reload', async t => {
  const f = await federationFixture(t), agent = f.agents[0], server = agent.store.data.servers.find(row => row.id === COLLISION_ID);
  Object.assign(server, { kind: 'python', transport: 'tcp', port: 30000, portV6: null, udpPorts: null, debugPort: null, application: normalizeApplication({}, { kind: 'python' }) });
  await f.central.nodes.refresh(agent.linked.id, { force: true });
  const observed = (await f.request('/servers')).data.servers.find(row => row.id === f.remote(0));
  assert.equal(observed.kind, 'python'); assert.equal(observed.transport, 'tcp'); assert.equal(observed.portV6, null);
  let node = (await f.request('/nodes')).data.nodes.find(row => row.id === agent.linked.id);
  assert.equal(node.online, true); assert.ok(node.usedPorts.reservations.some(row => row.protocol === 'tcp' && row.port === 30000)); assert.ok(!node.usedPorts.reservations.some(row => row.protocol === 'udp' && row.port === 30000)); assert.equal(node.nextApplicationPort, null); assert.equal(node.nextPort, null); assert.equal(node.nextPortV6, null);
  // A snapshot reports reservations, never an unreserved port suggestion.
  assert.deepEqual(node.portAllocation, node.capabilities?.portAllocation?.supported ? node.capabilities.portAllocation : null);
  assert.ok(node.usedPorts.reservations.some(row => row.protocol === 'udp'), 'The sibling Bedrock UDP reservation remains present');
  const acknowledged = { ...observed, id: COLLISION_ID, nodeId: undefined, port: 30001 };
  f.central.nodes.recordResponse(f.central.nodes.get(agent.linked.id), { server: acknowledged }, { mutating: true });
  assert.equal(f.central.nodes.listServers().find(row => row.id === f.remote(0)).port, 30001, 'Accepted application response is usable immediately before refresh settles');
  // Persisted cache has raw IDs and app kind; it must survive a controller
  // process that has not yet obtained a new snapshot.
  await f.central.nodes.refresh(agent.linked.id, { force: true });
  await f.restartCentral();
  const persisted = f.central.store.data.nodes.find(row => row.id === agent.linked.id).inventory.find(row => row.id === COLLISION_ID);
  assert.equal(persisted.kind, 'python'); assert.equal(persisted.transport, 'tcp'); assert.equal(persisted.portV6, null);
  for (const invalid of [{ kind: 'ruby' }, { kind: 'nodejs', transport: 'raknet' }, { kind: 'python', portV6: 30002 }, { kind: 'python', udpPorts: '30002-30033' }]) {
    const previous = { ...server }; Object.assign(server, invalid);
    await f.central.nodes.refresh(agent.linked.id, { force: true });
    assert.equal(f.central.nodes.publicNode(f.central.nodes.get(agent.linked.id)).online, false, 'Unknown kinds/contradictory application reservations fail closed');
    for (const key of Object.keys(server)) if (!Object.hasOwn(previous, key)) delete server[key]; Object.assign(server, previous);
    await f.central.nodes.refresh(agent.linked.id, { force: true });
  }
  t.diagnostic('Real isolated controller/agent snapshots and sessions; app process execution and resource/storage enforcement are not part of this transport test.');
});

test('remote create promotes only canonical application error identities in both languages, without retries or peer translation trust', async t => {
  const f = await federationFixture(t), agent = f.agents[0]; let code = 'APPLICATION_UNSUPPORTED', calls = 0;
  const beforeServers = agent.store.data.servers.length, beforeJobs = agent.store.data.jobs.length;
  const dashboard = await agent.runtime.manager.dashboard();
  t.mock.method(agent.runtime.manager, 'dashboard', async () => ({ ...dashboard, capabilities: { ...dashboard.capabilities, applicationRuntime: { managed: true, supported: true, runtimes: [{ kind: 'nodejs', managedAvailable: true }] } } }));
  t.mock.method(agent.runtime.manager, 'createServer', async () => { calls++; throw Object.assign(new Error('Synthetic native adapter rejection'), { status: 409, code, errorI18n: { en: 'untrusted peer metadata', vi: 'untrusted peer metadata' } }); });
  for (code of ['APPLICATION_UNSUPPORTED', 'APPLICATION_ENVIRONMENT', 'APPLICATION_ACCOUNT']) for (const language of ['en', 'vi']) {
    const response = await f.request('/servers', { body: { nodeId: agent.linked.id, kind: 'nodejs', name: 'Rejected app', port: 31000 }, headers: { 'Accept-Language': language } });
    assert.equal(response.status, 409); assert.deepEqual(response.data, applicationErrorPayload({ code }, language));
  }
  assert.equal(calls, 6); assert.equal(agent.store.data.servers.length, beforeServers); assert.equal(agent.store.data.jobs.length, beforeJobs);
  assert.equal((await f.request('/nodes')).data.nodes.find(row => row.id === agent.linked.id).online, true);
});

test('fresh remote runtime capability rejects old agents before application POST, even with explicit manual ports', async t => {
  const f = await federationFixture(t), agent = f.agents[0]; let calls = 0;
  t.mock.method(agent.runtime.manager, 'createServer', async () => { calls++; throw Error('Old agent must not receive a create request'); });
  for (const language of ['en', 'vi']) {
    const response = await f.request('/servers', { body: { nodeId: agent.linked.id, kind: 'python', name: 'Never fall back to host Python', port: 31000 }, headers: { 'Accept-Language': language } });
    assert.equal(response.status, 409); assert.deepEqual(response.data, applicationErrorPayload({ code: 'APPLICATION_MANAGED_NODE_REQUIRED' }, language));
  }
  assert.equal(calls, 0);
});

test('application error promotion never coerces malformed peer codes or imports arbitrary translations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-app-errors-')), nodes = createNodes({ store: createStore(directory), localManager: {}, dataDir: directory });
  t.after(async () => { await nodes.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  for (const code of [['APPLICATION_ACCOUNT'], { toString: 'broken' }, 'APPLICATION_UNKNOWN', null]) {
    const body = { error: 'Peer failure', code, errorI18n: { en: 'forged', vi: 'forged' } };
    await assert.rejects(nodes.readJson({ statusCode: 409, stream: Readable.from([Buffer.from(JSON.stringify(body))]) }), error => { assert.equal(error.code, undefined); assert.equal(error.errorI18n, undefined); assert.deepEqual(error.body, body); return true; });
  }
});
