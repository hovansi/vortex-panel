import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAuth, verifyPassword } from '../server/auth.js';
import { createSecretVault, hotp } from '../server/mfa.js';

async function harness(t) {
  let failSave = false; let disk;
  const store = { data: { users: [], activity: [], servers: [{ id: 'assigned' }] }, save() { if (failSave) { failSave = false; throw new Error('Simulated durable write failure'); } disk = structuredClone(this.data); } };
  const auth = createAuth({ store, setupToken: 'bootstrap-secret', secretVault: createSecretVault('', { ephemeral: true }) });
  const app = express(); app.use(express.json()); app.use('/auth', auth.router);
  app.get('/protected', auth.requireAuth, (req, res) => res.json({ user: req.session.user }));
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { actor, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const response = await fetch(base + route, { method, headers: { Origin: base, 'Content-Type': 'application/json', ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const setup = await request('/auth/setup', { body: { token: 'bootstrap-secret', username: 'primary-admin', password: 'original-secure-password' } });
  assert.equal(setup.status, 200);
  return { request, store, auth, actor: { cookie: setup.cookie, csrfToken: setup.data.csrfToken }, failNextSave: () => { failSave = true; }, disk: () => disk };
}
const actorFrom = response => ({ cookie: response.cookie, csrfToken: response.data.csrfToken });

test('MFA requires second factor, encrypts persistent secret and enforces one-time factors', async t => {
  const h = await harness(t); const request = h.request;
  const oldLogin = await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } });
  const otherActor = actorFrom(oldLogin);
  assert.equal((await request('/auth/mfa', { actor: h.actor })).data.enabled, false);
  const setup = await request('/auth/mfa/setup', { actor: h.actor, body: { password: 'original-secure-password' } });
  assert.equal(setup.status, 200); assert.match(setup.data.qrDataUrl, /^data:image\/png;base64,/); assert.match(setup.data.otpauthUrl, /^otpauth:\/\/totp\/Vortex/);
  const counter = Math.floor(Date.now() / 30000); const code = hotp(setup.data.secret, counter);
  const enabled = await request('/auth/mfa/enable', { actor: h.actor, body: { code } });
  assert.equal(enabled.status, 200); assert.equal(enabled.data.recoveryCodes.length, 10);
  assert.equal(JSON.stringify(h.disk()).includes(setup.data.secret), false);
  assert.match(h.disk().users[0].mfaSecret, /^v1:/);
  assert.equal((await request('/protected', { actor: otherActor })).status, 401);
  assert.equal((await request('/protected', { actor: h.actor })).status, 200);
  const login = await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } });
  assert.equal(login.data.authenticated, false); assert.equal(login.data.mfaRequired, true); assert.equal(login.cookie, undefined);
  assert.equal((await request('/auth/mfa/verify', { body: { challengeToken: login.data.challengeToken, code } })).status, 401);
  const valid = await request('/auth/mfa/verify', { body: { challengeToken: login.data.challengeToken, code: hotp(setup.data.secret, counter + 1) } });
  assert.equal(valid.status, 200); assert.equal(valid.data.authenticated, true);
  assert.equal((await request('/auth/mfa/verify', { body: { challengeToken: login.data.challengeToken, code: enabled.data.recoveryCodes[0] } })).status, 401);
  const next = await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } });
  const recovery = await request('/auth/mfa/verify', { body: { challengeToken: next.data.challengeToken, code: enabled.data.recoveryCodes[0] } });
  assert.equal(recovery.status, 200); assert.equal(h.disk().users[0].mfaRecoveryHashes.length, 9);
  const another = await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } });
  assert.equal((await request('/auth/mfa/verify', { body: { challengeToken: another.data.challengeToken, code: enabled.data.recoveryCodes[0] } })).status, 401);
  const recovered = await request('/auth/mfa/verify', { body: { challengeToken: another.data.challengeToken, code: enabled.data.recoveryCodes[1] } });
  assert.equal(recovered.status, 200);
  const rotation = await request('/auth/mfa/recovery', { actor: actorFrom(recovered), body: { password: 'original-secure-password', code: enabled.data.recoveryCodes[2] } });
  assert.equal(rotation.status, 200); assert.equal(rotation.data.recoveryCodes.length, 10);
  assert.equal((await request('/auth/mfa/disable', { actor: actorFrom(recovered), body: { password: 'original-secure-password', code: enabled.data.recoveryCodes[3] } })).status, 403);
  assert.equal((await request('/auth/mfa/disable', { actor: actorFrom(recovered), body: { password: 'wrong-password', code: rotation.data.recoveryCodes[0] } })).status, 403);
  assert.equal((await request('/auth/mfa/disable', { actor: actorFrom(recovered), body: { password: 'original-secure-password', code: rotation.data.recoveryCodes[0] } })).status, 200);
  assert.equal((await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } })).data.authenticated, true);
});

