import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createStore } from './store.js';
import { createManager } from './manager.js';
import { restoreFleetRemovalIntent } from './panel-removal.js';
import { createRouter } from './routes.js';
import { acquireDataLock } from './lock.js';
import { localeMiddleware } from './locale.js';
import { createResourceController } from './resource-control.js';
import { canAccessServer, requireAdmin } from './access.js';
import { serverFirewallErrorPayload } from './server-firewall.js';
import { capacityErrorPayload } from './capacity.js';
import { storageErrorPayload } from './storage-volumes.js';
import { applicationErrorPayload } from './application-runtime.js';
import { createHostnameController, changeHostname, hostnameErrorPayload } from './hostname.js';
import { createSystemPowerController, sendPowerRequest, systemPowerErrorPayload } from './system-power.js';
import { createHostZramController, sendZramRequest, hostZramErrorPayload } from './host-zram.js';
import { createNodeRemovalAgent, nodeRemovalErrorPayload } from './node-removal.js';
import { playerListErrorPayload } from './player-lists.js';

const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const serviceActor = Object.freeze({ id: 'vortex-control-plane', username: 'node-control-plane', role: 'admin', allServers: true, serverIds: [] });
export function validateNodeDataDir(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Node dataDir must be absolute.');
  const directory = path.resolve(value), panels = ['/var/lib/vortex-panel', '/var/lib/bedrock-panel'].map(value => path.resolve(value));
  const compared = text => process.platform === 'win32' ? text.toLowerCase() : text;
  const a = compared(directory);
  if (panels.some(panel => { const b = compared(panel); return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); })) throw new Error('Node data must not overlap panel data.');
  if (process.platform !== 'win32' && (/^\/(?:etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|run)(?:\/|$)/.test(directory) || ['/', '/var', '/var/lib', '/var/backups', '/opt', '/home', '/root', '/tmp', '/var/tmp'].includes(directory))) throw new Error('Use a dedicated node data directory outside system roots.');
  let current = directory;
  while (true) { try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Node data ancestors must not be symlinks.'); } catch (error) { if (error.code !== 'ENOENT') throw error; } const parent = path.dirname(current); if (parent === current) break; current = parent; }
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || process.platform !== 'win32' && (stat.mode & 0o022)) throw new Error('Node data must be a real directory not writable by group/other.');
    if (fs.readdirSync(directory).length && !fs.existsSync(path.join(directory, 'panel.json'))) throw new Error('Existing node data must be empty or contain its own panel.json store.');
  }
  return directory;
}
function actorFromHeader(header) {
  if (header === undefined) return serviceActor;
  if (typeof header !== 'string' || header.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(header)) throw Object.assign(new Error('Invalid forwarded actor.'), { status: 400 });
  let actor;
  try { actor = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')); } catch { throw Object.assign(new Error('Invalid forwarded actor.'), { status: 400 }); }
  if (!actor || typeof actor !== 'object' || Array.isArray(actor) || Object.keys(actor).some(key => !['id', 'username', 'role', 'allServers', 'serverIds'].includes(key)) || typeof actor.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.id) || typeof actor.username !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(actor.username) || !['admin', 'operator', 'viewer'].includes(actor.role) || typeof actor.allServers !== 'boolean' || !Array.isArray(actor.serverIds) || actor.serverIds.length > 1000 || actor.serverIds.some(id => typeof id !== 'string' || !uuid.test(id))) throw Object.assign(new Error('Invalid forwarded actor.'), { status: 400 });
  return { ...actor, serverIds: [...new Set(actor.serverIds)] };
}

