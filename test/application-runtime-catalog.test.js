import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationRuntimeCatalog, parseNodeReleases, parseNodeChecksum, parsePythonReleases, parsePythonSource, normalizeRuntimePin, publicRuntimePin } from '../server/application-runtime-catalog.js';
const SHA = 'a'.repeat(64), when = '2026-10-18T00:00:00.000Z';
const nodeIndex = JSON.stringify([{ version: 'v24.21.0', files: ['linux-x64'], lts: 'Krypton' }, { version: 'v27.0.0-rc.1', files: ['linux-x64'] }, { version: 'v26.12.0', files: ['linux-x64'], lts: false }]);
const listing = '<a href="/downloads/release/python-3160a1/">Python 3.16.0a1</a><a href="/downloads/release/python-3150/">Python 3.15.0</a><a href="/downloads/release/python-3148/">Python 3.14.8</a>';
const source = (version = '3.15.0', hash = SHA) => `<tr><td><a href="https://www.python.org/ftp/python/${version}/Python-${version}.tar.xz">XZ compressed source tarball</a></td><td><code class="checksum"><span class="checksum-half">${hash.slice(0, 16)}<wbr>${hash.slice(16, 32)}</span><wbr><span class="checksum-half">${hash.slice(32)}</span></code></td></tr>`;
const pin = () => ({ schema: 1, mode: 'managed', kind: 'nodejs', version: 'v26.12.0', platform: 'linux', arch: 'x64', method: 'official-binary', source: 'nodejs.org', url: 'https://nodejs.org/dist/v26.12.0/node-v26.12.0-linux-x64.tar.xz', sha256: SHA, resolvedAt: when });
test('official current Node selection is numerical stable, architecture-specific and independent from LTS', () => {
  assert.equal(parseNodeReleases(nodeIndex, 'x64')[0].version, 'v26.12.0');
  assert.throws(() => parseNodeReleases(nodeIndex, 'arm64'), { code: 'APPLICATION_RUNTIME_ARTIFACT_UNAVAILABLE' });
  for (const arch of ['x64', 'arm64']) for (const newest of [{ files: ['win-x64'] }, { files: null }, {}]) assert.throws(() => parseNodeReleases(JSON.stringify([{ version: 'v26.12.0', files: ['linux-x64', 'linux-arm64'] }, { version: 'v26.13.0', ...newest }]), arch), { code: 'APPLICATION_RUNTIME_ARTIFACT_UNAVAILABLE' });
  assert.throws(() => parseNodeReleases('[{}]', 'x64'));
  assert.throws(() => parseNodeReleases(JSON.stringify([{ version: 'v26.12.0', files: ['linux-x64'] }, { version: 'v26.12.0', files: ['linux-x64'] }]), 'x64'));
  assert.equal(parseNodeChecksum(`${SHA}  node-v26.12.0-linux-x64.tar.xz\n`, 'node-v26.12.0-linux-x64.tar.xz'), SHA);
  assert.throws(() => parseNodeChecksum(`${SHA}  node-v26.12.0-linux-x64.tar.xz\n${SHA} *node-v26.12.0-linux-x64.tar.xz`, 'node-v26.12.0-linux-x64.tar.xz'));
});
test('Python final release and source checksum come from the same official release row', () => {
  assert.equal(parsePythonReleases(listing)[0].version, '3.15.0');
  assert.equal(parsePythonSource(source(), '3.15.0').sha256, SHA);
  assert.throws(() => parsePythonSource(source().replace('www.python.org', 'attacker.invalid'), '3.15.0'));
  assert.throws(() => parsePythonSource(source() + source(), '3.15.0'));
  assert.throws(() => parsePythonSource(source('3.15.0', 'not-a-checksum'), '3.15.0'));
  assert.throws(() => parsePythonReleases('<a href="/downloads/release/python-9999/">Python 3.15.0</a>'));
});
test('persisted pins cannot override publisher, exact artifact, checksum, platform or architecture', () => {
  assert.equal(normalizeRuntimePin(pin(), { arch: 'x64' }).version, 'v26.12.0');
  for (const change of [{ url: 'https://attacker.invalid/runtime' }, { source: 'host' }, { method: 'shell' }, { sha256: SHA.slice(1) }, { arch: 'arm64' }, { version: 'v26.12.0-beta' }, { platform: 'win32' }, { resolvedAt: 'invalid' }]) assert.throws(() => normalizeRuntimePin({ ...pin(), ...change }, { arch: 'x64' }), { code: 'APPLICATION_RUNTIME_PIN' });
  assert.throws(() => normalizeRuntimePin(pin(), { arch: 'x64', kind: 'python' }));
  assert.equal(Object.hasOwn(publicRuntimePin(pin()), 'url'), false);
  assert.equal(Object.hasOwn(publicRuntimePin(pin()), 'sha256'), false);
});
test('every create resolves fresh official metadata; failure never falls back to cached or host', async () => {
  const calls = []; let fail = false;
  const catalog = createApplicationRuntimeCatalog({ platform: 'linux', arch: 'x64', now: () => new Date(when), fetch: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error'); if (fail) throw new Error('offline');
    const value = url.endsWith('index.json') ? nodeIndex : url.endsWith('SHASUMS256.txt') ? `${SHA}  node-v26.12.0-linux-x64.tar.xz` : url.endsWith('/downloads/') ? listing : source(); return new Response(value);
  } });
  assert.equal((await catalog.resolve('nodejs')).version, 'v26.12.0');
  assert.equal((await catalog.resolve('nodejs')).version, 'v26.12.0');
  assert.equal(calls.filter(url => url.endsWith('index.json')).length, 2);
  assert.equal((await catalog.resolve('python')).version, '3.15.0');
  assert.equal(catalog.snapshot().length, 2); fail = true;
  await assert.rejects(catalog.resolve('nodejs'), { code: 'APPLICATION_RUNTIME_CATALOG' });
  assert.equal(catalog.snapshot()[0].version, 'v26.12.0');
});
test('metadata byte bounds, HTTPS failures and foreign redirects fail closed', async () => {
  for (const fetch of [async () => new Response('x'.repeat(4 * 1024 ** 2 + 1)), async () => new Response('no', { status: 503 }), async () => { throw new Error('TLS rejected'); }, async () => ({ ok: true, url: 'https://attacker.invalid/', body: new Response(nodeIndex).body })]) {
    await assert.rejects(createApplicationRuntimeCatalog({ platform: 'linux', arch: 'x64', fetch }).resolve('nodejs'), { code: 'APPLICATION_RUNTIME_CATALOG' });
  }
});
