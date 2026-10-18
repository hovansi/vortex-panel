import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { COLLISION_ID, SECOND_ID, federationFixture, eventually, digest } from './nodes080-fixture.js';

test('selected node catalog, immutable ZIP import and verification affect only the selected physical package store', async t => {
  const f = await federationFixture(t), version = '1.21.0.3';
  const selected = ['local', f.agents[0].linked.id, f.agents[1].linked.id];
  for (const [index, nodeId] of selected.slice(0, 2).entries()) {
    const targetStore = index === 0 ? f.central.store : f.agents[0].store;
    targetStore.data.versions.push({ version, channel: 'stable', historical: true, source: 'endstone',
      url: `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${version}.zip`,
      cached: false, available: false, availability: 'error', metadataStatus: 'error',
      verificationError: 'Fixture: previous CDN verification failed', metadataError: 'Fixture: previous metadata failed',
      availabilityCheckedAt: '2020-01-01T00:00:00.000Z' });
    targetStore.save();
    const zip = archiver('zip'), chunks = [];
    zip.on('data', chunk => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { zip.on('end', resolve); zip.on('error', reject); });
    const inert = Buffer.alloc(4096); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(inert); inert.writeUInt16LE(62, 18);
    zip.append(inert, { name: 'bedrock_server' });
    zip.append(`server-name=INERT selected package ${index}\nserver-port=19132\nserver-portv6=19133\n`, { name: 'server.properties' });
    await zip.finalize(); await done;
    const multipart = new FormData(); multipart.set('version', version); multipart.set('channel', 'stable'); multipart.set('file', new Blob([Buffer.concat(chunks)]), 'inert-package.zip');
    const imported = await f.request(`/nodes/${nodeId}/versions/import`, { body: multipart });
    assert.equal(imported.status, 201); assert.equal(imported.data.version.cached, true); assert.equal(imported.data.version.source, 'import');
    assert.equal(imported.data.version.availability, 'cached'); assert.equal(imported.data.version.verificationError, null); assert.equal(imported.data.version.metadataError, null);
    assert.equal(imported.data.version.metadataStatus, 'ready'); assert.notEqual(imported.data.version.availabilityCheckedAt, '2020-01-01T00:00:00.000Z');
    const verified = await f.request(`/nodes/${nodeId}/versions/stable/${version}/verify`, { body: {} });
    assert.equal(verified.status, 200); assert.equal(verified.data.version.version, version); assert.equal(verified.data.version.cached, true);
  }
  for (const [index, nodeId] of selected.entries()) {
    const catalog = await f.request(`/nodes/${nodeId}/versions`); assert.equal(catalog.status, 200);
    assert.equal(catalog.data.versions.some(row => row.version === version && row.cached), index < 2);
    if (index < 2) {
      const row = catalog.data.versions.find(row => row.version === version);
      assert.equal(row.availability, 'cached'); assert.equal(row.verificationError, null); assert.equal(row.metadataError, null); assert.equal(row.metadataStatus, 'ready');
    }
  }
  assert.equal((await f.request(`/nodes/${selected[2]}/versions/stable/${version}/verify`, { body: {} })).status, 404);
  const localPackage = path.join(f.root, 'controller', 'packages', `stable-${version}`, 'server.properties');
  const remotePackage = path.join(f.agents[0].dataDir, 'packages', `stable-${version}`, 'server.properties');
  assert.match(await fs.readFile(localPackage, 'utf8'), /selected package 0/); assert.match(await fs.readFile(remotePackage, 'utf8'), /selected package 1/);
  await assert.rejects(fs.stat(path.join(f.agents[1].dataDir, 'packages', `stable-${version}`)), { code: 'ENOENT' });
  const before = digest(await fs.readFile(localPackage));
  const refreshed = await f.request(`/nodes/${selected[1]}/versions/refresh`, { body: {} });
  assert.equal(refreshed.status, 200); assert.ok(refreshed.data.error); assert.equal(digest(await fs.readFile(localPackage)), before);
  const operator = await f.createUser('versions-operator', { role: 'operator', allServers: true });
  assert.equal((await f.request(`/nodes/${selected[1]}/versions/stable/${version}/verify`, { actor: operator, body: {} })).status, 403);
  t.diagnostic('Real multipart ZIP extraction, import, catalogs and cached verification on three isolated stores. ELF-header payload is inert and is never executed; external catalog access is deliberately disabled.');
});

