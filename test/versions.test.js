import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { createHash, randomBytes } from 'node:crypto';
import { HISTORY_ENDPOINT, ARCHIVE_ENDPOINT, ARCHIVE_ROOT, archiveEntries, archiveRecord, historyEntries, historyRecord } from '../server/version-catalog.js';
import { createVersionService, RELEASE_ENDPOINT, validateDownloadUrl, validateVersion } from '../server/versions.js';

const official = (version, channel = 'stable') => `https://www.minecraft.net/bedrockdedicatedserver/bin-linux${channel === 'preview' ? '-preview' : ''}/bedrock-server-${version}.zip`;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const registry = { release: { latest: '1.26.51', versions: ['1.26.51'] }, preview: { latest: '1.26.60-preview.29', versions: ['1.26.60-preview.29'] } };
const archiveIndex = (stable = ['1.6.0.15', '1.16.1.02'], preview = ['1.19.50.21']) => ({ cdn_root: 'https://www.minecraft.net/bedrockdedicatedserver', linux: { versions: stable, preview_versions: preview }, windows: { versions: ['9.9.9.9'] } });
const record = (display, version, channel = 'stable', hash = 'a'.repeat(64)) => ({ version: display, binary: { linux: { url: official(version, channel), sha256: hash } } });
const storeFor = () => ({ data: { versions: [], settings: {} }, save() {}, audit() {} });
async function serviceFor(t, store = storeFor()) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-versions-'));
  const originalFetch = globalThis.fetch;
  const service = createVersionService({ store, dataDir, demo: false, emit() {} });
  t.after(async () => { service.close(); globalThis.fetch = originalFetch; await fs.rm(dataDir, { recursive: true, force: true }); });
  return { service, store, dataDir };
}

test('historical metadata requires exact Linux channel/version identity and rejects untrusted URL/schema', () => {
  const entries = historyEntries(registry);
  assert.equal(entries.length, 2);
  assert.ok(entries.every(entry => entry.metadataUrl.startsWith('https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2/')));
  const stable = historyRecord(record('1.26.51', '1.26.51.1'), entries[0], validateDownloadUrl, validateVersion);
  assert.equal(stable.version, '1.26.51.1'); assert.equal(stable.availability, 'unchecked'); assert.equal(stable.available, false);
  assert.equal(historyRecord(record('1.26.60-preview.29', '1.26.60.29', 'preview'), entries[1], validateDownloadUrl, validateVersion).channel, 'preview');
  assert.throws(() => historyEntries({ ...registry, release: { versions: ['../escape'] } }));
  assert.throws(() => historyRecord(record('1.26.51', '1.26.52.3'), entries[0], validateDownloadUrl, validateVersion), /khớp/);
  assert.throws(() => historyRecord(record('1.26.51', '1.26.51.1', 'preview'), entries[0], validateDownloadUrl, validateVersion), /kênh/);
  assert.throws(() => historyRecord({ version: '1.26.51', binary: { linux: { url: 'https://evil.test/bds.zip', sha256: 'a'.repeat(64) } } }, entries[0], validateDownloadUrl, validateVersion), /chính thức/);
  assert.throws(() => historyRecord(record('1.26.51', '1.26.51.1', 'stable', 'invalid'), entries[0], validateDownloadUrl, validateVersion), /SHA/);
});

test('community history cannot override Mojang latest and HEAD verification is deduplicated with cached fallback', async t => {
  const { service, store } = await serviceFor(t);
  let heads = 0; let releaseOnline = true; let headGate;
  globalThis.fetch = async (url, options) => {
    if (url === RELEASE_ENDPOINT) { if (!releaseOnline) throw Error('offline'); return json({ result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: official('1.26.52.3') }] } }); }
    if (url === HISTORY_ENDPOINT) return json(registry);
    if (String(url).endsWith('/release/1.26.51/metadata.json')) return json(record('1.26.51', '1.26.51.1'));
    if (String(url).endsWith('/preview/1.26.60-preview.29/metadata.json')) return json(record('1.26.60-preview.29', '1.26.60.29', 'preview'));
    assert.equal(options.method, 'HEAD'); heads++; if (headGate) await headGate;
    return new Response(null, { headers: { 'content-type': 'application/x-zip-compressed', 'content-length': '90000000' } });
  };
  const result = await service.refresh();
  assert.equal(result.latest, '1.26.52.3'); assert.equal(result.preview, null); assert.equal(result.versions.length, 3);
  assert.equal(result.versions.find(item => item.version === '1.26.51.1').available, false); assert.ok(result.history.checkedAt);
  let releaseHead; headGate = new Promise(resolve => { releaseHead = resolve; });
  const first = service.verify('1.26.51.1', 'stable'); const second = service.verify('1.26.51.1', 'stable'); releaseHead();
  assert.equal((await first).availability, 'available'); await second; assert.equal(heads, 1);
  releaseOnline = false;
  const offline = await service.refresh(); assert.equal(offline.latest, '1.26.52.3'); assert.match(offline.error, /offline/);
  assert.equal(offline.versions.find(item => item.version === '1.26.51.1').available, true);
  const cached = store.data.versions.find(item => item.version === '1.26.51.1'); cached.cached = true;
  assert.equal((await service.verify(cached.version, cached.channel)).availability, 'cached'); assert.equal(heads, 1);
});

