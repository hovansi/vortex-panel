import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseUdpPorts, networkPortReservations } from './safety.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const texts = {
  unsupported: ['Server-port network accounting requires Linux nftables.', 'Đo lưu lượng cổng server cần Linux và nftables.'],
  unavailable: ['Server-port counters are unavailable or kernel permission was denied.', 'Bộ đếm cổng server không khả dụng hoặc thiếu quyền kernel.'],
  ownership: ['The network counter table could not be verified as exclusively owned.', 'Chưa xác minh được bảng đếm mạng thuộc riêng panel.'],
  ready: ['Kernel game-port counters include protocol overhead and traffic from any process using these reserved ports.', 'Bộ đếm kernel gồm phần giao thức và lưu lượng của mọi tiến trình dùng các cổng được dành này.'],
  stopped: ['No active reserved-port counter is attached to this server.', 'Server này chưa có bộ đếm cổng được dành đang hoạt động.'],
};
const presentation = code => ({ reason: texts[code][0], reasonI18n: { id: `panel.network-metrics.${code}`, en: texts[code][0], vi: texts[code][1], params: [] } });
export async function runNft(args, { input = '', timeoutMs = 3000, maxBytes = 2 * 1024 ** 2, spawnProcess = spawn, tempRoot = os.tmpdir() } = {}) {
  const batch = args?.length === 2 && args[0] === '-f' && args[1] === '-';
  if (!Array.isArray(args) || args.length > 16 || args.some(arg => typeof arg !== 'string' || arg.length > 256 || arg.includes('\0')) || typeof input !== 'string'
      || Buffer.byteLength(input) > 8 * 1024 ** 2 || !batch && input || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 ** 2) throw new Error('nft-invalid-command');
  let directory, filename;
  try {
    let commandArgs = args;
    if (batch) {
      // nft opens its batch input as a regular file. Node's pipe may be a Unix
      // socket, which Ubuntu nft rejects through /dev/stdin. Never use a shell.
      directory = await fs.mkdtemp(path.join(tempRoot, 'vortex-nft-'));
      await fs.chmod(directory, 0o700);
      filename = path.join(directory, 'commands.nft');
      const handle = await fs.open(filename, 'wx', 0o600);
      try { await handle.writeFile(input, 'utf8'); } finally { await handle.close(); }
      commandArgs = ['-f', filename];
    }
    return await new Promise((resolve, reject) => {
      const child = spawnProcess('nft', commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' }, windowsHide: true });
      let stdout = '', stderr = '', bytes = 0, failure;
      const fail = code => { if (!failure) failure = new Error(code); try { child.kill('SIGKILL'); } catch {} };
      const timer = setTimeout(() => fail('nft-timeout'), timeoutMs); timer.unref?.();
      for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', data => {
        bytes += data.length;
        if (bytes > maxBytes) { fail('nft-response-too-large'); return; }
        if (failure) return;
        if (key === 'stdout') stdout += data.toString('utf8'); else stderr += data.toString('utf8');
      });
      child.once('error', () => fail('nft-spawn-failed'));
      // close, rather than exit/error, confirms all descriptors are closed:
      // even a timeout must finish killing nft before deleting its batch file.
      child.once('close', code => { clearTimeout(timer); failure ? reject(failure) : resolve({ code, stdout, stderr }); });
    });
  } finally {
    if (filename) await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (directory) await fs.rmdir(directory);
  }
}

const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
export function gamePortSelectors(server) {
  if (!server || !UUID.test(server.id || '')) throw new Error('Invalid native network accounting plan.');
  if (['python', 'nodejs'].includes(server.kind)) {
    const reservations = networkPortReservations(server);
    return ['ipv4', 'ipv6'].map(family => ({ family, protocol: 'tcp', port: reservations[0].port }));
  }
  if (server.kind != null && server.kind !== 'bedrock' || !['raknet', 'nethernet'].includes(server.transport) || !validPort(server.port) || !validPort(server.portV6)) throw new Error('Invalid native network accounting plan.');
  const rows = [];
  const add = (family, protocol, ports) => { for (const port of [...new Set(ports)].sort((a, b) => a - b)) { if (!validPort(port)) throw new Error('Invalid reserved game port.'); rows.push({ family, protocol, port }); } };
  if (server.transport === 'raknet') { add('ipv4', 'udp', [server.port]); add('ipv6', 'udp', [server.portV6]); }
  else for (const family of ['ipv4', 'ipv6']) { add(family, 'tcp', [server.port]); add(family, 'udp', parseUdpPorts(server.udpPorts)); }
  if (server.debugPort !== undefined && server.debugPort !== null) for (const family of ['ipv4', 'ipv6']) add(family, 'tcp', [server.debugPort]);
  const unique = [...new Map(rows.map(row => [`${row.family}:${row.protocol}:${row.port}`, row])).values()];
  if (unique.length > 2052) throw new Error('Too many reserved network accounting ports.');
  return unique.sort((a, b) => a.family.localeCompare(b.family) || a.protocol.localeCompare(b.protocol) || a.port - b.port);
}
function groupedSelectors(selectors) {
  const groups = [];
  for (const family of ['ipv4', 'ipv6']) for (const protocol of ['tcp', 'udp']) {
    const ports = selectors.filter(row => row.family === family && row.protocol === protocol).map(row => row.port);
    if (ports.length) groups.push({ family, protocol, ports });
  }
  return groups;
}
const counterName = (id, direction) => `${direction}_${id.replaceAll('-', '').toLowerCase()}`;
const unsupportedSample = (code = 'stopped') => ({ supported: false, available: false, stale: false, scope: 'server-game-ports', source: 'nftables-counters',
  rxBytes: null, txBytes: null, rxPackets: null, txPackets: null, rxBytesPerSecond: null, txBytesPerSecond: null, sampledAt: null, resetAt: null,
  includesProtocolOverhead: true, processAttributed: false, ...presentation(code) });