test('real authenticated controller federates two headless agents without mixing colliding IDs or local stores', async t => {
  const f = await federationFixture(t);
  const response = await f.request('/dashboard'); assert.equal(response.status, 200);
  assert.equal(response.data.servers.length, 5);
  assert.equal(new Set(response.data.servers.map(server => server.id)).size, 5);
  assert.ok(response.data.servers.some(server => server.id === COLLISION_ID && server.nodeId === 'local'));
  for (let index = 0; index < 2; index++) {
    const server = response.data.servers.find(row => row.id === f.remote(index));
    assert.equal(server.nodeId, f.agents[index].linked.id); assert.equal(server.nodeOnline, true);
    assert.match(server.name, new RegExp(f.agents[index].name));
    const info = await f.request(`/servers/${f.remote(index)}/configuration`);
    assert.equal(info.status, 200); assert.equal(info.data.server.id, f.remote(index));
    assert.equal(info.data.resourcePolicy.mode, 'shared'); assert.equal(info.data.resources.effective, null);
    const versions = await f.request(`/nodes/${f.agents[index].linked.id}/versions`);
    assert.equal(versions.status, 200); assert.ok(JSON.stringify(versions.data).includes('1.26.52.3'));
  }
  assert.deepEqual(f.central.store.data.servers.map(server => server.id), [COLLISION_ID]);
  assert.equal(f.central.store.data.schedules.length, 0); assert.equal(f.central.store.data.jobs.length, 0);
  const serialized = await fs.readFile(path.join(f.root, 'controller', 'panel.json'), 'utf8');
  for (const agent of f.agents) assert.equal(serialized.includes(agent.token), false);
  assert.equal((await fs.stat(path.join(f.root, 'controller', '.node-key'))).size, 32);
  const nodeList = await f.request('/nodes'); assert.equal(nodeList.status, 200);
  for (const agent of f.agents) { assert.equal(JSON.stringify(nodeList.data).includes(agent.token), false); assert.equal(JSON.stringify(nodeList.data).includes(agent.linked.tokenEncrypted || 'not-present-ciphertext'), false); }
});

test('remote file HTTP uses actual independent agent disk bytes, revision checks, multipart upload and binary download', async t => {
  const f = await federationFixture(t), remote = f.remote(0);
  const otherBefore = await fs.readFile(path.join(f.runPath(1), 'config', 'readme.txt'), 'utf8');
  const localBefore = await fs.readFile(path.join(f.root, 'controller', 'servers', COLLISION_ID, 'run', 'config', 'readme.txt'), 'utf8');
  const read = await f.request(`/servers/${remote}/file?path=config%2Freadme.txt`); assert.equal(read.status, 200); assert.ok(read.data.revision);
  const edited = 'Node A only · opaque English / Tiếng Việt\n';
  assert.equal((await f.request(`/servers/${remote}/file`, { method: 'PUT', body: { path: 'config/readme.txt', content: edited, revision: read.data.revision } })).status, 200);
  assert.equal(await fs.readFile(path.join(f.runPath(0), 'config', 'readme.txt'), 'utf8'), edited);
  assert.equal((await f.request(`/servers/${remote}/file`, { method: 'PUT', body: { path: 'config/readme.txt', content: 'Must not overwrite', revision: read.data.revision } })).status, 409);
  const bytes = Buffer.from(Array.from({ length: 1024 * 1024 + 17 }, (_, n) => n % 251));
  const upload = new FormData(); upload.set('file', new Blob([bytes]), 'opaque-binary.dat');
  const sent = await f.request(`/servers/${remote}/files/upload?path=config`, { body: upload }); assert.equal(sent.status, 200);
  const disk = await fs.readFile(path.join(f.runPath(0), 'config', 'opaque-binary.dat')); assert.equal(digest(disk), digest(bytes));
  const download = await f.request(`/servers/${remote}/files/download?path=config%2Fopaque-binary.dat`, { raw: true });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /opaque-binary\.dat/);
  assert.equal(digest(Buffer.from(await download.arrayBuffer())), digest(bytes));
  const listing = await f.request(`/servers/${remote}/files?path=config`); assert.equal(listing.status, 200); assert.ok(listing.data.files.some(file => file.name === 'opaque-binary.dat'));
  assert.equal(await fs.readFile(path.join(f.runPath(1), 'config', 'readme.txt'), 'utf8'), otherBefore);
  assert.equal(await fs.readFile(path.join(f.root, 'controller', 'servers', COLLISION_ID, 'run', 'config', 'readme.txt'), 'utf8'), localBefore);
  await assert.rejects(fs.stat(path.join(f.runPath(1), 'config', 'opaque-binary.dat')), { code: 'ENOENT' });
});

