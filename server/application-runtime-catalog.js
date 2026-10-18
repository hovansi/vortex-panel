import { applicationIssue } from './application-schema.js';

export const RUNTIME_CATALOG_SOURCES = Object.freeze({ nodejs: 'https://nodejs.org/dist/index.json', python: 'https://www.python.org/downloads/' });
export const PYTHON_BUILD_RESOURCES = Object.freeze({ cpuCores: 0.5, memoryMiB: 1024, diskBytes: 6 * 1024 ** 3, volumeBytes: 3 * 1024 ** 3, timeoutMs: 45 * 60 * 1000 });
const architecture = value => ['x64', 'arm64'].includes(value);
const tuple = version => version.replace(/^v/, '').split('.').map(Number);
const descending = (a, b) => { const x = tuple(a.version), y = tuple(b.version); for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return y[index] - x[index]; return 0; };
const issue = () => applicationIssue('APPLICATION_RUNTIME_CATALOG', 502);

export function parseNodeReleases(text, arch = process.arch) {
  if (!architecture(arch)) throw applicationIssue('APPLICATION_RUNTIME_PLATFORM');
  let rows; try { rows = JSON.parse(text); } catch { throw issue(); }
  if (!Array.isArray(rows) || rows.length > 20000) throw issue();
  const versions = new Set(), releases = [];
  for (const row of rows) {
    if (!row || typeof row.version !== 'string' || !/^v(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/.test(row.version)) continue;
    if (versions.has(row.version)) throw issue();
    versions.add(row.version); releases.push({ version: row.version, available: Array.isArray(row.files) && row.files.includes(`linux-${arch}`), releaseDate: typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : null, lts: typeof row.lts === 'string' ? row.lts.slice(0, 32) : false });
  }
  if (!releases.length) throw issue();
  releases.sort(descending); if (!releases[0].available) throw applicationIssue('APPLICATION_RUNTIME_ARTIFACT_UNAVAILABLE');
  return releases;
}

export function parseNodeChecksum(text, filename) {
  if (typeof text !== 'string' || text.length > 1024 ** 2 || !/^node-v\d+\.\d+\.\d+-linux-(?:x64|arm64)\.tar\.xz$/.test(filename)) throw issue();
  const matches = text.split(/\r?\n/).filter(Boolean).map(line => /^([a-f0-9]{64})[ \t]+\*?([^\s]+)$/.exec(line)).filter(match => match?.[2] === filename);
  if (matches.length !== 1) throw issue();
  return matches[0][1];
}

export function parsePythonReleases(text) {
  if (typeof text !== 'string' || text.length > 4 * 1024 ** 2) throw issue();
  const versions = new Map();
  for (const match of text.matchAll(/<a\b[^>]*href=["'](\/downloads\/release\/python-(\d+)\/)["'][^>]*>\s*Python\s+(3\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,3}))\s*<\/a>/gi)) {
    const version = match[3]; if (version.replaceAll('.', '') !== match[2]) continue;
    versions.set(version, { version, releaseUrl: `https://www.python.org${match[1]}` });
  }
  if (!versions.size) throw issue();
  return [...versions.values()].sort(descending);
}

export function parsePythonSource(text, version) {
  if (typeof text !== 'string' || text.length > 4 * 1024 ** 2 || !/^3\.\d+\.\d+$/.test(version)) throw issue();
  const url = `https://www.python.org/ftp/python/${version}/Python-${version}.tar.xz`, matches = [];
  for (const match of text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1], link = [...row.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)].filter(item => item[1] === url);
    if (link.length !== 1) continue;
    const codes = [...row.matchAll(/<code\b[^>]*class=["'][^"']*\bchecksum\b[^"']*["'][^>]*>([\s\S]*?)<\/code>/gi)];
    if (codes.length !== 1) throw issue();
    const checksum = codes[0][1].replace(/<\/?(?:span|wbr)\b[^>]*>/gi, '').replace(/\s/g, '');
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw issue();
    matches.push({ url, sha256: checksum });
  }
  if (matches.length !== 1) throw issue();
  return matches[0];
}

// A persisted pin cannot turn a later start into an arbitrary download or mount.
export function normalizeRuntimePin(value, { kind, arch = process.arch } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || value.mode !== 'managed' || !['nodejs', 'python'].includes(value.kind) || kind && kind !== value.kind || value.platform !== 'linux' || !architecture(value.arch) || value.arch !== arch || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || typeof value.resolvedAt !== 'string' || !Number.isFinite(Date.parse(value.resolvedAt))) throw applicationIssue('APPLICATION_RUNTIME_PIN');
  const node = value.kind === 'nodejs', validVersion = node ? /^v(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/ : /^3\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,3})$/;
  if (!validVersion.test(value.version || '')) throw applicationIssue('APPLICATION_RUNTIME_PIN');
  const filename = node ? `node-${value.version}-linux-${arch}.tar.xz` : `Python-${value.version}.tar.xz`;
  const expected = node ? `https://nodejs.org/dist/${value.version}/${filename}` : `https://www.python.org/ftp/python/${value.version}/${filename}`;
  if (value.url !== expected || value.source !== (node ? 'nodejs.org' : 'python.org') || value.method !== (node ? 'official-binary' : 'official-source')) throw applicationIssue('APPLICATION_RUNTIME_PIN');
  return { schema: 1, mode: 'managed', kind: value.kind, version: value.version, platform: 'linux', arch, method: value.method, source: value.source, url: expected, sha256: value.sha256, resolvedAt: new Date(value.resolvedAt).toISOString() };
}

export function publicRuntimePin(value) {
  if (!value) return null;
  const { schema, mode, kind, version, platform, arch, method, source, resolvedAt } = normalizeRuntimePin(value, { arch: value.arch });
  return { schema, mode, kind, version, platform, arch, method, source, resolvedAt };
}

export function createApplicationRuntimeCatalog({ fetch: request = globalThis.fetch, arch = process.arch, platform = process.platform, now = () => new Date(), timeoutMs = 10000 } = {}) {
  const latest = new Map();
  async function metadata(url, maxBytes = 4 * 1024 ** 2, signal) {
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs); let response;
    try {
      response = await request(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json, text/html, text/plain', 'User-Agent': 'VortexPanel-Runtime/1' } });
      if (!response.ok || response.url && response.url !== url || !response.body) throw issue();
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > maxBytes) throw issue(); chunks.push(Buffer.from(part.value)); } }
      finally { await reader.cancel().catch(() => {}); }
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) { if (error?.code?.startsWith('APPLICATION_')) throw error; throw issue(); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function resolve(kind, { signal } = {}) {
    if (!['nodejs', 'python'].includes(kind) || platform !== 'linux' || !architecture(arch)) throw applicationIssue('APPLICATION_RUNTIME_PLATFORM');
    let version, source;
    if (kind === 'nodejs') {
      version = parseNodeReleases(await metadata(RUNTIME_CATALOG_SOURCES.nodejs, undefined, signal), arch)[0].version;
      const filename = `node-${version}-linux-${arch}.tar.xz`;
      source = { url: `https://nodejs.org/dist/${version}/${filename}`, sha256: parseNodeChecksum(await metadata(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, 1024 ** 2, signal), filename) };
    } else {
      const release = parsePythonReleases(await metadata(RUNTIME_CATALOG_SOURCES.python, undefined, signal))[0]; version = release.version;
      source = parsePythonSource(await metadata(release.releaseUrl, undefined, signal), version);
    }
    const pin = normalizeRuntimePin({ schema: 1, mode: 'managed', kind, version, platform: 'linux', arch, method: kind === 'nodejs' ? 'official-binary' : 'official-source', source: kind === 'nodejs' ? 'nodejs.org' : 'python.org', ...source, resolvedAt: now().toISOString() }, { arch });
    latest.set(kind, pin); return structuredClone(pin);
  }
  return { resolve, snapshot: () => [...latest.values()].map(publicRuntimePin) };
}
