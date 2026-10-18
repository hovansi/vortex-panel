import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import ssh2 from 'ssh2';
import { createApp } from '../server/index.js';
import { createNodeProvisioner } from '../server/node-provisioner.js';
const { Server: SSHServer, Client, utils } = ssh2;

// This is a real loopback SSH protocol peer. Shell commands are NOT executed:
// Ubuntu preflight output below is a synthetic response fixture.
export async function provisioningHttpFixture(t, { compatible = false, holdPreflight = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-nodes080-ssh-'));
  const password = 'SSH-fixture-only-' + randomUUID(), panelPassword = 'isolated-controller-password-080';
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(privateKey).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set(), ssh = { connectionsSeen: 0, authAttempts: [], commands: [], compatible, holdPreflight, heldChannels: [] };
  const peer = new SSHServer({ hostKeys: [privateKey] }, client => {
    clients.add(client); ssh.connectionsSeen++;
    client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      ssh.authAttempts.push({ method: context.method, username: context.username });
      if (context.method === 'password' && context.username === 'root' && context.password === password) context.accept();
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec(); ssh.commands.push(info.command);
        if (ssh.holdPreflight) { ssh.heldChannels.push(channel); return; }
        if (info.command.includes('VORTEX_PREFLIGHT_V1')) {
          channel.stderr.write(`Untrusted remote diagnostic must never be exposed: ${password}\n`);
          channel.write(`VORTEX_PREFLIGHT_V1\nuid=0\nos=ubuntu\nversion=${ssh.compatible ? '24.04' : '20.04'}\narch=x86_64\ndisk=4294967296\nmemory=2147483648\nsystemd=1\nexisting=0\n`);
          channel.exit(0); channel.end(); return;
        }
        channel.stderr.write(`Unexpected fixture command ${password}`); channel.exit(1); channel.end();
      });
    }));
  });
  peer.on('error', () => {});
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  const realFetch = globalThis.fetch;
  const networkMock = t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return ['127.0.0.1', '[::1]'].includes(url.hostname) ? realFetch(input, options) : Promise.reject(new Error('External catalog disabled in SSH HTTP fixture'));
  });
  const f = { root, password, fingerprint, ssh, peer, control: null, origin: null, admin: null, clientCreations: 0, request, startController, makeUser, input: extra => ({ host: '127.0.0.1', port: peer.address().port, username: 'root', password, hostFingerprint: fingerprint, ...extra }) };
  t.after(async () => {
    try {
      await f.control?.close(); for (const client of clients) client.destroy();
      await new Promise(resolve => peer.close(resolve));
    } finally {
      networkMock.mock.restore(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('vortex-nodes080-ssh-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  await startController(); return f;

  async function startController() {
    f.control = await createApp({ dataDir: root, demo: false, setupToken: 'ssh-http-isolated-setup', nodeProvisionerFactory: options => createNodeProvisioner({ ...options, sshClientFactory: () => { f.clientCreations++; return new Client(); }, connectTimeoutMs: 2500, commandTimeoutMs: 5000, pollIntervalMs: 20, installTimeoutMs: 5000 }) });
    await new Promise(resolve => f.control.server.listen(0, '127.0.0.1', resolve)); f.origin = `http://127.0.0.1:${f.control.server.address().port}`;
    const route = f.control.store.data.users.length ? '/auth/login' : '/auth/setup';
    const login = await request(route, { actor: null, body: { ...(route.endsWith('setup') ? { token: 'ssh-http-isolated-setup' } : {}), username: 'ssh-test-admin', password: panelPassword } }); assert.equal(login.status, 200);
    f.admin = { cookie: login.cookie, csrfToken: login.data.csrfToken, user: login.data.user };
  }
  async function request(route, { actor = f.admin, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await realFetch(f.origin + '/api' + route, { method, redirect: 'manual', headers: { Origin: f.origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function makeUser(username, role) {
    const result = await request('/auth/users', { body: { username, password: panelPassword, role, allServers: true } }); assert.equal(result.status, 201);
    const login = await request('/auth/login', { actor: null, body: { username, password: panelPassword } }); assert.equal(login.status, 200);
    return { cookie: login.cookie, csrfToken: login.data.csrfToken, user: login.data.user };
  }
}
