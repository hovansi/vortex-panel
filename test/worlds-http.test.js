import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { createApp } from '../server/index.js';
import { zipDirectory, extractZip } from '../server/archives.js';
import { serializeProperties } from '../server/safety.js';
import { writeWorld, fingerprints, waitJob } from './worlds-fixture.js';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-worlds-http-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith('https:') ? Promise.reject(Error('Isolated worlds HTTP fixture has no external network')) : originalFetch(url, options);
  const runtime = await createApp({ dataDir, demo: false, setupToken: 'worlds-isolated-setup-token' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const server of runtime.store.data.servers) server.status = 'stopped'; await runtime.close(); globalThis.fetch = originalFetch; assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dataDir).startsWith('vortex-worlds-http-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  for (const index of [0, 1]) {
    const server = { id: randomUUID(), name: 'Same opaque name', status: 'stopped', version: '1.26.52.3', channel: 'stable', port: 32500 + index * 100, portV6: 32501 + index * 100, transport: 'raknet', maxPlayers: 10, backups: [], runtimeFiles: ['bedrock_server'], createdAt: new Date().toISOString() };
    runtime.store.data.servers.push(server); const run = path.join(dataDir, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, 'server.properties'), serializeProperties({ 'server-name': server.name, 'server-port': server.port, 'server-portv6': server.portV6, transport: 'raknet', 'max-players': 10, 'enable-lan-visibility': false, 'level-name': 'Main', 'level-seed': '' }));
    await fs.writeFile(path.join(run, 'bedrock_server'), 'Inert HTTP fixture, never executed.');
    await fs.mkdir(path.join(run, 'keys')); await fs.writeFile(path.join(run, 'keys', 'server_identity_key.pem'), 'Secret identity HTTP fixture; must not be visible to viewer');
    await writeWorld(path.join(run, 'worlds', 'Main'));
  }
  runtime.store.save();
  const [first, second] = runtime.store.data.servers, origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'worlds-isolated-setup-token', username: 'worldadmin', password: 'vortex-world-http-password' }) }); assert.equal(setup.status, 200); const auth = await setup.json();
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: auth.csrfToken };
  const headers = actor => ({ Cookie: actor.cookie, Origin: origin, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json', 'Accept-Language': 'vi' });
  const request = async (actor, route, body, method = 'POST') => { const response = await fetch(origin + '/api' + route, { method, headers: headers(actor), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() }; };
  async function login(username, role) {
    assert.equal((await request(admin, '/auth/users', { username, password: 'vortex-world-http-password', role, serverIds: [first.id], allServers: false })).status, 201);
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'vortex-world-http-password' }) }); assert.equal(response.status, 200); const data = await response.json(); return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
  }
  return { dataDir, runtime, first, second, origin, headers, request, admin, operator: await login('worldoperator', 'operator'), viewer: await login('worldviewer', 'viewer') };
}

