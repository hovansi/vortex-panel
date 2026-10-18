import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MiB = 1024 ** 2;

async function tool(executable, args) {
  try {
    const { stdout } = await execute(executable, args, { timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' });
    return { available: true, output: stdout };
  } catch (error) { return { available: false, output: '', reason: error.code === 'ENOENT' ? 'Không có công cụ trên host.' : 'Không thể đọc thông tin trong thời gian cho phép.' }; }
}

// Parse fixed `ss -H -lntu` output. Do not return command lines or process environments.
export function parseListeners(output) {
  const result = [];
  for (const line of String(output).split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !['tcp', 'udp'].includes(fields[0])) continue;
    const endpoint = fields[4], colon = endpoint.lastIndexOf(':');
    const port = Number(endpoint.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    result.push({ protocol: fields[0], address: endpoint.slice(0, colon).replace(/^\[|\]$/g, ''), port });
    if (result.length >= 128) break;
  }
  return result.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

async function processes() {
  if (process.platform !== 'linux') return [{ pid: process.pid, name: 'node', memoryMB: Math.round(process.memoryUsage().rss / MiB * 10) / 10, threads: null, panel: true }];
  let entries;
  try { entries = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name)).slice(0, 4096); } catch { return []; }
  const records = [];
  // Bound concurrent /proc reads; expose only panel/runtime executables, never argv.
  for (let offset = 0; offset < entries.length; offset += 64) {
    const values = await Promise.all(entries.slice(offset, offset + 64).map(async name => {
      try {
        const comm = (await fs.readFile(`/proc/${name}/comm`, 'utf8')).trim();
        if (!['node', 'bedrock_server'].includes(comm) && Number(name) !== process.pid) return null;
        const status = await fs.readFile(`/proc/${name}/status`, 'utf8');
        return { pid: Number(name), name: comm, memoryMB: Math.round(Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) / 1024 * 10) / 10, threads: Number(status.match(/^Threads:\s+(\d+)/m)?.[1] || 0), panel: Number(name) === process.pid };
      } catch { return null; }
    }));
    records.push(...values.filter(Boolean));
  }
  return records.sort((a, b) => b.memoryMB - a.memoryMB).slice(0, 32);
}

export async function collectDiagnostics({ dataDir, host }) {
  const generatedAt = new Date().toISOString();
  const linux = process.platform === 'linux', checks = [];
  const add = (id, name, status, message) => checks.push({ id, name, status, message });
  let release = {};
  if (linux) {
    try { release = Object.fromEntries((await fs.readFile('/etc/os-release', 'utf8')).split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1).replace(/^"|"$/g, '')]; })); } catch {}
  }
  const ubuntuSupported = release.ID === 'ubuntu' && Number.parseFloat(release.VERSION_ID) >= 22.04;
  add('platform', 'Ubuntu x86_64', linux && process.arch === 'x64' && ubuntuSupported ? 'ok' : 'warning', linux ? `${release.PRETTY_NAME || host.release || 'Linux'} · ${process.arch}${!ubuntuSupported ? '. Runtime được hỗ trợ trên Ubuntu 22.04 trở lên.' : ''}` : 'Host hiện tại dùng Windows/macOS; chỉ preview panel, không chạy runtime Bedrock Linux.');
  add('node', 'Node.js', Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'error', `${process.version} · yêu cầu Node.js 22 trở lên.`);
  try { await fs.access(dataDir, fs.constants.W_OK); add('data', 'Thư mục dữ liệu', 'ok', 'Tài khoản dịch vụ có quyền ghi dữ liệu.'); } catch { add('data', 'Thư mục dữ liệu', 'error', 'Tài khoản dịch vụ không có quyền ghi thư mục dữ liệu.'); }
  const freeBytes = Math.max(0, host.diskTotal - host.diskUsed);
  add('storage', 'Không gian lưu trữ', !host.diskTotal ? 'warning' : freeBytes < 2 * 1024 ** 3 ? 'warning' : 'ok', !host.diskTotal ? 'Không đọc được thông tin filesystem.' : `${(freeBytes / 1024 ** 3).toFixed(1)} GiB còn trống; cần thêm dung lượng cho world, staging và backup.`);
  add('memory', 'Bộ nhớ khả dụng', os.freemem() < 512 * MiB ? 'warning' : 'ok', `${Math.round(os.freemem() / MiB)} MiB RAM trống.`);
  const terminal = linux && process.env.ALLOW_HOST_TERMINAL === 'true';
  add('access', 'Host terminal', terminal ? 'warning' : 'ok', terminal ? `Terminal đã bật với quyền ${process.getuid?.() === 0 ? 'root' : os.userInfo().username}. Chỉ Admin được truy cập, mọi lệnh có audit.` : 'Terminal đang tắt. Có thể bật rõ ràng trong cấu hình dịch vụ khi cần.');
  const bind = process.env.HOST || '127.0.0.1', publicUrl = process.env.PUBLIC_URL || '';
  add('https', 'Truy cập panel', publicUrl.startsWith('https://') || ['127.0.0.1', '::1', 'localhost'].includes(bind) ? 'ok' : 'warning', publicUrl.startsWith('https://') ? 'Đã khai báo PUBLIC_URL HTTPS; dùng reverse proxy có chứng chỉ hợp lệ.' : ['127.0.0.1', '::1', 'localhost'].includes(bind) ? 'Panel bind localhost; dùng SSH tunnel hoặc reverse proxy HTTPS.' : 'Panel đang bind ra mạng. Cần reverse proxy HTTPS và PUBLIC_URL trước khi truy cập từ Internet.');
  const [sockets, libraries, serviceResult, processList] = await Promise.all([
    linux ? tool('/usr/bin/ss', ['-H', '-lntu']) : Promise.resolve({ available: false, output: '' }),
    linux ? tool('/usr/sbin/ldconfig', ['-p']) : Promise.resolve({ available: false, output: '' }),
    linux ? tool('/usr/bin/systemctl', ['show', 'bedrock-panel.service', '--property=ActiveState,SubState,MainPID', '--no-pager']) : Promise.resolve({ available: false, output: '' }),
    processes(),
  ]);
  if (linux) add('dependencies', 'Thư viện Bedrock', libraries.available && /libcurl\.so/.test(libraries.output) && /libstdc\+\+\.so/.test(libraries.output) ? 'ok' : 'warning', libraries.available && /libcurl\.so/.test(libraries.output) && /libstdc\+\+\.so/.test(libraries.output) ? 'libcurl và libstdc++ đã được ghi nhận trên host.' : 'Chưa xác nhận libcurl/libstdc++. Chạy installer Ubuntu để cài dependency.');
  const serviceFields = Object.fromEntries(serviceResult.output.trim().split('\n').filter(line => line.includes('=')).map(line => line.split('=')));
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, items]) => (items || []).filter(item => !item.internal).map(item => ({ name, address: item.address, family: item.family }))).slice(0, 32);
  return {
    generatedAt, host, checks,
    network: { available: sockets.available, addresses, listeners: parseListeners(sockets.output) },
    processes: processList,
    panel: { pid: process.pid, uptime: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / MiB * 10) / 10, nodeVersion: process.version, user: os.userInfo().username, root: process.getuid?.() === 0 },
    service: { name: 'bedrock-panel.service', available: serviceResult.available, activeState: serviceFields.ActiveState || 'unknown', subState: serviceFields.SubState || 'unknown' },
    storage: { dataDir: path.resolve(dataDir), freeBytes, totalBytes: host.diskTotal },
  };
}
