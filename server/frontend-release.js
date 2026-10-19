import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const FRONTEND_ASSET_PREFIX = '/_vortex/frontend';
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]+)?$/;
const need = (value, message) => { if (!value) throw Error(`Frontend release: ${message}`); };
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);

// Snapshot a single release at startup. Relative ESM imports, including lazy
// imports, inherit its URL namespace instead of mixing with a later release.
export function createFrontendRelease({ publicDir, version, maxFiles = 256, maxFileBytes = 2 * 1024 ** 2, maxBytes = 16 * 1024 ** 2 } = {}) {
  need(typeof publicDir === 'string' && versionPattern.test(version || ''), 'a public directory and valid version are required');
  const root = path.resolve(publicDir), managed = process.platform === 'linux' && /^\/opt\/vortex-panel\/releases\//.test(root);
  const uid = process.platform === 'linux' ? managed ? 0 : process.getuid?.() : undefined;
  need(fs.realpathSync(root) === root, 'the public directory must not traverse symlinks');
  const files = new Map(); let total = 0;
  function ownership(info) { need(uid === undefined || info.uid === uid && !(info.mode & 0o022), 'source ownership or write permissions are unsafe'); }
  function walk(directory, relative = '') {
    const info = fs.lstatSync(directory); need(info.isDirectory() && !info.isSymbolicLink(), 'source directories must be regular'); ownership(info);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name, filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(filename, name); continue; }
      if (!/\.(?:js|css)$/.test(name) && name !== 'index.html') continue;
      need(!entry.isSymbolicLink() && files.size < maxFiles, 'source links or excessive file count are refused');
      const before = fs.lstatSync(filename); ownership(before);
      need(before.isFile() && before.nlink === 1 && before.size <= maxFileBytes, 'source files must be bounded regular files');
      const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        need(same(before, fs.fstatSync(descriptor)), 'source changed while opening');
        const buffer = Buffer.alloc(Math.min(maxFileBytes + 1, before.size + 1)); let size = 0, count;
        while (size < buffer.length && (count = fs.readSync(descriptor, buffer, size, buffer.length - size, size))) size += count;
        need(size === before.size && size <= maxFileBytes && same(before, fs.fstatSync(descriptor)) && same(before, fs.lstatSync(filename)), 'source changed while reading');
        total += size; need(total <= maxBytes, 'source exceeds its byte limit');
        files.set(name, Buffer.from(buffer.subarray(0, size)));
      } finally { fs.closeSync(descriptor); }
    }
  }
  walk(root);
  need(files.has('index.html') && files.has('app.js'), 'required entry points are missing');
  const hash = createHash('sha256').update(version).update('\0');
  for (const name of [...files.keys()].sort()) { const body = files.get(name); hash.update(name).update('\0').update(String(body.length)).update('\0').update(body); }
  const buildId = hash.digest('hex'), prefix = `${FRONTEND_ASSET_PREFIX}/${buildId}/`;
  let html = files.get('index.html').toString('utf8');
  need((html.match(/<\/head>/gi) || []).length === 1 && !/name=["']vortex-frontend-(?:version|build)["']/i.test(html), 'HTML release metadata is ambiguous');
  html = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=)(["'])(\/[^"'?#]+\.(?:js|css))([?#][^"']*)?\2/gi, (_all, opening, quote, filename, suffix = '') => {
    const name = filename.slice(1); need(files.has(name), `entry point is outside the source snapshot: ${name}`);
    return `${opening}${quote}${prefix}${name}${suffix}${quote}`;
  }).replace(/<\/head>/i, `  <meta name="vortex-frontend-version" content="${version}">\n  <meta name="vortex-frontend-build" content="${buildId}">\n</head>`);
  return Object.freeze({ version, buildId, html, prefix,
    asset(requestedBuild, name) {
      if (requestedBuild !== buildId || typeof name !== 'string' || !/\.(?:js|css)$/.test(name) || !files.has(name)) return null;
      const body = files.get(name);
      return { body: Buffer.from(body), contentType: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable', etag: `"${createHash('sha256').update(body).digest('hex')}"` };
    } });
}
