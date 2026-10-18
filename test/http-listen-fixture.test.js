import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { listenFetchSafeHttp } from './http-listen-fixture.js';

class Server extends EventEmitter {
  constructor(ports) { super(); this.ports = [...ports]; this.listening = false; this.calls = []; }
  listen(port, host, ready) {
    this.calls.push(['listen', port, host]);
    if (this.bindError) { queueMicrotask(() => this.emit('error', this.bindError)); return this; }
    this.listening = true; this.bound = this.ports.shift(); queueMicrotask(ready); return this;
  }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.bound }; }
  close(done) { assert.equal(this.listening, true); this.calls.push(['close', this.bound]); this.listening = false; queueMicrotask(() => done(this.closeError)); }
}

test('Fetch-blocked ephemeral candidate closes before a safe URL is exposed or authentication starts', async () => {
  const server = new Server([10080, 49152]);
  const port = await listenFetchSafeHttp(server);
  server.calls.push(['auth-request', port]);
  assert.equal(port, 49152);
  assert.deepEqual(server.calls, [['listen', 0, '127.0.0.1'], ['close', 10080], ['listen', 0, '127.0.0.1'], ['auth-request', 49152]]);
  assert.equal(server.listening, true);
  assert.equal(server.listenerCount('error'), 0);
});

test('eight blocked candidates fail closed with no HTTP requests and leave no selected listener', async () => {
  const server = new Server(Array(8).fill(10080));
  await assert.rejects(listenFetchSafeHttp(server), /exhausted eight blocked/);
  assert.equal(server.calls.filter(row => row[0] === 'listen').length, 8);
  assert.equal(server.calls.filter(row => row[0] === 'close').length, 8);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount('error'), 0);
});

test('safe fixed-port rebind is retained and existing listeners/bind errors are never closed or retried', async () => {
  const rebind = new Server([49152]);
  assert.equal(await listenFetchSafeHttp(rebind, 49152), 49152);
  assert.deepEqual(rebind.calls, [['listen', 49152, '127.0.0.1']]);
  const existing = new Server([]); existing.listening = true;
  await assert.rejects(listenFetchSafeHttp(existing), /already listening/);
  assert.deepEqual(existing.calls, []);
  const failed = new Server([]); failed.bindError = Object.assign(new Error('modeled occupied port'), { code: 'EADDRINUSE' });
  await assert.rejects(listenFetchSafeHttp(failed), { code: 'EADDRINUSE' });
  assert.deepEqual(failed.calls, [['listen', 0, '127.0.0.1']]);
  assert.equal(failed.listenerCount('error'), 0);
});
