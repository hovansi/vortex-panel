import express from 'express';
import { pipeline } from 'node:stream/promises';
import { canAccessServer, requireAdmin } from './access.js';
import { isIdentityPath, IDENTITY_READ_PROTECTION } from './file-privacy.js';
import { splitNodeResourceId, NODE_LIMITS } from './nodes.js';
import { fail } from './safety.js';
import { createRouter } from './routes.js';
import { buildNodeBundle } from './node-bundle.js';
import { createHostnameController, changeHostname } from './hostname.js';
import { sendPowerRequest, validatePowerRequest } from './system-power.js';
import { sendZramRequest, validateZramRequest } from './host-zram.js';
import { validateTimezoneRequest, timezoneErrorPayload } from './host-timezone.js';
import { validateNetworkTuningRequest, networkTuningErrorPayload } from './host-network-tuning.js';
import { validateSchedule, supportsSchedulePreCommands, scheduleCommandIssue, scheduleCommandErrorPayload } from './schedule-commands.js';

const safeResponseHeaders = ['content-type', 'content-disposition', 'content-length', 'content-encoding', 'etag', 'last-modified'];
const safeRequestHeaders = ['content-type', 'content-length', 'accept', 'accept-language'];
const writes = method => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const serverRoutes = [
  ['GET,HEAD', /^\/?$/], ['PATCH,DELETE', /^\/?$/],
  ['POST', /^\/(?:start|stop|restart|kill|clone|command|announcement|player-actions|update)\/?$/],
  ['POST', /^\/storage\/grow\/?$/],
  ['GET,PATCH', /^\/appearance\/?$/], ['GET,POST,DELETE', /^\/appearance\/media\/(?:icon|cover)\/?$/],
  ['GET,PATCH', /^\/application\/?$/], ['POST', /^\/dependencies\/?$/],
  ['GET,PATCH', /^\/experiments\/?$/], ['PATCH', /^\/packs\/order\/(?:behavior|resource)\/?$/],
  ['GET', /^\/(?:metrics|logs|properties|configuration|files|players|packs|worlds|activity|backups|gameplay|versions|network-access)\/?$/],
  ['POST,DELETE', /^\/network-access\/?$/],
  ['GET,PUT,DELETE', /^\/file\/?$/], ['PUT', /^\/(?:properties|players)\/?$/], ['PATCH', /^\/(?:configuration|gamerules)\/?$/],
  ['POST', /^\/gamerules\/query\/?$/],
  ['POST', /^\/files\/(?:mkdir|move|rename|copy|compress|extract|create|upload)\/?$/],
  ['GET', /^\/files\/download\/?$/], ['POST', /^\/packs\/import\/?$/],
  ['PATCH,DELETE', /^\/packs\/[^/]+\/?$/], ['POST', /^\/worlds\/(?:import|select|create)\/?$/],
  ['GET,HEAD,POST', /^\/worlds\/[^/]+\/export\/?$/], ['DELETE', /^\/worlds\/[^/]+\/?$/],
  ['GET,HEAD', /^\/world-exports\/[^/]+\/download\/?$/],
  ['POST', /^\/backups\/?$/], ['POST', /^\/backups\/[^/]+\/(?:restore|verify)\/?$/],
  ['GET', /^\/backups\/[^/]+\/download\/?$/], ['PATCH,DELETE', /^\/backups\/[^/]+\/?$/],
];
export function remoteServerRouteAllowed(method, suffix) {
  return serverRoutes.some(([methods, expression]) => methods.split(',').includes(method === 'HEAD' ? 'GET' : method) && expression.test(suffix));
}

