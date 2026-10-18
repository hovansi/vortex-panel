import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail, walkFiles, parseProperties } from './safety.js';
import { extractZip, validateBedrockPackage } from './archives.js';
import { HISTORY_ENDPOINT, HISTORY_SOURCE, ARCHIVE_ENDPOINT, ARCHIVE_SOURCE, ARCHIVE_ROOT, boundedJson, historyEntries, historyRecord, archiveEntries, archiveRecord, compareVersions, demoHistory } from './version-catalog.js';

export const RELEASE_ENDPOINT = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
export function validateVersion(input) {
  if (typeof input !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input)) fail('Phiên bản phải có dạng 1.26.52.3.');
  return input;
}
export function validateChannel(channel = 'stable') {
  if (!['stable', 'preview'].includes(channel)) fail('Kênh phiên bản không hợp lệ.');
  return channel;
}
export function validateDownloadUrl(input, { version, channel } = {}) {
  let url;
  try { url = new URL(input); } catch { fail('URL tải xuống không hợp lệ.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.minecraft.net' || url.port || url.username || url.password || url.search || url.hash || !/^\/bedrockdedicatedserver\/bin-linux(?:-preview)?\/bedrock-server-\d+\.\d+\.\d+\.\d+\.zip$/.test(url.pathname)) fail('Chỉ cho phép ZIP Bedrock Linux chính thức từ minecraft.net.');
  if (version && !url.pathname.endsWith(`/bedrock-server-${validateVersion(version)}.zip`)) fail('Liên kết tải chuyển sang phiên bản khác.', 502);
  if (channel && url.pathname.includes('/bin-linux-preview/') !== (validateChannel(channel) === 'preview')) fail('Liên kết tải chuyển sang kênh phiên bản khác.', 502);
  return url.href;
}

async function download(url, destination, progress, signal, expectedChecksums, identity, expectedSize) {
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(validateDownloadUrl(url, identity), { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(180000), signal]), headers: { 'User-Agent': 'VortexPanel/0.9.0' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) fail('Chuỗi chuyển hướng tải xuống không hợp lệ.', 502);
      url = validateDownloadUrl(new URL(location, url).href, identity);
    } else break;
  }
  if (!response.ok || !response.body) fail(`Mojang trả về HTTP ${response.status}.`, 502);
  const total = Number(response.headers.get('content-length'));
  if (total > 1024 ** 3) fail('Gói tải xuống vượt 1 GiB.');
  let received = 0, lastPublished = 0;
  const knownTotal = Number.isSafeInteger(total) && total > 0 ? total : null;
  const publish = (final = false) => {
    const timestamp = Date.now();
    if (!final && timestamp - lastPublished < 125) return;
    lastPublished = timestamp;
    progress(knownTotal ? Math.min(65, Math.round(received / knownTotal * 65)) : 20, { phase: 'download', loadedBytes: received, totalBytes: knownTotal, percent: knownTotal ? Math.min(100, Math.floor(received / knownTotal * 100)) : null });
  };
  publish(true);
  const digests = Object.entries(expectedChecksums || {}).filter(([algorithm, value]) => ['sha256', 'sha1'].includes(algorithm) && value).map(([algorithm, value]) => ({ algorithm, expected: value, hash: createHash(algorithm) }));
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    for (const digest of digests) digest.hash.update(chunk);
    if (received > 1024 ** 3) return callback(new Error('Gói tải xuống vượt 1 GiB.'));
    publish();
    callback(null, chunk);
  } }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  publish(true);
  progress(68, { phase: 'verify', loadedBytes: received, totalBytes: knownTotal, percent: null });
  if (expectedSize && received !== expectedSize) fail('Kích thước gói tải không khớp metadata cộng đồng. Gói chưa được cài.', 502);
  for (const digest of digests) if (digest.hash.digest('hex') !== digest.expected) fail(`${digest.algorithm === 'sha256' ? 'SHA-256' : 'SHA-1'} gói tải không khớp metadata cộng đồng. Gói chưa được cài.`, 502);
}

