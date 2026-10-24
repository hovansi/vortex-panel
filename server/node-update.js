import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runPanelUpdateHelper } from './panel-update.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MACHINE = /^[a-f0-9]{32}$/;
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const actions = new Set(['plan', 'prepare', 'launch', 'status', 'verify', 'verify-rollback', 'attest', 'abort']);
const direct = new Set(['plan', 'prepare', 'attest']);
const bodyKeys = ['schemaVersion', 'role', 'nodeId'];
const approvalKeys = [...bodyKeys, 'requestId', 'revision', 'installationId', 'version', 'manifestSHA256', 'archiveSHA256'];
const fail = (message, status = 409, fields = {}) => Object.assign(new Error(message), { code: 'NODE_UPDATE', status, ...fields });

export const NODE_UPDATE_PROTOCOL = 1;
export function isNodeUpdateControl(method, pathname) {
  const match = typeof pathname === 'string' && /^\/node\/update\/([a-z-]+)$/.exec(pathname);
  return method === 'POST' && Boolean(match && actions.has(match[1]));
}

// This is a fixed-purpose control-plane API. The bearer and TLS pin authenticate
// its caller; neither a filesystem path nor an executable is request input.
export function createNodeUpdateAgent({ nodeId, dataDir, manager, native = runPanelUpdateHelper,
  filesystem = fs, platform = process.platform, uid = process.getuid?.(),
  helperPath = new URL('./fleet-update.py', import.meta.url), installRoot = '/opt/vortex-node' } = {}) {
  if (!UUID.test(nodeId || '') || !dataDir || !manager) throw new Error('Worker update requires a fixed identity, data directory and manager.');
  const fixedHelper = helperPath instanceof URL ? fileURLToPath(helperPath) : helperPath;
  const intentFile = path.join(dataDir, '.panel-update-intent.json');
  let closed = false, mutation;
  const releases = new Map();
  function validate(action, input) {
    const keys = action === 'plan' ? bodyKeys : ['prepare', 'attest'].includes(action) ? approvalKeys : [...bodyKeys, 'requestId'];
    if (!actions.has(action) || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
      || Object.keys(input).some(key => !keys.includes(key)) || input.schemaVersion !== 1 || input.role !== 'worker' || input.nodeId !== nodeId
      || action !== 'plan' && !UUID.test(input.requestId || '')
      || ['prepare', 'attest'].includes(action) && (!VERSION.test(input.version || '') || ['revision', 'installationId', 'manifestSHA256', 'archiveSHA256'].some(key => !SHA.test(input[key] || '')))) {
      throw fail('The worker update request does not match this installed node.', 400);
    }
    return Object.fromEntries(keys.map(key => [key, key === 'role' ? 'worker' : key === 'nodeId' ? nodeId : input[key]]));
  }
  async function safe(filename, { directory = false, privateMode = false, maximum } = {}) {
    if (!path.posix.isAbsolute(filename) || path.posix.normalize(filename) !== filename) throw fail('The worker update path is not canonical.', 503);
    const parents = [];
    for (let current = path.posix.dirname(filename); ; current = path.posix.dirname(current)) {
      parents.unshift(current); if (current === '/') break;
    }
    for (const parent of parents) {
      const info = await filesystem.lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022) throw fail('The worker update path is not exclusively trusted.', 503);
    }
    const info = await filesystem.lstat(filename);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      || info.uid !== 0 || info.mode & (privateMode ? 0o077 : 0o022) || maximum !== undefined && (info.size < 1 || info.size > maximum)) {
      throw fail('The worker update input is not exclusively trusted.', 503);
    }
    return info;
  }
  async function read(filename, maximum, privateMode = true) {
    const before = await safe(filename, { maximum, privateMode }), value = await filesystem.readFile(filename);
    const after = await safe(filename, { maximum, privateMode });
    if (value.length !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail('The worker update input changed during verification.', 503);
    return value;
  }
  async function helper(action, requestId) {
    if (direct.has(action)) { await safe(fixedHelper, { maximum: 256 * 1024 }); return fixedHelper; }
    await safe(installRoot, { directory: true });
    const base = `${installRoot}/updates`, root = `${base}/${requestId}`;
    try { await filesystem.lstat(base); }
    catch (error) { if (error.code === 'ENOENT' && action === 'status') { await safe(fixedHelper, { maximum: 256 * 1024 }); return fixedHelper; } throw error; }
    await safe(base, { directory: true, privateMode: true });
    try { await filesystem.lstat(root); }
    catch (error) { if (error.code === 'ENOENT' && action === 'status') { await safe(fixedHelper, { maximum: 256 * 1024 }); return fixedHelper; } throw error; }
    await safe(root, { directory: true, privateMode: true });
    let record;
    try { record = JSON.parse((await read(`${root}/request.json`, 2 * 1024 ** 2)).toString('utf8')); }
    catch (error) { throw error.code === 'NODE_UPDATE' ? error : fail('The staged worker update receipt could not be verified.', 503); }
    const machine = (await read('/etc/machine-id', 1024, false)).toString('utf8').trim();
    if (record?.schemaVersion !== 1 || record.role !== 'worker' || record.nodeId !== nodeId || record.requestId !== requestId
      || !MACHINE.test(machine) || record.machineId !== machine || !SHA.test(record.installationId || '')) throw fail('The staged update belongs to another worker installation.', 503);
    if (!Object.hasOwn(record, 'helperSHA256') && action === 'status' && ['preparing', 'failed'].includes(record.status)) {
      // Preparation may fail before a helper digest is committed. Only the
      // installed trusted helper may inspect that incomplete receipt.
      await safe(fixedHelper, { maximum: 256 * 1024 }); return fixedHelper;
    }
    if (!SHA.test(record.helperSHA256 || '')) throw fail('The staged worker update helper has no trusted digest.', 503);
    const staged = `${root}/helper.py`, bytes = await read(staged, 256 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== record.helperSHA256) throw fail('The staged worker update helper changed.', 503);
    return staged;
  }
  async function intentAbsent() {
    try { await filesystem.lstat(intentFile); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  async function releaseSettled(requestId, value) {
    if ((['absent', 'failed', 'cancelled'].includes(value?.status) || value?.independentlyVerified === true && (value.verified === true || value.rolledBack === true)) && await intentAbsent()) {
      releases.get(requestId)?.(); releases.delete(requestId); manager.maintenanceStatus?.();
    }
  }
  async function inspectFailure(requestId) {
    try { const value = await native(await helper('status', requestId), 'status', { schemaVersion: 1, role: 'worker', nodeId, requestId }); await releaseSettled(requestId, value); }
    catch { /* An uncertain native outcome retains admission for recovery. */ }
  }
  async function request(action, rawInput) {
    const input = validate(action, rawInput);
    if (closed || platform !== 'linux' || uid !== 0) throw fail('Worker source updates require the managed root Linux service.', 503);
    const maintenance = manager.maintenanceStatus?.();
    if (maintenance?.active && (maintenance.action !== 'update' || action !== 'plan' && maintenance.requestId !== input.requestId)) throw fail('Another system operation is pending on this worker.');
    if (action === 'plan') {
      const inspect = async () => native(await helper(action), action, input);
      return maintenance?.active ? inspect() : manager.withHostOperation(inspect);
    }
    if (action === 'status') {
      const value = await native(await helper(action, input.requestId), action, input);
      if (!mutation) await releaseSettled(input.requestId, value);
      return value;
    }
    if (mutation) throw fail('A worker update control operation is already running.');
    // Freeze admission synchronously before any filesystem or native await.
    const release = manager.beginMaintenance({ action: 'update', requestId: input.requestId });
    releases.set(input.requestId, release); mutation = input.requestId;
    try {
      const value = await native(await helper(action, input.requestId), action, input);
      manager.maintenanceStatus?.();
      if (action === 'attest' && await intentAbsent()) { release(); releases.delete(input.requestId); }
      else await releaseSettled(input.requestId, value);
      return value;
    } catch (error) {
      if (action === 'launch') error.outcomeUnknown = true;
      if (action === 'attest' && await intentAbsent().catch(() => false)) { release(); releases.delete(input.requestId); }
      else await inspectFailure(input.requestId);
      throw error;
    } finally { mutation = undefined; }
  }
  return { request, close() { closed = true; } };
}
