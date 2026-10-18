import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COLLISION_ID, SECOND_ID, PASSWORD, federationFixture } from './nodes080-fixture.js';

test('remote advanced file access is bound to the authenticated session and full node/server identity, ignores forged headers and expires', async t => {
  const f = await federationFixture(t);
  const selected = f.remote(0), sameIdOnOtherNode = f.remote(1), otherServer = f.remote(0, SECOND_ID);
  const login = await f.request('/auth/login', { actor: null, body: { username: 'nodes-admin', password: PASSWORD } });
  assert.equal(login.status, 200);
  const otherSession = { cookie: login.cookie, csrfToken: login.data.csrfToken, user: login.data.user };
  const operator = await f.createUser('remote-file-operator', { role: 'operator', allServers: true });
  const viewer = await f.createUser('remote-file-viewer', { role: 'viewer', allServers: true });
  const removeRuntime = (id, options = {}) => f.request(`/servers/${encodeURIComponent(id)}/file?path=bedrock_server`, { method: 'DELETE', ...options });
  const runtimePath = (index, id = COLLISION_ID) => path.join(f.runPath(index, id), 'bedrock_server');
  const original = await fs.readFile(runtimePath(0));
  const otherOriginal = await fs.readFile(runtimePath(1));
  const localPath = path.join(f.root, 'controller', 'servers', COLLISION_ID, 'run', 'bedrock_server');
  const localOriginal = await fs.readFile(localPath);
  const forged = { 'X-Vortex-File-Access': JSON.stringify({ serverId: COLLISION_ID, expires: Date.now() + 600000 }) };

  assert.equal((await removeRuntime(selected)).status, 403);
  assert.equal((await removeRuntime(selected, { headers: forged })).status, 403);
  for (const actor of [operator, viewer]) {
    assert.equal((await f.request('/auth/file-access', { actor, body: { serverId: selected, password: PASSWORD, confirmed: true } })).status, 403);
    assert.equal((await removeRuntime(selected, { actor, headers: forged })).status, 403);
  }
  assert.equal((await f.request('/auth/file-access', { body: { serverId: selected, password: PASSWORD, confirmed: true }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/auth/file-access', { body: { serverId: selected, password: 'wrong-password', confirmed: true } })).status, 403);
  assert.equal((await f.request('/auth/file-access', { body: { serverId: selected, password: PASSWORD } })).status, 400);

  const enable = () => f.request('/auth/file-access', { body: { serverId: selected, password: PASSWORD, confirmed: true } });
  const grant = await enable();
  assert.equal(grant.status, 200);
  assert.equal(grant.data.fileAccess.serverId, selected);
  const listing = await f.request(`/servers/${encodeURIComponent(selected)}/files`);
  assert.equal(listing.status, 200);
  assert.equal(listing.data.fileAccess.expires, grant.data.fileAccess.expires);
  assert.equal(listing.data.files.find(file => file.path === 'bedrock_server').capabilities.delete, true);
  assert.equal((await removeRuntime(selected, { actor: otherSession })).status, 403);
  assert.equal((await removeRuntime(sameIdOnOtherNode, { headers: forged })).status, 403);
  assert.equal((await removeRuntime(otherServer, { headers: forged })).status, 403);
  assert.equal((await removeRuntime(COLLISION_ID, { headers: forged })).status, 403);
  assert.deepEqual(await fs.readFile(runtimePath(0)), original);
  assert.deepEqual(await fs.readFile(runtimePath(1)), otherOriginal);
  assert.deepEqual(await fs.readFile(localPath), localOriginal);

  assert.equal((await f.request('/auth/file-access', { method: 'DELETE', body: { serverId: selected } })).status, 200);
  assert.equal((await removeRuntime(selected, { headers: forged })).status, 403);
  assert.equal((await enable()).status, 200);
  const realNow = Date.now;
  const clock = t.mock.method(Date, 'now', () => realNow() + 11 * 60 * 1000);
  try {
    const expired = await f.request(`/servers/${encodeURIComponent(selected)}/files`, { headers: forged });
    assert.equal(expired.status, 200);
    assert.equal(expired.data.fileAccess, null);
    assert.equal(expired.data.files.find(file => file.path === 'bedrock_server').capabilities.delete, false);
    assert.equal((await removeRuntime(selected, { headers: forged })).status, 403);
  } finally { clock.mock.restore(); }

  assert.equal((await enable()).status, 200);
  assert.equal((await removeRuntime(selected)).status, 200);
  await assert.rejects(fs.stat(runtimePath(0)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(runtimePath(1)), otherOriginal);
  assert.deepEqual(await fs.readFile(localPath), localOriginal);
  assert.deepEqual(await fs.readFile(runtimePath(0, SECOND_ID)), original);
  t.diagnostic('Real controller cookies, CSRF, HTTP proxy and two authenticated agents with colliding raw server IDs; only inert temporary test files are removed.');
});
