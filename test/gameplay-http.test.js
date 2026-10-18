import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';

test('real authenticated HTTP restricts gameplay mutations/query to assigned managers, with safe Viewer metadata and no simulated confirmations', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-gameplay-http-')), runtime = await createApp({ dataDir, demo: true });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); assert.ok(path.basename(dataDir).startsWith('vortex-gameplay-http-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, status = await fetch(origin + '/api/auth/status'), session = await status.json(), admin = { cookie: status.headers.get('set-cookie').split(';')[0], csrf: session.csrfToken };
  const [server, other] = runtime.manager.listServers(), base = `/servers/${server.id}`, worldRevision = 'b'.repeat(64), target = { name: 'A Traveler', xuid: '', connectionId: randomUUID() };
  async function request(actor, route, body, method = 'POST', language = 'en', csrf = actor.csrf) {
    const response = await fetch(origin + '/api' + route, { method, headers: { Cookie: actor.cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json', 'Accept-Language': language }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function account(username, role) {
    assert.equal((await request(admin, '/auth/users', { username, password: 'fixture-only-gameplay-password', role, serverIds: [server.id], allServers: false })).status, 201);
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'fixture-only-gameplay-password' }) }); assert.equal(response.status, 200); const data = await response.json(); return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
  }
  const operator = await account('gameplayoperator', 'operator'), viewer = await account('gameplayviewer', 'viewer');
  const logs = runtime.manager.logs(server.id).length, activity = runtime.store.data.activity.length;
  for (const language of ['en', 'vi']) {
    const response = await request(viewer, base + '/gameplay', undefined, 'GET', language); assert.equal(response.status, 200); assert.equal(response.data.queryAvailable, false); assert.equal(response.data.server.permissions.manage, false); assert.equal(response.data.available, false); assert.equal(response.data.world.revision, null); assert.ok(response.data.rules.every(rule => rule.value === null && rule.status === 'not-queried')); assert.equal(response.data.rules[0].key, 'showcoordinates'); assert.equal(response.data.rules[0].label, language === 'en' ? 'Show coordinates' : 'Hiện tọa độ'); assert.equal(response.data.rules[0].labelI18n.en, 'Show coordinates'); const inventory = response.data.rules.find(rule => rule.key === 'keepinventory'); assert.equal(inventory.label, language === 'en' ? 'Keep inventory after death' : 'Giữ đồ khi chết'); assert.ok(!Object.hasOwn(response.data, 'acceptedToConsole'));
  }
  const cases = [['/gamerules/query', { worldRevision, keys: ['keepinventory'] }, 'POST'], ['/gamerules', { worldRevision, changes: { keepinventory: true }, expected: { keepinventory: false } }, 'PATCH'], ['/player-actions', { worldRevision, action: 'kill', target }, 'POST']];
  for (const [route, body, method] of cases) {
    assert.equal((await request(viewer, base + route, body, method)).status, 403);
    assert.equal((await request(operator, `/servers/${other.id}` + route, body, method)).status, 403);
    const unsupported = await request(operator, base + route, body, method); assert.equal(unsupported.status, 409); assert.match(unsupported.data.error, /owned native server/); assert.ok(!Object.hasOwn(unsupported.data, 'acceptedToConsole'));
  }
  assert.equal((await request(operator, `/servers/${other.id}/gameplay`, undefined, 'GET')).status, 403);
  assert.equal((await request(operator, base + '/gamerules/query', { worldRevision }, 'POST', 'en', 'missing')).status, 403);
  for (const locale of ['en', 'vi']) { const invalid = await request(operator, base + '/gamerules/query', { worldRevision, keys: ['private-input-value'] }, 'POST', locale); assert.equal(invalid.status, 400); assert.equal(invalid.data.error, locale === 'en' ? 'World rule list is invalid.' : 'Danh sách luật thế giới không hợp lệ.'); assert.ok(!JSON.stringify(invalid.data).includes('private-input-value')); }
  assert.equal(runtime.manager.logs(server.id).length, logs); assert.equal(runtime.store.data.activity.length, activity);
  assert.equal((await request(operator, base + '/stop', {})).status, 200);
  assert.equal((await request(operator, base + '/gamerules/query', { worldRevision })).status, 409);
});
