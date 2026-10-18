import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseListeners, collectDiagnostics } from '../server/diagnostics.js';
import { getHostInfo } from '../server/host.js';

test('host listener parsing preserves protocols and IPv6 while bounding response size', () => {
  const records = parseListeners('udp UNCONN 0 0 0.0.0.0:19134 0.0.0.0:*\ntcp LISTEN 0 128 [::]:3000 [::]:*\ntcp LISTEN 0 128 127.0.0.1:19132 0.0.0.0:*\ninvalid line\ntcp LISTEN 0 128 *:99999 *:*');
  assert.deepEqual(records, [{ protocol: 'tcp', address: '::', port: 3000 }, { protocol: 'tcp', address: '127.0.0.1', port: 19132 }, { protocol: 'udp', address: '0.0.0.0', port: 19134 }]);
  assert.equal(parseListeners('udp UNCONN 0 0 *:19134 *:*\n'.repeat(300)).length, 128);
});

test('host diagnostics reports capability evidence without exposing command arguments or environment', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-host-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const data = await collectDiagnostics({ dataDir, host: await getHostInfo(dataDir) });
  assert.equal(data.demo, false);
  assert.ok(data.checks.some(check => check.id === 'node' && check.status === 'ok'));
  assert.ok(data.checks.some(check => check.id === 'data' && check.status === 'ok'));
  assert.ok(data.panel.memoryMB > 0);
  assert.equal(data.storage.dataDir, path.resolve(dataDir));
  for (const record of data.processes) { assert.equal('argv' in record, false); assert.equal('env' in record, false); }
  const demo = await collectDiagnostics({ dataDir, demo: true, host: {} });
  assert.equal(demo.demo, true);
  assert.ok(demo.checks.every(check => check.message.includes('DEMO') || check.id === 'access'));
});
