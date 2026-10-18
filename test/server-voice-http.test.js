import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

test('announcement HTTP enforces assigned management scope and server language independently of UI locale (simulated delivery)', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-voice-http-')), runtime = await createApp({ dataDir, demo: true });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); assert.ok(path.basename(dataDir).startsWith('vortex-voice-http-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.server.address().port}`, status = await fetch(origin + '/api/auth/status'), auth = await status.json(), admin = { cookie: status.headers.get('set-cookie').split(';')[0], csrf: auth.csrfToken };
  const [first, second] = runtime.manager.listServers(), base = `/servers/${first.id}`;
  async function request(actor, route, body, method = 'POST', language = 'en') {
    const response = await fetch(origin + '/api' + route, { method, headers: { Cookie: actor.cookie, Origin: origin, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json', 'Accept-Language': language }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function account(username, role) {
    assert.equal((await request(admin, '/auth/users', { username, password: 'vortex-voice-http-test-password', role, serverIds: [first.id], allServers: false })).status, 201);
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'vortex-voice-http-test-password' }) }); assert.equal(login.status, 200); const body = await login.json(); return { cookie: login.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken };
  }
  const operator = await account('voiceoperator', 'operator'), viewer = await account('voiceviewer', 'viewer'), values = { worldName: 'Sky Islands', playerName: 'Traveler' }, body = { templateId: 'welcome', values, expectedLanguage: 'en' };
  const before = runtime.manager.logs(first.id).length;
  assert.equal((await request(viewer, base + '/announcement', body)).status, 403); assert.equal((await request(operator, `/servers/${second.id}/announcement`, body)).status, 403); assert.equal(runtime.manager.logs(first.id).length, before);
  assert.equal((await request(viewer, base, { messageLanguage: 'vi' }, 'PATCH')).status, 403);
  const english = await request(operator, base + '/announcement', body, 'POST', 'vi'); assert.equal(english.status, 200); assert.equal(english.data.announcement.language, 'en'); assert.match(english.data.announcement.plainText, /A new chapter opens/); assert.equal(english.data.acceptedToConsole, false); assert.equal(english.data.simulated, true);
  assert.equal((await request(operator, base, { messageLanguage: 'vi', worldVoiceEnabled: false }, 'PATCH', 'en')).status, 200);
  const staleCount = runtime.manager.logs(first.id).length, mismatch = await request(operator, base + '/announcement', body, 'POST', 'en'); assert.equal(mismatch.status, 409); assert.equal(mismatch.data.error, 'The server message language changed. Review the preview before sending again.'); assert.equal(runtime.manager.logs(first.id).length, staleCount);
  const vietnamese = await request(operator, base + '/announcement', { ...body, expectedLanguage: 'vi' }, 'POST', 'en'); assert.equal(vietnamese.status, 200); assert.equal(vietnamese.data.announcement.language, 'vi'); assert.match(vietnamese.data.announcement.plainText, /Một chương mới mở ra/);
  assert.equal((await request(operator, base + '/announcement', { ...body, language: 'en' }, 'POST', 'en')).data.error, 'The server announcement request is invalid.');
  const stopped = await request(operator, base + '/stop', {}); assert.equal(stopped.status, 200); assert.equal((await request(operator, base + '/announcement', { templateId: 'backup' })).status, 409);
  assert.ok(runtime.manager.serverActivity(first.id).some(record => record.action === 'server.announcement' && record.user === 'voiceoperator' && record.serverId === first.id));
  for (const language of ['en', 'vi']) {
    const invalid = await request(operator, base + '/announcement', { templateId: 'private-user-value' }, 'POST', language); assert.equal(invalid.status, 400); assert.equal(invalid.data.error, language === 'en' ? 'Choose a valid announcement template.' : 'Chọn một mẫu thông báo hợp lệ.'); assert.ok(!JSON.stringify(invalid.data).includes('private-user-value'));
  }
});