export function createNodeRouter(nodes, { projectDir, provisioner, removal, store, powerController, zramController, timezoneController, networkController, reauthenticateAdmin, hostnameController = createHostnameController() }) {
  const router = express.Router();
  router.use(requireAdmin);
  router.get('/', async (_req, res) => res.json({ nodes: await nodes.publicNodes(), limits: nodes.limits }));
  router.post('/ssh/check', async (req, res) => res.json(await (req.body?.hostFingerprint ? provisioner.check(req.body) : provisioner.discover({ host: req.body?.host, port: req.body?.port }))));
  router.post('/provision', async (req, res) => { res.status(202).json({ job: provisioner.start(req.body, req.session.user) }); });
  router.get('/provision/jobs', (_req, res) => res.json({ jobs: provisioner.jobs() }));
  router.get('/provision/jobs/:id', (req, res) => res.json({ job: provisioner.getJob(req.params.id) }));
  router.get('/uninstall/jobs', (_req, res) => res.json({ jobs: removal.jobs() }));
  router.get('/uninstall/jobs/:id', (req, res) => res.json({ job: removal.getJob(req.params.id) }));
  router.post('/uninstall/jobs/:id/verify', async (req, res) => {
    const { adminPassword, ...input } = req.body || {};
    if (req.body && typeof req.body === 'object') delete req.body.adminPassword;
    const user = await reauthenticateAdmin(req, adminPassword);
    res.status(202).json({ job: await removal.verify(req.params.id, input, user) });
  });
  router.get('/:id/uninstall', async (req, res) => res.json(await removal.plan(req.params.id)));
  router.post('/:id/uninstall', async (req, res) => {
    const { adminPassword, ...input } = req.body || {};
    if (req.body && typeof req.body === 'object') delete req.body.adminPassword;
    const user = await reauthenticateAdmin(req, adminPassword);
    res.status(202).json({ job: await removal.start(req.params.id, input, user) });
  });
  router.get('/agent-bundle', async (_req, res, next) => {
    // Reproducible source whitelist only; no node config, credentials, data or output.
    res.attachment('vortex-node-agent.zip').type('application/zip');
    try { await buildNodeBundle(projectDir, res); }
    catch (error) { if (res.destroyed) return; if (res.headersSent) res.destroy(error); else next(error); }
  });
  router.post('/', async (req, res) => { res.status(201).json({ node: await nodes.add(req.body, req.session.user) }); });
  router.get('/:id/application-runtimes', async (req, res) => {
    if (req.params.id === 'local') return res.json({ nodeId: 'local', applicationRuntime: await nodes.manager.applicationCapabilities({ refresh: true }) });
    const node = nodes.requireAvailable(req.params.id);
    const value = await nodes.call(node, { path: '/api/application-runtimes', method: 'GET', headers: { 'X-Vortex-Actor': nodes.actorHeader(node, req.session.user), 'Accept-Language': req.panelLanguage || 'en' }, timeoutMs: 45000, maxBytes: 128 * 1024 });
    res.json({ nodeId: node.id, applicationRuntime: value.applicationRuntime });
  });
  const hostnameOperation = async (req, res) => {
    if (req.params.id === 'local') {
      const value = req.method === 'GET' ? { hostname: await hostnameController.read() }
        : await changeHostname(hostnameController, req.body, { store, user: req.session.user, nodeId: 'local' });
      return res.json({ ...value, nodeId: 'local' });
    }
    // This dedicated endpoint forwards only the hostname schema, never an
    // arbitrary host path, command, node URL or process environment.
    const mutating = req.method === 'PATCH', node = nodes.requireAvailable(req.params.id, { mutating });
    const finish = mutating ? nodes.beginMutation(node.id) : () => {};
    try {
      const body = mutating ? Buffer.from(JSON.stringify(req.body ?? {})) : undefined;
      const headers = { 'X-Vortex-Actor': nodes.actorHeader(node, req.session.user), 'Accept-Language': req.panelLanguage || 'en',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) };
      const value = await nodes.call(node, { path: '/api/node/hostname', method: req.method, headers, body, timeoutMs: 30000, maxBytes: 64 * 1024 });
      if (mutating) nodes.refresh(node.id, { force: true }).catch(() => {});
      return res.json({ ...value, nodeId: node.id });
    } catch (error) {
      if (error.body) return res.status(error.status).json({ ...error.body, nodeId: node.id });
      if (mutating) throw Object.assign(new Error('Hostname request outcome is unknown.'), { code: 'HOSTNAME_UNKNOWN', status: error.status === 504 ? 504 : 502, outcomeUnknown: true });
      throw error;
    } finally { finish(); }
  };
  router.get('/:id/hostname', hostnameOperation);
  router.patch('/:id/hostname', hostnameOperation);
  const powerOperation = async (req, res) => {
    const mutating = req.method === 'POST';
    if (mutating) {
      validatePowerRequest(req.body);
      if (req.body.nodeId !== req.params.id) throw Object.assign(new Error('The selected VPS does not match this request.'), { code: 'POWER_TARGET', status: 409 });
    }
    if (req.params.id === 'local') {
      if (mutating) return sendPowerRequest(powerController, req, res, 'local');
      return res.json({ nodeId: 'local', power: await powerController.read() });
    }
    const node = nodes.requireAvailable(req.params.id, { mutating });
    const finish = mutating ? nodes.beginMutation(node.id) : () => {};
    try {
      // Browser-visible IDs belong to the control plane. Only its verified
      // agent identity is forwarded, preventing stale forms targeting another VPS.
      const body = mutating ? Buffer.from(JSON.stringify({ ...req.body, nodeId: node.agentId })) : undefined;
      const headers = { 'X-Vortex-Actor': nodes.actorHeader(node, req.session.user), 'Accept-Language': req.panelLanguage || 'en',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) };
      const value = await nodes.call(node, { path: '/api/node/power', method: req.method, headers, body, timeoutMs: 15000, maxBytes: 128 * 1024 });
      return res.status(mutating && value.accepted ? 202 : 200).json({ ...value, nodeId: node.id, ...(value.power ? { power: { ...value.power, nodeId: node.id } } : {}) });
    } catch (error) {
      if (error.body) return res.status(error.status).json({ ...error.body, nodeId: node.id, ...(error.body.power ? { power: { ...error.body.power, nodeId: node.id } } : {}) });
      if (mutating) throw Object.assign(new Error('The restart outcome is unknown.'), { code: 'POWER_UNKNOWN', status: error.status === 504 ? 504 : 502, outcomeUnknown: true });
      throw error;
    } finally { finish(); }
  };
  router.get('/:id/power', powerOperation);
  router.post('/:id/power', powerOperation);
  const zramOperation = async (req, res) => {
    const mutating = req.method === 'POST';
    let input;
    if (mutating) {
      const { password, ...value } = req.body || {};
      if (req.body && typeof req.body === 'object') delete req.body.password;
      validateZramRequest(value);
      if (value.nodeId !== req.params.id) throw Object.assign(new Error('The selected VPS changed.'), { code: 'ZRAM_TARGET', status: 409 });
      await reauthenticateAdmin(req, password);
      input = value;
    }
    if (req.params.id === 'local') {
      if (!mutating) return res.json({ nodeId: 'local', zram: await zramController.read() });
      req.body = input;
      return sendZramRequest(zramController, req, res, 'local');
    }
    const node = nodes.requireAvailable(req.params.id, { mutating });
    const finish = mutating ? nodes.beginMutation(node.id) : () => {};
    try {
      const body = mutating ? Buffer.from(JSON.stringify({ ...input, nodeId: node.agentId })) : undefined;
      const headers = { 'X-Vortex-Actor': nodes.actorHeader(node, req.session.user), 'Accept-Language': req.panelLanguage || 'en',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) };
      const value = await nodes.call(node, { path: '/api/node/zram', method: req.method, headers, body, timeoutMs: mutating ? 180000 : 20000, maxBytes: 128 * 1024 });
      return res.json({ ...value, nodeId: node.id, ...(value.zram ? { zram: { ...value.zram, nodeId: node.id } } : {}) });
    } catch (error) {
      if (error.body) return res.status(error.status).json({ ...error.body, nodeId: node.id, ...(error.body.zram ? { zram: { ...error.body.zram, nodeId: node.id } } : {}) });
      if (mutating) throw Object.assign(new Error('The system memory operation outcome is unknown.'), { code: 'ZRAM_UNKNOWN', status: error.status === 504 ? 504 : 502, outcomeUnknown: true });
      throw error;
    } finally { finish(); }
  };
  router.get('/:id/zram', zramOperation);
  router.post('/:id/zram', zramOperation);
  // Session, Origin and CSRF are checked by the parent panel before this router.
  // Forward only these two bounded schemas to the verified agent identity.
  for (const feature of ['timezone', 'network']) {
    const controller = feature === 'timezone' ? timezoneController : networkController;
    const validate = feature === 'timezone' ? validateTimezoneRequest : validateNetworkTuningRequest;
    const errorPayload = feature === 'timezone' ? timezoneErrorPayload : networkTuningErrorPayload;
    const operation = async (req, res) => {
      const mutating = req.method === 'POST';
      if (mutating) {
        validate(req.body);
        if (feature === 'timezone' && req.body.nodeId !== req.params.id) throw Object.assign(new Error('The selected VPS does not match this request.'), { code: 'TIMEZONE_TARGET', status: 409 });
      }
      if (req.params.id === 'local') {
        if (!controller) throw Object.assign(new Error('The local host controller is unavailable.'), { code: feature === 'timezone' ? 'TIMEZONE_UNAVAILABLE' : 'NETWORK_UNAVAILABLE', status: 409 });
        if (!mutating) return res.json({ nodeId: 'local', [feature]: await controller.read() });
        const apply = () => controller.request(req.body, { user: req.session.user });
        const value = feature === 'timezone' ? await nodes.manager.withHostOperation(apply) : await apply();
        return res.json({ ...value, nodeId: 'local' });
      }
      const node = nodes.requireAvailable(req.params.id, { mutating });
      const finish = mutating ? nodes.beginMutation(node.id) : () => {};
      const map = value => ({ ...value, nodeId: node.id, ...(value[feature] ? { [feature]: { ...value[feature], nodeId: node.id } } : {}) });
      try {
        const body = mutating ? Buffer.from(JSON.stringify({ ...req.body, ...(feature === 'timezone' ? { nodeId: node.agentId } : {}) })) : undefined;
        const headers = { 'X-Vortex-Actor': nodes.actorHeader(node, req.session.user), 'Accept-Language': req.panelLanguage || 'en',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) };
        const value = await nodes.call(node, { path: '/api/node/' + feature, method: req.method, headers, body, timeoutMs: 45000, maxBytes: 256 * 1024 });
        return res.json(map(value));
      } catch (error) {
        if (error.status === 404) return res.status(409).json({ ...errorPayload({ code: feature === 'timezone' ? 'TIMEZONE_UPGRADE_REQUIRED' : 'NETWORK_UPGRADE_REQUIRED' }, req.panelLanguage), nodeId: node.id });
        if (error.body) return res.status(error.status).json(map(error.body));
        if (mutating) throw Object.assign(new Error('The host operation outcome is unknown.'), { code: feature === 'timezone' ? 'TIMEZONE_UNKNOWN' : 'NETWORK_UNKNOWN', status: error.status === 504 ? 504 : 502, outcomeUnknown: true });
        throw error;
      } finally { finish(); }
    };
    router.get(`/:id/${feature}`, operation);
    router.post(`/:id/${feature}`, operation);
  }
  router.get('/:id', async (req, res) => {
    if (req.params.id === 'local') return res.json({ node: (await nodes.publicNodes())[0] });
    res.json({ node: nodes.publicNode(nodes.get(req.params.id)) });
  });
  router.patch('/:id', async (req, res) => res.json({ node: await nodes.update(req.params.id, req.body, req.session.user) }));
  router.delete('/:id', (_req, _res) => fail('Cần gỡ Vortex và xác minh kết quả trước khi ngắt quản lý VPS.', 409));
  router.post('/:id/test', async (req, res) => {
    if (req.params.id === 'local') return res.json({ node: (await nodes.publicNodes())[0] });
    const node = nodes.get(req.params.id); await nodes.refresh(node.id, { force: true });
    res.json({ node: nodes.publicNode(node) });
  });
  const localRoutes = createRouter(nodes.manager);
  const versionsProxy = async (req, res, next) => {
    if (req.params.id === 'local') {
      req.url = req.url.slice(req.url.indexOf('/versions'));
      return localRoutes(req, res, next);
    }
    const node = nodes.requireAvailable(req.params.id), rest = req.path.slice(req.path.indexOf('/versions'));
    if (req.method !== 'GET' && req.method !== 'POST') fail('Unsupported node version operation.', 405);
    await proxy(nodes, node, `/api${rest}`, req, res);
  };
  router.get('/:id/versions', versionsProxy);
  router.post('/:id/versions/refresh', versionsProxy);
  router.post('/:id/versions/import', versionsProxy);
  router.post('/:id/versions/:channel/:version/verify', versionsProxy);
  return router;
}

