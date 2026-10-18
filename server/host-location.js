import https from 'node:https';
import { isIP } from 'node:net';

export const HOST_LOCATION_PROVIDER = 'https://ipwho.is/?fields=success,ip,country,country_code,region,city,timezone.id';
export const HOST_LOCATION_FALLBACK = 'https://free.freeipapi.com/api/v1/json';
const PROVIDERS = Object.freeze([
  { source: 'ipwho.is', url: HOST_LOCATION_PROVIDER },
  { source: 'freeipapi.com', url: HOST_LOCATION_FALLBACK },
]);
const DAY = 24 * 60 * 60 * 1000;
const RETRIES = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const clean = value => typeof value === 'string' && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
const failure = reason => Object.assign(new Error('location-' + reason), { reason });

function normalize(row, source) {
  const primary = source === 'ipwho.is';
  const code = primary ? row?.country_code : row?.countryCode;
  const country = clean(primary ? row?.country : row?.countryName);
  const address = primary ? row?.ip : row?.ipAddress;
  if (!row || Array.isArray(row) || (primary ? row.success !== true : row.error === true)
    || !isIP(typeof address === 'string' ? address : '') || typeof code !== 'string' || !/^[A-Z]{2}$/.test(code) || !country) throw failure('invalid-response');
  const city = clean(primary ? row.city : row.cityName), region = clean(primary ? row.region : row.regionName);
  return { status: 'known', source, approximate: true, publicAddress: address,
    label: [...new Set([city, region, country].filter(Boolean))].join(', '), countryCode: code,
    // FreeIPAPI lists every timezone in the country, not the IP's timezone.
    country, region, city, timezone: clean(primary ? row.timezone?.id : null) };
}

function requestLocation(provider, { timeoutMs, maxBytes, get }) {
  return new Promise((resolve, reject) => {
    let settled = false, request, response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { response?.destroy(); request?.destroy(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(failure('timeout')), timeoutMs);
    timer.unref?.();
    try {
      request = get(provider.url, { headers: { Accept: 'application/json', 'User-Agent': 'VortexPanel-HostLocation/1' } }, incoming => {
        response = incoming;
        response.once('error', () => finish(failure('network')));
        response.once('aborted', () => finish(failure('network')));
        if (response.statusCode !== 200) { finish(failure('http')); return; }
        let size = 0, ended = false; const chunks = [];
        response.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) finish(failure('response-too-large')); else chunks.push(chunk);
        });
        response.once('close', () => { if (!ended) finish(failure('network')); });
        response.once('end', () => {
          ended = true;
          if (settled) return;
          try { finish(null, normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')), provider.source)); }
          catch { finish(failure('invalid-response')); }
        });
      });
      request.once('error', () => finish(failure('network')));
    } catch { finish(failure('network')); }
  });
}

// Only fixed HTTPS providers observe this host's egress IP. No supplied URL,
// queried address, account, token or hostname is sent. No redirect is followed.
// Fallback is sequential, so a healthy primary creates just one request.
export async function lookupHostLocation({ timeoutMs = 2500, maxBytes = 32768, get = https.get } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) throw failure('invalid-options');
  const attempts = [];
  for (const provider of PROVIDERS) {
    try {
      const value = await requestLocation(provider, { timeoutMs, maxBytes, get });
      return { ...value, providersTried: [...attempts.map(row => row.source), provider.source] };
    } catch (error) {
      attempts.push({ source: provider.source, reason: ['timeout', 'http', 'network', 'invalid-response', 'response-too-large'].includes(error.reason) ? error.reason : 'network' });
    }
  }
  throw Object.assign(failure('providers-unavailable'), { attempts });
}

export function createHostLocation({ enabled = process.env.VORTEX_GEOLOCATION !== 'off', lookup = lookupHostLocation, now = Date.now, ttlMs = DAY, retryMs } = {}) {
  let value = { status: enabled ? 'pending' : 'disabled', source: null, approximate: true, label: '', detectedAt: null, stale: false, refreshStatus: enabled ? 'pending' : 'disabled', lastAttemptAt: null, nextRetryAt: null, failureReason: null };
  let refreshAt = 0, flight, failures = 0;
  const copy = () => ({ ...value, ...(value.providersTried ? { providersTried: [...value.providersTried] } : {}) });
  function snapshot() {
    if (enabled && now() >= refreshAt && !flight) {
      // A background observation must never delay a console/dashboard request.
      const attemptedAt = new Date(now()).toISOString();
      flight = Promise.resolve().then(lookup).then(result => {
        if (result?.status !== 'known' || typeof result.label !== 'string' || !result.label.trim()) throw failure('invalid-response');
        failures = 0;
        value = { ...result, detectedAt: new Date(now()).toISOString(), stale: false, refreshStatus: 'idle', lastAttemptAt: attemptedAt, nextRetryAt: null, failureReason: null };
        refreshAt = now() + ttlMs;
      }).catch(error => {
        const delay = retryMs ?? RETRIES[Math.min(failures++, RETRIES.length - 1)];
        refreshAt = now() + delay;
        // A temporary provider failure does not erase a successful estimate.
        // Its original provider/time/IP remain, explicitly marked stale.
        const reason = ['providers-unavailable', 'invalid-response'].includes(error?.reason) ? error.reason : 'lookup-failed';
        value = { ...value, status: value.status === 'known' ? 'known' : 'unavailable', stale: value.status === 'known', refreshStatus: 'unavailable', lastAttemptAt: attemptedAt, nextRetryAt: new Date(refreshAt).toISOString(), failureReason: reason };
      }).finally(() => { flight = null; });
    }
    return { ...copy(), ...(enabled && value.status === 'known' && now() >= refreshAt ? { stale: true } : {}) };
  }
  return { snapshot, async settled() { await flight; return copy(); } };
}