test('remote configuration enforces node-local ports and preserves identity, world and the other agent', async t => {
  const f = await federationFixture(t), before = await fs.readFile(path.join(f.runPath(0), 'keys', 'server_identity_key.pem'));
  const worldBefore = await fs.readFile(path.join(f.runPath(0), 'worlds', 'Main', 'level.dat'));
  const otherProperties = await fs.readFile(path.join(f.runPath(1), 'server.properties'), 'utf8');
  const changed = await f.request(`/servers/${f.remote(0)}/configuration`, { method: 'PATCH', body: { settings: { name: 'Node A configured', messageLanguage: 'vi', resourcePolicy: { mode: 'shared' } }, properties: { 'server-port': 39500, 'server-portv6': 39501, difficulty: 'hard' }, udpMode: 'auto' } });
  assert.equal(changed.status, 200); assert.equal(changed.data.server.id, f.remote(0)); assert.equal(changed.data.server.port, 39500);
  assert.equal(changed.data.server.messageLanguage, 'vi'); assert.equal(changed.data.properties.difficulty, 'hard');
  assert.equal(digest(await fs.readFile(path.join(f.runPath(0), 'keys', 'server_identity_key.pem'))), digest(before));
  assert.equal(digest(await fs.readFile(path.join(f.runPath(0), 'worlds', 'Main', 'level.dat'))), digest(worldBefore));
  assert.equal(await fs.readFile(path.join(f.runPath(1), 'server.properties'), 'utf8'), otherProperties);
  const conflict = await f.request(`/servers/${f.remote(0, SECOND_ID)}/configuration`, { method: 'PATCH', body: { properties: { 'server-port': 39500, 'server-portv6': 39501 }, udpMode: 'auto' } }); assert.equal(conflict.status, 409);
  // Equal configured ports across independent nodes are valid; these inert
  // disk fixtures never bind game sockets or claim two physical hosts.
  const equalOnOtherNode = await f.request(`/servers/${f.remote(1)}/configuration`, { method: 'PATCH', body: { properties: { 'server-port': 39500, 'server-portv6': 39501 }, udpMode: 'auto' } }); assert.equal(equalOnOtherNode.status, 200);
});

