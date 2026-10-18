import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { APPLICATION_ENV_HANDOFF } from '../server/application-runtime.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
// Real isolated Python parser/exec handoff, with only execve replaced by a
// capture function. This verifies framing, not Linux sandbox enforcement.
const capture = `import os, sys, json
def capture(executable, arguments, environment):
    rest = os.read(0, 65536).decode('utf-8')
    os.write(1, json.dumps({'executable': executable, 'arguments': arguments, 'environment': environment, 'rest': rest}).encode('utf-8'))
    os._exit(0)
os.execve = capture
`;
async function handoff(input) {
  const child = spawn(python, ['-I', '-c', capture + APPLICATION_ENV_HANDOFF, '/runtime/node/bin/node', '/workspace/server.js', 'literal;$(no-shell)'], { env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text); child.stdin.on('error', () => {});
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  child.stdin.end(input); return done;
}

test('post-drop environment handoff reads exactly one frame and preserves the remaining console stdin', async () => {
  const environment = { PORT: '31000', TOKEN: 'inert-test-secret', DATABASE_URL: 'https://example.invalid/a?x="quoted"', LABEL: 'Tiếng Việt' };
  const result = await handoff(JSON.stringify(environment) + '\nnext console line\n'); assert.equal(result.code, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { executable: '/runtime/node/bin/node', arguments: ['/runtime/node/bin/node', '/workspace/server.js', 'literal;$(no-shell)'], environment, rest: 'next console line\n' });
});

test('post-drop handoff rejects malformed/unterminated/oversized frames without echoing secret input', async () => {
  for (const input of ['not-json inert-test-secret\n', JSON.stringify({ TOKEN: 'inert-test-secret' }), JSON.stringify({ TOKEN: null }) + '\n', JSON.stringify({ 'BAD=NAME': 'inert-test-secret' }) + '\n', JSON.stringify({ TOKEN: 'nul\0value' }) + '\n', JSON.stringify({ TOKEN: 'inert-test-secret' + 'x'.repeat(96 * 1024) }) + '\n']) {
    const result = await handoff(input); assert.equal(result.code, 126); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Application environment handoff failed.\n'); assert.equal(result.stderr.includes('inert-test-secret'), false);
  }
});
