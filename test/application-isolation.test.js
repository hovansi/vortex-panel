import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('actual Python isolation helper preserves ownership, distro profile semantics, shared references and failure rollback without host policy mutations', () => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-B', 'test/application-isolation-fixture.py'], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.passed, 27); assert.equal(proof.failed, 0); assert.equal(proof.hostPolicyMutations, 0);
});
