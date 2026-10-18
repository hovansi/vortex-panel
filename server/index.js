import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import { createSystemPowerController, systemPowerErrorPayload } from './system-power.js';
import { createHostZramController, hostZramErrorPayload } from './host-zram.js';
import { createNodeRemovalController, nodeRemovalErrorPayload } from './node-removal.js';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createStore } from './store.js';
import { createAuth } from './auth.js';
import { createHostRouter } from './host.js';
import { createManager } from './manager.js';
import { createRouter } from './routes.js';
import { acquireDataLock } from './lock.js';
import { createSecretVault } from './mfa.js';
import { createNodes } from './nodes.js';
import { createNodeRouter, createRemoteServerProxy } from './node-routes.js';
import { nodeErrorPayload } from './node-messages.js';
import { createNodeProvisioner, nodeProvisionErrorPayload } from './node-provisioner.js';
import { serverFirewallErrorPayload } from './server-firewall.js';
import { capacityErrorPayload } from './capacity.js';
import { storageErrorPayload } from './storage-volumes.js';
import { applicationErrorPayload } from './application-runtime.js';
import { createHostnameController, hostnameErrorPayload } from './hostname.js';
import { playerListErrorPayload } from './player-lists.js';
import { localeMiddleware, requestLanguage, localizeWebSocketEvent, formatPanelMessage, translatePanelMessage } from './locale.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
export async function createApp({ dataDir = path.resolve(process.env.DATA_DIR || path.join(projectDir, 'data')), setupToken = process.env.SETUP_TOKEN, nodeProvisionerFactory = createNodeProvisioner, nodeRemovalControllerFactory = createNodeRemovalController, hostnameController, powerController, zramController } = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireDataLock(dataDir);
  let store;
  try { store = createStore(dataDir); } catch (error) { releaseLock(); throw error; }
  const app = express();
  let closing = false;
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use(localeMiddleware);
  app.use((req, res, next) => {
    if (closing && req.path.startsWith('/api') && !['GET', 'HEAD'].includes(req.method)) return res.status(503).json({ error: 'Panel đang dừng. Vui lòng thử lại sau.' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    next();
  });
  const ordinaryJson = express.json({ limit: '2mb' });
  // A valid 2 MiB text body can occupy 12 MiB in JSON (six-byte Unicode
  // escapes), plus the path/revision envelope. Only text editors need this
  // transport allowance; their validators still cap decoded UTF-8 at 2 MiB.
  const editorJson = express.json({ limit: '13mb' });
  app.use((req, res, next) => {
    const editor = req.method === 'PUT' && /^\/api\/servers\/[^/]+\/file\/?$/i.test(req.path);
    const create = req.method === 'POST' && /^\/api\/servers\/[^/]+\/files\/create\/?$/i.test(req.path);
    return (editor || create ? editorJson : ordinaryJson)(req, res, next);
  });
  let secretVault;
  try { secretVault = createSecretVault(dataDir); } catch (error) { releaseLock(); throw error; }
  let manager, nodes, provisioner, removal, systemPower, powerInfo, systemZram;
  const systemHostname = hostnameController || createHostnameController();
  const auth = createAuth({ store, secretVault, ...(setupToken ? { setupToken } : {}), publicUrl: process.env.PUBLIC_URL || '', serverExists: id => (manager?.listServers() || store.data.servers).some(server => server.id === id) });
  app.use('/api/auth', auth.router);
  const server = http.createServer(app);
  server.requestTimeout = 5 * 60 * 1000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const emit = event => {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const session = auth.readSession({ headers: { cookie: `bedrock.sid=${client.sessionId}` } });
      if (!session) { client.close(1008, formatPanelMessage('panel.ws.session.revoked')[client.panelLanguage || 'en']); continue; }
      if (event.serverId && !auth.canAccessServer(session.user, event.serverId)) continue;
      if (session.user.role !== 'admin' && !event.serverId && event.type !== 'update') continue;
      if (client.bufferedAmount > 1024 * 1024) { client.close(1013, formatPanelMessage('panel.ws.client.slow')[client.panelLanguage || 'en']); continue; }
      client.send(JSON.stringify(localizeWebSocketEvent(event, client.panelLanguage)));
    }
  };
  try {
    manager = await createManager({ store, dataDir, emit }); await manager.initialize();
    nodes = createNodes({ store, localManager: manager, dataDir, emit });
    provisioner = nodeProvisionerFactory({ nodes, store, projectDir, dataDir, emit });
    nodes.attachProvisioner(provisioner);
    manager = nodes.manager; await nodes.initialize();
    removal = nodeRemovalControllerFactory({ nodes, store, dataDir, projectDir, ssh: provisioner.withSSH?.bind(provisioner), emit });
    nodes.attachRemoval(removal);
    const hostManager = { maintenanceStatus: () => manager.maintenanceStatus?.(), beginMaintenance(input) {
      if (!input.restore && provisioner.jobs().some(job => ['queued', 'running'].includes(job.status))) {
        const error = new Error('Đang có tác vụ chưa hoàn tất. Chờ hoàn tất trước khi khởi động lại hệ thống.'); error.status = 409; throw error;
      }
      if (!input.restore && removal.jobs().some(job => ['queued', 'running', 'unknown', 'partial'].includes(job.status))) {
        const error = new Error('Đang áp dụng thay đổi hệ thống. Hãy chờ hoàn tất.'); error.status = 409; throw error;
      }
      return manager.beginMaintenance(input);
    } };
    systemPower = powerController || createSystemPowerController({ role: 'panel', nodeId: 'local', dataDir, store, manager: hostManager });
    powerInfo = await systemPower.read();
    systemZram = zramController || createHostZramController({ role: 'panel', nodeId: 'local', dataDir, store, manager: hostManager });
    await systemZram.read();
  }
  catch (error) { await systemZram?.close?.(); await removal?.close?.(); await systemPower?.close?.(); await manager?.close(); releaseLock(); throw error; }
  app.use('/api', auth.requireAuth);
  app.use('/api', (req, res, next) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const sameHostControl = /^\/(?:host\/(?:power|zram)|nodes\/local\/(?:power|zram))\/?$/.test(req.path);
    const maintenance = manager.maintenanceStatus?.();
    if (mutating && !sameHostControl && maintenance?.active) return res.status(409).json({ error: ['zram', 'uninstall'].includes(maintenance.action) ? 'Đang áp dụng thay đổi hệ thống. Hãy chờ hoàn tất.' : 'Hệ thống đang chuẩn bị khởi động lại; vui lòng chờ kết nối trở lại.' });
    next();
  });
  app.use('/api', (req, _res, next) => {
    const match = req.path.match(/^\/servers\/([^/]+)\/(?:file|files)(?:\/|$)/);
    req.fileAccess = match ? auth.fileAccess(req, decodeURIComponent(match[1])) : null;
    next();
  });
  app.use('/api/host', auth.requireAdmin, createHostRouter({ store, dataDir, powerController: systemPower, zramController: systemZram, reauthenticateAdmin: auth.reauthenticateAdmin, manager }));
  app.use('/api/nodes', createNodeRouter(nodes, { projectDir, provisioner, removal, store, hostnameController: systemHostname, powerController: systemPower, zramController: systemZram, reauthenticateAdmin: auth.reauthenticateAdmin }));
  app.use('/api', createRemoteServerProxy(nodes));
  app.use('/api', createRouter(manager, { dataDir, store }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API không tồn tại.' }));
  app.get('/healthz', (_req, res) => res.status(closing ? 503 : 200).set('Cache-Control', 'no-store').json({ ok: !closing, service: 'vortex-mc', version: packageVersion, processId: process.pid, instanceId: powerInfo.instanceId }));
  app.use(express.static(path.join(projectDir, 'public'), { maxAge: 0, dotfiles: 'deny', index: 'index.html', setHeaders(res, filename) {
    if (filename.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    else if (/\.(?:js|css)$/.test(filename)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  } }));
  app.use((error, _req, res, _next) => {
    const status = error.status || error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(error);
    if (!res.headersSent) res.status(status).json(playerListErrorPayload(error, _req.panelLanguage) || applicationErrorPayload(error, _req.panelLanguage) || nodeRemovalErrorPayload(error, _req.panelLanguage) || hostZramErrorPayload(error, _req.panelLanguage) || systemPowerErrorPayload(error, _req.panelLanguage) || hostnameErrorPayload(error, _req.panelLanguage) || storageErrorPayload(error, _req.panelLanguage) || capacityErrorPayload(error, _req.panelLanguage) || serverFirewallErrorPayload(error, _req.panelLanguage) || nodeProvisionErrorPayload(error, _req.panelLanguage) || nodeErrorPayload(error.message, _req.panelLanguage) || { error: status >= 500 ? 'Thao tác thất bại. Xem nhật ký dịch vụ panel.' : error.message });
  });
  server.on('upgrade', (req, socket, head) => {
    const session = auth.readSession(req);
    if (!/^\/ws(?:\?|$)/.test(req.url || '') || !session || !req.headers.origin || !auth.originAllowed(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => { ws.sessionId = session.sid; ws.sessionExpires = session.expires; ws.panelLanguage = requestLanguage(req); wss.emit('connection', ws, req); ws.send(JSON.stringify({ type: 'update' })); });
  });
  const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (ws.sessionExpires < Date.now() || !auth.readSession({ headers: { cookie: `bedrock.sid=${ws.sessionId}` } })) { ws.close(1008, formatPanelMessage('panel.ws.session.expired')[ws.panelLanguage || 'en']); continue; } if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);
  heartbeat.unref();
  wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); ws.on('error', () => {}); });
  async function close() {
    closing = true;
    clearInterval(heartbeat);
    try {
      await systemHostname.close?.();
      await systemZram.close?.();
      await manager.close();
      await systemPower.close?.();
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    } finally { releaseLock(); }
  }
  return { app, server, store, manager, nodes, provisioner, removalController: removal, auth, powerController: systemPower, zramController: systemZram, close };
}

// systemd starts through the current release symlink; ESM resolves its real path.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(projectDir, 'data'));
  const runtime = await createApp({ dataDir });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  runtime.server.once('error', async error => { console.error(translatePanelMessage(`Không thể chạy panel: ${error.message}`)); await runtime.close(); process.exit(1); });
  runtime.server.listen(port, host, () => {
    console.log(`Vortex Panel: http://${host}:${port}`);
    if (runtime.store.data.users.length === 0) console.log(`SETUP TOKEN: ${runtime.auth.setupToken}`);
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; const timeout = setTimeout(() => process.exit(1), 210000); timeout.unref(); await runtime.close(); process.exit(0); });
}
