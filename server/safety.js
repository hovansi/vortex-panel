import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

export function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function cleanRelative(input = '', { allowRoot = true } = {}) {
  if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || input.includes(':') || input.startsWith('/')) fail('Đường dẫn không hợp lệ.');
  const pieces = input.split('/').filter(Boolean);
  if (pieces.some(piece => piece === '..' || piece === '.' || /[\x00-\x1f]/.test(piece))) fail('Đường dẫn không hợp lệ.');
  const relative = pieces.join('/');
  if (!relative && !allowRoot) fail('Không được thao tác thư mục gốc.');
  return relative;
}

export async function safePath(root, input = '', options = {}) {
  const relative = cleanRelative(input, options);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  for (const piece of relative.split('/').filter(Boolean)) {
    current = path.join(current, piece);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail('Không cho phép truy cập liên kết tượng trưng.', 403);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!options.allowMissing) fail('Không tìm thấy tệp hoặc thư mục.', 404);
    }
  }
  if (current !== realRoot && !current.startsWith(realRoot + path.sep)) fail('Đường dẫn vượt ngoài server.', 403);
  return current;
}

export async function atomicWrite(destination, content) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function walkFiles(root, relative = '') {
  const results = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail('Server chứa liên kết tượng trưng; không thể sao lưu hoặc sao chép an toàn.', 409);
    if (entry.isDirectory()) results.push(...await walkFiles(root, name));
    else if (entry.isFile()) results.push(name);
    else fail('Server chứa tệp thiết bị hoặc socket; thao tác bị từ chối.', 409);
  }
  return results;
}

export function parseProperties(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals > 0) {
      const key = line.slice(0, equals).trim();
      const value = line.slice(equals + 1).trim();
      // BDS permits repeated UDP/NAT mappings. Commas preserve the same mappings.
      result[key] = key === 'server-udp-ports' && result[key] ? `${result[key]},${value}` : value;
    }
  }
  return result;
}

export function serializeProperties(properties) {
  return '# Managed by Vortex Panel\n' + Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

export function validateProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties) || Object.keys(properties).length > 200) fail('Cấu hình không hợp lệ.');
  const result = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) fail('Khóa hoặc giá trị cấu hình không hợp lệ.');
    const text = String(value);
    if (text.length > 2048 || /[\r\n\0]/.test(text)) fail('Giá trị cấu hình chứa ký tự không hợp lệ.');
    if (key === 'level-name' && (!text || text === '.' || text === '..' || /[\\/:]/.test(text))) fail('Tên thế giới không hợp lệ.');
    result[key] = text;
  }
  return result;
}

export function validatePorts(servers, id, portInput, v6Input) {
  const port = Number(portInput);
  const portV6 = Number(v6Input);
  for (const number of [port, portV6]) if (!Number.isInteger(number) || number < 1024 || number > 65535) fail('Cổng phải nằm trong khoảng 1024–65535.');
  if (port === portV6) fail('Cổng IPv4 và IPv6 phải khác nhau.');
  const conflict = servers.find(server => server.id !== id && [server.port, server.portV6].some(value => [port, portV6].includes(Number(value))));
  if (conflict) fail(`Cổng đang được server “${conflict.name}” sử dụng.`, 409);
  return { port, portV6 };
}

export function parseUdpPorts(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) fail('NetherNet cần dải server-udp-ports riêng để kiểm soát cổng game.');
  const entries = input.split(',').map(entry => entry.trim());
  if (entries.length > 128 || entries.some(entry => !entry)) fail('Dải UDP không hợp lệ.');
  const ports = new Set();
  const range = (value, internal) => {
    if (!/^\d{1,5}(?:-\d{1,5})?$/.test(value)) fail('Dải UDP phải có dạng 19200 hoặc 19200-19231; hỗ trợ ánh xạ NAT IP:external:internal.');
    const numbers = value.split('-').map(Number); const [start, end = start] = numbers;
    if (start < (internal ? 1024 : 1) || end > 65535 || end < start || end - start > 4095) fail('Dải UDP vượt giới hạn cổng cho phép.');
    return { start, end, length: end - start + 1 };
  };
  for (const entry of entries) {
    const lastColon = entry.lastIndexOf(':');
    const internal = range(lastColon < 0 ? entry : entry.slice(lastColon + 1), true);
    if (lastColon >= 0) {
      const advertised = entry.slice(0, lastColon);
      let externalText = advertised;
      if (advertised.startsWith('[')) {
        const close = advertised.indexOf(']');
        if (close < 0 || advertised[close + 1] !== ':' || isIP(advertised.slice(1, close)) !== 6) fail('Địa chỉ IPv6 NAT không hợp lệ.');
        externalText = advertised.slice(close + 2);
      } else if (advertised.includes(':')) {
        const separator = advertised.lastIndexOf(':');
        if (isIP(advertised.slice(0, separator)) !== 4) fail('Địa chỉ IPv4 NAT không hợp lệ.');
        externalText = advertised.slice(separator + 1);
      }
      if (range(externalText, false).length !== internal.length) fail('Dải cổng external/internal NAT phải có cùng độ dài.');
    }
    for (let port = internal.start; port <= internal.end; port++) {
      if (ports.has(port)) fail('Dải UDP nội bộ bị trùng lặp.');
      ports.add(port);
      if (ports.size > 4096) fail('Tổng dải UDP vượt giới hạn 4096 cổng.');
    }
  }
  return [...ports];
}

