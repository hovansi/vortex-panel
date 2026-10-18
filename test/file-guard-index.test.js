import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManager } from '../server/manager.js';

test('indexed runtime guards protect all ancestors, fresh package paths, identity and world state while allowing sibling data', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-guard-index-'));
  const server = { id: randomUUID(), name: 'Guard fixture', status: 'stopped', runtimeFiles: ['bedrock_server', 'engine/nested/deep/runtime.txt'], demoFiles: { 'server.properties': 'level-name=Main\n', 'engine/nested/deep/runtime.txt': 'Runtime bytes', 'engine-sibling/notes.txt': 'User bytes', 'keys/server_identity_key.pem': 'Identity bytes', 'worlds/Main/marker.txt': 'World bytes', 'late-runtime/new.txt': 'Next package bytes' }, demoDirs: ['engine', 'engine/nested', 'engine/nested/deep', 'engine-sibling', 'keys', 'worlds', 'worlds/Main', 'late-runtime'], createdAt: new Date().toISOString() };
  const store = { data: { servers: [server], users: [], versions: [], jobs: [], schedules: [], activity: [], settings: {} }, save() {}, audit() {} };
  const manager = await createManager({ store, dataDir, demo: true }); t.after(async () => { await manager.close(); assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dataDir).startsWith('vortex-guard-index-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  const root = await manager.files(server.id); assert.equal(root.files.find(item => item.path === 'engine').capabilities.rename, false); assert.equal(root.files.find(item => item.path === 'engine-sibling').capabilities.rename, true);
  for (const source of ['engine', 'engine/nested', 'engine/nested/deep', 'engine/nested/deep/runtime.txt', 'keys', 'worlds', 'worlds/Main', 'server.properties']) await assert.rejects(manager.renameFile(server.id, { source, destination: 'must-not-exist' }), error => [403, 409].includes(error.status));
  await manager.renameFile(server.id, { source: 'engine-sibling', destination: 'safe-sibling' }); assert.equal(server.demoFiles['safe-sibling/notes.txt'], 'User bytes');
  server.runtimeFiles = [...server.runtimeFiles, 'late-runtime/new.txt'];
  assert.equal((await manager.files(server.id)).files.find(item => item.path === 'late-runtime').capabilities.rename, false); await assert.rejects(manager.renameFile(server.id, { source: 'late-runtime', destination: 'moved-late' }), error => error.status === 403);
  assert.equal(server.demoFiles['engine/nested/deep/runtime.txt'], 'Runtime bytes'); assert.equal(server.demoFiles['late-runtime/new.txt'], 'Next package bytes'); assert.equal(server.demoFiles['worlds/Main/marker.txt'], 'World bytes');
});