async function prepareRemoteSchedule(nodes, node, request, body, operation, signal) {
  let snapshot;
  try { snapshot = await nodes.call(node, { path: '/api/node/snapshot', timeoutMs: 10000, signal }); }
  catch { throw scheduleCommandIssue('SCHEDULE_NODE_UNVERIFIED'); }
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (snapshot?.service !== 'vortex-node' || snapshot.protocol !== 1 || snapshot.nodeId !== node.agentId || !Array.isArray(snapshot.schedules) || snapshot.schedules.length > 2000 || !Array.isArray(snapshot.servers) || snapshot.servers.length > NODE_LIMITS.serversPerNode) throw scheduleCommandIssue('SCHEDULE_NODE_UNVERIFIED');
  let previous = {};
  if (operation.id) {
    const records = snapshot.schedules.filter(row => row?.id === operation.id);
    if (records.length !== 1) fail('Schedule was not found. Refresh node status and retry.', 404);
    previous = records[0];
  }
  const serverId = previous.serverId ?? body.serverId;
  if (!uuid.test(serverId || '') || !snapshot.servers.some(server => server?.id === serverId)) throw scheduleCommandIssue('SCHEDULE_NODE_UNVERIFIED');
  if (!canAccessServer(request.session.user, `${node.id}:${serverId}`, true)) fail('You do not have permission to modify this schedule.', 403);
  if (body.serverId !== undefined && body.serverId !== serverId) fail('A schedule cannot move between servers or nodes.', 400);
  const fields = validateSchedule(operation.run ? {} : body, previous);
  if (fields.command && ['backup', 'restart'].includes(fields.action) && !supportsSchedulePreCommands(snapshot.capabilities?.scheduleCommands, snapshot.version)) throw scheduleCommandIssue('SCHEDULE_NODE_UPGRADE_REQUIRED');
  return { id: operation.id || null, serverId, ...fields };
}