test('remote creation, clone, lifecycle and namespaced jobs use demo runtime explicitly, never local manager records', async t => {
  const f = await federationFixture(t, { demoAgents: true });
  const create = index => f.request('/servers', { body: { nodeId: f.agents[index].linked.id, name: `Created on ${index}`, version: '1.26.52.3', channel: 'stable', port: 40000, portV6: 40001, maxPlayers: 5, resourcePolicy: { mode: 'shared' }, eula: true } });
  const created = await Promise.all([create(0), create(1)]);
  for (const [index, result] of created.entries()) {
    assert.equal(result.status, 201); assert.ok(result.data.server.id.startsWith(f.agents[index].linked.id + ':')); assert.ok(result.data.job.id.startsWith(f.agents[index].linked.id + ':'));
    const raw = result.data.server.id.split(':')[1];
    await eventually(() => { assert.equal(f.agents[index].runtime.manager.getServer(raw).status, 'stopped'); });
    assert.equal((await f.request(`/servers/${result.data.server.id}/start`, { body: {} })).status, 200);
    assert.equal(f.agents[index].runtime.manager.getServer(raw).status, 'running');
    assert.equal((await f.request(`/servers/${result.data.server.id}/stop`, { body: {} })).status, 200);
    assert.equal(f.agents[index].runtime.manager.getServer(raw).status, 'stopped');
    await f.central.nodes.refresh(f.agents[index].linked.id, { force: true });
  }
  const clone = await f.request(`/servers/${created[0].data.server.id}/clone`, { body: { name: 'Node A isolated clone', port: 40200, portV6: 40201, eula: true } });
  assert.equal(clone.status, 201); assert.notEqual(clone.data.server.id, created[0].data.server.id); assert.equal(clone.data.server.resourcePolicy.mode, 'shared');
  await eventually(() => { assert.equal(f.agents[0].runtime.manager.getServer(clone.data.server.id.split(':')[1]).status, 'stopped'); });
  await f.central.nodes.refresh(f.agents[0].linked.id, { force: true });
  const jobs = await f.request('/jobs'); assert.equal(jobs.status, 200);
  for (const result of created) assert.ok(jobs.data.jobs.some(job => job.id === result.data.job.id && job.serverId === result.data.server.id && job.status === 'completed'));
  assert.deepEqual(f.central.store.data.servers.map(server => server.id), [COLLISION_ID]); assert.equal(f.central.store.data.jobs.length, 0);
  t.diagnostic('Lifecycle/install/clone execution is explicitly simulated by demo agents. HTTP sessions, proxy authorization and persisted node metadata are real.');
});

test('actual disk backup schedules execute on the agent and every schedule/job reference is namespaced', async t => {
  const f = await federationFixture(t);
  const created = await f.request('/schedules', { body: { serverId: f.remote(0), action: 'backup', intervalMinutes: 60, enabled: false } });
  assert.equal(created.status, 201); const schedule = created.data.schedule; assert.equal(schedule.serverId, f.remote(0));
  assert.ok(schedule.id.startsWith(f.agents[0].linked.id + ':')); assert.equal(f.central.store.data.schedules.length, 0);
  await f.central.nodes.refresh(f.agents[0].linked.id, { force: true });
  const run = await f.request(`/schedules/${schedule.id}/run`, { body: {} }); assert.equal(run.status, 202);
  assert.equal(run.data.job.scheduleId, schedule.id); assert.equal(run.data.job.serverId, f.remote(0));
  await eventually(() => { const record = f.agents[0].runtime.manager.jobs().find(job => job.id === run.data.job.id.split(':')[1]); assert.equal(record.status, 'completed'); });
  await f.central.nodes.refresh(f.agents[0].linked.id, { force: true });
  const jobs = await f.request('/jobs'), job = jobs.data.jobs.find(row => row.id === run.data.job.id);
  assert.equal(job.status, 'completed'); assert.ok(job.backupJobId.startsWith(f.agents[0].linked.id + ':'));
  assert.ok(jobs.data.jobs.some(row => row.id === job.backupJobId && row.serverId === f.remote(0) && row.status === 'completed'));
  const backups = await f.request(`/servers/${f.remote(0)}/backups`); assert.equal(backups.status, 200); assert.equal(backups.data.backups.length, 1);
  assert.ok((await fs.readdir(path.join(f.agents[0].dataDir, 'servers', COLLISION_ID, 'backups'))).some(name => name.endsWith('.zip')));
  const schedules = await f.request('/schedules'); assert.equal(schedules.data.schedules.find(row => row.id === schedule.id).lastJobId, run.data.job.id);
  const moved = await f.request(`/schedules/${schedule.id}`, { method: 'PATCH', body: { serverId: f.remote(1) } }); assert.equal(moved.status, 400);
  assert.equal(f.agents[1].runtime.manager.schedules().length, 0); assert.equal(f.central.store.data.schedules.length, 0);
});

