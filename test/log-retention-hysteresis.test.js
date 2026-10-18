import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_RETENTION_DEFAULTS, boundConsoleEntry, createBoundedConsoleWriter, readConsoleTail } from '../server/log-retention.js';

const MiB = 1024 ** 2;
const record = (index, padding = '界🙂'.repeat(280), time = new Date().toISOString()) => ({ time, level: 'info', source: 'native', message: `row-${index}: ${padding}` });
const line = (input, policy) => JSON.stringify(boundConsoleEntry(input, policy)) + '\n';
const diskRows = root => fs.readFileSync(path.join(root, 'console.log'), 'utf8').trim().split('\n').filter(Boolean).map(value => JSON.parse(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vortex-log-hysteresis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function seedNearBudget(root, policy) {
  const chunks = []; let bytes = 0, index = 0;
  while (true) {
    const value = line(record(`seed-${index}`), policy), size = Buffer.byteLength(value);
    if (bytes + size > policy.consoleBytes) break;
    chunks.push(value); bytes += size; index++;
  }
  fs.writeFileSync(path.join(root, 'console.log'), chunks.join(''));
  return { bytes, entries: index };
}

for (const budget of [MiB, 2 * MiB]) test(`real ${budget / MiB} MiB overflow leaves append headroom instead of rewriting on each of400 sequential rows`, { timeout: 30000 }, async t => {
  const root = fixture(t), policy = { ...LOG_RETENTION_DEFAULTS, consoleBytes: budget, consoleMemoryBytes: 4 * MiB, consoleQueueBytes: 4 * MiB, consoleEntries: 5000 };
  seedNearBudget(root, policy); const writer = createBoundedConsoleWriter({ serverRoot: root, limits: policy });
  writer.append(record('overflow-first')); await writer.drain();
  const initialSize = fs.statSync(path.join(root, 'console.log')).size;
  assert.equal(writer.stats().compactions, 1);
  assert.ok(initialSize <= budget * 0.76 && initialSize >= budget * 0.70, 'size overflow should leave meaningful headroom while keeping the newest rows');
  for (let index = 0; index < 400; index++) {
    writer.append(record(index)); await writer.drain();
    const stats = writer.stats(); assert.ok(stats.queuedBytes + stats.inFlightBytes <= policy.consoleQueueBytes);
    assert.ok(fs.statSync(path.join(root, 'console.log')).size <= budget);
  }
  await writer.close(); const rows = diskRows(root), stats = writer.stats();
  assert.ok(stats.compactions <= 8, `400 rows produced ${stats.compactions} compactions`);
  assert.equal(rows.at(-1).message, record(399).message);
  assert.equal(rows.map(row => row.message).join('').includes('�'), false);
  assert.ok(rows.every(row => Buffer.byteLength(JSON.stringify(row) + '\n') <= policy.consoleLineBytes));
  assert.equal(stats.processedEntries, 401); assert.equal(stats.writtenEntries, 401); assert.equal(stats.droppedEntries, 0); assert.equal(stats.writeFailures, 0);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('.vortex-console-')), false);
  t.diagnostic(JSON.stringify({budget,appended:401,compactions:stats.compactions,fileBytes:stats.fileBytes,retentionEvictedKnownEntries:stats.retentionEvictedKnownEntries}));
});

test('quiet maintenance does not rewrite or shrink a fresh under-budget file even beyond the memory entry count', async t => {
  const root = fixture(t), policy = { ...LOG_RETENTION_DEFAULTS, consoleBytes: MiB, consoleEntries: 1500 };
  const contents = Array.from({length:2000}, (_, index) => line(record(index, 'fresh'), policy)).join('');
  fs.writeFileSync(path.join(root, 'console.log'), contents); const original = fs.statSync(path.join(root, 'console.log'));
  const writer = createBoundedConsoleWriter({ serverRoot: root, limits: policy });
  for (let index = 0; index < 20; index++) await writer.maintain();
  await writer.close(); const after = fs.statSync(path.join(root, 'console.log'));
  assert.equal(writer.stats().compactions, 0); assert.equal(writer.stats().fileBytes, Buffer.byteLength(contents));
  assert.equal(after.ino, original.ino); assert.equal(after.mtimeMs, original.mtimeMs); assert.equal(fs.readFileSync(path.join(root, 'console.log'), 'utf8'), contents);
  assert.equal(diskRows(root).length, 2000); assert.equal((await readConsoleTail(root, policy)).length, 1500);
});

