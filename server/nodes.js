import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StringDecoder } from 'node:string_decoder';
import { getLogRetentionPolicy, retainStoreHistory } from './log-retention.js';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { createNodeSecrets } from './node-secrets.js';
import { requestNode, validateNodeEndpoint, normalizeFingerprint } from './node-transport.js';
import { fail, parseUdpPorts, networkPortReservations } from './safety.js';
import { createNodeNaming } from './node-naming.js';
import { capacityErrorPayload } from './capacity.js';
import { applicationErrorPayload, applicationIssue } from './application-schema.js';
import { bedrockRuntimeErrorPayload } from './bedrock-runtime.js';
import { canAccessServer } from './access.js';
import { creationPortMode, supportsAutomaticPorts, requireAutomaticPorts } from './port-allocation.js';
import { requireNetherNetCreationPolicy, bedrockTransportErrorPayload } from './bedrock-transport.js';
import { isPublicGameAddress } from './bedrock-network.js';
import { gameNetworkAccessErrorPayload } from './game-network-access.js';

export function nodeGameNetworkHeaders(node, input = {}) {
  const headers = Object.fromEntries(Object.entries(input).filter(([name]) => name.toLowerCase() !== 'x-vortex-game-public-ip'));
  if (isPublicGameAddress(node?.publicAddress)) headers['X-Vortex-Game-Public-IP'] = node.publicAddress;
  return headers;
}

