import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { createManager } from '../server/manager.js';
import { createStore } from '../server/store.js';
import { createPortAllocator } from '../server/port-allocation.js';
import { defaultUdpPorts } from '../server/safety.js';
import { createDirectoryStorageFixture, directoryFixtureHost } from '../test/storage-fixture.js';

async function archive(filename, version) {
  const output = createWriteStream(filename), zip = archiver('zip');
  const finished = new Promise((resolve, reject) => { output.once('close', resolve); output.once('error', reject); zip.once('error', reject); });
  zip.pipe(output);
  const elf = Buffer.alloc(4096); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
  zip.append(elf, { name: 'bedrock_server' });
  zip.append(`server-name=Package ${version}\nserver-port=19132\nserver-portv6=19133\ntransport=nethernet\nserver-udp-ports=19134-19165\nmax-players=20\n`, { name: 'server.properties' });
  await zip.finalize(); await finished;
}
async function finish(manager, id) {
  for (let n = 0; n < 400; n++) {
    const job = manager.jobs().find(row => row.id === id);
    if (['completed', 'failed'].includes(job.status)) { assert.equal(job.status, 'completed', job.message); return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Offline package job did not finish');
}
test('fresh offline ZIP install keeps the allocated NetherNet range over package defaults, clone uses its own range, and upgrade preserves custom mappings', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-autoports-package-')), store = createStore(dataDir);
  const manager = await createManager({ store, dataDir, demo: false, hostReader: directoryFixtureHost, storageController: createDirectoryStorageFixture(dataDir), portAllocator: createPortAllocator({ random: () => 0, readInventory: async () => ({ ports: [], ephemeral: [32768, 60999], reserved: [] }) }) });
  t.after(async () => { await manager.close(); assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir())); assert.ok(path.basename(dataDir).startsWith('vortex-autoports-package-')); await fs.rm(dataDir, { recursive: true, force: true }); });
  for (const version of ['1.26.52.3', '1.26.52.4']) { const filename = path.join(dataDir, version + '.zip'); await archive(filename, version); await manager.importVersion(filename, version, 'stable'); }
  const accepted = await manager.createServer({ name: 'Allocated actual package', version: '1.26.52.3', eula: true, portAllocation: 'auto' });
  await finish(manager, accepted.job.id);
  const server = manager.getServer(accepted.server.id), properties = await manager.properties(server.id);
  assert.equal(server.port, accepted.server.port); assert.equal(server.portV6, accepted.server.portV6);
  assert.equal(properties['server-port'], String(accepted.server.port)); assert.equal(properties['server-portv6'], String(accepted.server.portV6));
  assert.equal(server.udpPorts, accepted.server.udpPorts); assert.equal(properties['server-udp-ports'], accepted.server.udpPorts);
  assert.equal(server.udpPorts, defaultUdpPorts(server.port, server.maxPlayers)); assert.notEqual(server.udpPorts, '19134-19165');
  const clone = await manager.cloneServer(server.id, { name: 'Allocated actual clone', eula: true, portAllocation: 'auto' }); await finish(manager, clone.job.id);
  assert.notEqual(clone.server.port, server.port); assert.equal((await manager.properties(clone.server.id))['server-udp-ports'], defaultUdpPorts(clone.server.port, server.maxPlayers));
  const custom = '31000-31031'; await manager.saveConfiguration(server.id, { properties: { 'server-udp-ports': custom }, udpMode: 'custom' });
  const upgraded = await manager.upgrade(server.id, { version: '1.26.52.4', channel: 'stable' }); await finish(manager, upgraded.id);
  assert.equal(manager.getServer(server.id).udpPorts, custom); assert.equal((await manager.properties(server.id))['server-udp-ports'], custom);
  t.diagnostic('Real offline ZIP extraction/install/clone/upgrade/properties with directory storage and inert ELF header; no runtime execution or kernel quota claim.');
});