function verifyScheduleAcknowledgement(value, expected) {
  const row = value?.schedule, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (!row || !uuid.test(row.id || '') || expected.id && row.id !== expected.id || row.serverId !== expected.serverId || row.action !== expected.action || row.intervalMinutes !== expected.intervalMinutes || row.enabled !== expected.enabled || (row.command ?? null) !== expected.command) throw scheduleCommandIssue('SCHEDULE_NODE_ACK_MISMATCH');
}

async function proxy(nodes, node, remotePath, req, res, bodyOverride, { schedule = null } = {}) {
  const abort = new AbortController();
  const finishMutation = writes(req.method) ? nodes.beginMutation(node.id, { placement: req.method === 'POST' && /\/clone\/?$/.test(remotePath) }) : () => {};
  let upstream;
  const cancel = () => { if (!res.writableFinished) { abort.abort(); upstream?.destroy(); } };
  req.once('aborted', cancel); res.once('close', cancel);
  const stableDownload = ['GET', 'HEAD'].includes(req.method) && /^\/api\/servers\/[^/]+\/(?:files\/download|(?:backups|world-exports)\/[^/]+\/download)\/?$/.test(remotePath);
  const worldExport = ['GET', 'HEAD'].includes(req.method) && /^\/api\/servers\/[^/]+\/worlds\/[^/]+\/export\/?$/.test(remotePath);
  const requestHeaders = stableDownload ? [...safeRequestHeaders, 'range', 'if-range'] : safeRequestHeaders;
  const responseHeaders = stableDownload ? [...safeResponseHeaders, 'accept-ranges', 'content-range'] : safeResponseHeaders;
  const headers = Object.fromEntries(requestHeaders.filter(key => req.headers[key] !== undefined).map(key => [key, req.headers[key]]));
  headers['X-Vortex-Actor'] = nodes.actorHeader(node, req.session.user);
  // Never relay a browser supplied elevation header. Only the authenticated
  // controller session can issue this short lived, server scoped grant.
  delete headers['x-vortex-file-access'];
  if (req.fileAccess && req.session.user.role === 'admin') {
    headers['X-Vortex-File-Access'] = JSON.stringify({ serverId: remotePath.split('/')[3], expires: req.fileAccess.expires });
  }
  const type = String(req.headers['content-type'] || '').toLowerCase();
  let body;
  if (writes(req.method)) {
    if (bodyOverride !== undefined || type.includes('application/json')) {
      body = Buffer.from(JSON.stringify(bodyOverride ?? req.body ?? {})); headers['content-type'] = 'application/json'; headers['content-length'] = String(body.length);
    } else { body = req; }
  } else delete headers['content-length'];
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  try {
    // Hold mutation admission while reading an authenticated fresh snapshot;
    // a cached new version cannot authorize an
    // older worker after a downgrade. Missing PATCH commands remain omitted.
    const scheduleExpected = schedule ? await prepareRemoteSchedule(nodes, node, req, bodyOverride ?? req.body ?? {}, schedule, abort.signal) : null;
    if (req.method === 'POST' && /\/clone\/?$/.test(remotePath)) await nodes.assertPortAllocation(node, { ...(bodyOverride ?? req.body), kind: 'bedrock' });
    const response = await nodes.request(nodes.credentials(node), { path: remotePath + query, method: req.method, body, headers: nodes.gameNetworkHeaders?.(node, headers) || headers, stream: true, signal: AbortSignal.any([abort.signal, nodes.signal]), timeoutMs: 300000,
      ...(stableDownload || worldExport || body === req ? { idleTimeoutMs: 300000 } : {}), maxBytes: 2 * 1024 ** 3 + 20 * 1024 ** 2 });
    upstream = response.stream; nodes.identityHeaders(node, response);
    // Each export GET builds a new ZIP. It has no stable representation that a
    // browser can safely resume from an earlier request's byte offset.
    if (worldExport) res.setHeader('Accept-Ranges', 'none');
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    const transformedJson = contentType.includes('application/json') && !response.headers['content-disposition'];
    if (scheduleExpected && response.statusCode >= 200 && response.statusCode < 300 && !transformedJson) throw scheduleCommandIssue('SCHEDULE_NODE_ACK_MISMATCH');
    // HEAD has the GET representation's headers and deliberately no body,
    // including when its Content-Type is JSON. Never feed it to a JSON parser.
    if (req.method === 'HEAD') {
      res.status(response.statusCode);
      // GET rewrites JSON resource IDs/localization. Its generated length and
      // validators cannot be inferred from the agent's raw representation.
      const headHeaders = transformedJson ? ['content-type'] : responseHeaders;
      for (const key of headHeaders) if (response.headers[key] !== undefined) res.setHeader(key, response.headers[key]);
      upstream.destroy(); res.end(); return;
    }
    if (transformedJson) {
      let value;
      try { value = await nodes.readJson(response, req.method === 'GET' && /\/files\/?$/.test(remotePath) ? 64 * 1024 ** 2 : 14 * 1024 ** 2); }
      catch (error) {
        if (error.body) { res.status(error.status).json(error.body); return; }
        throw error;
      }
      if (scheduleExpected) verifyScheduleAcknowledgement(value, scheduleExpected);
      nodes.recordResponse(node, value, { mutating: writes(req.method) });
      if (req.method === 'DELETE' && /^\/api\/servers\/[^/]+\/?$/.test(remotePath) && value.ok) { const warning = nodes.recordDeletedServer?.(node, remotePath.split('/')[3]); if (warning) value.warnings = [...(value.warnings || []), warning]; }
      if (req.method === 'DELETE' && /^\/api\/schedules\/[^/]+\/?$/.test(remotePath) && value.ok) nodes.recordDeletedSchedule(node, remotePath.split('/')[3]);
      res.status(response.statusCode).json(nodes.mapResponse(node, value)); return;
    }
    res.status(response.statusCode);
    for (const key of responseHeaders) if (response.headers[key] !== undefined) res.setHeader(key, response.headers[key]);
    await pipeline(upstream, res);
  } catch (error) {
    upstream?.destroy();
    if (req.aborted || res.destroyed) return;
    if (res.headersSent) { res.destroy(error); return; }
    const scheduleError = scheduleCommandErrorPayload(error, req.panelLanguage);
    if (scheduleError) { res.status(error.status).json(scheduleError); return; }
    if (writes(req.method) && !error.body && ![400, 401, 403, 404, 409].includes(error.status)) {
      error.message = 'The node request outcome is unknown. No automatic retry was made; reconnect and inspect the server/job state before trying again.';
      error.status = error.status === 504 ? 504 : 502;
    }
    throw error;
  } finally {
    finishMutation();
    req.removeListener('aborted', cancel); res.removeListener('close', cancel);
  }
}