export function defaultUdpPorts(port, maxPlayers) {
  const start = Number(port) + 2;
  const end = start + Math.max(32, Number(maxPlayers) + 4) - 1;
  if (end > 65535) fail('Cổng quá cao để cấp dải UDP NetherNet. Chọn cổng signaling thấp hơn.');
  return `${start}-${end}`;
}

function applicationNetwork(input) {
  if (input.transport != null && input.transport !== 'tcp' || ['portV6', 'udpPorts', 'debugPort', 'server-portv6', 'server-udp-ports', 'force-inbound-debug-port'].some(key => input[key] != null)) {
    fail('Application servers accept one TCP port and no Bedrock UDP, IPv6-port or debugger settings.');
  }
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('Cổng phải nằm trong khoảng 1024–65535.');
  return { port, portV6: null, transport: 'tcp', udpPorts: null, debugPort: null };
}

function networkKind(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Cấu hình không hợp lệ.');
  const kind = input.kind ?? 'bedrock';
  if (!['bedrock', 'python', 'nodejs'].includes(kind)) fail('Unsupported server kind.');
  return kind;
}

// TCP and UDP have separate namespaces. Reservations deliberately include
// stopped/installing servers; a pending Bedrock auto transport reserves both
// possible signaling protocols until its actual package is known.
export function networkPortReservations(server) {
  const kind = networkKind(server);
  if (kind !== 'bedrock') return [{ protocol: 'tcp', port: applicationNetwork(server).port }];
  const port = Number(server.port), portV6 = Number(server.portV6), transport = server.transport || 'raknet';
  for (const number of [port, portV6]) if (!Number.isInteger(number) || number < 1024 || number > 65535) fail('Cổng phải nằm trong khoảng 1024–65535.');
  if (!['raknet', 'nethernet', 'auto'].includes(transport)) fail('Transport phải là raknet hoặc nethernet.');
  const rows = [], add = (protocol, number) => rows.push({ protocol, port: number });
  if (transport !== 'nethernet') { add('udp', port); add('udp', portV6); }
  if (transport !== 'raknet') { add('tcp', port); for (const number of parseUdpPorts(server.udpPorts)) add('udp', number); }
  if (server.debugPort != null) {
    const debug = Number(server.debugPort);
    if (!Number.isInteger(debug) || debug < 1024 || debug > 65535) fail('Cổng debugger phải từ 1024–65535.');
    add('tcp', debug);
  }
  return [...new Map(rows.map(row => [`${row.protocol}:${row.port}`, row])).values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.port - b.port);
}

export function validateNetwork(servers, id, input) {
  const kind = networkKind(input);
  if (kind !== 'bedrock') {
    const network = applicationNetwork(input), reserved = `tcp:${network.port}`;
    for (const other of servers.filter(server => server.id !== id)) {
      if (networkPortReservations(other).some(row => `${row.protocol}:${row.port}` === reserved)) fail(`Cổng đang được server “${other.name}” sử dụng.`, 409);
    }
    return network;
  }
  // validatePorts retains its conservative legacy public API; network-aware
  // validation below compares only listeners using the same protocol.
  const basic = validatePorts([], id, input.port, input.portV6);
  const transport = input.transport || 'raknet';
  if (!['raknet', 'nethernet', 'auto'].includes(transport)) fail('Transport phải là raknet hoặc nethernet.');
  const udpPorts = transport === 'raknet' ? [] : parseUdpPorts(input.udpPorts);
  const debugPort = input.debugPort == null ? null : Number(input.debugPort);
  if (debugPort !== null && (!Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535)) fail('Cổng debugger phải từ 1024–65535.');
  if (debugPort !== null && [basic.port, basic.portV6, ...udpPorts].includes(debugPort)) fail('Cổng debugger không được trùng với cổng game.');
  const network = { ...basic, transport, udpPorts: transport === 'raknet' ? null : input.udpPorts, debugPort };
  const reserved = new Set(networkPortReservations(network).map(row => `${row.protocol}:${row.port}`));
  for (const other of servers.filter(server => server.id !== id)) {
    const conflict = networkPortReservations(other).find(row => reserved.has(`${row.protocol}:${row.port}`));
    if (conflict) {
      if ([basic.port, basic.portV6].includes(conflict.port) && [Number(other.port), Number(other.portV6)].includes(conflict.port)) fail(`Cổng đang được server “${other.name}” sử dụng.`, 409);
      fail(`Dải cổng trùng với server “${other.name}”. Chọn cổng hoặc dải UDP khác.`, 409);
    }
  }
  return network;
}
