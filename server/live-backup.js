import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cleanRelative, fail, safePath } from './safety.js';
import { nativeGameplayBody } from './gameplay.js';
import { createUtf8LineConsumer } from './log-retention.js';

export const LIVE_BACKUP_LIMITS = Object.freeze({ bytes: 2 * 1024 ** 3, entries: 50000, responseBytes: 8 * 1024 ** 2, responseTimeoutMs: 5000, prepareTimeoutMs: 60000 });
const issue = message => Object.assign(new Error(message), { status: 409 });
const nativeError = body => /^(?:Saving failed:|An error occurred when trying to pause|Syntax error:|Unknown command: save\b|You do not have permission|Cheats are not enabled|Commands aren't enabled)/.test(body);

// This reader exists only for the snapshot operation. Normal console history
// retains its small line budget; a native file list can legitimately be larger.
export function createBackupConsole({ child, send, timeoutMs = LIVE_BACKUP_LIMITS.responseTimeoutMs, maxBytes = LIVE_BACKUP_LIMITS.responseBytes }) {
  let pending = null, closed = false; const tokens = new Set();
  const settle = (error, lines) => {
    if (!pending) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    if (error) current.reject(error); else current.resolve(lines);
  };
  const consume = line => {
    if (!pending) return;
    const body = nativeGameplayBody(line);
    if (body?.startsWith(`Unknown command: ${pending.token}.`)) { settle(null, pending.lines); return; }
    pending.bytes += Buffer.byteLength(line);
    if (pending.bytes > maxBytes || line.endsWith(' … [truncated]') || pending.lines.length > LIVE_BACKUP_LIMITS.entries + 10) {
      settle(issue('Phản hồi sao lưu vượt giới hạn; chưa tạo bản sao lưu.')); return;
    }
    // File lists in some BDS versions do not have a log header. Chat/command
    // echoes cannot pass the world-path/byte-count validation below.
    pending.lines.push(body === null ? line : body);
  };
  const readers = [child.stdout, child.stderr].filter(Boolean).map(stream => {
    const reader = createUtf8LineConsumer({ maxBytes, onLine: consume });
    const onData = chunk => reader.write(chunk), onEnd = () => reader.end();
    stream.on('data', onData); stream.on('end', onEnd);
    return { stream, onData, onEnd };
  });
  const onClose = () => { closed = true; settle(issue('Server đã dừng trong lúc sao lưu; chưa tạo bản sao lưu.')); };
  child.on('close', onClose);
  return {
    get closed() { return closed; },
    collect(command) {
      if (closed || pending) return Promise.reject(issue('Kết nối sao lưu chưa sẵn sàng.'));
      return new Promise((resolve, reject) => {
        const token = 'vortex_backup_' + randomUUID().replaceAll('-', ''); tokens.add(token);
        if (tokens.size > 300) tokens.delete(tokens.values().next().value);
        pending = { token, lines: [], bytes: 0, resolve, reject, timer: setTimeout(() => settle(issue('Server chưa xác nhận lệnh sao lưu trong thời gian chờ.')), timeoutMs) };
        try {
          if (!send(command)?.acceptedToConsole || !send(token)?.acceptedToConsole) throw issue('Không gửi được lệnh sao lưu đến server.');
        } catch (error) { settle(error); }
      });
    },
    isInternal(line) { const token = /^Unknown command: (vortex_backup_[a-f0-9]+)\./.exec(nativeGameplayBody(line) || '')?.[1]; return Boolean(token && tokens.has(token)); },
    close() {
      closed = true; settle(issue('Kết nối sao lưu đã đóng.'));
      for (const { stream, onData, onEnd } of readers) { stream.off('data', onData); stream.off('end', onEnd); }
      child.off('close', onClose);
    }
  };
}

export function parseBackupFiles(lines, worldName, { maxEntries = LIVE_BACKUP_LIMITS.entries, maxBytes = LIVE_BACKUP_LIMITS.bytes } = {}) {
  if (cleanRelative(worldName, { allowRoot: false }) !== worldName || worldName.includes('/')) fail('Tên thế giới đang chạy không hợp lệ.', 409);
  const ready = lines.findIndex(line => /^Data saved\. Files are now ready to be copied\.$/.test(line));
  if (ready < 0) fail('Server chưa xác nhận dữ liệu sẵn sàng sao lưu.', 409);
  const rows = lines.slice(ready + 1).filter(line => line.trim());
  const files = [], seen = new Set(); let bytes = 0;
  for (const row of rows) {
    // Native connection/status messages may arrive between the list and fence.
    // A path-like row from another world still fails rather than being ignored.
    if (!row.startsWith(worldName + '/') && !/^[^:]*\/[^:]*:\d/.test(row)) continue;
    // BDS emits comma-separated path:length pairs. Use the numeric suffix
    // so spaces, Unicode and commas in a world/folder name remain intact.
    let remainder = row.trim();
    while (remainder) {
      const match = /^(.*?):(\d+)(?:,\s*|$)/.exec(remainder);
      if (!match) fail('Danh sách tệp sao lưu của server không hợp lệ.', 409);
      const relative = cleanRelative(match[1], { allowRoot: false });
      if (relative !== match[1] || !relative.startsWith(worldName + '/') || relative.length > 4096 || relative.split('/').length > 128) fail('Đường dẫn tệp sao lưu không thuộc thế giới đang chạy.', 409);
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0 || seen.has(relative)) fail('Kích thước hoặc tệp trùng trong danh sách sao lưu không hợp lệ.', 409);
      if (files.length >= maxEntries || (bytes += size) > maxBytes) fail('Dữ liệu sao lưu vượt giới hạn 2 GiB hoặc 50.000 mục.', 409);
      files.push({ relative: `worlds/${relative}`, size }); seen.add(relative);
      remainder = remainder.slice(match[0].length);
    }
  }
  if (!files.length || !seen.has(worldName + '/level.dat') || ![...seen].some(name => name.startsWith(worldName + '/db/'))) fail('Danh sách sao lưu thiếu dữ liệu thế giới; chưa tạo bản sao lưu.', 409);
  return files;
}

