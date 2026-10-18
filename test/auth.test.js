import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuth, constantEqual, hashPassword, verifyPassword } from '../server/auth.js';

test('scrypt password verification and malformed Unicode token are safe', async () => {
  const hash = await hashPassword('long-secret-password');
  assert.equal(await verifyPassword('long-secret-password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(constantEqual('éé', 'abcd'), false);
  assert.equal(constantEqual(undefined, 'a'), false);
});

test('setup secret, cookie session, CSRF, same-origin and session revocation', async t => {
  const store = { data: { users: [] }, audit() {}, save() {} };
  const auth = createAuth({ store, setupToken: 'test-setup-secret' });
  const app = express();
  app.use(express.json()); app.use('/auth', auth.router);
  app.post('/protected', auth.requireAuth, (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, headers = {}) => fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/protected', {})).status, 401);
  assert.equal((await request('/auth/demo', {})).status, 404);
  assert.equal((await request('/auth/setup', { token: 'wrong', username: 'admin', password: '123456789012' })).status, 403);
  const response = await request('/auth/setup', { token: 'test-setup-secret', username: 'admin', password: '123456789012' });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  const state = await response.json();
  assert.equal((await request('/auth/setup', { token: 'test-setup-secret' })).status, 409);
  assert.equal((await request('/protected', {}, { Cookie: cookie })).status, 403);
  const headers = { Cookie: cookie, 'X-CSRF-Token': state.csrfToken, Origin: base };
  assert.equal((await request('/protected', {}, headers)).status, 200);
  assert.equal((await request('/protected', {}, { ...headers, Origin: 'https://attacker.example' })).status, 403);
  assert.equal(auth.originAllowed({ headers: { origin: base, host: new URL(base).host }, socket: {} }), true);
  assert.equal((await request('/auth/logout', {}, headers)).status, 200);
  assert.equal((await request('/protected', {}, headers)).status, 401);
});

test('explicit demo recovery replaces stale fixture cookies and validates same origin', async t => {
  const store = { data: { users: [] }, audit() {}, save() {} };
  const auth = createAuth({ store, demo: true }); const app = express(); app.use(express.json()); app.use('/auth', auth.router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${base}/auth/status`, { headers: { Cookie: 'bedrock.sid=stale-session' } }); assert.equal((await status.json()).authenticated, false);
  const denied = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { Origin: 'https://attacker.example' } }); assert.equal(denied.status, 403);
  const recovered = await fetch(`${base}/auth/demo`, { method: 'POST', headers: { Origin: base, Cookie: 'bedrock.sid=stale-session' } });
  assert.equal(recovered.status, 200); const state = await recovered.json(); assert.equal(state.authenticated, true); assert.equal(state.user.role, 'admin'); assert.ok(recovered.headers.get('set-cookie'));
  store.data.users[0].disabled = true;
  assert.equal((await fetch(`${base}/auth/demo`, { method: 'POST', headers: { Origin: base } })).status, 409);
  assert.equal((await (await fetch(`${base}/auth/status`)).json()).authenticated, false);
});
