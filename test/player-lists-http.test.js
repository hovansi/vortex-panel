import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { federationFixture, COLLISION_ID } from './nodes080-fixture.js';

test('local and federated player forms reject a stale revision without replacing the first client edits', async t => {
  const f = await federationFixture(t);
  const secondActor = await f.createUser('players-other-operator', { role: 'operator', allServers: true });
  for (const [id, run] of [[COLLISION_ID, path.join(f.root, 'controller', 'servers', COLLISION_ID, 'run')], [f.remote(0), f.runPath(0)]]) {
    const route = `/servers/${id}/players`;
    const first = await f.request(route), second = await f.request(route, { actor: secondActor });
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.match(first.data.revision, /^[a-f0-9]{64}$/);
    assert.equal(first.data.revision, second.data.revision);
    const lists = { allowlist: [{ name: 'First client', ignoresPlayerLimit: false, xuid: '123' }], permissions: [{ xuid: '123', permission: 'operator' }], revision: first.data.revision };
    const saved = await f.request(route, { method: 'PUT', body: lists });
    assert.equal(saved.status, 200); assert.match(saved.data.revision, /^[a-f0-9]{64}$/); assert.notEqual(saved.data.revision, first.data.revision);
    const bytes = await Promise.all(['allowlist.json', 'permissions.json'].map(name => fs.readFile(path.join(run, name), 'utf8')));
    for (const language of ['en', 'vi']) {
      const stale = await f.request(route, { method: 'PUT', actor: secondActor, headers: { 'Accept-Language': language }, body: { ...second.data, allowlist: [{ name: 'Second client stale' }] } });
      assert.equal(stale.status, 409); assert.equal(stale.data.code, 'PLAYER_LIST_CONFLICT');
      assert.equal(stale.data.errorI18n.id, 'panel.players.conflict'); assert.equal(stale.data.error, stale.data.errorI18n[language]);
      const malformed = await f.request(route, { method: 'PUT', actor: secondActor, headers: { 'Accept-Language': language }, body: { ...lists, revision: 'malformed-revision' } });
      assert.equal(malformed.status, 400); assert.equal(malformed.data.code, 'PLAYER_LIST_REVISION'); assert.equal(malformed.data.error, malformed.data.errorI18n[language]);
    }
    const current = await f.request(route);
    assert.deepEqual(current.data.allowlist, lists.allowlist); assert.deepEqual(current.data.permissions, lists.permissions); assert.equal(current.data.revision, saved.data.revision);
    assert.deepEqual(await Promise.all(['allowlist.json', 'permissions.json'].map(name => fs.readFile(path.join(run, name), 'utf8'))), bytes);
  }
});