export function createVersionService({ store, dataDir, emit, demo, audit = (...args) => store.audit(...args), reserveDisk = async () => () => {} }) {
  const packageRoot = path.join(dataDir, 'packages');
  const pending = new Map();
  const importing = new Set();
  const verifying = new Map();
  const controller = new AbortController();
  let refreshing;
  let refreshingHistory;
  let historyLoading = false;
  const sourceLoading = new Set();
  const sourceSpecs = [{ id: 'endstone', label: 'EndstoneMC/bedrock-server-data', sourceUrl: HISTORY_SOURCE }, { id: 'bds-versions', label: 'Bedrock-OSS/BDS-Versions', sourceUrl: ARCHIVE_SOURCE }];
  const publicVersion = version => {
    const officialLatest = version.source === 'mojang' && version.version === store.data.settings[version.channel === 'stable' ? 'latestVersion' : 'previewVersion'];
    const freshProof = version.availability === 'available' && Number.isFinite(Date.parse(version.availabilityCheckedAt)) && Date.now() - Date.parse(version.availabilityCheckedAt) < 24 * 60 * 60 * 1000;
    const available = Boolean(version.cached || (version.available && (!version.historical || demo || officialLatest || freshProof)));
    const availability = version.cached ? 'cached' : available ? 'available' : version.historical && version.availability === 'available' ? 'unchecked' : version.availability || (version.historical ? 'unchecked' : 'unavailable');
    return { ...version, ...(demo ? { simulated: true, available: true, availability: 'simulated', source: version.source || 'demo' } : { available, availability }), cached: Boolean(version.cached) };
  };
  const historyMetadata = () => {
    const rows = store.data.versions.filter(item => item.historical || item.catalogKeys || item.historyKey);
    const keysFor = (item, id) => item.catalogKeys?.[id] || (id === 'endstone' ? item.historyKey : null);
    const sources = sourceSpecs.map(spec => {
      const state = store.data.settings.historySources?.[spec.id] || {};
      const keys = new Set(state.keys || []);
      const known = rows.filter(item => { const key = keysFor(item, spec.id); return key && (!keys.size || keys.has(key)); });
      const loaded = new Set(known.map(item => keysFor(item, spec.id)));
      const sortedKnown = [...known].sort(compareVersions);
      const indexedCount = state.indexedCount ?? loaded.size;
      const loadedCount = loaded.size;
      return { ...spec, checkedAt: state.checkedAt || null, error: state.error || null, indexedCount, loadedCount, remainingCount: Math.max(0, indexedCount - loadedCount), stableCount: state.stableCount ?? known.filter(item => item.channel === 'stable').length, previewCount: state.previewCount ?? known.filter(item => item.channel === 'preview').length, earliestStable: state.earliestStable || sortedKnown.filter(item => item.channel === 'stable').at(-1)?.version || null, earliestPreview: state.earliestPreview || sortedKnown.filter(item => item.channel === 'preview').at(-1)?.version || null, status: sourceLoading.has(spec.id) ? 'loading' : state.error ? loadedCount ? 'partial' : 'error' : state.checkedAt ? loadedCount < indexedCount ? 'partial' : 'ready' : 'idle' };
    });
    const sorted = [...rows].sort(compareVersions);
    const stable = sorted.filter(item => item.channel === 'stable'), preview = sorted.filter(item => item.channel === 'preview');
    const remainingCount = sources.reduce((total, source) => total + source.remainingCount, 0);
    const partial = sources.some(source => source.error || source.remainingCount);
    return { source: 'EndstoneMC/bedrock-server-data + Bedrock-OSS/BDS-Versions', sourceUrl: HISTORY_SOURCE, sources, checkedAt: store.data.settings.historyCheckedAt || null, error: store.data.settings.historyError || null, indexedCount: rows.length + remainingCount, indexedCountIsEstimate: remainingCount > 0, loadedCount: rows.length, remainingCount, partial, coverage: { stable: stable.length, preview: preview.length, earliestStable: stable.at(-1)?.version || null, earliestPreview: preview.at(-1)?.version || null }, status: historyLoading ? 'loading' : partial ? rows.length ? 'partial' : 'error' : sources.some(source => source.checkedAt) ? 'ready' : 'idle' };
  };
  const metadata = () => ({
    versions: store.data.versions.map(publicVersion).sort(compareVersions),
    latest: store.data.settings.latestVersion || null,
    preview: store.data.settings.previewVersion || null,
    checkedAt: store.data.settings.versionsCheckedAt || null,
    error: store.data.settings.versionsError || null,
    history: historyMetadata(),
  });
  const keyFor = (version, channel) => `${validateChannel(channel)}-${validateVersion(version)}`;
  const directory = (version, channel) => path.join(packageRoot, keyFor(version, channel));
  const assertOpen = () => { if (controller.signal.aborted) fail('Panel đang dừng.', 503); };
  function commitCatalog(entries, settings, { latest = false } = {}) {
    assertOpen();
    const before = store.data.versions.map(item => [item, structuredClone(item)]);
    const oldSettings = structuredClone(store.data.settings);
    try {
      if (latest) for (const item of store.data.versions) if (!item.historical && !item.cached) { item.available = false; item.availability = 'unavailable'; }
      for (const fields of entries) {
        const item = store.data.versions.find(value => value.version === fields.version && value.channel === fields.channel);
        if (item) {
          // A HEAD/metadata request may have begun before a package was
          // imported or downloaded. Its late network observation cannot revoke
          // validated immutable local bytes, their transport or checksum proof.
          const localPackage = item.cached ? Object.fromEntries(['cached', 'imported', 'transport', 'url', 'sha256', 'sha1', 'checksumSource', 'size', 'availabilityCheckedAt', ...(item.imported ? ['source'] : [])].map(key => [key, item[key]])) : null;
          if (['endstone', 'bds-versions'].includes(fields.source)) {
            const keep = { available: item.available, availability: item.availability, availabilityCheckedAt: item.availabilityCheckedAt, verificationError: item.verificationError, cached: item.cached, imported: item.imported, source: item.source };
            const catalogKeys = { ...item.catalogKeys, ...(item.historyKey ? { endstone: item.historyKey } : {}), ...fields.catalogKeys };
            const oldMetadata = { metadataStatus: item.metadataStatus, metadataError: item.metadataError };
            const oldUrl = item.url, oldChecksumSource = item.checksumSource;
            Object.assign(item, fields);
            for (const [key, value] of Object.entries(keep)) if (value !== undefined) item[key] = value;
            item.catalogKeys = catalogKeys;
            if (fields.source === 'endstone' && !['mojang', 'import'].includes(keep.source)) item.source = 'endstone';
            if (fields.source === 'bds-versions' && keep.source && keep.source !== 'bds-versions') { item.url = oldUrl; if (oldChecksumSource) item.checksumSource = oldChecksumSource; }
            if (fields.metadataStatus === 'pending' && oldMetadata.metadataStatus === 'ready') Object.assign(item, oldMetadata);
            if (keep.source === 'mojang') item.metadataStatus = 'ready';
            if (item.imported) { item.url = null; item.sha256 = null; item.sha1 = null; item.checksumSource = null; item.source = 'import'; }
          } else Object.assign(item, fields);
          if (localPackage) Object.assign(item, localPackage, { available: true, availability: 'cached', metadataStatus: 'ready', metadataError: null, verificationError: null });
        } else store.data.versions.push(fields);
      }
      Object.assign(store.data.settings, settings);
      store.save();
    } catch (error) {
      store.data.versions = before.map(([item, fields]) => { for (const key of Object.keys(item)) delete item[key]; Object.assign(item, fields); return item; });
      for (const key of Object.keys(store.data.settings)) delete store.data.settings[key];
      Object.assign(store.data.settings, oldSettings);
      throw error;
    }
    emit({ type: 'update' });
  }
  async function activatePackage(temporary, target, fields, existing) {
    let activated = false;
    let before;
    try {
      await fs.rename(temporary, target); activated = true;
      assertOpen(); before = existing && structuredClone(existing);
      if (existing) Object.assign(existing, fields);
      else store.data.versions.unshift(fields);
      store.save();
      return existing || fields;
    } catch (error) {
      if (activated) {
        if (existing && before) { for (const key of Object.keys(existing)) delete existing[key]; Object.assign(existing, before); }
        else store.data.versions = store.data.versions.filter(item => item !== fields);
        // Only this invocation's newly activated immutable directory is removed.
        await fs.rm(target, { recursive: true, force: true }).catch(rollbackError => { error.message += `; không thể dọn gói chưa được lưu: ${rollbackError.message}`; });
      }
      throw error;
    }
  }
  async function checkReleases() {
    try {
      const response = await fetch(RELEASE_ENDPOINT, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15000), controller.signal]), headers: { 'User-Agent': 'VortexPanel/0.9.0' } });
      if (!response.ok) fail(`Không thể kiểm tra Mojang (HTTP ${response.status}).`, 502);
      const chunks = []; let size = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        size += chunk.length; if (size > 1024 * 1024) fail('Phản hồi Mojang quá lớn.', 502);
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (controller.signal.aborted) return metadata();
      const links = JSON.parse(text)?.result?.links;
      if (!Array.isArray(links)) fail('Mojang đã thay đổi định dạng API.', 502);
      const now = new Date().toISOString();
      const discovered = [];
      for (const [downloadType, channel] of [['serverBedrockLinux', 'stable'], ['serverBedrockPreviewLinux', 'preview']]) {
        const link = links.find(item => item.downloadType === downloadType);
        if (!link) continue;
        const url = validateDownloadUrl(link.downloadUrl);
        if (url.includes('/bin-linux-preview/') !== (channel === 'preview')) fail('Mojang trả liên kết không khớp kênh Linux.', 502);
        const version = validateVersion(url.match(/bedrock-server-(\d+\.\d+\.\d+\.\d+)\.zip$/)[1]);
        discovered.push({ version, channel, url, available: true, availability: 'available', source: 'mojang', metadataStatus: 'ready', discoveredAt: now });
      }
      if (!discovered.some(item => item.channel === 'stable')) fail('Mojang chưa cung cấp liên kết Linux stable.', 502);
      const settings = { versionsCheckedAt: now, versionsError: null, previewVersion: null };
      for (const item of discovered) settings[item.channel === 'stable' ? 'latestVersion' : 'previewVersion'] = item.version;
      commitCatalog(discovered, settings, { latest: true });
    } catch (error) {
      if (controller.signal.aborted) return metadata();
      commitCatalog([], { versionsError: `Không thể xác thực bản mới: ${error.message}. Các gói đã lưu vẫn sử dụng được.` });
    }
    return metadata();
  }
  function commitHistorySource(id, fields, records = []) {
    commitCatalog(records, { historySources: { ...store.data.settings.historySources, [id]: { ...store.data.settings.historySources?.[id], ...fields } } });
  }
  function indexState(entries, key) {
    const sorted = [...entries].sort((a, b) => compareVersions({ version: a.version || a.displayVersion.replace('-preview.', '.'), channel: a.channel }, { version: b.version || b.displayVersion.replace('-preview.', '.'), channel: b.channel }));
    return { keys: entries.map(key), indexedCount: entries.length, stableCount: entries.filter(item => item.channel === 'stable').length, previewCount: entries.filter(item => item.channel === 'preview').length, earliestStable: sorted.filter(item => item.channel === 'stable').at(-1)?.version || sorted.filter(item => item.channel === 'stable').at(-1)?.displayVersion || null, earliestPreview: sorted.filter(item => item.channel === 'preview').at(-1)?.version || sorted.filter(item => item.channel === 'preview').at(-1)?.displayVersion || null, checkedAt: new Date().toISOString(), error: null };
  }
  async function checkArchiveHistory() {
    const id = 'bds-versions'; sourceLoading.add(id);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
      const entries = archiveEntries(await boundedJson(ARCHIVE_ENDPOINT, signal), validateDownloadUrl);
      // One bounded registry response makes every known Linux identifier visible;
      // hundreds of optional metadata requests cannot truncate the catalog.
      commitHistorySource(id, indexState(entries, entry => entry.catalogKeys[id]), entries);
      return true;
    } catch (error) { if (!controller.signal.aborted) commitHistorySource(id, { error: error.message }); return false; }
    finally { sourceLoading.delete(id); if (!controller.signal.aborted) emit({ type: 'update' }); }
  }
  async function checkEndstoneHistory() {
    const id = 'endstone'; sourceLoading.add(id);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    try {
      const entries = historyEntries(await boundedJson(HISTORY_ENDPOINT, signal));
      commitHistorySource(id, indexState(entries, entry => entry.historyKey));
      const existingKeys = new Set(store.data.versions.filter(item => (item.catalogKeys?.endstone || item.historyKey) && (item.sha256 || item.imported || item.cached)).map(item => item.catalogKeys?.endstone || item.historyKey));
      const wanted = entries.filter((entry, index) => !existingKeys.has(entry.historyKey) || index < 5);
      let cursor = 0, failed = 0;
      while (cursor < wanted.length && !signal.aborted) {
        const batch = wanted.slice(cursor, cursor + 8); cursor += batch.length;
        const records = (await Promise.all(batch.map(async entry => {
          try { return historyRecord(await boundedJson(entry.metadataUrl, AbortSignal.any([signal, AbortSignal.timeout(8000)]), 32 * 1024), entry, validateDownloadUrl, validateVersion); }
          catch { failed++; return null; }
        }))).filter(Boolean);
        if (records.length) commitHistorySource(id, {}, records);
      }
      const unresolved = failed + Math.max(0, wanted.length - cursor);
      commitHistorySource(id, { error: unresolved ? `${unresolved} mục metadata chưa đồng bộ; làm mới để thử lại.` : null });
      return true;
    } catch (error) { if (!controller.signal.aborted) commitHistorySource(id, { error: error.message }); return false; }
    finally { sourceLoading.delete(id); if (!controller.signal.aborted) emit({ type: 'update' }); }
  }
  async function checkHistory() {
    historyLoading = true; emit({ type: 'update' });
    try {
      const results = await Promise.allSettled([checkArchiveHistory(), checkEndstoneHistory()]);
      if (controller.signal.aborted) return metadata();
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      const errors = sourceSpecs.map(source => store.data.settings.historySources?.[source.id]?.error).filter(Boolean);
      const checked = results.some(result => result.value);
      commitCatalog([], { ...(checked ? { historyCheckedAt: new Date().toISOString() } : {}), historyError: errors.length ? errors.join(' · ') : null });
    } finally { historyLoading = false; if (!controller.signal.aborted) emit({ type: 'update' }); }
    return metadata();
  }
  function refreshHistory() {
    assertOpen();
    if (!refreshingHistory) refreshingHistory = checkHistory().finally(() => { refreshingHistory = null; });
    return refreshingHistory;
  }
  function refresh() {
    assertOpen();
    if (refreshing) return refreshing;
    refreshing = Promise.all([checkReleases(), refreshHistory()]).then(metadata).finally(() => { refreshing = null; });
    return refreshing;
  }
  async function verify(version, channel = 'stable') {
    assertOpen(); const key = keyFor(version, channel);
    const item = store.data.versions.find(value => value.version === version && value.channel === channel);
    if (!item) fail('Phiên bản không có trong chỉ mục.', 404);
    if (demo || item.cached) return publicVersion(item);
    if (!item.url) fail('Bản này cần nhập ZIP Linux để sử dụng.', 409);
    if (verifying.has(key)) return verifying.get(key);
    if (verifying.size >= 4) fail('Đang kiểm tra nhiều liên kết. Vui lòng thử lại sau.', 429);
    if (item.availabilityCheckedAt && Date.now() - Date.parse(item.availabilityCheckedAt) < 60000) return publicVersion(item);
    const promise = (async () => {
      let url = validateDownloadUrl(item.url, { version, channel }); let response; let fields;
      const signal = AbortSignal.any([AbortSignal.timeout(12000), controller.signal]);
      try {
        if (item.source === 'bds-versions' && item.archiveMetadataUrl && item.metadataStatus !== 'ready' && !item.sha256) {
          const metadataUrl = `${ARCHIVE_ROOT}/${channel === 'preview' ? 'linux_preview' : 'linux'}/${version}.json`;
          try {
            const details = archiveRecord(await boundedJson(metadataUrl, AbortSignal.any([signal, AbortSignal.timeout(8000)]), 32 * 1024), item, validateDownloadUrl);
            commitCatalog([details], {}); url = validateDownloadUrl(item.url, { version, channel });
          } catch (error) {
            assertOpen();
            commitCatalog([{ version, channel, metadataStatus: 'error', metadataError: error.message, available: false, availability: 'error', verificationError: `Chưa xác minh được metadata Linux: ${error.message}`, availabilityCheckedAt: new Date().toISOString() }], {});
            return publicVersion(item);
          }
        }
        for (let redirects = 0; redirects <= 5; redirects++) {
          response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal, headers: { 'User-Agent': 'VortexPanel/0.9.0' } });
          await response.body?.cancel();
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          if (!location || redirects === 5) fail('Chuỗi chuyển hướng tải xuống không hợp lệ.', 502);
          url = validateDownloadUrl(new URL(location, url).href, { version, channel });
        }
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const lengthHeader = response.headers.get('content-length');
        const length = Number(lengthHeader);
        const validLength = lengthHeader === null || (/^\d+$/.test(lengthHeader) && Number.isSafeInteger(length) && length >= 1000 && length <= 1024 ** 3);
        const validType = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(type);
        const matchesMetadataSize = !item.size || lengthHeader === null || length === item.size;
        if (response.status === 200 && validType && validLength && matchesMetadataSize) fields = { available: true, availability: 'available', verificationError: null };
        else if (response.status === 200 && validType && validLength && !matchesMetadataSize) fields = { available: false, availability: 'error', verificationError: 'Kích thước ZIP Mojang không khớp metadata lịch sử; hãy kiểm tra lại nguồn hoặc nhập gói đã lưu.' };
        else fields = { available: false, availability: [404, 410].includes(response.status) ? 'unavailable' : 'error', verificationError: [404, 410].includes(response.status) ? 'Mojang không còn cung cấp gói này. Bạn có thể nhập ZIP Linux đã lưu.' : `Chưa xác minh được ZIP từ Mojang (HTTP ${response.status}). Hãy thử lại hoặc nhập gói đã lưu.` };
      } catch (error) { assertOpen(); fields = { available: false, availability: 'error', verificationError: `Không kiểm tra được liên kết: ${error.message}` }; }
      assertOpen();
      commitCatalog([{ version, channel, ...fields, availabilityCheckedAt: new Date().toISOString() }], {});
      return publicVersion(item);
    })();
    verifying.set(key, promise);
    try { return await promise; } finally { verifying.delete(key); }
  }
  async function ensure(version, channel, progress = () => {}) {
    assertOpen();
    const key = keyFor(version, channel);
    if (importing.has(key)) fail('Phiên bản đang được nhập. Vui lòng đợi hoàn tất.', 409);
    const target = directory(version, channel);
    const item = store.data.versions.find(value => value.version === version && value.channel === channel);
    if (!item) fail('Phiên bản chưa được khám phá hoặc nhập vào kho. Hãy làm mới Mojang hoặc nhập ZIP.', 404);
    if (demo) return { directory: target, manifest: ['bedrock_server'], simulated: true };
    if (item.cached) {
      try { progress(70, { phase: 'cache', loadedBytes: 0, totalBytes: null, percent: null }); } catch {}
      await validateBedrockPackage(target);
      return { directory: target, manifest: await walkFiles(target) };
    }
    if (!item.url) fail('Phiên bản này không có URL tải xuống.', 404);
    if (pending.has(key)) {
      const shared = pending.get(key); shared.observers.add(progress);
      if (shared.lastProgress) try { progress(...shared.lastProgress); } catch {}
      try { return await shared.promise; } finally { shared.observers.delete(progress); }
    }
    const shared = { observers: new Set([progress]), lastProgress: null, promise: null };
    const publish = (value, details) => {
      shared.lastProgress = [value, details];
      for (const observer of shared.observers) try { observer(value, details); } catch {}
    };
    const promise = (async () => {
      const releaseDisk = await reserveDisk(3 * 1024 ** 3);
      const temporary = path.join(packageRoot, `.download-${randomUUID()}`);
      const archive = `${temporary}.zip`;
      try {
        await fs.mkdir(packageRoot, { recursive: true });
        if (item.historical) { const checked = await verify(version, channel); if (!checked.available) fail(checked.verificationError || 'Phiên bản chưa có gói tải khả dụng.', 502); }
        await download(item.url, archive, publish, controller.signal, { sha256: item.sha256, sha1: item.sha1 }, { version, channel }, item.size);
        publish(70, { phase: 'extract', loadedBytes: 0, totalBytes: null, percent: null });
        await extractZip(archive, temporary);
        publish(78, { phase: 'verify', loadedBytes: 0, totalBytes: null, percent: null });
        await validateBedrockPackage(temporary);
        if (controller.signal.aborted) fail('Panel đang dừng.', 503);
        const transport = parseProperties(await fs.readFile(path.join(temporary, 'server.properties'), 'utf8')).transport || 'raknet';
        const manifest = await walkFiles(temporary);
        assertOpen();
        await activatePackage(temporary, target, { transport, cached: true, available: true, availability: 'cached', metadataStatus: 'ready', metadataError: null, verificationError: null, availabilityCheckedAt: new Date().toISOString() }, item);
        return { directory: target, manifest };
      } finally {
        await fs.rm(archive, { force: true }).catch(() => {});
        await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
        await releaseDisk();
      }
    })();
    shared.promise = promise; pending.set(key, shared);
    try { return await promise; } finally { pending.delete(key); }
  }
  async function importPackage(archive, version, channel = 'stable') {
    assertOpen();
    const key = keyFor(version, channel);
    if (demo) fail('Nhập gói chính thức không hoạt động trong chế độ demo.', 409);
    if (pending.has(key) || importing.has(key)) fail('Phiên bản đang được tải hoặc nhập. Vui lòng đợi hoàn tất.', 409);
    const target = directory(version, channel);
    if (store.data.versions.some(item => item.version === version && item.channel === channel && item.cached)) fail('Gói phiên bản đã được lưu; không thể thay thế gói bất biến.', 409);
    importing.add(key);
    const temporary = path.join(packageRoot, `.import-${randomUUID()}`);
    let releaseDisk;
    try {
      releaseDisk = await reserveDisk(2 * 1024 ** 3);
      await fs.mkdir(packageRoot, { recursive: true });
      await extractZip(archive, temporary);
      await validateBedrockPackage(temporary);
      if (controller.signal.aborted) fail('Panel đang dừng.', 503);
      const transport = parseProperties(await fs.readFile(path.join(temporary, 'server.properties'), 'utf8')).transport || 'raknet';
      const item = { version, channel, url: null, sha256: null, sha1: null, checksumSource: null, source: 'import', metadataStatus: 'ready', metadataError: null, verificationError: null, availability: 'cached', availabilityCheckedAt: new Date().toISOString(), imported: true, cached: true, available: true, transport, discoveredAt: new Date().toISOString() };
      const existing = store.data.versions.find(value => value.version === version && value.channel === channel);
      assertOpen();
      const activated = await activatePackage(temporary, target, item, existing);
      emit({ type: 'update' });
      try { audit('version.import', `${channel} ${version}`); } catch {}
      return activated;
    } finally { importing.delete(key); await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}); await releaseDisk?.(); }
  }
  return { metadata, refresh, refreshHistory, verify, demoHistory, ensure, importPackage, directory, close: () => controller.abort() };
}