export function createNetworkMetrics({ dataDir, platform = process.platform, run = runNft, now = Date.now, monotonic = () => performance.now(), minIntervalMs = 500 } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Network accounting needs an absolute data directory.');
  const identityPath = path.join(dataDir, '.network-metrics.json');
  let identity, table, marker, initialized = false, closed = false, status = 'unsupported', tablePresent = false;
  let tail = Promise.resolve(), initializeFlight, sampleFlight, sampleAt = -Infinity;
  const samples = new Map(), previous = new Map();
  function exclusive(fn) { const work = tail.then(fn); tail = work.catch(() => {}); return work; }
  const capabilities = () => ({ supported: status === 'ready', available: status === 'ready', scope: 'server-game-ports', source: 'nftables-counters',
    includesProtocolOverhead: true, processAttributed: false, changesFirewallVerdicts: false, ...presentation(status) });
  async function command(input) { const result = await run(['-f', '-'], { input }); if (result.code !== 0) throw new Error('nft-operation-failed'); }
  function inspect(value) {
    const items = value?.nftables; if (!Array.isArray(items) || items.length > 10000) throw new Error('network-ownership');
    const tables = items.filter(row => row.table).map(row => row.table);
    if (tables.length !== 1 || tables[0].family !== 'inet' || tables[0].name !== table || tables[0].comment !== marker) throw new Error('network-ownership');
    const counters = new Map(), rules = [], plans = new Map(), chains = new Set();
    const selections = new Map();
    for (const item of items) {
      if (item.metainfo || item.table) continue;
      const row = item.chain || item.counter || item.rule;
      if (!row || row.family !== 'inet' || row.table !== table) throw new Error('network-ownership');
      if (item.chain) {
        if (!['input', 'output'].includes(row.name) || row.hook !== row.name || row.type !== 'filter' || row.prio !== 10 || row.policy !== 'accept' || chains.has(row.name)) throw new Error('network-ownership');
        chains.add(row.name); continue;
      }
      if (item.counter) {
        const match = row.comment?.match(new RegExp(`^${marker}:([a-f0-9-]{36}):([a-f0-9]{16}):(\\d{13})$`));
        if (!match || !UUID.test(match[1]) || !['rx', 'tx'].some(direction => row.name === counterName(match[1], direction)) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(row.packets) || row.packets < 0) throw new Error('network-ownership');
        const prior = plans.get(match[1]); if (prior && (prior.hash !== match[2] || prior.resetAt !== Number(match[3]))) throw new Error('network-ownership');
        plans.set(match[1], { hash: match[2], resetAt: Number(match[3]) }); counters.set(row.name, row); continue;
      }
      const match = row.comment?.match(new RegExp(`^${marker}:([a-f0-9-]{36}):([a-f0-9]{16}):(rx|tx):(\\d+)$`));
      if (!match || !UUID.test(match[1]) || row.chain !== (match[3] === 'rx' ? 'input' : 'output') || !Number.isSafeInteger(row.handle) || row.handle < 1 || !Array.isArray(row.expr) || row.expr.length !== 3) throw new Error('network-ownership');
      const [family, ports, counter] = row.expr;
      if (Object.keys(family).length !== 1 || family.match?.op !== '==' || family.match?.left?.meta?.key !== 'nfproto' || !['ipv4', 'ipv6'].includes(family.match?.right)) throw new Error('network-ownership');
      const matchPort = ports.match, payload = matchPort?.left?.payload;
      const values = Array.isArray(matchPort?.right?.set) ? matchPort.right.set : [matchPort?.right];
      const portValues = [];
      for (const value of values) {
        if (validPort(value)) portValues.push(value);
        else if (Array.isArray(value?.range) && value.range.length === 2 && value.range.every(validPort) && value.range[1] >= value.range[0] && value.range[1] - value.range[0] <= 1024) for (let p = value.range[0]; p <= value.range[1]; p++) portValues.push(p);
        else throw new Error('network-ownership');
      }
      if (Object.keys(ports).length !== 1 || !['==', 'in'].includes(matchPort?.op) || !['tcp', 'udp'].includes(payload?.protocol) || payload?.field !== (match[3] === 'rx' ? 'dport' : 'sport') || !values.length) throw new Error('network-ownership');
      if (Object.keys(counter).length !== 1 || counter.counter !== counterName(match[1], match[3])) throw new Error('network-ownership');
      const selectorKey = `${match[1]}:${match[3]}`, selectors = selections.get(selectorKey) || [];
      selectors.push(...portValues.map(port => ({ family: family.match.right, protocol: payload.protocol, port })));
      selections.set(selectorKey, selectors);
      rules.push({ ...row, serverId: match[1], hash: match[2] });
    }
    if (chains.size !== 2) throw new Error('network-ownership');
    for (const [id, plan] of plans) {
      if (!counters.has(counterName(id, 'rx')) || !counters.has(counterName(id, 'tx')) || !rules.some(rule => rule.serverId === id) || rules.some(rule => rule.serverId === id && rule.hash !== plan.hash)) throw new Error('network-ownership');
      for (const direction of ['rx', 'tx']) {
        const rows = selections.get(`${id}:${direction}`) || [];
        rows.sort((a, b) => a.family.localeCompare(b.family) || a.protocol.localeCompare(b.protocol) || a.port - b.port);
        if (new Set(rows.map(row => `${row.family}:${row.protocol}:${row.port}`)).size !== rows.length || digest(rows) !== plan.hash) throw new Error('network-ownership');
      }
    }
    for (const rule of rules) if (!plans.has(rule.serverId)) throw new Error('network-ownership');
    return { counters, rules, plans };
  }
  async function readTable() {
    const result = await run(['-j', 'list', 'table', 'inet', table], {});
    if (result.code !== 0) { if (/No such file or directory/i.test(result.stderr || '')) return null; throw new Error('nft-unavailable'); }
    let value; try { value = JSON.parse(result.stdout); } catch { throw new Error('nft-invalid-response'); }
    return inspect(value);
  }
  async function ensureIdentity() {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      const descriptor = await fs.open(identityPath, 'wx', 0o600);
      try { const owner = randomUUID(); await descriptor.writeFile(JSON.stringify({ schemaVersion: 1, owner, table: 'vortex_metrics_' + owner.replaceAll('-', '') }) + '\n'); }
      finally { await descriptor.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(identityPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('network-ownership');
    identity = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    if (identity.schemaVersion !== 1 || !UUID.test(identity.owner || '') || identity.table !== 'vortex_metrics_' + identity.owner.replaceAll('-', '')) throw new Error('network-ownership');
    table = identity.table; marker = 'vortex-metrics:' + identity.owner;
  }
  async function initialize() {
    if (initializeFlight) return initializeFlight;
    if (initialized) return capabilities(); initialized = true;
    if (platform !== 'linux' || closed || process.env.NODE_TEST_CONTEXT && run === runNft) return capabilities();
    initializeFlight = (async () => {
      try {
        await ensureIdentity(); const current = await readTable();
        if (!current) await command(`add table inet ${table} { comment "${marker}"; }\nadd chain inet ${table} input { type filter hook input priority 10; policy accept; }\nadd chain inet ${table} output { type filter hook output priority 10; policy accept; }\n`);
        const confirmed = await readTable(); if (!confirmed) throw new Error('nft-unavailable'); tablePresent = true; status = 'ready';
      } catch (error) { status = error.message === 'network-ownership' ? 'ownership' : 'unavailable'; }
      return capabilities();
    })().finally(() => { initializeFlight = null; });
    return initializeFlight;
  }
  async function syncServers(servers) {
    if (!Array.isArray(servers) || servers.length > 512) throw new Error('Invalid network accounting inventory.');
    const desired = new Map(), occupied = new Set();
    for (const server of servers) {
      const selectors = gamePortSelectors(server), id = server.id.toLowerCase();
      if (desired.has(id)) throw new Error('Duplicate network accounting server.');
      for (const row of selectors) { const key = `${row.family}:${row.protocol}:${row.port}`; if (occupied.has(key)) throw new Error('Overlapping network accounting reservations.'); occupied.add(key); }
      desired.set(id, { selectors, hash: digest(selectors) });
    }
    return exclusive(async () => {
      await initialize(); if (closed || status !== 'ready') return capabilities();
      try {
        let current = await readTable(); if (!current) throw new Error('nft-unavailable'); const commands = [];
        const changed = [...new Set([...current.plans.keys(), ...desired.keys()])].filter(id => current.plans.get(id)?.hash !== desired.get(id)?.hash);
        for (const id of changed) {
          for (const rule of current.rules.filter(rule => rule.serverId === id)) commands.push(`delete rule inet ${table} ${rule.chain} handle ${rule.handle}`);
          for (const direction of ['rx', 'tx']) if (current.counters.has(counterName(id, direction))) commands.push(`delete counter inet ${table} ${counterName(id, direction)}`);
          if (desired.has(id)) {
            const plan = desired.get(id), stamp = now();
            for (const direction of ['rx', 'tx']) commands.push(`add counter inet ${table} ${counterName(id, direction)} { comment "${marker}:${id}:${plan.hash}:${stamp}"; }`);
            for (const [index, group] of groupedSelectors(plan.selectors).entries()) for (const direction of ['rx', 'tx']) commands.push(`add rule inet ${table} ${direction === 'rx' ? 'input' : 'output'} meta nfproto ${group.family} ${group.protocol} ${direction === 'rx' ? 'dport' : 'sport'} { ${group.ports.join(', ')} } counter name ${counterName(id, direction)} comment "${marker}:${id}:${plan.hash}:${direction}:${index}"`);
          }
        }
        if (commands.length) { await command(commands.join('\n') + '\n'); current = await readTable(); if (!current) throw new Error('nft-unavailable'); }
        if (current.plans.size !== desired.size || [...desired].some(([id, plan]) => current.plans.get(id)?.hash !== plan.hash)) throw new Error('network-ownership');
        for (const id of changed) { samples.delete(id); previous.delete(id); }
        sampleAt = -Infinity; return capabilities();
      } catch (error) { status = error.message === 'network-ownership' ? 'ownership' : 'unavailable'; return capabilities(); }
    });
  }
  async function sample(serverId) {
    await initialize();
    if (closed || status !== 'ready') return serverId ? unsupportedSample(closed ? 'stopped' : status) : {};
    if (!sampleFlight && monotonic() - sampleAt >= minIntervalMs) sampleFlight = exclusive(async () => {
      try {
        const current = await readTable(); if (!current) throw new Error('nft-unavailable');
        const at = monotonic(), sampledAt = new Date(now()).toISOString();
        for (const [id, plan] of current.plans) {
          const rx = current.counters.get(counterName(id, 'rx')), tx = current.counters.get(counterName(id, 'tx')), before = previous.get(id), elapsed = before ? at - before.at : null;
          const valid = before && before.resetAt === plan.resetAt && elapsed > 0 && rx.bytes >= before.rxBytes && tx.bytes >= before.txBytes;
          samples.set(id, { ...unsupportedSample('ready'), supported: true, available: true, stale: false, rxBytes: rx.bytes, txBytes: tx.bytes, rxPackets: rx.packets, txPackets: tx.packets,
            rxBytesPerSecond: valid ? (rx.bytes - before.rxBytes) * 1000 / elapsed : null, txBytesPerSecond: valid ? (tx.bytes - before.txBytes) * 1000 / elapsed : null,
            sampleDurationMs: valid ? elapsed : null, sampledAt, resetAt: new Date(plan.resetAt).toISOString(), countersSince: 'counter-reset' });
          previous.set(id, { at, resetAt: plan.resetAt, rxBytes: rx.bytes, txBytes: tx.bytes });
        }
        for (const id of samples.keys()) if (!current.plans.has(id)) { samples.delete(id); previous.delete(id); }
        sampleAt = at;
      } catch (error) {
        status = error.message === 'network-ownership' ? 'ownership' : 'unavailable';
        for (const [id, value] of samples) samples.set(id, { ...value, available: false, stale: true, rxBytesPerSecond: null, txBytesPerSecond: null, ...presentation(status) });
      }
    }).finally(() => { sampleFlight = null; });
    await sampleFlight;
    return serverId ? peek(serverId) : Object.fromEntries(samples);
  }
  function peek(id) {
    const value = samples.get(id); if (!value) return unsupportedSample(status === 'ready' ? 'stopped' : status);
    return now() - Date.parse(value.sampledAt) > 10000 ? { ...value, stale: true, available: false, rxBytesPerSecond: null, txBytesPerSecond: null } : { ...value };
  }
  async function close({ cleanup = true } = {}) {
    return exclusive(async () => {
      if (closed) return;
      if (initializeFlight) await initializeFlight;
      closed = true;
      if (cleanup && tablePresent && table) {
        try { const current = await readTable(); if (current) await command(`delete table inet ${table}\n`); }
        catch { return { cleaned: false, ...presentation('ownership') }; }
      }
      samples.clear(); previous.clear(); return { cleaned: true };
    });
  }
  return { initialize, syncServers, sample, peek, capabilities, close };
}
