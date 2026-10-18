import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostSampler } from '../server/host-telemetry.js';
import { createMetricHistory } from '../public/metric-history.js';

const priorDocument = globalThis.document;
globalThis.document = { documentElement: { lang: '' }, addEventListener() {}, querySelectorAll() { return []; } };
let view, plainUI;
try { view = await import('../public/telemetry-view.js'); ({ plainUI } = await import('../public/i18n.js')); }
finally { if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument; }

function samplerFixture() {
  let time = 0, cpu = 'cpu 100 0 100 800 50 10 10 20 50 0', interfaces = [{ name: 'eth0', rx: 1000, tx: 2000 }, { name: 'eth1', rx: 1000, tx: 2000 }];
  const osApi = { cpus: () => Array.from({ length: 2 }, () => ({ model: 'Measured fixture', times: { user: 1, sys: 1, idle: 8 } })), availableParallelism: () => 1,
    totalmem: () => 1024000, freemem: () => 102400, hostname: () => 'fixture', arch: () => 'x64', release: () => '6.8', type: () => 'Linux', uptime: () => 10, loadavg: () => [0, 0, 0], userInfo: () => ({ username: 'fixture' }) };
  const sample = createHostSampler({ platform: 'linux', osApi, monotonic: () => time, now: () => 1700000000000 + time, minIntervalMs: 0,
    statfs: async () => ({ blocks: 100, bfree: 50, bavail: 40, bsize: 4096 }), readFile: async filename => {
      const name = String(filename).replaceAll('\\', '/');
      if (name === '/proc/stat') return cpu;
      if (name === '/proc/meminfo') return 'MemTotal: 1000 kB\nMemAvailable: 700 kB\nMemFree: 100 kB\n';
      if (name === '/proc/net/dev') return interfaces.map(row => `${row.name}: ${row.rx} 0 0 0 0 0 0 0 ${row.tx} 0 0 0 0 0 0 0`).join('\n');
      if (name === '/proc/net/route') return interfaces.map(row => `${row.name} 00000000 0 0003 0 0 0 00000000`).join('\n');
      return '';
    } });
  return { sample: () => sample('/fixture'), advance(nextCPU, nextInterfaces) { time += 1000; if (nextCPU) cpu = nextCPU; if (nextInterfaces) interfaces = nextInterfaces; } };
}

test('host executing CPU excludes steal and I/O wait, guest stays counted once, vCPU denominator is not the service affinity', async () => {
  const f = samplerFixture(); await f.sample();
  // Of 100 new ticks: execution20, idle50, I/O wait10, hypervisor steal20.
  f.advance('cpu 110 0 110 850 60 10 10 40 60 0');
  const host = await f.sample();
  assert.equal(host.cpu.percent, 20); assert.equal(host.cpu.usedCores, .4);
  assert.equal(host.cpu.totalCores, 2); assert.equal(host.limits.effectiveCpuCores, 1);
  assert.equal(host.cpu.stealPercent, 20); assert.equal(host.cpu.iowaitPercent, 10);
  assert.equal(host.cpu.sampleDurationMs, 1000);
});

test('a decreasing kernel I/O-wait counter invalidates one interval and recovers on the next valid observation', async () => {
  const f = samplerFixture(); await f.sample(); f.advance('cpu 110 0 110 900 40 10 10 20 60 0');
  assert.equal((await f.sample()).cpu.percent, null);
  f.advance('cpu 120 0 120 980 40 10 10 20 70 0'); assert.equal((await f.sample()).cpu.percent, 20);
});

test('very small measured CPU use stays precise in the API instead of becoming a rounded zero', async () => {
  const f = samplerFixture(); await f.sample(); f.advance('cpu 101 0 100 10799 50 10 10 20 50 0');
  const host = await f.sample();
  assert.equal(host.cpu.percent, .01); assert.equal(host.cpuPercent, .01); assert.equal(host.cpu.usedCores, .0002);
});

test('a reset on one selected interface cannot be hidden by growth on another; the next rate uses only the new baseline', async () => {
  const f = samplerFixture(); await f.sample();
  f.advance(null, [{ name: 'eth0', rx: 1, tx: 2 }, { name: 'eth1', rx: 4000, tx: 6000 }]);
  const reset = await f.sample();
  assert.equal(reset.network.rxBytes, 4001); assert.equal(reset.network.txBytes, 6002);
  assert.equal(reset.network.rxBytesPerSecond, null); assert.equal(reset.network.txBytesPerSecond, null);
  f.advance(null, [{ name: 'eth0', rx: 101, tx: 202 }, { name: 'eth1', rx: 4300, tx: 6400 }]);
  const recovered = await f.sample(); assert.equal(recovered.network.rxBytesPerSecond, 400); assert.equal(recovered.network.txBytesPerSecond, 600);
});

test('current model rejects older CPU but accepts a newer independent storage sample from the same mixed snapshot', () => {
  const history = createMetricHistory();
  history.record('host:a', { cpu: { sampledAt: 2000, values: [.2] }, storage: { sampledAt: 1000, values: [100] } },
    { model: { kind: 'host', sampledAt: 2000, cpu: { used: .2 }, storage: { used: 100 } } });
  history.record('host:a', { cpu: { sampledAt: 1500, values: [.9] }, storage: { sampledAt: 3000, values: [200] } },
    { model: { kind: 'host', sampledAt: 1500, cpu: { used: .9 }, storage: { used: 200 } } });
  assert.equal(history.model('host:a').cpu.used, .2); assert.equal(history.model('host:a').storage.used, 200);
  assert.deepEqual(history.series('host:a', 'cpu').map(row => row.values[0]), [.2]);
  assert.deepEqual(history.series('host:a', 'storage').map(row => row.values[0]), [100, 200]);
});

test('an old stale snapshot cannot mark a newer current measurement stale; same-time offline gaps remain real', () => {
  const history = createMetricHistory();
  const record = (time, used, stale = false) => history.record('a', { cpu: { sampledAt: time, values: [used], stale } },
    { model: { sampledAt: time, offline: stale, cpu: { used, stale } } });
  record(2000, .2); record(1000, .1, true);
  assert.equal(history.model('a').cpu.used, .2); assert.equal(history.model('a').offline, false);
  record(2000, null, true); assert.equal(history.model('a').cpu.stale, true);
  assert.equal(history.series('a', 'cpu').at(-1).gap, true);
  record(3000, .3); assert.equal(history.model('a').cpu.used, .3); assert.equal(history.series('a', 'cpu').at(-1).breakBefore, true);
});

test('CPU shows an explicit percent for the actual denominator and explains steal/I/O separately', () => {
  view.clearTelemetryHistory();
  const host = { sampledAt: new Date(2000).toISOString(), cpu: { usedCores: .09, totalCores: 1, stealPercent: 4, iowaitPercent: 2, source: 'proc-stat' } };
  const html = plainUI(view.telemetryMarkup(host, () => '', { entityId: 'percent-proof' }));
  assert.match(html, /data-metric-percent>9%/); assert.match(html, /steal[^<]*4%/i); assert.match(html, /I\/O[^<]*2%/i);
  const server = view.telemetryModel({ telemetry: { cpu: { usedCores: .25, totalCores: .5 } }, resourcePolicy: { mode: 'fixed' } }, 'server');
  assert.equal(server.cpu.percent, 50);
});
