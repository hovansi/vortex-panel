import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fail, safePath } from './safety.js';

const conflictMessage = Object.freeze({ id: 'panel.players.conflict', params: [], en: 'Player lists changed after this form was opened. Refresh the lists and review your changes before saving again.', vi: 'Danh sách người chơi đã thay đổi sau khi mở biểu mẫu. Hãy tải lại danh sách và kiểm tra thay đổi trước khi lưu lại.' });
const revisionMessage = Object.freeze({ id: 'panel.players.revision', params: [], en: 'Player list revision is invalid. Reload the lists before saving.', vi: 'Phiên bản danh sách người chơi không hợp lệ. Hãy tải lại danh sách trước khi lưu.' });
export function playerListErrorPayload(error, language = 'en') {
  const message = error?.code === 'PLAYER_LIST_CONFLICT' ? conflictMessage : error?.code === 'PLAYER_LIST_REVISION' ? revisionMessage : null;
  if (!message) return null;
  return { code: error.code, error: message[language === 'vi' ? 'vi' : 'en'], errorI18n: { ...message, params: [] } };
}
export function playerListsRevision({ allowlist, permissions }) {
  return createHash('sha256').update(JSON.stringify([allowlist, permissions])).digest('hex');
}
export function assertPlayerListRevision(input, current) {
  // Legacy API callers may explicitly replace the pair without a revision.
  // Browser forms include their opening revision to protect intervening edits.
  if (input.revision === undefined) return;
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) throw Object.assign(new Error(revisionMessage.en), { status: 400, code: 'PLAYER_LIST_REVISION' });
  if (input.revision !== playerListsRevision(current)) throw Object.assign(new Error(conflictMessage.en), { status: 409, code: 'PLAYER_LIST_CONFLICT' });
}

function xuid(value, optional = false) {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value))) fail('XUID phải là chuỗi số nguyên chính xác.');
  const text = String(value);
  if (!/^\d{1,20}$/.test(text) || BigInt(text) < 1n || BigInt(text) > 18446744073709551615n) fail('XUID phải là số nguyên dương 64 bit.');
  return BigInt(text).toString();
}

export function validatePlayerLists(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Danh sách người chơi không hợp lệ.');
  const { allowlist, permissions } = input;
  if (!Array.isArray(allowlist) || !Array.isArray(permissions) || allowlist.length > 10000 || permissions.length > 10000) fail('Danh sách người chơi không hợp lệ.');
  const names = new Set(), allowedIds = new Set(), permissionIds = new Set();
  const allowed = allowlist.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(value.name)) fail('Tên người chơi allowlist phải từ 1–64 ký tự, không chứa ký tự điều khiển.');
    if (value.ignoresPlayerLimit !== undefined && typeof value.ignoresPlayerLimit !== 'boolean') fail('ignoresPlayerLimit phải là boolean.');
    const name = value.name.trim(), id = xuid(value.xuid, true), key = name.toLowerCase();
    if (names.has(key) || id && allowedIds.has(id)) fail('Allowlist có tên hoặc XUID bị trùng.');
    names.add(key); if (id) allowedIds.add(id);
    return { name, ignoresPlayerLimit: value.ignoresPlayerLimit ?? false, ...(id ? { xuid: id } : {}) };
  });
  const permitted = permissions.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !['visitor', 'member', 'operator'].includes(value.permission)) fail('Quyền người chơi phải là visitor, member hoặc operator.');
    const id = xuid(value.xuid);
    if (permissionIds.has(id)) fail('Danh sách quyền có XUID bị trùng.');
    permissionIds.add(id); return { xuid: id, permission: value.permission };
  });
  return { allowlist: allowed, permissions: permitted };
}

export function playerListFiles(lists) {
  return { 'allowlist.json': JSON.stringify(lists.allowlist, null, 2) + '\n', 'permissions.json': JSON.stringify(lists.permissions, null, 2) + '\n' };
}

// Prepare both files before replacing either. Backups keep the old inode so
// an observed write or metadata failure can be rolled back even on a full disk.
export async function commitPlayerListFiles(root, files, commit) {
  const prepared = []; let committed = false;
  try {
    for (const [name, content] of Object.entries(files)) {
      const destination = await safePath(root, name, { allowMissing: true });
      const previous = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (previous && !previous.isFile()) fail(`${name} phải là tệp thông thường.`, 409);
      const entry = { destination, temporary: `${destination}.${randomUUID()}.tmp`, backup: previous ? `${destination}.${randomUUID()}.rollback` : null, activated: false, restored: false };
      prepared.push(entry);
      await fs.writeFile(entry.temporary, content, { flag: 'wx', mode: 0o600 });
      if (entry.backup) await fs.link(destination, entry.backup).catch(async error => {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw error;
        await fs.copyFile(destination, entry.backup, fs.constants.COPYFILE_EXCL);
      });
    }
    for (const entry of prepared) { await fs.rename(entry.temporary, entry.destination); entry.activated = true; }
    commit(); committed = true;
  } catch (error) {
    for (const entry of prepared.slice().reverse()) if (entry.activated) {
      try {
        if (entry.backup) await fs.rename(entry.backup, entry.destination);
        else await fs.rm(entry.destination);
        entry.restored = true;
      } catch (rollbackError) { error.message += `; không thể hoàn tác ${path.basename(entry.destination)}: ${rollbackError.message}${entry.backup ? `, bản cũ tại ${path.basename(entry.backup)}` : ''}`; }
    }
    throw error;
  } finally {
    for (const entry of prepared) {
      await fs.rm(entry.temporary, { force: true }).catch(() => {});
      if (entry.backup && (!entry.activated || committed || entry.restored)) await fs.rm(entry.backup, { force: true }).catch(() => {});
    }
  }
}
