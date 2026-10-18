import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNodeSecrets } from '../server/node-secrets.js';

const token = 'fixture_only_'.repeat(4), firstId = 'node-a', secondId = 'node-b';
async function directory(t) { const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-secrets-')); t.after(() => fs.rm(folder, { recursive: true, force: true })); return folder; }
test('node credentials use randomized contextual ciphertext, remain private at rest and reopen after key reload', async t => {
  const folder = await directory(t), vault = createNodeSecrets(folder), sealed = vault.seal(token, firstId), second = vault.seal(token, firstId);
  assert.notEqual(sealed, second); assert.equal(sealed.includes(token), false); assert.equal(JSON.stringify({ tokenEncrypted: sealed }).includes(token), false);
  assert.equal(vault.open(sealed, firstId), token); assert.equal(createNodeSecrets(folder).open(sealed, firstId), token); assert.throws(() => vault.open(sealed, secondId));
  const key = await fs.readFile(path.join(folder, '.node-key')); assert.equal(key.length, 32); assert.equal(key.includes(Buffer.from(token)), false);
  if (process.platform !== 'win32') { assert.equal((await fs.stat(path.join(folder, '.node-key'))).mode & 0o777, 0o600); await fs.chmod(path.join(folder, '.node-key'), 0o644); createNodeSecrets(folder); assert.equal((await fs.stat(path.join(folder, '.node-key'))).mode & 0o777, 0o600); }
});
test('wrong context, authentication-tag/ciphertext corruption and malformed records fail without plaintext', async t => {
  const vault = createNodeSecrets(await directory(t)), sealed = vault.seal(token, firstId), pieces = sealed.split(':');
  pieces[2] = (pieces[2][0] === '0' ? '1' : '0') + pieces[2].slice(1); assert.throws(() => vault.open(pieces.join(':'), firstId));
  const body = sealed.split(':'); body[3] = (body[3][0] === 'A' ? 'B' : 'A') + body[3].slice(1); assert.throws(() => vault.open(body.join(':'), firstId));
  for (const record of ['', 'v9:bad', sealed + ':extra', 'x'.repeat(513)]) assert.throws(() => vault.open(record, firstId));
  for (const value of ['short', 'x'.repeat(257), 'bad token'.repeat(5)]) assert.throws(() => vault.seal(value, firstId), { status: 400 });
});
test('missing/wrong-sized/replaced keys cannot silently decrypt old records; hardlinked key paths are rejected', async t => {
  const folder = await directory(t), keyFile = path.join(folder, '.node-key'), vault = createNodeSecrets(folder), sealed = vault.seal(token, firstId);
  await fs.unlink(keyFile); const changed = createNodeSecrets(folder); assert.throws(() => changed.open(sealed, firstId));
  await fs.writeFile(keyFile, Buffer.alloc(31)); assert.throws(() => createNodeSecrets(folder), /Invalid node secret key/);
  await fs.unlink(keyFile); await fs.writeFile(keyFile, Buffer.alloc(32), { mode: 0o600 }); await fs.link(keyFile, path.join(folder, 'linked-key')); assert.throws(() => createNodeSecrets(folder), /Invalid node secret key/);
});
