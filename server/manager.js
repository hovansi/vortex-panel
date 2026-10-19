import {createServerAppearance,publicServerAppearance} from './server-appearance.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createVersionService } from './versions.js';
import { extractZip, verifyZip, zipDirectory, validateBedrockPackage } from './archives.js';
import { inspectPacks, importPacks, setPackEnabled, removePack } from './packs.js';
import { validateServerSettings, validateBedrockProperties, debuggerPort } from './configuration.js';
import { fail, safePath, cleanRelative, atomicWrite, walkFiles, parseProperties, serializeProperties, validateProperties, validateNetwork, parseUdpPorts, defaultUdpPorts } from './safety.js';
import { validatePlayerLists, playerListFiles, commitPlayerListFiles, playerListsRevision, assertPlayerListRevision } from './player-lists.js';
import { createFileOperations, readTextFile, fileRevision, filePath, FILE_LIMITS } from './file-operations.js';
import { bedrockLogLevel } from './bedrock-log.js';
import { WORLD_LIMITS, validateWorldName, validateWorldSeed, existingWorldNames, worldTarget, unpackWorld, inspectSupportedWorld } from './worlds.js';
import { buildWorldVoice, WorldVoiceValidationError, worldVoiceErrorText } from '../public/world-voice.js';
import { serverMessageLanguage, serverWorldVoiceEnabled, createNativeWorldVoice, announceGracefulWorldPause, dispatchConsoleLine } from './server-voice.js';
import { updateJobProgress } from './job-progress.js';
import { GAME_RULES, GAME_ITEMS, PLAYER_ACTIONS, validateRuleQuery, validateRuleChanges, buildPlayerAction, parseNativeRuleResponse, executePlayerAction, createGameplayConsole, nativeGameplayBody, trackGameplayPlayer, connectedGameplayPlayers, assertGameplayPlayer, applyGameRuleChanges } from './gameplay.js';
import { createResourceController, normalizeResourcePolicy } from './resource-control.js';
import { LOG_RETENTION_DEFAULTS, createBoundedConsoleRing, createBoundedConsoleWriter, createUtf8LineConsumer } from './log-retention.js';
import { canonicalOperationsError } from './gameplay-messages.js';
import { recordResourceExit, memoryLimitExitMessage } from './resource-exit.js';
import { createCapacityGate, evaluateCapacity, assertMemoryHeadroom, serverCapacityAllocation, SHARED_ADMISSION_RESERVATION } from './capacity.js';
import { normalizeStoragePolicy, GIB } from './storage-policy.js';
import { createStorageController } from './storage-volumes.js';
import { createNetworkMetrics } from './network-metrics.js';
import { assertUnmountedTree } from './mount-safety.js';
import { createBackupConsole, snapshotLiveServer } from './live-backup.js';
import { createApplicationRuntime, normalizeApplication, publicApplication } from './application-runtime.js';
import { applicationIssue } from './application-schema.js';
import { publicRuntimePin, normalizeRuntimePin } from './application-runtime-catalog.js';
import { createPortAllocator, creationPortMode, PORT_ALLOCATION_POLICY } from './port-allocation.js';
import { validateSchedule, dispatchScheduledCommand } from './schedule-commands.js';

const appKind = server => ['nodejs','python'].includes(server?.kind) ? server.kind : 'bedrock';
const isApp = server => appKind(server) !== 'bedrock';
const startupSummary = server => server.application?.startup?.mode === 'npm-script' ? { mode: 'npm-script', script: server.application.startup.script } : server.application?.startup?.mode === 'python-module' ? { mode: 'python-module', module: server.application.startup.module } : { mode: 'entrypoint' };
const appRevision = server => createHash('sha256').update(JSON.stringify([server.id,server.kind,server.port,server.application])).digest('hex');

const MUTABLE = ['worlds/', 'config/', 'keys/', 'server.properties', 'allowlist.json', 'permissions.json', 'valid_known_packs.json', 'server_identity_key.pem'];
const mutable = name => MUTABLE.some(prefix => name === prefix || (prefix.endsWith('/') && name.startsWith(prefix)));
const now = () => new Date().toISOString();
const backupVerificationSubject = Symbol('backupVerificationSubject');
const defaultProperties = server => ({ 'server-name': server.name, gamemode: 'survival', difficulty: 'normal', 'allow-cheats': 'false', 'max-players': String(server.maxPlayers), 'online-mode': 'true', 'allow-list': 'false', 'server-port': String(server.port), 'server-portv6': String(server.portV6), 'view-distance': '16', 'tick-distance': '4', 'player-idle-timeout': '30', 'max-threads': '8', 'level-name': 'Bedrock level', 'level-seed': '', 'default-player-permission-level': 'member', 'texturepack-required': 'false', transport: server.transport === 'nethernet' ? 'nethernet' : 'raknet', ...(server.transport === 'nethernet' ? { 'server-udp-ports': server.udpPorts } : {}), 'enable-lan-visibility': 'false' });

async function copyEmptyDirectories(source, destination, { exclude = () => false } = {}) {
  const pending = [{ relative: '', depth: 0 }]; let count = 0;
  while (pending.length) {
    const { relative, depth } = pending.pop();
    const entries = await fs.readdir(path.join(source, relative), { withFileTypes: true });
    if (!entries.length && relative) await fs.mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (++count > 50000 || depth >= 128) fail('Dữ liệu sao chép vượt giới hạn số mục hoặc độ sâu.');
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('Dữ liệu sao chép chứa liên kết hoặc tệp đặc biệt.', 409);
      if (entry.isDirectory() && !exclude(name)) pending.push({ relative: name, depth: depth + 1 });
    }
  }
}

