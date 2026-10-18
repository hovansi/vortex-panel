import fs from 'node:fs/promises';
import path from 'node:path';

export function mountedDescendants(text, directory) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 ** 2) throw new Error('Mount inventory is unavailable.');
  const target = path.posix.resolve(directory);
  return text.trim().split('\n').filter(Boolean).map(row => {
    const fields = row.split(' ');
    if (fields.length < 10 || !fields.includes('-')) throw new Error('Mount inventory is malformed.');
    return fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  }).filter(mount => mount === target || mount.startsWith(target + '/'));
}

export async function assertUnmountedTree(directory, { platform = process.platform, readFile = fs.readFile } = {}) {
  if (platform !== 'linux') return;
  const mounts = mountedDescendants(await readFile('/proc/self/mountinfo', 'utf8'), path.posix.resolve(directory));
  if (mounts.length) throw Object.assign(new Error('The directory contains a mounted filesystem. Unmount it before deletion.'), { status: 409, code: 'MOUNTED_TREE' });
}