// Copy only the byte prefix promised by BDS. fs.copyFile + truncate would first
// copy unbounded growth, and truncate could silently pad an unexpectedly short
// source. An exact, bounded reader detects premature EOF instead.
async function copyPrefix(root, destination, relative, size, guard) {
  guard();
  const source = await safePath(root, relative), target = path.join(destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output;
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size < size) fail('Tệp thế giới thay đổi hoặc ngắn hơn dữ liệu server đã xác nhận.', 409);
    output = await fs.open(target, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(1024 ** 2, Math.max(size, 1)));
    for (let offset = 0; offset < size;) {
      guard();
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) fail('Tệp thế giới bị rút ngắn trong lúc sao lưu.', 409);
      let written = 0;
      while (written < bytesRead) { const { bytesWritten } = await output.write(buffer, written, bytesRead - written, offset + written); if (!bytesWritten) throw issue('Không ghi được dữ liệu sao lưu.'); written += bytesWritten; }
      offset += bytesRead;
    }
  } finally { try { await output?.close(); } finally { await input.close(); } }
}

export async function snapshotLiveServer({ root, destination, worldName, console: control, guard = () => {}, releaseGuard = guard, exclude = () => false, progress = () => {}, reserveWorkspace = async () => {}, prepareTimeoutMs = LIVE_BACKUP_LIMITS.prepareTimeoutMs, retryMs = 250 }) {
  let resumeRequired = false, primary;
  try {
    guard();
    // Drain old native responses before taking ownership of a new hold.
    await control.collect('list'); guard();
    resumeRequired = true;
    const held = await control.collect('save hold'); guard();
    if (held.some(line => /^(?:Saving is already turned off\.|The command is already running)/.test(line))) {
      resumeRequired = false; fail('Server đang chuẩn bị một bản sao lưu khác. Hãy chờ hoàn tất rồi thử lại.', 409);
    }
    if (held.some(nativeError) || !held.includes('Saving...')) fail('Server chưa xác nhận bắt đầu sao lưu trực tuyến.', 409);
    const expires = Date.now() + prepareTimeoutMs;
    let files;
    while (Date.now() < expires) {
      guard(); progress(2, 'Đang chuẩn bị bản sao lưu; người chơi vẫn có thể kết nối');
      const lines = await control.collect('save query'); guard();
      if (lines.some(nativeError)) fail('Server từ chối chuẩn bị dữ liệu sao lưu.', 409);
      if (lines.includes('Data saved. Files are now ready to be copied.')) { files = parseBackupFiles(lines, worldName); break; }
      if (!lines.includes('A previous save has not been completed.')) fail('Không đọc được trạng thái chuẩn bị sao lưu của server.', 409);
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
    if (!files) fail('Server chưa chuẩn bị xong dữ liệu sao lưu trong thời gian chờ.', 409);
    let bytes = files.reduce((total, file) => total + file.size, 0), count = files.length;
    const nativeFiles = new Set(files.map(file => file.relative));
    const otherFiles = [], directories = [];
    // Preserve inactive worlds, configuration and static assets. The active
    // world's database uses exclusively BDS's manifest, never unlisted tables.
    async function scanOther(relative = '', depth = 0) {
      guard(); if (depth > 128) fail('Dữ liệu sao lưu có quá nhiều thư mục lồng nhau.', 409);
      for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (name === `worlds/${worldName}/db` || nativeFiles.has(name) || name === `worlds/${worldName}/level.dat_old` || exclude(name)) continue;
        if (++count > LIVE_BACKUP_LIMITS.entries) fail('Dữ liệu sao lưu vượt giới hạn 50.000 mục.', 409);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('Dữ liệu sao lưu chứa liên kết hoặc tệp đặc biệt.', 409);
        if (entry.isDirectory()) { directories.push(name); await scanOther(name, depth + 1); }
        else {
          const stat = await fs.lstat(await safePath(root, name));
          if ((bytes += stat.size) > LIVE_BACKUP_LIMITS.bytes) fail('Dữ liệu sao lưu vượt giới hạn 2 GiB.', 409);
          otherFiles.push({ relative: name, size: stat.size });
        }
      }
    }
    await scanOther(); guard();
    // Source bytes already exist. Reserve the two new copies plus bounded ZIP
    // entry overhead before writing; the manager retains this reservation until
    // both staging and compression finish, including concurrent admissions.
    // Include per-entry allocation and long ZIP path headers, not just file
    // payload: many tiny files still consume blocks and directory metadata.
    await reserveWorkspace(bytes * 2 + count * 16384 + 1024 ** 2); guard();
    await fs.mkdir(destination, { recursive: false, mode: 0o700 });
    // Copy the native manifest first to minimize its hold interval.
    for (let index = 0; index < files.length; index++) { const file = files[index]; await copyPrefix(root, destination, file.relative, file.size, guard); progress(5 + Math.round((index + 1) / files.length * 15), 'Đang sao chép dữ liệu thế giới'); }
    guard();
    // Resume before copying unrelated packs/configs or compressing: players can
    // keep playing and obsolete native files can be reclaimed immediately.
    await resume(); resumeRequired = false;
    for (const name of directories) { guard(); await fs.mkdir(path.join(destination, name), { recursive: true, mode: 0o700 }); }
    for (const file of otherFiles) await copyPrefix(root, destination, file.relative, file.size, guard);
    guard();
  } catch (error) { primary = error; throw error; }
  finally {
    if (resumeRequired) try { await resume(); }
    catch (error) {
      if (primary) primary.message += `; ${error.message}`;
      else throw error;
    }
  }
  async function resume() {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) try {
      // An exited process no longer holds native files. Never send a resume to
      // a replacement process, or obscure its exit with a misleading warning.
      if (control.closed || releaseGuard() === false) return;
      const lines = await control.collect('save resume');
      if (!lines.some(line => /^(?:Changes to the world are resumed\.|Saving is already turned on\.)$/.test(line))) throw issue('Chưa nhận được xác nhận tiếp tục lưu thế giới.');
      return;
    } catch (error) { last = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, retryMs)); }
    throw Object.assign(issue(`Không xác nhận được server đã tiếp tục lưu dữ liệu. Quản trị viên cần kiểm tra Console và gửi save resume: ${last.message}`), { code: 'BACKUP_SAVE_RESUME_REQUIRED' });
  }
}
