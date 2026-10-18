import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
test('worker removal Python helper checks real owned-file effects, strict refusal and foreign preservation offline', () => {
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['test/node-removal-helper.py'], { cwd: process.cwd(), encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(typeof output, 'string');
});
