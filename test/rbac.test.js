import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { canAccessServer } from '../server/access.js';

test('access decisions fail closed and viewer never receives mutation permissions', () => {
  assert.equal(canAccessServer(null, 'a'), false);
  assert.equal(canAccessServer({ role: 'unknown', allServers: true }, 'a'), false);
  assert.equal(canAccessServer({ role: 'admin', disabled: true }, 'a'), false);
  assert.equal(canAccessServer({ role: 'operator', serverIds: ['a'] }, 'a', true), true);
  assert.equal(canAccessServer({ role: 'operator', serverIds: ['a'] }, 'b'), false);
  assert.equal(canAccessServer({ role: 'viewer', allServers: true }, 'a'), true);
  assert.equal(canAccessServer({ role: 'viewer', allServers: true }, 'a', true), false);
});

test('RBAC enforces server isolation, read-only viewers, scoped websocket logs and account revocation', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-rbac-'));
  const runtime = await createApp({ dataDir, demo: true });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const status = await fetch(`${origin}/api/auth/status`); const adminAuth = await status.json();
  const admin = { cookie: status.headers.get('set-cookie').split(';')[0], csrf: adminAuth.csrfToken };
  const servers = runtime.manager.listServers(); const first = servers[0], second = servers[1];
  async function request(actor, route, method = 'GET', body) {
    const response = await fetch(`${origin}/api${route}`, { method, headers: { Cookie: actor.cookie, Origin: origin, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function create(username, role, serverIds = [], allServers = false) {
    const result = await request(admin, '/auth/users', 'POST', { username, password: 'vortex-test-password', role, serverIds, allServers });
    assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal('passwordHash' in result.data.user, false); return result.data.user;
  }
  async function login(username, password = 'vortex-test-password') {
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken, user: data.user };
  }
  const operatorUser = await create('operator', 'operator', [first.id]); const viewerUser = await create('viewer', 'viewer', [second.id]);
  await create('outsider', 'viewer'); const secondAdmin = await create('second-admin', 'admin');
  const operator = await login('operator'), viewer = await login('viewer'), outsider = await login('outsider');
  assert.deepEqual((await request(operator, '/servers')).data.servers.map(value => value.id), [first.id]);
  assert.deepEqual((await request(viewer, '/servers')).data.servers.map(value => value.id), [second.id]);
  assert.equal((await request(outsider, '/servers')).data.servers.length, 0);
  const scopedDashboard = (await request(operator, '/dashboard')).data; assert.equal(scopedDashboard.host, null); assert.deepEqual(scopedDashboard.activity, []); assert.equal(scopedDashboard.capabilities.hostTerminal, false);
  for (const route of [`/servers/${second.id}`, `/servers/${second.id}/logs`, `/servers/${second.id}/files`, `/servers/${second.id}/metrics`, `/servers/${second.id}/backups`, `/servers/${second.id}/players`, `/servers/${second.id}/packs`, `/servers/${second.id}/configuration`]) assert.equal((await request(operator, route)).status, 403, route);
  for (const [route, method, body] of [[`/servers/${second.id}/start`, 'POST', {}], [`/servers/${second.id}`, 'PATCH', { name: 'denied' }], [`/servers/${second.id}/file`, 'PUT', { path: 'x.txt', content: 'denied' }], ['/schedules', 'POST', { serverId: second.id, action: 'restart', intervalMinutes: 60 }]]) assert.equal((await request(viewer, route, method, body)).status, 403, route);
  for (const [route, method, body] of [['/auth/users', 'GET'], ['/host/info', 'GET'], ['/activity', 'GET'], ['/versions/refresh', 'POST', {}], ['/servers', 'POST', {}], [`/servers/${first.id}`, 'DELETE'], [`/servers/${first.id}/clone`, 'POST', {}]]) assert.equal((await request(operator, route, method, body)).status, 403, route);
  assert.equal((await request(operator, `/servers/${first.id}`, 'PATCH', { name: 'Operator managed' })).status, 200);
  assert.ok(runtime.manager.activity().some(entry => entry.action === 'server.settings' && entry.user === 'operator'));
  assert.equal((await request(viewer, `/servers/${second.id}/configuration`, 'PATCH', { settings: { name: 'Forbidden' } })).status, 403);
  assert.equal((await request(viewer, `/servers/${second.id}/files/move`, 'POST', { source: 'old.txt', destination: 'new.txt' })).status, 403);
  assert.equal((await request(operator, `/servers/${second.id}/files/move`, 'POST', { source: 'old.txt', destination: 'new.txt' })).status, 403);
  assert.equal((await request(operator, `/servers/${second.id}/configuration`, 'PATCH', { properties: { 'server-port': 29500 } })).status, 403);
  const ownConfiguration = await request(operator, `/servers/${first.id}/configuration`, 'PATCH', { settings: { autoStart: true, backupRetention: 4 } });
  assert.equal(ownConfiguration.status, 200); assert.equal(ownConfiguration.data.server.permissions.manage, true); assert.equal(ownConfiguration.data.server.backupRetention, 4);
  assert.equal((await request(viewer, `/servers/${second.id}/configuration`)).status, 200);
  assert.equal((await request(operator, '/versions/stable/1.26.52.3/verify', 'POST', {})).status, 403);
  const readonlyPacks = await request(viewer, `/servers/${second.id}/packs`); assert.equal(readonlyPacks.status, 200); const demoPack = readonlyPacks.data.packs[0];
  assert.equal((await request(viewer, `/servers/${second.id}/packs/${demoPack.uuid}`, 'PATCH', { enabled: true })).status, 403);
  assert.equal((await request(operator, `/servers/${second.id}/packs/${demoPack.uuid}`, 'DELETE')).status, 403);
  assert.equal((await request(viewer, `/servers/${second.id}/packs/import`, 'POST', {})).status, 403);
  const ownSchedule = await request(operator, '/schedules', 'POST', { serverId: first.id, action: 'command', command: 'list', intervalMinutes: 60 }); assert.equal(ownSchedule.status, 201);
  const otherSchedule = await request(admin, '/schedules', 'POST', { serverId: second.id, action: 'restart', intervalMinutes: 60 });
  for (const [actor, scheduleId] of [[operator, otherSchedule.data.schedule.id], [viewer, otherSchedule.data.schedule.id]]) {
    assert.equal((await request(actor, `/schedules/${scheduleId}`, 'PATCH', { enabled: false })).status, 403);
    assert.equal((await request(actor, `/schedules/${scheduleId}/run`, 'POST', {})).status, 403);
  }
  const editedSchedule = await request(operator, `/schedules/${ownSchedule.data.schedule.id}`, 'PATCH', { intervalMinutes: 15, enabled: false });
  assert.equal(editedSchedule.status, 200); assert.equal(editedSchedule.data.schedule.enabled, false);
  const manual = await request(operator, `/schedules/${ownSchedule.data.schedule.id}/run`, 'POST', {});
  assert.equal(manual.status, 202); assert.equal(manual.data.job.type, 'schedule');
  assert.equal((await request(operator, `/schedules/${otherSchedule.data.schedule.id}`, 'DELETE')).status, 403);
  assert.deepEqual((await request(operator, '/schedules')).data.schedules.map(value => value.id), [ownSchedule.data.schedule.id]);
  async function connect(actor) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: actor.cookie, Origin: origin } });
    const messages = []; ws.on('message', value => messages.push(JSON.parse(value.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }); return { ws, messages };
  }
  const opSocket = await connect(operator), viewerSocket = await connect(viewer);
  t.after(() => { opSocket.ws.terminate(); viewerSocket.ws.terminate(); });
  assert.equal((await request(admin, `/servers/${first.id}/command`, 'POST', { command: 'list' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(opSocket.messages.some(message => message.type === 'log' && message.serverId === first.id));
  assert.equal(viewerSocket.messages.some(message => message.type === 'log'), false);
  assert.equal((await request(admin, `/auth/users/${adminAuth.user.id}`, 'PATCH', { role: 'viewer' })).status, 409);
  assert.equal((await request(admin, `/auth/users/${adminAuth.user.id}`, 'DELETE')).status, 409);
  assert.equal((await request(admin, `/auth/users/${secondAdmin.id}`, 'PATCH', { role: 'viewer', serverIds: [second.id] })).data.user.allServers, false);
  assert.equal((await request(admin, `/auth/users/${operatorUser.id}`, 'PATCH', { serverIds: [] })).status, 200);
  assert.equal((await request(operator, '/servers')).status, 401);
  assert.equal((await request(admin, `/servers/${first.id}/command`, 'POST', { command: 'list' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(opSocket.ws.readyState, WebSocket.CLOSED);
  assert.equal((await request(admin, `/auth/users/${viewerUser.id}`, 'PATCH', { password: 'changed-test-password' })).status, 200);
  assert.equal((await request(viewer, '/servers')).status, 401);
  const newViewer = await login('viewer', 'changed-test-password'); assert.equal((await request(newViewer, `/servers/${second.id}`)).status, 200);
  assert.equal((await request(admin, `/auth/users/${viewerUser.id}`, 'DELETE')).status, 200); assert.equal((await request(newViewer, '/servers')).status, 401);
});
