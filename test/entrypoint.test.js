import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('panel starts through a release directory symlink and releases its data lock on shutdown', { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-entrypoint-'));
  const alias = path.join(directory, 'current');
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dataDir = path.join(directory, 'data');
  const child = spawn(process.execPath, [path.join(alias, 'server/index.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, DEMO_MODE: 'false', SETUP_TOKEN: 'entrypoint-test-only' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) { child.kill(); await exited; } await fs.rm(directory, { recursive: true, force: true }); });
  let health;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) assert.fail('Entry point exited before readiness: ' + output);
    try { const response = await fetch(`http://127.0.0.1:${port}/healthz`); if (response.ok) { health = await response.json(); break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.service, 'vortex-mc', output);
  assert.equal(health.processId, child.pid, 'Readiness must identify the actual Node process launched through the release symlink');
  assert.equal((await fs.stat(path.join(dataDir, 'panel.lock'))).isFile(), true);
  child.kill('SIGTERM'); await exited;
  if (process.platform !== 'win32') assert.equal(await fs.stat(path.join(dataDir, 'panel.lock')).then(() => true, () => false), false);
});
