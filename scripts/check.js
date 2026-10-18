import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectPublicFiles } from './release.js';

const root = process.cwd();
const files = await collectPublicFiles(root);
const names = new Set(files.map(file => file.name));
const python = process.platform === 'win32' ? 'python' : 'python3';
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error('Source validation failed: ' + args.at(-1));
};
for (const file of files) {
  if (file.name.endsWith('.js')) run(process.execPath, ['--check', file.name]);
  if (file.name.endsWith('.py')) run(python, ['-I', '-B', '-c', 'import ast,pathlib,sys;ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"),filename=sys.argv[1])', file.name]);
  if (file.name.endsWith('.sh')) run(bash, ['-n', file.name]);
  if (file.name.endsWith('.md')) {
    for (const match of file.content.toString('utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.relative(root, path.resolve(path.dirname(path.join(root, file.name)), decodeURIComponent(target))).replaceAll('\\', '/');
      if (!names.has(resolved)) throw new Error('Unpublished documentation target: ' + file.name + ' -> ' + target);
    }
  }
}
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) throw new Error('Package versions differ');
console.log(`Production source validated: ${files.length} files, JavaScript/Python/Bash syntax, documentation links and package metadata.`);
