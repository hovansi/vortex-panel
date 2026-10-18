import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { federationFixture, COLLISION_ID, SECOND_ID, eventually } from './nodes080-fixture.js';

test('remote schedule create, immediate update and deletion survive older in-flight snapshots without losing ACL scope', async t => {
  const f = await federationFixture(t), agent = f.agents[0], nodeId = agent.linked.id;
  const original = agent.runtime.manager.dashboard.bind(agent.runtime.manager);
  let stale = structuredClone(await original()), held = true;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const mock = t.mock.method(agent.runtime.manager, 'dashboard', async () => { if (held) { entered.resolve(); await release.promise; return structuredClone(stale); } return original(); });
  t.after(() => { held = false; release.resolve(); mock.mock.restore(); });
  const refreshing = f.central.nodes.refresh(nodeId, { force: true }); await entered.promise;
  const created = await f.request('/schedules', { body: { serverId: f.remote(0), action: 'backup', intervalMinutes: 120, enabled: false } });
  assert.equal(created.status, 201); const id = created.data.schedule.id;
  const patched = await f.request('/schedules/' + id, { method: 'PATCH', body: { intervalMinutes: 121 } });
  assert.equal(patched.status, 200); assert.equal(patched.data.schedule.intervalMinutes, 121); assert.equal(patched.data.schedule.serverId, f.remote(0));
  const denied = await f.createUser('schedule-unrelated', { role: 'operator', allServers: false, serverIds: [f.remote(1)] });
  assert.equal((await f.request('/schedules/' + id, { actor: denied, method: 'PATCH', body: { intervalMinutes: 122 } })).status, 403);
  assert.equal((await f.request('/schedules')).data.schedules.find(row => row.id === id).intervalMinutes, 121);
  held = false; release.resolve(); await refreshing;
  assert.equal((await f.request('/schedules')).data.schedules.find(row => row.id === id).intervalMinutes, 121);
  await f.central.nodes.refresh(nodeId, { force: true });
  // Capture a pre-delete snapshot and release it only after DELETE is
  // acknowledged. Its stale schedule must not reappear in the controller.
  stale = structuredClone(await original());
  const enteredDelete = Promise.withResolvers(), releaseDelete = Promise.withResolvers(); held = true;
  mock.mock.restore();
  const deleteMock = t.mock.method(agent.runtime.manager, 'dashboard', async () => { if (held) { enteredDelete.resolve(); await releaseDelete.promise; return structuredClone(stale); } return original(); });
  t.after(() => { held = false; releaseDelete.resolve(); deleteMock.mock.restore(); });
  const beforeDelete = f.central.nodes.refresh(nodeId, { force: true }); await enteredDelete.promise;
  assert.equal((await f.request('/schedules/' + id, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/schedules')).data.schedules.some(row => row.id === id), false);
  held = false; releaseDelete.resolve(); await beforeDelete;
  assert.equal((await f.request('/schedules')).data.schedules.some(row => row.id === id), false);
  assert.equal((await f.request('/schedules/' + id, { method: 'PATCH', body: { intervalMinutes: 123 } })).status, 404);
  await f.central.nodes.refresh(nodeId, { force: true });
  assert.equal((await f.request('/schedules')).data.schedules.some(row => row.id === id), false);
});

test('dashboard and jobs merge newest private provisioning history before more than twenty older local jobs while hiding it from non-admin users', async t => {
  const f = await federationFixture(t);
  const viewer = await f.createUser('sorted-jobs-viewer', { role: 'viewer', allServers: true });
  const operator = await f.createUser('sorted-jobs-operator', { role: 'operator', allServers: true });
  const timestamp = Date.now();
  const old = Array.from({ length: 25 }, (_, index) => ({ id: randomUUID(), type: 'backup', serverId: COLLISION_ID,
    status: 'completed', progress: 100, message: 'Isolated old local history', createdAt: new Date(timestamp - 3600000 + index * 1000).toISOString() }));
  f.central.store.data.jobs = old;
  const remote = { id: randomUUID(), type: 'backup', serverId: COLLISION_ID, status: 'completed', progress: 100,
    message: 'Isolated newer remote history', createdAt: new Date(timestamp - 600000).toISOString() };
  f.agents[0].store.data.jobs = [remote]; f.agents[0].store.save();
  await f.central.nodes.refresh(f.agents[0].linked.id, { force: true });
  const id = randomUUID(), marker = 'Private node setup history visible only to administrators';
  f.central.store.data.nodeProvisionJobs = [{ id, type: 'node-provision', adminOnly: true, scope: 'nodes', serverId: null,
    status: 'failed', phase: 'failed', progress: 90, message: marker,
    createdAt: new Date(timestamp).toISOString(), finishedAt: new Date(timestamp + 1).toISOString(), outcomeUnknown: true, completionStatusPersisted: true }];
  f.central.store.save();
  const remoteId = `${f.agents[0].linked.id}:${remote.id}`;
  const ordinary = [remoteId, ...old.map(job => job.id).reverse()];
  for (const route of ['/jobs', '/dashboard']) {
    const admin = await f.request(route); assert.equal(admin.status, 200);
    assert.deepEqual(admin.data.jobs.map(job => job.id), [id, ...ordinary]);
    assert.equal(admin.data.jobs.slice(0, 20)[0].id, id); assert.equal(admin.data.jobs[0].progress, 90);
    assert.equal(admin.data.jobs[0].outcomeUnknown, true); assert.equal(admin.data.jobs[0].adminOnly, true);
    for (const actor of [viewer, operator]) {
      const response = await f.request(route, { actor }); assert.equal(response.status, 200);
      assert.deepEqual(response.data.jobs.map(job => job.id), ordinary);
      assert.equal(JSON.stringify(response.data.jobs).includes(marker), false);
      assert.equal(response.data.jobs.some(job => job.adminOnly || job.id === id || job.type === 'node-provision'), false);
    }
  }
  assert.equal(f.central.store.data.nodeProvisionJobs.length, 1);
  assert.equal(f.central.store.data.jobs.length, 25); assert.equal(f.agents[0].store.data.jobs.length, 1);
  t.diagnostic('Real authenticated Express controller plus two headless agents; job histories are seeded fixtures. No provisioning task, SSH connection, firewall mutation or native Bedrock process. Platform capability inspection remains read-only.');
});

test('accepted remote install and clone jobs remain immediately readable across an older in-flight snapshot', async t => {
  const f = await federationFixture(t, { demoAgents: true });
  const agent = f.agents[0], nodeId = agent.linked.id;
  await f.central.nodes.refresh(nodeId, { force: true });
  const original = agent.runtime.manager.dashboard.bind(agent.runtime.manager);
  const stale = structuredClone(await original());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let held = true;
  const mock = t.mock.method(agent.runtime.manager, 'dashboard', async () => {
    if (held) { entered.resolve(); await release.promise; return structuredClone(stale); }
    return original();
  });
  t.after(() => { held = false; release.resolve(); mock.mock.restore(); });
  const oldRefresh = f.central.nodes.refresh(nodeId, { force: true }); await entered.promise;
  const created = await f.request('/servers', { body: { nodeId, name: 'Immediate acknowledged install', version: '1.26.52.3', channel: 'stable', port: 40000, portV6: 40001, maxPlayers: 5, resourcePolicy: { mode: 'shared' }, eula: true } });
  assert.equal(created.status, 201);
  const assertVisible = async result => {
    for (const route of ['/jobs', '/dashboard']) {
      const response = await f.request(route); assert.equal(response.status, 200);
      assert.ok(response.data.jobs.some(job => job.id === result.data.job.id && job.serverId === result.data.server.id), `${route} includes the acknowledged job without waiting for a snapshot`);
      if (route === '/dashboard') assert.ok(response.data.servers.some(server => server.id === result.data.server.id));
    }
  };
  await assertVisible(created);
  await eventually(() => assert.equal(agent.runtime.manager.jobs().find(job => `${nodeId}:${job.id}` === created.data.job.id)?.status, 'completed'));
  const exact = await f.request(`/jobs/${created.data.job.id}`);
  assert.equal(exact.status, 200); assert.equal(exact.data.job.status, 'completed'); assert.equal(exact.data.job.serverId, created.data.server.id);
  f.central.nodes.recordResponse(f.central.nodes.get(nodeId), { server: { ...created.data.server, id: created.data.server.id.split(':')[1] }, job: { ...created.data.job, id: created.data.job.id.split(':')[1], serverId: created.data.server.id.split(':')[1] } });
  assert.equal(f.central.manager.jobs().find(job => job.id === created.data.job.id).status, 'completed', 'A late queued acknowledgement cannot downgrade a directly observed terminal job');
  // Clone uses the generic proxy acknowledgement path rather than createRemote.
  const clone = await f.request(`/servers/${created.data.server.id}/clone`, { body: { name: 'Immediate acknowledged clone', port: 40200, portV6: 40201, eula: true } });
  assert.equal(clone.status, 201); await assertVisible(clone);
  held = false; release.resolve(); await oldRefresh;
  await assertVisible(created); await assertVisible(clone);
  // A later fresh observation may replace the queued acknowledgement with its
  // terminal state, and normal history retention remains authoritative.
  await eventually(() => assert.equal(agent.runtime.manager.jobs().find(job => `${nodeId}:${job.id}` === clone.data.job.id)?.status, 'completed'));
  await f.central.nodes.refresh(nodeId, { force: true });
  assert.equal((await f.request('/jobs')).data.jobs.find(job => job.id === clone.data.job.id).status, 'completed');
  const rawJob = created.data.job.id.split(':')[1];
  // Force refresh intentionally joins an existing request. Hold a snapshot
  // captured before the manual, event-free prune so this ordering is explicit.
  mock.mock.restore();
  const beforePrune = structuredClone(await original());
  assert.ok(beforePrune.jobs.some(job => job.id === rawJob));
  const enteredPrune = Promise.withResolvers(), releasePrune = Promise.withResolvers();
  let holdPrune = true, pruneEntered = false, heldSnapshots = 0;
  const pruneMock = t.mock.method(agent.runtime.manager, 'dashboard', async () => {
    if (holdPrune) { heldSnapshots++; pruneEntered = true; enteredPrune.resolve(); await releasePrune.promise; return structuredClone(beforePrune); }
    return original();
  });
  t.after(() => { holdPrune = false; releasePrune.resolve(); pruneMock.mock.restore(); });
  let beforePruneRefresh;
  await eventually(async () => {
    beforePruneRefresh = f.central.nodes.refresh(nodeId, { force: true });
    // An earlier background flight may finish first; drain it before the
    // deliberately held request begins. Only status reads are repeated.
    await Promise.race([beforePruneRefresh, enteredPrune.promise]);
    assert.equal(pruneEntered, true);
  });
  agent.store.data.jobs = agent.store.data.jobs.filter(job => job.id !== rawJob); agent.store.save();
  const joinedAfterPrune = f.central.nodes.refresh(nodeId, { force: true });
  holdPrune = false; releasePrune.resolve(); await Promise.all([beforePruneRefresh, joinedAfterPrune]);
  assert.equal(heldSnapshots, 1, 'The force call after pruning shares the already captured snapshot');
  assert.ok(f.central.nodes.stateOf(f.central.nodes.get(nodeId)).snapshot.jobs.some(job => job.id === rawJob), 'A joined pre-prune observation may still contain the job');
  // Now require an observation begun after the held flight finished. Worker
  // retention is authoritative once this fresh snapshot has been accepted.
  await f.central.nodes.refresh(nodeId, { force: true });
  assert.equal((await f.request('/jobs')).data.jobs.some(job => job.id === created.data.job.id), false);
  assert.equal((await f.request(`/jobs/${created.data.job.id}`)).status, 404);
  assert.equal(f.central.store.data.jobs.length, 0);
  t.diagnostic('Real HTTP acknowledgement/snapshot ordering and durable Agent jobs; install and clone execution are explicitly simulated, without native Bedrock.');
});

test('exact local and federated job reads enforce server grants, private admin history and colliding node namespaces', async t => {
  const f = await federationFixture(t);
  const id = randomUUID(), privateId = randomUUID(), missing = randomUUID();
  const record = (serverId, message) => ({ id, type: 'backup', serverId, message, status: 'completed', progress: 100, createdAt: new Date().toISOString() });
  f.central.store.data.jobs = [record(COLLISION_ID, 'Local job')];
  for (const [index, agent] of f.agents.entries()) { agent.store.data.jobs = [record(COLLISION_ID, `Agent ${index} job`)]; agent.store.save(); }
  f.central.store.data.nodeProvisionJobs = [{ id: privateId, type: 'node-provision', serverId: null, adminOnly: true, scope: 'nodes', status: 'failed', message: 'Private setup job', createdAt: new Date().toISOString() }];
  f.central.store.save();
  const granted = await f.createUser('exact-job-viewer', { serverIds: [COLLISION_ID, f.remote(0)] });
  const operator = await f.createUser('exact-job-operator', { role: 'operator', serverIds: [f.remote(0)] });
  const wrongServer = await f.createUser('exact-job-wrong', { serverIds: [f.remote(0, SECOND_ID)] });
  const all = await f.createUser('exact-job-all', { allServers: true });
  assert.equal((await f.request(`/jobs/${id}`, { actor: granted })).data.job.message, 'Local job');
  for (const [index, agent] of f.agents.entries()) {
    const composite = `${agent.linked.id}:${id}`;
    const admin = await f.request(`/jobs/${composite}`); assert.equal(admin.status, 200); assert.equal(admin.data.job.id, composite);
    assert.equal(admin.data.job.serverId, f.remote(index)); assert.equal(admin.data.job.message, `Agent ${index} job`);
  }
  const remoteJob = `${f.agents[0].linked.id}:${id}`;
  for (const actor of [granted, operator, all]) assert.equal((await f.request(`/jobs/${remoteJob}`, { actor })).status, 200);
  assert.equal((await f.request(`/jobs/${remoteJob}`, { actor: wrongServer })).status, 404);
  assert.equal((await f.request(`/jobs/${f.agents[1].linked.id}:${id}`, { actor: granted })).status, 404);
  assert.equal((await f.request(`/jobs/${privateId}`)).status, 200);
  for (const actor of [granted, operator, all]) assert.equal((await f.request(`/jobs/${privateId}`, { actor })).status, 404);
  assert.equal((await f.request(`/jobs/${id}`, { actor: operator })).status, 404);
  assert.equal((await f.request(`/jobs/${missing}`)).status, 404);
  assert.equal((await f.request(`/jobs/${f.agents[0].linked.id}:${missing}`)).status, 404);
  assert.equal((await f.request(`/jobs/${id}`, { actor: null })).status, 401);
  const denied = await f.request(`/jobs/${remoteJob}`, { actor: wrongServer, headers: { 'X-Vortex-Actor': Buffer.from(JSON.stringify({ ...f.admin.user, allServers: true })).toString('base64url') } });
  assert.equal(denied.status, 404);
  for (const agent of f.agents) { agent.store.data.jobs[0].message = 'Đã đưa vào hàng đợi'; agent.store.save(); }
  for (const language of ['en', 'vi']) {
    const localized = await f.request(`/jobs/${remoteJob}`, { headers: { 'Accept-Language': language } });
    assert.equal(localized.status, 200); assert.equal(localized.data.job.message, language === 'vi' ? 'Đã đưa vào hàng đợi' : 'Queued');
    const unavailable = await f.request(`/jobs/${missing}`, { headers: { 'Accept-Language': language } });
    assert.equal(unavailable.status, 404); assert.equal(unavailable.data.error, unavailable.data.errorI18n[language]);
  }
  await f.restartCentral();
  assert.equal((await f.request(`/jobs/${id}`)).data.job.id, id, 'Durable local job remains readable after controller restart');
  assert.equal((await f.request(`/jobs/${remoteJob}`)).data.job.serverId, f.remote(0), 'Remote lookup is authoritative after the controller cache is rebuilt');
});

test('job acknowledgements validate the whole response before updating cache and stale snapshots cannot resurrect an acknowledged deletion', async t => {
  const f = await federationFixture(t), agent = f.agents[0], node = f.central.nodes.get(agent.linked.id);
  const before = f.central.nodes.listServers().map(row => row.id);
  const validServer = { ...f.central.nodes.stateOf(node).snapshot.servers[0], id: randomUUID(), name: 'Must not be cached' };
  assert.throws(() => f.central.nodes.recordResponse(node, { server: validServer, job: { id: randomUUID(), serverId: `${node.id}:${COLLISION_ID}` } }), { status: 502 });
  assert.deepEqual(f.central.nodes.listServers().map(row => row.id), before);
  const jobId = randomUUID();
  const jobs = t.mock.method(agent.runtime.manager, 'jobs', () => [{ id: jobId, serverId: `${node.id}:${COLLISION_ID}`, message: 'Invalid cross-node reference' }]);
  assert.equal((await f.request(`/jobs/${node.id}:${jobId}`)).status, 502);
  assert.equal(f.central.nodes.manager.jobs().some(row => row.id === `${node.id}:${jobId}`), false); jobs.mock.restore();
  await f.central.nodes.refresh(node.id, { force: true });
  const original = agent.runtime.manager.dashboard.bind(agent.runtime.manager), stale = structuredClone(await original());
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let held = true;
  const mock = t.mock.method(agent.runtime.manager, 'dashboard', async () => { if (held) { entered.resolve(); await release.promise; return structuredClone(stale); } return original(); });
  t.after(() => { held = false; release.resolve(); mock.mock.restore(); });
  const pending = f.central.nodes.refresh(node.id, { force: true }); await entered.promise;
  assert.equal((await f.request(`/servers/${f.remote(0)}`, { method: 'DELETE' })).status, 200);
  held = false; release.resolve(); await pending;
  assert.equal(f.central.nodes.listServers().some(row => row.id === f.remote(0)), false);
  assert.equal(node.inventory.some(row => row.id === COLLISION_ID), false);
  assert.ok(f.central.nodes.listServers().some(row => row.id === f.remote(1)), 'Same raw UUID on the other Agent remains intact');
});