test('offline cache, agent reconnect and controller restart preserve links/grants/disk data without queued mutations', async t => {
  const f = await federationFixture(t), granted = await f.createUser('offline-viewer', { serverIds: [f.remote(0)] });
  const nodeId = f.agents[0].linked.id, previousLastSeen = f.central.nodes.get(nodeId).lastSeen;
  const beforeFile = await fs.readFile(path.join(f.runPath(0), 'config', 'readme.txt'), 'utf8');
  await f.agents[0].runtime.close();
  const tested = await f.request(`/nodes/${nodeId}/test`, { body: {} }); assert.equal(tested.status, 200); assert.equal(tested.data.node.online, false);
  const offline = await f.request('/servers', { actor: granted }); assert.equal(offline.status, 200); assert.equal(offline.data.servers.length, 1);
  const cached = offline.data.servers[0]; assert.equal(cached.id, f.remote(0)); assert.equal(cached.status, 'unreachable'); assert.equal(cached.lastKnownStatus, 'stopped'); assert.equal(cached.pid, null); assert.equal(cached.memoryMB, null); assert.equal(cached.nodeOnline, false);
  const jobsBefore = f.agents[0].runtime.manager.jobs().length;
  assert.equal((await f.request(`/servers/${f.remote(0)}/command`, { body: { command: 'list' } })).status, 503);
  assert.equal(f.agents[0].runtime.manager.jobs().length, jobsBefore);
  await f.restartCentral();
  assert.equal(f.central.store.data.nodes.length, 2); assert.equal(f.central.store.data.users.find(user => user.username === 'offline-viewer').serverIds[0], f.remote(0));
  assert.equal(f.central.nodes.publicNode(f.central.nodes.get(nodeId)).online, false); assert.ok(f.central.nodes.publicNode(f.central.nodes.get(nodeId)).lastSeen >= previousLastSeen);
  await f.restartAgent(0); await f.central.nodes.refresh(nodeId, { force: true });
  const restored = await f.request(`/servers/${f.remote(0)}/configuration`); assert.equal(restored.status, 200); assert.equal(restored.data.server.id, f.remote(0)); assert.equal(restored.data.server.nodeOnline, true);
  assert.equal(await fs.readFile(path.join(f.runPath(0), 'config', 'readme.txt'), 'utf8'), beforeFile);
  assert.deepEqual(f.central.store.data.servers.map(server => server.id), [COLLISION_ID]);
});

test('closing the controller does not stop agent runtime or its real scheduler loop', { timeout: 30000 }, async t => {
  const f = await federationFixture(t, { demoAgents: true });
  assert.equal((await f.request(`/servers/${f.remote(0)}/start`, { body: {} })).status, 200);
  const created = await f.request('/schedules', { body: { serverId: f.remote(0), action: 'backup', intervalMinutes: 1, enabled: true } }); assert.equal(created.status, 201);
  const rawScheduleId = created.data.schedule.id.split(':')[1];
  await f.central.close();
  assert.equal(f.agents[0].runtime.server.listening, true); assert.equal(f.agents[0].runtime.manager.getServer(COLLISION_ID).status, 'running');
  const schedule = f.agents[0].store.data.schedules.find(row => row.id === rawScheduleId);
  // Move only this isolated fixture's due time backwards; the real 15 s agent
  // scheduler interval, backup workflow and resume logic must execute it.
  schedule.nextRun = new Date(Date.now() - 1000).toISOString(); f.agents[0].store.save();
  await eventually(() => { assert.equal(schedule.status, 'completed'); assert.equal(f.agents[0].runtime.manager.getServer(COLLISION_ID).status, 'running'); }, { timeout: 22000, interval: 100 });
  assert.ok(f.agents[0].runtime.manager.jobs().some(job => job.scheduleId === rawScheduleId && job.status === 'completed'));
  assert.equal(f.central.store.data.schedules.length, 0);
  t.diagnostic('The agent scheduler interval and controller shutdown are real. Bedrock lifecycle and backup payload are explicitly demo runtime in this case.');
});

