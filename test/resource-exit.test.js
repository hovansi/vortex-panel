import test from 'node:test';
import assert from 'node:assert/strict';
import { recordResourceExit, MEMORY_LIMIT_EXIT_MESSAGE, memoryLimitExitMessage } from '../server/resource-exit.js';
import { translatePanelMessage, localizeApiResponse } from '../server/locale.js';

test('bounded historical exit retains verified OOM counters without claiming live usage/enforcement', () => {
  const policy = { mode: 'fixed', cpuCores: 0.2, memoryMiB: 256 }, stats = { memoryCurrentBytes: 0, memoryPeakBytes: 268435456, cpuUsageUsec: 999, nrThrottled: 40, throttledUsec: 456, oomKills: 2, oomEvents: 1, memoryMaxEvents: 22, effective: { kernelEnforced: true }, unexpected: 'x'.repeat(100000) };
  const sample = recordResourceExit({ policy, stats, pid: 1234, code: null, signal: 'SIGKILL', time: '2026-10-14T13:00:00.000Z' });
  assert.equal(sample.reason, 'memory-limit'); assert.equal(sample.usage.oomKills, 2); assert.equal(sample.kernelEnforcedAtExit, true); assert.equal(sample.pid, 1234); assert.equal(sample.signal, 'SIGKILL'); assert.ok(Buffer.byteLength(JSON.stringify(sample)) < 1000); assert.ok(!Object.hasOwn(sample.usage, 'unexpected'));
  stats.oomKills = 0; assert.equal(sample.usage.oomKills, 2); assert.equal(recordResourceExit({ policy, stats, pid: 1, signal: 'SIGKILL' }).reason, 'native-exit');
  assert.equal(recordResourceExit({ policy: { mode: 'shared' }, stats, pid: 1 }), null);
});

test('malformed counters are bounded/unconfirmed and memory-limit reason is localized without altering historical sample', () => {
  const sample = recordResourceExit({ policy: { mode: 'fixed', cpuCores: 1, memoryMiB: 256 }, stats: { oomKills: Infinity, memoryPeakBytes: -1 }, pid: -1, signal: 'arbitrary text', code: 900, time: 'secret' }); assert.equal(sample.reason, 'native-exit'); assert.equal(sample.usage.oomKills, null); assert.equal(sample.usage.memoryPeakBytes, null); assert.equal(sample.pid, null); assert.equal(sample.code, null); assert.equal(sample.signal, null);
  assert.equal(translatePanelMessage(MEMORY_LIMIT_EXIT_MESSAGE), "Bedrock was stopped by the operating system after exceeding this server's configured memory limit.");
  const body = { server: { id: 'a', error: MEMORY_LIMIT_EXIT_MESSAGE, resources: { effective: null, usage: null, lastExit: sample } } }, result = localizeApiResponse('/api/servers/a', body, 'en'); assert.match(result.server.error, /configured memory limit/); assert.deepEqual(result.server.resources.lastExit, sample); assert.equal(result.server.resources.effective, null); assert.equal(result.server.resources.usage, null);
});

test('application OOM diagnostics identify the actual runtime in EN and VI without rewriting Bedrock history', () => {
  for (const [kind, name] of [['nodejs', 'Node.js'], ['python', 'Python']]) {
    const message = memoryLimitExitMessage(kind);
    assert.match(message, new RegExp('^' + name.replace('.', '\\.')));
    assert.equal(message.includes('Bedrock'), false);
    const result = localizeApiResponse('/api/servers/owned', { server: { id: 'owned', kind, error: message } }, 'en');
    assert.equal(result.server.error, `${name} was stopped by the operating system after exceeding this application's configured memory limit.`);
    assert.equal(translatePanelMessage(message, 'vi'), message);
  }
  assert.equal(memoryLimitExitMessage('bedrock'), MEMORY_LIMIT_EXIT_MESSAGE);
});