test('successful Mojang refresh clears withdrawn Preview latest while offline refresh preserves last known releases', async t => {
  const { service } = await serviceFor(t);
  let includePreview = true; let online = true;
  globalThis.fetch = async url => {
    if (url === RELEASE_ENDPOINT) {
      if (!online) throw Error('offline');
      return json({ result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: official('1.26.52.3') }, ...(includePreview ? [{ downloadType: 'serverBedrockPreviewLinux', downloadUrl: official('1.26.60.29', 'preview') }] : [])] } });
    }
    if (url === HISTORY_ENDPOINT) return json(registry);
    return String(url).includes('/preview/') ? json(record('1.26.60-preview.29', '1.26.60.29', 'preview')) : json(record('1.26.51', '1.26.51.1'));
  };
  assert.equal((await service.refresh()).preview, '1.26.60.29');
  online = false;
  assert.equal((await service.refresh()).preview, '1.26.60.29');
  online = true; includePreview = false;
  const withdrawn = await service.refresh();
  assert.equal(withdrawn.preview, null); assert.equal(withdrawn.error, null);
  assert.ok(withdrawn.versions.some(item => item.version === '1.26.60.29'));
  assert.equal(withdrawn.versions.find(item => item.version === '1.26.60.29').available, false);
});

test('history verification distinguishes retired downloads, HTML masquerading as ZIP and unsafe redirects', async t => {
  const { service, store } = await serviceFor(t);
  const version = { version: '1.26.51.1', channel: 'stable', historical: true, url: official('1.26.51.1'), available: false };
  store.data.versions.push(version);
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal((await service.verify(version.version)).availability, 'unavailable'); assert.match(version.verificationError, /không còn/);
  version.availabilityCheckedAt = null;
  globalThis.fetch = async () => new Response(null, { headers: { 'content-type': 'text/html', 'content-length': '2000' } });
  assert.equal((await service.verify(version.version)).availability, 'error'); assert.equal(version.available, false);
  for (const [status, headers] of [[200, { 'content-type': 'application/zip', 'content-length': '0' }], [204, { 'content-type': 'application/zip' }]]) {
    version.availabilityCheckedAt = null;
    globalThis.fetch = async () => new Response(null, { status, headers });
    assert.equal((await service.verify(version.version)).availability, 'error'); assert.equal(version.available, false);
  }
  version.availabilityCheckedAt = null;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: official('1.26.60.30', 'preview') } });
  assert.equal((await service.verify(version.version)).availability, 'error'); assert.equal(version.available, false); assert.match(version.verificationError, /phiên bản khác/);
  version.availabilityCheckedAt = null; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/file.zip' } }); };
  assert.equal((await service.verify(version.version)).availability, 'error'); assert.equal(calls, 1); assert.match(version.verificationError, /chính thức/);
  service.close(); await assert.rejects(service.verify(version.version), error => error.status === 503);
});

test('uncached downloads cannot redirect to a different official version or channel', async t => {
  const { service, store, dataDir } = await serviceFor(t);
  const item = { version: '1.26.51.1', channel: 'stable', url: official('1.26.51.1'), available: true, source: 'mojang' };
  store.data.versions.push(item);
  for (const redirect of [official('1.26.52.3'), official('1.26.51.1', 'preview')]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: redirect } }); };
    await assert.rejects(service.ensure(item.version, item.channel), /phiên bản khác/);
    assert.equal(calls, 1); assert.equal(item.cached, undefined); assert.deepEqual(await fs.readdir(path.join(dataDir, 'packages')), []);
  }
});

