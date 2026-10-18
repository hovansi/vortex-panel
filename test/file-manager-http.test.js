import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.js';
import { extractZip } from '../server/archives.js';

test('authenticated file tools enforce server scope, viewer rights, revisions and real ZIP download/extraction', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-files-http-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith('https:') ? Promise.reject(Error('Isolated file test has no external catalog')) : originalFetch(url, options);
  const runtime = await createApp({ dataDir, demo: false, setupToken: 'file-tools-isolated-setup-token' });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); globalThis.fetch = originalFetch; await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  for (const [index, name] of ['Files one', 'Files two'].entries()) {
    const server = { id: randomUUID(), name, status: 'stopped', version: '1.20.0.01', channel: 'stable', port: 31000 + index * 100, portV6: 31001 + index * 100, transport: 'raknet', maxPlayers: 10, runtimeFiles: ['bedrock_server'], backups: [] };
    runtime.store.data.servers.push(server);
    const run = path.join(dataDir, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true });
    await fs.writeFile(path.join(run, 'server.properties'), 'level-name=Main\ntransport=raknet\nenable-lan-visibility=false\n');
    await fs.writeFile(path.join(run, 'bedrock_server'), 'Inert text fixture. Never executed.');
  }
  const [first, second] = runtime.store.data.servers;
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'file-tools-isolated-setup-token', username: 'fileadmin', password: 'vortex-file-test-password' }) });
  assert.equal(setup.status, 200); const auth = await setup.json();
  const admin = { cookie: setup.headers.get('set-cookie').split(';')[0], csrf: auth.csrfToken };
  const headers = actor => ({ Cookie: actor.cookie, Origin: origin, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json' });
  const request = async (actor, route, body, method = 'POST') => {
    const response = await fetch(origin + '/api' + route, { method, headers: headers(actor), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const actor = async (username, role) => {
    assert.equal((await request(admin, '/auth/users', { username, password: 'vortex-file-test-password', role, serverIds: [first.id], allServers: false })).status, 201);
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'vortex-file-test-password' }) });
    assert.equal(login.status, 200); const data = await login.json(); return { cookie: login.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
  };
  const operator = await actor('fileoperator', 'operator'), viewer = await actor('fileviewer', 'viewer');
  const routes = {
    create: { path: 'denied.txt', content: 'denied' }, copy: { sources: ['notes.txt'], destination: 'copy' }, move: { sources: ['notes.txt'], destination: 'copy' },
    rename: { source: 'notes.txt', destination: 'changed.txt' }, compress: { sources: ['notes.txt'], destination: 'bundle.zip' }, extract: { source: 'bundle.zip', destination: 'unpacked' }
  };
  for (const [tool, body] of Object.entries(routes)) {
    assert.equal((await request(viewer, `/servers/${first.id}/files/${tool}`, body)).status, 403, tool + ': viewer');
    assert.equal((await request(operator, `/servers/${second.id}/files/${tool}`, body)).status, 403, tool + ': server scope');
  }
  const base = `/servers/${first.id}`;
  assert.equal((await request(operator, base + '/files/create', { path: 'notes.txt', content: 'Original notes' })).status, 201);
  const initial = (await request(operator, base + '/file?path=notes.txt', undefined, 'GET')).data;
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal((await request(operator, base + '/file', { path: 'notes.txt', content: 'Unversioned' }, 'PUT')).status, 428);
  const saved = await request(operator, base + '/file', { path: 'notes.txt', content: 'Current notes', revision: initial.revision }, 'PUT'); assert.equal(saved.status, 200);
  assert.equal((await request(operator, base + '/file', { path: 'notes.txt', content: 'Stale editor', revision: initial.revision }, 'PUT')).status, 409);
  assert.equal((await request(operator, base + '/files/create', { path: 'deleted.txt', content: 'Read before deletion' })).status, 201);
  const deleted = (await request(operator, base + '/file?path=deleted.txt', undefined, 'GET')).data;
  assert.equal((await request(operator, base + '/file?path=deleted.txt', undefined, 'DELETE')).status, 200);
  assert.equal((await request(operator, base + '/file', { path: 'deleted.txt', content: 'Stale recreation', revision: deleted.revision }, 'PUT')).status, 404);
  assert.equal((await request(operator, base + '/file', { path: 'missing.txt', content: 'Unversioned creation' }, 'PUT')).status, 404);
  assert.equal((await request(operator, base + '/file?path=deleted.txt', undefined, 'GET')).status, 404);
  assert.equal((await request(operator, base + '/files/create', { path: 'notes.txt', content: 'Overwrite' })).status, 409);
  assert.equal((await request(operator, base + '/files/mkdir', { path: 'copied' })).status, 200);
  assert.equal((await request(operator, base + '/files/copy', { sources: ['notes.txt'], destination: 'copied' })).status, 200);
  assert.equal((await request(operator, base + '/files/rename', { source: 'copied/notes.txt', destination: 'copied/renamed.txt' })).status, 200);
  assert.equal((await request(operator, base + '/files/compress', { sources: ['copied'], destination: 'bundle.zip' })).status, 200);
  const endpoint = origin + '/api' + base + '/files/download?path=bundle.zip';
  const preflight = await fetch(endpoint, { method: 'HEAD', headers: headers(operator) }); assert.equal(preflight.status, 200); assert.ok(Number(preflight.headers.get('content-length')) > 0); assert.equal((await preflight.arrayBuffer()).byteLength, 0);
  const download = await fetch(endpoint, { headers: headers(operator) }); assert.equal(download.status, 200);
  const zip = path.join(dataDir, 'downloaded-fixture.zip'); await fs.writeFile(zip, Buffer.from(await download.arrayBuffer()));
  await extractZip(zip, path.join(dataDir, 'verified-download'));
  assert.equal(await fs.readFile(path.join(dataDir, 'verified-download/copied/renamed.txt'), 'utf8'), 'Current notes');
  assert.equal((await request(operator, base + '/files/extract', { source: 'bundle.zip', destination: 'unpacked' })).status, 200);
  assert.equal((await request(operator, base + '/file?path=unpacked/copied/renamed.txt', undefined, 'GET')).data.content, 'Current notes');
  assert.equal((await request(operator, base + '/files/extract', { source: 'bundle.zip', destination: 'unpacked' })).status, 409);
  assert.ok(runtime.manager.activity().some(item => item.action === 'file.compress' && item.user === 'fileoperator'));

  // The decoded text quota is independent of JSON's transport overhead and
  // escapes. Keep the allowance confined to create/editor HTTP endpoints.
  const textLimit = 2 * 1024 ** 2;
  const exactAscii = 'a'.repeat(textLimit);
  const largeCreated = await request(operator, base + '/files/create', { path: 'exact-limit.txt', content: exactAscii });
  assert.equal(largeCreated.status, 201); assert.equal((await fs.readFile(path.join(dataDir, 'servers', first.id, 'run/exact-limit.txt'))).byteLength, textLimit);
  const escapedNewlines = '\n'.repeat(1024 ** 2);
  const escapedSaved = await request(operator, base + '/file', { path: 'exact-limit.txt', content: escapedNewlines, revision: largeCreated.data.revision }, 'PUT');
  assert.equal(escapedSaved.status, 200); assert.equal(await fs.readFile(path.join(dataDir, 'servers', first.id, 'run/exact-limit.txt'), 'utf8'), escapedNewlines);
  const worstEscapes = '\u0001'.repeat(textLimit);
  assert.equal((await request(operator, base + '/files/create', { path: 'escaped-limit.txt', content: worstEscapes })).status, 201);
  assert.equal((await fs.readFile(path.join(dataDir, 'servers', first.id, 'run/escaped-limit.txt'))).byteLength, textLimit);
  const oversized = 'a'.repeat(textLimit + 1);
  const rejectedCreate = await request(operator, base + '/files/create', { path: 'too-large.txt', content: oversized });
  assert.equal(rejectedCreate.status, 400); assert.match(rejectedCreate.data.error, /2 MiB/);
  const rejectedEdit = await request(operator, base + '/file', { path: 'exact-limit.txt', content: oversized, revision: escapedSaved.data.revision }, 'PUT');
  assert.equal(rejectedEdit.status, 400); assert.match(rejectedEdit.data.error, /2 MiB/);
  assert.equal(await fs.readFile(path.join(dataDir, 'servers', first.id, 'run/exact-limit.txt'), 'utf8'), escapedNewlines);
  assert.equal(await fs.stat(path.join(dataDir, 'servers', first.id, 'run/too-large.txt')).catch(() => null), null);
  assert.equal((await request(operator, base + '/command', { command: oversized })).status, 413);
});
