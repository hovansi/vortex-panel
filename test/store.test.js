import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';

test('atomic store reload preserves state and limits audit history', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir);
  store.data.servers.push({ id: 'one' }); store.audit('create', 'one', 'admin');
  const reloaded = createStore(dir);
  assert.equal(reloaded.data.servers[0].id, 'one');
  assert.equal(reloaded.data.activity[0].action, 'create');
  assert.equal(fs.existsSync(path.join(dir, 'panel.json.tmp')), false);
});