test('history and link status durable failures restore catalog object identity and settings', async t => {
  const store = storeFor();
  const existing = { version: '1.26.51.1', channel: 'stable', url: official('1.26.51.1'), available: false };
  store.data.versions.push(existing); store.data.settings.testSetting = 'keep';
  const { service } = await serviceFor(t, store); const before = structuredClone(existing);
  globalThis.fetch = async url => url === HISTORY_ENDPOINT ? json(registry) : String(url).includes('/preview/') ? json(record('1.26.60-preview.29', '1.26.60.29', 'preview')) : json(record('1.26.51', '1.26.51.1'));
  store.save = () => { throw Error('disk write failed'); };
  await assert.rejects(service.refreshHistory(), /disk write failed/);
  assert.equal(store.data.versions.length, 1); assert.equal(store.data.versions[0], existing); assert.deepEqual(existing, before); assert.deepEqual(store.data.settings, { testSetting: 'keep' });
  globalThis.fetch = async () => new Response(null, { headers: { 'content-type': 'application/zip', 'content-length': '90000000' } });
  await assert.rejects(service.verify(existing.version), /disk write failed/);
  assert.equal(store.data.versions[0], existing); assert.deepEqual(existing, before);
});

async function packageFixture(properties = 'server-port=19132\nserver-portv6=19133\n') {
  const zip = archiver('zip'); const chunks = [];
  zip.on('data', chunk => chunks.push(chunk));
  const completion = new Promise((resolve, reject) => { zip.on('end', resolve); zip.on('error', reject); });
  const executable = Buffer.alloc(4096); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(executable); executable.writeUInt16LE(62, 18);
  zip.append(executable, { name: 'bedrock_server' }); zip.append(properties, { name: 'server.properties' }); zip.append(randomBytes(4096), { name: 'padding.bin' });
  await zip.finalize(); await completion; return Buffer.concat(chunks);
}

test('historical download verifies community checksum before immutable package activation', async t => {
  const { service, store, dataDir } = await serviceFor(t);
  const archive = await packageFixture(); const hash = createHash('sha256').update(archive).digest('hex');
  const item = { version: '1.26.51.1', channel: 'stable', historical: true, url: official('1.26.51.1'), sha256: 'a'.repeat(64), available: false };
  store.data.versions.push(item);
  globalThis.fetch = async (_url, options) => new Response(options.method === 'HEAD' ? null : archive, { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } });
  await assert.rejects(service.ensure(item.version, item.channel), /SHA-256/); assert.equal(item.cached, undefined);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'packages')), []);
  item.sha256 = hash;
  const installed = await service.ensure(item.version, item.channel); assert.ok(installed.manifest.includes('bedrock_server')); assert.equal(item.cached, true);
  assert.equal(await fs.readFile(path.join(installed.directory, 'server.properties'), 'utf8'), 'server-port=19132\nserver-portv6=19133\n');
});

test('broad Linux registry retains exact padded identifiers and legacy metadata without inventing build IDs', () => {
  const entries = archiveEntries(archiveIndex(), validateDownloadUrl);
  assert.deepEqual(entries.map(item => item.version), ['1.6.0.15', '1.16.1.02', '1.19.50.21']);
  assert.equal(entries[1].url, official('1.16.1.02')); assert.ok(entries.every(item => item.available === false && item.availability === 'unchecked' && item.metadataStatus === 'pending'));
  const details = archiveRecord({ version: '1.16.1.02', platform: 'linux', size_in_bytes: 22000000, download_url: official('1.16.1.02'), date: '2020-06-29T12:00:00' }, entries[1], validateDownloadUrl);
  assert.equal(details.sha1, null); assert.equal(details.checksumSource, null); assert.equal(details.metadataStatus, 'ready');
  assert.throws(() => archiveEntries({ ...archiveIndex(), cdn_root: 'https://evil.test' }, validateDownloadUrl), /CDN/);
  assert.throws(() => archiveEntries(archiveIndex(['1.16.1']), validateDownloadUrl), /định dạng/);
  for (const changes of [{ version: '1.16.1.2' }, { platform: 'windows' }, { download_url: official('1.16.1.02', 'preview') }, { sha1: 'bad' }, { size_in_bytes: -1 }]) assert.throws(() => archiveRecord({ version: '1.16.1.02', platform: 'linux', size_in_bytes: 22000000, download_url: official('1.16.1.02'), ...changes }, entries[1], validateDownloadUrl));
});

