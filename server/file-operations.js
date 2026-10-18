import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { extractZip, zipDirectory } from './archives.js';
import { cleanRelative, safePath, fail } from './safety.js';

export const FILE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 ** 3, maxEntries: 50000, textBytes: 2 * 1024 ** 2 });
export const fileRevision = content => createHash('sha256').update(content).digest('hex');
const parent = name => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
const inside = (name, directory) => name === directory || name.startsWith(directory + '/');
const key = name => process.platform === 'win32' ? name.toLowerCase() : name;
const missing = async target => fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export function filePath(input, allowRoot = false) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 1024) fail('Đường dẫn phải là chuỗi không quá 1.024 byte.');
  const name = cleanRelative(input, { allowRoot });
  if (name.split('/').some(piece => Buffer.byteLength(piece) > 255 || /[<>?"*|]/.test(piece) || /[. ]$/.test(piece) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) fail('Tên tệp không hợp lệ hoặc không tương thích hệ thống.');
  return name;
}

function selection(input) {
  if (!Array.isArray(input) || !input.length || input.length > 1000) fail('Chọn từ 1 đến 1.000 tệp hoặc thư mục.');
  const names = input.map(name => filePath(name));
  for (let index = 0; index < names.length; index++) for (let previous = 0; previous < index; previous++) {
    if (inside(key(names[index]), key(names[previous])) || inside(key(names[previous]), key(names[index]))) fail('Danh sách nguồn bị trùng hoặc chứa thư mục cùng tệp con của nó.');
  }
  return names;
}

function textContent(content) {
  if (typeof content !== 'string' || !content.isWellFormed() || Buffer.byteLength(content) > FILE_LIMITS.textBytes || content.includes('\0')) fail('Nội dung phải là văn bản UTF-8 nhỏ hơn 2 MiB.');
  return content;
}

export async function readTextFile(root, input) {
  const name = filePath(input);
  const target = await safePath(root, name);
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > FILE_LIMITS.textBytes) fail('Chỉ đọc tệp văn bản nhỏ hơn 2 MiB.');
  const buffer = await fs.readFile(target);
  if (buffer.length > FILE_LIMITS.textBytes || buffer.includes(0)) fail('Tệp nhị phân hoặc quá lớn không hỗ trợ trình soạn thảo.');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { fail('Tệp không phải văn bản UTF-8 hợp lệ; hãy tải xuống để chỉnh sửa bằng công cụ phù hợp.'); }
  return { path: name, content, revision: fileRevision(buffer) };
}

export function createFileOperations({ root, server, guard = filePath, commit }) {
  const validate = (name, mode) => guard(filePath(name), mode);
  const result = (operation, paths) => ({ ok: true, operation, paths });
  const record = (fields, action, names) => commit(fields, `file.${action}`, `${server.name}: ${names.join(' → ')}`);
  async function targetPath(name) {
    const target = await safePath(root, name, { allowMissing: true });
    if (await missing(target)) fail('Đường dẫn đích đã tồn tại; không ghi đè.', 409);
    const directory = await safePath(root, parent(name));
    if (!(await fs.stat(directory)).isDirectory()) fail('Đường dẫn cha của đích phải là thư mục.', 409);
    return target;
  }
  async function stage() {
    const directory = path.join(path.dirname(root), `.file-op-${randomUUID()}`);
    await fs.mkdir(directory, { mode: 0o700 });
    return directory;
  }
  async function tree(names, mode = 'read') {
    const entries = []; let bytes = 0;
    const stack = [...names].reverse();
    while (stack.length) {
      const name = stack.pop(); validate(name, mode);
      let directory, size = 0;
      {
        const target = await safePath(root, name);
        const stat = await fs.lstat(target);
        if (!stat.isFile() && !stat.isDirectory()) fail('Chỉ hỗ trợ tệp thông thường hoặc thư mục; không dùng liên kết.', 403);
        directory = stat.isDirectory(); size = directory ? 0 : stat.size;
      }
      bytes += size;
      if (entries.length >= FILE_LIMITS.maxEntries || bytes > FILE_LIMITS.maxBytes) fail('Thao tác vượt giới hạn 2 GiB hoặc 50.000 mục.');
      entries.push({ name, directory, size });
      if (directory) {
        const children = (await fs.readdir(await safePath(root, name))).map(child => `${name}/${child}`);
        stack.push(...children.reverse());
      }
    }
    return entries;
  }
  async function copyEntries(entries, destination) {
    for (const entry of entries) {
      const target = path.join(destination, ...entry.name.split('/'));
      if (entry.directory) await fs.mkdir(target, { recursive: true, mode: 0o700 });
      else { await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.copyFile(await safePath(root, entry.name), target, fs.constants.COPYFILE_EXCL); await fs.chmod(target, 0o600); }
    }
  }
  async function transfer(input, move) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !['source', 'sources', 'destination'].includes(name)) || ('source' in input && 'sources' in input)) fail('Yêu cầu sao chép hoặc di chuyển không hợp lệ.');
    const single = 'source' in input;
    if (single && !move) fail('Sao chép cần danh sách sources.');
    const sources = selection(single ? [input.source] : input.sources);
    const destination = filePath(input.destination, !single);
    const destinations = sources.map(source => single ? destination : destination ? `${destination}/${path.posix.basename(source)}` : path.posix.basename(source));
    if (new Set(destinations.map(key)).size !== destinations.length) fail('Các nguồn có cùng tên tại đích.', 409);
    for (const target of destinations) {
      validate(target, 'target');
      if (sources.some(source => inside(key(target), key(source)))) fail('Không thể chuyển hoặc sao chép thư mục vào chính nó; đường dẫn nguồn và đích phải khác nhau.');
    }
    const entries = await tree(sources, move ? 'destructive' : 'read');
    for (const entry of entries) {
      const index = sources.findIndex(source => inside(entry.name, source));
      validate(destinations[index] + entry.name.slice(sources[index].length), 'target');
    }
    {
      const targets = [];
      for (const name of destinations) targets.push(await targetPath(name));
      const staging = move ? null : await stage(); const activated = []; let committed = false;
      try {
        if (!move) await copyEntries(entries, staging);
        for (let index = 0; index < sources.length; index++) {
          // Recheck immediately before activation; never intentionally replace a target.
          if (await missing(targets[index])) fail('Đường dẫn đích đã tồn tại; không ghi đè.', 409);
          await fs.rename(move ? await safePath(root, sources[index]) : path.join(staging, ...sources[index].split('/')), targets[index]); activated.push(index);
        }
        record({}, move ? 'move' : 'copy', [...sources, ...destinations]); committed = true;
      } catch (error) {
        for (const index of activated.reverse()) {
          try { if (move) await fs.rename(targets[index], path.join(root, ...sources[index].split('/'))); else await fs.rename(targets[index], path.join(staging, ...sources[index].split('/'))); }
          catch (rollbackError) { error.message += `; không thể hoàn tác ${destinations[index]}: ${rollbackError.message}`; }
        }
        throw error;
      } finally { if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
      if (!committed) fail('Thao tác chưa được ghi nhận.', 500);
    }
    if (single) return { ok: true, source: sources[0], destination: destinations[0] };
    return result(move ? 'move' : 'copy', destinations);
  }
  async function create(name, content, { revision, requireRevision = false, existing = false, binary = false, action = 'write' } = {}) {
    name = validate(name, existing ? 'edit' : 'target');
    if (!binary) textContent(content);
    if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) fail('Revision tệp không hợp lệ.');
    const target = await safePath(root, name, { allowMissing: true }); const stat = await missing(target);
    if (existing && requireRevision && !stat) fail('Tệp không còn tồn tại. Hãy tạo tệp mới bằng công cụ tạo tệp.', 404);
    if (stat && (!existing || !stat.isFile())) fail('Đường dẫn đích đã tồn tại; không ghi đè.', 409);
    if (!stat) await targetPath(name);
    if (stat && !binary) await readTextFile(root, name);
    if (stat && requireRevision && revision === undefined) fail('Hãy tải lại nội dung tệp trước khi lưu.', 428);
    if (stat && revision !== undefined && fileRevision(await fs.readFile(target)) !== revision) fail('Tệp đã thay đổi. Hãy tải lại trước khi lưu để tránh mất dữ liệu.', 409);
    const staging = await stage(); const temporary = path.join(staging, 'content'); const rollback = path.join(staging, 'rollback'); let activated = false, committed = false, restored = false;
    try {
      if (binary) await fs.copyFile(content, temporary, fs.constants.COPYFILE_EXCL); else await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await fs.chmod(temporary, 0o600);
      if (stat) await fs.link(target, rollback).catch(async error => { if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error; await fs.copyFile(target, rollback, fs.constants.COPYFILE_EXCL); });
      else if (await missing(target)) fail('Đường dẫn đích đã tồn tại; không ghi đè.', 409);
      if (stat && revision !== undefined && fileRevision(await fs.readFile(target)) !== revision) fail('Tệp đã thay đổi. Hãy tải lại trước khi lưu để tránh mất dữ liệu.', 409);
      await fs.rename(temporary, target); activated = true;
      record({}, action, [name]); committed = true;
      return { ok: true, path: name, ...(binary ? {} : { revision: fileRevision(content) }) };
    } catch (error) {
      if (activated && !committed) try { if (stat) await fs.rename(rollback, target); else await fs.rename(target, temporary); restored = true; } catch (rollbackError) { error.message += `; rollback tại ${staging}: ${rollbackError.message}`; }
      throw error;
    } finally { if (!activated || committed || restored) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  async function mkdir(input) {
    const name = validate(input, 'directory');
    if (await missing(await safePath(root, name, { allowMissing: true }))) fail('Đường dẫn đã tồn tại.', 409);
    let first = ''; let current = '';
    for (const piece of name.split('/')) { current = current ? `${current}/${piece}` : piece; validate(current, 'directory'); const stat = await missing(await safePath(root, current, { allowMissing: true })); if (!stat) { first = current; break; } if (!stat.isDirectory()) fail('Đường dẫn cha phải là thư mục.', 409); }
    const staging = await stage(); const branch = path.join(staging, 'new'); const target = await targetPath(first); let activated = false, committed = false, restored = false;
    try { await fs.mkdir(path.join(branch, ...name.slice(first.length).split('/').filter(Boolean)), { recursive: true, mode: 0o700 }); await fs.rename(branch, target); activated = true; record({}, 'mkdir', [name]); committed = true; }
    catch (error) { if (activated && !committed) try { await fs.rename(target, branch); restored = true; } catch (rollbackError) { error.message += `; rollback tại ${staging}: ${rollbackError.message}`; } throw error; }
    finally { if (!activated || committed || restored) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
    return result('mkdir', [name]);
  }
  async function remove(input) {
    const name = validate(input, 'destructive'); await tree([name], 'destructive');
    {
      const target = await safePath(root, name); const staging = await stage(); const rollback = path.join(staging, 'deleted'); let moved = false, committed = false, restored = false;
      try { await fs.rename(target, rollback); moved = true; record({}, 'delete', [name]); committed = true; }
      catch (error) { if (moved && !committed) try { await fs.rename(rollback, target); restored = true; } catch (rollbackError) { error.message += `; rollback tại ${staging}: ${rollbackError.message}`; } throw error; }
      finally { if (!moved || committed || restored) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
    }
    return result('delete', [name]);
  }
  async function compress(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(name => !['sources', 'destination'].includes(name))) fail('Yêu cầu nén tệp không hợp lệ.');
    const sources = selection(input.sources); const destination = validate(input.destination, 'target');
    if (!destination.toLowerCase().endsWith('.zip')) fail('Tệp nén cần đuôi .zip.');
    if (sources.some(source => inside(destination, source))) fail('Không thể tạo ZIP bên trong nguồn được chọn.');
    const entries = await tree(sources);
    {
      const target = await targetPath(destination); const staging = await stage(); const content = path.join(staging, 'selected'); const archive = path.join(staging, 'archive.zip'); let activated = false, committed = false, restored = false;
      try { await fs.mkdir(content); await copyEntries(entries, content); await zipDirectory(content, archive, { ...FILE_LIMITS, includeEmptyDirectories: true }); if (await missing(target)) fail('Đường dẫn đích đã tồn tại; không ghi đè.', 409); await fs.rename(archive, target); activated = true; record({}, 'compress', [...sources, destination]); committed = true; }
      catch (error) { if (activated && !committed) try { await fs.rename(target, archive); restored = true; } catch (rollbackError) { error.message += `; rollback tại ${staging}: ${rollbackError.message}`; } throw error; }
      finally { if (!activated || committed || restored) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
    }
    return result('compress', [destination]);
  }
  async function extract(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(name => !['source', 'destination'].includes(name))) fail('Yêu cầu giải nén không hợp lệ.');
    const source = filePath(input.source); const destination = validate(input.destination, 'target');
    if (!source.toLowerCase().endsWith('.zip')) fail('Chọn tệp .zip để giải nén.');
    {
      const original = await safePath(root, source); const stat = await fs.stat(original); if (!stat.isFile() || stat.size > FILE_LIMITS.maxBytes) fail('ZIP phải là tệp thông thường không quá 2 GiB.');
      const target = await targetPath(destination); const staging = await stage(); const content = path.join(staging, 'extracted'); let activated = false, committed = false, restored = false;
      try {
        const names = await extractZip(original, content, FILE_LIMITS);
        for (const name of names) validate(`${destination}/${filePath(name)}`, 'target');
        if (await missing(target)) fail('Đường dẫn đích đã tồn tại; không ghi đè.', 409);
        await fs.rename(content, target); activated = true; record({}, 'extract', [source, destination]); committed = true;
      } catch (error) { if (activated && !committed) try { await fs.rename(target, content); restored = true; } catch (rollbackError) { error.message += `; rollback tại ${staging}: ${rollbackError.message}`; } throw error; }
      finally { if (!activated || committed || restored) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
    }
    return result('extract', [destination]);
  }
  return { transfer, create, mkdir, remove, compress, extract };
}
