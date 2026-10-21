import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNodeAgent, validateNodeDataDir } from './node-agent.js';
import { validateNodeEndpoint, requestNode } from './node-transport.js';

const DEFAULT_CONFIG = '/etc/vortex-node.json';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function regularFile(filename, { privateFile = false } = {}) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || privateFile && process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('Node configuration and private keys must be private, regular files without links.');
  return info;
}
function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || !uuid.test(config.nodeId || '') || !/^[A-Za-z0-9_-]{43,256}$/.test(config.token || '') || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.host !== 'string' || !config.host || /[\s\x00-\x1f]/.test(config.host) || !path.isAbsolute(config.dataDir || '')) throw new Error('Invalid node configuration.');
  if (config.tls !== null && (!config.tls || !path.isAbsolute(config.tls.certFile || '') || !path.isAbsolute(config.tls.keyFile || ''))) throw new Error('TLS certificate and key paths must be absolute.');
  if (!config.tls && !['127.0.0.1', '::1'].includes(config.host)) throw new Error('Public node listeners require TLS.');
  if (config.endpoint) config.endpoint = validateNodeEndpoint(config.endpoint);
  validateNodeDataDir(config.dataDir);
  return config;
}
export function readNodeConfig(filename = DEFAULT_CONFIG) {
  regularFile(filename, { privateFile: true });
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { if (fs.fstatSync(fd).size > 65536) throw new Error('Node configuration is too large.'); return validateConfig(JSON.parse(fs.readFileSync(fd, 'utf8'))); }
  finally { fs.closeSync(fd); }
}
function writeConfig(filename, config, { create = false } = {}) {
  validateConfig(config);
  const parent = path.dirname(path.resolve(filename));
  if (fs.realpathSync(parent) !== parent) throw new Error('Node configuration directory must not use symlinks.');
  if (!create) regularFile(filename, { privateFile: true });
  const temporary = path.join(parent, `.vortex-node-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (create) { fs.linkSync(temporary, filename); fs.unlinkSync(temporary); }
    else fs.renameSync(temporary, filename);
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export function initializeNodeConfig({ configFile = DEFAULT_CONFIG, dataDir = '/var/lib/vortex-node', host = '0.0.0.0', port = 8443, certFile = '/etc/vortex-node/tls.crt', keyFile = '/etc/vortex-node/tls.key', endpoint, tls = true } = {}) {
  if (fs.existsSync(configFile)) return { config: readNodeConfig(configFile), created: false };
  const config = validateConfig({ schemaVersion: 1, nodeId: randomUUID(), token: randomBytes(32).toString('base64url'), dataDir: path.resolve(dataDir), host, port, tls: tls ? { certFile: path.resolve(certFile), keyFile: path.resolve(keyFile) } : null, ...(endpoint ? { endpoint } : {}) });
  writeConfig(configFile, config, { create: true }); return { config, created: true };
}
export function rotateNodeToken(configFile = DEFAULT_CONFIG) {
  const config = readNodeConfig(configFile); config.token = randomBytes(32).toString('base64url'); writeConfig(configFile, config); return { nodeId: config.nodeId, restartRequired: true };
}
export function nodeConnection(config, endpoint) {
  const address = endpoint || config.endpoint || (['127.0.0.1', '::1'].includes(config.host) ? `${config.tls ? 'https' : 'http'}://${config.host === '::1' ? '[::1]' : config.host}:${config.port}` : null);
  if (!address) throw new Error('Specify --endpoint https://YOUR_VPS_IP:8443 for the connection record.');
  let fingerprint = null;
  if (config.tls) { regularFile(config.tls.certFile); fingerprint = createHash('sha256').update(new X509Certificate(fs.readFileSync(config.tls.certFile)).raw).digest('hex').toUpperCase(); }
  return { endpoint: validateNodeEndpoint(address), token: config.token, fingerprint, agentId: config.nodeId, protocol: 1 };
}
function optionsFromArgs(args) {
  const result = {};
  const names = { '--config': 'configFile', '--data-dir': 'dataDir', '--host': 'host', '--port': 'port', '--cert': 'certFile', '--key': 'keyFile', '--endpoint': 'endpoint' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--http-loopback') { result.tls = false; continue; }
    const key = names[args[i]]; if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid node CLI option.');
    result[key] = key === 'port' ? Number(args[++i]) : args[++i];
  }
  return result;
}
export async function runNodeCli(args = process.argv.slice(2)) {
  const [command = 'serve', ...rest] = args, options = optionsFromArgs(rest), configFile = options.configFile || process.env.VORTEX_NODE_CONFIG || DEFAULT_CONFIG;
  if (['init', 'initialize'].includes(command)) { const result = initializeNodeConfig({ ...options, configFile }); console.log(JSON.stringify({ created: result.created, nodeId: result.config.nodeId, configFile })); return; }
  if (command === 'show-connection') { console.log(JSON.stringify(nodeConnection(readNodeConfig(configFile), options.endpoint), null, 2)); return; }
  if (command === 'rotate-token') { console.log(JSON.stringify(rotateNodeToken(configFile))); return; }
  if (command === 'check') {
    const config = readNodeConfig(configFile), localHost = config.host === '::' || config.host === '::1' ? '[::1]' : config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
    const connection = nodeConnection(config, `${config.tls ? 'https' : 'http'}://${localHost}:${config.port}`), identity = await requestNode(connection, { timeoutMs: 2500 });
    if (identity?.service !== 'vortex-node' || identity.protocol !== 1 || identity.nodeId !== config.nodeId || !Number.isSafeInteger(identity.processId) || identity.processId < 1) throw new Error('Unexpected node service identity.');
    console.log(JSON.stringify({ ok: true, processId: identity.processId, nodeId: identity.nodeId, maintenance: identity.maintenance || null })); return;
  }
  if (command !== 'serve') throw new Error('Commands: initialize, show-connection, rotate-token, check, serve.');
  const config = readNodeConfig(configFile);
  let certificate;
  if (config.tls) { regularFile(config.tls.keyFile, { privateFile: true }); regularFile(config.tls.certFile); certificate = { cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) }; }
  const runtime = await createNodeAgent({ ...config, configFile, tls: certificate });
  runtime.server.once('error', async () => { console.error('Node listener failed. Check bind address, port and TLS files.'); await runtime.close(); process.exitCode = 1; });
  runtime.server.listen(config.port, config.host, () => console.log(`Vortex node ready: ${config.nodeId} (${certificate ? 'HTTPS' : 'loopback HTTP'}:${config.port})`));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { if (stopping) return; stopping = true; const timer = setTimeout(() => process.exit(1), 210000); timer.unref(); try { await runtime.close(); process.exit(0); } catch { process.exit(1); } });
  return runtime;
}

function isDirectInvocation(filename = process.argv[1]) {
  if (typeof filename !== 'string' || !filename || filename === '-') return false;
  try { return fs.realpathSync(path.resolve(filename)) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isDirectInvocation()) {
  try { await runNodeCli(); } catch { console.error('Node command failed. Check private configuration, file permissions, arguments and node service journal.'); process.exitCode = 1; }
}
