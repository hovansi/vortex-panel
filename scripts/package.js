import fs from 'node:fs/promises';
import path from 'node:path';
import { collectPublicFiles, buildZip } from './release.js';

const files = await collectPublicFiles();
const version = JSON.parse(files.find(file => file.name === 'package.json').content.toString('utf8')).version;
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('STABLE_PACKAGE_VERSION_REQUIRED');
try { await fs.mkdir('output'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const directory = await fs.lstat('output');
if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('REGULAR_OUTPUT_DIRECTORY_REQUIRED');
const destination = path.resolve(`output/vortex-panel-${version}.zip`);
const result = await buildZip(destination, files);
console.log(`${destination} (${result.bytes} bytes)`);
