import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuth } from '../server/auth.js';
import { localeMiddleware } from '../server/locale.js';

const password = 'isolated-current-password', replacement = 'isolated-replacement-password';
async function fixture(t) {
  const store = { data: { users: [] }, save() {} }, auth = createAuth({ store, setupToken: 'password-rate-fixture' });
  const app = express(); app.use(localeMiddleware); app.use(express.json()); app.use('/api/auth', auth.router);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { actor, body, language = 'en' } = {}) {
    const response = await fetch(base + '/api/auth' + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, 'Accept-Language': language, 'Content-Type': 'application/json', ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), retryAfter: response.headers.get('retry-after'), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const session = response => ({ cookie: response.cookie, csrfToken: response.data.csrfToken });
  const setup = await request('/setup', { body: { token: 'password-rate-fixture', username: 'password-admin', password } }); assert.equal(setup.status, 200);
  const login = async current => { const response = await request('/login', { body: { username: 'password-admin', password: current } }); assert.equal(response.status, 200); return session(response); };
  return { store, request, first: session(setup), second: await login(password), login };
}

test('password proof attempts are reserved across concurrent sessions, with localized cooldown and usable login', async t => {
  const f = await fixture(t); let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.request('/password', { actor: i % 2 ? f.first : f.second, language: 'vi', body: { currentPassword: 'incorrect', password: replacement } })));
  assert.equal(results.filter(row => row.status === 403).length, 5); assert.equal(results.filter(row => row.status === 429).length, 3);
  for (const row of results.filter(row => row.status === 429)) { assert.ok(Number(row.retryAfter) > 0 && Number(row.retryAfter) <= 900); assert.equal(row.data.error, row.data.errorI18n.vi); }
  assert.equal(f.store.data.users[0].disabled, false);
  const third = await f.login(password);
  const locked = await f.request('/password', { actor: third, body: { currentPassword: password, password: replacement } });
  assert.equal(locked.status, 429); assert.equal(locked.data.error, locked.data.errorI18n.en);
  assert.equal((await f.request('/status', { actor: f.first })).data.authenticated, true);
  clock += 15 * 60 * 1000 + 1;
  assert.equal((await f.request('/password', { actor: third, body: { currentPassword: password, password: replacement } })).status, 200);
  assert.equal((await f.request('/status', { actor: third })).data.authenticated, true);
  for (const actor of [f.first, f.second]) assert.equal((await f.request('/status', { actor })).data.authenticated, false);
});

test('successful password rotation clears its proof bucket and preserves the current session while revoking others', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) assert.equal((await f.request('/password', { actor: f.first, body: { currentPassword: 'incorrect', password: replacement } })).status, 403);
  assert.equal((await f.request('/password', { actor: f.first, body: { currentPassword: password, password: replacement } })).status, 200);
  assert.equal((await f.request('/status', { actor: f.second })).data.authenticated, false);
  for (let i = 0; i < 4; i++) assert.equal((await f.request('/password', { actor: f.first, body: { currentPassword: 'incorrect', password } })).status, 403);
  assert.equal((await f.request('/password', { actor: f.first, body: { currentPassword: replacement, password } })).status, 200);
  assert.equal((await f.request('/status', { actor: f.first })).data.authenticated, true);
  await f.login(password);
});