test('deleting a remote server removes only its scoped grants and bare unlink always requires verified worker uninstall', async t => {
  const f = await federationFixture(t);
  await f.createUser('deletion-operator', { role: 'operator', serverIds: [f.remote(0), f.remote(1), COLLISION_ID] });
  assert.equal((await f.request(`/nodes/${f.agents[0].linked.id}`, { method: 'DELETE' })).status, 409);
  const deleted = await f.request(`/servers/${f.remote(0)}`, { method: 'DELETE' }); assert.equal(deleted.status, 200);
  const grants = f.central.store.data.users.find(user => user.username === 'deletion-operator').serverIds;
  assert.deepEqual(grants.sort(), [f.remote(1), COLLISION_ID].sort());
  assert.equal(f.agents[0].runtime.manager.listServers().length, 1); assert.equal(f.agents[1].runtime.manager.listServers().length, 2); assert.equal(f.central.store.data.servers.length, 1);
  assert.equal((await f.request(`/servers/${f.remote(0, SECOND_ID)}`, { method: 'DELETE' })).status, 200);
  const unlinked = await f.request(`/nodes/${f.agents[0].linked.id}`, { method: 'DELETE' }); assert.equal(unlinked.status, 409);
  assert.equal(f.central.store.data.nodes.length, 2); assert.equal(f.agents[0].runtime.server.listening, true);
});

test('an in-flight remote creation prevents unlink or credential replacement until its result is correlated', async t => {
  const f = await federationFixture(t, { demoAgents: true }), agent = f.agents[0];
  for (const rawId of [COLLISION_ID, SECOND_ID]) assert.equal((await f.request(`/servers/${f.remote(0, rawId)}`, { method: 'DELETE' })).status, 200);
  await f.central.nodes.refresh(agent.linked.id, { force: true });
  assert.equal(agent.runtime.manager.listServers().length, 0);
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), arrival = new Promise(resolve => { arrived = resolve; });
  const create = agent.runtime.manager.createServer;
  agent.runtime.manager.createServer = async input => { arrived(); await gate; return create(input); };
  const creating = f.request('/servers', { body: { nodeId: agent.linked.id, name: 'Gated remote creation', version: '1.26.52.3', port: 40000, portV6: 40001, eula: true } });
  let failure;
  try {
    await Promise.race([arrival, new Promise((_, reject) => setTimeout(() => reject(new Error('Remote creation never reached the agent')), 4000))]);
    assert.equal(agent.runtime.manager.listServers().length, 0);
    assert.equal((await f.request(`/nodes/${agent.linked.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await f.request(`/nodes/${agent.linked.id}`, { method: 'PATCH', body: { token: agent.token } })).status, 409);
    assert.ok(f.central.store.data.nodes.some(node => node.id === agent.linked.id));
  } catch (error) { failure = error; }
  finally { release(); }
  const result = await creating;
  if (failure) throw failure;
  assert.equal(result.status, 201); assert.ok(result.data.server.id.startsWith(agent.linked.id + ':'));
  await eventually(() => { assert.equal(agent.runtime.manager.getServer(result.data.server.id.split(':')[1]).status, 'stopped'); });
  await f.central.nodes.refresh(agent.linked.id, { force: true });
  assert.ok((await f.request('/servers')).data.servers.some(server => server.id === result.data.server.id));
  assert.equal((await f.request(`/nodes/${agent.linked.id}`, { method: 'DELETE' })).status, 409);
  assert.deepEqual(f.central.store.data.servers.map(server => server.id), [COLLISION_ID]);
});
