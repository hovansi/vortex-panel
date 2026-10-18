import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(directory) {
  let files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(name));
    else if (name.endsWith('.js')) files.push(name);
  }
  return files;
}
for (const file of (await Promise.all(['server', 'public', 'scripts', 'test'].map(walk))).flat()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('JavaScript syntax OK');