export async function createNodeAgent({ dataDir, nodeId, token, tls, host = '127.0.0.1', configFile = process.env.VORTEX_NODE_CONFIG || '/etc/vortex-node.json', manager: injectedManager, store: injectedStore, resourceController, hostnameController, powerController, zramController, removalController, emit: observer = () => {} } = {}) {
  if (!uuid.test(nodeId || '') || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new Error('A UUID nodeId and strong node token are required.');
  if (!tls && !['127.0.0.1', '::1', '[::1]'].includes(host)) throw new Error('Public node listeners require HTTPS. HTTP is limited to literal loopback.');
  if (tls && (!tls.cert || !tls.key)) throw new Error('Both TLS certificate and key are required.');
  dataDir = validateNodeDataDir(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('Node dataDir must not be a symlink.');
  const releaseLock = injectedManager ? () => {} : acquireDataLock(dataDir);
  let manager, store, closing = false, closePromise;
  const clients = new Set();
  const expectedToken = createHash('sha256').update(token).digest();
  const app = express(); app.disable('x-powered-by');
  const systemHostname = hostnameController || createHostnameController();
  const identity = () => ({ service: 'vortex-node', protocol: 1, nodeId, version, processId: process.pid });
  const send = (client, event) => {
    if (client.res.destroyed || client.res.writableLength > 1024 ** 2) { client.res.destroy(); clients.delete(client); return; }
    if (event.serverId && !canAccessServer(client.actor, event.serverId)) return;
    if (!event.serverId && client.actor.role !== 'admin' && event.type !== 'update') return;
    let json;
    try { json = JSON.stringify(event); } catch { return; }
    if (Buffer.byteLength(json) > 64 * 1024) json = JSON.stringify({ type: 'update' });
    const frame = `data: ${json}\n\n`;
    if (client.res.writableLength + Buffer.byteLength(frame) + 16 > 1024 ** 2) { client.res.destroy(); clients.delete(client); return; }
    client.res.write(frame);
  };
  const emit = event => { for (const client of clients) send(client, event); observer(event); };
  try {
    store = injectedStore || createStore(dataDir);
    if (!injectedStore && store.data.users.length) throw new Error('Node data must not contain panel user accounts. Use a dedicated node data directory.');
    manager = injectedManager || await createManager({ store, dataDir, emit, reserveRatio: 0, resourceController: resourceController || createResourceController({ unit: process.env.VORTEX_NODE_UNIT || 'vortex-node.service', reserveRatio: 0 }) });
    manager.setMaintenanceProbe?.(() => restoreFleetRemovalIntent({ manager, dataDir, role: 'worker', nodeId: nodeId, store }));
    restoreFleetRemovalIntent({ manager, dataDir, role: 'worker', nodeId, store });
    await manager.initialize?.();
  } catch (error) { await manager?.close?.(); releaseLock(); throw error; }
  const systemPower = powerController || createSystemPowerController({ role: 'worker', nodeId, dataDir, store, manager });
  let systemZram, removalAgent;
  try {
    const powerInfo = await systemPower.read();
    systemZram = zramController || createHostZramController({ role: 'worker', nodeId, dataDir, store, manager });
    await systemZram.read();
    removalAgent = removalController || createNodeRemovalAgent({ nodeId, dataDir, configFile, manager, instanceId: powerInfo.instanceId });
    await removalAgent.initialize?.();
  }
  catch (error) { await removalAgent?.close?.(); await systemZram?.close?.(); await systemPower.close?.(); await manager.close?.(); releaseLock(); throw error; }
  app.use(localeMiddleware);
  app.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); next(); });
  app.use('/api', (req, res, next) => {
    res.set('X-Vortex-Node-Id', nodeId);
    const header = req.headers.authorization;
    const provided = typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{1,256}$/.test(header) ? header.slice(7) : '';
    if (!timingSafeEqual(expectedToken, createHash('sha256').update(provided).digest())) return res.status(401).json({ error: 'Node authentication required.' });
    if (closing && !['GET', 'HEAD'].includes(req.method)) return res.status(503).json({ error: 'Node is stopping.' });
    try {
      req.session = { user: actorFromHeader(req.headers['x-vortex-actor']) };
      if (req.session.user.role === 'admin' && req.headers['x-vortex-file-access']) {
        const grant = JSON.parse(req.headers['x-vortex-file-access']);
        if (typeof grant.serverId === 'string' && Number.isFinite(grant.expires) && grant.expires > Date.now() && grant.expires <= Date.now() + 10 * 60 * 1000) req.fileAccess = grant;
      }
      next();
    } catch (error) { next(error); }
  });
  const ordinaryJson = express.json({ limit: '2mb' }), editorJson = express.json({ limit: '13mb' });
  app.use('/api', (req, res, next) => (req.method === 'PUT' && /^\/servers\/[^/]+\/file\/?$/i.test(req.path) || req.method === 'POST' && /^\/servers\/[^/]+\/files\/create\/?$/i.test(req.path) ? editorJson : ordinaryJson)(req, res, next));
  app.use('/api', (req, _res, next) => {
    const dedicatedControl = ['/node/power', '/node/zram', '/node/uninstall/prepare', '/node/uninstall/abort'].includes(req.path);
    const maintenance = manager.maintenanceStatus?.();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !dedicatedControl && maintenance?.active) return next(Object.assign(new Error(['zram', 'uninstall'].includes(maintenance.action) ? 'Đang áp dụng thay đổi hệ thống. Hãy chờ hoàn tất.' : 'A restart is pending.'), { ...(maintenance.action === 'restart-service' || maintenance.action === 'reboot' ? { code: 'POWER_BUSY' } : {}), status: 409 }));
    next();
  });
  app.get('/api/node/identity', (_req, res) => res.json(identity()));
  app.get('/api/node/power', requireAdmin, async (_req, res) => res.json({ nodeId, power: await systemPower.read() }));
  app.post('/api/node/power', requireAdmin, async (req, res) => sendPowerRequest(systemPower, req, res, nodeId));
  app.get('/api/node/zram', requireAdmin, async (_req, res) => res.json({ nodeId, zram: await systemZram.read() }));
  app.post('/api/node/zram', requireAdmin, async (req, res) => sendZramRequest(systemZram, req, res, nodeId));
  app.get('/api/node/uninstall/plan', requireAdmin, async (_req, res) => res.json({ nodeId, plan: await removalAgent.plan() }));
  app.post('/api/node/uninstall/prepare', requireAdmin, async (req, res) => res.json(await removalAgent.prepare(req.body)));
  app.post('/api/node/uninstall/abort', requireAdmin, async (req, res) => res.json(await removalAgent.abort(req.body)));
  app.get('/api/node/hostname', requireAdmin, async (_req, res) => res.json({ nodeId, hostname: await systemHostname.read() }));
  app.patch('/api/node/hostname', requireAdmin, async (req, res) => {
    const result = await changeHostname(systemHostname, req.body, { store, user: req.session.user, nodeId });
    emit({ type: 'update' }); res.json({ ...result, nodeId });
  });
  app.get('/api/node/snapshot', async (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Node inventory requires a control-plane administrator.' });
    const dashboard = await manager.dashboard();
    res.json({ ...dashboard, capabilities: { ...dashboard.capabilities, hostTerminal: false }, schedules: manager.schedules(), ...identity() });
  });
  app.get('/api/node/events', (req, res) => {
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const client = { res, actor: req.session.user }; clients.add(client); send(client, { type: 'update' });
    const lease = setTimeout(() => res.end(), 5 * 60 * 1000); lease.unref();
    res.once('close', () => { clearTimeout(lease); clients.delete(client); });
  });
  // No host router, web assets, cookie login, setup, password or MFA API is
  // mounted. The bearer links a trusted control plane, never a browser session.
  app.use(['/api/auth', '/api/host', '/api/node'], (_req, res) => res.status(404).json({ error: 'API is not exposed by the node agent.' }));
  const exposedManager = new Proxy(manager, { get(target, key) { if (key === 'dashboard') return async () => { const data = await target.dashboard(); return { ...data, capabilities: { ...data.capabilities, hostTerminal: false } }; }; return Reflect.get(target, key); } });
  app.use('/api', createRouter(exposedManager, { dataDir, store }));
  app.use((_req, res) => res.status(404).json({ error: 'Node API not found.' }));
  app.use((error, _req, res, _next) => {
    const status = error.status || error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (!res.headersSent) res.status(status).json(playerListErrorPayload(error, _req.panelLanguage) || applicationErrorPayload(error, _req.panelLanguage) || nodeRemovalErrorPayload(error, _req.panelLanguage) || hostZramErrorPayload(error, _req.panelLanguage) || systemPowerErrorPayload(error, _req.panelLanguage) || hostnameErrorPayload(error, _req.panelLanguage) || storageErrorPayload(error, _req.panelLanguage) || capacityErrorPayload(error, _req.panelLanguage) || serverFirewallErrorPayload(error, _req.panelLanguage) || { error: status >= 500 ? 'Node operation failed. Review the node service journal.' : error.message });
    else res.destroy();
  });
  let server;
  try { server = tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, app) : http.createServer(app); }
  catch (error) { try { await removalAgent.close?.(); await systemZram.close?.(); await systemPower.close?.(); await systemHostname.close?.(); await manager.close?.(); } finally { releaseLock(); } throw error; }
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    if (typeof args[0] === 'object' && args[0]) { args[0] = { ...args[0], host: args[0].host || host }; if (!tls && !['127.0.0.1', '::1'].includes(args[0].host)) throw new Error('HTTP node listeners must use literal loopback.'); }
    else { if (typeof args[1] !== 'string') args.splice(1, 0, host); if (!tls && !['127.0.0.1', '::1'].includes(args[1])) throw new Error('HTTP node listeners must use literal loopback.'); }
    return listen(...args);
  };
  server.requestTimeout = 5 * 60 * 1000; server.headersTimeout = 30000; server.maxHeadersCount = 64;
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); });
  const heartbeat = setInterval(() => { for (const client of clients) { if (client.res.writableLength + 32 > 1024 ** 2) client.res.destroy(); else client.res.write(': keepalive\n\n'); } }, 15000); heartbeat.unref();
  async function close() {
    if (closePromise) return closePromise;
    closing = true; clearInterval(heartbeat);
    for (const client of clients) client.res.end(); clients.clear();
    const listenerClosed = server.listening ? new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); server.closeAllConnections(); }) : Promise.resolve();
    closePromise = (async () => { try { await removalAgent.close?.(); await systemZram.close?.(); await systemPower.close?.(); await systemHostname.close?.(); await manager.close?.(); } finally { await listenerClosed; releaseLock(); } })();
    return closePromise;
  }
  return { app, server, manager, store, powerController: systemPower, zramController: systemZram, removalController: removalAgent, close, emit, host, identity: identity() };
}

// CLI lives separately so importing the agent never reads configuration,
// prints a credential or starts a listener.
export const nodeAgentModulePath = fileURLToPath(import.meta.url);