// Called only AFTER the panel's session/origin/CSRF checks. No arbitrary node URL
// or general-purpose host proxy is exposed to browsers.
export function createRemoteServerProxy(nodes) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    const match = req.path.match(/^\/servers\/([^/]+)(.*)$/);
    if (match) {
      let id; try { id = decodeURIComponent(match[1]); } catch { fail('Invalid server identity.', 400); }
      const composite = splitNodeResourceId(id); if (!composite) return next();
      if (!remoteServerRouteAllowed(req.method, match[2])) fail('Remote API route does not exist.', 404);
      const user = req.session.user, manage = writes(req.method);
      if (!canAccessServer(user, id, manage)) fail('You do not have permission to access this server.', 403);
      if ((req.method === 'DELETE' && /^\/?$/.test(match[2]) || req.method === 'POST' && /^\/(?:clone|storage\/grow)\/?$/.test(match[2])) && user.role !== 'admin') fail('This operation requires an administrator.', 403);
      if (/^\/network-access\/?$/.test(match[2]) && user.role !== 'admin') fail('This operation requires an administrator.', 403);
      if (['GET', 'HEAD'].includes(req.method) && ((/^\/(?:file|files\/download)\/?$/.test(match[2]) && isIdentityPath(req.query.path)) || /^\/worlds\/[^/]+\/export\/?$/.test(match[2]) || /^\/(?:backups|world-exports)\/[^/]+\/download\/?$/.test(match[2])) && !canAccessServer(user, id, true)) fail(IDENTITY_READ_PROTECTION, 403);
      const node = nodes.requireAvailable(composite.nodeId, { create: req.method === 'POST' && /^\/clone\/?$/.test(match[2]), mutating: manage });
      return proxy(nodes, node, `/api/servers/${composite.rawId}${match[2]}`, req, res);
    }
    if (req.path === '/schedules' && req.method === 'POST') {
      const composite = splitNodeResourceId(req.body?.serverId); if (!composite) return next();
      if (!canAccessServer(req.session.user, req.body.serverId, true)) fail('You do not have permission to schedule this server.', 403);
      return proxy(nodes, nodes.requireAvailable(composite.nodeId), '/api/schedules', req, res, { ...req.body, serverId: composite.rawId }, { schedule: {} });
    }
    const schedule = req.path.match(/^\/schedules\/([^/]+)(\/run)?\/?$/);
    if (schedule) {
      let id; try { id = decodeURIComponent(schedule[1]); } catch { fail('Invalid schedule identity.', 400); }
      const composite = splitNodeResourceId(id); if (!composite) return next();
      if (!(req.method === 'PATCH' && !schedule[2] || req.method === 'DELETE' && !schedule[2] || req.method === 'POST' && schedule[2] === '/run')) fail('Remote schedule route does not exist.', 404);
      const record = nodes.manager.schedules().find(row => row.id === id);
      if (!record) fail('Schedule was not found. Refresh node status and retry.', 404);
      if (!canAccessServer(req.session.user, record.serverId, true)) fail('You do not have permission to modify this schedule.', 403);
      const body = { ...req.body };
      if (body.serverId !== undefined) {
        if (body.serverId !== record.serverId) fail('A schedule cannot move between servers or nodes.', 400);
        body.serverId = splitNodeResourceId(record.serverId).rawId;
      }
      return proxy(nodes, nodes.requireAvailable(composite.nodeId), `/api/schedules/${composite.rawId}${schedule[2] || ''}`, req, res, body, req.method === 'DELETE' ? {} : { schedule: { id: composite.rawId, run: Boolean(schedule[2]) } });
    }
    next();
  });
  return router;
}
