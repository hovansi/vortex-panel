import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { Transform } from 'node:stream';

const problem = (message, status = 502, code = 'NODE_TRANSPORT_ERROR', extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const loopback = new Set(['127.0.0.1', '[::1]']);
export function validateNodeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || /[\s\\\x00-\x1f\x7f]/.test(value)) throw problem('Invalid node endpoint.', 400, 'NODE_ENDPOINT');
  let url;
  try { url = new URL(value); } catch { throw problem('Invalid node endpoint.', 400, 'NODE_ENDPOINT'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw problem('Node endpoint must be an HTTPS origin without credentials, path, query or fragment.', 400, 'NODE_ENDPOINT');
  // URL parsing canonicalizes exotic numeric IPv4 forms. Inspect the original
  // authority too: cleartext is permitted only for these two literal addresses.
  const authority = value.match(/^https?:\/\/([^/]+)\/?$/i)?.[1];
  if (!authority) throw problem('Node endpoint must contain only an origin.', 400, 'NODE_ENDPOINT');
  const literal = authority?.replace(/:\d+$/, '');
  if (url.protocol === 'http:' && (!loopback.has(url.hostname) || !loopback.has(literal))) throw problem('HTTP nodes are restricted to literal 127.0.0.1 or [::1].', 400, 'NODE_ENDPOINT');
  return url.origin;
}
export function normalizeFingerprint(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw problem('Invalid SHA-256 certificate fingerprint.', 400, 'NODE_FINGERPRINT');
  const normalized = value.trim().replace(/^sha256[:=]\s*/i, '').replaceAll(':', '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) throw problem('Use the exact SHA-256 certificate fingerprint (64 hexadecimal digits).', 400, 'NODE_FINGERPRINT');
  return normalized;
}

const forbiddenHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect']);
function prepareHeaders(input, token) {
  const result = {};
  for (const [name, value] of Object.entries(input || {})) {
    const lower = name.toLowerCase();
    if (forbiddenHeaders.has(lower)) continue;
    http.validateHeaderName(lower); http.validateHeaderValue(lower, value);
    result[lower] = value;
  }
  result.authorization = `Bearer ${token}`;
  result.connection = 'close';
  return result;
}
function connect(url, fingerprint, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const secure = url.protocol === 'https:';
    let settled = false;
    const socket = secure ? tls.connect({ host, port: Number(url.port || 443), servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !fingerprint, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] }) : net.connect({ host, port: Number(url.port || 80) });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.off('error', fail); };
    const fail = cause => { if (settled) return; settled = true; cleanup(); socket.destroy(); reject(cause?.status ? cause : problem('Unable to establish a trusted node connection.', 502, 'NODE_CONNECT', { cause })); };
    const abort = () => fail(problem('Node request was aborted.', 499, 'NODE_ABORTED'));
    const timer = setTimeout(() => fail(problem('Node connection timed out.', 504, 'NODE_TIMEOUT')), timeoutMs); timer.unref();
    socket.once('error', fail); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      if (settled) return;
      try {
        if (secure && fingerprint) {
          const raw = socket.getPeerCertificate(true)?.raw;
          if (!raw) throw problem('Node supplied no certificate.', 502, 'NODE_TLS_PIN');
          const expected = Buffer.from(fingerprint, 'hex'), actual = createHash('sha256').update(raw).digest();
          if (!timingSafeEqual(expected, actual)) throw problem('Node certificate fingerprint does not match. No credentials were sent.', 502, 'NODE_TLS_PIN');
          const cert = new X509Certificate(raw), now = Date.now();
          if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) throw problem('Pinned node certificate is not currently valid.', 502, 'NODE_TLS_PIN');
        } else if (secure && !socket.authorized) throw problem('Node certificate could not be verified.', 502, 'NODE_TLS_CA');
        settled = true; cleanup(); resolve(socket);
      } catch (error) { fail(error); }
    });
  });
}

