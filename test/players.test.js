import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';
import { validatePlayerLists, playerListsRevision, playerListErrorPayload } from '../server/player-lists.js';

const valid = { allowlist: [{ name: ' Alex ', xuid: '2533274790395904', ignoresPlayerLimit: false }], permissions: [{ xuid: '2533274790395904', permission: 'operator' }] };
async function fixture(t, demo = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-players-'));
  const server = { id: randomUUID(), name: 'Players', version: '1.20.0.0', channel: 'stable', transport: 'raknet', port: 30000, portV6: 30001, maxPlayers: 20, status: 'stopped', runtimeFiles: [] };
  const store = { data: { servers: [server], versions: [], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  const run = path.join(directory, 'servers', server.id, 'run');
  const files = { 'allowlist.json': '[{"name":"Original"}]\n', 'permissions.json': '[{"xuid":"123","permission":"member"}]\n' };
  if (demo) server.demoFiles = { ...files };
  else { await fs.mkdir(run, { recursive: true }); for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(run, name), content); }
  const manager = await createManager({ store, dataDir: directory, demo });
  t.after(async () => { store.save = () => {}; server.status = 'stopped'; delete server.jobId; await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, store, server, run, files };
}

test('player lists reject ambiguous flags, duplicate identities and unsafe numeric XUIDs', () => {
  for (const input of [
    null, [], { ...valid, allowlist: [{ name: 'Alex', ignoresPlayerLimit: 'false' }] },
    { ...valid, allowlist: [{ name: 'Alex' }, { name: ' alex ' }] },
    { ...valid, allowlist: [{ name: 'Alex', xuid: '123' }, { name: 'Other', xuid: '000123' }] },
    { ...valid, permissions: [{ xuid: '123', permission: 'member' }, { xuid: '000123', permission: 'operator' }] },
    { ...valid, permissions: [{ xuid: 25332747903959040, permission: 'operator' }] },
    { ...valid, permissions: [{ xuid: '18446744073709551616', permission: 'operator' }] },
    { ...valid, allowlist: [{ name: 'Bad\tName' }] }, { ...valid, allowlist: [{ name: 'Alex', xuid: false }] }
  ]) assert.throws(() => validatePlayerLists(input), error => error.status === 400);
  assert.deepEqual(validatePlayerLists(valid).allowlist, [{ name: 'Alex', xuid: '2533274790395904', ignoresPlayerLimit: false }]);
  assert.equal(validatePlayerLists({ allowlist: [{ name: 'No XUID yet' }], permissions: [{ xuid: '18446744073709551615', permission: 'member' }] }).permissions[0].xuid, '18446744073709551615');
});

test('player list pair commits once with actor and rolls both files back on metadata failure', async t => {
  const { manager, store, server, run } = await fixture(t);
  let writes = 0; store.save = () => { writes++; };
  await manager.withActor({ username: 'player-operator' }, () => manager.savePlayers(server.id, valid));
  assert.equal(writes, 1); assert.equal(store.data.activity[0].user, 'player-operator');
  assert.equal((await manager.players(server.id)).allowlist[0].name, 'Alex');
  const before = Object.fromEntries(await Promise.all(['allowlist.json', 'permissions.json'].map(async name => [name, await fs.readFile(path.join(run, name), 'utf8')])));
  const activity = structuredClone(store.data.activity);
  store.save = () => { throw new Error('Players disk full'); };
  await assert.rejects(manager.savePlayers(server.id, { allowlist: [{ name: 'Changed' }], permissions: [] }), /Players disk full/);
  for (const [name, content] of Object.entries(before)) assert.equal(await fs.readFile(path.join(run, name), 'utf8'), content);
  assert.deepEqual(store.data.activity, activity);
  assert.deepEqual((await fs.readdir(run)).filter(name => /\.tmp$|\.rollback$/.test(name)), []);
});

test('a second-file activation failure restores the already activated allowlist', async t => {
  const { manager, server, run, files } = await fixture(t);
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    if (String(source).endsWith('.tmp') && destination === path.join(run, 'permissions.json')) throw new Error('Injected permissions activation failure');
    return originalRename(source, destination);
  };
  try { await assert.rejects(manager.savePlayers(server.id, valid), /permissions activation failure/); }
  finally { fs.rename = originalRename; }
  for (const [name, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(run, name), 'utf8'), content);
  assert.deepEqual((await fs.readdir(run)).filter(name => /\.tmp$|\.rollback$/.test(name)), []);
});

test('player writes prepare both files first and remove newly created files on failed commit', async t => {
  const { manager, store, server, run, files } = await fixture(t);
  await fs.rm(path.join(run, 'permissions.json')); await fs.mkdir(path.join(run, 'permissions.json'));
  await assert.rejects(manager.savePlayers(server.id, valid), error => error.status === 409);
  assert.equal(await fs.readFile(path.join(run, 'allowlist.json'), 'utf8'), files['allowlist.json']);
  await fs.rmdir(path.join(run, 'permissions.json')); await fs.rm(path.join(run, 'allowlist.json'));
  store.save = () => { throw new Error('Missing file commit failure'); };
  await assert.rejects(manager.savePlayers(server.id, valid), /Missing file commit failure/);
  assert.deepEqual(await fs.readdir(run), []);
});

test('raw player file editor uses the pair transaction and demo failures preserve the lists', async t => {
  const { manager, store, server, run, files } = await fixture(t);
  store.save = () => { throw new Error('Raw editor write failed'); };
  await assert.rejects(manager.writeFile(server.id, 'permissions.json', JSON.stringify(valid.permissions)), /Raw editor write failed/);
  for (const [name, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(run, name), 'utf8'), content);
  const simulated = await fixture(t, true); const before = structuredClone(simulated.server);
  simulated.store.save = () => { throw new Error('Demo player failure'); };
  await assert.rejects(simulated.manager.savePlayers(simulated.server.id, valid), /Demo player failure/);
  assert.deepEqual(simulated.server, before); assert.equal(simulated.store.data.activity.length, 0);
  server.status = 'running'; await assert.rejects(manager.savePlayers(server.id, valid), error => error.status === 409);
  server.status = 'stopped'; server.jobId = 'busy'; await assert.rejects(manager.savePlayers(server.id, valid), error => error.status === 409);
});

test('player revisions exclude online state and reject stale sequential saves before changing either file', async t => {
  for (const demo of [false, true]) {
    const { manager, store, server, run } = await fixture(t, demo);
    const firstClient = await manager.players(server.id), secondClient = structuredClone(firstClient);
    assert.match(firstClient.revision, /^[a-f0-9]{64}$/);
    assert.equal(playerListsRevision({ ...firstClient, online: [{ name: 'Connected later' }] }), firstClient.revision);
    const saved = await manager.savePlayers(server.id, { ...valid, revision: firstClient.revision });
    const current = await manager.players(server.id);
    assert.equal(saved.revision, current.revision); assert.notEqual(current.revision, firstClient.revision);
    const names = ['allowlist.json', 'permissions.json'];
    const bytes = demo ? structuredClone(server.demoFiles) : Object.fromEntries(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(run, name), 'utf8')])));
    const activity = structuredClone(store.data.activity);
    await assert.rejects(manager.savePlayers(server.id, { ...secondClient, allowlist: [{ name: 'Stale replacement' }] }), error => {
      assert.equal(error.status, 409); assert.equal(error.code, 'PLAYER_LIST_CONFLICT');
      for (const language of ['en', 'vi']) { const payload = playerListErrorPayload(error, language); assert.equal(payload.error, payload.errorI18n[language]); }
      return true;
    });
    assert.deepEqual(await manager.players(server.id), current);
    assert.deepEqual(store.data.activity, activity);
    if (demo) assert.deepEqual(server.demoFiles, bytes);
    else for (const [name, content] of Object.entries(bytes)) assert.equal(await fs.readFile(path.join(run, name), 'utf8'), content);
    for (const revision of [null, '', 'not-a-hash', 'A'.repeat(64)]) await assert.rejects(manager.savePlayers(server.id, { ...valid, revision }), error => {
      assert.equal(error.status, 400); assert.equal(error.code, 'PLAYER_LIST_REVISION');
      for (const language of ['en', 'vi']) { const payload = playerListErrorPayload(error, language); assert.equal(payload.error, payload.errorI18n[language]); }
      return true;
    });
    // Compatibility: callers intentionally replacing both lists can omit the
    // precondition; browser forms always send the opening revision.
    assert.equal((await manager.savePlayers(server.id, { allowlist: [], permissions: [] })).ok, true);
  }
});