test('all known archive identifiers appear before optional metadata loads and merge retains stronger Endstone proof', async t => {
  const { service, store } = await serviceFor(t); let archiveDetails = 0;
  globalThis.fetch = async url => {
    if (url === ARCHIVE_ENDPOINT) return json(archiveIndex(['1.6.0.15', '1.16.1.02', '1.26.51.1'], ['1.19.50.21', '1.26.60.29']));
    if (url === HISTORY_ENDPOINT) return json(registry);
    if (String(url).startsWith(ARCHIVE_ROOT)) { archiveDetails++; throw Error('metadata should remain lazy'); }
    return String(url).includes('/preview/') ? json(record('1.26.60-preview.29', '1.26.60.29', 'preview')) : json(record('1.26.51', '1.26.51.1'));
  };
  const data = await service.refreshHistory();
  assert.equal(data.versions.length, 5); assert.equal(archiveDetails, 0); assert.equal(data.latest, null);
  assert.equal(data.history.status, 'ready'); assert.equal(data.history.partial, false); assert.equal(data.history.remainingCount, 0);
  assert.deepEqual(data.history.coverage, { stable: 3, preview: 2, earliestStable: '1.6.0.15', earliestPreview: '1.19.50.21' });
  assert.equal(data.history.sources.find(source => source.id === 'bds-versions').indexedCount, 5);
  assert.equal(data.history.sources.find(source => source.id === 'endstone').loadedCount, 2);
  const recent = store.data.versions.find(item => item.version === '1.26.51.1');
  assert.equal(recent.sha256, 'a'.repeat(64)); assert.equal(recent.source, 'endstone'); assert.equal(recent.checksumSource, 'endstone'); assert.equal(recent.metadataStatus, 'ready');
  await service.refreshHistory(); assert.equal(recent.sha256, 'a'.repeat(64)); assert.equal(recent.metadataStatus, 'ready');
});

test('partial incremental metadata backfill reports source coverage and retries missing records without clearing known versions', async t => {
  const { service } = await serviceFor(t); let fail = true; const calls = new Map();
  const displays = Array.from({ length: 10 }, (_, index) => `1.21.${62 + index}`);
  globalThis.fetch = async url => {
    if (url === ARCHIVE_ENDPOINT) return json(archiveIndex(['1.6.0.15'], []));
    if (url === HISTORY_ENDPOINT) return json({ release: { versions: displays }, preview: { versions: [] } });
    const display = String(url).match(/release\/(1\.21\.\d+)\/metadata\.json/)?.[1];
    if (!display) throw Error('Unexpected URL');
    calls.set(display, (calls.get(display) || 0) + 1);
    if (display === '1.21.68' && fail) throw Error('temporary metadata failure');
    return json(record(display, `${display}.1`));
  };
  let data = await service.refreshHistory();
  assert.equal(data.history.status, 'partial'); assert.equal(data.history.remainingCount, 1); assert.equal(data.history.loadedCount, 10); assert.match(data.history.error, /1 mục/);
  assert.ok(data.versions.some(item => item.version === '1.6.0.15'));
  fail = false; data = await service.refreshHistory();
  assert.equal(data.history.status, 'ready'); assert.equal(data.history.remainingCount, 0); assert.equal(data.history.loadedCount, 11);
  assert.equal(calls.get('1.21.68'), 2); assert.equal(calls.get('1.21.70'), 1); assert.equal(calls.get('1.21.71'), 1);
  globalThis.fetch = async () => { throw Error('all sources offline'); };
  const offline = await service.refreshHistory(); assert.equal(offline.versions.length, 11); assert.equal(offline.history.status, 'partial'); assert.ok(offline.history.sources.every(source => source.error));
});

test('lazy legacy verification requires exact Linux metadata and HEAD while keeping optional missing hashes honest', async t => {
  const { service, store } = await serviceFor(t); let heads = 0;
  const entry = archiveEntries(archiveIndex(['1.16.1.02'], []), validateDownloadUrl)[0]; store.data.versions.push(entry);
  globalThis.fetch = async (url, options) => {
    if (url === `${ARCHIVE_ROOT}/linux/1.16.1.02.json`) return json({ version: '1.16.1.02', platform: 'linux', size_in_bytes: 22000000, download_url: official('1.16.1.02') });
    assert.equal(options.method, 'HEAD'); heads++; return new Response(null, { headers: { 'content-type': 'application/zip', 'content-length': '22000000' } });
  };
  const verified = await service.verify('1.16.1.02'); assert.equal(heads, 1); assert.equal(verified.available, true); assert.equal(verified.sha1, null); assert.equal(verified.checksumSource, null);
  entry.availabilityCheckedAt = null;
  globalThis.fetch = async () => new Response(null, { headers: { 'content-type': 'application/zip', 'content-length': '22000001' } });
  const mismatched = await service.verify(entry.version); assert.equal(mismatched.available, false); assert.match(mismatched.verificationError, /Kích thước/);
  const malformed = archiveEntries(archiveIndex(['1.20.0.01'], []), validateDownloadUrl)[0]; store.data.versions.push(malformed);
  globalThis.fetch = async () => json({ version: '1.20.0.1', platform: 'linux', size_in_bytes: 22000000, download_url: official('1.20.0.1') });
  const rejected = await service.verify('1.20.0.01'); assert.equal(rejected.available, false); assert.equal(rejected.metadataStatus, 'error'); assert.match(rejected.verificationError, /metadata Linux/);
});