export async function requestNode(node, { method = 'GET', path = '/api/node/identity', body, headers, stream = false, timeoutMs = 30000, idleTimeoutMs, maxBytes = stream ? 2 * 1024 ** 3 + 2 * 1024 ** 2 : 8 * 1024 ** 2, signal } = {}) {
  const endpoint = validateNodeEndpoint(node?.endpoint), fingerprint = normalizeFingerprint(node?.fingerprint);
  if (typeof node?.token !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(node.token)) throw problem('Invalid node credential.', 400, 'NODE_TOKEN');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method) || typeof path !== 'string' || !/^\/api(?:\/|\?|$)/.test(path) || path.length > 16384 || /[\\#\x00-\x20\x7f]/.test(path) || /(?:^|\/)\.{1,2}(?:\/|\?|$)/.test(path)) throw problem('Invalid node API request.', 400, 'NODE_PATH');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60 * 1000 || idleTimeoutMs !== undefined && (!stream || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 15 * 60 * 1000) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 ** 3) throw problem('Invalid node transport limits.', 400, 'NODE_LIMIT');
  const url = new URL(endpoint), started = Date.now();
  const socket = await connect(url, fingerprint, timeoutMs, signal);
  // No HTTP request object, application headers or body exists on the socket
  // until the preceding CA/pin handshake has completed. A one-use HTTP Agent
  // writes HTTP over this already-verified TLSSocket; it never opens a new one.
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  let outgoing, payload = body;
  const inputStream = body && typeof body.pipe === 'function' ? body : null;
  try {
    outgoing = prepareHeaders(headers, node.token);
    if (body !== undefined && !inputStream && !Buffer.isBuffer(body) && typeof body !== 'string') { payload = JSON.stringify(body); outgoing['content-type'] ||= 'application/json'; }
    if (payload !== undefined && !inputStream) outgoing['content-length'] = Buffer.byteLength(payload);
  } catch (cause) { agent.destroy(); socket.destroy(); throw problem('Invalid node request body or headers.', 400, 'NODE_REQUEST', { cause }); }
  return new Promise((resolve, reject) => {
    let settled = false, failed = false, response, output, timer, sent = 0;
    const request = http.request({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), method, path, headers: outgoing, agent });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); inputStream?.off('data', activity); };
    const terminate = error => { cleanup(); inputStream?.unpipe(request); request.destroy(); response?.destroy(); agent.destroy(); socket.destroy(); if (output && !output.destroyed) output.destroy(error); };
    const fail = cause => { if (failed) return; failed = true; const error = cause?.status ? cause : problem('Node request failed.', 502, 'NODE_CONNECTION', { cause }); if (!settled) { settled = true; reject(error); } terminate(error); };
    const abort = () => fail(problem('Node request was aborted.', 499, 'NODE_ABORTED'));
    const expired = () => fail(problem(idleTimeoutMs === undefined ? 'Node request timed out.' : 'Node transfer timed out while idle.', 504, 'NODE_TIMEOUT'));
    // Only opted-in byte streams renew their deadline. Connection/TLS still
    // has its original bound, and ordinary RPCs retain a total deadline.
    const activity = () => { if (idleTimeoutMs === undefined || failed) return; clearTimeout(timer); timer = setTimeout(expired, idleTimeoutMs); timer.unref(); };
    if (idleTimeoutMs === undefined) { timer = setTimeout(expired, Math.max(1, timeoutMs - (Date.now() - started))); timer.unref(); }
    else activity();
    signal?.addEventListener('abort', abort, { once: true });
    request.on('error', fail); inputStream?.once('error', fail);
    if (signal?.aborted) return abort();
    request.once('response', incoming => {
      response = incoming;
      activity();
      // Redirects are never followed; in streaming mode the original response
      // remains available to the proxy, without sending credentials elsewhere.
      const limit = Number(incoming.headers['content-length']);
      if (Number.isFinite(limit) && limit > maxBytes) return fail(problem('Node response exceeds the configured byte limit.', 502, 'NODE_RESPONSE_LIMIT'));
      if (stream) {
        output = new Transform({ transform(chunk, _encoding, callback) { activity(); sent += chunk.length; callback(sent > maxBytes ? problem('Node response exceeds the configured byte limit.', 502, 'NODE_RESPONSE_LIMIT') : null, chunk); } });
        output.once('error', fail);
        output.once('close', () => { cleanup(); if (!incoming.complete) request.destroy(); incoming.destroy(); agent.destroy(); });
        incoming.once('error', fail); incoming.once('aborted', () => fail(problem('Node response was interrupted.', 502, 'NODE_TRUNCATED')));
        settled = true; resolve({ status: incoming.statusCode, statusCode: incoming.statusCode, headers: incoming.headers, stream: output }); incoming.pipe(output); return;
      }
      const chunks = [];
      incoming.on('data', chunk => { sent += chunk.length; if (sent > maxBytes) fail(problem('Node response exceeds the configured byte limit.', 502, 'NODE_RESPONSE_LIMIT')); else chunks.push(chunk); });
      incoming.once('error', fail); incoming.once('aborted', () => fail(problem('Node response was interrupted.', 502, 'NODE_TRUNCATED')));
      incoming.once('end', () => {
        if (settled) return;
        cleanup(); agent.destroy();
        let data;
        try { data = sent ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; }
        catch { return fail(problem('Node returned invalid JSON.', 502, 'NODE_INVALID_JSON')); }
        if (incoming.statusCode < 200 || incoming.statusCode >= 300) return fail(problem(typeof data?.error === 'string' ? data.error : 'Node rejected the request.', incoming.statusCode, 'NODE_HTTP_ERROR', { body: data, httpStatus: incoming.statusCode }));
        settled = true; resolve(data);
      });
    });
    if (inputStream) { if (idleTimeoutMs !== undefined) inputStream.on('data', activity); inputStream.pipe(request); }
    else request.end(payload);
  });
}
