import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { createApp } from '../server/index.js';
import { createNodeAgent } from '../server/node-agent.js';
import { createStore } from '../server/store.js';
import { serializeProperties, defaultUdpPorts } from '../server/safety.js';
import { writeWorld } from './worlds-fixture.js';
import { listenFetchSafeHttp } from './http-listen-fixture.js';

export const COLLISION_ID = '882cb810-f816-450e-8758-fca7b744ec9b';
export const SECOND_ID = '56ec7d17-06fc-4c7e-86d4-b1619a7eab32';
export const PASSWORD = 'nodes080-fixture-password-only';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually(callback, { timeout = 6000, interval = 25 } = {}) {
  const until = Date.now() + timeout; let last;
  do { try { return await callback(); } catch (error) { last = error; } await pause(interval); } while (Date.now() < until);
  throw last || new Error('Timed out waiting for isolated federation state');
}

async function seed(dataDir, name, port, { demo = false, secondary = true } = {}) {
  const store = createStore(dataDir);
  if (store.data.servers.length) return store;
  store.data.versions = [{ version: '1.26.52.3', channel: 'stable', transport: 'nethernet', available: true, url: null, cached: false, simulated: demo }];
  store.data.settings.latestVersion = '1.26.52.3';
  for (const [index, id] of [COLLISION_ID, ...(secondary ? [SECOND_ID] : [])].entries()) {
    const server = { id, name: `${name} ${index + 1}`, status: 'stopped', version: '1.26.52.3', channel: 'stable', port: port + index * 100, portV6: port + index * 100 + 1, transport: 'nethernet', maxPlayers: 10, autoStart: false, autoRestart: false, backupRetention: 3, messageLanguage: 'en', worldVoiceEnabled: false, resourcePolicy: { mode: 'shared', cpuCores: null, memoryMiB: null }, backups: [], runtimeFiles: ['bedrock_server'], createdAt: new Date().toISOString() };
    server.udpPorts = defaultUdpPorts(server.port, server.maxPlayers);
    const properties = serializeProperties({ 'server-name': server.name, 'server-port': server.port, 'server-portv6': server.portV6, transport: server.transport, 'server-udp-ports': server.udpPorts, 'max-players': server.maxPlayers, 'enable-lan-visibility': false, 'level-name': 'Main', 'level-seed': '', 'online-mode': true, 'allow-list': false, 'allow-cheats': false, gamemode: 'survival', difficulty: 'peaceful', 'view-distance': 16, 'tick-distance': 4, 'max-threads': 0 });
    server.demoFiles = { 'server.properties': properties, 'allowlist.json': '[]\n', 'permissions.json': '[]\n', 'config/readme.txt': `${name} original\n`, 'keys/server_identity_key.pem': `Inert ${name} identity fixture; no real key.`, 'worlds/Main/levelname.txt': 'Main\n' };
    store.data.servers.push(server);
    const run = path.join(dataDir, 'servers', id, 'run');
    await fs.mkdir(path.join(run, 'config'), { recursive: true });
    await fs.mkdir(path.join(run, 'keys'), { recursive: true });
    for (const [relative, content] of Object.entries(server.demoFiles)) {
      const target = path.join(run, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content, { mode: 0o600 });
    }
    await fs.writeFile(path.join(run, 'bedrock_server'), 'INERT TEST FIXTURE. MUST NEVER EXECUTE.\n', { mode: 0o600 });
    await writeWorld(path.join(run, 'worlds', 'Main'), 'Main');
  }
  store.save(); return store;
}

