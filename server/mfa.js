import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHmac, createHash, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeBase32(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decodeBase32(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]{16,128}$/.test(secret)) throw new Error('Invalid TOTP secret.');
  let bits = 0, value = 0;
  const result = [];
  for (const char of secret) {
    value = (value << 5) | alphabet.indexOf(char); bits += 5;
    if (bits >= 8) { result.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(result);
}

// RFC 4226 dynamic truncation + RFC 6238 30-second counters. No copied reference code.
export function hotp(secret, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  if (!Number.isSafeInteger(counter) || counter < 0 || ![6, 8].includes(digits) || !['sha1', 'sha256', 'sha512'].includes(algorithm)) throw new Error('Invalid TOTP parameters.');
  const value = Buffer.alloc(8); value.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, decodeBase32(secret)).update(value).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
export function generateSecret() { return encodeBase32(randomBytes(20)); }
export function verifyTotp(secret, code, { lastCounter = -1, now = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !Number.isFinite(now) || now < 0) return null;
  const current = Math.floor(now / 30000);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || counter <= lastCounter) continue;
    try { if (timingSafeEqual(Buffer.from(code), Buffer.from(hotp(secret, counter)))) return counter; } catch { return null; }
  }
  return null;
}
export function otpauthUrl(secret, username, issuer = 'Vortex Panel') {
  decodeBase32(secret);
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?${query}`;
}
function normalizedCode(code) {
  if (typeof code !== 'string' || code.length > 64) return null;
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-F0-9]{24}$/.test(normalized) ? normalized : null;
}
function recoveryHash(code) { return createHash('sha256').update(`Vortex MC recovery:${code}`).digest('hex'); }
export function generateRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').toUpperCase().match(/.{6}/g).join('-'));
  return { codes, hashes: codes.map(code => recoveryHash(normalizedCode(code))) };
}
export function consumeRecoveryCode(code, hashes) {
  const normalized = normalizedCode(code);
  if (!normalized || !Array.isArray(hashes) || hashes.length > 100) return -1;
  const actual = Buffer.from(recoveryHash(normalized), 'hex');
  return hashes.findIndex(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(actual, Buffer.from(hash, 'hex')));
}

// The key lives outside JSON metadata and is required alongside it for disaster recovery.
// Encryption protects a metadata-only export; it does not isolate secrets from root on this host.
export function createSecretVault(dataDir) {
  const filename = path.join(dataDir, '.mfa-key');
  try { fs.writeFileSync(filename, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 32) throw new Error('MFA vault key is invalid. Restore the original .mfa-key with panel data.');
  fs.chmodSync(filename, 0o600); const key = fs.readFileSync(filename);
  return {
    seal(secret, context) {
      decodeBase32(secret);
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(String(context)));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('base64')}`;
    },
    open(record, context) {
      if (typeof record !== 'string' || record.length > 1024) throw new Error('Invalid encrypted TOTP secret.');
      const [version, iv, tag, content, extra] = record.split(':');
      if (version !== 'v1' || extra !== undefined || !/^[a-f0-9]{24}$/.test(iv || '') || !/^[a-f0-9]{32}$/.test(tag || '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(content || '')) throw new Error('Invalid encrypted TOTP secret.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
      decipher.setAAD(Buffer.from(String(context))); decipher.setAuthTag(Buffer.from(tag, 'hex'));
      const secret = Buffer.concat([decipher.update(Buffer.from(content, 'base64')), decipher.final()]).toString('utf8');
      decodeBase32(secret); return secret;
    },
  };
}
