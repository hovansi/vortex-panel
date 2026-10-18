import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { provisioningHttpFixture } from './nodes080-ssh-fixture.js';
import { eventually } from './nodes080-fixture.js';

test('SSH provisioning HTTP requires administrator session, CSRF and same origin before opening any SSH connection', async t => {
  const f = await provisioningHttpFixture(t), viewer = await f.makeUser('ssh-viewer', 'viewer'), operator = await f.makeUser('ssh-operator', 'operator');
  const payload = f.input({ name: 'Denied SSH installation', agentPort: 8443 });
  for (const actor of [null, viewer, operator]) {
    for (const [route, body] of [['/nodes/ssh/check', f.input()], ['/nodes/provision', payload]]) assert.equal((await f.request(route, { actor, body })).status, actor ? 403 : 401);
    assert.equal((await f.request('/nodes/provision/jobs', { actor })).status, actor ? 403 : 401);
  }
  assert.equal((await f.request('/nodes/ssh/check', { body: f.input(), headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await f.request('/nodes/provision', { body: payload, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(f.clientCreations, 0); assert.equal(f.ssh.connectionsSeen, 0); assert.equal(f.control.store.data.nodeProvisionJobs.length, 0);
});

test('actual SSH host discovery returns fingerprint but sends zero authentication and no credentials are persisted', async t => {
  const f = await provisioningHttpFixture(t);
  const discovery = await f.request('/nodes/ssh/check', { body: { host: '127.0.0.1', port: f.peer.address().port } });
  assert.equal(discovery.status, 200); assert.equal(discovery.data.hostFingerprint, f.fingerprint);
  assert.equal(discovery.data.requiresHostConfirmation, true); assert.equal(discovery.data.authenticated, false); assert.equal(discovery.data.host, null);
  assert.equal(discovery.data.existingAgent, null); assert.equal(f.ssh.authAttempts.length, 0); assert.equal(f.ssh.commands.length, 0);
  assert.ok(f.ssh.connectionsSeen >= 1); assert.equal(f.control.store.data.nodeProvisionJobs.length, 0);
  const disk = await fs.readFile(path.join(f.root, 'panel.json'), 'utf8'); assert.equal(disk.includes(f.password), false); assert.equal(JSON.stringify(discovery.data).includes(f.password), false);
  t.diagnostic('Real ssh2 client/server protocol with generated key; key discovery is rejected before SSH user authentication. No remote commands or VPS access.');
});

test('pinned authenticated HTTP check reads synthetic Ubuntu metadata over real SSH without exposing untrusted stderr', async t => {
  const f = await provisioningHttpFixture(t, { compatible: true });
  const checked = await f.request('/nodes/ssh/check', { body: f.input() });
  assert.equal(checked.status, 200); assert.equal(checked.data.authenticated, true); assert.equal(checked.data.requiresHostConfirmation, false);
  assert.equal(checked.data.hostFingerprint, f.fingerprint); assert.equal(checked.data.compatible, true); assert.equal(checked.data.host.root, true); assert.equal(checked.data.host.os, 'ubuntu'); assert.equal(checked.data.host.version, '24.04');
  assert.ok(f.ssh.authAttempts.some(attempt => attempt.method === 'password' && attempt.username === 'root'));
  assert.equal(f.ssh.commands.length, 1); assert.ok(f.ssh.commands[0].includes('VORTEX_PREFLIGHT_V1'));
  assert.equal(JSON.stringify(checked.data).includes(f.password), false); assert.equal((await fs.readFile(path.join(f.root, 'panel.json'), 'utf8')).includes(f.password), false);
  t.diagnostic('Ubuntu/systemd/resource values are synthetic SSH command replies; no shell commands are executed. SSH handshake, authentication and HTTP are real.');
});

test('changed SSH host key blocks all authentication and gives a safe bilingual error through the controller API', async t => {
  const f = await provisioningHttpFixture(t), wrongPin = 'SHA256:' + Buffer.alloc(32).toString('base64').replace(/=+$/, '');
  const denied = await f.request('/nodes/ssh/check', { body: f.input({ hostFingerprint: wrongPin }), headers: { 'Accept-Language': 'vi' } });
  assert.equal(denied.status, 502); assert.equal(f.ssh.authAttempts.length, 0); assert.equal(f.ssh.commands.length, 0);
  assert.ok(denied.data.errorI18n?.en && denied.data.errorI18n?.vi); assert.match(denied.data.errorI18n.en, /host key changed/i); assert.equal(denied.data.error, denied.data.errorI18n.vi);
  assert.equal(JSON.stringify(denied.data).includes(f.password), false); assert.equal((await f.request('/auth/status')).data.authenticated, true);
});

test('failed install job is truthful, admin-only and restart-persistent without SSH credentials or remote stderr', async t => {
  const f = await provisioningHttpFixture(t), viewer = await f.makeUser('jobs-viewer', 'viewer'), operator = await f.makeUser('jobs-operator', 'operator');
  const started = await f.request('/nodes/provision', { body: f.input({ name: 'Synthetic incompatible Ubuntu', agentPort: 8443 }) });
  assert.equal(started.status, 202); const id = started.data.job.id;
  assert.equal(started.data.job.adminOnly, true); assert.equal(started.data.job.scope, 'nodes'); assert.equal(started.data.job.progress, 0);
  let finished;
  await eventually(async () => { const status = await f.request(`/nodes/provision/jobs/${id}`); assert.equal(status.status, 200); assert.equal(status.data.job.status, 'failed'); finished = status.data.job; });
  assert.equal(finished.phase, 'failed'); assert.ok(finished.progress < 100); assert.equal(finished.outcomeUnknown, false); assert.equal(finished.completionStatusPersisted, true);
  assert.ok(finished.messageI18n.en && finished.messageI18n.vi); assert.match(finished.messageI18n.en, /Ubuntu 22\.04/);
  assert.equal(f.control.store.data.nodes.length, 0); assert.equal(f.ssh.commands.length, 1);
  for (const actor of [viewer, operator]) {
    assert.equal((await f.request(`/nodes/provision/jobs/${id}`, { actor })).status, 403);
    assert.equal((await f.request('/jobs', { actor })).data.jobs.some(job => job.id === id), false);
    assert.equal((await f.request('/dashboard', { actor })).data.jobs.some(job => job.id === id), false);
  }
  for (const value of [finished, (await f.request('/jobs')).data, (await f.request('/dashboard')).data, f.control.store.data.nodeProvisionJobs]) assert.equal(JSON.stringify(value).includes(f.password), false);
  assert.equal((await fs.readFile(path.join(f.root, 'panel.json'), 'utf8')).includes(f.password), false);
  const connectionsBeforeRestart = f.clientCreations;
  await f.control.close(); await f.startController();
  assert.equal((await f.request(`/nodes/provision/jobs/${id}`)).data.job.status, 'failed'); assert.equal(f.clientCreations, connectionsBeforeRestart);
  assert.equal((await fs.readFile(path.join(f.root, 'panel.json'), 'utf8')).includes(f.password), false);
});

test('controller shutdown interrupts only its SSH job and records unknown outcome without automatic replay', async t => {
  const f = await provisioningHttpFixture(t, { holdPreflight: true });
  const started = await f.request('/nodes/provision', { body: f.input({ name: 'Interrupted fixture', agentPort: 8443 }) }); assert.equal(started.status, 202);
  const id = started.data.job.id;
  await eventually(() => { assert.equal(f.ssh.commands.length, 1); assert.equal(f.control.store.data.nodeProvisionJobs.find(job => job.id === id).status, 'running'); });
  await f.control.close();
  const disk = JSON.parse(await fs.readFile(path.join(f.root, 'panel.json'), 'utf8')), job = disk.nodeProvisionJobs.find(row => row.id === id);
  assert.equal(job.status, 'failed'); assert.equal(job.phase, 'interrupted'); assert.equal(job.outcomeUnknown, true); assert.ok(job.progress < 100); assert.equal(JSON.stringify(disk).includes(f.password), false);
  const connectionsBeforeRestart = f.clientCreations;
  f.ssh.holdPreflight = false; await f.startController();
  assert.equal((await f.request(`/nodes/provision/jobs/${id}`)).data.job.phase, 'interrupted'); assert.equal(f.clientCreations, connectionsBeforeRestart);
  assert.equal(f.control.store.data.nodes.length, 0);
});