test('Worlds and backup HTTP enforce scopes/mutation/privacy permissions and export HEAD performs no ZIP work', async t => {
  const x = await fixture(t), base = `/servers/${x.first.id}`, other = `/servers/${x.second.id}`, run = path.join(x.dataDir, 'servers', x.first.id, 'run');
  const original = await fingerprints(run), listing = await x.request(x.viewer, base + '/worlds', undefined, 'GET'); assert.equal(listing.status, 200); assert.equal(listing.data.worlds[0].name, 'Main');
  assert.equal((await x.request(x.operator, other + '/worlds', undefined, 'GET')).status, 403);
  for (const [route, body, method] of [[base + '/worlds/select', { name: 'Main' }, 'POST'], [base + '/worlds/create', { name: 'Denied' }, 'POST'], [base + '/worlds/import', {}, 'POST'], [base + '/worlds/Main', { name: 'Main' }, 'DELETE']]) assert.equal((await x.request(x.viewer, route, body, method)).status, 403, route);
  const backup = await x.runtime.manager.backup(x.first.id); await waitJob(x.runtime.manager, backup.id); const backupId = x.runtime.manager.backups(x.first.id)[0].id;
  assert.equal((await x.request(x.viewer, base + '/backups', undefined, 'GET')).status, 200);
  for (const endpoint of [base + '/worlds/Main/export', base + `/backups/${backupId}/download`]) {
    for (const method of ['GET', 'HEAD']) {
      const denied = await fetch(x.origin + '/api' + endpoint, { method, headers: x.headers(x.viewer) }); assert.equal(denied.status, 403, method + endpoint); await denied.arrayBuffer();
      const scoped = await fetch(x.origin + '/api' + endpoint.replace(base, other), { method, headers: x.headers(x.operator) }); assert.equal(scoped.status, 403); await scoped.arrayBuffer();
    }
  }
  for (const [route, body, method] of [[base + `/backups/${backupId}/verify`, {}, 'POST'], [base + `/backups/${backupId}`, { locked: true }, 'PATCH'], [base + `/backups/${backupId}`, {}, 'DELETE']]) assert.equal((await x.request(x.viewer, route, body, method)).status, 403);
  const pinned = await x.request(x.operator, base + `/backups/${backupId}`, { locked: true }, 'PATCH'); assert.equal(pinned.status, 200); assert.equal(pinned.data.backup.locked, true);
  assert.equal((await x.request(x.operator, base + `/backups/${backupId}`, undefined, 'DELETE')).status, 409);
  const verified = await x.request(x.operator, base + `/backups/${backupId}/verify`, {}); assert.equal(verified.status, 202); assert.equal((await waitJob(x.runtime.manager, verified.data.job.id)).result.backup.integrity.status, 'verified');
  const privateDownload = await fetch(x.origin + '/api' + base + `/backups/${backupId}/download`, { headers: x.headers(x.operator) }); assert.equal(privateDownload.status, 200); await privateDownload.arrayBuffer();
  let prepared = 0; const exportMethod = x.runtime.manager.exportWorld; x.runtime.manager.exportWorld = (...args) => { prepared++; return exportMethod(...args); };
  const endpoint = x.origin + '/api' + base + '/worlds/Main/export';
  const preflight = await fetch(endpoint, { method: 'HEAD', headers: x.headers(x.operator) }); assert.equal(preflight.status, 200); assert.equal((await preflight.arrayBuffer()).byteLength, 0); assert.equal(prepared, 0);
  assert.ok(!(await fs.readdir(path.dirname(run))).some(name => name.startsWith('.world-export-')));
  const exported = await fetch(endpoint, { headers: x.headers(x.operator) }); assert.equal(exported.status, 200); assert.equal(prepared, 1); assert.match(exported.headers.get('content-disposition'), /Main\.mcworld/);
  const archive = path.join(x.dataDir, 'exported-world.mcworld'); await fs.writeFile(archive, Buffer.from(await exported.arrayBuffer())); const unpacked = path.join(x.dataDir, 'unpacked-world'); await extractZip(archive, unpacked);
  assert.deepEqual(await fingerprints(unpacked), await fingerprints(path.join(run, 'worlds', 'Main')));
  assert.equal(await fs.stat(path.join(unpacked, 'keys')).catch(() => null), null); assert.equal(await fs.stat(path.join(unpacked, 'server.properties')).catch(() => null), null);
  for (let attempt = 0; attempt < 100 && (await fs.readdir(path.dirname(run))).some(name => name.startsWith('.world-export-')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!(await fs.readdir(path.dirname(run))).some(name => name.startsWith('.world-export-'))); assert.deepEqual(await fingerprints(run), original);
  const importArchive = path.join(x.dataDir, 'upload.mcworld'); await zipDirectory(path.join(run, 'worlds', 'Main'), importArchive, { includeEmptyDirectories: true });
  const multipart = new FormData(); multipart.append('name', 'Imported via HTTP'); multipart.append('file', new Blob([await fs.readFile(importArchive)]), 'real-fixture.mcworld');
  const uploadHeaders = x.headers(x.operator); delete uploadHeaders['Content-Type'];
  const imported = await fetch(x.origin + '/api' + base + '/worlds/import', { method: 'POST', headers: uploadHeaders, body: multipart }); assert.equal(imported.status, 202); const importedResult = await imported.json(); await waitJob(x.runtime.manager, importedResult.job.id);
  assert.equal((await x.runtime.manager.properties(x.first.id))['level-name'], 'Main'); assert.deepEqual(await fingerprints(path.join(run, 'worlds', 'Imported via HTTP')), await fingerprints(path.join(run, 'worlds', 'Main')));
  assert.equal((await x.request(x.operator, base + '/worlds/select', { name: 'Imported via HTTP' })).status, 200);
  assert.equal((await x.request(x.operator, base + '/worlds/create', { name: 'Pending through HTTP', seed: '64-bit exact -9223372036854775808' })).status, 201);
  assert.equal(await fs.stat(path.join(run, 'worlds', 'Pending through HTTP')).catch(() => null), null);
  assert.equal((await x.request(x.operator, base + '/worlds/Imported%20via%20HTTP', { name: 'Imported via HTTP' }, 'DELETE')).status, 200);
  assert.ok(x.runtime.manager.activity().some(event => event.action === 'world.import' && event.user === 'worldoperator'));
});

test('interrupted .mcworld downloads remove prepared private exports and preserve world bytes', async t => {
  const x = await fixture(t), run = path.join(x.dataDir, 'servers', x.first.id, 'run');
  await fs.writeFile(path.join(run, 'worlds', 'Main', 'payload.bin'), randomBytes(2 * 1024 ** 2)); const original = await fingerprints(run);
  const response = await fetch(x.origin + `/api/servers/${x.first.id}/worlds/Main/export`, { headers: x.headers(x.operator) }); assert.equal(response.status, 200);
  await response.body.cancel();
  for (let attempt = 0; attempt < 100 && (await fs.readdir(path.dirname(run))).some(name => name.startsWith('.world-export-')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!(await fs.readdir(path.dirname(run))).some(name => name.startsWith('.world-export-'))); assert.deepEqual(await fingerprints(run), original); assert.equal(x.runtime.manager.getServer(x.first.id).busy, false);
});

test('Viewer identity privacy protects GET/HEAD reads and downloads while retaining ordinary files and own manager access', async t => {
  const x = await fixture(t), base = `/servers/${x.first.id}`, other = `/servers/${x.second.id}`, run = path.join(x.dataDir, 'servers', x.first.id, 'run');
  const identityFiles = ['server_identity_key.pem', 'nested/Server_Identity_Key.PEM', 'nested/keys/other.txt', 'nested/Keys/alternate.pem'];
  const ordinaryFiles = ['notes.txt', 'keys-backup/normal.txt', 'metadata/server_identity_key.pem.txt', 'mykeys/readme.txt'];
  for (const relative of [...identityFiles, ...ordinaryFiles]) {
    const file = path.join(run, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'Inert HTTP privacy fixture; not a usable key or private production data.');
  }
  const before = await fingerprints(run);
  let reads = 0, downloads = 0; const readFile = x.runtime.manager.readFile, downloadFile = x.runtime.manager.downloadFile;
  x.runtime.manager.readFile = (...args) => { reads++; return readFile(...args); };
  x.runtime.manager.downloadFile = (...args) => { downloads++; return downloadFile(...args); };
  for (const relative of ['keys/server_identity_key.pem', 'keys//server_identity_key.pem', ...identityFiles]) {
    for (const operation of ['file', 'files/download']) for (const method of ['GET', 'HEAD']) {
      const endpoint = `${base}/${operation}?path=${encodeURIComponent(relative)}`;
      const denied = await fetch(x.origin + '/api' + endpoint, { method, headers: x.headers(x.viewer) }); assert.equal(denied.status, 403, method + ' ' + endpoint);
      if (method === 'GET') { const body = await denied.json(); assert.equal(body.error, 'Đọc hoặc tải identity của server cần quyền quản lý server.'); assert.equal(Object.hasOwn(body, 'content'), false); }
      else assert.equal((await denied.arrayBuffer()).byteLength, 0);
    }
  }
  assert.equal(reads, 0); assert.equal(downloads, 0); // Denial precedes reading bytes.
  for (const relative of ['keys/../notes.txt', '../keys/server_identity_key.pem', 'keys\\server_identity_key.pem', '/keys/server_identity_key.pem']) {
    const denied = await fetch(x.origin + '/api' + base + '/file?path=' + encodeURIComponent(relative), { headers: x.headers(x.viewer) }); assert.equal(denied.status, 400); await denied.arrayBuffer();
  }
  assert.equal(reads, 0); assert.equal(downloads, 0);
  for (const relative of ordinaryFiles) for (const operation of ['file', 'files/download']) {
    const response = await fetch(x.origin + '/api' + base + `/${operation}?path=` + encodeURIComponent(relative), { headers: x.headers(x.viewer) }); assert.equal(response.status, 200); await response.arrayBuffer();
  }
  for (const actor of [x.operator, x.admin]) for (const operation of ['file', 'files/download']) for (const method of ['GET', 'HEAD']) {
    const allowed = await fetch(x.origin + '/api' + base + `/${operation}?path=keys%2F%2Fserver_identity_key.pem`, { method, headers: x.headers(actor) }); assert.equal(allowed.status, 200); await allowed.arrayBuffer();
  }
  for (const operation of ['file', 'files/download']) for (const method of ['GET', 'HEAD']) {
    const denied = await fetch(x.origin + '/api' + other + `/${operation}?path=keys%2Fserver_identity_key.pem`, { method, headers: x.headers(x.operator) }); assert.equal(denied.status, 403); await denied.arrayBuffer();
  }
  for (const language of ['en', 'vi']) {
    const expected = language === 'en' ? 'Reading or downloading the server identity requires server management permission.' : 'Đọc hoặc tải identity của server cần quyền quản lý server.';
    const headers = { ...x.headers(x.viewer), 'Accept-Language': language };
    const listing = await fetch(x.origin + '/api' + base + '/files?path=keys', { headers }); assert.equal(listing.status, 200); const data = await listing.json();
    const key = data.files.find(file => file.name === 'server_identity_key.pem'); assert.ok(key); assert.equal(key.path, 'keys/server_identity_key.pem');
    assert.equal(key.capabilities.read, false); assert.equal(key.capabilities.download, false); assert.equal(key.protected, true); assert.equal(key.protection, expected); assert.equal(key.protectionI18n[language], expected);
    const denied = await fetch(x.origin + '/api' + base + '/file?path=keys%2Fserver_identity_key.pem', { headers }); assert.equal(denied.status, 403); const body = await denied.json(); assert.equal(body.error, expected); assert.equal(body.errorI18n[language], expected);
  }
  const managerListing = await x.request(x.operator, base + '/files?path=keys', undefined, 'GET'); assert.equal(managerListing.status, 200); assert.equal(managerListing.data.files[0].capabilities.read, true); assert.equal(managerListing.data.files[0].capabilities.download, true);
  assert.deepEqual(await fingerprints(run), before);
});

test('scoped activity survives duplicate names/rename, filters before limit and never leaks global history', async t => {
  const x = await fixture(t), base = `/servers/${x.first.id}`, other = `/servers/${x.second.id}`;
  const created = await x.request(x.operator, base + '/worlds/create', { name: 'Exact activity world', seed: '9223372036854775807' });
  assert.equal(created.status, 201);
  assert.equal((await x.request(x.operator, base, { name: 'Renamed server' }, 'PATCH')).status, 200);
  const schedule = x.runtime.manager.withActor({ username: 'worldoperator' }, () => x.runtime.manager.createSchedule({ serverId: x.first.id, action: 'backup', intervalMinutes: 60, enabled: false }));
  x.runtime.manager.updateSchedule(schedule.id, { intervalMinutes: 90 });
  x.runtime.manager.deleteSchedule(schedule.id);
  const backup = await x.runtime.manager.withActor({ username: 'worldoperator' }, () => x.runtime.manager.backup(x.first.id));
  await waitJob(x.runtime.manager, backup.id);
  const backupId = x.runtime.manager.backups(x.first.id)[0].id;
  await x.runtime.manager.setBackupLocked(x.first.id, backupId, { locked: true });
  const own = x.runtime.manager.serverActivity(x.first.id);
  for (const action of ['world.create', 'server.settings', 'schedule.create', 'schedule.update', 'schedule.delete', 'backup.create', 'backup.complete', 'backup.lock']) assert.ok(own.some(event => event.action === action), action);
  assert.ok(own.every(event => event.serverId === x.first.id));
  x.runtime.store.data.activity = [
    ...Array.from({ length: 110 }, (_, index) => ({ id: `other-${index}`, serverId: x.second.id, action: 'server.command', detail: 'Renamed server secret from other server' })),
    { id: 'legacy', action: 'server.command', detail: 'Renamed server without ID' },
    { id: 'auth', action: 'auth.login', detail: 'Signed in', user: 'global-private-name' },
    ...own,
  ];
  x.runtime.store.save();
  for (const actor of [x.viewer, x.operator, x.admin]) {
    const response = await x.request(actor, base + '/activity', undefined, 'GET');
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.activity.map(event => event.id), own.map(event => event.id));
  }
  assert.equal((await x.request(x.operator, other + '/activity', undefined, 'GET')).status, 403);
  assert.equal((await x.request(x.viewer, '/activity', undefined, 'GET')).status, 403);
  assert.equal((await x.request(x.admin, '/activity', undefined, 'GET')).status, 200);
});
