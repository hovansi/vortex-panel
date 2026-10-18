import fs from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { defaultUdpPorts, networkPortReservations, validateNetwork } from './safety.js';

export const PORT_ALLOCATION_POLICY = Object.freeze({ supported: true, schemaVersion: 1, mode: 'auto', minPort: 20000, maxPort: 59999, excludesEphemeral: true, authority: 'node' });
const messages = Object.freeze({
  PORT_ALLOCATION_INPUT: ['Invalid port allocation request. Choose automatic allocation without port fields, or supply manual ports.', 'Yêu cầu cấp cổng không hợp lệ. Chọn tự động và bỏ các trường cổng, hoặc nhập cổng thủ công.'],
  PORT_ALLOCATION_INVENTORY: ['Host port usage could not be verified. No server was created; refresh and try again after checking the node.', 'Không xác minh được các cổng đang dùng trên VPS. Chưa tạo máy chủ; kiểm tra node rồi tải lại và thử lại.'],
  PORT_ALLOCATION_EXHAUSTED: ['No free port allocation remains in the safe range on this VPS. No server was created.', 'Không còn cụm cổng trống trong dải an toàn trên VPS này. Chưa tạo máy chủ.'],
  PORT_ALLOCATION_UNSUPPORTED: ['This node does not support automatic port allocation. Update its agent or choose manual ports.', 'Node này chưa hỗ trợ tự động cấp cổng. Cập nhật agent hoặc chọn cổng thủ công.'],
});
export const PORT_ALLOCATION_MESSAGES = Object.freeze(Object.entries(messages).map(([code, [en, vi]]) => Object.freeze({ id: `panel.ports.${code.toLowerCase()}`, en, vi })));
export function supportsAutomaticPorts(capability) { return capability?.supported === true && capability.schemaVersion === 1 && capability.mode === 'auto' && capability.authority === 'node'; }
export function requireAutomaticPorts(capability) { if (!supportsAutomaticPorts(capability)) throw issue('PORT_ALLOCATION_UNSUPPORTED'); }
function issue(code, status = 409) {
  const [en, vi] = messages[code];
  return Object.assign(new Error(vi), { code, status, errorI18n: { id: `panel.ports.${code.toLowerCase()}`, en, vi, params: [] } });
}
const portFields = ['port', 'portV6', 'udpPorts', 'debugPort', 'server-port', 'server-portv6', 'server-udp-ports', 'force-inbound-debug-port'];
export function creationPortMode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.portAllocation !== undefined && !['auto', 'manual'].includes(input.portAllocation)) throw issue('PORT_ALLOCATION_INPUT', 400);
  const supplied = portFields.some(key => Object.hasOwn(input, key));
  if (input.portAllocation === 'auto' && supplied) throw issue('PORT_ALLOCATION_INPUT', 400);
  if (input.portAllocation === 'manual' && input.port === undefined) throw issue('PORT_ALLOCATION_INPUT', 400);
  return input.portAllocation || (supplied ? 'manual' : 'auto');
}

async function readProcText(filename) {
  const limit = filename.endsWith('ip_local_port_range') ? 128 : filename.endsWith('ip_local_reserved_ports') ? 1024 * 1024 : 16 * 1024 ** 2;
  const handle = await fs.open(filename, 'r'), chunks = [];
  let length = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead;
      if (length > limit) throw issue('PORT_ALLOCATION_INVENTORY');
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally { await handle.close(); }
}

// Read every local socket, including connected sockets and IPv6/loopback binds.
// A wildcard bind probe alone cannot see every reusable UDP listener. Unknown
// tables or ephemeral policy therefore fail closed rather than guessing.
export async function readHostPortInventory({ readFile = readProcText, platform = process.platform } = {}) {
  if (platform !== 'linux') throw issue('PORT_ALLOCATION_INVENTORY');
  const files = ['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/udp', '/proc/net/udp6', '/proc/sys/net/ipv4/ip_local_port_range', '/proc/sys/net/ipv4/ip_local_reserved_ports'];
  let contents;
  try { contents = await Promise.all(files.map(filename => readFile(filename, 'utf8'))); }
  catch { throw issue('PORT_ALLOCATION_INVENTORY'); }
  const ports = new Set();
  for (const [index, value] of contents.slice(0, 4).entries()) {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024 ** 2) throw issue('PORT_ALLOCATION_INVENTORY');
    const lines = value.trim().split('\n');
    if (!/^\s*sl\s+local_address\s+(?:rem|remote)_address\s+st\b/.test(lines.shift() || '')) throw issue('PORT_ALLOCATION_INVENTORY');
    const width = index % 2 === 0 ? 8 : 32;
    const address = new RegExp(`^[0-9a-fA-F]{${width}}:[0-9a-fA-F]{4}$`);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || !/^\d+:$/.test(fields[0]) || !address.test(fields[1]) || !address.test(fields[2]) || !/^[0-9a-fA-F]{2}$/.test(fields[3])) throw issue('PORT_ALLOCATION_INVENTORY');
      const port = Number.parseInt(fields[1].slice(-4), 16);
      if (port) ports.add(port);
    }
  }
  const range = typeof contents[4] === 'string' && contents[4].trim().match(/^(\d{1,5})\s+(\d{1,5})$/);
  const ephemeral = range && range.slice(1).map(Number);
  if (!ephemeral || ephemeral[0] < 1024 || ephemeral[1] > 65535 || ephemeral[0] > ephemeral[1]) throw issue('PORT_ALLOCATION_INVENTORY');
  if (typeof contents[5] !== 'string' || contents[5].length > 1024 * 1024) throw issue('PORT_ALLOCATION_INVENTORY');
  const reserved = new Set(), reservedText = contents[5].trim();
  if (reservedText) for (const value of reservedText.split(',')) {
    const match = value.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!match) throw issue('PORT_ALLOCATION_INVENTORY');
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first < 1 || last > 65535 || first > last) throw issue('PORT_ALLOCATION_INVENTORY');
    for (let port = first; port <= last; port++) reserved.add(port);
  }
  return { ports: [...ports], ephemeral, reserved: [...reserved] };
}