test('legacy SHA-1 from community metadata is checked before immutable package activation', async t => {
  const { service, store, dataDir } = await serviceFor(t); const archive = await packageFixture();
  const entry = archiveEntries(archiveIndex(['1.20.0.01'], []), validateDownloadUrl)[0]; store.data.versions.push(entry);
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(ARCHIVE_ROOT)) return json({ version: entry.version, platform: 'linux', size_in_bytes: archive.length, download_url: entry.url, sha1: '0'.repeat(40) });
    return new Response(options.method === 'HEAD' ? null : archive, { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } });
  };
  await assert.rejects(service.ensure(entry.version, entry.channel), /SHA-1/); assert.equal(entry.cached, undefined); assert.deepEqual(await fs.readdir(path.join(dataDir, 'packages')), []);
  entry.sha1 = createHash('sha1').update(archive).digest('hex');
  const installed = await service.ensure(entry.version, entry.channel); assert.ok(installed.manifest.includes('bedrock_server')); assert.equal(entry.cached, true);
});

test('hashless legacy packages still enforce observed metadata byte count before activation', async t => {
  const { service, store, dataDir } = await serviceFor(t); const archive = await packageFixture();
  const entry = { ...archiveEntries(archiveIndex(['1.6.0.15'], []), validateDownloadUrl)[0], metadataStatus: 'ready', size: archive.length + 1, sha1: null, sha256: null };
  store.data.versions.push(entry);
  globalThis.fetch = async (_url, options) => new Response(options.method === 'HEAD' ? null : archive, { headers: { 'content-type': 'application/zip' } });
  await assert.rejects(service.ensure(entry.version, entry.channel), /Kích thước gói tải/); assert.equal(entry.cached, undefined); assert.deepEqual(await fs.readdir(path.join(dataDir, 'packages')), []);
});

test('demo reads complete live metadata without downloads or HEAD proofs and preserves fallback entries offline', async t => {
  const { store, dataDir } = await serviceFor(t); const service = createVersionService({ store, dataDir, demo: true, emit() {} }); t.after(() => service.close());
  store.data.versions.push({ version: '1.26.52.3', channel: 'stable', source: 'demo', simulated: true, available: true });
  globalThis.fetch = async (url, options) => {
    assert.notEqual(options.method, 'HEAD');
    if (url === ARCHIVE_ENDPOINT) return json(archiveIndex());
    if (url === HISTORY_ENDPOINT) return json({ release: { versions: [] }, preview: { versions: [] } });
    throw Error('No package or individual metadata fetch expected');
  };
  const data = await service.refreshHistory(); assert.equal(data.versions.length, 4); assert.ok(data.versions.every(item => item.simulated && item.availability === 'simulated'));
  assert.equal((await service.verify('1.6.0.15')).availability, 'simulated');
  globalThis.fetch = async () => { throw Error('offline'); };
  assert.equal((await service.refreshHistory()).versions.length, 4);
  assert.equal(await fs.stat(path.join(dataDir, 'packages')).catch(() => null), null);
});