test('failed durable auth commits preserve ACL, passwords, sessions and unused MFA factors', async t => {
  const h = await harness(t); const request = h.request;
  const created = await request('/auth/users', { actor: h.actor, body: { username: 'scoped-viewer', password: 'viewer-secure-password', role: 'viewer', serverIds: ['assigned'] } });
  const viewerLogin = await request('/auth/login', { body: { username: 'scoped-viewer', password: 'viewer-secure-password' } }); const viewer = actorFrom(viewerLogin);
  const diskBefore = structuredClone(h.disk()); h.failNextSave();
  const failedRole = await request(`/auth/users/${created.data.user.id}`, { actor: h.actor, method: 'PATCH', body: { disabled: true, role: 'operator' } });
  assert.equal(failedRole.status, 500); assert.deepEqual(h.store.data, diskBefore); assert.equal((await request('/protected', { actor: viewer })).status, 200);
  const oldLogin = await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } }); const otherActor = actorFrom(oldLogin);
  h.failNextSave(); assert.equal((await request('/auth/password', { actor: h.actor, body: { currentPassword: 'original-secure-password', password: 'new-secure-password' } })).status, 500);
  assert.equal(await verifyPassword('original-secure-password', h.store.data.users[0].passwordHash), true); assert.equal(await verifyPassword('new-secure-password', h.store.data.users[0].passwordHash), false);
  assert.equal((await request('/protected', { actor: h.actor })).status, 200); assert.equal((await request('/protected', { actor: otherActor })).status, 200);
  const setup = await request('/auth/mfa/setup', { actor: h.actor, body: { password: 'original-secure-password' } });
  const code = hotp(setup.data.secret, Math.floor(Date.now() / 30000)); h.failNextSave();
  assert.equal((await request('/auth/mfa/enable', { actor: h.actor, body: { code } })).status, 500);
  assert.equal(Boolean(h.store.data.users[0].mfaSecret), false); assert.equal((await request('/protected', { actor: otherActor })).status, 200);
  const enable = await request('/auth/mfa/enable', { actor: h.actor, body: { code } }); assert.equal(enable.status, 200);
  const challenge = await request('/auth/login', { body: { username: 'primary-admin', password: 'original-secure-password' } });
  const remaining = h.store.data.users[0].mfaRecoveryHashes.length; h.failNextSave();
  const failedFactor = await request('/auth/mfa/verify', { body: { challengeToken: challenge.data.challengeToken, code: enable.data.recoveryCodes[0] } });
  assert.equal(failedFactor.status, 500); assert.equal(failedFactor.cookie, undefined); assert.equal(h.store.data.users[0].mfaRecoveryHashes.length, remaining);
  const retry = await request('/auth/mfa/verify', { body: { challengeToken: challenge.data.challengeToken, code: enable.data.recoveryCodes[0] } });
  assert.equal(retry.status, 200); assert.equal(h.disk().users[0].mfaRecoveryHashes.length, remaining - 1);
});

test('MFA setup is bound to the session version and challenges expire after five attempts or five minutes', async t => {
  const h = await harness(t); const request = h.request;
  const stale = await request('/auth/mfa/setup', { actor: h.actor, body: { password: 'original-secure-password' } });
  assert.equal((await request('/auth/password', { actor: h.actor, body: { currentPassword: 'original-secure-password', password: 'updated-secure-password' } })).status, 200);
  assert.equal((await request('/auth/mfa/enable', { actor: h.actor, body: { code: hotp(stale.data.secret, Math.floor(Date.now() / 30000)) } })).status, 409);
  const setup = await request('/auth/mfa/setup', { actor: h.actor, body: { password: 'updated-secure-password' } });
  const enabled = await request('/auth/mfa/enable', { actor: h.actor, body: { code: hotp(setup.data.secret, Math.floor(Date.now() / 30000)) } }); assert.equal(enabled.status, 200);
  const challenge = await request('/auth/login', { body: { username: 'primary-admin', password: 'updated-secure-password' } });
  for (let count = 0; count < 5; count++) assert.equal((await request('/auth/mfa/verify', { body: { challengeToken: challenge.data.challengeToken, code: 'not-a-code' } })).status, 401);
  assert.equal((await request('/auth/mfa/verify', { body: { challengeToken: challenge.data.challengeToken, code: enabled.data.recoveryCodes[0] } })).status, 401);
  const expiring = await request('/auth/login', { body: { username: 'primary-admin', password: 'updated-secure-password' } });
  const originalNow = Date.now; const future = originalNow() + 5 * 60 * 1000 + 1000;
  try {
    Date.now = () => future;
    assert.equal((await request('/auth/mfa/verify', { body: { challengeToken: expiring.data.challengeToken, code: enabled.data.recoveryCodes[0] } })).status, 401);
  } finally { Date.now = originalNow; }
  assert.equal(h.disk().users[0].mfaRecoveryHashes.length, 10);
});
