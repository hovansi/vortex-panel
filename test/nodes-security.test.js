import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import yauzl from 'yauzl';
import express from 'express';
import WebSocket from 'ws';
import { createNodeRouter, remoteServerRouteAllowed } from '../server/node-routes.js';
import { createNodeSecrets } from '../server/node-secrets.js';
import { NODE_INSTALLER_FILES } from '../server/node-runtime.js';
import { COLLISION_ID, SECOND_ID, federationFixture, eventually, pause, digest } from './nodes080-fixture.js';

test('session, CSRF, origin and remote grants are checked before forwarding even with spoofed agent/actor headers', async t => {
  const f = await federationFixture(t);
  const viewer = await f.createUser('scope-viewer', { serverIds: [f.remote(0)] });
  const operator = await f.createUser('scope-operator', { role: 'operator', serverIds: [f.remote(0)] });
  const seen = [];
  for (const agent of f.agents) agent.runtime.server.prependListener('request', req => { if (req.url.startsWith('/api/servers/')) seen.push({ agent: agent.name, method: req.method, url: req.url, actor: req.headers['x-vortex-actor'] }); });
  const route = `/servers/${f.remote(0)}/configuration`, body = { settings: { name: 'must-not-apply' } };
  assert.equal((await f.request(route, { actor: null, method: 'PATCH', body })).status, 401);
  assert.equal((await f.request(route, { method: 'PATCH', body, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.request(route, { method: 'PATCH', body, headers: { Origin: 'https://outside.example' } })).status, 403);
  const forged = Buffer.from(JSON.stringify({ id: 'forged', username: 'forged', role: 'admin', allServers: true, serverIds: [] })).toString('base64url');
  assert.equal((await f.request(route, { actor: viewer, method: 'PATCH', body, headers: { Authorization: `Bearer ${f.agents[0].token}`, 'X-Vortex-Actor': forged } })).status, 403);
  assert.equal((await f.request(`/servers/${f.remote(1)}/configuration`, { actor: operator, method: 'PATCH', body, headers: { 'X-Vortex-Actor': forged } })).status, 403);
  assert.equal((await f.request(`/servers/${COLLISION_ID}/configuration`, { actor: operator, method: 'PATCH', body })).status, 403);
  assert.equal((await f.request(`/servers/${COLLISION_ID}/configuration`, { actor: operator })).status, 403);
  assert.equal(seen.length, 0);
  const accepted = await f.request(route, { actor: operator, method: 'PATCH', body: { settings: { name: 'Operator actual change' } }, headers: { 'X-Vortex-Actor': forged, Cookie: operator.cookie, 'X-Forwarded-For': '203.0.113.77' } });
  assert.equal(accepted.status, 200); assert.equal(seen.length, 1);
  const actualActor = JSON.parse(Buffer.from(seen[0].actor, 'base64url').toString());
  assert.equal(actualActor.role, 'operator'); assert.equal(actualActor.username, 'scope-operator'); assert.deepEqual(actualActor.serverIds, [COLLISION_ID]);
  assert.ok(f.agents[0].store.data.activity.some(record => record.action === 'server.configuration' && record.user === 'scope-operator'));
  const listed = await f.request('/servers', { actor: viewer }); assert.deepEqual(listed.data.servers.map(server => server.id), [f.remote(0)]);
  const dashboard = await f.request('/dashboard', { actor: viewer }); assert.equal(dashboard.data.host, null); assert.deepEqual(dashboard.data.activity, []);
  assert.deepEqual(dashboard.data.nodes.map(node => node.id), [f.agents[0].linked.id]);
  for (const node of dashboard.data.nodes) for (const privateField of ['host', 'endpoint', 'capabilities', 'serverCount', 'agentId', 'fingerprint', 'tokenEncrypted']) assert.equal(privateField in node, false);
});

test('viewer private exports and admin-only remote routes are denied before the headless agent receives them', async t => {
  const f = await federationFixture(t), viewer = await f.createUser('exports-viewer', { serverIds: [f.remote(0)] });
  const operator = await f.createUser('exports-operator', { role: 'operator', serverIds: [f.remote(0)] });
  const seen = [];
  f.agents[0].runtime.server.prependListener('request', req => { if (req.url.startsWith('/api/servers/')) seen.push(req.url); });
  const base = `/servers/${f.remote(0)}`;
  for (const method of ['GET', 'HEAD']) {
    for (const suffix of ['/file?path=keys%2Fserver_identity_key.pem', '/files/download?path=keys%2Fserver_identity_key.pem', '/worlds/Main/export', `/backups/${randomUUID()}/download`]) assert.equal((await f.request(base + suffix, { actor: viewer, method })).status, 403);
  }
  for (const [method, suffix, body] of [['POST', '/clone', { name: 'forbidden', port: 40000, portV6: 40001, eula: true }], ['DELETE', '', undefined], ['POST', '/host/terminal', { command: 'echo forbidden' }], ['POST', '/versions/import', {}]]) {
    const response = await f.request(base + suffix, { actor: operator, method, body }); assert.equal(response.status, suffix === '/clone' || suffix === '' ? 403 : 404);
  }
  for (const route of ['/nodes', '/nodes/agent-bundle', `/nodes/${f.agents[0].linked.id}/versions`]) assert.equal((await f.request(route, { actor: viewer })).status, 403);
  assert.equal((await f.request('/servers', { actor: operator, body: { nodeId: f.agents[0].linked.id, name: 'forbidden', eula: true } })).status, 403);
  assert.equal(seen.length, 0);
  const allowed = await f.request(base + '/file?path=config%2Freadme.txt', { actor: viewer }); assert.equal(allowed.status, 200); assert.equal(allowed.data.editable, false);
  const listing = await f.request(base + '/files?path=config', { actor: viewer }); assert.equal(listing.status, 200);
  for (const file of listing.data.files) for (const ability of ['edit', 'copy', 'move', 'rename', 'delete', 'compress', 'extract']) assert.equal(file.capabilities[ability], false);
  assert.equal(remoteServerRouteAllowed('POST', '/host/terminal'), false); assert.equal(remoteServerRouteAllowed('GET', '/auth/status'), false);
});

test('node enrollment rejects duplicate agents/endpoints and identity changes; rotation keeps grants and encrypted restart identity', async t => {
  const f = await federationFixture(t), first = f.agents[0];
  const granted = await f.createUser('identity-viewer', { serverIds: [f.remote(0)] });
  const keyHash = digest(await fs.readFile(path.join(f.root, 'controller', '.node-key'))), mfaHash = digest(await fs.readFile(path.join(f.root, 'controller', '.mfa-key')));
  const duplicate = await f.request('/nodes', { body: { name: 'Duplicate', endpoint: first.endpoint, token: first.token } }); assert.equal(duplicate.status, 409);
  for (const endpoint of ['http://localhost:9999', 'http://example.test', 'https://name:password@example.test', first.endpoint + '/api', first.endpoint + '?query=1']) assert.equal((await f.request('/nodes', { body: { name: 'Invalid', endpoint, token: first.token } })).status, 400);
  const original = structuredClone(f.central.nodes.get(first.linked.id));
  const wrongIdentity = http.createServer((_req, res) => res.setHeader('X-Vortex-Node-Id', f.agents[1].nodeId).end(JSON.stringify({ service: 'vortex-node', protocol: 1, nodeId: f.agents[1].nodeId })));
  wrongIdentity.listen(0, '127.0.0.1'); await once(wrongIdentity, 'listening'); t.after(() => new Promise(resolve => wrongIdentity.close(resolve)));
  const changed = await f.request(`/nodes/${first.linked.id}`, { method: 'PATCH', body: { endpoint: `http://127.0.0.1:${wrongIdentity.address().port}`, token: first.token } }); assert.equal(changed.status, 502);
  assert.deepEqual(f.central.nodes.get(first.linked.id), original);
  const encryptedBefore = original.tokenEncrypted;
  await first.runtime.close(); first.token = randomBytes(32).toString('base64url');
  await f.restartAgent(0);
  const rotated = await f.request(`/nodes/${first.linked.id}`, { method: 'PATCH', body: { token: first.token } }); assert.equal(rotated.status, 200); assert.equal(rotated.data.node.agentId, first.nodeId);
  assert.notEqual(f.central.nodes.get(first.linked.id).tokenEncrypted, encryptedBefore);
  const privateStore = await fs.readFile(path.join(f.root, 'controller', 'panel.json'), 'utf8'); assert.equal(privateStore.includes(first.token), false);
  const secrets = createNodeSecrets(path.join(f.root, 'controller'));
  assert.throws(() => secrets.open(f.central.nodes.get(first.linked.id).tokenEncrypted, f.agents[1].linked.id));
  await f.restartCentral();
  assert.equal(digest(await fs.readFile(path.join(f.root, 'controller', '.node-key'))), keyHash); assert.equal(digest(await fs.readFile(path.join(f.root, 'controller', '.mfa-key'))), mfaHash);
  assert.equal(f.central.nodes.get(first.linked.id).agentId, first.nodeId);
  assert.deepEqual(f.central.store.data.users.find(user => user.id === granted.user.id).serverIds, [f.remote(0)]);
  const state = await f.request(`/nodes/${first.linked.id}`); assert.equal(state.status, 200); assert.equal(state.data.node.online, true); assert.equal(JSON.stringify(state.data).includes(first.token), false); assert.equal('tokenEncrypted' in state.data.node, false);
});

test('opaque player/world identifiers survive remote proxy mapping and no remote object enters local metadata', async t => {
  const f = await federationFixture(t), operator = await f.createUser('opaque-operator', { role: 'operator', serverIds: [f.remote(0)] });
  const payload = { action: 'gamemode', player: { name: 'Opaque English', xuid: 'fixture-xuid-opaque', connectionId: randomUUID() }, worldRevision: `opaque-world:${randomUUID()}`, value: 'creative', confirmed: true };
  let observed;
  f.agents[0].runtime.manager.playerAction = (id, input) => { observed = { id, input }; return { serverId: id, submitted: true, player: input.player, worldRevision: input.worldRevision }; };
  const response = await f.request(`/servers/${f.remote(0)}/player-actions`, { actor: operator, body: payload }); assert.equal(response.status, 200);
  assert.equal(observed.id, COLLISION_ID); assert.deepEqual(observed.input, payload);
  assert.equal(response.data.serverId, f.remote(0)); assert.deepEqual(response.data.player, payload.player); assert.equal(response.data.worldRevision, payload.worldRevision);
  assert.deepEqual(f.central.store.data.servers.map(server => server.id), [COLLISION_ID]);
  t.diagnostic('A fixture manager spy verifies opaque request forwarding; it does not claim native player command validation or client receipt.');
});

test('a mutation that commits then loses its connection is never retried and reports unknown outcome', async t => {
  const f = await federationFixture(t), agent = f.agents[0], route = `/api/servers/${COLLISION_ID}`;
  let attempts = 0, requestSocket;
  agent.runtime.server.prependListener('request', req => { if (req.method === 'PATCH' && req.url === route) requestSocket = req.socket; });
  const update = agent.runtime.manager.updateServer;
  agent.runtime.manager.updateServer = (id, input) => { attempts++; const result = update(id, input); requestSocket.destroy(); return result; };
  const response = await f.request(`/servers/${f.remote(0)}`, { method: 'PATCH', body: { name: 'Committed before connection loss' } });
  assert.equal(response.status, 502); assert.match(response.data.error, /outcome is unknown/i); assert.match(response.data.error, /no automatic retry/i);
  await pause(150); assert.equal(attempts, 1); assert.equal(agent.runtime.manager.getServer(COLLISION_ID).name, 'Committed before connection loss');
  await f.central.nodes.refresh(agent.linked.id, { force: true });
  const recovered = await f.request(`/servers/${f.remote(0)}`); assert.equal(recovered.status, 200); assert.equal(recovered.data.server.name, 'Committed before connection loss');
});

test('remote binary download respects paused-client backpressure and abort closes the upstream owned stream', async t => {
  const f = await federationFixture(t), agent = f.agents[0], size = 64 * 1024 ** 2;
  await fs.writeFile(path.join(f.runPath(0), 'config', 'slow-download.dat'), Buffer.alloc(size, 0x72));
  let agentResponse, closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  agent.runtime.server.prependListener('request', (req, res) => { if (req.url.startsWith(`/api/servers/${COLLISION_ID}/files/download`)) { agentResponse = res; res.once('close', () => closed({ finished: res.writableFinished })); } });
  let bytesAtPause, received = 0;
  await new Promise((resolve, reject) => {
    let aborting = false;
    const request = http.get(f.base + `/api/servers/${f.remote(0)}/files/download?path=config%2Fslow-download.dat`, { headers: { Cookie: f.admin.cookie } }, response => {
      assert.equal(response.statusCode, 200);
      response.once('data', async chunk => {
        received += chunk.length; response.pause(); await pause(200);
        bytesAtPause = agentResponse.socket?.bytesWritten || 0;
        aborting = true; response.destroy(); request.destroy(); resolve();
      });
      response.on('error', error => { if (!aborting) reject(error); });
    });
    request.on('error', error => { if (!aborting) reject(error); });
  });
  assert.ok(received > 0 && received < size); assert.ok(bytesAtPause > 0 && bytesAtPause < size, `Upstream wrote ${bytesAtPause} bytes while client paused, total ${size}`);
  const outcome = await Promise.race([upstreamClosed, pause(3000).then(() => { throw new Error('Agent stream did not close after caller abort'); })]);
  assert.equal(outcome.finished, false);
  assert.equal((await f.request(`/servers/${f.remote(0)}/configuration`)).status, 200);
  t.diagnostic(`Actual 64 MiB file; client read ${received} bytes, upstream wrote ${bytesAtPause} before abort. No browser/client or native Bedrock throughput claim.`);
});

test('headless-agent bundle excludes transient credential/config/output data and non-admin download is blocked', async t => {
  const f = await federationFixture(t), projectDir = path.join(f.root, 'bundle-source'), marker = 'TRANSIENT-CREDENTIAL-MUST-NOT-BUNDLE';
  await fs.mkdir(projectDir, { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'README.md', '.env.example']) await fs.writeFile(path.join(projectDir, name), 'public source ' + name);
  for (const directory of ['server', 'public', 'deploy', 'scripts', 'docs', 'test', 'output', 'data']) { await fs.mkdir(path.join(projectDir, directory)); await fs.writeFile(path.join(projectDir, directory, directory === 'output' || directory === 'data' ? 'node-agent.json' : 'source.js'), directory === 'output' || directory === 'data' ? marker : 'public source'); }
  for (const relative of NODE_INSTALLER_FILES) {
    const target = path.join(projectDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(new URL('../' + relative, import.meta.url), target);
  }
  for (const relative of ['server/index.js', 'server/auth.js', 'server/node-provisioner.js', 'public/index.html', 'public/app.js', 'deploy/install.sh']) await fs.writeFile(path.join(projectDir, relative), marker);
  for (const name of ['.env', 'backup.bk', 'active.tmp']) await fs.writeFile(path.join(projectDir, 'deploy', name), marker);
  const app = express(); app.use((req, _res, next) => { req.session = { user: { role: 'admin', allServers: true } }; next(); }); app.use('/nodes', createNodeRouter(f.central.nodes, { projectDir }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const bundle = await fetch(`http://127.0.0.1:${server.address().port}/nodes/agent-bundle`); assert.equal(bundle.status, 200);
  const bytes = Buffer.from(await bundle.arrayBuffer()), entries = [];
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', resolve); zip.on('entry', entry => { entries.push(entry.fileName); zip.openReadStream(entry, (readError, stream) => { if (readError) return reject(readError); const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject); stream.on('end', () => { try { assert.equal(Buffer.concat(chunks).toString().includes(marker), false); zip.readEntry(); } catch (cause) { zip.close(); reject(cause); } }); }); }); zip.readEntry();
  }));
  assert.deepEqual(entries.slice().sort(), [...NODE_INSTALLER_FILES].sort());
  assert.ok(entries.includes('server/node-agent.js')); assert.ok(entries.includes('deploy/install-node.sh'));
  assert.equal(entries.includes('server/source.js'), false);
  for (const excluded of ['server/index.js', 'server/auth.js', 'server/node-provisioner.js', 'public/index.html', 'public/app.js', 'deploy/install.sh']) assert.equal(entries.includes(excluded), false, excluded);
  assert.ok(entries.every(name => !/^(?:output|data)\//.test(name) && !/\.bk$|\.tmp$|(?:^|\/)\.env$/.test(name)));
  const viewer = await f.createUser('bundle-viewer', { serverIds: [f.remote(0)] }); assert.equal((await f.request('/nodes/agent-bundle', { actor: viewer })).status, 403);
});

test('bad agent token does not log out the controller; maintenance blocks only new placement', async t => {
  const f = await federationFixture(t, { demoAgents: true }), agent = f.agents[0];
  const wrongToken = randomBytes(32).toString('base64url');
  const rejected = await f.request('/nodes', { body: { name: 'Wrong credential', endpoint: agent.endpoint, token: wrongToken } });
  assert.equal(rejected.status, 502); assert.match(rejected.data.error, /authenticat/i);
  assert.equal(JSON.stringify(rejected.data).includes(wrongToken), false); assert.equal(JSON.stringify(rejected.data).includes(agent.token), false);
  assert.equal((await f.request('/auth/status')).data.authenticated, true); assert.equal(f.central.store.data.nodes.length, 2);
  assert.equal((await f.request(`/nodes/${agent.linked.id}`, { method: 'PATCH', body: { maintenance: true } })).status, 200);
  const newServer = { nodeId: agent.linked.id, name: 'No new placement', version: '1.26.52.3', port: 40000, portV6: 40001, eula: true };
  assert.equal((await f.request('/servers', { body: newServer })).status, 409);
  assert.equal((await f.request(`/servers/${f.remote(0)}/clone`, { body: { name: 'No new clone', port: 40200, portV6: 40201, eula: true } })).status, 409);
  assert.equal((await f.request(`/servers/${f.remote(0)}`, { method: 'PATCH', body: { name: 'Existing server remains manageable' } })).status, 200);
  assert.equal(agent.runtime.manager.listServers().length, 2); assert.equal(agent.runtime.manager.jobs().length, 0);
});

test('real agent SSE to controller WebSocket preserves node scoping and revocation on colliding raw server IDs', async t => {
  const f = await federationFixture(t), viewer = await f.createUser('stream-viewer', { serverIds: [f.remote(0)] });
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/ws', { headers: { Origin: f.base, Cookie: viewer.cookie } });
  t.after(() => socket.terminate());
  const messages = []; socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  await once(socket, 'open'); await pause(100);
  const ownMessage = 'Synthetic agent A SSE log', forbiddenMessage = 'Synthetic agent B SSE log';
  f.agents[0].runtime.emit({ type: 'log', serverId: COLLISION_ID, runId: 'dba44a9a-2c5c-4dd2-9f2c-b8d597c5e785', log: { runId: 'dba44a9a-2c5c-4dd2-9f2c-b8d597c5e785', id: randomUUID(), time: new Date().toISOString(), level: 'info', message: ownMessage, source: 'native' } });
  f.agents[1].runtime.emit({ type: 'log', serverId: COLLISION_ID, runId: 'dba44a9a-2c5c-4dd2-9f2c-b8d597c5e785', log: { runId: 'dba44a9a-2c5c-4dd2-9f2c-b8d597c5e785', id: randomUUID(), time: new Date().toISOString(), level: 'info', message: forbiddenMessage, source: 'native' } });
  await eventually(() => { assert.ok(messages.some(event => event.type === 'log' && event.serverId === f.remote(0) && event.log.message === ownMessage)); });
  await pause(100); assert.equal(messages.some(event => event.log?.message === forbiddenMessage), false);
  const closed = once(socket, 'close');
  const revoked = await f.request(`/auth/users/${viewer.user.id}`, { method: 'PATCH', body: { serverIds: [] } }); assert.equal(revoked.status, 200);
  f.agents[0].runtime.emit({ type: 'log', serverId: COLLISION_ID, runId: 'dba44a9a-2c5c-4dd2-9f2c-b8d597c5e785', log: { runId: 'dba44a9a-2c5c-4dd2-9f2c-b8d597c5e785', id: randomUUID(), time: new Date().toISOString(), level: 'info', message: 'Must not arrive after revocation', source: 'native' } });
  const [code] = await Promise.race([closed, pause(3000).then(() => { throw new Error('Controller WebSocket did not revoke the stale session'); })]);
  assert.equal(code, 1008); assert.equal(messages.some(event => event.log?.message === 'Must not arrive after revocation'), false);
  t.diagnostic('Actual SSE and WebSocket transport; emitted log payloads are synthetic boundary probes, not native Bedrock output.');
});

test('partial multipart caller abort cancels the upstream upload and removes agent temporary bytes without committing', async t => {
  const realTempRoot = os.tmpdir(), uploadRoot = await fs.mkdtemp(path.join(realTempRoot, 'vortex-nodes080-upload-'));
  const temporaryDirectory = t.mock.method(os, 'tmpdir', () => uploadRoot);
  const f = await federationFixture(t), agent = f.agents[0];
  const stagingRoot = await agent.runtime.manager.uploadStagingDirectory(COLLISION_ID);
  t.after(async () => {
    temporaryDirectory.mock.restore();
    assert.equal(path.dirname(path.resolve(uploadRoot)), path.resolve(realTempRoot)); assert.ok(path.basename(uploadRoot).startsWith('vortex-nodes080-upload-'));
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });
  let uploadCalls = 0;
  const originalUpload = agent.runtime.manager.upload;
  agent.runtime.manager.upload = (...args) => { uploadCalls++; return originalUpload(...args); };
  const boundary = 'vortex080-partial-' + randomUUID();
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial-upload.dat"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  let request;
  const requestError = new Promise(resolve => {
    request = http.request(f.base + `/api/servers/${f.remote(0)}/files/upload?path=config`, { method: 'POST', headers: { Origin: f.base, Cookie: f.admin.cookie, 'X-CSRF-Token': f.admin.csrfToken, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': 10 * 1024 ** 2 } });
    request.on('error', resolve); request.write(prefix); request.write(Buffer.alloc(256 * 1024, 0x51));
  });
  t.after(() => request.destroy());
  await eventually(async () => { assert.ok((await fs.readdir(stagingRoot)).some(name => name.startsWith('bedrock-file-'))); });
  request.destroy(); await requestError;
  await eventually(async () => { assert.deepEqual((await fs.readdir(stagingRoot)).filter(name => name.startsWith('bedrock-file-')), []); });
  assert.equal(uploadCalls, 0);
  await assert.rejects(fs.stat(path.join(f.runPath(0), 'config', 'partial-upload.dat')), { code: 'ENOENT' });
  assert.equal((await f.request(`/servers/${f.remote(0)}/configuration`)).status, 200);
});

test('malformed remote network or job references quarantine only that node and retain the last-good inventory', async t => {
  const f = await federationFixture(t), agent = f.agents[0], nodeId = agent.linked.id;
  const originalRange = agent.store.data.servers[0].udpPorts;
  const originalJobs = agent.store.data.jobs;
  const lastGood = structuredClone(f.central.nodes.get(nodeId).inventory);
  try {
    for (const defect of ['udp-range', 'job-reference']) {
      if (defect === 'udp-range') agent.store.data.servers[0].udpPorts = 'malformed-remote-udp-range';
      else agent.store.data.jobs = [{ id: randomUUID(), type: 'schedule', status: 'completed', serverId: COLLISION_ID, backupJobId: 'malformed-reference', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() }];
      await f.central.nodes.refresh(nodeId, { force: true });
      assert.equal(f.central.nodes.publicNode(f.central.nodes.get(nodeId)).online, false, `Invalid ${defect} snapshot must not become live state`);
      assert.deepEqual(f.central.nodes.get(nodeId).inventory, lastGood);
      const dashboard = await f.request('/dashboard'); assert.equal(dashboard.status, 200);
      assert.ok(dashboard.data.servers.some(server => server.id === f.remote(1) && server.nodeOnline));
      assert.equal(dashboard.data.servers.find(server => server.id === f.remote(0)).status, 'unreachable');
      assert.equal((await f.request('/nodes')).status, 200);
      agent.store.data.servers[0].udpPorts = originalRange; agent.store.data.jobs = originalJobs;
      await f.central.nodes.refresh(nodeId, { force: true });
      assert.equal(f.central.nodes.publicNode(f.central.nodes.get(nodeId)).online, true);
    }
  } finally { agent.store.data.servers[0].udpPorts = originalRange; agent.store.data.jobs = originalJobs; }
});
