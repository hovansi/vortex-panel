import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuth } from '../server/auth.js';

const password = 'isolated-administrator-password';
async function fixture(t) {
  const store = { data: { users: [] }, save() {}, audit() {} };
  const auth = createAuth({ store, setupToken: 'isolated-reauth-setup' });
  const app = express(); app.use(express.json()); app.use('/auth', auth.router);
  app.post('/system-change', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const user = await auth.reauthenticateAdmin(req, req.body.password);
    res.json({ accepted: true, actor: user.id });
  });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(base + '/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ token: 'isolated-reauth-setup', username: 'admin', password }) });
  assert.equal(setup.status, 200); const session = await setup.json(), cookie = setup.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: base, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
  return { auth, store, req: { headers: { cookie, host: new URL(base).host }, protocol: 'http' },
    post: (body, extra = {}) => fetch(base + '/system-change', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) }) };
}

test('system reauthentication uses actual current password and preserves HTTP session, CSRF and role enforcement', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ password }, { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await f.post({ password }, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post({ password: 'wrong' })).status, 403);
  assert.equal((await f.post({ password })).status, 200);
  f.store.data.users[0].role = 'viewer';
  assert.equal((await f.post({ password })).status, 403);
});

test('administrator password attempts are bounded and a correct password cannot bypass a locked account window', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) await assert.rejects(f.auth.reauthenticateAdmin(f.req, 'wrong'), { status: 403 });
  await assert.rejects(f.auth.reauthenticateAdmin(f.req, password), { status: 429 });
});

test('revocation while scrypt is pending prevents system admission', async t => {
  const f = await fixture(t), user = f.store.data.users[0];
  const pending = f.auth.reauthenticateAdmin(f.req, password);
  f.auth.revokeSessions(user.id);
  await assert.rejects(pending, { status: 401 });
});

test('account replacement while the password is pending cannot transfer an administrator authorization', async t => {
  const f = await fixture(t), user = f.store.data.users[0];
  const pending = f.auth.reauthenticateAdmin(f.req, password);
  f.store.data.users = [{ ...user }];
  await assert.rejects(pending, { status: 401 });
});
