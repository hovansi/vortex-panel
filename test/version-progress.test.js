import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomBytes } from 'node:crypto';
import archiver from 'archiver';
import { createVersionService } from '../server/versions.js';
import { updateJobProgress } from '../server/job-progress.js';

const version = '1.26.52.3', channel = 'stable';
const official = `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${version}.zip`;
async function packageFixture() {
  const zip = archiver('zip'), chunks = [];
  zip.on('data', chunk => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { zip.on('end', resolve); zip.on('error', reject); });
  const elf = Buffer.alloc(4096); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
  zip.append(elf, { name: 'bedrock_server' });
  zip.append('server-port=19132\nserver-portv6=19133\n', { name: 'server.properties' });
  zip.append(randomBytes(32768), { name: 'padding.bin' });
  await zip.finalize(); await done; return Buffer.concat(chunks);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-version-progress-'));
  const archive = await packageFixture(), item = { version, channel, url: official, available: true, sha256: createHash('sha256').update(archive).digest('hex') };
  const store = { data: { versions: [item], settings: {} }, save() {}, audit() {} };
  const originalFetch = globalThis.fetch, service = createVersionService({ store, dataDir: root, demo: false, emit() {} });
  t.after(async () => { service.close(); globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); });
  return { root, service, archive, item, store };
}
async function until(condition, label) {
  const start = Date.now();
  while (!condition()) { if (Date.now() - start > 5000) assert.fail(`Timed out waiting for ${label}`); await delay(5); }
}
const snapshot = (value, details) => ({ value, details: structuredClone(details) });

test('concurrent ensure consumers share one actual gated byte stream and late subscribers replay measured partial progress', { timeout: 10000 }, async t => {
  const { service, archive, item } = await fixture(t);
  let controller, gets = 0;
  globalThis.fetch = async url => {
    assert.equal(url, official); gets++;
    return new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } });
  };
  const firstEvents = [], secondEvents = [], workflow = { status: 'running', progress: 5 };
  const first = service.ensure(version, channel, (value, details) => {
    firstEvents.push(snapshot(value, details));
    updateJobProgress(workflow, value, details.phase, { phase: details.phase, ...(details.phase === 'download' ? { transfer: details } : {}) });
  });
  let second, throwing;
  try {
    await until(() => controller && firstEvents.some(event => event.details.phase === 'download'), 'download start');
    await delay(150); // Cross the documented publisher throttle using real time.
    const cut = Math.floor(archive.length / 2); controller.enqueue(archive.subarray(0, cut));
    await until(() => firstEvents.some(event => event.details.loadedBytes === cut), 'actual first-half progress');
    const partial = firstEvents.at(-1);
    assert.equal(partial.details.totalBytes, archive.length); assert.equal(partial.details.percent, Math.floor(cut / archive.length * 100));
    assert.equal(item.cached, undefined); assert.ok(workflow.progress < 100); assert.equal(workflow.transfer.loadedBytes, cut);
    second = service.ensure(version, channel, (value, details) => secondEvents.push(snapshot(value, details)));
    assert.deepEqual(secondEvents[0], partial);
    throwing = service.ensure(version, channel, () => { throw Error('Optional late observer failed'); });
    await delay(150); controller.enqueue(archive.subarray(cut)); controller.close();
    const results = await Promise.all([first, second, throwing]);
    assert.equal(gets, 1); assert.ok(results.every(result => result.directory === results[0].directory && result.manifest.includes('bedrock_server')));
    const firstDownload = firstEvents.filter(event => event.details.phase === 'download'), secondDownload = secondEvents.filter(event => event.details.phase === 'download');
    assert.equal(firstDownload[0].details.loadedBytes, 0);
    assert.deepEqual(secondDownload.at(-1).details, firstDownload.at(-1).details);
    assert.equal(firstDownload.at(-1).details.loadedBytes, archive.length); assert.equal(firstDownload.at(-1).details.percent, 100);
    assert.ok(firstEvents.every(event => event.value < 100)); assert.ok(secondEvents.every(event => event.value < 100)); assert.ok(workflow.progress < 100);
    assert.equal(workflow.transfer, undefined); assert.equal(item.cached, true);
    assert.equal(await fs.readFile(path.join(results[0].directory, 'server.properties'), 'utf8'), 'server-port=19132\nserver-portv6=19133\n');
  } finally {
    try { controller?.close(); } catch {}
    await Promise.allSettled([first, second, throwing].filter(Boolean));
  }
});

test('unknown Content-Length retains measured bytes with indeterminate percent and no fabricated completed workflow', async t => {
  const { service, archive } = await fixture(t), events = [];
  globalThis.fetch = async url => { assert.equal(url, official); return new Response(archive, { headers: { 'content-type': 'application/zip' } }); };
  const result = await service.ensure(version, channel, (value, details) => events.push(snapshot(value, details)));
  const download = events.filter(event => event.details.phase === 'download');
  assert.ok(download.length >= 2); assert.ok(download.every(event => event.details.totalBytes === null && event.details.percent === null));
  assert.equal(download[0].details.loadedBytes, 0); assert.equal(download.at(-1).details.loadedBytes, archive.length);
  assert.ok(events.every(event => event.value < 100)); assert.ok(result.manifest.includes('bedrock_server'));
});

test('a throwing cache-hit progress observer cannot abort an already validated immutable package', async t => {
  const { service, archive } = await fixture(t);
  globalThis.fetch = async url => { assert.equal(url, official); return new Response(archive, { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } }); };
  const first = await service.ensure(version, channel);
  globalThis.fetch = async () => { assert.fail('A cache hit must not redownload the package'); };
  const cached = await service.ensure(version, channel, () => { throw Error('Optional cache observer failed'); });
  assert.equal(cached.directory, first.directory); assert.ok(cached.manifest.includes('bedrock_server'));
});

test('receiving all download bytes can report transfer100 while checksum failure never reports workflow success or activates a package', async t => {
  const { service, archive, root, item } = await fixture(t), events = [], workflow = { status: 'running', progress: 0 };
  item.sha256 = '0'.repeat(64);
  globalThis.fetch = async () => new Response(archive, { headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) } });
  await assert.rejects(service.ensure(version, channel, (value, details) => {
    events.push(snapshot(value, details));
    updateJobProgress(workflow, value, details.phase, { phase: details.phase, ...(details.phase === 'download' ? { transfer: details } : {}) });
  }), /SHA-256/);
  const transfer = events.filter(event => event.details.phase === 'download').at(-1);
  assert.equal(transfer.details.loadedBytes, archive.length); assert.equal(transfer.details.percent, 100);
  assert.ok(events.every(event => event.value < 100)); assert.ok(workflow.progress < 100); assert.equal(item.cached, undefined);
  assert.deepEqual(await fs.readdir(path.join(root, 'packages')), []);
});
