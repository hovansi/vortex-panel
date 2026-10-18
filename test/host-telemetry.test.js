import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHostSampler, parseHostCPU, parseHostMemory, defaultRouteInterfaces } from '../server/host-telemetry.js';
import { createHostLocation, lookupHostLocation, HOST_LOCATION_PROVIDER } from '../server/host-location.js';
import { createNodeNaming } from '../server/node-naming.js';

function fixture() {
  let at = 0, rx = 1000, tx = 2000, cpu = 'cpu 100 0 100 800 0 0 0 0 70 0', route = 'eth0 00000000 00000000 0003 0 0 0 00000000 0 0 0';
  const osApi = { cpus: () => [0, 1].map(() => ({ model: 'Fixture CPU', times: { user: 100, idle: 100 } })), availableParallelism: () => 2,
    totalmem: () => 1024000, freemem: () => 102400, hostname: () => 'fixture', arch: () => 'x64', release: () => '6.8-test', type: () => 'Linux', uptime: () => 10, loadavg: () => [1, 0, 0], userInfo: () => ({ username: 'fixture' }) };
  const sampler = createHostSampler({ platform: 'linux', osApi, procRoot: '/fixture/proc', sysRoot: '/fixture/sys', minIntervalMs: 100,
    monotonic: () => at, now: () => 1700000000000 + at, statfs: async () => ({ blocks: 1000, bfree: 300, bavail: 200, bsize: 4096 }),
    stat: async () => { throw new Error('no physical fallback'); }, readFile: async filename => {
      const name = String(filename).replaceAll('\\', '/');
      if (name.endsWith('/proc/stat')) return cpu;
      if (name.endsWith('/proc/meminfo')) return 'MemTotal: 1000 kB\nMemAvailable: 700 kB\nMemFree: 100 kB\nSwapTotal: 100 kB\nSwapFree: 50 kB\n';
      if (name.endsWith('/proc/net/dev')) return `eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\nlo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0\nveth0: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0`;
      if (name.endsWith('/proc/net/route')) return route;
      if (name.endsWith('/proc/self/cgroup')) return '0::/service/leaf';
      if (name.endsWith('/service/cpu.max')) return '50000 100000';
      if (name.endsWith('/service/memory.max')) return '524288000';
      if (name.endsWith('/cpuset.cpus.effective')) return '0-1';
      return '';
    } });
  return { sample: () => sampler('/fixture/data'), advance() { at += 1000; rx += 3000; tx += 5000; cpu = 'cpu 200 0 100 1100 0 0 0 0 170 0'; }, reset() { at += 1000; rx = 2; tx = 3; }, noRoute() { at += 1000; route = ''; } };
}
test('host first sample is warming; subsequent CPU and selected-interface rates use real deltas', async () => {
  const f = fixture(), first = await f.sample();
  assert.equal(first.cpu.percent, null); assert.equal(first.network.rxBytesPerSecond, null);
  assert.deepEqual(first.network.interfaces.map(row => row.name), ['eth0']);
  f.advance(); const second = await f.sample();
  assert.equal(second.cpu.percent, 25); assert.equal(second.cpu.usedCores, 0.5);
  assert.equal(second.network.rxBytesPerSecond, 3000); assert.equal(second.network.txBytesPerSecond, 5000);
  assert.equal(second.network.scope, 'host-network-namespace'); assert.equal(second.network.includesOtherProcesses, true);
});
test('memory distinguishes available cache, disk reserved blocks and cgroup ancestor ceilings', async () => {
  const value = await fixture().sample();
  assert.equal(value.memory.usedBytes, 300 * 1024); assert.equal(value.memory.freeBytes, 100 * 1024);
  assert.equal(value.disk.usedBytes, 700 * 4096); assert.equal(value.disk.availableBytes, 200 * 4096); assert.equal(value.disk.reservedBytes, 100 * 4096);
  assert.equal(value.limits.effectiveCpuCores, 0.5); assert.equal(value.limits.memoryMaxBytes, 524288000); assert.equal(value.limits.limitsAreReservations, false);
});
test('counter reset never emits negative traffic; absent route/device stays unsupported', async () => {
  const f = fixture(); await f.sample(); f.advance(); await f.sample(); f.reset(); const reset = await f.sample();
  assert.equal(reset.network.rxBytesPerSecond, null); assert.equal(reset.network.txBytesPerSecond, null);
  f.noRoute(); const absent = await f.sample(); assert.equal(absent.network.supported, false); assert.equal(absent.network.rxBytes, null);
});
test('concurrent dashboard reads share one sampling interval; guest CPU is not counted twice', async () => {
  const f = fixture(); const values = await Promise.all([f.sample(), f.sample(), f.sample()]); assert.equal(values[0], values[1]);
  assert.deepEqual(parseHostCPU('cpu 10 20 30 40 5 6 7 8 10 20'), { total:126,idle:45,busy:73,iowait:5,steal:8 });
  assert.equal(parseHostMemory('MemTotal: 100 kB\nMemFree: 40 kB\n').availableEstimated,true);
  assert.deepEqual(defaultRouteInterfaces('eth0 00000000 0 0003 0 0 0 00000000\nlo 00000000 0 0001 0 0 0 00000000'), ['eth0']);
});
test('automatic location is nonblocking, cached and failure is explicit unknown', async () => {
  let count=0, at=0; const service=createHostLocation({enabled:true,now:()=>at,ttlMs:100,retryMs:20,lookup:async()=>{count++;return{status:'known',label:'Fixture City',publicAddress:'203.0.113.2'};}});
  assert.equal(service.snapshot().status,'pending'); assert.equal((await service.settled()).status,'known'); service.snapshot(); assert.equal(count,1);
  at=101; service.snapshot(); await service.settled(); assert.equal(count,2);
  const disabled=createHostLocation({enabled:false,lookup:()=>{throw new Error('must not call');}}); assert.equal(disabled.snapshot().status,'disabled');
  const failed=createHostLocation({enabled:true,lookup:async()=>{throw new Error('private provider details');}}); failed.snapshot(); const result=await failed.settled(); assert.equal(result.status,'unavailable'); assert.equal(JSON.stringify(result).includes('private'),false);
});
function locationPeer(payload, options={}) {
  return (url, requestOptions, callback) => {
    assert.equal(url,HOST_LOCATION_PROVIDER); assert.equal(new URL(url).protocol,'https:'); assert.equal(Object.hasOwn(requestOptions.headers,'Authorization'),false);
    const req=new EventEmitter();req.destroy=()=>{};
    queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=options.status||200;response.destroy=()=>{};callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from(payload));response.emit('end');});});return req;
  };
}
test('provider response is bounded and validated; redirects/errors never become guessed locations', async () => {
  const value=await lookupHostLocation({get:locationPeer(JSON.stringify({success:true,ip:'203.0.113.4',country_code:'US',country:'United States',city:'City',region:'Region'}))});assert.equal(value.label,'City, Region, United States');
  await assert.rejects(lookupHostLocation({get:locationPeer('x'.repeat(100)),maxBytes:10}));
  await assert.rejects(lookupHostLocation({get:locationPeer('{}',{status:302})}));
  await assert.rejects(lookupHostLocation({get:locationPeer(JSON.stringify({success:true,ip:'not-an-IP',country_code:'US',country:'Country'}))}));
});
function namingStore(nodes=[],sequence) {return{data:{nodes,...(sequence===undefined?{}:{nodeNameSequence:sequence})},save(){this.saves=(this.saves||0)+1;}};}
test('legacy generated name migrates once, custom names remain, and unlink never reuses a serial',()=>{
  const store=namingStore([{name:'Vortex Node 02'},{name:'Custom Singapore'}]);const naming=createNodeNaming(store);
  assert.deepEqual(store.data.nodes.map(row=>row.name),['Vortex Node 001','Custom Singapore']);assert.equal(naming.preview(),'Vortex Node 002');
  assert.equal(naming.reserve(),'Vortex Node 002');assert.equal(naming.reserve(),'Vortex Node 003');store.data.nodes=[];
  assert.equal(createNodeNaming(store).reserve(),'Vortex Node 004');
});
test('name reservation persists before enrollment, preserves custom labels and rolls back failed disk commits',()=>{
  const store=namingStore([{name:'Vortex Node 007'}]);const naming=createNodeNaming(store);assert.equal(naming.reserve('Custom name'),'Custom name');assert.equal(naming.reserve(),'Vortex Node 008');
  store.save=()=>{throw new Error('disk full');};assert.throws(()=>naming.reserve(),/disk full/);assert.equal(store.data.nodeNameSequence,8);
  assert.throws(()=>createNodeNaming(namingStore([],-1)),/Invalid persisted/);
});