test('community metadata outage cannot gate installation of an authoritative Mojang latest package', async t => {
  const { service } = await serviceFor(t); const archive = await packageFixture(); let individualMetadataRequests = 0, heads = 0;
  globalThis.fetch = async (url, options) => {
    if (url === RELEASE_ENDPOINT) return json({ result: { links: [{ downloadType: 'serverBedrockLinux', downloadUrl: official('1.26.52.3') }] } });
    if (url === ARCHIVE_ENDPOINT) return json(archiveIndex(['1.26.52.3'], []));
    if (url === HISTORY_ENDPOINT) throw Error('Auxiliary catalog offline');
    if (String(url).startsWith(ARCHIVE_ROOT)) { individualMetadataRequests++; throw Error('Auxiliary metadata offline'); }
    assert.equal(url, official('1.26.52.3')); if (options.method === 'HEAD') heads++;
    return new Response(options.method === 'HEAD' ? null : archive, { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } });
  };
  const data = await service.refresh(); assert.equal(data.latest, '1.26.52.3'); assert.equal(data.versions[0].source, 'mojang'); assert.equal(data.versions[0].available, true);
  const installed = await service.ensure('1.26.52.3', 'stable'); assert.ok(installed.manifest.includes('bedrock_server')); assert.equal(individualMetadataRequests, 0); assert.equal(heads, 1);
});

test('previous catalog caches retain source coverage even before a new registry index is reachable', async t => {
  const { service, store } = await serviceFor(t);
  store.data.versions.push({ version: '1.21.62.01', channel: 'stable', historyKey: 'release/1.21.62', source: 'endstone', historical: true, url: official('1.21.62.01'), cached: true });
  let source = service.metadata().history.sources.find(item => item.id === 'endstone');
  assert.equal(source.loadedCount, 1); assert.equal(source.stableCount, 1); assert.equal(source.earliestStable, '1.21.62.01');
  globalThis.fetch = async () => { throw Error('provider unavailable'); };
  const data = await service.refreshHistory(); source = data.history.sources.find(item => item.id === 'endstone');
  assert.equal(source.loadedCount, 1); assert.equal(source.stableCount, 1); assert.equal(source.status, 'partial'); assert.equal(data.versions[0].availability, 'cached');
});

test('a late failed HEAD cannot resurrect CDN errors after an immutable package import', async t => {
  const { service, store, dataDir } = await serviceFor(t), version = '1.26.51.1';
  const item = { version, channel: 'stable', source: 'endstone', historical: true, url: official(version), transport: 'raknet', metadataStatus: 'ready' }; store.data.versions.push(item);
  const filename = path.join(dataDir, 'owned-runtime.zip'); await fs.writeFile(filename, await packageFixture('transport=nethernet\nserver-port=19132\nserver-portv6=19133\n'));
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
  globalThis.fetch = async (_url, options) => { assert.equal(options.method, 'HEAD'); entered(); await gate; return new Response(null, { status: 404 }); };
  const checking = service.verify(version); await requested;
  const imported = await service.importPackage(filename, version); assert.equal(imported, item); assert.equal(imported.transport, 'nethernet');
  release(); const result = await checking;
  assert.equal(result.available, true); assert.equal(result.availability, 'cached'); assert.equal(result.verificationError, null); assert.equal(result.metadataError, null); assert.equal(result.metadataStatus, 'ready');
  assert.equal(item.transport, 'nethernet'); assert.equal(item.source, 'import'); assert.equal(item.url, null); assert.equal(item.availability, 'cached');
  const fromCache = await service.ensure(version, 'stable'); assert.ok(fromCache.manifest.includes('bedrock_server'));
});

test('late legacy metadata failure and later registry refresh preserve imported runtime proof and transport', async t => {
  const { service, store, dataDir } = await serviceFor(t), version = '1.16.1.02';
  const item = archiveEntries(archiveIndex([version], []), validateDownloadUrl)[0]; store.data.versions.push(item);
  const filename = path.join(dataDir, 'owned-runtime.zip'); await fs.writeFile(filename, await packageFixture('transport=nethernet\n'));
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { entered = resolve; });
  globalThis.fetch = async url => { assert.ok(String(url).startsWith(ARCHIVE_ROOT)); entered(); await gate; throw Error('Late legacy provider outage'); };
  const checking = service.verify(version); await requested; await service.importPackage(filename, version); release();
  const result = await checking; assert.equal(result.metadataStatus, 'ready'); assert.equal(result.metadataError, null); assert.equal(result.verificationError, null); assert.equal(result.availability, 'cached');
  globalThis.fetch = async url => { if (url === ARCHIVE_ENDPOINT) return json(archiveIndex([version], [])); if (url === HISTORY_ENDPOINT) throw Error('History unavailable'); throw Error('No runtime download should occur'); };
  await service.refreshHistory();
  assert.equal(store.data.versions[0], item); assert.equal(item.transport, 'nethernet'); assert.equal(item.available, true); assert.equal(item.availability, 'cached'); assert.equal(item.source, 'import'); assert.equal(item.url, null); assert.equal(item.sha256, null); assert.equal(item.sha1, null);
});
