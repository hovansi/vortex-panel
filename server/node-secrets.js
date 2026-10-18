import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Separate key/context from TOTP; metadata-only exports contain ciphertext.
export function createNodeSecrets(dataDir, { ephemeral = false } = {}) {
  let key = randomBytes(32);
  if (!ephemeral) {
    const filename = path.join(dataDir, '.node-key');
    try { fs.writeFileSync(filename, key, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== 32) throw new Error('Invalid node secret key. Restore .node-key with panel data.');
    fs.chmodSync(filename, 0o600); key = fs.readFileSync(filename);
  }
  return {
    seal(value, id) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(value)) throw Object.assign(new Error('Node token must contain 43–256 letters, digits, underscores or hyphens.'), { status: 400 });
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`vortex-node-token:${id}`));
      const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${content.toString('base64')}`;
    },
    open(record, id) {
      if (typeof record !== 'string' || record.length > 512) throw new Error('Invalid encrypted node token.');
      const [version, iv, tag, content, extra] = record.split(':');
      if (version !== 'v1' || extra !== undefined || !/^[a-f0-9]{24}$/.test(iv || '') || !/^[a-f0-9]{32}$/.test(tag || '') || !/^[A-Za-z0-9+/]+={0,2}$/.test(content || '')) throw new Error('Invalid encrypted node token.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
      decipher.setAAD(Buffer.from(`vortex-node-token:${id}`)); decipher.setAuthTag(Buffer.from(tag, 'hex'));
      const value = Buffer.concat([decipher.update(Buffer.from(content, 'base64')), decipher.final()]).toString('utf8');
      if (!/^[A-Za-z0-9_-]{43,256}$/.test(value)) throw new Error('Invalid encrypted node token.');
      return value;
    },
  };
}
