import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { lookupHostLocation, createHostLocation, HOST_LOCATION_PROVIDER, HOST_LOCATION_FALLBACK } from '../server/host-location.js';

const primary = { success: true, ip: '203.0.113.5', country_code: 'US', country: 'United States', region: 'California', city: 'Los Angeles', timezone: { id: 'America/Los_Angeles' } };
const fallback = { ipAddress: '2001:db8::5', countryCode: 'DE', countryName: 'Germany', cityName: 'Berlin', regionName: 'Berlin', timeZones: ['Europe/Berlin', 'Other/Fixture'] };
function peer(replies, observations = []) {
  return (url, options, callback) => {
    observations.push({ url, options });
    const request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
    const reply = replies[observations.length - 1];
    queueMicrotask(() => {
      if (reply?.error) { request.emit('error', new Error(reply.error)); return; }
      if (reply?.hang) return;
      const response = reply?.stream || Readable.from([Buffer.from(reply?.raw ?? JSON.stringify(reply?.body ?? {}))]);
      response.statusCode = reply?.status ?? 200; response.headers = reply?.headers || {};
      callback(response);
    });
    return request;
  };
}

test('healthy primary has one fixed HTTPS request, retains source and sends no private or queried host fields', async () => {
  const observations = [], result = await lookupHostLocation({ get: peer([{ body: primary }], observations) });
  assert.equal(result.label, 'Los Angeles, California, United States'); assert.equal(result.source, 'ipwho.is');
  assert.deepEqual(result.providersTried, ['ipwho.is']); assert.equal(result.timezone, 'America/Los_Angeles');
  assert.equal(observations.length, 1); assert.equal(observations[0].url, HOST_LOCATION_PROVIDER);
  assert.deepEqual(Object.keys(observations[0].options.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(new URL(observations[0].url).protocol, 'https:'); assert.equal(new URL(observations[0].url).searchParams.has('ip'), false);
});

test('failed primary falls back once and validates the independent schema without guessing a timezone', async () => {
  for (const first of [{ error: 'private DNS transport information' }, { status: 503 }, { body: { success: false } }, { raw: 'malformed' }]) {
    const observations = [], value = await lookupHostLocation({ get: peer([first, { body: fallback }], observations) });
    assert.deepEqual(observations.map(row => row.url), [HOST_LOCATION_PROVIDER, HOST_LOCATION_FALLBACK]);
    assert.equal(value.status, 'known'); assert.equal(value.source, 'freeipapi.com'); assert.equal(value.publicAddress, '2001:db8::5');
    assert.equal(value.label, 'Berlin, Germany'); assert.equal(value.timezone, '');
    assert.deepEqual(value.providersTried, ['ipwho.is', 'freeipapi.com']); assert.equal(JSON.stringify(value).includes('private'), false);
  }
});

test('redirect, error and oversized responses never follow a supplied address or become a guessed location', async () => {
  const observations = [];
  await assert.rejects(lookupHostLocation({ get: peer([{ status: 302, headers: { location: 'http://127.0.0.1/private' } }, { raw: 'x'.repeat(500) }], observations), maxBytes: 32 }), error => {
    assert.equal(error.reason, 'providers-unavailable'); assert.deepEqual(error.attempts, [{ source: 'ipwho.is', reason: 'http' }, { source: 'freeipapi.com', reason: 'response-too-large' }]); return true;
  });
  assert.deepEqual(observations.map(row => row.url), [HOST_LOCATION_PROVIDER, HOST_LOCATION_FALLBACK]);
});

test('both timeout paths are bounded, destroy their requests and expose only safe diagnostics', async t => {
  const keepAlive = setTimeout(() => {}, 500); t.after(() => clearTimeout(keepAlive));
  const requests = [], get = () => { const request = new EventEmitter(); request.destroy = () => { request.destroyed = true; }; requests.push(request); return request; };
  const start = performance.now();
  await assert.rejects(lookupHostLocation({ timeoutMs: 10, get }), error => error.reason === 'providers-unavailable' && error.attempts.every(row => row.reason === 'timeout'));
  assert.equal(requests.length, 2); assert.ok(requests.every(row => row.destroyed)); assert.ok(performance.now() - start < 400);
});

test('a truncated response falls back instead of waiting for the full timeout', async () => {
  const stream = new PassThrough(), observations = [];
  const promise = lookupHostLocation({ timeoutMs: 1000, get: peer([{ stream }, { body: fallback }], observations) });
  queueMicrotask(() => { stream.write('{"success":'); stream.destroy(); });
  assert.equal((await promise).source, 'freeipapi.com'); assert.equal(observations.length, 2);
});

test('invalid IP/country/schema from either provider is rejected and a valid country-only estimate remains honest', async () => {
  for (const body of [{ ...fallback, ipAddress: 'not-an-IP' }, { ...fallback, countryCode: 'INVALID' }, { ...fallback, countryCode: ['DE'] }, { ...fallback, countryName: '\nprivate' }, { ...fallback, error: true }, []]) {
    await assert.rejects(lookupHostLocation({ get: peer([{ body: { ...primary, ip: 'invalid' } }, { body }]) }));
  }
  const country = await lookupHostLocation({ get: peer([{ status: 503 }, { body: { ...fallback, cityName: null, regionName: null } }]) });
  assert.equal(country.label, 'Germany'); assert.equal(country.approximate, true);
});

test('first failure retries after one minute, then bounded backoff, without delaying or duplicating dashboard reads', async () => {
  let at = 0, calls = 0;
  const location = createHostLocation({ now: () => at, enabled: true, lookup: async () => { calls++; throw new Error('secret provider details'); } });
  assert.equal(location.snapshot().status, 'pending'); location.snapshot(); location.snapshot();
  let result = await location.settled(); assert.equal(calls, 1); assert.equal(result.status, 'unavailable'); assert.equal(result.label, ''); assert.equal(result.failureReason, 'lookup-failed');
  for (const delay of [60_000, 300_000, 900_000, 3_600_000, 3_600_000]) {
    assert.equal(Date.parse(result.nextRetryAt) - at, delay); at += delay - 1; location.snapshot(); await location.settled();
    const before = calls; at++; location.snapshot(); result = await location.settled(); assert.equal(calls, before + 1);
  }
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('refresh failure preserves the exact last good source/time/IP and marks it stale until a successful recovery', async () => {
  let at = 0, fail = false;
  const known = { status: 'known', source: 'ipwho.is', label: 'Fixture, United States', publicAddress: '203.0.113.8', providersTried: ['ipwho.is'] };
  const location = createHostLocation({ now: () => at, enabled: true, ttlMs: 100, lookup: async () => { if (fail) throw new Error('unavailable'); return known; } });
  location.snapshot(); const original = await location.settled(); fail = true; at = 101;
  assert.equal(location.snapshot().stale, true); const stale = await location.settled();
  for (const key of ['status', 'label', 'source', 'detectedAt', 'publicAddress']) assert.equal(stale[key], original[key]);
  assert.equal(stale.stale, true); assert.equal(stale.refreshStatus, 'unavailable'); assert.equal(Date.parse(stale.nextRetryAt), 60_101);
  stale.providersTried.push('modified caller'); assert.deepEqual(location.snapshot().providersTried, ['ipwho.is']);
  at = 60_101; fail = false; location.snapshot(); const recovered = await location.settled();
  assert.equal(recovered.stale, false); assert.equal(recovered.refreshStatus, 'idle'); assert.equal(recovered.nextRetryAt, null); assert.notEqual(recovered.detectedAt, original.detectedAt);
});

test('successful recovery resets fast retry, while explicit opt-out makes no external calls', async () => {
  let at = 0, calls = 0, fail = true;
  const location = createHostLocation({ enabled: true, now: () => at, ttlMs: 10, lookup: async () => { calls++; if (fail) throw Error('fail'); return { status: 'known', label: 'Country' }; } });
  location.snapshot(); await location.settled(); at = 60_000; fail = false; location.snapshot(); await location.settled();
  at += 11; fail = true; location.snapshot(); const result = await location.settled(); assert.equal(Date.parse(result.nextRetryAt) - at, 60_000);
  const disabled = createHostLocation({ enabled: false, lookup: () => { calls++; throw Error('must not call'); } });
  const before = calls; assert.equal(disabled.snapshot().status, 'disabled'); assert.equal((await disabled.settled()).label, ''); assert.equal(calls, before);
});

test('invalid options and malformed custom lookup cannot become known metadata', async () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 1e9 }, { maxBytes: 1e9 }]) await assert.rejects(lookupHostLocation({ ...options, get: () => assert.fail('must not request') }));
  const location = createHostLocation({ enabled: true, lookup: async () => ({ status: 'known', label: '' }) });
  location.snapshot(); const result = await location.settled(); assert.equal(result.status, 'unavailable'); assert.equal(result.failureReason, 'invalid-response');
});