export function createPortAllocator({ readInventory = readHostPortInventory, random = randomInt, minPort = PORT_ALLOCATION_POLICY.minPort, maxPort = PORT_ALLOCATION_POLICY.maxPort, protectedPorts = [] } = {}) {
  if (!Number.isInteger(minPort) || !Number.isInteger(maxPort) || minPort < 1024 || maxPort > 65535 || minPort > maxPort || !Array.isArray(protectedPorts) || protectedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw issue('PORT_ALLOCATION_INPUT', 400);
  return async function allocate({ kind = 'bedrock', transport = 'auto', maxPlayers = 20, servers = [], excludedPorts = [] } = {}) {
    if (!['bedrock', 'nodejs', 'python'].includes(kind) || !['auto', 'raknet', 'nethernet'].includes(transport) || !Array.isArray(servers) && typeof servers !== 'function' || !Array.isArray(excludedPorts) || excludedPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || kind === 'bedrock' && (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000)) throw issue('PORT_ALLOCATION_INPUT', 400);
    let inventory;
    try { inventory = await readInventory(); }
    catch { throw issue('PORT_ALLOCATION_INVENTORY'); }
    if (!inventory || !Array.isArray(inventory.ports) || inventory.ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || !Array.isArray(inventory.ephemeral) || inventory.ephemeral.length !== 2 || inventory.ephemeral.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || inventory.ephemeral[0] > inventory.ephemeral[1] || inventory.reserved !== undefined && (!Array.isArray(inventory.reserved) || inventory.reserved.some(port => !Number.isInteger(port) || port < 1 || port > 65535))) throw issue('PORT_ALLOCATION_INVENTORY');
    // Manager callers provide a reader: pending configuration changes may have
    // reserved new ports while procfs I/O was awaited. Read them afterwards.
    try { if (typeof servers === 'function') servers = servers(); } catch { throw issue('PORT_ALLOCATION_INVENTORY'); }
    if (!Array.isArray(servers)) throw issue('PORT_ALLOCATION_INVENTORY');
    const blocked = new Uint8Array(65536);
    for (const port of [22, 80, 443, 3000, 8080, 8443, ...protectedPorts, ...inventory.ports, ...(inventory.reserved || []), ...excludedPorts]) blocked[port] = 1;
    for (let port = inventory.ephemeral[0]; port <= inventory.ephemeral[1]; port++) blocked[port] = 1;
    try {
      for (const server of servers) {
        for (const row of networkPortReservations(server)) blocked[row.port] = 1;
        // NetherNet does not bind its v6 property today, but assigning it again
        // would still duplicate a displayed allocation and break a later move.
        for (const key of ['port', 'portV6', 'debugPort']) if (server[key] != null) blocked[Number(server[key])] = 1;
      }
    } catch { throw issue('PORT_ALLOCATION_INVENTORY'); }
    const width = kind !== 'bedrock' ? 1 : transport === 'raknet' ? 2 : Math.max(32, maxPlayers + 4) + 2;
    const prefix = new Uint32Array(65537);
    for (let port = 0; port < blocked.length; port++) prefix[port + 1] = prefix[port] + blocked[port];
    const candidates = [];
    for (let port = minPort; port + width - 1 <= maxPort; port++) if (prefix[port + width] === prefix[port]) candidates.push(port);
    if (!candidates.length) throw issue('PORT_ALLOCATION_EXHAUSTED');
    const index = random(candidates.length);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) throw issue('PORT_ALLOCATION_INVENTORY');
    const port = candidates[index];
    return validateNetwork(servers, null, kind !== 'bedrock' ? { kind, port } : { port, portV6: port + 1, transport, udpPorts: transport === 'raknet' ? null : defaultUdpPorts(port, maxPlayers) });
  };
}