test('explicit age maintenance removes expired records once while preserving fresh rows and unrelated assets', async t => {
  const root = fixture(t); let policy = { ...LOG_RETENTION_DEFAULTS, consoleBytes: MiB };
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  fs.writeFileSync(path.join(root, 'console.log'), line(record('expired', 'old bytes', old), policy) + line(record('fresh', 'newest bytes'), policy));
  fs.mkdirSync(path.join(root, 'run/worlds/Main/db'), {recursive:true}); fs.writeFileSync(path.join(root, 'run/worlds/Main/db/000123.log'), 'WORLD DATABASE');fs.writeFileSync(path.join(root, 'user.log'), 'USER BYTES');
  const writer = createBoundedConsoleWriter({serverRoot:root,limits:()=>policy});await writer.maintain();assert.equal(writer.stats().compactions,0);
  policy={...policy,consoleDays:1};await writer.maintain();const first=fs.readFileSync(path.join(root,'console.log'));
  for(let index=0;index<10;index++)await writer.maintain();await writer.close();
  assert.equal(writer.stats().compactions,1);assert.deepEqual(fs.readFileSync(path.join(root,'console.log')),first);assert.deepEqual(diskRows(root).map(row=>row.message),[record('fresh','newest bytes').message]);
  assert.equal(writer.stats().retentionEvictedKnownEntries,1);assert.equal(writer.stats().processedEntries,0);assert.equal(writer.stats().writtenEntries,0);
  assert.equal(fs.readFileSync(path.join(root,'user.log'),'utf8'),'USER BYTES');assert.equal(fs.readFileSync(path.join(root,'run/worlds/Main/db/000123.log'),'utf8'),'WORLD DATABASE');
});

test('4 MiB queue with a1 MiB file retains the newest real rows and distinguishes input processing from materialized entries', async t => {
  const root=fixture(t),policy={...LOG_RETENTION_DEFAULTS,consoleBytes:MiB,consoleMemoryBytes:4*MiB,consoleQueueBytes:4*MiB,consoleEntries:5000},writer=createBoundedConsoleWriter({serverRoot:root,limits:policy});
  for(let index=0;index<1000;index++){writer.append(record(index,'界🙂'.repeat(1100)));const stats=writer.stats();assert.ok(stats.queuedBytes+stats.inFlightBytes<=policy.consoleQueueBytes);}
  await writer.close();const rows=diskRows(root),stats=writer.stats();
  assert.ok(fs.statSync(path.join(root,'console.log')).size<=0.76*MiB);assert.equal(rows.at(-1).message,record(999,'界🙂'.repeat(1100)).message);assert.equal(rows.map(row=>row.message).join('').includes('�'),false);
  assert.equal(stats.compactions,1);assert.equal(stats.processedEntries+stats.droppedEntries,1000);assert.ok(stats.processedEntries>stats.writtenEntries);assert.equal(stats.writtenEntries,rows.length);assert.equal(stats.writtenEntries+stats.retentionEvictedKnownEntries,stats.processedEntries);
  assert.equal(stats.writeFailures,0);assert.equal(stats.queuedBytes,0);assert.equal(stats.inFlightBytes,0);assert.equal(stats.fileBytes,fs.statSync(path.join(root,'console.log')).size);
  t.diagnostic(JSON.stringify({queueBudget:policy.consoleQueueBytes,fileBudget:policy.consoleBytes,submitted:1000,processedEntries:stats.processedEntries,writtenEntries:stats.writtenEntries,droppedEntries:stats.droppedEntries,retentionEvictedKnownEntries:stats.retentionEvictedKnownEntries,fileBytes:stats.fileBytes}));
});
