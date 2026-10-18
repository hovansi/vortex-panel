import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeBase32, hotp, verifyTotp, generateSecret, generateRecoveryCodes, consumeRecoveryCode, createSecretVault, otpauthUrl } from '../server/mfa.js';

test('TOTP matches RFC6238 SHA1/SHA256/SHA512 vectors including post2038 times', () => {
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  const seeds = ['12345678901234567890', '12345678901234567890123456789012', '1234567890123456789012345678901234567890123456789012345678901234'];
  for (const [time, ...expected] of vectors) ['sha1', 'sha256', 'sha512'].forEach((algorithm, index) => assert.equal(hotp(encodeBase32(Buffer.from(seeds[index])), Math.floor(time / 30), { digits: 8, algorithm }), expected[index]));
});

test('TOTP bounds clock drift, rejects replay, and recovery hashes are singleuse caller consumable', () => {
  const secret = generateSecret(), now = 1234567890000, counter = Math.floor(now / 30000);
  assert.equal(secret.length, 32);
  const code = hotp(secret, counter);
  assert.equal(verifyTotp(secret, code, { now }), counter);
  assert.equal(verifyTotp(secret, code, { now, lastCounter: counter }), null);
  assert.equal(verifyTotp(secret, hotp(secret, counter - 2), { now }), null);
  assert.equal(verifyTotp(secret, '123', { now }), null);
  assert.equal(verifyTotp('malformed', code, { now }), null);
  const recovery = generateRecoveryCodes();
  assert.equal(new Set(recovery.codes).size, 10);
  assert.equal(consumeRecoveryCode(recovery.codes[3].toLowerCase(), recovery.hashes), 3);
  recovery.hashes.splice(3, 1);
  assert.equal(consumeRecoveryCode(recovery.codes[3], recovery.hashes), -1);
  assert.equal(consumeRecoveryCode('invalid', recovery.hashes), -1);
  assert.ok(otpauthUrl(secret, 'admin').startsWith('otpauth://totp/Vortex%20Panel:admin?'));
  const legacy = 'ABCDEF-123456-ABCDEF-123456';
  assert.equal(consumeRecoveryCode(legacy, [createHash('sha256').update(`Vortex MC recovery:${legacy.replaceAll('-', '')}`).digest('hex')]), 0);
});

test('MFA vault survives restart and rejects wrong account, key and ciphertext', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-mfa-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const secret = generateSecret(), vault = createSecretVault(dataDir), sealed = vault.seal(secret, 'user1');
  assert.equal(sealed.includes(secret), false);
  assert.equal(createSecretVault(dataDir).open(sealed, 'user1'), secret);
  assert.throws(() => vault.open(sealed, 'user2'));
  assert.throws(() => createSecretVault(dataDir, { ephemeral: true }).open(sealed, 'user1'));
  assert.throws(() => vault.open(sealed.replace(/.$/, '*'), 'user1'));
  assert.equal((await fs.stat(path.join(dataDir, '.mfa-key'))).size, 32);
});
