import path from 'node:path';
import { createNativeFirewall } from './native-firewall.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUdpPorts, networkPortReservations } from './safety.js';

const execute = promisify(execFile), UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
let hostTail = Promise.resolve();
const texts = {
  unsupported: ['Firewall management requires a separate data scope and Linux root access.', 'Quản lý firewall cần thư mục dữ liệu riêng và quyền root Linux.'],
  unavailable: ['The host firewall is unavailable or could not be inspected safely.', 'Firewall trên VPS không khả dụng hoặc không thể kiểm tra an toàn.'],
  inactive: ['UFW is inactive. The panel will not enable it or change its rules.', 'UFW chưa bật. Panel không bật UFW hoặc thay đổi rule.'],
  ready: ['Review the server ports before applying scoped UFW rules.', 'Kiểm tra cổng server trước khi áp dụng rule UFW riêng.'],
  complete: ['The requested server-port rules are active and saved by the host firewall.', 'Các rule cổng máy chủ yêu cầu đã được áp dụng và lưu trên VPS.'],
  removed: ['This server\'s scoped Vortex rules were removed. Foreign rules may still allow these ports.', 'Đã xóa rule Vortex riêng của server này. Rule khác vẫn có thể cho phép các cổng đó.'],
  partial: ['Firewall changes were only partly confirmed. Review the current rules before retrying.', 'Chỉ xác nhận được một phần thay đổi firewall. Kiểm tra rule hiện tại trước khi thử lại.'],
  unsafe: ['Some owned or relevant firewall rules cannot be reconciled safely. Review them manually.', 'Có rule firewall thuộc panel hoặc liên quan chưa thể đồng bộ an toàn. Cần kiểm tra thủ công.'],
  external: ['Only the selected host firewall is managed. Cloud firewalls, NAT, routing and client connectivity are not verified.', 'Chỉ quản lý firewall được chọn trên VPS. Chưa xác minh firewall cloud, NAT, định tuyến hoặc kết nối từ client.'],
  native_ready: ['Review the server ports before applying scoped native firewall rules.', 'Kiểm tra cổng máy chủ trước khi áp dụng rule firewall riêng.'],
  native_persistence: ['Native firewall access requires existing, verified netfilter-persistent configuration. No rules were enabled or adopted automatically.', 'Firewall gốc cần cấu hình netfilter-persistent hiện có được xác minh. Panel không tự bật hoặc tiếp quản rule.'],
  FIREWALL_INPUT: ['Confirm the inspected firewall revision before applying server-port rules.', 'Hãy xác nhận revision firewall vừa kiểm tra trước khi áp dụng rule cổng server.'],
  FIREWALL_STALE: ['Server network settings or firewall rules changed. Inspect again before applying.', 'Cấu hình mạng server hoặc rule firewall đã thay đổi. Hãy kiểm tra lại trước khi áp dụng.'],
  FIREWALL_NETWORK: ['The installed server must have a supported, validated network configuration.', 'Server đã cài cần có cấu hình mạng được hỗ trợ và kiểm tra hợp lệ.'],
  FIREWALL_CONTEXT: ['Firewall controls require a native server and dedicated data directory.', 'Công cụ firewall cần server thực và thư mục dữ liệu riêng.'],
};
const present = key => ({ message: texts[key][0], messageI18n: { id: `panel.firewall.${key.toLowerCase()}`, en: texts[key][0], vi: texts[key][1], params: [] } });
export function serverFirewallErrorPayload(error, language = 'en') {
  const code = error?.code;
  if (!code?.startsWith('FIREWALL_') || !texts[code]) return null;
  const value = present(code); return { error: value.messageI18n[language === 'vi' ? 'vi' : 'en'], errorI18n: value.messageI18n };
}
function fail(code, status = 400) { throw Object.assign(new Error(texts[code][0]), { code, status, errorI18n: present(code).messageI18n }); }
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const key = rule => `${rule.family}:${rule.protocol}:${rule.port}`;
const summary = rule => ({ protocol: rule.protocol, port: rule.port, family: rule.family, ...(rule.purpose ? { purpose: rule.purpose, purposeI18n: rule.purposeI18n } : {}) });
const purpose = (id, en, vi) => ({ purpose: en, purposeI18n: { id: `panel.firewall.purpose.${id}`, en, vi, params: [] } });
function ranges(ports) {
  const sorted = [...new Set(ports)].sort((a, b) => a - b), result = [];
  for (let i = 0; i < sorted.length; i++) { const start = sorted[i]; let end = start; while (sorted[i + 1] === end + 1) end = sorted[++i]; result.push(start === end ? String(start) : `${start}:${end}`); }
  return result;
}
function portRanges(value) {
  if (!/^(?:\d{1,5}(?::\d{1,5})?)(?:,\d{1,5}(?::\d{1,5})?)*$/.test(value)) return null;
  const result = value.split(',').map(part => { const [start, end = start] = part.split(':').map(Number); return [start, end]; });
  return result.every(([start, end]) => start >= 1 && end <= 65535 && start <= end) ? result : null;
}
function derive(server) {
  if (!server || !UUID.test(server.id || '')) fail('FIREWALL_NETWORK', 409);
  if (['python', 'nodejs'].includes(server.kind)) {
    let reservations; try { reservations = networkPortReservations(server); } catch { fail('FIREWALL_NETWORK', 409); }
    return { serverId: server.id.toLowerCase(), transport: 'tcp', ports: ['ipv4', 'ipv6'].map(family => ({ protocol: 'tcp', port: String(reservations[0].port), family, ...purpose('application', 'Application TCP', 'TCP ứng dụng') })) };
  }
  if (server.kind != null && server.kind !== 'bedrock' || !['raknet', 'nethernet'].includes(server.transport)) fail('FIREWALL_NETWORK', 409);
  for (const port of [server.port, server.portV6]) if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('FIREWALL_NETWORK', 409);
  const ports = [];
  if (server.transport === 'raknet') {
    ports.push({ protocol: 'udp', port: String(server.port), family: 'ipv4', ...purpose('raknet4', 'RakNet IPv4', 'Game RakNet IPv4') }, { protocol: 'udp', port: String(server.portV6), family: 'ipv6', ...purpose('raknet6', 'RakNet IPv6', 'Game RakNet IPv6') });
  } else {
    let udp; try { udp = parseUdpPorts(server.udpPorts); } catch { fail('FIREWALL_NETWORK', 409); }
    for (const family of ['ipv4', 'ipv6']) {
      ports.push({ protocol: 'tcp', port: String(server.port), family, ...purpose('signaling', 'NetherNet signaling', 'Báo hiệu kết nối NetherNet') });
      for (const port of ranges(udp)) ports.push({ protocol: 'udp', port, family, ...purpose('traffic', 'NetherNet game traffic', 'Lưu lượng game NetherNet') });
    }
  }
  if (ports.length > 258) fail('FIREWALL_NETWORK', 409);
  return { serverId: server.id.toLowerCase(), transport: server.transport, ports };
}
// The English numbered status preserves address families, unlike `show added`,
// which deduplicates equivalent IPv4/IPv6 commands. Never execute parsed text.
function parseStatus(stdout, owner) {
  const text = String(stdout).replaceAll('\r', '');
  if (/^Status: inactive\s*$/m.test(text)) return { status: 'inactive', rows: [], unsafe: false, raw: text };
  if (!/^Status: active\s*$/m.test(text)) throw new Error('UFW_STATUS');
  const rows = []; let unsafe = false;
  for (const line of text.split('\n').filter(line => /^\[/.test(line.trim()))) {
    const match = line.trim().match(/^\[\s*\d+\]\s+(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)(?:\s+(IN|OUT|FWD))?\s+(.+)$/);
    if (!match) { unsafe = true; continue; }
    let [, destination, action, direction = 'IN', source] = match;
    let comment = ''; const separator = source.indexOf(' # ');
    if (separator >= 0) { comment = source.slice(separator + 3).trim(); source = source.slice(0, separator).trim(); }
    const family = destination.endsWith(' (v6)') ? 'ipv6' : 'ipv4';
    destination = destination.replace(/ \(v6\)$/, '').trim(); source = source.replace(/ \(v6\)$/, '').trim();
    const target = destination.match(/^(\d[\d:,]*)(?:\/(tcp|udp))?$/), parsed = target && portRanges(target[1]);
    const global = ['Anywhere', '0.0.0.0/0', '::/0'].includes(source);
    const known = Boolean(parsed && global && direction === 'IN');
    if (comment === owner && (!known || action !== 'ALLOW' || !target?.[2]) || direction === 'IN' && action !== 'ALLOW' && !parsed) unsafe = true;
    rows.push({ family, action, direction, sourceAny: global, port: target?.[1] || null, protocol: target?.[2] || 'any', ranges: parsed, owner: comment === owner, comment, known });
  }
  return { status: 'active', rows, unsafe, raw: text };
}
const overlaps = (row, target) => row.family === target.family && (row.protocol === 'any' || row.protocol === target.protocol) && row.ranges?.some(([a, b]) => portRanges(target.port).some(([c, d]) => a <= d && c <= b));
const covers = (row, target) => row.known && row.action === 'ALLOW' && row.family === target.family && (row.protocol === 'any' || row.protocol === target.protocol) && portRanges(target.port).every(([a, b]) => row.ranges.some(([c, d]) => c <= a && d >= b));
function covered(rows, target, desired) {
  // Obsolete owned ranges will be removed later. They must not suppress their
  // narrower replacement. Foreign rules can jointly cover a requested range.
  const intervals = rows.filter(row => row.known && row.action === 'ALLOW' && row.family === target.family && (row.protocol === 'any' || row.protocol === target.protocol) && (!row.owner || desired.has(key(row)))).flatMap(row => row.ranges).sort((a, b) => a[0] - b[0]);
  return portRanges(target.port).every(([start, end]) => { let cursor = start; for (const [a, b] of intervals) { if (a > cursor) break; if (b >= cursor) cursor = b + 1; if (cursor > end) return true; } return false; });
}
function argsFor(rule, owner, remove = false) {
  const any = rule.family === 'ipv6' ? '::/0' : '0.0.0.0/0';
  // Prepend chooses the first position within this address family. `insert 1`
  // uses combined IPv4/IPv6 numbering and rejects IPv6 when IPv4 rules exist.
  // Prepend retains insertion's duplicate-skip behavior for existing tuples;
  // an empty family has no foreign tuple to replace. A non-empty comment is
  // mandatory for the exact-owner delete match.
  return [...(remove ? ['--force', 'delete'] : ['prepend']), 'allow', 'in', 'proto', rule.protocol, 'from', any, 'to', any, 'port', rule.port, 'comment', owner];
}

export function createServerFirewall({ scope, exec = execute, platform = process.platform, uid = process.getuid?.(), commandTimeoutMs = 10000, maxDurationMs = 120000 } = {}) {
  const supported = platform === 'linux' && uid === 0 && typeof scope === 'string' && path.isAbsolute(scope);
  const scopeId = typeof scope === 'string' && path.isAbsolute(scope) ? hash(path.resolve(scope)).slice(0, 16) : 'unavailable';
  const run = args => exec('/usr/sbin/ufw', args, { timeout: commandTimeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
  async function observe(owner) { return parseStatus((await run(['status', 'numbered'])).stdout, owner); }
  async function assertNativeAllowed() {
    try { if ((await observe('')).status !== 'inactive') throw new Error('Active UFW owns the host firewall.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const native = createNativeFirewall({ exec, supported, present, assertNativeAllowed, commandTimeoutMs, maxDurationMs });
  function response(network, observed, owner, extra = {}) {
    const desired = new Set(network.ports.map(key)), own = observed.rows.filter(row => row.owner), unsafe = observed.unsafe || network.ports.some(target => observed.rows.some(row => row.direction === 'IN' && row.action !== 'ALLOW' && overlaps(row, target)));
    const ports = network.ports.map(target => ({ ...target, state: observed.rows.some(row => row.owner && key(row) === key(target) && covers(row, target)) ? 'managed' : covered(observed.rows, target, desired) ? 'covered' : 'missing' }));
    const status = observed.status, canApply = supported && status === 'active' && !unsafe;
    const warningKeys = ['external', ...(unsafe ? ['unsafe'] : [])], warnings = warningKeys.map(key => texts[key][0]), warningsI18n = warningKeys.map(key => present(key).messageI18n);
    const value = { ...network, backend: 'ufw', ports, status, supported, canApply, canRemove: supported && status === 'active' && !observed.unsafe && own.length > 0, revision: supported ? hash({ network, rules: observed.raw }) : null, owner, managedRules: own.map(summary), obsoleteRules: own.filter(row => !desired.has(key(row))).map(summary), warnings, warningsI18n, ...present(!supported ? 'unsupported' : status === 'inactive' ? 'inactive' : status !== 'active' ? 'unavailable' : unsafe ? 'unsafe' : 'ready'), ...extra };
    return value;
  }
  async function inspect(server) {
    const network = derive(server), owner = `vortex:${scopeId}:${network.serverId}`;
    if (!supported) return response(network, { status: 'unavailable', rows: [], raw: '' }, owner);
    try {
      const observed = await observe(owner);
      return observed.status === 'inactive' ? await native.inspect(network, owner) : response(network, observed, owner);
    } catch (error) {
      return error.code === 'ENOENT' ? await native.inspect(network, owner) : response(network, { status: 'unavailable', rows: [], raw: '' }, owner);
    }
  }
  async function applyImmediate(server, input, resolveCurrent, removeAll = false) {
    if (!input || Object.keys(input).some(key => !['revision', 'confirmed'].includes(key)) || input.confirmed !== true || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) fail('FIREWALL_INPUT', 400);
    const current = async () => resolveCurrent ? await resolveCurrent() : server;
    const network = derive(await current()), owner = `vortex:${scopeId}:${network.serverId}`, identity = hash(network), added = [], removed = [], errors = []; let attempts = 0;
    let observed;
    if (!supported) return { ...await inspect(server), ok: false, partial: false, added, removed, errors: [texts.unsupported[0]], errorsI18n: [present('unsupported').messageI18n] };
    try { observed = await observe(owner); }
    catch (error) {
      if (error.code === 'ENOENT') return native.apply(network, { ...input, scopeId }, async () => derive(await current()), removeAll);
      return { ...await inspect(server), ok: false, partial: false, added, removed, errors: [texts.unavailable[0]], errorsI18n: [present('unavailable').messageI18n] };
    }
    if (observed.status === 'inactive') return native.apply(network, { ...input, scopeId }, async () => derive(await current()), removeAll);
    let state = response(network, observed, owner);
    if (state.revision !== input.revision) fail('FIREWALL_STALE', 409);
    const permitted = observation => removeAll ? supported && observation.status === 'active' && !observation.unsafe : response(network, observation, owner).canApply;
    if (!permitted(observed)) return { ...state, ok: false, partial: false, added, removed, errors: [state.message], errorsI18n: [state.messageI18n] };
    const began = Date.now(), desired = new Set(removeAll ? [] : network.ports.map(key));
    async function fresh() {
      if (Date.now() - began > maxDurationMs) throw new Error('TIMEOUT');
      if (hash(derive(await current())) !== identity) throw new Error('NETWORK_CHANGED');
      const next = await observe(owner);
      if (hash(derive(await current())) !== identity) throw new Error('NETWORK_CHANGED');
      if (next.raw !== observed.raw) throw new Error('RULES_CHANGED');
      if (!permitted(next)) throw new Error('UNSAFE');
      observed = next;
    }
    try {
      for (const target of removeAll ? [] : network.ports) {
        await fresh();
        if (covered(observed.rows, target, desired)) continue;
        attempts++; await run(argsFor(target, owner));
        observed = await observe(owner);
        if (observed.rows.some(row => row.owner && key(row) === key(target) && covers(row, target))) added.push(summary(target));
        else if (!covered(observed.rows, target, desired)) throw new Error('NOT_CONFIRMED');
      }
      for (const obsolete of observed.rows.filter(row => row.owner && !desired.has(key(row)))) {
        await fresh();
        if (!observed.rows.some(row => row.owner && key(row) === key(obsolete))) continue;
        attempts++; await run(argsFor(obsolete, owner, true)); observed = await observe(owner);
        if (observed.rows.some(row => row.owner && key(row) === key(obsolete))) throw new Error('NOT_CONFIRMED');
        removed.push(summary(obsolete));
      }
      if (hash(derive(await current())) !== identity) throw new Error('NETWORK_CHANGED');
    } catch {
      errors.push(texts.partial[0]);
      try { observed = await observe(owner); } catch { observed = { status: 'unavailable', rows: [], raw: '' }; }
    }
    state = response(network, observed, owner);
    const ok = errors.length === 0 && (removeAll ? permitted(observed) && state.managedRules.length === 0 : state.canApply && state.ports.every(port => port.state !== 'missing') && state.obsoleteRules.length === 0);
    return { ...state, ok, partial: !ok && attempts > 0, added, removed, errors, errorsI18n: errors.map(() => present('partial').messageI18n), ...present(ok ? removeAll ? 'removed' : 'complete' : 'partial') };
  }
  const enqueue = (server, input, resolveCurrent, removeAll) => { const run = hostTail.then(() => applyImmediate(server, input, resolveCurrent, removeAll)); hostTail = run.catch(() => {}); return run; };
  return { inspect, apply: (server, input, resolveCurrent) => enqueue(server, input, resolveCurrent, false), remove: (server, input, resolveCurrent) => enqueue(server, input, resolveCurrent, true) };
}