export async function federationFixture(t, { demoAgents = false, link = true, hostnameControllers, powerControllers, nodeRemovalControllerFactory } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-nodes080-'));
  const realFetch = globalThis.fetch;
  // Catalog network is deliberately unavailable; every localhost HTTP request,
  // controller session, proxy stream and agent router remains real.
  const networkMock = t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return ['127.0.0.1', '[::1]'].includes(url.hostname) ? realFetch(input, options) : Promise.reject(new Error('External catalog disabled in isolated federation fixture'));
  });
  const agents = [];
  const f = { root, agents, central: null, base: null, admin: null, demoAgents, request, restartCentral, restartAgent, createUser, linkAgent, runPath: (index, id = COLLISION_ID) => path.join(agents[index].dataDir, 'servers', id, 'run') };
  t.after(async () => {
    try { await f.central?.close(); await Promise.allSettled(agents.map(agent => agent.runtime?.close())); }
    finally {
      networkMock.mock.restore();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('vortex-nodes080-'));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  for (const [index, name] of ['Agent-A', 'Agent-B'].entries()) {
    const dataDir = path.join(root, name); await fs.mkdir(dataDir, { mode: 0o700 });
    const store = await seed(dataDir, name, 39100, { demo: demoAgents });
    const agent = { dataDir, nodeId: randomUUID(), token: randomBytes(32).toString('base64url'), name, store, runtime: null, linked: null };
    agent.runtime = await createNodeAgent({ dataDir, nodeId: agent.nodeId, token: agent.token, demo: demoAgents, store, hostnameController: hostnameControllers?.agents?.[index], powerController: powerControllers?.agents?.[index] });
    await listenFetchSafeHttp(agent.runtime.server);
    agent.port = agent.runtime.server.address().port; agent.endpoint = `http://127.0.0.1:${agent.port}`; agents.push(agent);
  }
  await seed(path.join(root, 'controller'), 'Local-only', 39700, { secondary: false });
  f.central = await createApp({ dataDir: path.join(root, 'controller'), demo: false, setupToken: 'nodes080-isolated-setup', hostnameController: hostnameControllers?.central, powerController: powerControllers?.central, nodeRemovalControllerFactory });
  await listenFetchSafeHttp(f.central.server);
  f.base = `http://127.0.0.1:${f.central.server.address().port}`;
  const setup = await request('/auth/setup', { actor: null, body: { token: 'nodes080-isolated-setup', username: 'nodes-admin', password: PASSWORD } });
  assert.equal(setup.status, 200); f.admin = { cookie: setup.cookie, csrfToken: setup.data.csrfToken, user: setup.data.user };
  if (link) for (const agent of agents) await linkAgent(agent);
  f.remote = (index, rawId = COLLISION_ID) => `${agents[index].linked.id}:${rawId}`;
  return f;

  async function request(route, { actor = f.admin, body, method = body === undefined ? 'GET' : 'POST', headers = {}, raw = false, signal } = {}) {
    const response = await realFetch(f.base + '/api' + route, { method, redirect: 'manual', signal, headers: { Origin: f.base, ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(actor ? { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrfToken } : {}), ...headers }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
    if (raw) return response;
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  }
  async function createUser(username, { role = 'viewer', allServers = false, serverIds = [] } = {}) {
    const created = await request('/auth/users', { body: { username, password: PASSWORD, role, allServers, serverIds } }); assert.equal(created.status, 201);
    const login = await request('/auth/login', { actor: null, body: { username, password: PASSWORD } }); assert.equal(login.status, 200);
    return { cookie: login.cookie, csrfToken: login.data.csrfToken, user: login.data.user };
  }
  async function linkAgent(agent) {
    const linked = await request('/nodes', { body: { name: agent.name, endpoint: agent.endpoint, token: agent.token, fingerprint: null, publicAddress: 'node.example.test', location: 'Isolated test fixture' } });
    assert.equal(linked.status, 201); agent.linked = linked.data.node; return agent.linked;
  }
  async function restartCentral() {
    const port = new URL(f.base).port; await f.central.close();
    f.central = await createApp({ dataDir: path.join(root, 'controller'), demo: false, setupToken: 'not-reused-after-initialization', nodeRemovalControllerFactory });
    await listenFetchSafeHttp(f.central.server, Number(port));
    const login = await request('/auth/login', { actor: null, body: { username: 'nodes-admin', password: PASSWORD } }); assert.equal(login.status, 200);
    f.admin = { cookie: login.cookie, csrfToken: login.data.csrfToken, user: login.data.user };
    await Promise.all(agents.filter(agent => agent.linked).map(agent => f.central.nodes.refresh(agent.linked.id, { force: true })));
  }
  async function restartAgent(index) {
    const agent = agents[index]; await agent.runtime.close();
    agent.store = createStore(agent.dataDir);
    agent.runtime = await createNodeAgent({ dataDir: agent.dataDir, nodeId: agent.nodeId, token: agent.token, demo: demoAgents, store: agent.store });
    await listenFetchSafeHttp(agent.runtime.server, agent.port);
    return agent;
  }
}
