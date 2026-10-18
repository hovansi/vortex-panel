import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireDataLock } from '../server/lock.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('only one panel may write a data directory; release permits restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-lock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = acquireDataLock(dir);
  assert.throws(() => acquireDataLock(dir), /Một panel khác/);
  release();
  const releaseAgain = acquireDataLock(dir);
  releaseAgain();
  assert.equal(fs.existsSync(path.join(dir, 'panel.lock')), false);
});

test('simultaneous stale-lock recovery admits exactly one writer', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-stale-lock-test-'));
  const ended = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise(resolve => ended.once('exit', resolve));
  fs.writeFileSync(path.join(dir, 'panel.lock'), JSON.stringify({ pid: ended.pid, identity: 'stale' }));
  const children = [];
  t.after(() => { for (const item of children) item.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const moduleURL = new URL('../server/lock.js', import.meta.url).href;
  const program = `import { acquireDataLock } from ${JSON.stringify(moduleURL)};
process.stdout.write('READY\\n');
process.stdin.once('data', () => {
  try { const release = acquireDataLock(process.argv[1]); process.stdout.write('ACQUIRED\\n'); process.stdin.once('data', () => { release(); process.exit(0); }); }
  catch { process.stdout.write('REFUSED\\n'); process.stdin.once('data', () => process.exit(0)); }
});`;
  for (let i = 0; i < 6; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, dir], { windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let readyResolve, resultResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const result = new Promise(resolve => { resultResolve = resolve; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    lines.on('line', line => { if (line === 'READY') readyResolve(); else resultResolve(line); });
    children.push({ child, ready, result, exited });
  }
  await Promise.all(children.map(item => item.ready));
  for (const item of children) item.child.stdin.write('GO\n');
  const outcomes = await Promise.all(children.map(item => item.result));
  for (const item of children) item.child.stdin.write('RELEASE\n');
  await Promise.all(children.map(item => item.exited));
  assert.equal(outcomes.filter(value => value === 'ACQUIRED').length, 1, outcomes.join(','));
});
