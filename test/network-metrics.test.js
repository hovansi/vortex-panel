import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createNetworkMetrics, gamePortSelectors, runNft } from '../server/network-metrics.js';

async function runnerFixture(t) {
  const parent = path.resolve(os.tmpdir()), dir = await fs.mkdtemp(path.join(parent, 'vortex-nft-runner-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), parent); assert.ok(path.basename(dir).startsWith('vortex-nft-runner-test-')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
test('nft batch runner passes a private regular file to the actual child and removes it only after close', async t => {
  const tempRoot = await runnerFixture(t); let filename, visibleAtClose = false, childClosed = false;
  const result = await runNft(['-f', '-'], { input: 'counter fixture only\n', tempRoot, spawnProcess(command, args, options) {
    assert.equal(command, 'nft'); assert.equal(args[0], '-f'); assert.notEqual(args[1], '-'); assert.equal(options.stdio[0], 'ignore');
    filename = args[1]; assert.equal(path.dirname(path.dirname(filename)), tempRoot);
    const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs"),path=require("node:path"),f=process.argv[1]; console.log(JSON.stringify({regular:fs.statSync(f).isFile(),fileMode:fs.statSync(f).mode&511,dirMode:fs.statSync(path.dirname(f)).mode&511,text:fs.readFileSync(f,"utf8")}));', '--', filename], options);
    child.once('close', () => { visibleAtClose = existsSync(filename); childClosed = true; }); return child;
  } });
  assert.equal(result.code, 0); const data = JSON.parse(result.stdout); assert.equal(data.regular, true); assert.equal(data.text, 'counter fixture only\n');
  if (process.platform !== 'win32') { assert.equal(data.fileMode, 0o600); assert.equal(data.dirMode, 0o700); }
  assert.equal(visibleAtClose, true); assert.equal(childClosed, true); assert.equal(existsSync(filename), false); assert.deepEqual(await fs.readdir(tempRoot), []);
});
test('nft batch runner cleans regular input after synchronous and asynchronous spawn failures', async t => {
  const tempRoot = await runnerFixture(t);
  for (const synchronous of [true, false]) {
    await assert.rejects(runNft(['-f', '-'], { input: 'private fixture\n', tempRoot, spawnProcess(command, args, options) {
      assert.equal(existsSync(args[1]), true);
      if (synchronous) throw new Error('fixture-spawn-failure');
      return spawn(path.join(tempRoot, 'missing-nft-binary'), [], options);
    } }), synchronous ? /fixture-spawn-failure/ : /nft-spawn-failed/);
    assert.deepEqual(await fs.readdir(tempRoot), []);
  }
});
test('nft timeout and response bounds kill and await actual child close before private file cleanup', async t => {
  const tempRoot = await runnerFixture(t);
  for (const excessiveOutput of [false, true]) {
    let filename, childClosed = false, visibleAtClose = false;
    await assert.rejects(runNft(['-f', '-'], { input: 'fixture\n', tempRoot, timeoutMs: excessiveOutput ? 3000 : 100, maxBytes: 1024,
      spawnProcess(command, args, options) {
        filename = args[1];
        const child = spawn(process.execPath, ['-e', excessiveOutput ? 'process.stdout.write(Buffer.alloc(65536));setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], options);
        child.once('close', () => { visibleAtClose = existsSync(filename); childClosed = true; }); return child;
      } }), excessiveOutput ? /nft-response-too-large/ : /nft-timeout/);
    assert.equal(childClosed, true); assert.equal(visibleAtClose, true); assert.equal(existsSync(filename), false); assert.deepEqual(await fs.readdir(tempRoot), []);
  }
});
test('invalid or oversized nft batch input fails before file creation or child execution', async t => {
  const tempRoot = await runnerFixture(t); let spawned = false;
  const options = { tempRoot, spawnProcess() { spawned = true; throw new Error('unexpected child'); } };
  await assert.rejects(runNft(['-f', '-'], { ...options, input: 'x'.repeat(8 * 1024 ** 2 + 1) }), /nft-invalid-command/);
  await assert.rejects(runNft(['list', 'tables'], { ...options, input: 'unexpected input' }), /nft-invalid-command/);
  assert.equal(spawned, false); assert.deepEqual(await fs.readdir(tempRoot), []);
});

// This fixture models nft's CLI/JSON contract; live kernel packet accounting
// needs the separately authorized Linux acceptance and is not claimed here.
function nftFixture() {
  let table, handle=10, fail=false;const calls=[];
  function add(input) {
    for(const line of input.trim().split('\n')) {
      let m;
      if((m=line.match(/^add table inet (\w+) \{ comment "([^"]+)"; \}$/))) table={family:'inet',name:m[1],comment:m[2],chains:[],counters:[],rules:[]};
      else if((m=line.match(/^add chain inet \w+ (input|output) \{ type filter hook \w+ priority 10; policy accept; \}$/))) table.chains.push({family:'inet',table:table.name,name:m[1],hook:m[1],type:'filter',prio:10,policy:'accept'});
      else if((m=line.match(/^add counter inet \w+ (\w+) \{ comment "([^"]+)"; \}$/))) table.counters.push({family:'inet',table:table.name,name:m[1],comment:m[2],bytes:0,packets:0});
      else if((m=line.match(/^add rule inet \w+ (input|output) meta nfproto (ipv4|ipv6) (tcp|udp) (dport|sport) \{ ([\d, ]+) \} counter name (\w+) comment "([^"]+)"$/))) table.rules.push({family:'inet',table:table.name,chain:m[1],handle:handle++,comment:m[7],expr:[{match:{op:'==',left:{meta:{key:'nfproto'}},right:m[2]}},{match:{op:'==',left:{payload:{protocol:m[3],field:m[4]}},right:{set:m[5].split(',').map(Number)}}},{counter:m[6]}]});
      else if((m=line.match(/^delete rule inet \w+ \w+ handle (\d+)$/))) table.rules=table.rules.filter(r=>r.handle!==Number(m[1]));
      else if((m=line.match(/^delete counter inet \w+ (\w+)$/))) table.counters=table.counters.filter(r=>r.name!==m[1]);
      else if(/^delete table inet \w+$/.test(line)) table=undefined;
      else throw new Error('Unexpected nft fixture command: '+line);
    }
  }
  return {calls,get table(){return table;},fail(value){fail=value;},increment(id,rx,tx){for(const c of table.counters)if(c.name.endsWith(id.replaceAll('-',''))){c.bytes+=c.name.startsWith('rx_')?rx:tx;c.packets++;}},
    async run(args,options={}) {calls.push({args,input:options.input});if(fail)throw new Error('permission-denied-private-detail');if(args[0]==='-f'){add(options.input);return{code:0,stdout:'',stderr:''};}if(!table)return{code:1,stdout:'',stderr:'No such file or directory'};return{code:0,stderr:'',stdout:JSON.stringify({nftables:[{metainfo:{json_schema_version:1}},{table:{family:'inet',name:table.name,comment:table.comment}},...table.chains.map(chain=>({chain})),...table.counters.map(counter=>({counter})),...table.rules.map(rule=>({rule}))]})};},};
}
async function fixture(t,options={}) {
  const parent=path.resolve(os.tmpdir()),dir=await fs.mkdtemp(path.join(parent,'vortex-network-metrics-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert.ok(path.basename(dir).startsWith('vortex-network-metrics-'));await fs.rm(dir,{recursive:true,force:true});});
  const nft=nftFixture();let at=1700000000000,mono=0;
  const controller=createNetworkMetrics({dataDir:dir,platform:'linux',run:nft.run,now:()=>at,monotonic:()=>mono,minIntervalMs:10,...options});
  return{dir,nft,controller,advance(ms=1000){at+=ms;mono+=ms;},row(extra={}){return{id:randomUUID(),transport:'nethernet',port:19132,portV6:19133,udpPorts:'19134-19165',...extra};}};
}
test('selectors cover real RakNet/NetherNet families, full UDP ranges and owned debugger without duplicates',()=>{
  const id=randomUUID();assert.deepEqual(gamePortSelectors({id,transport:'raknet',port:19132,portV6:19133}),[{family:'ipv4',protocol:'udp',port:19132},{family:'ipv6',protocol:'udp',port:19133}]);
  const rows=gamePortSelectors({id,transport:'nethernet',port:19132,portV6:19133,udpPorts:'19134-19165',debugPort:19132});assert.equal(rows.length,66);assert.equal(rows.filter(r=>r.port===19165).length,2);
  assert.throws(()=>gamePortSelectors({id:'bad; flush ruleset',transport:'raknet',port:19132,portV6:19133}));
});

test('application selectors reserve only TCP by family and reject hybrid or unknown kinds before accounting',()=>{
  const id=randomUUID(),app={id,kind:'python',transport:'tcp',port:30000,portV6:null,udpPorts:null,debugPort:null};
  assert.deepEqual(gamePortSelectors(app),[{family:'ipv4',protocol:'tcp',port:30000},{family:'ipv6',protocol:'tcp',port:30000}]);
  for(const change of[{udpPorts:'30002-30033'},{portV6:30001},{debugPort:39999},{transport:'raknet'},{kind:'unknown'}])assert.throws(()=>gamePortSelectors({...app,...change}));
});

test('actual nft controller keeps app TCP and Bedrock UDP plans on the same port independently accounted',async t=>{
  const f=await fixture(t),app=f.row({kind:'nodejs',transport:'tcp',portV6:null,udpPorts:null,debugPort:null}),minecraft=f.row({transport:'raknet',udpPorts:null});
  await f.controller.initialize();assert.equal((await f.controller.syncServers([app,minecraft])).supported,true);
  assert.equal(f.nft.table.counters.length,4);assert.equal(f.nft.table.rules.length,8);
  assert.ok(f.nft.table.rules.filter(row=>row.comment.includes(app.id)).every(row=>row.expr[1].match.left.payload.protocol==='tcp'));
  assert.ok(f.nft.table.rules.filter(row=>row.comment.includes(minecraft.id)).every(row=>row.expr[1].match.left.payload.protocol==='udp'));
  await f.controller.sample();f.nft.increment(app.id,400,700);f.nft.increment(minecraft.id,900,1200);f.advance();
  assert.equal((await f.controller.sample(app.id)).rxBytes,400);assert.equal(f.controller.peek(minecraft.id).rxBytes,900);
  const writes=f.nft.calls.length;await assert.rejects(f.controller.syncServers([app,{...app,id:randomUUID()}]),/Overlapping/);assert.equal(f.nft.calls.length,writes);
  await f.controller.close();assert.equal(f.nft.table,undefined);
});
test('kernel counter attachment uses exclusive private identity and only pass-through counter statements',async t=>{
  const f=await fixture(t);await Promise.all([f.controller.initialize(),f.controller.initialize()]);const row=f.row();assert.equal((await f.controller.syncServers([row])).supported,true);
  const writes=f.nft.calls.filter(c=>c.input).map(c=>c.input).join('\n');assert.equal(/flush ruleset|\bdrop\b|\breject\b|\bjump\b|\baccept\s*\n/.test(writes),false);
  assert.equal(f.nft.table.rules.length,8);assert.equal(f.nft.table.counters.length,2);
  const identity=JSON.parse(await fs.readFile(path.join(f.dir,'.network-metrics.json'),'utf8'));assert.ok(identity.table.endsWith(identity.owner.replaceAll('-','')));
  if(process.platform!=='win32')assert.equal((await fs.stat(path.join(f.dir,'.network-metrics.json'))).mode&0o077,0);
  await f.controller.close();assert.equal(f.nft.table,undefined);
});
test('first game-port sample warms; bytes, packets and subsequent rates are actual counter deltas',async t=>{
  const f=await fixture(t),row=f.row();await f.controller.syncServers([row]);const first=await f.controller.sample(row.id);assert.equal(first.rxBytesPerSecond,null);
  f.nft.increment(row.id,1200,3400);f.advance();const value=await f.controller.sample(row.id);assert.equal(value.rxBytes,1200);assert.equal(value.txBytes,3400);assert.equal(value.rxBytesPerSecond,1200);assert.equal(value.txBytesPerSecond,3400);assert.equal(value.rxPackets,1);assert.equal(value.scope,'server-game-ports');assert.equal(value.processAttributed,false);await f.controller.close();
});
test('changing one port resets only its server while another server counter is retained',async t=>{
  const f=await fixture(t),a=f.row(),b=f.row({port:19232,portV6:19233,udpPorts:'19234-19265'});await f.controller.syncServers([a,b]);f.nft.increment(a.id,200,400);f.nft.increment(b.id,500,900);await f.controller.sample();
  f.advance();await f.controller.syncServers([{...a,port:19332,udpPorts:'19334-19365'},b]);const data=await f.controller.sample();assert.equal(data[a.id].rxBytes,0);assert.equal(data[a.id].rxBytesPerSecond,null);assert.equal(data[b.id].rxBytes,500);assert.notEqual(data[a.id].resetAt,data[b.id].resetAt);await f.controller.close();
});
test('same plans are idempotent; removing a server removes only its counters and rules',async t=>{
  const f=await fixture(t),a=f.row(),b=f.row({port:19232,portV6:19233,udpPorts:'19234-19265'});await f.controller.syncServers([a,b]);const writes=f.nft.calls.filter(c=>c.input).length;await f.controller.syncServers([a,b]);assert.equal(f.nft.calls.filter(c=>c.input).length,writes);
  await f.controller.syncServers([b]);assert.equal(f.nft.table.counters.length,2);assert.equal((await f.controller.sample(a.id)).available,false);assert.equal((await f.controller.sample(b.id)).available,true);await f.controller.close();
});
test('duplicate and overlapping reservations fail before kernel writes',async t=>{
  const f=await fixture(t),a=f.row();await assert.rejects(f.controller.syncServers([a,{...a,id:randomUUID()}]),/Overlapping/);assert.equal(f.nft.calls.length,0);
});
test('counter table is reused after restart without resetting existing bytes',async t=>{
  const f=await fixture(t),row=f.row();await f.controller.syncServers([row]);f.nft.increment(row.id,500,800);await f.controller.close({cleanup:false});
  const next=createNetworkMetrics({dataDir:f.dir,platform:'linux',run:f.nft.run});await next.initialize();await next.syncServers([row]);const value=await next.sample(row.id);assert.equal(value.rxBytes,500);assert.equal(value.txBytes,800);assert.equal(value.rxBytesPerSecond,null);await next.close();
});
test('foreign ownership, extra verdicts or mismatched selectors block destructive cleanup',async t=>{
  for(const tamper of [table=>{table.comment='foreign';},table=>{table.rules[0].expr.push({drop:null});},table=>{table.rules[0].expr[1].match.right={set:[22]};}]){
    const f=await fixture(t),row=f.row();await f.controller.syncServers([row]);tamper(f.nft.table);const before=f.nft.calls.filter(c=>c.input).length;const result=await f.controller.close();assert.equal(result.cleaned,false);assert.equal(f.nft.calls.filter(c=>c.input).length,before);assert.ok(f.nft.table);
  }
});
test('unsupported Windows, nft permission failures and old samples never pretend live rates',async t=>{
  const windows=await fixture(t,{platform:'win32'});assert.equal((await windows.controller.initialize()).supported,false);assert.equal(windows.nft.calls.length,0);
  const f=await fixture(t),row=f.row();await f.controller.syncServers([row]);await f.controller.sample(row.id);f.advance(11000);assert.equal(f.controller.peek(row.id).stale,true);f.nft.fail(true);const value=await f.controller.sample(row.id);assert.equal(value.stale,true);assert.equal(value.available,false);assert.equal(value.rxBytesPerSecond,null);assert.equal(JSON.stringify(value).includes('private-detail'),false);
});