export const NODE_LIMITS = Object.freeze({ maxNodes: 32, serversPerNode: 512, snapshotBytes: 8 * 1024 ** 2 });
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const panelVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const now = () => new Date().toISOString();
const errorText = (error, token) => String(error?.message || 'Node is unavailable.').split(token || '\0').join('[redacted]').slice(0, 400);
const references = ['serverId', 'scheduleId', 'lastJobId', 'jobId', 'cloneJobId', 'backupJobId'];
function validServerNetwork(row) {
  const kind = row.kind ?? 'bedrock';
  if (!['bedrock', 'nodejs', 'python'].includes(kind)) return false;
  if (kind !== 'bedrock') return Number.isInteger(row.port) && row.port >= 1024 && row.port <= 65535 && row.transport === 'tcp' && row.portV6 === null && row.udpPorts === null && row.debugPort == null;
  if (!Number.isInteger(row.port) || row.port < 1024 || row.port > 65535 || !Number.isInteger(row.portV6) || row.portV6 < 1024 || row.portV6 > 65535 || !['raknet', 'nethernet', 'auto'].includes(row.transport)) return false;
  try { if (row.transport !== 'raknet') parseUdpPorts(row.udpPorts); networkPortReservations(row); } catch { return false; }
  return true;
}
export function nodeResourceId(nodeId, rawId) {
  if (!UUID.test(nodeId) || !UUID.test(rawId)) fail('Invalid node resource identity.', 400);
  return `${nodeId}:${rawId}`;
}
export function splitNodeResourceId(id) {
  if (typeof id !== 'string') return null;
  const pieces = id.split(':');
  return pieces.length === 2 && pieces.every(p => UUID.test(p)) ? { nodeId: pieces[0], rawId: pieces[1] } : null;
}
const validateLabel = (value, name, max, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid node ${name}.`, 400);
  return value.trim();
};
const publicAddress = value => {
  const address = validateLabel(value, 'public address', 253, true);
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (address && !isIP(unwrapped) && (!/^[A-Za-z0-9.-]+$/.test(address) || !address.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) fail('Use a hostname or IP address without a URL or port.', 400);
  return unwrapped;
};
const compact = server => {
  const copy = { ...server };
  for (const key of ['players', 'cpuPercent', 'memoryMB', 'uptime', 'pid', 'busy', 'startupWait', 'resources', 'telemetry', 'capacityUsage']) delete copy[key];
  return copy;
};
const nodeTag = (node, row, state) => ({
  ...row, nodeId: node.id, nodeName: node.name, nodeAddress: node.publicAddress || '',
  nodeOnline: Boolean(state?.online), nodeStatus: state?.online ? 'online' : 'offline', nodeLastSeen: state?.lastSeen || node.lastSeen || null,
});
export function mapNodeRecord(node, row, kind, state) {
  const mapped = { ...row };
  if (mapped.id && ['server', 'job', 'schedule', 'activity'].includes(kind)) mapped.id = nodeResourceId(node.id, mapped.id);
  for (const key of references) if (mapped[key]) mapped[key] = nodeResourceId(node.id, mapped[key]);
  return nodeTag(node, mapped, state);
}
export function mapNodeResponse(node, value, state) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value };
  for (const [key, kind] of [['server', 'server'], ['job', 'job'], ['schedule', 'schedule']]) if (result[key]) result[key] = mapNodeRecord(node, result[key], kind, state);
  for (const [key, kind] of [['servers', 'server'], ['jobs', 'job'], ['schedules', 'schedule'], ['activity', 'activity']]) if (Array.isArray(result[key])) result[key] = result[key].map(row => mapNodeRecord(node, row, kind, state));
  if (result.serverId) result.serverId = nodeResourceId(node.id, result.serverId);
  return result;
}

export function createNodes({ store, localManager, dataDir, emit = () => {}, request = requestNode }) {
  const secrets = createNodeSecrets(dataDir);
  const states = new Map(), inFlight = new Map(), locks = new Set(), actor = new AsyncLocalStorage();
  const streams = new Map(), retryTimers = new Map(), retryCounts = new Map(), networkCache = new Map();
  const eventTimers = new Map(), eventDirty = new Set();
  const activeMutations = new Map();
  // A mutation acknowledgement is newer than any snapshot already in flight.
  // Keep only those bounded observations until a subsequent snapshot can be
  // authoritative; this is not a second persisted job history.
  const acknowledgements = new Map();
  let observation = 0;
  const shutdown = new AbortController();
  let closed = false, timer, refreshPromise, provisioner, removal, fleetRemoval, fleetUpdate, pendingAdds = 0, addTail = Promise.resolve();
  store.data.nodes ||= [];
  if (!Array.isArray(store.data.nodes) || store.data.nodes.length > NODE_LIMITS.maxNodes) throw new Error('Invalid node registry.');
  for (const row of store.data.nodes) {
    if (!UUID.test(row.id) || !UUID.test(row.agentId) || !Array.isArray(row.inventory) || row.inventory.length > NODE_LIMITS.serversPerNode || typeof row.tokenEncrypted !== 'string') throw new Error('Invalid stored node identity or inventory.');
    validateNodeEndpoint(row.endpoint); normalizeFingerprint(row.fingerprint);
    if (row.inventory.some(server => !server || !UUID.test(server.id) || typeof server.name !== 'string' || server.name.length > 80 || !validServerNetwork(server))) {
      row.inventory = row.inventory.filter(server => server && UUID.test(server.id) && typeof server.name === 'string' && server.name.length <= 80 && validServerNetwork(server));
      states.set(row.id, { online: false, lastSeen: row.lastSeen, snapshot: null, error: 'The stored node inventory needs a fresh validated observation.' });
    }
  }
  const naming = createNodeNaming(store);
  const get = id => store.data.nodes.find(row => row.id === id) || fail('Node was not found.', 404);
  const requireOpen = () => { if (closed) fail('The panel is shutting down.', 503); };
  const assertLocalMutation = () => { if (localManager.maintenanceStatus?.()?.active) fail('A main-panel system operation is pending. Wait for it to finish before changing a linked VPS.', 409); };
  const stateOf = node => states.get(node.id) || { online: false, lastSeen: node.lastSeen, error: null, snapshot: null };
  const credentials = node => {
    try { return { ...node, token: secrets.open(node.tokenEncrypted, node.id) }; }
    catch { fail('Node credentials cannot be decrypted. Restore .node-key or replace this node token.', 502); }
  };
  const identityHeaders = (node, response) => {
    if (response.statusCode === 401) { response.stream.destroy(); fail('Node authentication failed. Check or replace the agent token.', 502); }
    const id = response.headers['x-vortex-node-id'];
    if (id !== node.agentId) { response.stream.destroy(); fail('The node identity does not match this link. Re-enroll the correct agent.', 502); }
  };
  async function readJson(response, maxBytes = NODE_LIMITS.snapshotBytes) {
    let size = 0; const chunks = [];
    try {
      for await (const chunk of response.stream) {
        size += chunk.length;
        if (size > maxBytes) { response.stream.destroy(); fail('Node response exceeds the supported limit.', 502); }
        chunks.push(chunk);
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('The node did not return valid JSON.', 502); }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = new Error(typeof value.error === 'string' ? value.error : `Node request failed (${response.statusCode}).`);
        error.status = response.statusCode; error.body = value;
        // The central create facade throws through its own error handler. Keep
        // recognized operation identities there, using local canonical metadata
        // rather than trusting arbitrary message/code fields from a peer.
        const canonical = typeof value?.code === 'string' ? capacityErrorPayload(value) || applicationErrorPayload(value) || bedrockRuntimeErrorPayload(value) || bedrockTransportErrorPayload(value) || gameNetworkAccessErrorPayload(value) : null;
        if (canonical) { error.code = canonical.code; error.errorI18n = canonical.errorI18n; }
        throw error;
      }
      return value;
    } finally { if (!response.stream.complete) response.stream.destroy(); }
  }
  async function call(node, options = {}) {
    requireOpen();
    const result = await request(credentials(node), { ...options, headers: nodeGameNetworkHeaders(node, options.headers), stream: true, signal: options.signal ? AbortSignal.any([shutdown.signal, options.signal]) : shutdown.signal, timeoutMs: options.timeoutMs ?? 10000 });
    identityHeaders(node, result);
    return readJson(result, options.maxBytes);
  }
  const actorHeader = (node, user) => {
    const selected = user || { id: 'panel-system', username: 'panel-system', role: 'admin', allServers: true, serverIds: [] };
    const rawIds = (selected.serverIds || []).map(splitNodeResourceId).filter(id => id?.nodeId === node.id).map(id => id.rawId);
    return Buffer.from(JSON.stringify({ id: selected.id, username: selected.username, role: selected.role, allServers: selected.role === 'admin' || selected.allServers === true, serverIds: rawIds })).toString('base64url');
  };
  function validateSnapshot(node, data) {
    if (data?.service !== 'vortex-node' || data.protocol !== 1 || data.nodeId !== node.agentId || !Array.isArray(data.servers) || data.servers.length > NODE_LIMITS.serversPerNode) fail('Node identity or inventory is incompatible.', 502);
    const ids = new Set();
    for (const row of data.servers) {
      if (!row || !UUID.test(row.id) || ids.has(row.id) || typeof row.name !== 'string' || row.name.length > 80 || !validServerNetwork(row)) fail('Node returned an invalid server inventory or network reservation.', 502);
      ids.add(row.id);
    }
    for (const [key, max] of [['jobs', 2000], ['schedules', 2000], ['activity', 2000]]) {
      if (!Array.isArray(data[key]) || data[key].length > max) fail('Node returned an invalid history inventory.', 502);
      const seen = new Set();
      for (const row of data[key]) {
        if (!row || !UUID.test(row.id) || seen.has(row.id) || references.some(key => row[key] !== undefined && row[key] !== null && (typeof row[key] !== 'string' || !UUID.test(row[key])))) fail('Node returned an invalid history identity.', 502);
        seen.add(row.id);
      }
    }
    return data;
  }
  function updateInventory(node, snapshot) {
    const inventory = snapshot.servers.map(compact), current = get(node.id);
    if (current !== node) return;
    const savedAt = Date.parse(node.lastSeen || '') || 0;
    if (JSON.stringify(inventory) !== JSON.stringify(node.inventory) || Date.now() - savedAt > 60000) {
      const old = { inventory: node.inventory, lastSeen: node.lastSeen };
      node.inventory = inventory; node.lastSeen = now();
      try { store.save(); } catch (error) { Object.assign(node, old); throw error; }
    }
  }
  function validHistoryRow(row) {
    return row && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string' && UUID.test(row.id)
      && !references.some(key => row[key] !== undefined && row[key] !== null && (typeof row[key] !== 'string' || !UUID.test(row[key])));
  }
  const terminalJob = row => row && ['completed', 'failed'].includes(row.status);
  function rememberResponse(node, value) {
    let server = value?.server, job = value?.job, schedule = value?.schedule;
    if (server && (!validHistoryRow(server) || typeof server.name !== 'string' || server.name.length > 80 || !validServerNetwork(server))) fail('Node returned an invalid server inventory or network reservation.', 502);
    if (job && !validHistoryRow(job)) fail('Node returned an invalid history identity.', 502);
    if (schedule && (!validHistoryRow(schedule) || !UUID.test(schedule.serverId || ''))) fail('Node returned an invalid schedule identity.', 502);
    if (!server && !job && !schedule) return;
    const state = stateOf(node), knownJob = job && state.snapshot?.jobs.find(row => row.id === job.id);
    if (terminalJob(knownJob) && !terminalJob(job)) {
      job = knownJob;
      if (server?.id === job.serverId) server = state.snapshot.servers.find(row => row.id === server.id) || server;
    }
    let pending = acknowledgements.get(node.id);
    if (!pending) { pending = { servers: new Map(), jobs: new Map(), schedules: new Map() }; acknowledgements.set(node.id, pending); }
    const revision = ++observation;
    for (const [key, row, max] of [['servers', server, NODE_LIMITS.serversPerNode], ['jobs', job, 2000], ['schedules', schedule, 2000]]) {
      if (!row) continue;
      pending[key].delete(row.id); pending[key].set(row.id, { revision, row });
      while (pending[key].size > max) pending[key].delete(pending[key].keys().next().value);
      if (state.snapshot) state.snapshot[key] = [...state.snapshot[key].filter(item => item.id !== row.id), row];
    }
  }
  function acceptSnapshot(node, snapshot, beganObservation = observation) {
    validateSnapshot(node, snapshot);
    if (!store.data.nodes.includes(node)) return;
    const pending = acknowledgements.get(node.id);
    if (pending) {
      for (const key of ['servers', 'jobs', 'schedules']) {
        const newer = [], changed = new Set();
        for (const [id, value] of pending[key]) {
          if (value.revision <= beganObservation) pending[key].delete(id);
          else {
            changed.add(id);
            const observed = key === 'jobs' && snapshot.jobs.find(row => row.id === id);
            if (terminalJob(observed) && !terminalJob(value.row)) value.row = observed;
            if (value.row) newer.push(value.row);
          }
        }
        if (changed.size) snapshot[key] = [...snapshot[key].filter(row => !changed.has(row.id)), ...newer];
      }
      if (!pending.servers.size && !pending.jobs.size && !pending.schedules.size) acknowledgements.delete(node.id);
    }
    updateInventory(node, snapshot);
    states.set(node.id, { online: true, lastSeen: now(), sampledAt: now(), snapshot, latencyMs: stateOf(node).latencyMs || null, error: null });
  }
  function markUnavailable(node, error) {
    if (!store.data.nodes.includes(node)) return;
    const previous = stateOf(node);
    let token; try { token = credentials(node).token; } catch {}
    states.set(node.id, { ...previous, online: false, error: errorText(error, token) });
  }
  async function probe(node) {
    const identity = await call(node, { path: '/api/node/identity', timeoutMs: 10000 });
    if (identity.service !== 'vortex-node' || identity.protocol !== 1 || identity.nodeId !== node.agentId) fail('This endpoint is not the enrolled Vortex Node agent.', 502);
    return validateSnapshot(node, await call(node, { path: '/api/node/snapshot', timeoutMs: 10000 }));
  }
  async function refresh(id, { force = false } = {}) {
    const node = get(id); if (closed) return;
    const state = stateOf(node);
    if (!force && Date.now() - (Date.parse(state.sampledAt || '') || 0) < 4500) return state;
    if (inFlight.has(id)) return inFlight.get(id);
    const run = (async () => {
      const began = performance.now(), beganObservation = observation;
      try { acceptSnapshot(node, await call(node, { path: '/api/node/snapshot', timeoutMs: 4000 }), beganObservation); stateOf(node).latencyMs = Math.round(performance.now() - began); }
      catch (error) { markUnavailable(node, error); }
      finally { inFlight.delete(id); emit({ type: 'update' }); }
      return stateOf(node);
    })();
    inFlight.set(id, run); return run;
  }
  function refreshAll() {
    if (closed) return Promise.resolve();
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const ids = store.data.nodes.map(row => row.id);
      for (let index = 0; index < ids.length && !closed; index += 8) await Promise.allSettled(ids.slice(index, index + 8).map(id => refresh(id)));
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  function stopEvents(id) {
    clearTimeout(retryTimers.get(id)); retryTimers.delete(id);
    clearTimeout(eventTimers.get(id)); eventTimers.delete(id); eventDirty.delete(id);
    streams.get(id)?.abort(); streams.delete(id);
  }
  function queueEventRefresh(id) {
    if (closed) return;
    eventDirty.add(id);
    if (eventTimers.has(id)) return;
    const scheduled = setTimeout(async () => {
      eventDirty.delete(id);
      try { await refresh(id, { force: true }); } catch {}
      eventTimers.delete(id);
      if (eventDirty.has(id)) queueEventRefresh(id);
    }, 1000);
    scheduled.unref(); eventTimers.set(id, scheduled);
  }
  function scheduleEvents(id) {
    if (closed || !store.data.nodes.some(n => n.id === id) || retryTimers.has(id)) return;
    const count = Math.min((retryCounts.get(id) || 0) + 1, 5); retryCounts.set(id, count);
    const retry = setTimeout(() => { retryTimers.delete(id); startEvents(id).catch(() => {}); }, Math.min(30000, 1000 * 2 ** count));
    retry.unref(); retryTimers.set(id, retry);
  }
  async function startEvents(id) {
    if (closed || streams.has(id)) return;
    const node = get(id), abort = new AbortController(); streams.set(id, abort);
    try {
      const result = await request(credentials(node), { path: '/api/node/events', stream: true, signal: abort.signal, timeoutMs: 330000, maxBytes: 16 * 1024 ** 2 });
      identityHeaders(node, result);
      if (result.statusCode !== 200) { result.stream.destroy(); throw new Error('Node event stream is unavailable.'); }
      retryCounts.set(id, 0);
      let buffer = ''; const decoder = new StringDecoder('utf8');
      for await (const chunk of result.stream) {
        buffer += decoder.write(chunk);
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(row => row.startsWith('data: ')); if (!line) continue;
          let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
          const knownServer = UUID.test(event.serverId || '') && get(node.id).inventory.some(s => s.id === event.serverId);
          if (event.type === 'log' && knownServer && UUID.test(event.runId || '') && event.log?.runId === event.runId && typeof event.log.message === 'string' && Buffer.byteLength(event.log.message) <= 32768) {
            emit({ type: 'log', nodeId: id, serverId: nodeResourceId(id, event.serverId), runId: event.runId, log: event.log });
          } else if (event.type === 'console-reset' && knownServer && UUID.test(event.runId || '')) {
            // Keep a snapshot taken before the reset from reintroducing the old
            // generation while the normal inventory refresh is in flight.
            for (const row of [...(node.inventory || []), ...(stateOf(node).snapshot?.servers || [])]) if (row.id === event.serverId) row.consoleRunId = event.runId;
            emit({ type: 'console-reset', nodeId: id, serverId: nodeResourceId(id, event.serverId), runId: event.runId });
            queueEventRefresh(id);
          } else if (event.type === 'update') queueEventRefresh(id);
        }
        if (Buffer.byteLength(buffer) > 128 * 1024) { result.stream.destroy(); throw new Error('Node event frame exceeds the supported limit.'); }
      }
    } catch (error) { if (!abort.signal.aborted && !closed) markUnavailable(node, error); }
    finally { if (streams.get(id) === abort) streams.delete(id); if (!abort.signal.aborted) scheduleEvents(id); }
  }
  function taggedServer(node, row) {
    const state = stateOf(node), server = mapNodeRecord(node, row, 'server', state);
    if (!state.online) Object.assign(server, { lastKnownStatus: server.status, status: 'unreachable', players: null, pid: null, memoryMB: null, cpuPercent: null, uptime: null, busy: true, resources: server.resources ? { ...server.resources, effective: null, usage: null } : null,
      telemetry: server.telemetry ? { ...server.telemetry, stale: true,
        cpu: { ...server.telemetry.cpu, usedCores: null, usedPercent: null }, memory: { ...server.telemetry.memory, usedBytes: null },
        storage: { ...server.telemetry.storage, usedBytes: null, availableBytes: null, hardEnforced: false, stale: true },
        network: { ...server.telemetry.network, available: false, stale: true, rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null } } : null });
    return server;
  }
  const localName = () => store.data.settings?.localNodeName === undefined ? 'Vortex Panel' : validateLabel(store.data.settings.localNodeName, 'name', 80);
  const localTag = row => ({ ...row, nodeId: 'local', nodeName: localName(), nodeAddress: process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '', nodeOnline: true, nodeStatus: 'online', nodeLastSeen: null });
  function listServers() {
    return [...localManager.listServers().map(localTag), ...store.data.nodes.flatMap(node => (stateOf(node).snapshot?.servers || node.inventory).map(row => taggedServer(node, row)))];
  }
  function nodeRows(kind) {
    return store.data.nodes.flatMap(node => (stateOf(node).snapshot?.[kind] || []).map(row => mapNodeRecord(node, row, kind === 'jobs' ? 'job' : kind === 'schedules' ? 'schedule' : 'activity', stateOf(node))));
  }
  function networkSummary(servers) {
    if (servers.some(row => !validServerNetwork(row))) return { usedPorts: { ports: [], reservations: [], unknown: true }, nextPort: null, nextPortV6: null, nextApplicationPort: null };
    const reservations = [...new Map(servers.flatMap(networkPortReservations).map(row => [`${row.protocol}:${row.port}`, row])).values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.port - b.port);
    const occupied = new Set(reservations.map(row => row.port));
    // These legacy suggestion fields cannot reserve ports and become stale
    // between a snapshot and submission. The executor allocates at commit time.
    return { usedPorts: { ports: [...occupied].sort((a, b) => a - b), reservations }, nextPort: null, nextPortV6: null, nextApplicationPort: null };
  }
  function publicNode(node) {
    const state = stateOf(node), snapshot = state.snapshot, rows = snapshot?.servers || node.inventory;
    const observedHost = snapshot?.host || null;
    const host = state.online || !observedHost ? observedHost : { ...observedHost, stale: true, cpuPercent: null, memoryUsed: null, memoryAvailable: null, diskUsed: null, diskAvailable: null,
      cpu: { ...observedHost.cpu, percent: null, usedCores: null }, memory: { ...observedHost.memory, usedBytes: null, availableBytes: null },
      disk: { ...observedHost.disk, usedBytes: null, availableBytes: null }, network: { ...observedHost.network, supported: false, available: false, stale: true, rxBytesPerSecond: null, txBytesPerSecond: null } };
    const signature = JSON.stringify(rows.map(s => [s.id, s.kind, s.port, s.portV6, s.transport, s.udpPorts, s.debugPort]));
    if (networkCache.get(node.id)?.signature !== signature) networkCache.set(node.id, { signature, value: networkSummary(rows) });
    const controlPlane = { kind: 'remote-agent', service: 'vortex-node', version: snapshot?.version || null,
      processId: Number.isSafeInteger(snapshot?.processId) && snapshot.processId > 0 ? snapshot.processId : null, agentId: node.agentId,
      tls: { mode: new URL(node.endpoint).protocol === 'http:' ? 'loopback-http' : node.fingerprint ? 'pinned' : 'certificate-authority', endpoint: node.endpoint, fingerprint: node.fingerprint || null } };
    return { id: node.id, name: node.name, endpoint: node.endpoint, publicAddress: node.publicAddress, location: node.location || snapshot?.host?.location?.label || '', locationSource: node.location ? 'manual' : snapshot?.host?.location?.status === 'known' ? 'ip-geolocation' : 'unknown', maintenance: node.maintenance, removalOperationId: node.removalOperationId || null, removalState: node.removalOperationId ? 'removing' : null, local: false, online: state.online, status: node.removalOperationId ? 'removing' : state.online ? 'online' : 'offline', stale: !state.online, lastSeen: state.lastSeen || node.lastSeen || null, hostSampledAt: snapshot?.host?.sampledAt || state.sampledAt || null, latencyMs: state.latencyMs || null, error: state.error, version: snapshot?.version || null, agentId: node.agentId, fingerprint: node.fingerprint || null, hasToken: true, controlPlane, host, capabilities: snapshot?.capabilities || null, portAllocation: supportsAutomaticPorts(snapshot?.capabilities?.portAllocation) ? snapshot.capabilities.portAllocation : null, serverCount: rows.length, runningServers: state.online ? rows.filter(s => s.status === 'running').length : null, ...networkCache.get(node.id).value };
  }
  async function publicNodes() {
    refreshAll().catch(() => {});
    const local = await localManager.dashboard();
    const controlPlane = { kind: 'local-panel', service: 'vortex-panel', version: panelVersion, processId: process.pid, agentId: null,
      tls: { mode: 'in-process', endpoint: null, fingerprint: null } };
    return [{ id: 'local', name: localName(), endpoint: null, publicAddress: localTag({}).nodeAddress || local.host?.publicAddress || '', location: local.host?.location?.label || '', locationSource: local.host?.location?.status === 'known' ? 'ip-geolocation' : 'unknown', maintenance: false, local: true, online: true, status: 'online', stale: false, lastSeen: now(), hostSampledAt: local.host?.sampledAt || now(), latencyMs: 0, error: null, version: panelVersion, agentId: null, fingerprint: null, hasToken: false, controlPlane, host: local.host, capabilities: local.capabilities, portAllocation: supportsAutomaticPorts(local.capabilities?.portAllocation) ? local.capabilities.portAllocation : null, serverCount: local.servers.length, runningServers: local.servers.filter(s => s.status === 'running').length, ...networkSummary(local.servers) }, ...store.data.nodes.map(publicNode)];
  }
  async function locked(id, callback) {
    requireOpen();
    if (locks.has(id)) fail('A node configuration operation is already pending.', 409);
    locks.add(id); try { return await callback(); } finally { locks.delete(id); }
  }
  function commit(action, detail, user, mutation) {
    const oldNodes = store.data.nodes, oldActivity = store.data.activity, oldSettings = store.data.settings;
    mutation();
    try { store.audit(action, detail, user?.username || 'system'); }
    catch (error) { store.data.nodes = oldNodes; store.data.activity = oldActivity; store.data.settings = oldSettings; throw error; }
    emit({ type: 'update' });
  }
  function validateInput(input, previous) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['name', 'endpoint', 'publicAddress', 'location', 'maintenance', 'token', 'fingerprint'].includes(k))) fail('Invalid node settings.', 400);
    if (input.maintenance !== undefined && typeof input.maintenance !== 'boolean') fail('Node maintenance must be true or false.', 400);
    return { name: input.name === undefined && previous ? previous.name : input.name === undefined || input.name === '' ? '' : validateLabel(input.name, 'name', 80), endpoint: input.endpoint === undefined && previous ? previous.endpoint : validateNodeEndpoint(input.endpoint), publicAddress: input.publicAddress === undefined && previous ? previous.publicAddress : publicAddress(input.publicAddress), location: input.location === undefined && previous ? previous.location : validateLabel(input.location, 'location', 120, true), maintenance: input.maintenance ?? previous?.maintenance ?? false, fingerprint: input.fingerprint === undefined && previous ? previous.fingerprint : normalizeFingerprint(input.fingerprint) };
  }
  async function addImmediate(input, user) {
    return locked('create', async () => {
      if (store.data.nodes.length >= NODE_LIMITS.maxNodes) fail('The node limit has been reached.', 409);
      const fields = validateInput(input), id = randomUUID(), tokenEncrypted = secrets.seal(input.token, id);
      fields.name = naming.reserve(fields.name);
      fields.publicAddress ||= new URL(fields.endpoint).hostname.replace(/^\[|\]$/g, '');
      const candidate = { id, ...fields, tokenEncrypted, inventory: [], lastSeen: null, createdAt: now(), updatedAt: now() };
      let identity;
      try { identity = await request({ ...candidate, token: input.token }, { path: '/api/node/identity', timeoutMs: 10000, signal: shutdown.signal }); }
      catch (error) { if (error.status === 401) fail('Node authentication failed. Check the agent token.', 502); throw error; }
      if (identity?.service !== 'vortex-node' || identity.protocol !== 1 || !UUID.test(identity.nodeId)) fail('This endpoint is not a compatible Vortex Node agent.', 502);
      candidate.agentId = identity.nodeId;
      if (store.data.nodes.some(n => n.agentId === candidate.agentId || n.endpoint === candidate.endpoint)) fail('This node agent or endpoint is already linked.', 409);
      const snapshot = await probe(candidate);
      assertLocalMutation();
      candidate.inventory = snapshot.servers.map(compact); candidate.lastSeen = now();
      commit('node.link', candidate.name, user, () => { store.data.nodes = [...store.data.nodes, candidate]; });
      states.set(id, { online: true, lastSeen: now(), sampledAt: now(), snapshot, error: null });
      startEvents(id).catch(() => {}); return publicNode(candidate);
    });
  }
  function add(input, user) {
    requireOpen(); assertLocalMutation(); pendingAdds++;
    const run = addTail.then(() => { assertLocalMutation(); return addImmediate(input, user); }).finally(() => { pendingAdds--; });
    addTail = run.catch(() => {}); return run;
  }
  async function update(id, input, user) {
    return locked(id, async () => {
      if (id === 'local') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'name')) fail('Invalid node settings.', 400);
        const name = validateLabel(input.name, 'name', 80), observed = (await publicNodes())[0];
        requireOpen();
        commit('node.update', name, user, () => { store.data.settings = { ...store.data.settings, localNodeName: name }; });
        return { ...observed, name };
      }
      const previous = get(id);
      if (previous.removalOperationId || removal?.isRemoving(id)) fail('This VPS has an unresolved uninstall. Verify that operation before changing its connection.', 409);
      const fields = validateInput(input, previous), candidate = { ...previous, ...fields, updatedAt: now() };
      if (input.name !== undefined) candidate.name = naming.reserve(fields.name);
      if (input.token !== undefined) candidate.tokenEncrypted = secrets.seal(input.token, id);
      if (store.data.nodes.some(n => n.id !== id && n.endpoint === candidate.endpoint)) fail('This endpoint is already linked.', 409);
      const connectionChanged = candidate.endpoint !== previous.endpoint || candidate.fingerprint !== previous.fingerprint || input.token !== undefined;
      if (connectionChanged && (activeMutations.get(id) || 0) > 0) fail('Wait for active node operations before changing connection credentials.', 409);
      const snapshot = connectionChanged ? await probe(candidate) : null;
      assertLocalMutation();
      commit('node.update', candidate.name, user, () => { store.data.nodes = store.data.nodes.map(n => n.id === id ? candidate : n); });
      if (snapshot) acceptSnapshot(candidate, snapshot);
      if (connectionChanged) { stopEvents(id); startEvents(id).catch(() => {}); }
      return publicNode(candidate);
    });
  }
  async function remove(id, user) {
    return locked(id, async () => {
      const node = get(id);
      if ((activeMutations.get(id) || 0) > 0) fail('Wait for active node operations before unlinking this node.', 409);
      await refresh(id, { force: true });
      if (!stateOf(node).online) fail('Reconnect the node before removing its link so its inventory can be checked.', 409);
      if ((stateOf(node).snapshot?.servers || node.inventory).length) fail('This node still has servers. Remove them before unlinking the node.', 409);
      fail('Uninstall this VPS through the verified removal workflow before removing its link.', 409);
    });
  }
  async function beginRemoval(id, requestId, user) {
    if (id === 'local' || !UUID.test(requestId || '')) fail('Invalid worker uninstall target.', 400);
    return locked(id, async () => {
      assertLocalMutation();
      const node = get(id);
      if (node.removalOperationId) { if (node.removalOperationId === requestId) return; fail('Another worker uninstall requires review.', 409); }
      if ((activeMutations.get(id) || 0) > 0 || !stateOf(node).online || !stateOf(node).snapshot || stateOf(node).snapshot.servers.length) fail('The worker must have a known empty inventory with no active operations before uninstall.', 409);
      const previous = { ...node };
      try { commit('node.uninstall.begin', node.name, user, () => { node.removalOperationId = requestId; node.removalState = 'removing'; }); }
      catch (error) { for (const key of Object.keys(node)) if (!Object.hasOwn(previous, key)) delete node[key]; Object.assign(node, previous); throw error; }
    });
  }
  async function cancelRemoval(id, requestId, user) {
    return locked(id, async () => {
      const node = get(id);
      if (node.removalOperationId !== requestId) fail('The worker uninstall identity changed.', 409);
      const old = { ...node };
      try { commit('node.uninstall.cancel', node.name, user, () => { delete node.removalOperationId; delete node.removalState; }); }
      catch (error) { Object.assign(node, old); throw error; }
    });
  }
  async function completeRemoval(id, requestId, user, proof, completeJob) {
    if (id === 'local') fail('The main panel cannot be uninstalled through linked VPS management.', 400);
    return locked(id, async () => {
      const node = get(id);
      if (node.removalOperationId !== requestId || proof?.requestId !== requestId || proof.nodeId !== node.agentId || proof.verified !== true || proof.inventoryEmpty !== true || proof.serviceRemoved !== true || proof.filesVerified !== true || proof.processesAbsent !== true || proof.mountsAbsent !== true || proof.firewallRemoved !== true || proof.networkCountersRemoved !== true || proof.zramRemoved !== true || !Array.isArray(proof.remainingOwnedPaths) || proof.remainingOwnedPaths.length) fail('Independent worker uninstall verification is required before unlinking.', 409);
      if ((activeMutations.get(id) || 0) > 0 || node.inventory.length || (stateOf(node).snapshot?.servers || []).length) fail('The worker inventory changed during uninstall; its link was retained.', 409);
      const jobs = store.data.nodeRemovalJobs || [], jobStates = jobs.map(row => [row, structuredClone(row)]);
      try { commit('node.uninstall.complete', node.name, user, () => { completeJob?.(); store.data.nodes = store.data.nodes.filter(row => row.id !== id); }); }
      catch (error) { for (const [row, previous] of jobStates) { for (const key of Object.keys(row)) if (!Object.hasOwn(previous, key)) delete row[key]; Object.assign(row, previous); } store.data.nodeRemovalJobs = jobs; throw error; }
      stopEvents(id); states.delete(id); networkCache.delete(id); acknowledgements.delete(id); return { ok: true, verified: true };
    });
  }
  function requireAvailable(id, { create = false, mutating = false } = {}) {
    requireOpen(); const node = get(id);
    if (create || mutating) assertLocalMutation();
    if ((create || mutating) && (node.removalOperationId || removal?.isRemoving(id))) fail('This VPS is being uninstalled or requires uninstall verification.', 409);
    if ((create || mutating) && locks.has(id)) fail('A node configuration operation is already pending.', 409);
    if (!stateOf(node).online) fail('Node is offline. Its servers may still be running; no command was queued.', 503);
    if (create && node.maintenance) fail('This node is in maintenance and is not accepting new servers.', 409);
    return node;
  }
  function beginMutation(id, { placement = false } = {}) {
    assertLocalMutation();
    const node = requireAvailable(id, { create: placement, mutating: true });
    if (placement && (stateOf(node).snapshot?.servers || node.inventory).length + (activeMutations.get(id) || 0) >= NODE_LIMITS.serversPerNode) fail('The server inventory limit for this node has been reached.', 409);
    activeMutations.set(id, (activeMutations.get(id) || 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; const count = (activeMutations.get(id) || 1) - 1; if (count) activeMutations.set(id, count); else activeMutations.delete(id); } };
  }
  async function assertPortAllocation(node, input) {
    const automaticPorts = creationPortMode(input) === 'auto', application = ['nodejs', 'python'].includes(input?.kind);
    // Re-observe every creation, including manual ports and clones: older
    // workers must not silently choose RakNet under a newer control plane.
    const snapshot = validateSnapshot(node, await call(node, { path: '/api/node/snapshot', timeoutMs: 4000 }));
    if (!application) requireNetherNetCreationPolicy(snapshot.capabilities?.bedrockTransportPolicy);
    if (automaticPorts) requireAutomaticPorts(snapshot.capabilities?.portAllocation);
    if (application) {
      const capability = snapshot.capabilities?.applicationRuntime, rows = Array.isArray(capability?.runtimes) ? capability.runtimes : Object.entries(capability?.runtimes || {}).map(([kind, row]) => ({ kind, ...row }));
      if (capability?.managed !== true || capability.supported !== true || !rows.some(row => row.kind === input.kind && row.managedAvailable === true)) throw applicationIssue('APPLICATION_MANAGED_NODE_REQUIRED');
    }
  }
  async function createRemote(id, input, user) {
    const node = requireAvailable(id, { create: true });
    const finish = beginMutation(id, { placement: true });
    const body = { ...input }; delete body.nodeId;
    let value, sent = false;
    try { await assertPortAllocation(node, input); sent = true; value = await call(node, { path: '/api/servers', method: 'POST', body, headers: { 'X-Vortex-Actor': actorHeader(node, user) }, timeoutMs: 45000 }); }
    catch (error) { if (sent && !error.body) { markUnavailable(node, error); error.message = 'The node request outcome is unknown. No automatic retry was made; reconnect and check server/job history before trying again.'; } throw error; }
    finally { finish(); }
    rememberResponse(node, value);
    if (value.server) {
      const state = stateOf(node), rows = (state.snapshot?.servers || node.inventory).filter(s => s.id !== value.server.id);
      if (state.snapshot) state.snapshot.servers = [...rows, value.server];
      node.inventory = [...node.inventory.filter(s => s.id !== value.server.id), compact(value.server)];
      try { store.save(); } catch { value.warnings = [...(value.warnings || []), 'The server was created on the node, but its central offline inventory cache could not be saved. Refresh after reconnecting.']; }
    }
    refresh(id, { force: true }).catch(() => {});
    return mapNodeResponse(node, value, stateOf(node));
  }
  async function getJob(id) {
    const composite = splitNodeResourceId(id);
    if (!composite) return manager.jobs().find(job => job.id === id) || null;
    const user = actor.getStore();
    // Do not turn an unscoped job read into the trusted service-admin actor.
    if (!user || !(canAccessServer(user, id) || (user.serverIds || []).some(serverId => splitNodeResourceId(serverId)?.nodeId === composite.nodeId && canAccessServer(user, serverId)))) return null;
    const node = store.data.nodes.find(row => row.id === composite.nodeId);
    if (!node) return null;
    let value;
    // Preserve the canonical panel text for the controller's per-request
    // localization, rather than caching an English-only intermediate value.
    try { value = await call(node, { path: `/api/jobs/${composite.rawId}`, headers: { 'X-Vortex-Actor': actorHeader(node, user), 'Accept-Language': 'vi' } }); }
    catch (error) { if (error.status === 403 || error.status === 404) return null; throw error; }
    if (!validHistoryRow(value?.job) || value.job.id !== composite.rawId) fail('Node returned an invalid history identity.', 502);
    if ((value.job.adminOnly && user.role !== 'admin') || !canAccessServer(user, value.job.serverId ? nodeResourceId(node.id, value.job.serverId) : id)) return null;
    rememberResponse(node, value);
    return mapNodeRecord(node, value.job, 'job', stateOf(node));
  }
  const manager = new Proxy(localManager, {
    get(target, property) {
      if (property === 'listServers') return listServers;
      if (property === 'getServer') return id => listServers().find(s => s.id === id) || fail('Không tìm thấy server.', 404);
      if (property === 'withActor') return (user, callback) => actor.run(user, () => localManager.withActor(user, callback));
      if (property === 'jobs') return () => retainStoreHistory({ jobs: [...localManager.jobs().map(localTag), ...nodeRows('jobs'), ...(provisioner?.jobs() || []), ...(removal?.jobs() || []), ...(fleetRemoval?.jobs() || []), ...(fleetUpdate?.jobs() || [])], activity: [], servers: listServers(), schedules: [...localManager.schedules().map(localTag), ...nodeRows('schedules')] }, getLogRetentionPolicy(store.data.settings.logRetention)).jobs;
      if (property === 'getJob') return getJob;
      if (property === 'schedules') return () => [...localManager.schedules().map(localTag), ...nodeRows('schedules')];
      if (property === 'activity') return () => [...localManager.activity().map(localTag), ...nodeRows('activity')].sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 100);
      if (property === 'createServer') return input => {
        if (input?.nodeId === undefined || input.nodeId === 'local') {
          if (!input || typeof input !== 'object' || Array.isArray(input)) return localManager.createServer(input);
          const body = { ...input }; delete body.nodeId;
          return localManager.createServer(body);
        }
        if (typeof input.nodeId !== 'string' || !UUID.test(input.nodeId)) fail('Invalid node resource identity.', 400);
        return createRemote(input.nodeId, input, actor.getStore());
      };
      if (property === 'dashboard') return async () => {
        const value = await localManager.dashboard(); refreshAll().catch(() => {});
        return { ...value, servers: listServers(), jobs: manager.jobs(), activity: manager.activity(), nodes: await publicNodes() };
      };
      if (property === 'close') return async () => { await close(); await localManager.close(); };
      return Reflect.get(target, property);
    },
  });
  function beginFleetRemoval(input) {
    requireOpen();
    if (fleetUpdate?.isActive() || pendingAdds || locks.size || activeMutations.size || provisioner?.jobs().some(row => ['queued', 'running'].includes(row.status)) || removal?.jobs().some(row => ['queued', 'running', 'unknown', 'partial'].includes(row.status))) fail('Another node operation needs to finish before uninstall.', 409);
    return localManager.beginMaintenance(input);
  }
  function beginFleetUpdate(input){
    requireOpen();
    if(fleetRemoval?.isActive()||pendingAdds||locks.size||activeMutations.size||provisioner?.jobs().some(row=>['queued','running'].includes(row.status))||removal?.jobs().some(row=>['queued','running','unknown','partial'].includes(row.status)))fail('Another VPS operation needs to finish before updating.',409);
    if(listServers().some(server=>!['stopped','error'].includes(server.status)||server.busy))fail('Stop every server and finish all jobs before updating the panel.',409);
    return localManager.beginMaintenance(input);
  }
  async function initialize() {
    if (closed || timer) return;
    refreshAll().catch(() => {});
    for (const node of store.data.nodes) startEvents(node.id).catch(() => {});
    timer = setInterval(() => refreshAll().catch(() => {}), 5000); timer.unref();
  }
  async function close() {
    if (closed) return; closed = true; clearInterval(timer); shutdown.abort();
    await removal?.close(); await provisioner?.close();
    for (const id of new Set([...streams.keys(), ...retryTimers.keys(), ...eventTimers.keys()])) stopEvents(id);
    // Never stop agents or remote Bedrock processes when the controller closes.
  }
  return { manager, initialize, close, attachProvisioner(value) { provisioner = value; }, attachRemoval(value) { removal = value; }, attachFleetRemoval(value) { fleetRemoval = value; }, attachFleetUpdate(value){fleetUpdate=value;}, beginFleetUpdate, beginFleetRemoval, beginRemoval, cancelRemoval, completeRemoval, add, update, remove, get, publicNodes, publicNode, listServers, refresh, refreshAll, requireAvailable, beginMutation, assertPortAllocation, call, readJson, actorHeader, identityHeaders, gameNetworkHeaders: nodeGameNetworkHeaders, credentials, stateOf, signal: shutdown.signal, mapResponse: (node, value) => mapNodeResponse(node, value, stateOf(node)), recordResponse(node, value, { mutating = true } = {}) { if (mutating) rememberResponse(node, value); refresh(node.id, { force: true }).catch(() => {}); }, recordDeletedSchedule(node, rawId) { if (!UUID.test(rawId || '')) fail('Invalid schedule identity.', 400); let pending = acknowledgements.get(node.id); if (!pending) { pending = { servers: new Map(), jobs: new Map(), schedules: new Map() }; acknowledgements.set(node.id, pending); } pending.schedules.delete(rawId); pending.schedules.set(rawId, { revision: ++observation, row: null }); while (pending.schedules.size > 2000) pending.schedules.delete(pending.schedules.keys().next().value); const state = stateOf(node); if (state.snapshot) state.snapshot.schedules = state.snapshot.schedules.filter(row => row.id !== rawId); emit({ type: 'update' }); }, recordDeletedServer(node, rawId) { const id = nodeResourceId(node.id, rawId); let pending = acknowledgements.get(node.id); if (!pending) { pending = { servers: new Map(), jobs: new Map(), schedules: new Map() }; acknowledgements.set(node.id, pending); } pending.servers.set(rawId, { revision: ++observation, row: null }); const state = stateOf(node); if (state.snapshot) state.snapshot.servers = state.snapshot.servers.filter(s => s.id !== rawId); node.inventory = node.inventory.filter(s => s.id !== rawId); for (const user of store.data.users) user.serverIds = (user.serverIds || []).filter(value => value !== id); let warning; try { store.save(); } catch { warning = 'The server was deleted on the node, but its central inventory/grant cleanup could not be saved. Refresh after reconnecting.'; } emit({ type: 'update' }); return warning; }, request, get limits() { return { ...NODE_LIMITS, nextNodeName: naming.preview() }; } };
}
