import { Readable } from 'node:stream';
import { fail } from './safety.js';

export const HISTORY_ROOT = 'https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2';
export const HISTORY_SOURCE = 'https://github.com/EndstoneMC/bedrock-server-data';
export const HISTORY_ENDPOINT = `${HISTORY_ROOT}/versions.json`;
export const ARCHIVE_ROOT = 'https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main';
export const ARCHIVE_SOURCE = 'https://github.com/Bedrock-OSS/BDS-Versions';
export const ARCHIVE_ENDPOINT = `${ARCHIVE_ROOT}/versions.json`;
const EXACT_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DISPLAY_STABLE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DISPLAY_PREVIEW = /^\d{1,3}\.\d{1,3}\.\d{1,3}-preview\.\d{1,3}$/;

export async function boundedJson(url, signal, maxBytes = 256 * 1024) {
  const response = await fetch(url, { redirect: 'error', signal, headers: { 'User-Agent': 'VortexPanel/0.9.0', Accept: 'application/json' } });
  if (!response.ok || !response.body) fail(`Không đọc được chỉ mục phiên bản (HTTP ${response.status}).`, 502);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      size += chunk.length;
      if (size > maxBytes) fail('Metadata phiên bản vượt giới hạn cho phép.', 502);
      chunks.push(chunk);
    }
  } catch (error) { await response.body.cancel().catch(() => {}); throw error; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Metadata phiên bản không phải JSON hợp lệ.', 502); }
}

export function historyEntries(payload) {
  const entries = [];
  for (const [section, channel, pattern] of [['release', 'stable', DISPLAY_STABLE], ['preview', 'preview', DISPLAY_PREVIEW]]) {
    const values = payload?.[section]?.versions;
    if (!Array.isArray(values) || values.length > 500 || !values.every(value => typeof value === 'string' && pattern.test(value))) fail('Chỉ mục lịch sử đã thay đổi định dạng.', 502);
    for (const displayVersion of new Set(values)) entries.push({ channel, displayVersion, historyKey: `${section}/${displayVersion}`, metadataUrl: `${HISTORY_ROOT}/${section}/${displayVersion}/metadata.json` });
  }
  if (!entries.length) fail('Chỉ mục lịch sử không có phiên bản Linux.', 502);
  return entries;
}

export function historyRecord(payload, entry, validateUrl, validateVersion) {
  if (payload?.version !== entry.displayVersion) fail('Metadata không khớp phiên bản được yêu cầu.', 502);
  const binary = payload?.binary?.linux;
  const url = validateUrl(binary?.url);
  const match = url.match(/\/bin-linux(-preview)?\/bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip$/);
  if (!match || Boolean(match[1]) !== (entry.channel === 'preview')) fail('Metadata không khớp kênh Linux được yêu cầu.', 502);
  const version = validateVersion(match[2]);
  const parts = version.split('.');
  const expectedDisplay = entry.channel === 'preview' ? `${parts.slice(0, 3).join('.')}-preview.${parts[3]}` : parts.slice(0, 3).join('.');
  if (expectedDisplay !== entry.displayVersion) fail('Liên kết tải không khớp phiên bản trong chỉ mục.', 502);
  if (typeof binary.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(binary.sha256)) fail('Metadata thiếu SHA-256 hợp lệ.', 502);
  return { version, channel: entry.channel, displayVersion: entry.displayVersion, historyKey: entry.historyKey, catalogKeys: { endstone: entry.historyKey }, url, sha256: binary.sha256.toLowerCase(), checksumSource: 'endstone', source: 'endstone', metadataStatus: 'ready', historical: true, available: false, availability: 'unchecked', discoveredAt: new Date().toISOString() };
}

// The registry supplies exact identifiers and its official CDN root. A candidate
// URL is not evidence of availability: only the separate HEAD check enables it.
export function archiveEntries(payload, validateUrl) {
  if (payload?.cdn_root !== 'https://www.minecraft.net/bedrockdedicatedserver') fail('CDN lịch sử không phải Minecraft.net chính thức.', 502);
  const entries = [];
  for (const [field, channel, folder] of [['versions', 'stable', 'linux'], ['preview_versions', 'preview', 'linux_preview']]) {
    const versions = payload?.linux?.[field];
    if (!Array.isArray(versions) || versions.length > 1000 || !versions.every(version => typeof version === 'string' && EXACT_VERSION.test(version))) fail('Chỉ mục BDS Linux đã thay đổi định dạng.', 502);
    for (const version of new Set(versions)) {
      const key = `${folder}/${version}`;
      const url = validateUrl(`${payload.cdn_root}/bin-linux${channel === 'preview' ? '-preview' : ''}/bedrock-server-${version}.zip`, { version, channel });
      entries.push({ version, channel, url, catalogKeys: { 'bds-versions': key }, archiveMetadataUrl: `${ARCHIVE_ROOT}/${key}.json`, source: 'bds-versions', historical: true, available: false, availability: 'unchecked', metadataStatus: 'pending', discoveredAt: new Date().toISOString() });
    }
  }
  if (!entries.length) fail('Chỉ mục BDS không chứa phiên bản Linux.', 502);
  return entries;
}

export function archiveRecord(payload, entry, validateUrl) {
  if (payload?.version !== entry.version || payload?.platform !== 'linux') fail('Metadata không khớp phiên bản hoặc nền tảng Linux.', 502);
  const url = validateUrl(payload.download_url, { version: entry.version, channel: entry.channel });
  const size = payload.size_in_bytes;
  if (!Number.isSafeInteger(size) || size < 1000 || size > 1024 ** 3) fail('Kích thước BDS trong metadata không hợp lệ.', 502);
  if (payload.sha1 !== undefined && (typeof payload.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(payload.sha1))) fail('SHA-1 trong metadata không hợp lệ.', 502);
  return { version: entry.version, channel: entry.channel, url, size, sha1: payload.sha1?.toLowerCase() || null, checksumSource: payload.sha1 ? 'bds-versions' : null, releasedAt: typeof payload.date === 'string' && Number.isFinite(Date.parse(payload.date)) ? payload.date : null, source: 'bds-versions', metadataStatus: 'ready', metadataError: null };
}

export function compareVersions(a, b) {
  const left = a.version.split('.').map(Number); const right = b.version.split('.').map(Number);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return right[i] - left[i];
  return a.channel.localeCompare(b.channel);
}
