import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import archiver from 'archiver';
import { createStore } from '../server/store.js';
import { createManager } from '../server/manager.js';
import { serializeProperties } from '../server/safety.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from './storage-fixture.js';

// These small disk fixtures validate metadata/transactions/transport. Their
// LevelDB record bytes are intentionally inert, not a playable native world.
const text = value => { const bytes = Buffer.from(value), length = Buffer.alloc(2); length.writeUInt16LE(bytes.length); return Buffer.concat([length, bytes]); };
const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; };
const long = value => { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(BigInt(value)); return bytes; };
const tag = (type, name, bytes) => Buffer.concat([Buffer.from([type]), text(name), bytes]);
export function levelDat(name = 'Opaque world <img src=x> & English') {
  const body = Buffer.concat([Buffer.from([10]), text(''), tag(8, 'LevelName', text(name)), tag(3, 'StorageVersion', int(10)), tag(4, 'RandomSeed', long('-9223372036854775808')), Buffer.from([0])]);
  const header = Buffer.alloc(8); header.writeUInt32LE(10, 0); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
export async function writeWorld(root, name = 'Opaque world <img src=x> & English') {
  await fs.mkdir(path.join(root, 'db'), { recursive: true });
  await fs.mkdir(path.join(root, 'structures', 'empty'), { recursive: true });
  await fs.writeFile(path.join(root, 'level.dat'), levelDat(name));
  await fs.writeFile(path.join(root, 'levelname.txt'), name + '\n');
  await fs.writeFile(path.join(root, 'db', 'CURRENT'), 'MANIFEST-000001\n');
  await fs.writeFile(path.join(root, 'db', 'MANIFEST-000001'), 'Inert manifest fixture, not native LevelDB.');
  await fs.writeFile(path.join(root, 'db', '000002.ldb'), 'Inert table fixture, not a playable Minecraft world.');
}
export async function zipEntries(destination, entries, { store = false } = {}) {
  const output = createWriteStream(destination), archive = archiver('zip', { store });
  const completed = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output);
  for (const entry of entries) {
    if (entry.symlink) archive.symlink(entry.name, entry.symlink);
    else archive.append(entry.content || '', { name: entry.name, ...(entry.directory ? { type: 'directory', mode: 0o700 } : {}) });
  }
  await Promise.all([archive.finalize(), completed]);
}
export async function fingerprints(root, relative = '') {
  const result = {};
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { result[name + '/'] = 'directory'; Object.assign(result, await fingerprints(root, name)); }
    else if (entry.isSymbolicLink()) result[name] = 'link:' + await fs.readlink(path.join(root, name));
    else result[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
  }
  return result;
}
export async function operationFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-world-operations-'));
  const store = createStore(dataDir);
  const server = { id: randomUUID(), name: 'Actual bytes fixture', status: 'stopped', version: '1.26.52.3', channel: 'stable', port: 32000, portV6: 32001, transport: 'raknet', maxPlayers: 10, backups: [], backupRetention: 2, runtimeFiles: ['bedrock_server'], createdAt: new Date().toISOString() };
  store.data.servers.push(server);
  const run = path.join(dataDir, 'servers', server.id, 'run'); await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, 'bedrock_server'), 'Inert fixture. It must never be executed.');
  await fs.writeFile(path.join(run, 'server.properties'), serializeProperties({ 'server-name': server.name, 'server-port': server.port, 'server-portv6': server.portV6, transport: 'raknet', 'max-players': 10, 'enable-lan-visibility': false, 'level-name': 'Main', 'level-seed': '', 'online-mode': true, 'allow-list': false }));
  await fs.mkdir(path.join(run, 'keys')); await fs.writeFile(path.join(run, 'keys', 'server_identity_key.pem'), 'Sensitive identity fixture; not a usable private key.');
  await writeWorld(path.join(run, 'worlds', 'Main'));
  store.save(); const save = store.save;
  const manager = await createManager({ store, dataDir, demo: false, storageController: createDirectoryStorageFixture(dataDir), hostReader: directoryFixtureHost });
  t.after(async () => { store.save = save; server.status = 'stopped'; await manager.close(); assertWithinFixture(dataDir); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, save, server, run, manager };
}
function assertWithinFixture(directory) {
  if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('vortex-world-operations-')) throw Error('Unsafe fixture cleanup target');
}
export async function waitJob(manager, id, expected = 'completed') {
  for (let count = 0; count < 600; count++) {
    const job = manager.jobs().find(item => item.id === id);
    if (['completed', 'failed'].includes(job?.status)) { if (job.status !== expected) throw Error(`Unexpected job ${job.status}: ${job.message}`); return job; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Timed out waiting for isolated job');
}
