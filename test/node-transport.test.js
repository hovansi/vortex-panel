import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { Readable } from 'node:stream';
import { requestNode, validateNodeEndpoint, normalizeFingerprint } from '../server/node-transport.js';

const token = 'A'.repeat(43);
async function listen(t, server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })); return `http${server instanceof https.Server ? 's' : ''}://127.0.0.1:${server.address().port}`; }
async function certificate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-tls-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = process.platform === 'win32' && syncFs.existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
  execFileSync(executable, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=Vortex test fixture', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore', windowsHide: true });
  const key = await fs.readFile(path.join(directory, 'key.pem')), cert = await fs.readFile(path.join(directory, 'cert.pem'));
  return { key, cert, fingerprint: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex').toUpperCase() };
}

test('node endpoints reject credentials, paths, redirects and nonliteral HTTP; pins normalize strictly', () => {
  assert.equal(validateNodeEndpoint('https://EXAMPLE.com:8443/'), 'https://example.com:8443');
  assert.equal(validateNodeEndpoint('http://127.0.0.1:8443'), 'http://127.0.0.1:8443');
  assert.equal(validateNodeEndpoint('http://[::1]:8443'), 'http://[::1]:8443');
  for (const url of ['http://localhost:8443', 'http://127.1', 'http://0x7f000001', 'http://10.0.0.1', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/%2e%2e', 'https://example.com/a/..', 'https://example.com?x=1', 'https://example.com#x', 'https://example.com\\evil', 'file:///tmp/x']) assert.throws(() => validateNodeEndpoint(url), { status: 400 });
  assert.equal(normalizeFingerprint('SHA256:' + 'ab:'.repeat(31) + 'ab'), 'AB'.repeat(32));
  assert.equal(normalizeFingerprint(null), null);
  assert.throws(() => normalizeFingerprint('abc'), { status: 400 });
});

test('exact TLS pin permits JSON while self-signed CA mode/wrong pin send zero HTTP bytes and never consume upload', async t => {
  const cert = await certificate(t); let requests = 0, receivedAuth;
  const server = https.createServer(cert, (req, res) => { requests++; receivedAuth = req.headers.authorization; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
  const endpoint = await listen(t, server), node = { endpoint, token, fingerprint: cert.fingerprint };
  assert.deepEqual(await requestNode(node), { ok: true }); assert.equal(receivedAuth, `Bearer ${token}`);
  let read = 0; const upload = new Readable({ read() { read++; this.push('secret-body'); this.push(null); } });
  await assert.rejects(requestNode({ ...node, fingerprint: '00'.repeat(32) }, { method: 'POST', body: upload }), { code: 'NODE_TLS_PIN' });
  await assert.rejects(requestNode({ ...node, fingerprint: null }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests, 1); assert.equal(read, 0);
});

test('raw TLS observer receives zero application bytes before rejected pin', async t => {
  const cert = await certificate(t); let bytes = 0;
  const server = tls.createServer(cert, socket => socket.on('data', chunk => { bytes += chunk.length; }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(requestNode({ endpoint: `https://127.0.0.1:${server.address().port}`, token, fingerprint: 'FF'.repeat(32) }), { code: 'NODE_TLS_PIN' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(bytes, 0);
});

test('stream upload/download retain bytes and safe headers; caller credential spoofing and redirects are not forwarded', async t => {
  const payload = Buffer.alloc(256 * 1024, 0x7a); let captured, redirected = 0;
  const target = http.createServer((_req, res) => { redirected++; res.end('{}'); }); const targetUrl = await listen(t, target);
  const server = http.createServer((req, res) => {
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: targetUrl + '/api/stolen' }); res.end('{"error":"redirect forbidden"}'); return; }
    captured = req.headers; const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Vortex-Node-Id': 'fixture-node', 'Content-Length': Buffer.concat(chunks).length }); res.end(Buffer.concat(chunks)); });
  }); const endpoint = await listen(t, server);
  const response = await requestNode({ endpoint, token }, { method: 'POST', path: '/api/upload', body: Readable.from([payload]), headers: { Authorization: 'forged', Cookie: 'private=client', 'Content-Type': 'application/octet-stream', 'X-Vortex-Actor': 'trusted' }, stream: true });
  const chunks = []; for await (const chunk of response.stream) chunks.push(chunk);
  assert.equal(response.statusCode, 200); assert.equal(response.headers['x-vortex-node-id'], 'fixture-node'); assert.deepEqual(Buffer.concat(chunks), payload);
  assert.equal(captured.authorization, `Bearer ${token}`); assert.equal(captured.cookie, undefined); assert.equal(captured['x-vortex-actor'], 'trusted');
  await assert.rejects(requestNode({ endpoint, token }, { path: '/api/redirect' }), { status: 302, code: 'NODE_HTTP_ERROR' }); assert.equal(redirected, 0);
});

test('bounded JSON/streams reject oversize, malformed and truncated responses; deadlines and caller abort close requests', async t => {
  let aborted = 0;
  const server = http.createServer((req, res) => {
    res.on('close', () => { aborted++; });
    if (req.url === '/api/big') { res.end(JSON.stringify({ content: 'x'.repeat(5000) })); return; }
    if (req.url === '/api/invalid') { res.end('not-json'); return; }
    if (req.url === '/api/truncated') { res.writeHead(200, { 'content-length': '5000' }); res.flushHeaders(); res.write('{}'); setTimeout(() => res.destroy(), 10); return; }
    if (req.url === '/api/stream') { res.writeHead(200); res.write('start'); return; }
  }); const endpoint = await listen(t, server), node = { endpoint, token };
  await assert.rejects(requestNode(node, { path: '/api/big', maxBytes: 100 }), { code: 'NODE_RESPONSE_LIMIT' });
  await assert.rejects(requestNode(node, { path: '/api/invalid' }), { code: 'NODE_INVALID_JSON' });
  await assert.rejects(requestNode(node, { path: '/api/truncated' }), { code: 'NODE_TRUNCATED' });
  await assert.rejects(requestNode(node, { path: '/api/slow', timeoutMs: 30 }), { status: 504, code: 'NODE_TIMEOUT' });
  const aborter = new AbortController(); const response = await requestNode(node, { path: '/api/stream', stream: true, signal: aborter.signal });
  const consumed = (async () => { for await (const _chunk of response.stream) {} })(); aborter.abort(); await assert.rejects(consumed, { code: 'NODE_ABORTED' });
  assert.ok(aborted >= 4);
});