export async function ensureServerIdentity(runRoot) {
  const destination = await safePath(runRoot, 'keys/server_identity_key.pem', { allowMissing: true });
  try {
    const existing = await fs.stat(destination);
    if (!existing.isFile()) fail('Identity key phải là tệp PEM thông thường.', 409);
    await fs.chmod(destination, 0o600); return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await fs.writeFile(destination, privateKey, { flag: 'wx', mode: 0o600 });
  return destination;
}

export async function createManager({ store, dataDir, emit = () => {}, reserveRatio = 0.1, resourceController = createResourceController({ reserveRatio }), storageController = createStorageController({ dataDir }), networkMetrics = createNetworkMetrics({ dataDir }), applicationController, hostReader, portAllocator }) {
  const applicationRuntime = applicationController || createApplicationRuntime({dataDir,resourceController,storageController});
  const allocatePorts = portAllocator || createPortAllocator({ protectedPorts: [Number(process.env.PORT)].filter(port => Number.isInteger(port) && port > 0 && port <= 65535) });
  let applicationControl = {supported:false,engine:'bubblewrap',runtimes:[],reason:'Application runtime has not been checked.'};
  const versionService = createVersionService({ store, dataDir, emit, audit: (...args) => audit(...args), reserveDisk: bytes => reservePackageWorkspace(bytes) });
  const processes = new Map();
  const logBuffers = new Map();
  const consoleRuns = new Map();
  const logWriters = new Map();
  const resourceCleanup = new Set();
  const gameplayRuns = new Set();
  let resourceControl = await resourceController.capabilities();
  const restartTimers = new Map();
  const crashes = new Map();
  const runningJobs = new Set();
  const jobPromises = new Map();
  const lifecycle = new Map();
  const lifecycleIntents = new Map();
  const scheduleRuns = new Map();
  const scheduleLocks = new Map();
  const scheduleContext = new AsyncLocalStorage();
  const operations = new Map();
  const hostOperations = new Set();
  const fileAccessContext = new AsyncLocalStorage();
  const pendingNetworks = new Map();
  // Keep both old and candidate ports reserved until commit; a failed move must
  // never restore ports which another server acquired while file I/O awaited.
  const networkServers = () => [...store.data.servers, ...[...pendingNetworks].map(([id, fields]) => ({ ...store.data.servers.find(server => server.id === id), ...fields, id }))];
  const operationContext = new AsyncLocalStorage();
  const actorContext = new AsyncLocalStorage();
  const serverMetrics = new Map();
  const storageMetrics = new Map();
  const pendingDisk = new Map();
  const runtimeBuilds = new Map();
  const applicationProjects = new Map();
  const applicationProjectInstallStates = new Map();
  const packageWorkspaces = new Map(), packageContext = new AsyncLocalStorage();
  const PACKAGE_WORKSPACE_BYTES = 3 * GIB;
  const storagePaused = new Set(), deferredLogs = new Map();
  let lastHost = null, metricsSampledAt = null, storageControl = await storageController.capabilities();
  let collectingMetrics = null;
  const capacityGate = createCapacityGate({ readHost: async () => {
    await applicationRuntime.assertNoPendingBuilds?.();
    const host = await capacityHostInfo();
    const pending = [...pendingDisk.values()].reduce((sum, value) => sum + value, 0);
    return { ...host, diskAvailableBytes: Math.max(0, (host.diskAvailableBytes ?? host.diskAvailable ?? host.disk?.availableBytes ?? host.diskTotal - host.diskUsed) - pending) };
  }, listServers: () => capacityServers(), reserveRatio });
  const capacityServers = () => store.data.servers.map(server => {
    const runtime = processes.get(server.id);
    // MemAvailable already credits reclaimable page cache. Only anonymous
    // charged memory gets an additional managed-process credit here, otherwise
    // cache could incorrectly hide memory consumed by unrelated applications.
    return { ...server, ...(runtimeBuilds.has(server.id) ? { resourcePolicy: runtimeBuilds.get(server.id).resourcePolicy } : {}), pid: runtime?.child.pid || null, capacityUsage: runtime?.sampledAt ? { memoryBytes: runtime.resourceUsage?.memoryAnonymousBytes ?? 0, sampledAt: runtime.sampledAt } : null };
  });
  async function reserveRuntimeBuild(server, resources) {
    // The target is installing and cannot run simultaneously. Credit its
    // existing reservation, while exposing any larger temporary build ceiling
    // to every other admission check until the builder is completely drained.
    const id = `runtime:${server.id}`, allocation = serverCapacityAllocation(server), candidate = { ...server, resourcePolicy: { mode: 'fixed', cpuCores: Math.max(allocation.cpuCores, resources.cpuCores), memoryMiB: Math.max(allocation.memoryMiB, resources.memoryMiB) } };
    await capacityGate.run({ candidate, replaceServerId: server.id, additionalDiskBytes: resources.diskBytes }, () => { assertOpen(); if (runtimeBuilds.has(server.id)) throw applicationIssue('APPLICATION_BUSY'); runtimeBuilds.set(server.id, candidate); pendingDisk.set(id, resources.diskBytes); });
    let released = false; return () => { if (!released) { released = true; runtimeBuilds.delete(server.id); pendingDisk.delete(id); } };
  }
  async function reserveDiskWorkspace(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) fail('Invalid disk workspace reservation.', 400);
    const key = `workspace:${randomUUID()}`;
    await capacityGate.run({ additionalDiskBytes: bytes }, () => { assertOpen(); pendingDisk.set(key, bytes); });
    let released = false;
    return () => { if (!released) { released = true; pendingDisk.delete(key); } };
  }
  async function reservePackageWorkspace(bytes) {
    const id = packageContext.getStore();
    if (id && packageWorkspaces.get(id) >= bytes) return () => { packageWorkspaces.delete(id); pendingDisk.delete(`package:${id}`); };
    return reserveDiskWorkspace(bytes);
  }
  const history = [];
  let closed = false;
  let maintenance = null, maintenanceProbe;
  let initialized = false;
  let scheduler;
  let metricsTimer;
  let releaseTimer;
  let scheduleBusy = false;
  let lastLogMaintenance = 0;
  const root = path.join(dataDir, 'servers');
  const clockTicks = process.platform === 'linux' ? Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim()) || 100 : 100;
  const directory = server => path.join(root, server.id);
  const runDirectory = server => path.join(directory(server), 'run');
  const get = id => store.data.servers.find(server => server.id === id) || fail('Không tìm thấy server.', 404);
  const getSchedule = id => store.data.schedules.find(schedule => schedule.id === id) || fail('Không tìm thấy lịch.', 404);
  const logPolicy = () => store.historyPolicy?.() || LOG_RETENTION_DEFAULTS;
  const serverPolicy = server => normalizeResourcePolicy(server.resourcePolicy);
  const storagePolicy = server => normalizeStoragePolicy(server.storagePolicy, { legacy: true });
  const ensureStorage = server => storagePolicy(server).mode === 'unlimited' ? Promise.resolve() : storageController.ensureMounted(server);
  const serverResources = server => ({ configured: serverPolicy(server), effective: processes.get(server.id)?.resourceHandle?.effective || null, usage: processes.get(server.id)?.resourceUsage || null, allocation: serverCapacityAllocation(server), capacityCredit: serverCapacityAllocation(server), cleanupPending: server.resourceCleanupPending || null, lastExit: server.lastResourceExit || null });
  const telemetry = server => {
    const policy = serverPolicy(server), runtime = processes.get(server.id), active = Boolean(runtime);
    const pool = resourceControl.managedPool;
    const poolCores = pool?.cpuCores ?? (lastHost?.cpus ? lastHost.cpus * 0.9 : null);
    const poolMemory = pool?.memoryMiB ? pool.memoryMiB * 1024 ** 2 : lastHost?.memoryTotal ? Math.floor(lastHost.memoryTotal * 0.9) : null;
    const cores = policy.mode === 'fixed' ? Math.min(policy.cpuCores, poolCores ?? policy.cpuCores) : poolCores;
    const memory = policy.mode === 'fixed' ? Math.min(policy.memoryMiB * 1024 ** 2, poolMemory ?? policy.memoryMiB * 1024 ** 2) : poolMemory;
    const stale = Boolean(runtime && (!runtime.sampledAt || Date.now() - Date.parse(runtime.sampledAt) > 15000));
    const network = networkMetrics.peek(server.id);
    return { sampledAt: runtime?.sampledAt || metricsSampledAt, stale,
      cpu: { usedCores: stale ? null : active ? runtime.cpuUsedCores ?? null : 0, totalCores: cores, usedPercent: stale ? null : active ? runtime.cpuUsedCores != null ? runtime.cpuUsedCores * 100 : null : 0, scope: runtime?.cpuScope || 'process', limitSource: policy.mode === 'fixed' ? 'fixed' : 'shared-pool' },
      memory: { usedBytes: stale ? null : active ? runtime.resourceUsage?.memoryCurrentBytes ?? runtime.memoryBytes ?? null : 0, totalBytes: memory, scope: runtime?.resourceUsage?.memoryCurrentBytes != null ? 'cgroup-memory-current' : 'process-rss', limitSource: policy.mode === 'fixed' ? 'fixed' : 'shared-pool' },
      storage: storagePaused.has(server.id) ? { usedBytes: null, totalBytes: null, availableBytes: null, limitBytes: null, hardEnforced: false, sampledAt: now(), reason: 'Storage maintenance is in progress.', maintenance: true } : storageMetrics.get(server.id) || { usedBytes: null, totalBytes: null, availableBytes: null, limitBytes: storagePolicy(server).diskGiB === null ? null : storagePolicy(server).diskGiB * GIB, hardEnforced: false, sampledAt: null, reason: 'Storage has not been sampled.' },
      network: network || { available: false, rxBytes: null, txBytes: null, rxBytesPerSecond: null, txBytesPerSecond: null, sampledAt: null, scope: 'server-game-ports', reason: active ? 'Network counters are warming up.' : 'Server is stopped.' } };
  };
  const maintenanceMessage = () => ['zram', 'uninstall', 'update'].includes(maintenance?.action)
    ? 'Đang áp dụng thay đổi hệ thống. Hãy chờ hoàn tất.'
    : 'Hệ thống đang chuẩn bị khởi động lại; vui lòng chờ kết nối trở lại.';
  const assertOpen = () => { maintenanceProbe?.(); if (closed) fail('Panel đang tắt; không nhận thao tác mới.', 503); if (maintenance) fail(maintenanceMessage(), 409); };
  function withHostOperation(callback) {
    assertOpen();
    if (typeof callback !== 'function') fail('Thao tác hệ thống không hợp lệ.', 400);
    // Register admission before yielding to a system command or async callback.
    const promise = Promise.resolve().then(callback);
    hostOperations.add(promise);
    return promise.finally(() => { hostOperations.delete(promise); });
  }
  function beginMaintenance(input) {
    if (!input || !['restart-service', 'reboot', 'zram', 'uninstall', 'update'].includes(input.action) || typeof input.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId)) fail('Yêu cầu khởi động lại không hợp lệ.', 400);
    if (closed) fail('Panel đang tắt; không nhận thao tác mới.', 503);
    if (maintenance) { if (maintenance.requestId === input.requestId && maintenance.action === input.action) return maintenance.release; fail(maintenanceMessage(), 409); }
    if (input.restore !== true && (hostOperations.size || operations.size || lifecycle.size || runningJobs.size || scheduleRuns.size || scheduleLocks.size || gameplayRuns.size || resourceCleanup.size || pendingDisk.size || packageWorkspaces.size || storagePaused.size || store.data.servers.some(server => server.jobId || server.cloneJobId || ['starting', 'stopping', 'installing'].includes(server.status) || processes.get(server.id)?.gameplay?.busy))) fail('Đang có tác vụ chưa hoàn tất. Chờ hoàn tất trước khi khởi động lại hệ thống.', 409);
    const record = { action: input.action, requestId: input.requestId };
    let released = false;
    record.release = () => { if (!released) { released = true; if (maintenance === record) maintenance = null; } };
    maintenance = record;
    return record.release;
  }
  const publicServer = server => ({ id: server.id, appearance: publicServerAppearance(server), kind: appKind(server), application: isApp(server) ? publicApplication(server.application) : null, runtime: isApp(server) && server.runtime ? publicRuntimePin(server.runtime) : null, applicationRuntime: isApp(server) ? { ...(processes.get(server.id)?.applicationRuntime || {}), readiness: server.application?.readiness || 'tcp', ready: Boolean(processes.get(server.id)?.ready) } : null, consoleRunId: consoleRun(server), name: server.name, version: server.version, channel: server.channel, port: server.port, portV6: server.portV6, debugPort: server.debugPort ?? null, transport: server.transport || 'raknet', udpPorts: server.udpPorts || null, maxPlayers: server.maxPlayers, players: server.players || 0, status: server.status, createdAt: server.createdAt, autoRestart: Boolean(server.autoRestart), autoStart: Boolean(server.autoStart), backupRetention: server.backupRetention || 10, messageLanguage: serverMessageLanguage(server), worldVoiceEnabled: !isApp(server) && serverWorldVoiceEnabled(server), resourcePolicy: serverPolicy(server), storagePolicy: storagePolicy(server), resources: serverResources(server), telemetry: telemetry(server), memoryMB: server.memoryMB || 0, cpuPercent: server.cpuPercent || 0, uptime: processes.has(server.id) ? Math.floor((Date.now() - processes.get(server.id).startedAt) / 1000) : 0, error: server.error || null, recoveryRequired: Boolean(server.restoreRecoveryRequired), busy: Boolean(server.jobId || server.cloneJobId || lifecycle.has(server.id) || operations.has(server.id) || scheduleLocks.has(server.id) || processes.get(server.id)?.gameplay?.busy), pid: processes.get(server.id)?.child.pid || null });
  const persist = () => { store.save(); emit({ type: 'update' }); };
  const audit = (action, detail, user, detailI18n, serverId) => store.audit(action, detail, user || actorContext.getStore()?.username || 'system', detailI18n, serverId);
  const commitServerFields = (server, fields, action, detail = server.name) => {
    const before = Object.fromEntries(Object.keys(fields).map(key => [key, { exists: Object.hasOwn(server, key), value: server[key] }]));
    const activity = store.data.activity;
    Object.assign(server, fields);
    store.data.activity = [{ id: randomUUID(), time: now(), action, detail, serverId: server.id, user: actorContext.getStore()?.username || 'system' }, ...activity];
    try { store.save(); }
    catch (error) { for (const [key, value] of Object.entries(before)) { if (value.exists) server[key] = value.value; else delete server[key]; } store.data.activity = activity; throw error; }
  };
  const appearanceController = createServerAppearance({dataDir,getServer:get,commit:(server,appearance)=>commitServerFields(server,{appearance},'server.appearance',server.name),emit});
  const deletionAudit = (action, detail, quarantine, serverId) => ({ id: randomUUID(), time: now(), action, serverId, detail: `${detail}${quarantine ? ` [quarantine: ${quarantine.relative}]` : ''}`, user: actorContext.getStore()?.username || 'system' });
  async function quarantineDeletion(relative, type, { optional = false } = {}) {
    // Resolve from DATA_DIR, not from a server root which could itself be a link.
    const source = await safePath(dataDir, relative, { allowMissing: optional });
    const stat = await fs.lstat(source).catch(error => { if (optional && error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    if ((type === 'server' && !stat.isDirectory()) || (type === 'backup' && !stat.isFile()) || stat.isSymbolicLink()) fail('Đối tượng xóa phải là thư mục server hoặc tệp backup thông thường.', 409);
    if (type === 'server') await assertUnmountedTree(source);
    const basename = path.posix.basename(relative), nonce = randomUUID();
    let quarantineName = `.vortex-delete-${type}-${basename}-${nonce}`;
    // A valid 255-byte world name still needs room for the ownership marker.
    // Keep its exact source path for rollback/audit; only the staging name uses
    // a fixed-size digest when the original would exceed a filesystem component.
    if (Buffer.byteLength(quarantineName) > 255) quarantineName = `.vortex-delete-${type}-${createHash('sha256').update(basename).digest('hex')}-${nonce}`;
    const quarantineRelative = path.posix.join(path.posix.dirname(relative), quarantineName);
    const quarantine = await safePath(dataDir, quarantineRelative, { allowMissing: true });
    if (await fs.lstat(quarantine).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) fail('Đường dẫn cách ly đã tồn tại.', 409);
    await fs.rename(source, quarantine);
    return { source, sourceRelative: relative, path: quarantine, relative: quarantineRelative, type, ino: stat.ino, dev: stat.dev };
  }
  async function deletionPath(record) {
    const current = await safePath(dataDir, record.relative);
    const stat = await fs.lstat(current);
    if (current !== record.path || stat.ino !== record.ino || stat.dev !== record.dev || (record.type === 'server' ? !stat.isDirectory() : !stat.isFile())) fail('Đối tượng cách ly đã thay đổi; cần kiểm tra dữ liệu thủ công.', 409);
    if (record.type === 'server') await assertUnmountedTree(current);
    return current;
  }
  async function rollbackDeletion(record, error) {
    if (!record) return;
    try {
      const quarantine = await deletionPath(record);
      const original = await safePath(dataDir, record.sourceRelative, { allowMissing: true });
      if (original !== record.source || await fs.lstat(original).catch(value => { if (value.code === 'ENOENT') return null; throw value; })) fail('Đường dẫn khôi phục đã thay đổi hoặc đã có dữ liệu.', 409);
      await fs.rename(quarantine, original);
    } catch (rollbackError) { error.message += `; dữ liệu vẫn được cách ly tại ${record.relative}: ${rollbackError.message}`; }
  }
  async function finishDeletion(record) {
    if (!record) return { ok: true };
    try { await fs.rm(await deletionPath(record), { recursive: record.type === 'server', force: false }); return { ok: true }; }
    catch (error) {
      const warning = `Đã lưu thao tác xóa; còn dữ liệu cách ly tại ${record.relative}. Quản trị viên cần kiểm tra trước khi dọn: ${error.message}`;
      console.warn(`[Vortex Panel] ${warning}`);
      return { ok: true, warnings: [warning], cleanupPending: record.relative };
    }
  }
  async function deleteBackupRecord(server, record, action = 'backup.delete') {
    if (record.locked === true) fail('Bản sao lưu đang được khóa; hãy mở khóa trước khi xóa.', 409);
    const quarantine = await quarantineDeletion(`servers/${server.id}/backups/${record.id}.zip`, 'backup', { optional: true });
    const backups = server.backups, activity = store.data.activity;
    try {
      server.backups = backups.filter(item => item.id !== record.id);
      store.data.activity = [deletionAudit(action, `${server.name}: ${record.name}`, quarantine, server.id), ...activity];
      store.save();
    } catch (error) { server.backups = backups; store.data.activity = activity; await rollbackDeletion(quarantine, error); throw error; }
    emit({ type: 'update' });
    return finishDeletion(quarantine);
  }
  const consoleRun = server => { if (!consoleRuns.has(server.id)) consoleRuns.set(server.id, randomUUID()); return consoleRuns.get(server.id); };
  const ring = server => { if (!logBuffers.has(server.id)) logBuffers.set(server.id, createBoundedConsoleRing({ limits: logPolicy })); return logBuffers.get(server.id); };
  const resetConsole = server => {
    const runId = randomUUID(); consoleRuns.set(server.id, runId); ring(server).replace([]);
    emit({ type: 'console-reset', serverId: server.id, runId });
    return runId;
  };
  const writer = server => { if (!logWriters.has(server.id)) logWriters.set(server.id, createBoundedConsoleWriter({ serverRoot: directory(server), limits: logPolicy, onWarning: error => console.warn(`[Vortex Panel] Console retention ${server.id}: ${error.code || 'LOG_WRITE_FAILED'}`) })); return logWriters.get(server.id); };
  const log = (server, message, level = 'info', source = level === 'command' ? 'command' : 'panel') => {
    const runId = consoleRun(server);
    const entry = ring(server).append({ id: randomUUID(), runId, time: now(), level, source, message: String(message) });
    emit({ type: 'log', serverId: server.id, runId, log: entry });
    if (storagePaused.has(server.id)) {
      const entries = deferredLogs.get(server.id) || []; entries.push(entry);
      while (entries.length > 256 || entries.reduce((sum, row) => sum + Buffer.byteLength(row.message), 0) > 1024 ** 2) entries.shift();
      deferredLogs.set(server.id, entries);
    } else writer(server).append(entry);
    return entry;
  };
  const runtimeCurrent = (server, runtime) => processes.get(server.id) === runtime && consoleRun(server) === runtime.consoleRunId;
  const runtimeLog = (server, runtime, ...args) => { if (runtimeCurrent(server, runtime)) return log(server, ...args); };
  const persistStartState = (server, previous) => {
    try { persist(); }
    catch (error) {
      // No child exists yet. Restore the actual stopped state so a storage
      // fault cannot strand the instance in a transition that never happened.
      for (const key of Object.keys(server)) if (!Object.hasOwn(previous, key)) delete server[key];
      Object.assign(server, previous);
      try { log(server, `Không thể lưu yêu cầu khởi động: ${error.message}`, 'error'); } catch {}
      throw error;
    }
  };
  async function pauseStorageWrites(server) {
    storagePaused.add(server.id);
    await logWriters.get(server.id)?.close(); logWriters.delete(server.id);
  }
  async function resumeStorageWrites(server) {
    if (!storagePaused.has(server.id)) return;
    if (storagePolicy(server).mode === 'fixed' && !await storageController.isMounted(server)) return;
    storagePaused.delete(server.id);
    const entries = deferredLogs.get(server.id) || []; deferredLogs.delete(server.id);
    if (entries.length) { const output = writer(server); for (const entry of entries) output.append(entry); await output.drain(); }
  }
  const persistRuntime = server => {
    try { persist(); return null; }
    catch (error) { server.error = `Không thể lưu trạng thái tiến trình: ${error.message}`; log(server, server.error, 'error'); emit({ type: 'update' }); return error; }
  };
  function deliverConsole(server, command, action = 'server.command', { allowStopping = false, gameplay = false, internal = false } = {}) {
    const runtime = processes.get(server.id);
    if (!gameplay && runtime?.gameplay?.busy) fail('Console đang đọc hoặc áp dụng thao tác gameplay. Hãy chờ hoàn tất.', 409);
    if ((server.status !== 'running' && !(allowStopping && server.status === 'stopping')) || !runtime || runtime.child.stdin.destroyed || runtime.child.stdin.writable === false) fail('Server phải đang chạy để gửi lệnh.', 409);
    return dispatchConsoleLine({ write: () => runtime.child.stdin.write(command.trim() + '\n'), log: () => {
      if (internal) return;
      log(server, `> ${isApp(server) ? applicationRuntime.redact(server, command) : command}`, 'command');
    }, audit: () => { if (!internal) audit(action, `${server.name}: ${isApp(server) ? applicationRuntime.redact(server, command) : command}`, undefined, undefined, server.id); } });
  }
  const optionalVoiceWarning = server => { try { log(server, 'Không thể gửi thông báo thế giới tùy chọn; thao tác quản lý vẫn tiếp tục.', 'warn'); } catch {} };
  const assertIdle = server => { if (server.jobId || server.cloneJobId || processes.get(server.id)?.gameplay?.busy || (operations.has(server.id) && operationContext.getStore() !== server.id) || (scheduleLocks.has(server.id) && scheduleContext.getStore() !== scheduleLocks.get(server.id))) fail('Server đang thực hiện tác vụ. Vui lòng đợi hoàn tất.', 409); };
  const assertRecovered = server => { if (server.restoreRecoveryRequired) fail(`Server có dữ liệu restore chưa phục hồi; cần quản trị viên kiểm tra ${server.restoreRecoveryRequired.original} và ${server.restoreRecoveryRequired.candidate} trước khi khởi động hoặc thay đổi dữ liệu.`, 409); };
  const assertStopped = server => { assertIdle(server); assertRecovered(server); if (lifecycle.has(server.id) || processes.has(server.id) || ['running', 'starting', 'stopping'].includes(server.status)) fail(isApp(server) ? 'Hãy dừng ứng dụng trước khi thao tác để bảo vệ mã nguồn và dữ liệu.' : 'Hãy dừng server trước khi thao tác để bảo vệ dữ liệu thế giới.', 409); };
  const resolveVersion = async (version, channel = 'stable') => {
    if (!['stable', 'preview'].includes(channel)) fail('Kênh phiên bản không hợp lệ.');
    if (!version || version === 'latest') {
      let value = channel === 'stable' ? versionService.metadata().latest : versionService.metadata().preview;
      if (!value) { await versionService.refresh(); value = channel === 'stable' ? versionService.metadata().latest : versionService.metadata().preview; }
      if (!value) fail('Chưa xác định được phiên bản mới nhất từ Mojang. Hãy kiểm tra mạng hoặc nhập ZIP chính thức.', 503);
      version = value;
    }
    if (!store.data.versions.some(item => item.version === version && item.channel === channel)) fail('Phiên bản không có trong kho.', 404);
    return { version, channel };
  };
  const job = (type, server, operation, beforeQueued, afterFinished) => {
    assertOpen();
    assertIdle(server);
    const createdAt = now();
    const record = { id: randomUUID(), type, serverId: server.id, subject: { name: server.name, kind: appKind(server) }, status: 'queued', phase: 'queued', progress: 0, message: 'Đã đưa vào hàng đợi', createdAt, startedAt: null, finishedAt: null, phaseHistory: [{ phase: 'queued', at: createdAt, progress: 0, message: 'Đã đưa vào hàng đợi' }], operationCompleted: false, completionStatusPersisted: false };
    const rememberPhase = () => { if (record.phaseHistory.at(-1)?.phase !== record.phase) record.phaseHistory = [...record.phaseHistory, { phase: record.phase, at: now(), progress: record.progress, message: record.message }].slice(-16); };
    const appendOutput = line => {
      if (typeof line !== 'string') return;
      const safe = (isApp(server) ? applicationRuntime.redact(server, line) : line).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 4000);
      const output = record.output ||= { lines: [], truncated: false }; output.lines.push(safe);
      while (output.lines.length > 200 || Buffer.byteLength(output.lines.join('\n')) > 65536) { output.lines.shift(); output.truncated = true; }
    };
    server.jobId = record.id;
    const previousJobs = store.data.jobs;
    store.data.jobs = [record, ...previousJobs];
    try { beforeQueued?.(record); persist(); }
    catch (error) { delete server.jobId; store.data.jobs = previousJobs; throw error; }
    const promise = (async () => {
      let lastProgressEvent = 0;
      const progress = (value, message, details) => {
        const phase = record.phase, milestone = record.progress;
        if (details?.outputLine !== undefined) appendOutput(details.outputLine);
        const changed = updateJobProgress(record, value, message, details); rememberPhase();
        if ((changed || details?.outputLine !== undefined) && (record.phase !== phase || record.progress !== milestone || Date.now() - lastProgressEvent >= 200)) { lastProgressEvent = Date.now(); emit({ type: 'update' }); }
      };
      const completionWarning = warning => {
        record.warnings = [...(record.warnings || []), warning];
        record.message = 'Hoàn tất với cảnh báo; hãy kiểm tra chi tiết tác vụ.';
        log(server, warning, 'warn');
      };
      try {
        record.status = 'running'; record.startedAt = now(); record.phase = 'prepare'; record.message = 'Đang xử lý'; rememberPhase(); persist();
        if (closed) fail('Panel đang tắt.', 503);
        const outcome = await operation(progress);
        record.operationCompleted = true;
        if (outcome?.result) record.result = outcome.result;
        else if (['install', 'clone'].includes(type)) record.result = { kind: appKind(server), version: server.version, port: server.port, ...(isApp(server) ? { entrypoint: server.application?.entrypoint, startup: startupSummary(server), ...(server.runtime ? { runtime: publicRuntimePin(server.runtime) } : {}) } : {}) };
        if (outcome?.warnings?.length) record.warnings = [...outcome.warnings];
        if (typeof outcome?.retentionComplete === 'boolean') record.retentionComplete = outcome.retentionComplete;
        record.status = 'completed'; record.phase = 'complete'; delete record.transfer; record.progress = 100; record.message = record.warnings?.length ? type === 'backup' && record.retentionComplete !== false ? 'Hoàn tất; còn dữ liệu cách ly cần quản trị viên kiểm tra.' : 'Hoàn tất với cảnh báo; hãy kiểm tra chi tiết tác vụ.' : typeof outcome?.message === 'string' ? outcome.message : 'Hoàn tất'; rememberPhase();
        // The operation has already committed its own data. A completion audit
        // write failure must not tell clients to repeat that successful action.
        record.completionAuditRecorded = true;
        try { audit(`${type}.complete`, server.name, undefined, undefined, server.id); }
        catch (error) { record.completionAuditRecorded = false; completionWarning(`Thao tác đã hoàn tất, nhưng chưa ghi được nhật ký hoàn tất: ${error.message}`); }
      } catch (error) {
        record.status = 'failed'; record.phase = 'failed'; delete record.transfer; record.message = error.message;
        if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) record.errorCode = error.code;
        rememberPhase();
        if (error.errorI18n) record.messageI18n = error.errorI18n;
        server.error = error.message;
        if (type === 'backup-verify' && error[backupVerificationSubject]) server.backupVerificationFailure = { backupId: error[backupVerificationSubject], message: error.message };
        else delete server.backupVerificationFailure;
        if (type === 'install' || type === 'clone') server.status = 'error';
        log(server, error.message, 'error');
        try { audit(`${type}.failed`, `${server.name}: ${error.message}`, undefined, { id: 'panel.audit.operation.failed', params: [server.name, error.message] }, server.id); } catch {}
      } finally {
        record.finishedAt = now(); delete server.jobId;
        afterFinished?.(record);
        record.completionStatusPersisted = true;
        try { persist(); }
        catch (error) {
          record.completionStatusPersisted = false;
          if (record.operationCompleted) completionWarning(`Thao tác đã hoàn tất, nhưng chưa lưu được trạng thái tác vụ: ${error.message}. Trạng thái cuối có thể chưa được lưu; hãy kiểm tra dữ liệu trước khi thử lại.`);
          else {
            // Keep the original operation/recovery error and append the status
            // write failure, rather than hiding the primary recovery locations.
            const warning = `Không thể lưu trạng thái panel: ${error.message}`;
            record.warnings = [...(record.warnings || []), warning]; log(server, warning, 'warn');
          }
          emit({ type: 'update' });
        }
      }
    })();
    runningJobs.add(promise); jobPromises.set(record.id, promise);
    promise.then(() => { runningJobs.delete(promise); jobPromises.delete(record.id); }, () => { runningJobs.delete(promise); jobPromises.delete(record.id); });
    return { ...record };
  };

  function registerServerJob(server, type, operation, action, detail, source) {
    const servers = store.data.servers, jobs = store.data.jobs, previousJobs = [...jobs], activity = store.data.activity;
    const sourceLock = source && { exists: Object.hasOwn(source, 'cloneJobId'), value: source.cloneJobId };
    store.data.servers = [...servers, server];
    store.data.activity = [{ id: randomUUID(), time: now(), action, detail, serverId: server.id, user: actorContext.getStore()?.username || 'system' }, ...activity];
    try { return job(type, server, operation, source ? record => { source.cloneJobId = record.id; } : undefined, record => { pendingDisk.delete(server.id); if (source?.cloneJobId === record.id) delete source.cloneJobId; }); }
    catch (error) {
      store.data.servers = servers; jobs.splice(0, jobs.length, ...previousJobs); store.data.jobs = jobs; store.data.activity = activity;
      if (source) { if (sourceLock.exists) source.cloneJobId = sourceLock.value; else delete source.cloneJobId; }
      throw error;
    }
  }

  async function install(server, selection, progress, updating = false) {
    progress(5, 'Chuẩn bị gói Bedrock chính thức');
    if (!updating && storagePolicy(server).mode === 'fixed') {
      progress(1, 'Đang cấp phát volume lưu trữ máy chủ', { phase: 'storage' });
      try { await storageController.provision(server); storageMetrics.set(server.id, await storageController.stats(server)); }
      finally { pendingDisk.delete(server.id); }
    } else await ensureStorage(server);
    let packageInfo;
    try { packageInfo = await packageContext.run(server.id, () => versionService.ensure(selection.version, selection.channel, (value, transfer) => progress(value, transfer?.phase === 'verify' ? 'Đang kiểm tra gói Bedrock' : transfer?.phase === 'extract' ? 'Đang giải nén gói Bedrock' : transfer?.phase === 'cache' ? 'Đã chuẩn bị gói Bedrock' : 'Đang tải gói từ Mojang', { phase: transfer?.phase || 'download', transfer }))); }
    finally { packageWorkspaces.delete(server.id); pendingDisk.delete(`package:${server.id}`); }
    if (updating) await performBackup(server, value => progress(65 + value / 5, 'Đang sao lưu dữ liệu trước cập nhật'), 'pre-update');
    const before = structuredClone(server);
    const serverRoot = directory(server);
    await fs.mkdir(serverRoot, { recursive: true, mode: 0o700 });
    const staging = path.join(serverRoot, `.staging-${randomUUID()}`);
    const rollback = path.join(serverRoot, `.rollback-${randomUUID()}`);
    let swapped = false;
    let committed = false;
    try {
      await fs.mkdir(staging, { mode: 0o700 });
      if (updating) {
        const oldFiles = await walkFiles(runDirectory(server));
        const oldRuntime = new Set(server.runtimeFiles || []);
        for (const file of oldFiles.filter(name => mutable(name) || !oldRuntime.has(name))) {
          await fs.mkdir(path.dirname(path.join(staging, file)), { recursive: true });
          await fs.copyFile(path.join(runDirectory(server), file), path.join(staging, file));
        }
        await copyEmptyDirectories(runDirectory(server), staging);
      }
      for (const file of packageInfo.manifest) {
        const target = path.join(staging, file);
        if (updating && mutable(file) && await fs.stat(target).catch(() => false)) continue;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(packageInfo.directory, file), target);
      }
      await fs.chmod(path.join(staging, 'bedrock_server'), 0o700);
      const packageProperties = parseProperties(await fs.readFile(path.join(packageInfo.directory, 'server.properties'), 'utf8'));
      const properties = { ...packageProperties, ...parseProperties(await fs.readFile(path.join(staging, 'server.properties'), 'utf8')) };
      const transport = packageProperties.transport || 'raknet';
      const udpPorts = transport === 'nethernet' ? (updating ? properties['server-udp-ports'] : null) || server.udpPorts || defaultUdpPorts(server.port, server.maxPlayers) : null;
      const network = validateNetwork(networkServers(), server.id, { ...server, transport, udpPorts, debugPort: debuggerPort(properties) });
      pendingNetworks.set(server.id, network);
      Object.assign(properties, updating ? { 'server-port': String(server.port), 'server-portv6': String(server.portV6), transport, 'enable-lan-visibility': 'false' } : defaultProperties({ ...server, ...network }));
      if (transport === 'nethernet') properties['server-udp-ports'] = udpPorts;
      await atomicWrite(path.join(staging, 'server.properties'), serializeProperties(properties));
      if (transport === 'nethernet') await ensureServerIdentity(staging);
      for (const name of ['allowlist.json', 'permissions.json']) if (!await fs.stat(path.join(staging, name)).catch(() => false)) await atomicWrite(path.join(staging, name), '[]\n');
      progress(90, 'Đang kích hoạt thư mục server', { phase: 'activate' });
      if (updating) await fs.rename(runDirectory(server), rollback);
      try { await fs.rename(staging, runDirectory(server)); swapped = true; }
      catch (error) { if (updating) await fs.rename(rollback, runDirectory(server)); throw error; }
      Object.assign(server, selection, network, { runtimeFiles: packageInfo.manifest.filter(file => !mutable(file)), status: 'stopped', error: null });
      persist();
      committed = true;
      const warnings = [];
      if (updating) try { await fs.rm(rollback, { recursive: true, force: true }); }
      catch (error) { warnings.push(`Đã cập nhật server; còn dữ liệu rollback tại ${path.basename(rollback)} cần kiểm tra: ${error.message}`); }
      log(server, `Bedrock ${selection.version} ${updating ? 'đã cập nhật; dữ liệu thế giới và cấu hình được giữ lại' : 'đã cài đặt'}.`);
      return { warnings };
    } catch (error) {
      if (swapped && !committed) {
        await fs.rename(runDirectory(server), staging);
        if (updating) await fs.rename(rollback, runDirectory(server));
        for (const key of Object.keys(server)) delete server[key];
        Object.assign(server, before);
        swapped = false;
      }
      throw error;
    } finally {
      pendingNetworks.delete(server.id);
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      // A cleanup failure after commit must remain visible for maintenance;
      // keep the rollback bytes rather than reporting that activation failed.
    }
  }

  async function probePorts(server) {
    for (const port of [...(isApp(server) || ['nethernet', 'auto'].includes(server.transport) ? [server.port] : []), ...(server.debugPort == null ? [] : [server.debugPort])]) {
      const probe = address => new Promise((resolve, reject) => {
        const listener = net.createServer();
        listener.once('error', reject);
        listener.listen({ port, host: address, exclusive: true }, () => listener.close(resolve));
      });
      for (const address of ['::', '0.0.0.0', ...(isApp(server) ? ['::1', '127.0.0.1'] : [])]) {
        try { await probe(address); }
        catch (error) { if (address.includes(':') && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) continue; throw Object.assign(new Error(`Không thể mở cổng TCP ${port}: ${error.message}`), { status: 409, code: error.code }); }
      }
    }
    if (isApp(server)) return;
    const probeUdp = (type, port, address) => new Promise((resolve, reject) => {
        const socket = dgram.createSocket({ type, ...(type === 'udp6' ? { ipv6Only: server.transport !== 'nethernet' } : {}) });
        socket.once('error', error => { try { socket.close(); } catch {} reject(Object.assign(new Error(`Không thể mở cổng UDP ${port}: ${error.message}`), { status: 409, code: error.code })); });
        socket.bind({ port, address }, () => socket.close(resolve));
    });
    const bindings = [...(server.transport !== 'nethernet' ? [['udp4', server.port, '0.0.0.0'], ['udp6', server.portV6, '::']] : []), ...(server.transport !== 'raknet' ? parseUdpPorts(server.udpPorts).flatMap(port => [['udp6', port, '::'], ['udp4', port, '0.0.0.0']]) : [])];
    for (const [type, port, address] of bindings) {
      try { await probeUdp(type, port, address); }
      catch (error) { if (server.transport !== 'raknet' && type === 'udp6' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) continue; else throw error; }
    }
  }

  // Call only inside capacityGate: every accepted create is visible before the
  // next create chooses its random allocation. Reserve before native probes so
  // simultaneous configuration edits also see this candidate during awaits.
  async function prepareCreationNetwork(server, mode) {
    const excludedPorts = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      if (mode === 'auto') Object.assign(server, await allocatePorts({ kind: appKind(server), transport: isApp(server) ? 'auto' : server.transport, maxPlayers: server.maxPlayers, servers: networkServers, excludedPorts }));
      assertOpen(); validateNetwork(networkServers(), server.id, server);
      pendingNetworks.set(server.id, { kind: appKind(server), port: server.port, portV6: server.portV6, transport: server.transport, udpPorts: server.udpPorts, debugPort: server.debugPort });
      try {
        if (mode === 'auto' || isApp(server)) await probePorts(server);
        assertOpen(); validateNetwork(networkServers(), server.id, server);
        return;
      } catch (error) {
        pendingNetworks.delete(server.id);
        if (mode !== 'auto' || error.code !== 'EADDRINUSE' || attempt === 7) throw error;
        // Only an address-in-use race is retryable. Unknown bind failures must
        // never be hidden by selecting another port or accepting the create.
        excludedPorts.push(server.port, ...(!isApp(server) ? [server.portV6, ...(server.transport !== 'raknet' ? parseUdpPorts(server.udpPorts) : [])] : []));
      }
    }
  }

  async function start(server, { automatic = false } = {}) {
    await applicationRuntime.assertNoPendingBuilds?.();
    await ensureStorage(server);
    if (storagePolicy(server).mode === 'fixed') {
      const actual = await storageController.stats(server); storageMetrics.set(server.id, actual);
      if (!actual.hardEnforced || actual.limitBytes < storagePolicy(server).diskGiB * GIB) fail('Cần hoàn tất tăng dung lượng trước khi khởi động máy chủ này.', 409);
    }
    assertIdle(server);
    assertRecovered(server);
    if (closed) fail('Panel đang tắt.', 503);
    if (processes.has(server.id) || ['running', 'starting', 'stopping'].includes(server.status)) fail('Server đang chạy hoặc đang chuyển trạng thái.', 409);
    if (server.status === 'installing' || !server.version) fail('Server chưa cài đặt xong.', 409);
    validateNetwork(networkServers(), server.id, server);
    assertMemoryHeadroom({ host: await capacityHostInfo(), servers: capacityServers(), reserveRatio, minimumMemoryMiB: resourceControl.memory?.minMiB ?? 256 });
    if (closed) fail('Panel đang tắt.', 503);
    const restartTimer = restartTimers.get(server.id);
    if (restartTimer) { clearTimeout(restartTimer); restartTimers.delete(server.id); }
    if (!automatic) crashes.delete(server.id);
    if (!isApp(server) && (process.platform !== 'linux' || process.arch !== 'x64')) fail('Bedrock Linux yêu cầu Ubuntu 22.04+ x86-64. Hãy triển khai panel trên Ubuntu.', 409);
    const workingDirectory = runDirectory(server);
    let executable, plan, properties = {};
    if (isApp(server)) {
      await requireApplicationRuntime(appKind(server), { server });
      await applicationRuntime.prepareWorkspace(server);
      plan = await applicationRuntime.launchPlan(server, { purpose: 'start' });
      executable = plan.executable;
    } else {
    executable = await safePath(workingDirectory, 'bedrock_server');
    const stat = await fs.stat(executable);
    if (!stat.isFile()) fail('Không tìm thấy tệp Bedrock server.', 409);
    properties = parseProperties(await fs.readFile(await safePath(workingDirectory, 'server.properties'), 'utf8'));
    validateBedrockProperties(properties);
    const transport = properties.transport || 'raknet';
    if (transport === 'nethernet') await ensureServerIdentity(workingDirectory);
    if (!['raknet', 'nethernet'].includes(transport) || transport !== (server.transport || 'raknet') || properties['enable-lan-visibility'] !== 'false' || Number(properties['server-port']) !== server.port || Number(properties['server-portv6']) !== server.portV6 || (transport === 'nethernet' && properties['server-udp-ports'] !== server.udpPorts) || debuggerPort(properties) !== (server.debugPort ?? null)) fail('Cấu hình cổng hoặc transport không khớp. Hãy lưu lại cấu hình qua panel.', 409);
    }
    await probePorts(server);
    resetConsole(server);
    const previous = { ...server };
    if (plan) server.version = server.runtime?.mode === 'managed' ? server.runtime.version : plan.runtime.version;
    server.status = 'starting'; server.error = null; server.players = 0; persistStartState(server, previous);
    let resourceHandle, launched;
    try {
      resourceHandle = await resourceController.prepare(server.id, serverPolicy(server), isApp(server) ? { tasksMax: 128 } : {});
      launched = plan ? resourceHandle.spawnWithArgs(plan.executable, plan.args, plan.options, plan.execution) : resourceHandle.spawn(executable, { cwd: workingDirectory, env: { ...process.env, LD_LIBRARY_PATH: workingDirectory }, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    } catch (error) { await resourceHandle?.cleanup().catch(() => {}); server.status = 'error'; server.error = error.message; log(server, `${isApp(server) ? 'Cannot start application' : 'Không thể chạy Bedrock'}: ${error.message}`, 'error'); persistRuntime(server); throw error; }
    const { child, ready } = launched;
    const runtime = { child, resourceHandle, resourceUsage: null, startedAt: Date.now(), expected: false, online: new Map(), connections: new Map(), instanceId: randomUUID(), worldName: properties['level-name'] || 'Bedrock level', startupProperties: { ...properties }, gameRules: new Map(), previousTicks: 0, previousTime: performance.now(), ready: false, close: null };
    runtime.consoleRunId = consoleRun(server);
    runtime.applicationRuntime = plan?.runtime || null;
    runtime.gameplay = isApp(server) ? { busy: false, consume: () => false, close() {} } : createGameplayConsole({ send: (command, options) => {
      if (!runtimeCurrent(server, runtime)) fail('Phiên chạy máy chủ đã thay đổi.', 409);
      return deliverConsole(server, command, 'server.gameplay.command', { gameplay: true, internal: options.internal });
    } });
    runtime.worldVoice = isApp(server) ? { consume() {} } : createNativeWorldVoice({ server, online: runtime.online, send: command => {
      if (!runtimeCurrent(server, runtime)) fail('Phiên chạy máy chủ đã thay đổi.', 409);
      return deliverConsole(server, command, 'server.announcement.auto');
    }, onWarning: () => { if (runtimeCurrent(server, runtime)) optionalVoiceWarning(server); } });
    processes.set(server.id, runtime);
    child.stdin.on('error', error => runtimeLog(server, runtime, `Console: ${error.message}`, 'warn'));
    // The trusted in-sandbox loader consumes this one private line before
    // handing the unchanged console pipe to user code. Custom variables never
    // enter the privileged resource wrapper, setpriv or bwrap environment.
    if (plan?.stdinPrelude) child.stdin.write(plan.stdinPrelude);
    const consume = (stream, level) => {
      const consumer = createUtf8LineConsumer({ maxBytes: logPolicy().consoleLineBytes, onLine: line => {
          if (!runtimeCurrent(server, runtime)) return;
          if (isApp(server)) { log(server, applicationRuntime.redact(server, line), level, 'native'); return; }
          const internal = runtime.gameplay.consume(line) || runtime.backupConsole?.isInternal(line);
          if (!internal) log(server, line, bedrockLogLevel(line, level), 'native');
          if (/^Server started\.?$/i.test(nativeGameplayBody(line) || '')) {
            if (!runtime.ready) runtime.worldIdentityReady = captureGameplayWorld(server, runtime).catch(() => null);
            runtime.ready = true; clearTimeout(runtime.readyTimer);
            if (!runtime.expected) server.status = 'running';
            if (!closed && !runtime.expected) delete server.resumeOnPanelStart;
            persistRuntime(server);
          }
          trackRuntimePlayer(server, runtime, line);
          runtime.worldVoice.consume(line);
      } });
      stream.on('data', chunk => consumer.write(chunk));
      stream.on('end', () => consumer.end());
    };
    consume(child.stdout, 'info'); consume(child.stderr, 'warn');
    child.on('error', error => { if (!runtimeCurrent(server, runtime)) return; server.error = error.message; runtimeLog(server, runtime, `${isApp(server) ? 'Cannot start application' : 'Không thể chạy Bedrock'}: ${error.message}`, 'error'); });
    runtime.close = new Promise(resolve => child.once('close', async (code, signal) => {
      runtime.gameplay.close();
      clearTimeout(runtime.readyTimer);
      let finalUsage = null;
      const cleanup = resourceHandle.cleanup().then(result => { finalUsage = result.stats || null; if (server.resourceCleanupPending === resourceHandle.effective.cgroupPath) delete server.resourceCleanupPending; for (const warning of result.warnings || []) runtimeLog(server, runtime, warning, 'warn'); }).catch(error => { runtimeLog(server, runtime, error.message, 'warn'); server.resourceCleanupPending ||= error.cleanupPending || resourceHandle.effective.cgroupPath || null; runtime.resourceCleanupError = error.message; });
      resourceCleanup.add(cleanup); await cleanup; resourceCleanup.delete(cleanup);
      const lastExit = recordResourceExit({ policy: resourceHandle.policy, stats: finalUsage, pid: child.pid, code, signal });
      if (lastExit) server.lastResourceExit = lastExit;
      if (!runtimeCurrent(server, runtime)) { resolve(); return; }
      processes.delete(server.id);
      server.status = runtime.expected ? 'stopped' : 'error'; server.players = 0; server.memoryMB = 0; server.cpuPercent = 0;
      if (!runtime.expected) server.error = server.error || `${isApp(server) ? appKind(server) : 'Bedrock'} exited (code ${code}, signal ${signal || 'none'}).`;
      if (lastExit?.reason === 'memory-limit') { const message = memoryLimitExitMessage(appKind(server)); if (!runtime.expected) server.error = message; log(server, message, 'error'); }
      log(server, `Tiến trình dừng: code ${code}, signal ${signal || 'none'}.`, runtime.expected ? 'info' : 'error'); persistRuntime(server);
      if (!runtime.expected && server.autoRestart && !closed) {
        const attempts = (crashes.get(server.id) || []).filter(time => Date.now() - time < 10 * 60 * 1000);
        attempts.push(Date.now()); crashes.set(server.id, attempts);
        if (attempts.length <= 5) {
          const delay = Math.min(60000, 2000 * 2 ** (attempts.length - 1));
          log(server, `Tự khởi động lại sau ${delay / 1000}s (lần ${attempts.length}/5).`, 'warn');
          restartTimers.set(server.id, setTimeout(() => { restartTimers.delete(server.id); manager.action(server.id, 'start', true).catch(error => { server.error = error.message; log(server, error.message, 'error'); persistRuntime(server); }); }, delay));
        } else log(server, 'Tạm ngừng tự khởi động lại: quá 5 lần lỗi trong 10 phút.', 'error');
      }
      resolve();
    }));
    runtime.readyTimer = setTimeout(() => { if (runtimeCurrent(server, runtime) && !runtime.ready && !runtime.expected) { server.error = isApp(server) ? 'Application did not become ready within 30 seconds.' : 'Bedrock không báo sẵn sàng sau 90 giây.'; runtimeLog(server, runtime, server.error, 'error'); child.kill('SIGKILL'); } }, isApp(server) ? 30000 : 90000);
    try { await ready; }
    catch (error) { runtime.expected = true; server.error = error.message; if (!child.killed) child.kill('SIGKILL'); await runtime.close; server.status = 'error'; persistRuntime(server); throw error; }
    if (isApp(server)) {
      const readyTask = (async () => {
        const deadline = Date.now() + 30000;
        do {
          await new Promise(resolve => setTimeout(resolve, 300));
          if (!runtimeCurrent(server, runtime) || runtime.expected || closed) return;
          const ownedListener = async () => {
            const portHex = server.port.toString(16).toUpperCase().padStart(4, '0');
            for (const filename of ['/proc/net/tcp', '/proc/net/tcp6']) {
              const lines = (await fs.readFile(filename, 'utf8').catch(() => '')).trim().split('\n').slice(1);
              if (lines.some(line => { const fields = line.trim().split(/\s+/); return fields[1]?.endsWith(':' + portHex) && fields[3] === '0A' && Number(fields[7]) === runtime.applicationRuntime?.uid; })) return true;
            }
            return false;
          };
          const listening = server.application.readiness === 'process' || await ownedListener() && await new Promise(resolve => {
            const socket = net.connect({ host: '127.0.0.1', port: server.port });
            const finish = value => { socket.destroy(); resolve(value); };
            socket.setTimeout(250); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
          });
          // A stop/restart can complete while the listener probe awaits I/O.
          // Only this still-current launch may publish readiness afterwards.
          if (!runtimeCurrent(server, runtime) || runtime.expected || closed) return;
          if (listening) { runtime.ready = true; clearTimeout(runtime.readyTimer); server.status = 'running'; delete server.resumeOnPanelStart; persistRuntime(server); log(server, server.application.readiness === 'process' ? 'Application process is running; network readiness was not requested.' : `Application is listening on TCP ${server.port}.`); return; }
        } while (Date.now() < deadline);
      })();
      gameplayRuns.add(readyTask); readyTask.finally(() => gameplayRuns.delete(readyTask)).catch(() => {});
    }
    runtimeLog(server, runtime, isApp(server) ? `Started ${appKind(server)} PID ${child.pid}; checking readiness.` : `Đã chạy Bedrock PID ${child.pid}; đang đợi server sẵn sàng.`);
    audit('server.start', server.name, undefined, undefined, server.id); return publicServer(server);
  }

  async function stop(server, force = false, shutdown = false, noticeReason = 'stop') {
    assertIdle(server);
    if (!shutdown && !closed) delete server.resumeOnPanelStart;
    const timer = restartTimers.get(server.id);
    if (timer) { clearTimeout(timer); restartTimers.delete(server.id); }
    const runtime = processes.get(server.id);
    if (!runtime) { server.status = 'stopped'; persist(); return publicServer(server); }
    const wasRunning = server.status === 'running' && runtime.ready;
    runtime.expected = true; server.status = 'stopping';
    // A metadata write failure must never prevent terminating a managed process.
    const persistenceError = persistRuntime(server);
    if (!force && wasRunning && !isApp(server)) await announceGracefulWorldPause({ server, reason: noticeReason, send: command => deliverConsole(server, command, 'server.announcement.auto', { allowStopping: true }), wait: milliseconds => new Promise(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      runtime.close.then(() => { clearTimeout(timer); resolve(); });
    }), onWarning: () => optionalVoiceWarning(server) });
    if (force && processes.get(server.id) === runtime) runtime.child.kill('SIGKILL');
    else if (processes.get(server.id) === runtime) {
      if (isApp(server)) {
        let signaled = false, signalResult;
        try { signalResult = await applicationRuntime.signalApplication?.(server, { resourceHandle: runtime.resourceHandle, supervisorPid: runtime.child.pid, signal: 'SIGTERM' }); signaled = signalResult?.sent === true; }
        catch (error) { if (processes.get(server.id) === runtime) log(server, `Graceful application signal could not be verified: ${error.message}`, 'warn'); }
        if (signaled) {
          log(server, 'Sent SIGTERM to the verified application process; waiting for shutdown.');
          if (signalResult.partial) log(server, `SIGTERM reached ${signalResult.pids.length} application process(es); ${signalResult.pendingPids.length} delivery failed. Waiting before forced cleanup.`, 'warn');
        }
        else if (processes.get(server.id) === runtime) { runtime.child.kill('SIGTERM'); log(server, 'Application process was not available for a verified graceful signal; stopping its sandbox.', 'warn'); }
      }
      else {
      runtime.child.stdin.write('stop\n');
      log(server, 'Đã gửi stop; chờ Bedrock lưu thế giới.');
      }
    }
    let timeout;
    await Promise.race([runtime.close, new Promise(resolve => { timeout = setTimeout(() => { log(server, isApp(server) ? 'Application did not stop within 30 seconds; sending SIGKILL.' : 'Bedrock chưa dừng sau 30 giây; gửi SIGKILL.', 'warn'); runtime.child.kill('SIGKILL'); resolve(); }, force ? 5000 : 30000); })]);
    clearTimeout(timeout);
    if (processes.has(server.id)) await Promise.race([runtime.close, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (processes.has(server.id)) fail('Không thể xác nhận tiến trình đã dừng.', 500);
    if (persistenceError) throw persistenceError;
    audit(force ? 'server.kill' : 'server.stop', server.name, undefined, undefined, server.id); return publicServer(server);
  }

  async function properties(server) {
    if (isApp(server)) fail('This tool is available for Minecraft Bedrock servers only.', 409);
    await ensureStorage(server);
    const text = await fs.readFile(await safePath(runDirectory(server), 'server.properties'), 'utf8');
    return parseProperties(text);
  }
  function trackRuntimePlayer(server, runtime, line) {
    if (!trackGameplayPlayer(runtime.online, runtime.connections, line)) return;
    server.players = runtime.online.size; emit({ type: 'update' });
  }
  async function captureGameplayWorld(server, runtime) {
    const world = await safePath(runDirectory(server), `worlds/${runtime.worldName}`), stat = await fs.stat(world);
    if (!stat.isDirectory()) fail('Thư mục thế giới native không sẵn sàng.', 409);
    const identity = `${stat.dev}:${stat.ino}`;
    if (runtime.worldIdentity && runtime.worldIdentity !== identity) fail('Thế giới đã thay đổi từ khi tiến trình khởi động. Hãy khởi động lại và đọc lại gameplay.', 409);
    runtime.worldIdentity = identity;
    return { name: runtime.worldName, revision: createHash('sha256').update(`${server.id}:${runtime.instanceId}:${runtime.worldName}:${identity}`).digest('hex') };
  }
  async function gameplayWorld(server, runtime) {
    if (processes.get(server.id) !== runtime || !runtime.ready || runtime.expected || server.status !== 'running') fail('Cần server native đang chạy và sẵn sàng để dùng gameplay.', 409);
    const current = await properties(server);
    if ((current['level-name'] || 'Bedrock level') !== runtime.worldName) fail('Thế giới đã thay đổi từ khi tiến trình khởi động. Hãy khởi động lại và đọc lại gameplay.', 409);
    await runtime.worldIdentityReady;
    const world = await captureGameplayWorld(server, runtime);
    if (processes.get(server.id) !== runtime || runtime.expected || server.status !== 'running') fail('Phiên thế giới đã thay đổi. Hãy đọc lại gameplay trước khi thao tác.', 409);
    return world;
  }
  const gamePlayers = runtime => connectedGameplayPlayers(runtime.online, runtime.connections);
  function assertPlayerConnection(runtime, target) {
    assertGameplayPlayer(runtime.online, runtime.connections, target);
  }
  async function gameplayMetadata(server) {
    const runtime = processes.get(server.id);
    let current; try { current = await properties(server); } catch (error) { if (error.code !== 'ENOENT') throw error; current = defaultProperties(server); }
    let world = { name: current['level-name'] || 'Bedrock level', revision: null }, available = false, reason = 'Khởi động server native và đợi sẵn sàng để đọc hoặc đổi gameplay.';
    if (runtime?.ready && server.status === 'running' && !runtime.expected) try { world = await gameplayWorld(server, runtime); available = true; reason = null; } catch (error) { reason = error.message; }
    const cached = available ? runtime.gameRules : new Map();
    return { server: publicServer(server), available, reason, world, cheatsEnabled: available && runtime.startupProperties['allow-cheats'] === 'true', rules: GAME_RULES.map(rule => ({ ...rule, value: null, status: 'not-queried', ...(cached.get(rule.key) || {}) })), valuesSource: cached.size ? 'cached-native' : 'not-queried', rulesQueriedAt: available ? runtime.rulesQueriedAt || null : null, players: available ? gamePlayers(runtime) : [], actions: PLAYER_ACTIONS, itemCatalog: GAME_ITEMS, busy: Boolean(runtime?.gameplay?.busy), queryAvailable: available && !runtime.gameplay.busy && !publicServer(server).busy };
  }
  async function withGameplay(server, worldRevision, operation) {
    assertOpen(); assertIdle(server); assertRecovered(server);
    if (lifecycle.has(server.id)) fail('Server đang chuyển trạng thái. Vui lòng đợi.', 409);
    const runtime = processes.get(server.id);
    if (!runtime?.ready || server.status !== 'running') fail('Cần server native đang chạy và sẵn sàng để dùng gameplay.', 409);
    const run = runtime.gameplay.run(async console => {
      const world = await gameplayWorld(server, runtime);
      if (world.revision !== worldRevision) fail('Phiên thế giới đã thay đổi. Hãy đọc lại gameplay trước khi thao tác.', 409);
      emit({ type: 'update' });
      const guard = async () => { const current = await gameplayWorld(server, runtime); if (current.revision !== worldRevision) fail('Phiên thế giới đã thay đổi. Hãy đọc lại gameplay trước khi thao tác.', 409); };
      try { await console.fence(); await guard(); return await operation({ runtime, console, world, guard }); }
      finally { emit({ type: 'update' }); }
    });
    gameplayRuns.add(run);
    try { return await run; } finally { gameplayRuns.delete(run); emit({ type: 'update' }); }
  }
  async function queryNativeRule(console, key) {
    const result = await console.exchange(`gamerule ${key}`, line => parseNativeRuleResponse(line, key), { endFence: true });
    return { key, value: result.status === 'confirmed' ? result.value : null, status: result.status, acceptedToConsole: Boolean(result.acceptedToConsole), queriedAt: now(), ...(result.nativeFeedback ? { nativeFeedback: result.nativeFeedback } : {}), ...(result.message ? { message: result.message } : {}), ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}) };
  }
  async function queryGameRules(server, rawInput) {
    const input = validateRuleQuery(rawInput);
    return withGameplay(server, input.worldRevision, async ({ runtime, console, world, guard }) => {
      const results = [];
      for (const key of input.keys) { await guard(); const result = await queryNativeRule(console, key); results.push(result); runtime.gameRules.set(key, result); if (result.status === 'unconfirmed') break; }
      runtime.rulesQueriedAt = now();
      return { world, rules: results, valuesSource: 'fresh-native', confirmed: results.length === input.keys.length && results.every(rule => rule.status === 'confirmed'), queriedAt: runtime.rulesQueriedAt };
    });
  }
  async function changeGameRules(server, rawInput) {
    const input = validateRuleChanges(rawInput);
    return withGameplay(server, input.worldRevision, async ({ runtime, console, world, guard }) => {
      const result = await applyGameRuleChanges(input, { console, guard, query: key => queryNativeRule(console, key), onRead: row => runtime.gameRules.set(row.key, row) });
      runtime.rulesQueriedAt = now();
      return { world, ...result };
    });
  }
  async function playerAction(server, rawInput) {
    const input = buildPlayerAction(rawInput, serverMessageLanguage(server));
    return withGameplay(server, input.worldRevision, async ({ runtime, console, guard }) => {
      if (input.spec.requiresCheats && runtime.startupProperties['allow-cheats'] !== 'true') fail('Thao tác này cần allow-cheats=true. Dừng server và đổi cấu hình nếu bạn muốn bật cheats; panel không tự bật.', 409);
      assertPlayerConnection(runtime, input.target);
      await guard(); assertPlayerConnection(runtime, input.target);
      return executePlayerAction(input, { console });
    });
  }
  async function packOptions(server, action, uuid) {
    return { levelName: (await properties(server))['level-name'] || 'Bedrock level', serverVersion: server.version, runtimeFiles: server.runtimeFiles || [], onCommit: () => {
      const before = [...store.data.activity];
      try { audit(action, `${server.name}${uuid ? `: ${uuid}` : ''}`, undefined, undefined, server.id); }
      catch (error) { store.data.activity = before; throw error; }
      emit({ type: 'update' });
    } };
  }
  function allowedTransports(server) {
    const [major, minor, patch] = String(server.version).split('.').map(Number);
    if (server.channel === 'preview' && (major > 1 || (major === 1 && (minor > 26 || (minor === 26 && patch >= 60))))) return ['nethernet'];
    const item = store.data.versions.find(value => value.version === server.version && value.channel === server.channel);
    return (item?.transport || server.transport) === 'nethernet' ? ['raknet', 'nethernet'] : ['raknet'];
  }
  function configurationResult(server, values) {
    if (isApp(server)) return { server: publicServer(server), properties: {}, resourcePolicy: serverPolicy(server), resourceControl, storageControl, hostCapacity: lastHost?.capacity || null, resources: serverResources(server), network: { port: server.port, transport: 'tcp', requiresStopped: true, warnings: [] } };
    let recommendedUdpPorts = null;
    const port = Number(values['server-port']), maxPlayers = Number(values['max-players']);
    if (Number.isInteger(port) && port >= 1024 && port <= 65535 && Number.isInteger(maxPlayers) && maxPlayers >= 1 && maxPlayers <= 1000) try { recommendedUdpPorts = defaultUdpPorts(port, maxPlayers); } catch {}
    let udpPortCount = 0; const warnings = [];
    if (values.transport === 'nethernet') try { udpPortCount = parseUdpPorts(values['server-udp-ports']).length; } catch (error) { warnings.push(error.message); }
    const udpMode = server.udpMode || (values['server-udp-ports'] === recommendedUdpPorts ? 'auto' : 'custom');
    return { server: publicServer(server), properties: values, resourcePolicy: serverPolicy(server), resourceControl, storageControl, hostCapacity: lastHost?.capacity || null, resources: serverResources(server), network: { udpMode, recommendedUdpPorts, udpPortCount, allowedTransports: allowedTransports(server), debugPort: debuggerPort(values), requiresStopped: true, warnings } };
  }
  async function applicationCapabilities({ refresh = false } = {}) {
    const native = typeof applicationRuntime.runtimeCatalog === 'function' ? await applicationRuntime.runtimeCatalog({ refresh }) : await applicationRuntime.capabilities();
    applicationControl = { ...native, engine: 'bubblewrap', runtimes: Array.isArray(native.runtimes) ? native.runtimes : Object.entries(native.runtimes || {}).map(([kind, info]) => ({ kind, ...info })) };
    return structuredClone(applicationControl);
  }
  async function requireApplicationRuntime(kind, { managed = false, server } = {}) {
    const capabilities = await applicationCapabilities();
    resourceControl = await resourceController.capabilities();
    const pinned = server?.runtime && typeof applicationRuntime.runtimeAvailability === 'function' ? await applicationRuntime.runtimeAvailability(server) : null;
    if (!capabilities.supported || !(pinned ? pinned.available : capabilities.runtimes.some(item => item.kind === kind && (managed ? capabilities.managed === true && item.managedAvailable === true : item.available))) || !resourceControl.fixedSupported || !resourceControl.pidsSupported) throw applicationIssue(pinned ? 'APPLICATION_RUNTIME_PIN' : managed && kind === 'python' && capabilities.runtimes.find(item => item.kind === kind)?.prerequisites?.ready === false ? 'APPLICATION_RUNTIME_TOOLS' : 'APPLICATION_UNSUPPORTED');
    return capabilities.runtimes.find(item => item.kind === kind);
  }
  function applicationResult(server, project, runtimeAvailability) {
    if (!isApp(server)) fail('Application startup settings are available for Python and Node.js servers only.', 409);
    return { server: publicServer(server), application: publicApplication(server.application), revision: appRevision(server), capabilities: structuredClone(applicationControl), ...(project ? { project } : {}), ...(runtimeAvailability ? { runtimeAvailability } : {}) };
  }
  function applicationSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'autoStart', 'autoRestart', 'backupRetention', 'resourcePolicy'].includes(key))) fail('Invalid application server settings.', 400);
    return validateServerSettings(input);
  }
  async function saveApplicationConfiguration(server, input, action, detail) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['settings', 'port'].includes(key))) fail('Invalid application configuration request.', 400);
    assertStopped(server);
    const settings = applicationSettings(input.settings || {});
    const network = validateNetwork(networkServers(), server.id, { kind: appKind(server), port: input.port ?? server.port });
    const fields = { ...settings, ...network };
    return capacityGate.run({ candidate: { ...server, ...fields }, replaceServerId: server.id }, async () => {
      assertOpen(); assertStopped(server);
      validateNetwork(networkServers(), server.id, { ...server, ...fields });
      pendingNetworks.set(server.id, { kind: appKind(server), ...fields });
      try {
        if (network.port !== server.port) await probePorts({ ...server, ...fields });
        commitServerFields(server, fields, action, detail); emit({ type: 'update' });
        return configurationResult(server, {});
      } finally { pendingNetworks.delete(server.id); }
    });
  }
  async function createApplicationServer(input) {
    const allowed = ['kind', 'name', 'port', 'portAllocation', 'application', 'resourcePolicy', 'storagePolicy'];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail('Invalid application creation request.', 400);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\r\n\0]/.test(input.name)) fail('Tên server phải có 1–80 ký tự.');
    await requireApplicationRuntime(input.kind, { managed: true });
    if (typeof applicationRuntime.resolveRuntime !== 'function' || typeof applicationRuntime.ensureRuntime !== 'function') throw applicationIssue('APPLICATION_UNSUPPORTED');
    const runtime = normalizeRuntimePin(await applicationRuntime.resolveRuntime(input.kind), { kind: input.kind });
    const application = normalizeApplication(input.application, { kind: input.kind });
    if (application.startup?.mode === 'npm-script' && application.startup.script !== 'start') throw applicationIssue('APPLICATION_INPUT', 400);
    const resourcePolicy = normalizeResourcePolicy(input.resourcePolicy), storage = normalizeStoragePolicy(input.storagePolicy);
    const portMode = creationPortMode(input);
    const network = portMode === 'auto' ? { port: null, portV6: null, transport: 'tcp', udpPorts: null, debugPort: null } : validateNetwork(networkServers(), null, { kind: input.kind, port: input.port });
    storageControl = await storageController.capabilities();
    if (!storageControl.supported) fail(storageControl.reason || 'Hard storage volumes are unavailable on this node.', 409);
    const server = { id: randomUUID(), kind: input.kind, name: input.name.trim(), version: runtime.version, runtime, channel: 'stable', ...network, application, maxPlayers: 0, players: 0, status: 'installing', createdAt: now(), autoRestart: true, autoStart: false, backupRetention: 10, resourcePolicy, storagePolicy: storage, admissionReservation: { ...SHARED_ADMISSION_RESERVATION }, runtimeFiles: [], backups: [], dependencyState: { status: 'not-installed', installedAt: null } };
    return capacityGate.run({ candidate: server, additionalDiskBytes: storage.diskGiB * GIB }, async () => {
      try {
      await prepareCreationNetwork(server, portMode);
      pendingDisk.set(server.id, storage.diskGiB * GIB);
      try {
        const record = registerServerJob(server, 'install', async progress => {
          try {
            progress(5, 'Preparing application storage', { phase: 'storage' });
            await storageController.provision(server); storageMetrics.set(server.id, await storageController.stats(server));
            pendingDisk.delete(server.id);
            progress(10, `Đã ghim runtime chính thức ${server.kind === 'nodejs' ? 'Node.js' : 'Python'} ${runtime.version}`, { phase: 'runtime-resolve' });
            progress(12, 'Creating isolated application workspace', { phase: 'prepare' });
            await applicationRuntime.prepareWorkspace(server, { seed: true });
            let runtimePhase = 'runtime-prepare';
            const output = line => { log(server, applicationRuntime.redact(server, line), 'info', 'native'); progress(15, 'Đang chuẩn bị runtime đã ghim', { phase: runtimePhase, outputLine: line }); };
            await applicationRuntime.ensureRuntime(server, { reserve: resources => reserveRuntimeBuild(server, resources), onOutput: output, onProgress: item => { runtimePhase = item.phase; progress(15, item.phase === 'runtime-build' ? 'Đang biên dịch mã nguồn Python chính thức; có thể mất vài phút' : 'Đang chuẩn bị runtime đã ghim', item); } });
            if (application.dependencies === 'auto' || server.kind === 'python') {
              progress(40, 'Installing application dependencies', { phase: 'dependencies' });
              const result = await applicationRuntime.installDependencies(server, { onOutput: line => { log(server, applicationRuntime.redact(server, line), 'info', 'native'); progress(40, 'Installing application dependencies', { phase: 'dependencies', outputLine: line }); }, onProgress: item => progress(40 + (item.total ? item.completed / item.total * 50 : 0), 'Installing application dependencies', { phase: 'dependencies' }) });
              server.dependencyState = { status: result.installed ? 'installed' : 'not-installed', installedAt: result.installed ? now() : null, ...(result.manifestFingerprint ? { manifestFingerprint: result.manifestFingerprint } : {}) };
            }
            server.status = 'stopped'; server.error = null; persist();
            progress(100, 'Application workspace is ready', { phase: 'complete' });
            return { message: 'Application workspace is ready', result: { kind: server.kind, version: server.version, runtime: publicRuntimePin(runtime), port: server.port, entrypoint: server.application.entrypoint, startup: startupSummary(server) } };
          } finally { pendingDisk.delete(server.id); }
        }, 'server.create', server.name);
        return { server: publicServer(server), job: record };
      } catch (error) { pendingDisk.delete(server.id); throw error; }
      } finally { pendingNetworks.delete(server.id); }
    });
  }
  async function saveConfiguration(server, input, action = 'server.configuration', detail = server.name) {
    if (isApp(server)) return saveApplicationConfiguration(server, input, action, detail);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['settings', 'properties', 'udpMode'].includes(key))) fail('Yêu cầu cấu hình không hợp lệ.');
    const settings = validateServerSettings(input.settings);
    if (settings.resourcePolicy && JSON.stringify(settings.resourcePolicy) !== JSON.stringify(serverPolicy(server))) {
      return capacityGate.run({ candidate: { ...server, ...settings }, replaceServerId: server.id }, () => saveConfigurationWithCapacity(server, input, action, detail));
    }
    return saveConfigurationWithCapacity(server, input, action, detail);
  }
  async function saveConfigurationWithCapacity(server, input, action = 'server.configuration', detail = server.name) {
    const settings = validateServerSettings(input.settings);
    if (settings.resourcePolicy && JSON.stringify(settings.resourcePolicy) !== JSON.stringify(serverPolicy(server))) { assertStopped(server); resourceControl = await resourceController.capabilities(); if (settings.resourcePolicy.mode === 'fixed' && !resourceControl.fixedSupported) fail(resourceControl.reason, 409); }
    const original = await properties(server);
    const proposed = { ...original, ...(input.properties === undefined ? {} : validateProperties(input.properties)) };
    if (input.udpMode !== undefined && !['auto', 'custom'].includes(input.udpMode)) fail('udpMode phải là auto hoặc custom.');
    let udpMode = input.udpMode || configurationResult(server, original).network.udpMode;
    // Direct edits in the advanced editor explicitly choose a custom mapping.
    if (input.udpMode === undefined && input.properties?.['server-udp-ports'] !== undefined && String(input.properties['server-udp-ports']) !== original['server-udp-ports']) udpMode = 'custom';
    if (proposed.transport === 'nethernet' && udpMode === 'auto' && (input.properties !== undefined || input.udpMode === 'auto')) proposed['server-udp-ports'] = defaultUdpPorts(Number(proposed['server-port']), Number(proposed['max-players']));
    const values = validateBedrockProperties(proposed);
    const changed = Object.entries(values).some(([key, value]) => original[key] !== value);
    const allowed = allowedTransports(server);
    if (changed && !allowed.includes(values.transport || 'raknet')) fail(`Phiên bản đã cài chỉ được cấu hình transport: ${allowed.join(', ')}. Panel dùng NetherNet cho Preview từ 1.26.60; Mojang đã đánh dấu RakNet deprecated.`);
    const network = validateNetwork(networkServers(), server.id, { port: values['server-port'], portV6: values['server-portv6'], transport: values.transport || 'raknet', udpPorts: values['server-udp-ports'], debugPort: debuggerPort(values) });
    const fields = { ...settings, ...network, maxPlayers: Number(values['max-players']), udpMode };
    if (!changed) { commitServerFields(server, fields, action, detail); emit({ type: 'update' }); return configurationResult(server, values); }
    assertStopped(server);
    pendingNetworks.set(server.id, fields);
    let destination, temporary, rollback;
    let activated = false, committed = false, restored = false;
    try {
      const networkChanged = ['port', 'portV6', 'transport', 'udpPorts', 'debugPort'].some(key => fields[key] !== (server[key] ?? null));
      if (networkChanged) await probePorts(fields);
      const text = serializeProperties(values);
      {
        destination = await safePath(runDirectory(server), 'server.properties');
        temporary = `${destination}.${randomUUID()}.tmp`; rollback = `${destination}.${randomUUID()}.rollback`;
        await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        // Keep the old inode so rollback still works when the data volume is full.
        await fs.link(destination, rollback).catch(async error => { if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error; await fs.copyFile(destination, rollback, fs.constants.COPYFILE_EXCL); });
        await fs.rename(temporary, destination); activated = true;
      }
      validateNetwork(networkServers(), server.id, fields);
      commitServerFields(server, fields, action, detail); committed = true;
      emit({ type: 'update' }); return configurationResult(server, values);
    } catch (error) {
      if (activated && !committed) {
        try { await fs.rename(rollback, destination); restored = true; } catch (rollbackError) { error.message += `; không thể khôi phục server.properties, bản cũ tại ${path.basename(rollback)}: ${rollbackError.message}`; }
      }
      throw error;
    } finally {
      pendingNetworks.delete(server.id);
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      if (rollback && (!activated || committed || restored)) await fs.rm(rollback, { force: true }).catch(() => {});
    }
  }
  async function saveProperties(server, input) { await saveConfiguration(server, { properties: input }); return { ok: true }; }
  function runtimeProtectionIndex(server) {
    const result = new Set();
    for (const file of server.runtimeFiles || ['bedrock_server']) {
      const pieces = (process.platform === 'win32' ? file.toLowerCase() : file).split('/');
      for (let count = 1; count <= pieces.length; count++) result.add(pieces.slice(0, count).join('/'));
    }
    return result;
  }
  function assertMutable(server, name, runtimePaths = runtimeProtectionIndex(server)) {
    const relative = cleanRelative(name, { allowRoot: false });
    const compared = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (runtimePaths.has(compared) || /(^|\/)(?:bedrock_server(?:\.exe)?|.*\.(?:so(?:\.\d+)*|dll|exe|sh|bat|cmd))$/i.test(relative)) fail('Tệp runtime được bảo vệ; hãy dùng công cụ cập nhật phiên bản.', 403);
    return relative;
  }
  function fileGuard(server, current) {
    if (isApp(server)) return (input, mode = 'destructive') => {
      assertStopped(server);
      const relative = filePath(input);
      if (mode !== 'read' && /^(?:node_modules|\.venv|\.home)(?:\/|$)/.test(relative)) fail('Generated dependencies and caches are managed by the dependency installer.', 403);
      return relative;
    };
    const activeWorld = `worlds/${current['level-name'] || 'Bedrock level'}`;
    // Compile once per operation/list, preserving protection of each runtime
    // file and all its ancestor folders without scanning the package per row.
    const runtimePaths = runtimeProtectionIndex(server);
    return (input, mode = 'destructive') => {
      const relative = filePath(input);
      const livePath = process.platform === 'win32' ? relative.toLowerCase() : relative;
      const access = fileAccessContext.getStore();
      const elevated = actorContext.getStore()?.role === 'admin' && access?.serverId === server.id && access.expires > Date.now();
      const live = processes.has(server.id) || server.status !== 'stopped';
      // World copies/archives use consistent backup while live. Readonly file
      // viewing is allowed separately. Elevation cannot bypass write locks.
      if (live && (livePath === 'worlds' || livePath.startsWith('worlds/'))) fail('Dữ liệu thế giới đang được sử dụng. Tạo bản sao lưu trực tiếp hoặc dừng máy chủ để chỉnh sửa.', 409);
      if (mode === 'read') return relative;
      const compared = process.platform === 'win32' ? relative.toLowerCase() : relative;
      const comparedWorld = process.platform === 'win32' ? activeWorld.toLowerCase() : activeWorld;
      if (elevated && !live) return relative;
      if (live && ['server.properties', 'allowlist.json', 'permissions.json'].includes(compared)) fail('Dừng máy chủ trước khi thay đổi tệp cấu hình đang được sử dụng.', 409);
      assertMutable(server, relative, runtimePaths);
      if (/(^|\/)(?:keys)(?:\/|$)/.test(compared) || /(^|\/)server_identity_key\.pem$/.test(compared)) fail('Identity của server được bảo vệ khỏi chỉnh sửa, di chuyển hoặc xóa.', 403);
      if (/(^|\/)(?:behavior_packs|resource_packs)(?:\/|$)/.test(compared) || /(?:^|\/)world_(?:behavior|resource)_packs(?:_history)?\.json$/.test(compared) || compared === 'valid_known_packs.json') fail('Hãy dùng công cụ Add-ons để quản lý pack và đăng ký pack.', 403);
      if (['server.properties', 'allowlist.json', 'permissions.json'].includes(compared)) { if (mode !== 'edit') fail('Tệp cấu hình được bảo vệ; hãy dùng trình soạn thảo hoặc công cụ cấu hình.', 403); return compared; }
      if (['destructive', 'target'].includes(mode) && (compared === comparedWorld || comparedWorld.startsWith(compared + '/'))) fail('Không thể di chuyển hoặc xóa thư mục thế giới đang được chọn; hãy đổi level-name trước.', 409);
      return relative;
    };
  }
  async function fileSettings(server) { if (isApp(server)) return {}; try { return await properties(server); } catch (error) { if (error.status !== 404 && error.code !== 'ENOENT') throw error; return {}; } }
  function assertFileReady(server) {
    assertIdle(server); assertRecovered(server);
    if (isApp(server)) assertStopped(server);
    if (lifecycle.has(server.id) || !['running', 'stopped'].includes(server.status)) fail('Chờ máy chủ hoàn tất khởi động hoặc dừng trước khi thao tác tệp.', 409);
  }
  async function fileTools(server) {
    assertFileReady(server);
    return createFileOperations({ root: runDirectory(server), server, guard: fileGuard(server, await fileSettings(server)), commit: (fields, action, detail) => { commitServerFields(server, fields, action, detail); emit({ type: 'update' }); } });
  }
  async function moveFile(server, input) { return (await fileTools(server)).transfer(input, true); }
  async function readFile(server, name) {
    if (isApp(server)) assertFileReady(server);
    const result = await readTextFile(runDirectory(server), name);
    let protection = null;
    try { fileGuard(server, await fileSettings(server))(result.path, 'edit'); } catch (error) { protection = error.message; }
    const access = fileAccessContext.getStore();
    let needsAccess = false;
    if (!protection && access) {
      try { await fileAccessContext.run(null, async () => fileGuard(server, await fileSettings(server))(result.path, 'edit')); }
      catch { needsAccess = true; }
    }
    return { ...result, editable: !protection, protection, accessExpires: needsAccess && actorContext.getStore()?.role === 'admin' && access?.serverId === server.id && access.expires > Date.now() ? access.expires : null };
  }
  async function writeFile(server, name, content, options = {}) {
    assertFileReady(server);
    const relative = fileGuard(server, await fileSettings(server))(name, 'edit');
    if (typeof content !== 'string' || !content.isWellFormed() || Buffer.byteLength(content) > 2 * 1024 ** 2 || content.includes('\0')) fail('Nội dung phải là văn bản UTF-8 nhỏ hơn 2 MiB.');
    if (!isApp(server) && ['server.properties', 'allowlist.json', 'permissions.json'].includes(relative)) {
      const previous = await readFile(server, relative);
      if (options.requireRevision && options.revision === undefined) fail('Hãy tải lại nội dung tệp trước khi lưu.', 428);
      if (options.revision !== undefined && options.revision !== previous.revision) fail('Tệp đã thay đổi. Hãy tải lại trước khi lưu để tránh mất dữ liệu.', 409);
      if (relative === 'server.properties') await saveProperties(server, parseProperties(content));
      else {
      let value; try { value = JSON.parse(content); } catch { fail('JSON không hợp lệ.'); }
        await savePlayers(server, { ...(await players(server)), [relative === 'allowlist.json' ? 'allowlist' : 'permissions']: value });
      }
      const saved = await readFile(server, relative);
      return { ok: true, path: relative, content: saved.content, revision: saved.revision };
    }
    return (await fileTools(server)).create(relative, content, { ...options, existing: true });
  }
  async function files(server, name = '') {
    if (isApp(server)) assertFileReady(server);
    const relative = cleanRelative(name);
    const guard = fileGuard(server, await fileSettings(server));
    const stopped = ['stopped', 'running'].includes(server.status) && !server.jobId && !server.cloneJobId && !lifecycle.has(server.id) && !operations.has(server.id) && !scheduleLocks.has(server.id);
    const describe = entry => {
      let protection = null, readable = true, editable = !entry.directory && entry.size <= FILE_LIMITS.textBytes;
      try { guard(entry.path, 'read'); } catch { readable = false; }
      try { guard(entry.path, 'destructive'); } catch (error) { protection = error.message; }
      try { guard(entry.path, 'edit'); } catch { editable = false; }
      const immutable = Boolean(protection && !['server.properties', 'allowlist.json', 'permissions.json'].includes(entry.path) && !entry.path.startsWith('worlds/'));
      return { ...entry, protected: Boolean(protection), protection, capabilities: { read: !entry.directory, edit: stopped && editable, download: !entry.directory, copy: stopped && readable && !immutable, move: stopped && !protection, rename: stopped && !protection, delete: stopped && !protection, compress: stopped && readable, extract: stopped && readable && !entry.directory && entry.name.toLowerCase().endsWith('.zip') } };
    };
    const access = fileAccessContext.getStore();
    const response = entries => ({ path: relative, files: entries.map(describe).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)), limits: FILE_LIMITS, fileAccess: actorContext.getStore()?.role === 'admin' && access?.serverId === server.id && access.expires > Date.now() ? { expires: access.expires } : null });
    const target = await safePath(runDirectory(server), relative);
    if (!(await fs.stat(target)).isDirectory()) fail('Đường dẫn không phải thư mục.');
    const entries = [];
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const stat = await fs.lstat(path.join(target, entry.name));
      if (!entry.isFile() && !entry.isDirectory()) continue;
      entries.push({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name, directory: entry.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() });
    }
    return response(entries);
  }
  async function players(server) {
    const read = async name => {
      try { return JSON.parse(await fs.readFile(await safePath(runDirectory(server), name), 'utf8')); } catch (error) { if (error.status === 404 || error.code === 'ENOENT') return []; throw error; }
    };
    const runtime = processes.get(server.id);
    const lists = { allowlist: await read('allowlist.json'), permissions: await read('permissions.json') };
    return { ...lists, revision: playerListsRevision(lists), online: runtime ? gamePlayers(runtime) : [] };
  }
  async function savePlayers(server, input) {
    assertStopped(server);
    const lists = validatePlayerLists(input);
    // savePlayers runs within the per-server operation lock. Read the current
    // pair here so a stale sequential submission cannot overwrite a prior save.
    if (input.revision !== undefined) assertPlayerListRevision(input, await players(server));
    const files = playerListFiles(lists);
    await commitPlayerListFiles(runDirectory(server), files, () => commitServerFields(server, {}, 'server.players'));
    emit({ type: 'update' }); return { ok: true, revision: playerListsRevision(lists) };
  }
  async function worldOptions(server) {
    const runRoot = await safePath(dataDir, `servers/${server.id}/run`);
    const catalog = await inspectPacks(runRoot, { levelName: (await properties(server))['level-name'] || 'Bedrock level', serverVersion: server.version, runtimeFiles: server.runtimeFiles || [] });
    return { serverVersion: server.version, globalPacks: catalog.packs.filter(pack => pack.scope === null) };
  }
  const worldRow = (name, current, inspected) => ({ name, displayName: inspected.metadata.displayName || inspected.metadata.name || name, active: name === current, exists: true, state: 'ready', valid: true, validationMode: 'structural', size: inspected.size, modified: inspected.modified, metadata: inspected.metadata, warnings: inspected.warnings, error: null });
  async function worlds(server) {
    const runRoot = await safePath(dataDir, `servers/${server.id}/run`);
    const values = await properties(server), current = values['level-name'] || 'Bedrock level';
    const names = await existingWorldNames(runRoot);
    const options = await worldOptions(server), rows = [];
    for (const name of names) {
      try { rows.push(worldRow(name, current, await inspectSupportedWorld(await worldTarget(runRoot, name), options))); }
      catch (error) {
        const retryable = error.code === 'WORLD_METADATA_CHANGED' || error.message === 'Dữ liệu thế giới đã thay đổi trong lúc kiểm tra; hãy dừng server và thử lại.' || (['running', 'starting', 'stopping'].includes(server.status) && ['ENOENT', 'ENOTDIR'].includes(error.code));
        rows.push({ name, displayName: name, active: name === current, exists: true, state: retryable ? 'changing' : 'invalid', retryable, valid: false, validationMode: 'structural', size: null, modified: null, metadata: null, warnings: [], error: retryable ? 'World đang thay đổi trong khi server chạy; hãy tải lại hoặc dừng server để kiểm tra.' : error.message });
      }
    }
    const pending = names.includes(current) ? null : { name: current, seed: values['level-seed'] || '', state: 'pending-generation', exists: false, active: true };
    return { worlds: rows, current, pending, limits: WORLD_LIMITS, validationMode: 'structural', warnings: ['Kiểm tra metadata và bố cục world không xác minh khả năng chơi; Bedrock sẽ đọc database khi khởi động.'] };
  }
  async function importWorld(server, archive, input) {
    assertStopped(server);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'filename'].includes(key))) fail('Yêu cầu nhập world không hợp lệ.');
    const runRoot = await safePath(dataDir, `servers/${server.id}/run`);
    const name = validateWorldName(input.name), current = (await properties(server))['level-name'] || 'Bedrock level';
    if (name === current) fail('Tên world đang được chọn; hãy nhập bằng tên mới để không thay dữ liệu active.', 409);
    if ((await existingWorldNames(runRoot)).length >= WORLD_LIMITS.maxWorlds) fail('Panel hỗ trợ tối đa 100 world trên một server.', 409);
    await worldTarget(runRoot, name, { missing: true });
    const options = await worldOptions(server);
    // Own the upload before accepting an asynchronous job: multipart cleanup
    // must not unlink the input while the worker is still reading the archive.
    const ownedArchive = path.join(directory(server), `.world-upload-${randomUUID()}`);
    const stat = await fs.lstat(archive);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WORLD_LIMITS.compressedMB * 1024 ** 2) fail('Archive world phải là tệp thường không quá 1 GiB.');
    try { await fs.copyFile(archive, ownedArchive, fs.constants.COPYFILE_EXCL); await fs.chmod(ownedArchive, 0o600); }
    catch (error) { await fs.rm(ownedArchive, { force: true }).catch(() => {}); throw error; }
    try {
      return job('world-import', server, async progress => {
        const staging = path.join(directory(server), `.world-import-${randomUUID()}`);
        let target, importRoot, activated = false, committed = false;
        try {
          progress(10, 'Đang giải nén và kiểm tra world Bedrock');
          const unpacked = await unpackWorld(ownedArchive, input.filename, staging, options);
          importRoot = unpacked.root;
          target = await worldTarget(runRoot, name, { missing: true });
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          progress(90, 'Đang nhập world bằng tên mới; giữ world đang chọn');
          await fs.rename(unpacked.root, target); activated = true;
          commitServerFields(server, {}, 'world.import', `${server.name}: ${name}`); committed = true;
          const world = worldRow(name, current, unpacked);
          log(server, `Đã nhập world ${name}; world đang chọn được giữ nguyên.`);
          return { result: { world, selected: false }, warnings: world.warnings };
        } catch (error) {
          if (activated && !committed) {
            // Moving the new folder back does not need free space for a copy.
            try { await fs.rename(target, importRoot); }
            catch (rollbackError) { error.message += `; world nhập chưa commit còn tại worlds/${name}: ${rollbackError.message}`; }
          }
          throw error;
        } finally {
          await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
          await fs.rm(ownedArchive, { force: true }).catch(() => {});
        }
      });
    } catch (error) { await fs.rm(ownedArchive, { force: true }).catch(() => {}); throw error; }
  }
  async function selectWorld(server, input, create = false) {
    assertStopped(server);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !(create ? ['name', 'seed'] : ['name']).includes(key))) fail('Yêu cầu chọn hoặc tạo world không hợp lệ.');
    const name = validateWorldName(input.name), seed = create ? validateWorldSeed(input.seed ?? '') : null;
    const runRoot = await safePath(dataDir, `servers/${server.id}/run`);
    if (create) {
      const names = await existingWorldNames(runRoot);
      if (names.length >= WORLD_LIMITS.maxWorlds) fail('Panel hỗ trợ tối đa 100 world trên một server.', 409);
      await worldTarget(runRoot, name, { missing: true });
    } else await inspectSupportedWorld(await worldTarget(runRoot, name), await worldOptions(server));
    const configuration = await saveConfiguration(server, { properties: { 'level-name': name, ...(create ? { 'level-seed': seed } : {}) } }, create ? 'world.create' : 'world.select', `${server.name}: ${name}`);
    // Never write placeholder level.dat/db files: native BDS creates a fresh
    // world from this configuration at its next successful start.
    return { world: { name, active: true, exists: !create, state: create ? 'pending-generation' : 'ready', validationMode: create ? null : 'structural' }, configuration };
  }
  async function exportWorldInfo(server, name) {
    assertStopped(server);
    const target = await worldTarget(await safePath(dataDir, `servers/${server.id}/run`), name);
    await inspectSupportedWorld(target, await worldOptions(server));
    return { target, name: `${name}.mcworld` };
  }
  async function exportWorld(server, name) {
    const info = await exportWorldInfo(server, name);
    const archive = path.join(directory(server), `.world-export-${randomUUID()}.mcworld`);
    try {
      await zipDirectory(info.target, archive, { includeEmptyDirectories: true, maxBytes: WORLD_LIMITS.unpackedMB * 1024 ** 2, maxEntries: WORLD_LIMITS.entries });
      return { path: archive, name: info.name, cleanup: () => fs.rm(archive, { force: true }) };
    } catch (error) { await fs.rm(archive, { force: true }).catch(() => {}); throw error; }
  }
  async function deleteWorld(server, name, input) {
    assertStopped(server); validateWorldName(name);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'name') || input.name !== name) fail('Hãy nhập chính xác tên world để xác nhận xóa.');
    if ((await properties(server))['level-name'] === name) fail('Không được xóa world đang chọn; hãy chọn world khác trước.', 409);
    await worldTarget(await safePath(dataDir, `servers/${server.id}/run`), name);
    const relative = `servers/${server.id}/run/worlds/${name}`, quarantine = await quarantineDeletion(relative, 'server');
    const activity = store.data.activity;
    try { commitServerFields(server, {}, 'world.delete', `${server.name}: ${name} [quarantine: ${quarantine.relative}]`); }
    catch (error) { store.data.activity = activity; await rollbackDeletion(quarantine, error); throw error; }
    return finishDeletion(quarantine);
  }
  const publicBackup = (server, record) => {
    const fields = ['id', 'name', 'size', 'createdAt', 'version', 'kind', 'reason', 'excludes', 'dependenciesRequireInstall', 'consistency'];
    const visible = Object.fromEntries(fields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
    return { ...visible, locked: record.locked === true, sha256: record.sha256 || null, checksumOrigin: record.checksumOrigin || null, integrity: record.integrity || { status: 'unverified', checkedAt: null }, restoreCompatible: (record.kind || 'bedrock') === appKind(server) && (isApp(server) || !record.version || record.version === server.version) };
  };
  async function inspectBackupArchive(archive, expectedHash, progress = () => {}) {
    const initial = await fs.lstat(archive);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 2 * 1024 ** 3 + 16 * 1024 ** 2) fail('Archive sao lưu phải là tệp thường trong giới hạn kích thước hỗ trợ.', 409);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(archive)) {
      bytes += chunk.length; hash.update(chunk);
      if (bytes > initial.size) fail('Archive sao lưu đã thay đổi trong khi kiểm tra.', 409);
      progress(initial.size ? Math.round(bytes / initial.size * 40) : 40, 'Đang kiểm tra SHA-256 của bản sao lưu');
    }
    const sha256 = hash.digest('hex');
    if (expectedHash && sha256 !== expectedHash) fail('SHA-256 của bản sao lưu không khớp; không cho phép khôi phục hoặc tải bản hỏng.', 409);
    progress(45, 'Đang kiểm tra đường dẫn, giới hạn và CRC-32 của archive');
    const checked = await verifyZip(archive);
    const final = await fs.lstat(archive);
    if (bytes !== initial.size || initial.ino !== final.ino || initial.dev !== final.dev || initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs || final.isSymbolicLink()) fail('Archive sao lưu đã thay đổi trong khi kiểm tra.', 409);
    return { sha256, size: final.size, entries: checked.entries, files: checked.files, unpackedBytes: checked.unpackedBytes };
  }
  function commitBackupFields(server, record, fields, action, serverFields = {}) {
    const updated = { ...record, ...fields };
    commitServerFields(server, { ...serverFields, backups: (server.backups || []).map(item => item.id === record.id ? updated : item) }, action, `${server.name}: ${record.name}`);
    emit({ type: 'update' });
    return updated;
  }
  async function checkBackup(server, record, progress, { save = true, clearVerificationFailure = false } = {}) {
    try {
      const archive = await safePath(dataDir, `servers/${server.id}/backups/${record.id}.zip`);
      const checked = await inspectBackupArchive(archive, record.sha256, progress);
      const established = !record.sha256 || record.checksumOrigin === 'established';
      const fields = { sha256: checked.sha256, size: checked.size, checksumOrigin: established ? 'established' : 'created', integrity: { status: established ? 'established' : 'verified', checkedAt: now(), entries: checked.entries, files: checked.files, unpackedBytes: checked.unpackedBytes } };
      // A repaired archive only owns the error raised by its explicit verify
      // job. Keep unrelated process errors, other backups and recovery state.
      const owned = server.backupVerificationFailure;
      const canClear = save && clearVerificationFailure && owned?.backupId === record.id && owned.message === server.error && server.status === 'stopped' && !processes.has(server.id) && !lifecycle.has(server.id) && !server.restoreRecoveryRequired;
      const updated = save ? commitBackupFields(server, record, fields, 'backup.verify', canClear ? { error: null, backupVerificationFailure: null } : {}) : { ...record, ...fields };
      return { archive, backup: publicBackup(server, updated) };
    } catch (error) {
      if (save) {
        try { commitBackupFields(server, record, { integrity: { status: 'failed', checkedAt: now(), error: error.message } }, 'backup.verify.failed'); }
        catch (commitError) { error.message += `; không thể lưu kết quả kiểm tra sao lưu: ${commitError.message}`; }
      }
      throw error;
    }
  }
  async function performBackup(server, progress, reason = 'manual') {
      const id = randomUUID();
      const record = { id, name: `${reason === 'pre-update' ? 'pre-update-' : ''}${server.name}-${now().replace(/[:.]/g, '-')}.zip`, size: 0, createdAt: now(), version: server.version, kind: appKind(server), reason, locked: false, ...(isApp(server) ? { excludes: ['node_modules/', '.venv/', '.home/'], dependenciesRequireInstall: true } : {}) };
      let artifact; const cleanupWarnings = [];
      {
        const backupsRoot = await safePath(dataDir, `servers/${server.id}/backups`, { allowMissing: true });
        await fs.mkdir(backupsRoot, { recursive: true, mode: 0o700 });
        const temporary = path.join(backupsRoot, `.${id}.tmp`);
        const destination = path.join(backupsRoot, `${id}.zip`);
        const snapshot = path.join(backupsRoot, `.${id}.snapshot`);
        const runtime = processes.get(server.id);
        let releaseWorkspace;
        try {
          let source = runDirectory(server);
          const exclude = name => (server.runtimeFiles || []).includes(name) || (isApp(server) && /^(?:node_modules|\.venv|\.home)(?:\/|$)/.test(name));
          if (runtime) {
            const active = () => { if (processes.get(server.id) !== runtime || !runtime.ready || runtime.expected || server.status !== 'running') fail('Server chưa sẵn sàng hoặc đã đổi phiên trong lúc sao lưu.', 409); };
            await runtime.gameplay.run(async () => {
              const control = createBackupConsole({ child: runtime.child, send: command => deliverConsole(server, command, 'server.backup.command', { gameplay: true, internal: true }) });
              runtime.backupConsole = control;
              try {
                await snapshotLiveServer({ root: source, destination: snapshot, worldName: runtime.worldName, console: control, exclude, progress, reserveWorkspace: async bytes => {
                  if (storagePolicy(server).mode === 'fixed') {
                    // The server's volume is already allocated on the host.
                    // Check its own free space rather than reserving it twice.
                    const usage = await fs.statfs(backupsRoot), available = Number(usage.bavail) * Number(usage.bsize);
                    if (!Number.isSafeInteger(available) || available < bytes) fail('Không đủ dung lượng trống trong gói máy chủ để tạo bản sao lưu tạm và ZIP.', 409);
                  } else releaseWorkspace = await reserveDiskWorkspace(bytes);
                },
                  guard: () => { assertOpen(); active(); }, releaseGuard: active });
              } finally { control.close(); delete runtime.backupConsole; }
            });
            source = snapshot; record.consistency = 'native-online';
          } else record.consistency = 'stopped';
          await zipDirectory(source, temporary, { exclude, includeEmptyDirectories: true, progress: value => progress((runtime ? 20 : 0) + value * (runtime ? 0.3 : 0.5), 'Đang nén dữ liệu server') });
          const checked = await inspectBackupArchive(temporary, null, (value, message) => progress(50 + value / 2, message));
          record.sha256 = checked.sha256; record.checksumOrigin = 'created';
          record.integrity = { status: 'verified', checkedAt: now(), entries: checked.entries, files: checked.files, unpackedBytes: checked.unpackedBytes };
          await fs.rename(temporary, destination);
          const stat = await fs.lstat(destination); record.size = stat.size;
          artifact = { path: destination, relative: `servers/${server.id}/backups/${id}.zip`, type: 'backup', ino: stat.ino, dev: stat.dev };
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => {});
          await fs.rm(snapshot, { recursive: true, force: true }).catch(error => {
            const warning = `Chưa dọn được dữ liệu sao lưu tạm tại servers/${server.id}/backups/.${id}.snapshot: ${error.message}`;
            cleanupWarnings.push(warning); log(server, warning, 'warn');
          });
          releaseWorkspace?.();
        }
      }
      try { commitServerFields(server, { backups: [record, ...(server.backups || [])] }, 'backup.create', `${server.name}: ${record.name}`); }
      catch (error) {
        if (artifact) try { await fs.rm(await deletionPath(artifact)); }
        catch (cleanupError) { error.message += `; backup chưa được ghi vào catalog vẫn ở ${artifact.relative}: ${cleanupError.message}`; console.warn(`[Vortex Panel] ${error.message}`); }
        throw error;
      }
      emit({ type: 'update' }); log(server, `Sao lưu hoàn tất: ${record.name}.`);
      const retention = await pruneBackups(server);
      const warnings = [...cleanupWarnings, ...(retention.warnings || [])];
      return { ...record, ...retention, ...(warnings.length ? { warnings } : {}) };
  }
  async function pruneBackups(server) {
    const retention = server.backupRetention || 10, warnings = [];
    // Locked snapshots do not consume the rolling retention allowance.
    for (const record of (server.backups || []).filter(item => item.locked !== true).slice(retention)) {
      try {
        const result = await deleteBackupRecord(server, record, 'backup.retention');
        for (const warning of result.warnings || []) { warnings.push(warning); log(server, warning, 'warn'); }
      } catch (error) {
        const warning = `Bản sao lưu mới đã được tạo, nhưng chưa dọn được bản cũ ${record.name}: ${error.message}. Đã dừng retention để giữ dữ liệu.`;
        warnings.push(warning); log(server, warning, 'warn');
        return { warnings, retentionComplete: false };
      }
    }
    return { ...(warnings.length ? { warnings } : {}), retentionComplete: true };
  }
  async function backup(server) {
    assertIdle(server); assertRecovered(server);
    if (isApp(server)) assertStopped(server);
    const runtime = processes.get(server.id);
    if (lifecycle.has(server.id) || ['starting', 'stopping'].includes(server.status) || ((server.status === 'running') && (!runtime?.ready || runtime.expected))) fail('Đợi server sẵn sàng rồi tạo bản sao lưu.', 409);
    return job('backup', server, progress => performBackup(server, progress));
  }
  const backupRecord = (server, id) => (server.backups || []).find(item => item.id === id) || fail('Không tìm thấy bản sao lưu.', 404);

  async function restore(server, backupId) {
    assertStopped(server);
    const record = backupRecord(server, backupId);
    if ((record.kind || 'bedrock') !== appKind(server)) fail('Backup runtime type does not match this server.', 409);
    if (!isApp(server) && record.version && record.version !== server.version) fail('Bản sao lưu thuộc phiên bản khác. Hãy cài lại phiên bản tương ứng trước khi khôi phục để tránh hỏng thế giới.', 409);
    if (!record.sha256) fail('Bản sao lưu cũ chưa có SHA-256; hãy chạy kiểm tra để thiết lập mốc toàn vẹn trước khi khôi phục.', 409);
    return job('restore', server, async progress => {
      const serverRoot = await safePath(dataDir, `servers/${server.id}`);
      const staging = path.join(serverRoot, `.restore-${randomUUID()}`);
      const rollback = path.join(serverRoot, `.rollback-${randomUUID()}`);
      const before = structuredClone(server);
      let activated = false;
      let committed = false;
      let originalMoved = false;
      let preserveCandidate = false;
      try {
        await fs.mkdir(staging, { mode: 0o700 });
        const { archive } = await checkBackup(server, record, (value, message) => progress(value / 2, message));
        const restored = await extractZip(archive, staging);
        if (restored.some(file => (server.runtimeFiles || []).includes(file))) fail('Bản sao lưu cố thay thế tệp runtime được bảo vệ.');
        let restoredProperties = {};
        if (!isApp(server)) {
        restoredProperties = validateProperties(parseProperties(await fs.readFile(path.join(staging, 'server.properties'), 'utf8')));
        const currentProperties = await properties(server);
        Object.assign(restoredProperties, { 'server-port': String(server.port), 'server-portv6': String(server.portV6), transport: server.transport || 'raknet', 'enable-lan-visibility': 'false', 'allow-inbound-script-debugging': currentProperties['allow-inbound-script-debugging'] || 'false', ...(currentProperties['force-inbound-debug-port'] ? { 'force-inbound-debug-port': currentProperties['force-inbound-debug-port'] } : {}), ...(server.transport === 'nethernet' ? { 'server-udp-ports': server.udpPorts } : {}) });
        await atomicWrite(path.join(staging, 'server.properties'), serializeProperties(restoredProperties));
        for (const file of server.runtimeFiles || []) {
          const source = await safePath(runDirectory(server), file);
          const target = path.join(staging, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(source, target);
        }
        await fs.chmod(path.join(staging, 'bedrock_server'), 0o700);
        }
        progress(90, 'Đang thay thế dữ liệu; giữ bản rollback');
        await fs.rename(runDirectory(server), rollback); originalMoved = true;
        await fs.rename(staging, runDirectory(server));
        activated = true;
        const count = Number(restoredProperties['max-players']); if (Number.isInteger(count)) server.maxPlayers = count;
        server.error = null; persist(); committed = true;
        const warnings = [];
        try { await fs.rm(rollback, { recursive: true, force: true }); }
        catch (error) { warnings.push(`Đã khôi phục server; còn dữ liệu rollback tại ${path.basename(rollback)} cần kiểm tra: ${error.message}`); }
        log(server, `Đã khôi phục ${record.name}.`);
        return { warnings };
      } catch (error) {
        if (originalMoved && !committed) {
          try {
            if (activated) { await fs.rename(runDirectory(server), staging); activated = false; }
            await fs.rename(rollback, runDirectory(server));
            for (const key of Object.keys(server)) delete server[key];
            Object.assign(server, before);
          } catch (rollbackError) {
            // Both the original and candidate may be the only accessible copies
            // after an I/O failure. Keep them, and persist a marker which stops
            // autostart and data mutations until the administrator recovers them.
            preserveCandidate = true;
            const original = path.posix.join('servers', server.id, path.basename(rollback));
            const candidate = path.posix.join('servers', server.id, activated ? 'run' : path.basename(staging));
            for (const key of Object.keys(server)) delete server[key];
            Object.assign(server, before, { status: 'error', restoreRecoveryRequired: { original, candidate, primaryError: error.message, rollbackError: rollbackError.message, backupId: record.id, createdAt: now() } });
            error.message = `Khôi phục rollback thất bại; dữ liệu gốc tại ${original}, dữ liệu bản sao tại ${candidate}. Nguyên nhân ban đầu: ${error.message}; lỗi rollback: ${rollbackError.message}. Cần phục hồi thủ công trước khi khởi động hoặc thay đổi dữ liệu.`;
            server.error = error.message;
          }
        }
        throw error;
      } finally {
        if (!preserveCandidate) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  async function collectMetricsOnce() {
    metricsSampledAt = now();
    if (Date.now() - lastLogMaintenance >= 60000) { lastLogMaintenance = Date.now(); await Promise.allSettled([...logWriters].filter(([id]) => !storagePaused.has(id)).map(([, value]) => value.maintain())); }
    for (const [id, runtime] of processes) {
      const server = get(id);
      try {
        const stat = await fs.readFile(`/proc/${runtime.child.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const ticks = Number(fields[11]) + Number(fields[12]);
        const measuredAt = performance.now(), elapsed = measuredAt - runtime.previousTime;
        runtime.cpuUsedCores = runtime.previousTicks && elapsed > 0 ? Math.max(0, (ticks - runtime.previousTicks) / clockTicks / (elapsed / 1000)) : null;
        server.cpuPercent = runtime.cpuUsedCores == null ? 0 : Math.round(runtime.cpuUsedCores * 1000) / 10;
        const status = await fs.readFile(`/proc/${runtime.child.pid}/status`, 'utf8');
        const rss = status.match(/VmRSS:\s+(\d+)/)?.[1];
        runtime.memoryBytes = rss === undefined ? null : Number(rss) * 1024;
        server.memoryMB = runtime.memoryBytes === null ? 0 : Math.round(runtime.memoryBytes / 1024 ** 2);
        runtime.previousTicks = ticks; runtime.previousTime = measuredAt;
        runtime.sampledAt = now();
      } catch { runtime.cpuUsedCores = null; runtime.memoryBytes = null; runtime.sampledAt = null; }
      try {
        runtime.resourceUsage = await runtime.resourceHandle.stats();
        const usage = runtime.resourceUsage, sampled = performance.now();
        if (usage && Number.isFinite(usage.cpuUsageUsec)) {
          const elapsed = sampled - (runtime.previousResourceTime ?? sampled);
          runtime.cpuUsedCores = runtime.previousResourceCPU != null && elapsed > 0 && usage.cpuUsageUsec >= runtime.previousResourceCPU ? (usage.cpuUsageUsec - runtime.previousResourceCPU) / (elapsed * 1000) : null;
          runtime.previousResourceCPU = usage.cpuUsageUsec; runtime.previousResourceTime = sampled; runtime.cpuScope = 'cgroup';
          server.cpuPercent = runtime.cpuUsedCores === null ? 0 : Math.round(runtime.cpuUsedCores * 1000) / 10;
        } else runtime.cpuScope = 'process';
        if (isApp(server)) {
          // The direct child is Bubblewrap's supervisor. Its idle CPU/RSS
          // cannot stand in for the application and all its descendants.
          if (!usage || !Number.isFinite(usage.cpuUsageUsec) || !Number.isFinite(usage.memoryCurrentBytes)) throw new Error('Application cgroup usage is unavailable.');
          runtime.sampledAt = now(); runtime.memoryBytes = usage.memoryCurrentBytes;
        }
      } catch (error) { runtime.resourceUsage = null; runtime.resourceStatsError = error.message; runtime.cpuScope = isApp(server) ? 'unavailable' : 'process'; if (isApp(server)) { runtime.cpuUsedCores = null; runtime.memoryBytes = null; runtime.sampledAt = null; } }
    }
    {
      await networkMetrics.syncServers([...processes.keys()].map(id => get(id))).catch(() => {});
      await networkMetrics.sample().catch(() => {});
      await Promise.all(store.data.servers.map(async server => {
        if (storagePaused.has(server.id)) return;
        try { storageMetrics.set(server.id, await storageController.stats(server)); }
        catch (error) { storageMetrics.set(server.id, { usedBytes: null, totalBytes: null, availableBytes: null, limitBytes: storagePolicy(server).diskGiB === null ? null : storagePolicy(server).diskGiB * GIB, hardEnforced: false, sampledAt: now(), reason: error.message }); }
      }));
    }
    for (const server of store.data.servers) {
      const samples = serverMetrics.get(server.id) || [];
      samples.push({ time: now(), cpu: processes.has(server.id) ? telemetry(server).cpu.usedPercent : 0, memoryMB: processes.has(server.id) ? telemetry(server).memory.usedBytes === null ? null : telemetry(server).memory.usedBytes / 1024 ** 2 : 0, players: server.players || 0, status: server.status, telemetry: telemetry(server) });
      if (samples.length > 120) samples.splice(0, samples.length - 120);
      serverMetrics.set(server.id, samples);
    }
    try {
      const host = await hostInfo();
      history.push({ time: now(), cpu: host.cpuPercent, memory: host.memoryTotal ? Math.round(host.memoryUsed / host.memoryTotal * 1000) / 10 : 0 });
      if (history.length > 60) history.shift();
    } catch {}
    emit({ type: 'update' });
  }
  function collectMetrics() {
    if (collectingMetrics) return collectingMetrics;
    collectingMetrics = collectMetricsOnce().finally(() => { collectingMetrics = null; });
    return collectingMetrics;
  }
  async function rawHostInfo() {
    if (hostReader) return hostReader(dataDir);
    const { getHostInfo } = await import('./host.js');
    return getHostInfo(dataDir);
  }
  async function capacityHostInfo() {
    const host = { ...await rawHostInfo() };
    // Rate samplers cache their baseline briefly. Admission must observe disk
    // allocations and MemAvailable again after every preceding transaction.
    if (!hostReader) {
      const disk = await fs.statfs(dataDir);
      host.diskTotal = Number(disk.blocks) * Number(disk.bsize);
      host.diskAvailableBytes = Number(disk.bavail) * Number(disk.bsize);
      if (process.platform === 'linux') {
        const memory = await fs.readFile('/proc/meminfo', 'utf8');
        const available = memory.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
        const total = memory.match(/^MemTotal:\s+(\d+)\s+kB$/m);
        if (!available || !total) fail('Memory capacity is unavailable.', 503);
        host.memoryAvailableBytes = host.memoryAvailable = Number(available[1]) * 1024;
        host.memoryTotalBytes = host.memoryTotal = Number(total[1]) * 1024;
        host.memorySampledAt = now();
      }
    }
    return host;
  }
  async function hostInfo() {
    const host = await rawHostInfo(); lastHost = host;
    const capacityHost = await capacityHostInfo();
    const available = capacityHost.diskAvailableBytes ?? capacityHost.diskAvailable ?? capacityHost.disk?.availableBytes ?? capacityHost.diskTotal - capacityHost.diskUsed;
    const pending = [...pendingDisk.values()].reduce((sum, value) => sum + value, 0);
    try { host.capacity = evaluateCapacity({ host: { ...capacityHost, diskAvailableBytes: Math.max(0, available - pending) }, servers: capacityServers(), reserveRatio }).capacity; host.capacity.storage.pendingBytes = pending; }
    catch (error) { host.capacity = { available: false, reason: error.message, sampledAt: now(), reserveRatio }; }
    return host;
  }
  function commitSchedules(action, detail, mutate, serverId) {
    const schedules = store.data.schedules, activity = store.data.activity;
    const before = schedules.map(record => [record, structuredClone(record)]);
    try {
      mutate();
      store.data.activity = [{ id: randomUUID(), time: now(), action, detail, serverId, user: actorContext.getStore()?.username || 'system' }, ...activity];
      store.save();
    } catch (error) {
      for (const [record, fields] of before) { for (const key of Object.keys(record)) delete record[key]; Object.assign(record, fields); }
      store.data.schedules = schedules; store.data.activity = activity; throw error;
    }
    emit({ type: 'update' });
  }
  function runSchedule(schedule, automatic = false) {
    assertOpen();
    const fields = validateSchedule({ action: schedule.action, intervalMinutes: schedule.intervalMinutes, enabled: schedule.enabled, command: schedule.command });
    const server = get(schedule.serverId);
    if (scheduleRuns.has(schedule.id) || scheduleLocks.has(server.id)) fail('Một lịch của server đang chạy. Vui lòng đợi hoàn tất.', 409);
    assertIdle(server);
    if (lifecycle.has(server.id)) fail('Server đang chuyển trạng thái. Vui lòng đợi.', 409);
    const previous = structuredClone(schedule);
    const previousJobs = store.data.jobs;
    const record = { id: randomUUID(), type: 'schedule', scheduleId: schedule.id, action: fields.action, serverId: server.id, status: 'queued', progress: 0, message: 'Đã đưa lịch vào hàng đợi', createdAt: now(), finishedAt: null, commandResult: null, actionStatus: 'not-started' };
    Object.assign(schedule, { status: 'running', lastRun: now(), lastFinishedAt: null, lastJobId: record.id, lastCommandResult: null, error: null, nextRun: new Date(Date.now() + fields.intervalMinutes * 60000).toISOString() });
    store.data.jobs = [record, ...previousJobs];
    try { persist(); }
    catch (error) { for (const key of Object.keys(schedule)) delete schedule[key]; Object.assign(schedule, previous); store.data.jobs = previousJobs; throw error; }
    scheduleLocks.set(server.id, schedule.id);
    const promise = scheduleContext.run(schedule.id, async () => {
      await Promise.resolve();
      try {
        assertOpen(); record.status = 'running'; record.message = `Đang chạy lịch ${schedule.action}`; persist();
        if (fields.command) {
          record.message = fields.action === 'command' ? 'Đang gửi lệnh theo lịch' : 'Đang gửi lệnh trước tác vụ'; record.progress = 5; persist();
          const runtime = processes.get(server.id);
          record.commandResult = { status: 'not-sent', acceptedToConsole: false, confirmedApplied: false, clientReceiptConfirmed: false };
          try {
            if (!isApp(server) && !runtime?.gameplay) fail('Server phải đang chạy để gửi lệnh.', 409);
            record.commandResult = await dispatchScheduledCommand({ command: fields.command, console: isApp(server) ? null : runtime.gameplay, send: command => manager.command(server.id, command) });
          } catch (error) { record.commandResult.message = error.message; throw error; }
          finally { schedule.lastCommandResult = { ...record.commandResult }; }
          persist();
          if (!record.commandResult.acceptedToConsole || !['confirmed', 'dispatched'].includes(record.commandResult.status)) throw new Error(record.commandResult.message || (record.commandResult.status === 'rejected' ? `Tiến trình từ chối lệnh lịch: ${record.commandResult.nativeFeedback || 'Không có phản hồi chi tiết.'}` : 'Chưa xác nhận được thứ tự xử lý lệnh lịch. Tác vụ tiếp theo chưa chạy; không tự gửi lại lệnh.'));
          runtime?.gameRules.clear();
        }
        assertOpen(); record.actionStatus = 'running'; record.actionStartedAt = now();
        if (fields.action === 'backup') {
          const backupJob = await backup(server);
          record.backupJobId = backupJob.id; record.progress = 30; record.message = 'Đang sao lưu dữ liệu'; persist();
          await jobPromises.get(backupJob.id);
          const outcome = store.data.jobs.find(item => item.id === backupJob.id);
          if (outcome?.status !== 'completed') throw new Error(outcome?.message || 'Không xác định được kết quả sao lưu.');
        } else if (fields.action === 'restart') await manager.action(server.id, 'restart', true);
        record.actionStatus = 'completed'; record.actionFinishedAt = now();
        schedule.status = 'completed'; record.status = 'completed'; record.progress = 100; record.message = fields.action === 'command' && record.commandResult?.status === 'dispatched' ? 'Đã gửi lệnh theo lịch; tiến trình không cung cấp xác nhận kết quả tác động.' : 'Lịch đã hoàn tất';
        audit('schedule.run', `${server.name}: ${schedule.action}${automatic ? ' (tự động)' : ' (thủ công)'}`, undefined, { id: automatic ? 'panel.audit.schedule.automatic' : 'panel.audit.schedule.manual', params: [server.name, schedule.action] }, server.id);
      } catch (error) {
        if (record.actionStatus === 'running') record.actionStatus = 'failed';
        schedule.status = 'failed'; schedule.error = error.message; record.status = 'failed'; record.message = error.message;
        try { audit('schedule.failed', `${server.name}: ${error.message}`, undefined, { id: 'panel.audit.operation.failed', params: [server.name, error.message] }, server.id); } catch {}
      } finally {
        schedule.lastFinishedAt = now(); record.finishedAt = schedule.lastFinishedAt;
        scheduleLocks.delete(server.id); scheduleRuns.delete(schedule.id);
        try { persist(); } catch (error) { schedule.status = 'failed'; schedule.error = `Không thể lưu kết quả lịch: ${error.message}`; record.status = 'failed'; record.message = schedule.error; emit({ type: 'update' }); }
      }
    });
    scheduleRuns.set(schedule.id, promise); runningJobs.add(promise); jobPromises.set(record.id, promise);
    promise.finally(() => { runningJobs.delete(promise); jobPromises.delete(record.id); }).catch(() => {});
    return { schedule: { ...schedule }, job: { ...record } };
  }
  async function tickSchedules() {
    maintenanceProbe?.();
    if (closed || maintenance || scheduleBusy) return;
    scheduleBusy = true;
    try {
      for (const schedule of store.data.schedules.filter(item => item.enabled && Date.parse(item.nextRun) <= Date.now())) {
        if (closed) break;
        if (!store.data.servers.some(item => item.id === schedule.serverId)) { schedule.enabled = false; schedule.status = 'failed'; schedule.error = 'Server của lịch không còn tồn tại.'; persist(); continue; }
        // A busy server is retried on the next tick without creating duplicate work.
        if (scheduleRuns.has(schedule.id) || scheduleLocks.has(schedule.serverId)) continue;
        try { runSchedule(schedule, true); }
        catch (error) { if (error.status !== 409) { schedule.status = 'failed'; schedule.error = error.message; schedule.nextRun = new Date(Date.now() + schedule.intervalMinutes * 60000).toISOString(); persist(); } }
      }
    } finally { scheduleBusy = false; }
  }
  const manager = {
    async initialize() {
      if (initialized) return; initialized = true;
      const updatingAtBoot = maintenance?.action === 'update';
      // An acknowledged erase intent is an admission freeze, not permission to
      // recreate mounts, users or counters after an interrupted uninstall.
      if (maintenance?.action === 'uninstall') return;
      resourceControl = await resourceController.initialize();
      await applicationRuntime.initialize();
      await applicationCapabilities();
      {
        storageControl = await storageController.initialize();
        await networkMetrics.initialize();
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        for (const server of store.data.servers) {
          if(!updatingAtBoot){server.status = server.restoreRecoveryRequired || server.status === 'installing' ? 'error' : 'stopped';
          server.players = 0; server.memoryMB = 0; server.cpuPercent = 0; delete server.jobId; delete server.cloneJobId;}
          try { await ensureStorage(server); if(!updatingAtBoot)delete server.storageMountError; }
          catch (error) { if(updatingAtBoot)throw error;server.status = 'error'; server.storageMountError = error.message; server.error = error.message; continue; }
          if(!updatingAtBoot)try { server.debugPort = isApp(server) ? null : debuggerPort(await properties(server)); } catch {}
          // Disk history is diagnostic history. A new manager process must not
          // repopulate a customer's current console with a previous run.
          resetConsole(server);
          try { await writer(server).maintain(); } catch (error) { console.warn(`[Vortex Panel] Console retention startup ${server.id}: ${error.code || 'LOG_READ_FAILED'}`); }
        }
        if(!updatingAtBoot)for (const record of store.data.jobs) if (['running', 'queued'].includes(record.status)) { record.status = 'failed'; record.message = 'Panel khởi động lại khi tác vụ chưa hoàn tất.'; record.finishedAt = now(); }
        if(!updatingAtBoot)for (const record of store.data.schedules) if (record.status === 'running') { record.status = 'failed'; record.error = 'Panel khởi động lại khi lịch chưa hoàn tất.'; record.lastFinishedAt = now(); }
        if(!updatingAtBoot){persist();versionService.refresh().catch(() => {});}
        releaseTimer = setInterval(() => versionService.refresh().catch(() => {}), 6 * 60 * 60 * 1000); releaseTimer.unref();
      }
      for (const server of store.data.servers.filter(item => !updatingAtBoot && !item.restoreRecoveryRequired && !item.storageMountError && (item.autoStart || item.resumeOnPanelStart) && !['running', 'starting'].includes(item.status))) manager.action(server.id, 'start', true).catch(error => { server.error = error.message; log(server, error.message, 'error'); persistRuntime(server); });
      await collectMetrics();
      metricsTimer = setInterval(() => collectMetrics().catch(() => {}), 5000); metricsTimer.unref();
      scheduler = setInterval(() => tickSchedules().catch(() => {}), 15000); scheduler.unref();
    },
    async dashboard() {
      resourceControl = await resourceController.capabilities();
      return { host: await hostInfo(), servers: manager.listServers(), jobs: manager.jobs(), activity: manager.activity(), versions: versionService.metadata(), capabilities: { linux: process.platform === 'linux', root: process.getuid?.() === 0, hostTerminal: process.platform === 'linux' && process.env.ALLOW_HOST_TERMINAL === 'true', portAllocation: process.platform === 'linux' || portAllocator ? PORT_ALLOCATION_POLICY : { supported: false }, resourceControl, applicationRuntime: await applicationCapabilities(), storageControl: { ...storageControl, packageWorkspaceBytes: PACKAGE_WORKSPACE_BYTES }, networkMetrics: networkMetrics.capabilities() }, history: [...history] };
    },
    listServers: () => store.data.servers.map(publicServer),
    getServer: id => publicServer(get(id)),
    appearance: id => appearanceController.read(id),
    appearanceMedia: (id,slot) => appearanceController.media(id,slot),
    saveAppearance: async (id,input) => ({...await appearanceController.update(id,input),server:publicServer(get(id))}),
    uploadAppearance: async (id,slot,buffer,mime,input) => ({...await appearanceController.upload(id,slot,buffer,mime,input),server:publicServer(get(id))}),
    removeAppearance: async (id,slot,input) => ({...await appearanceController.remove(id,slot,input),server:publicServer(get(id))}),
    withActor: (user, callback) => actorContext.run(user, callback),
    beginMaintenance,
    setMaintenanceProbe(probe) { if (maintenanceProbe || typeof probe !== 'function') throw new Error('Invalid maintenance probe.'); maintenanceProbe = probe; },
    withHostOperation,
    maintenanceStatus: () => { maintenanceProbe?.(); return maintenance ? { active: true, action: maintenance.action, requestId: maintenance.requestId } : null; },
    withFileAccess: (access, callback) => fileAccessContext.run(access, callback),
    serverHistory: id => ({ history: [...(serverMetrics.get(get(id).id) || [])], sampleIntervalMs: 5000, retentionSeconds: 600 }),
    async createServer(input) {
      assertOpen();
      await applicationRuntime.assertNoPendingBuilds?.();
      if (input && ['nodejs', 'python'].includes(input.kind)) return createApplicationServer(input);
      if (input?.kind !== undefined && input.kind !== 'bedrock') throw applicationIssue('APPLICATION_INPUT', 400);
      if (!input || input.eula !== true) fail('Bạn cần chấp nhận Minecraft EULA và Điều khoản trước khi cài đặt.');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\r\n\0]/.test(input.name)) fail('Tên server phải có 1–80 ký tự.');
      const selection = await resolveVersion(input.version, input.channel || 'stable');
      const resourcePolicy = normalizeResourcePolicy(input.resourcePolicy);
      const storage = normalizeStoragePolicy(input.storagePolicy);
      resourceControl = await resourceController.capabilities();
      if (resourcePolicy.mode === 'fixed' && !resourceControl.fixedSupported) fail(resourceControl.reason || 'Giới hạn tài nguyên cần server native trên hệ thống hỗ trợ.', 409);
      assertOpen();
      const maxPlayers = Number(input.maxPlayers || 20);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000) fail('Số người chơi tối đa phải từ 1–1000.');
      const portMode = creationPortMode(input);
      const port = input.port ?? 19132;
      const catalogItem = store.data.versions.find(item => item.version === selection.version && item.channel === selection.channel);
      const ports = portMode === 'auto' ? { port: null, portV6: null, transport: catalogItem.transport || 'auto', udpPorts: null, debugPort: null } : validateNetwork(networkServers(), null, { port, portV6: input.portV6 ?? 19133, transport: catalogItem.transport || 'auto', udpPorts: defaultUdpPorts(port, maxPlayers) });
      const server = { id: randomUUID(), name: input.name.trim(), ...selection, ...ports, maxPlayers, status: 'installing', players: 0, createdAt: now(), autoRestart: true, autoStart: false, backupRetention: 10, messageLanguage: 'en', worldVoiceEnabled: true, resourcePolicy, storagePolicy: storage, admissionReservation: { ...SHARED_ADMISSION_RESERVATION }, eulaAcceptedAt: now(), backups: [] };
      { storageControl = await storageController.capabilities(); if (!storageControl.supported) fail(storageControl.reason || 'Hard storage volumes are unavailable on this node.', 409); }
      const packageBytes = !catalogItem.cached ? PACKAGE_WORKSPACE_BYTES : 0;
      return capacityGate.run({ candidate: server, additionalDiskBytes: storage.diskGiB * GIB + packageBytes }, async assessment => {
        try {
        await prepareCreationNetwork(server, portMode);
        pendingDisk.set(server.id, storage.diskGiB * GIB);
        if (packageBytes) { packageWorkspaces.set(server.id, packageBytes); pendingDisk.set(`package:${server.id}`, packageBytes); }
        try {
          const record = registerServerJob(server, 'install', async progress => { try { return await install(server, selection, progress); } finally { pendingDisk.delete(server.id); pendingDisk.delete(`package:${server.id}`); packageWorkspaces.delete(server.id); } }, 'server.create', server.name);
          return { server: publicServer(server), job: record };
        } catch (error) { pendingDisk.delete(server.id); pendingDisk.delete(`package:${server.id}`); packageWorkspaces.delete(server.id); throw error; }
        } finally { pendingNetworks.delete(server.id); }
      });
    },
    updateServer(id, input) {
      assertOpen();
      const server = get(id); assertIdle(server);
      const fields = isApp(server) ? applicationSettings(input) : validateServerSettings(input);
      if (fields.resourcePolicy && JSON.stringify(fields.resourcePolicy) !== JSON.stringify(serverPolicy(server))) { assertStopped(server); if (fields.resourcePolicy.mode === 'fixed' && !resourceControl.fixedSupported) fail(resourceControl.reason || 'Giới hạn tài nguyên cần server native trên hệ thống hỗ trợ.', 409); }
      const resourceChanged = fields.resourcePolicy && JSON.stringify(fields.resourcePolicy) !== JSON.stringify(serverPolicy(server));
      const commit = () => { assertOpen(); assertIdle(server); if (resourceChanged) assertStopped(server); commitServerFields(server, fields, 'server.settings'); emit({ type: 'update' }); return { server: publicServer(server) }; };
      return resourceChanged ? capacityGate.run({ candidate: { ...server, ...fields }, replaceServerId: id }, commit) : commit();
    },
    async deleteServer(id) {
      const server = get(id); assertStopped(server);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(server.id)) fail('ID server không hợp lệ.', 500);
      // Drain pending console writes before moving the stopped instance tree.
      await pauseStorageWrites(server);
      const fixedStorage = (storagePolicy(server).mode === 'fixed');
      try { if (fixedStorage) await storageController.unmount(server); }
      catch (error) { await resumeStorageWrites(server).catch(() => {}); throw error; }
      let quarantine;
      try { quarantine = await quarantineDeletion(`servers/${server.id}`, 'server', { optional: true }); }
      catch (error) { if (fixedStorage) await storageController.ensureMounted(server).catch(problem => { error.message += `; storage remount failed: ${problem.message}`; }); await resumeStorageWrites(server).catch(() => {}); throw error; }
      const before = { servers: store.data.servers, schedules: store.data.schedules, activity: store.data.activity, grants: store.data.users.map(user => ({ user, present: Object.hasOwn(user, 'serverIds'), value: user.serverIds })) };
      try {
        store.data.servers = before.servers.filter(item => item.id !== id);
        store.data.schedules = before.schedules.filter(item => item.serverId !== id);
        for (const { user } of before.grants) user.serverIds = (user.serverIds || []).filter(value => value !== id);
        store.data.activity = [deletionAudit('server.delete', server.name, quarantine, server.id), ...before.activity];
        store.save();
      } catch (error) {
        store.data.servers = before.servers; store.data.schedules = before.schedules; store.data.activity = before.activity;
        for (const { user, present, value } of before.grants) { if (present) user.serverIds = value; else delete user.serverIds; }
        await rollbackDeletion(quarantine, error);
        if (fixedStorage) await storageController.ensureMounted(server).catch(problem => { error.message += `; storage remount failed: ${problem.message}`; });
        await resumeStorageWrites(server).catch(() => {});
        throw error;
      }
      const timer = restartTimers.get(id); if (timer) { clearTimeout(timer); restartTimers.delete(id); }
      await logWriters.get(id)?.close();
      for (const values of [logBuffers, consoleRuns, logWriters, serverMetrics, storageMetrics, crashes, applicationProjects, applicationProjectInstallStates]) values.delete(id);
      storagePaused.delete(id); deferredLogs.delete(id);
      const result = await finishDeletion(quarantine);
      if (fixedStorage) {
        try { await storageController.remove(server); }
        catch (error) { result.warnings = [...(result.warnings || []), `Server deleted; its private storage image requires cleanup: ${server.id}: ${error.message}`]; result.storageCleanupPending = server.id; }
      }
      if (isApp(server)) try { await applicationRuntime.releaseWorkspace(server); } catch (error) { result.warnings = [...(result.warnings || []), `Application account cleanup requires attention: ${error.message}`]; result.applicationAccountCleanupPending = server.id; }
      emit({ type: 'update' }); return result;
    },
    async growStorage(id, input) {
      const server = get(id); assertStopped(server);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'diskGiB')) fail('Yêu cầu tăng dung lượng chỉ chấp nhận diskGiB.', 400);
      const current = storagePolicy(server), proposed = normalizeStoragePolicy({ mode: 'fixed', diskGiB: input.diskGiB });
      if (current.mode !== 'fixed') fail('Máy chủ cũ này chưa có volume lưu trữ giới hạn riêng.', 409);
      if (proposed.diskGiB < current.diskGiB) fail('Volume lưu trữ chỉ có thể tăng dung lượng.', 409);
      const additionalDiskBytes = await storageController.growthAdditionalBytes(server, proposed);
      return capacityGate.run({ candidate: { ...server, storagePolicy: proposed }, replaceServerId: id, additionalDiskBytes }, assessment => {
        assertOpen(); assertStopped(server);
        const before = server.storagePolicy;
        pendingDisk.set(id, assessment.additionalDiskBytes);
        try {
          const record = job('storage-grow', server, async progress => {
            progress(5, 'Đang tăng volume lưu trữ máy chủ', { phase: 'storage' });
            await pauseStorageWrites(server);
            try { await storageController.grow(server, proposed); storageMetrics.set(id, await storageController.stats(server)); progress(100, 'Volume lưu trữ đã sẵn sàng', { phase: 'complete' }); }
            finally { pendingDisk.delete(id); await resumeStorageWrites(server).catch(() => {}); }
          }, () => { server.storagePolicy = proposed; }, () => pendingDisk.delete(id));
          return { server: publicServer(server), job: record };
        } catch (error) { server.storagePolicy = before; pendingDisk.delete(id); throw error; }
      });
    },
    async cloneServer(id, input) {
      await applicationRuntime.assertNoPendingBuilds?.();
      const source = get(id); assertStopped(source);
      if (isApp(source)) fail('Application cloning is not available. Create a new application and restore its source files.', 409);
      if (input.eula !== true) fail('Bạn cần chấp nhận Minecraft EULA trước khi nhân bản.');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\r\n\0]/.test(input.name)) fail('Tên server phải có 1–80 ký tự.');
      const maxPlayers = source.maxPlayers;
      const sourceProperties = await properties(source);
      if (debuggerPort(sourceProperties) !== null) fail('Hãy tắt inbound script debugger trước khi clone để tránh trùng cổng debugger.', 409);
      const portMode = creationPortMode(input);
      const network = portMode === 'auto' ? { port: null, portV6: null, transport: source.transport || 'raknet', udpPorts: null, debugPort: null } : validateNetwork(networkServers(), null, { port: input.port, portV6: input.portV6, transport: source.transport || 'raknet', udpPorts: source.transport === 'nethernet' ? defaultUdpPorts(input.port, maxPlayers) : null });
      const target = { id: randomUUID(), name: input.name.trim(), version: source.version, channel: source.channel, ...network, maxPlayers, status: 'installing', players: 0, createdAt: now(), autoRestart: source.autoRestart, autoStart: false, backupRetention: source.backupRetention || 10, messageLanguage: serverMessageLanguage(source), worldVoiceEnabled: serverWorldVoiceEnabled(source), resourcePolicy: serverPolicy(source), storagePolicy: normalizeStoragePolicy(input.storagePolicy ?? (source.storagePolicy?.mode === 'fixed' ? source.storagePolicy : undefined)), admissionReservation: { ...SHARED_ADMISSION_RESERVATION }, eulaAcceptedAt: now(), backups: [], clonedFrom: source.id, runtimeFiles: [...(source.runtimeFiles || [])] };
      { storageControl = await storageController.capabilities(); if (!storageControl.supported) fail(storageControl.reason || 'Hard storage volumes are unavailable on this node.', 409); }
      return capacityGate.run({ candidate: target }, async assessment => {
      try {
      assertOpen(); assertStopped(source);
      await prepareCreationNetwork(target, portMode);
      assertStopped(source);
      pendingDisk.set(target.id, assessment.additionalDiskBytes);
      let record;
      try { record = registerServerJob(target, 'clone', async progress => {
          try { await storageController.provision(target); storageMetrics.set(target.id, await storageController.stats(target)); }
          finally { pendingDisk.delete(target.id); }
          const files = (await walkFiles(runDirectory(source))).filter(name => !name.startsWith('keys/') && name !== 'server_identity_key.pem');
          if (files.length > 50000) fail('Nhân bản hỗ trợ tối đa 50.000 tệp.');
          let total = 0;
          for (const name of files) { total += (await fs.stat(await safePath(runDirectory(source), name))).size; if (total > 2 * 1024 ** 3) fail('Dữ liệu nhân bản vượt 2 GiB.'); }
          const targetRoot = directory(target); await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
          const staging = path.join(targetRoot, `.clone-${randomUUID()}`);
          try {
            await fs.mkdir(staging, { mode: 0o700 });
            let copied = 0;
            for (const name of files) {
              const destination = path.join(staging, name); await fs.mkdir(path.dirname(destination), { recursive: true });
              await fs.copyFile(await safePath(runDirectory(source), name), destination); await fs.chmod(destination, 0o600);
              progress(++copied / files.length * 90, 'Đang sao chép thế giới và cấu hình');
            }
            await copyEmptyDirectories(runDirectory(source), staging, { exclude: name => name === 'keys' || name.startsWith('keys/') });
            const properties = parseProperties(await fs.readFile(path.join(staging, 'server.properties'), 'utf8'));
            Object.assign(properties, { 'server-name': target.name, 'server-port': String(target.port), 'server-portv6': String(target.portV6), transport: target.transport, 'enable-lan-visibility': 'false', ...(target.transport === 'nethernet' ? { 'server-udp-ports': target.udpPorts } : {}) });
            await atomicWrite(path.join(staging, 'server.properties'), serializeProperties(properties));
            if (target.transport === 'nethernet') await ensureServerIdentity(staging);
            await validateBedrockPackage(staging);
            await fs.rename(staging, runDirectory(target)); target.status = 'stopped'; target.error = null; persist();
            log(target, `Đã nhân bản ${source.name}; tạo identity riêng khi Bedrock khởi động.`);
          } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
      }, 'server.clone', `${source.name} → ${target.name}`, source);
      return { server: publicServer(target), job: record };
      } catch (error) { pendingDisk.delete(target.id); throw error; }
      } finally { pendingNetworks.delete(target.id); }
      });
    },
    async action(id, action, automatic = false, noticeReason = action) {
      assertOpen();
      const server = get(id);
      assertIdle(server);
      if (lifecycle.has(id)) fail('Server đang chuyển trạng thái. Vui lòng đợi.', 409);
      const promise = (async () => {
        // Yield once so the lock is registered before an async operation starts.
        await Promise.resolve();
        if (action === 'start') return { server: await start(server, { automatic }) };
        if (action === 'stop' || action === 'kill') return { server: await stop(server, action === 'kill', false, noticeReason) };
        if (action === 'restart') { await stop(server, false, false, 'restart'); return { server: await start(server, { automatic }) }; }
        fail('Thao tác không hợp lệ.');
      })();
      lifecycle.set(id, promise);
      lifecycleIntents.set(id, action);
      try { return await promise; } finally { lifecycle.delete(id); lifecycleIntents.delete(id); emit({ type: 'update' }); }
    },
    command(id, command) {
      assertOpen();
      const server = get(id); assertIdle(server);
      if (typeof command !== 'string' || !command.trim() || command.length > 2048 || /[\r\n\0]/.test(command)) fail('Lệnh phải là một dòng không quá 2048 ký tự.');
      if (!isApp(server) && ['stop', 'restart'].includes(command.trim().toLowerCase())) fail('Hãy dùng nút dừng hoặc khởi động lại để panel theo dõi đúng tiến trình.');
      const result = deliverConsole(server, command);
      processes.get(id)?.gameRules.clear(); emit({ type: 'update' }); return result;
    },
    announcement(id, input) {
      assertOpen(); const server = get(id); assertIdle(server);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['templateId', 'values', 'expectedLanguage', 'method'].includes(key)) || typeof input.templateId !== 'string') fail('Yêu cầu thông báo server không hợp lệ.');
      const language = serverMessageLanguage(server);
      if (Object.hasOwn(input, 'expectedLanguage')) {
        if (!['en', 'vi'].includes(input.expectedLanguage)) fail('Ngôn ngữ xem trước phải là en hoặc vi.');
        if (input.expectedLanguage !== language) fail('Ngôn ngữ thông báo server đã thay đổi. Hãy xem lại bản xem trước rồi gửi lại.', 409);
      }
      let message;
      try { message = buildWorldVoice({ templateId: input.templateId, values: input.values === undefined ? {} : input.values, language, method: input.method === undefined ? 'say' : input.method }); }
      catch (error) { if (error instanceof WorldVoiceValidationError) fail(worldVoiceErrorText(error, 'vi')); throw error; }
      const result = deliverConsole(server, message.command, 'server.announcement');
      return { ...result, announcement: { templateId: message.templateId, language, method: message.method, minecraftMessage: message.message, preview: message.segments, plainText: message.plainText, normalizedValues: message.normalizedValues, changedFields: message.changedFields } };
    },
    logs: id => ring(get(id)).snapshot(),
    consoleState: id => ({ runId: consoleRun(get(id)) }),
    gameplay: id => gameplayMetadata(get(id)),
    queryGameRules: (id, input) => queryGameRules(get(id), input),
    changeGameRules: (id, input) => changeGameRules(get(id), input),
    playerAction: (id, input) => playerAction(get(id), input),
    logRetentionStats: () => ({ managed: 'panel-console', nativeFilesManaged: false, journaldManaged: false, servers: store.data.servers.map(server => ({ serverId: server.id, memory: ring(server).stats(), disk: logWriters.get(server.id)?.stats() || null })) }),
    logRetention: () => ({ policy: logPolicy(), stats: store.historyStats(), console: manager.logRetentionStats() }),
    async updateLogRetention(input) { assertOpen(); try { store.updateHistoryPolicy(input, actorContext.getStore()?.username || 'system'); } catch (error) { throw canonicalOperationsError(error); } for (const server of store.data.servers) ring(server).replace(ring(server).snapshot()); await Promise.allSettled([...logWriters.values()].map(value => value.maintain())); return manager.logRetention(); },
    clearHistory(input) { assertOpen(); try { return store.clearHistory(input, actorContext.getStore()?.username || 'system'); } catch (error) { throw canonicalOperationsError(error); } },
    exportHistory: () => store.exportHistory(),
    properties: id => properties(get(id)),
    applicationCapabilities,
    application: async (id, { inspect = false } = {}) => {
      await applicationCapabilities(); const server = get(id); applicationResult(server); const runtimeAvailability = await applicationRuntime.runtimeAvailability?.(server);
      const previous = applicationProjects.get(id), installState = JSON.stringify([server.dependencyState?.status || 'unknown', server.dependencyState?.installedAt || null, server.dependencyState?.manifestFingerprint || null]);
      const dependencyState = previous && applicationProjectInstallStates.get(id) === installState ? { ...previous.dependencyState } : { status: server.dependencyState?.status || 'unknown', installedAt: server.dependencyState?.installedAt || null, kind: server.kind, manifest: server.kind === 'nodejs' ? 'package.json' : 'requirements.txt' };
      const summary = { ...(previous || { manifests: [], packages: [], packagesTruncated: false }), runtime: server.runtime ? publicRuntimePin(server.runtime) : { mode: 'legacy', kind: server.kind, version: server.version, source: 'host', method: 'existing-host-runtime' }, dependencyState, inspectionAvailable: false, reason: 'stop-required' };
      if (!inspect || typeof applicationRuntime.inspectProject !== 'function') return applicationResult(server, summary, runtimeAvailability);
      assertStopped(server);
      try { const project = { ...await applicationRuntime.inspectProject(server), inspectionAvailable: true, inspectedAt: now() }; applicationProjects.set(id, project); applicationProjectInstallStates.set(id, installState); return applicationResult(server, project, runtimeAvailability); }
      catch (error) { if (!error.code?.startsWith('APPLICATION_')) throw error; return applicationResult(server, { ...summary, reason: error.code, inspectionError: error.message, ...(error.errorI18n ? { inspectionErrorI18n: error.errorI18n } : {}) }, runtimeAvailability); }
    },
    async saveApplication(id, input) {
      const server = get(id); assertStopped(server); applicationResult(server);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['revision', 'application'].includes(key))) throw applicationIssue('APPLICATION_INPUT', 400);
      if (typeof input.revision !== 'string' || input.revision !== appRevision(server)) fail('Application settings changed. Reload before saving.', 409);
      const application = normalizeApplication(input.application, { kind: server.kind, previous: server.application });
      const runtimeAvailability = await applicationRuntime.runtimeAvailability?.(server);
      commitServerFields(server, { application }, 'server.application', server.name); emit({ type: 'update' }); return applicationResult(server, applicationProjects.get(id), runtimeAvailability);
    },
    async installApplicationDependencies(id, input = {}) {
      const server = get(id); assertStopped(server); applicationResult(server);
      await applicationRuntime.assertNoPendingBuilds?.();
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw applicationIssue('APPLICATION_INPUT', 400);
      await requireApplicationRuntime(server.kind, { server });
      return job('dependencies', server, async progress => {
        progress(5, 'Preparing dependency installation', { phase: 'prepare' });
        await applicationRuntime.prepareWorkspace(server);
        const installTarget = { ...server, application: { ...server.application, dependencies: 'auto' } };
        const result = await applicationRuntime.installDependencies(installTarget, { onOutput: line => { log(server, applicationRuntime.redact(server, line), 'info', 'native'); progress(10, 'Installing application dependencies', { phase: 'dependencies', outputLine: line }); }, onProgress: item => progress(10 + (item.total ? item.completed / item.total * 80 : 0), 'Installing application dependencies', { phase: 'dependencies' }) });
        server.dependencyState = { status: result.installed ? 'installed' : 'not-installed', installedAt: result.installed ? now() : null, ...(result.manifestFingerprint ? { manifestFingerprint: result.manifestFingerprint } : {}) };
        progress(100, 'Dependency installation completed', { phase: 'complete' }); return { message: 'Dependency installation completed', result: { ...result, entrypoint: server.application.entrypoint, startup: startupSummary(server), ...(server.runtime ? { runtime: publicRuntimePin(server.runtime) } : {}) } };
      });
    },
    configuration: async id => { const server = get(id); await hostInfo(); { try { storageMetrics.set(id, await storageController.stats(server)); } catch {} } return configurationResult(server, isApp(server) ? {} : await properties(server)); },
    saveConfiguration: (id, input) => saveConfiguration(get(id), input),
    saveProperties: (id, input) => saveProperties(get(id), input),
    files: (id, name) => files(get(id), name),
    readFile: (id, name) => readFile(get(id), name),
    writeFile: (id, name, content, options) => writeFile(get(id), name, content, options),
    moveFile: (id, input) => moveFile(get(id), input),
    async renameFile(id, input) { if (!input || !Object.hasOwn(input, 'source') || Object.hasOwn(input, 'sources')) fail('Đổi tên cần một source và destination.'); return moveFile(get(id), input); },
    async copyFiles(id, input) { return (await fileTools(get(id))).transfer(input, false); },
    async compressFiles(id, input) { return (await fileTools(get(id))).compress(input); },
    async extractFiles(id, input) { return (await fileTools(get(id))).extract(input); },
    async createFile(id, input) { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path', 'content'].includes(key))) fail('Yêu cầu tạo tệp không hợp lệ.'); return (await fileTools(get(id))).create(input.path, input.content, { action: 'create' }); },
    async mkdir(id, name) { return (await fileTools(get(id))).mkdir(name); },
    async upload(id, directoryName, originalName, temporary) {
      const server = get(id); assertFileReady(server);
      const base = cleanRelative(directoryName || '');
      if (typeof originalName !== 'string' || path.basename(originalName) !== originalName || /[\\/:]/.test(originalName)) fail('Tên tệp tải lên không hợp lệ.');
      const relative = fileGuard(server, await fileSettings(server))(base ? `${base}/${originalName}` : originalName, 'target');
      const stat = await fs.stat(temporary); if (!stat.isFile() || stat.size > 100 * 1024 ** 2) fail('Tệp tải lên không quá 100 MiB.');
      return (await fileTools(server)).create(relative, temporary, { binary: true, action: 'upload' });
    },
    async deleteFile(id, name) { return (await fileTools(get(id))).remove(name); },
    async downloadFile(id, name) { const server = get(id); if (isApp(server)) {
      assertFileReady(server);
      const target = await safePath(runDirectory(server), name, { allowRoot: false });
      const handle = await fs.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const before = await handle.stat();
        if (!before.isFile()) fail('Only regular application files can be downloaded.', 400);
        if (before.size > 100 * 1024 ** 2) fail('Application file downloads are limited to 100 MiB.', 413);
        const content = await handle.readFile();
        const after = await handle.stat();
        if (after.size !== before.size || content.length !== before.size || after.mtimeMs !== before.mtimeMs) fail('The application file changed during download.', 409);
        return { content, name: path.basename(target) };
      } finally { await handle.close(); }
    }  const target = await safePath(runDirectory(server), name, { allowRoot: false }); if (!(await fs.stat(target)).isFile()) fail('Chỉ tải xuống một tệp.'); return { path: target, name: path.basename(target) }; },
    players: id => players(get(id)),
    async packs(id) {
      const server = get(id); assertStopped(server);
      return inspectPacks(runDirectory(server), await packOptions(server));
    },
    async importPacks(id, archive, filename) {
      const server = get(id); assertStopped(server);
      return importPacks(runDirectory(server), archive, { ...await packOptions(server, 'pack.import'), filename });
    },
    async setPackEnabled(id, uuid, enabled) {
      const server = get(id); assertStopped(server);
      return setPackEnabled(runDirectory(server), uuid, enabled, await packOptions(server, enabled ? 'pack.activate' : 'pack.deactivate', uuid));
    },
    async removePack(id, uuid) {
      const server = get(id); assertStopped(server);
      return removePack(runDirectory(server), uuid, await packOptions(server, 'pack.remove', uuid));
    },
    savePlayers: (id, input) => savePlayers(get(id), input),
    worlds: id => worlds(get(id)),
    importWorld: (id, archive, input) => importWorld(get(id), archive, input),
    selectWorld: (id, input) => selectWorld(get(id), input),
    createWorld: (id, input) => selectWorld(get(id), input, true),
    deleteWorld: (id, name, input) => deleteWorld(get(id), name, input),
    exportWorldInfo: (id, name) => exportWorldInfo(get(id), name),
    exportWorld: (id, name) => exportWorld(get(id), name),
    backups: id => { const server = get(id); return (server.backups || []).map(record => publicBackup(server, record)); },
    backupLimits: () => ({ maxLocked: 50, maxRetention: 50, unpackedMB: 2048, entries: 50000 }),
    backup: id => backup(get(id)),
    restore: (id, backupId) => restore(get(id), backupId),
    async downloadBackup(id, backupId) { const server = get(id); const record = backupRecord(server, backupId);  const checked = await checkBackup(server, record, undefined, { save: false }); return { path: checked.archive, name: record.name }; },
    async verifyBackup(id, backupId) {
      const server = get(id), record = backupRecord(server, backupId);
      return job('backup-verify', server, async progress => {
        try { const result = await checkBackup(server, record, progress, { clearVerificationFailure: true }); return { result: { backup: result.backup } }; }
        catch (error) { error[backupVerificationSubject] = record.id; throw error; }
      });
    },
    async setBackupLocked(id, backupId, input) { const server = get(id); const record = backupRecord(server, backupId); if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'locked') || typeof input.locked !== 'boolean') fail('Trạng thái khóa sao lưu phải là boolean.'); if (input.locked && record.locked !== true && (server.backups || []).filter(item => item.locked === true).length >= 50) fail('Mỗi server được khóa tối đa 50 bản sao lưu; hãy mở khóa bản không còn cần giữ.', 409); const updated = commitBackupFields(server, record, { locked: input.locked }, input.locked ? 'backup.lock' : 'backup.unlock'); return { backup: publicBackup(server, updated) }; },
    async deleteBackup(id, backupId) { const server = get(id); assertIdle(server); return deleteBackupRecord(server, backupRecord(server, backupId)); },
    async upgrade(id, input) { const server = get(id); assertStopped(server); const selection = await resolveVersion(input.version, input.channel || server.channel); assertStopped(server); return job('update', server, progress => install(server, selection, progress, true)); },
    versions: () => versionService.metadata(),
    refreshVersions: () => { assertOpen(); return versionService.refresh(); },
    reserveDiskWorkspace,
    async uploadStagingDirectory(id) {
      assertOpen();
      const server = id ? get(id) : null;
      if (server) await ensureStorage(server);
      const base = server && storagePolicy(server).mode === 'fixed' ? directory(server) : dataDir;
      const target = await safePath(base, '.uploads', { allowMissing: true });
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Upload staging directory is unsafe.', 409);
      return target;
    },
    verifyVersion: (version, channel) => { assertOpen(); return versionService.verify(version, channel); },
    importVersion: (file, version, channel) => { assertOpen(); return versionService.importPackage(file, version, channel); },
    jobs: () => store.data.jobs.map(record => ({ ...record })),
    schedules: () => store.data.schedules.map(record => ({ status: 'idle', error: null, command: null, lastCommandResult: null, lastFinishedAt: null, lastJobId: null, ...record })),
    createSchedule(input) {
      assertOpen();
      const fields = validateSchedule(input);
      const server = get(input.serverId);
      const record = { id: randomUUID(), serverId: input.serverId, ...fields, nextRun: new Date(Date.now() + fields.intervalMinutes * 60000).toISOString(), lastRun: null, status: 'idle', lastFinishedAt: null, lastJobId: null, error: null };
      commitSchedules('schedule.create', `${server.name}: ${fields.action}`, () => { store.data.schedules = [...store.data.schedules, record]; }, server.id); return { ...record };
    },
    updateSchedule(id, input) {
      assertOpen(); const record = getSchedule(id);
      if (scheduleRuns.has(id)) fail('Lịch đang chạy; hãy đợi hoàn tất trước khi sửa.', 409);
      const fields = validateSchedule(input, record); const before = structuredClone(record);
      if (input.serverId !== undefined && input.serverId !== record.serverId) fail('Không thể chuyển lịch sang máy chủ khác; hãy tạo lịch mới.');
      const changed = ['action', 'intervalMinutes', 'command'].some(key => fields[key] !== record[key]);
      commitSchedules('schedule.update', `${get(record.serverId).name}: ${fields.action}`, () => {
        Object.assign(record, fields);
        if (changed || (fields.enabled && !before.enabled)) record.nextRun = new Date(Date.now() + fields.intervalMinutes * 60000).toISOString();
      }, record.serverId); return { ...record };
    },
    runSchedule: id => runSchedule(getSchedule(id)),
    deleteSchedule(id) { assertOpen(); const record = getSchedule(id); if (scheduleRuns.has(id)) fail('Lịch đang chạy; hãy đợi hoàn tất trước khi xóa.', 409); commitSchedules('schedule.delete', id, () => { store.data.schedules = store.data.schedules.filter(item => item.id !== id); }, record.serverId); return { ok: true }; },
    serverActivity(id) { get(id); return store.data.activity.filter(record => record.serverId === id).slice(0, 100); },
    activity: () => store.data.activity.slice(0, 100),
    async close() {
      if (closed) return;
      closed = true;
      for (const server of maintenance?.action==='update'?[]:store.data.servers) {
        const intent = lifecycleIntents.get(server.id);
        if (!['stop', 'kill'].includes(intent) && (server.resumeOnPanelStart || ['running', 'starting'].includes(server.status) || ['start', 'restart'].includes(intent))) server.resumeOnPanelStart = true;
        else delete server.resumeOnPanelStart;
      }
      let persistenceError;
      try { persist(); } catch (error) { persistenceError = error; }
      clearInterval(scheduler); clearInterval(metricsTimer); clearInterval(releaseTimer);
      await collectingMetrics?.catch(() => {});
      await capacityGate.close();
      versionService.close();
      for (const timer of restartTimers.values()) clearTimeout(timer); restartTimers.clear();
      await Promise.allSettled([...lifecycle.values()]);
      await Promise.allSettled([...hostOperations]);
      await Promise.allSettled([...operations.values()]);
      // Online backups must release Bedrock's snapshot before the console is
      // closed or stop() checks the active job lock during shutdown.
      await Promise.allSettled([...jobPromises].filter(([id]) => store.data.jobs.some(job => job.id === id && job.type === 'backup')).map(([, promise]) => promise));
      for (const runtime of processes.values()) runtime.gameplay.close();
      await Promise.allSettled([...gameplayRuns]);
      const active = store.data.servers.filter(server => processes.has(server.id));
      await Promise.allSettled(active.map(server => stop(server, false, true)));
      await applicationRuntime.close();
      await Promise.allSettled([...runningJobs]);
      await Promise.allSettled([...resourceCleanup]);
      await Promise.allSettled([...logWriters.values()].map(value => value.close()));
      await networkMetrics.close();
      await storageController.close?.();
      if (persistenceError) throw persistenceError;
    },
  };
  // File edits, deletion and installation selection must not race start/stop.
  const applicationRead = manager.application;
  manager.application = async id => {
    assertOpen(); const server = get(id); applicationResult(server);
    if (server.status !== 'stopped' && server.status !== 'error' || server.jobId || server.cloneJobId || lifecycle.has(id) || operations.has(id) || scheduleLocks.has(id)) return applicationRead(id);
    assertStopped(server);
    const promise = operationContext.run(id, async () => { await Promise.resolve(); return applicationRead(id, { inspect: true }); }); operations.set(id, promise);
    try { const result = await promise; result.server.busy = false; return result; } finally { operations.delete(id); }
  };
  for (const name of ['saveAppearance', 'uploadAppearance', 'removeAppearance', 'saveApplication', 'installApplicationDependencies', 'deleteServer', 'growStorage', 'saveConfiguration', 'saveProperties', 'writeFile', 'moveFile', 'renameFile', 'copyFiles', 'compressFiles', 'extractFiles', 'createFile', 'mkdir', 'upload', 'deleteFile', 'savePlayers', 'backup', 'restore', 'deleteBackup', 'verifyBackup', 'setBackupLocked', 'downloadBackup', 'upgrade', 'cloneServer', 'importPacks', 'setPackEnabled', 'removePack', 'importWorld', 'selectWorld', 'createWorld', 'deleteWorld', 'exportWorld', 'exportWorldInfo']) {
    const method = manager[name];
    manager[name] = async (id, ...args) => {
      assertOpen();
      const server = get(id); assertIdle(server);
      if (lifecycle.has(id) || operations.has(id)) fail('Server đang thực hiện thao tác khác.', 409);
      if (!['verifyBackup', 'setBackupLocked', 'downloadBackup'].includes(name)) assertRecovered(server);
      const promise = operationContext.run(id, async () => { await Promise.resolve(); return method(id, ...args); });
      operations.set(id, promise);
        emit({ type: 'update' });
        let result;
        try { result = await promise; } finally { operations.delete(id); emit({ type: 'update' }); }
        if (result?.server?.id === id) result.server.busy = publicServer(server).busy;
        return result;
    };
  }
  for (const name of ['files', 'readFile', 'downloadFile']) {
    const method = manager[name];
    manager[name] = async (id, ...args) => {
      const server = get(id);
      if (!isApp(server)) return method(id, ...args);
      assertOpen(); assertStopped(server);
      const promise = operationContext.run(id, async () => { await Promise.resolve(); return method(id, ...args); });
      operations.set(id, promise);
      try { return await promise; } finally { operations.delete(id); }
    };
  }
  for (const name of ['properties', 'saveProperties', 'players', 'savePlayers', 'packs', 'importPacks', 'setPackEnabled', 'removePack', 'worlds', 'importWorld', 'selectWorld', 'createWorld', 'deleteWorld', 'exportWorld', 'exportWorldInfo', 'upgrade', 'gameplay', 'queryGameRules', 'saveGameRules', 'playerAction', 'announcement', 'changeGameRules']) {
    if (typeof manager[name] !== 'function') continue;
    const method = manager[name];
    manager[name] = (id, ...args) => { if (isApp(get(id))) fail('This tool is available for Minecraft Bedrock servers only.', 409); return method(id, ...args); };
  }
  return manager;
}
