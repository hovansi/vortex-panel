import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipDirectory } from '../server/archives.js';
import { operationFixture, writeWorld, fingerprints, waitJob } from './worlds-fixture.js';

const manifest = (header = randomUUID(), module = randomUUID(), name = 'Opaque pack <img src=x> & English') => ({ format_version: 2, header: { uuid: header, name, description: 'Inert resource fixture', version: [1, 0, 0], min_engine_version: [1, 26, 0] }, modules: [{ uuid: module, type: 'resources', version: [1, 0, 0] }] });
async function pack(root, name, value) {
  const directory = path.join(root, 'resource_packs', name); await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(value));
}

test('world pack headers and modules cannot collide with either global header or module UUIDs, including uppercase IDs', async t => {
  const x = await operationFixture(t), globalHeader = randomUUID(), globalModule = randomUUID();
  await pack(x.run, 'shared', manifest(globalHeader, globalModule, 'Shared pack'));
  const source = path.join(x.dataDir, 'collision-source'); await writeWorld(source);
  const before = await fingerprints(x.run);
  for (const [index, header, module] of [[0, globalHeader, randomUUID()], [1, globalModule, randomUUID()], [2, randomUUID(), globalHeader], [3, randomUUID(), globalModule.toUpperCase()]]) {
    await pack(source, 'embedded', manifest(header, module));
    const archive = path.join(x.dataDir, `collision-${index}.mcworld`); await zipDirectory(source, archive, { includeEmptyDirectories: true });
    const result = await waitJob(x.manager, (await x.manager.importWorld(x.server.id, archive, { name: `Collision ${index}`, filename: 'collision.mcworld' })).id, 'failed');
    assert.match(result.message, /UUID pack hoặc module của world trùng với pack dùng chung/);
    assert.ok(result.message.startsWith('Opaque pack <img src=x> & English:'));
    assert.deepEqual(await fingerprints(x.run), before);
    assert.equal(await fs.stat(path.join(x.run, 'worlds', `Collision ${index}`)).catch(() => null), null);
  }
});

test('a script-only manifest without executable files reports unsupported Script API rather than a directory mismatch', async t => {
  const x = await operationFixture(t), source = path.join(x.dataDir, 'script-only'); await writeWorld(source);
  const value = manifest(); value.modules[0].type = 'script';
  await pack(source, 'script-fixture', value);
  const archive = path.join(x.dataDir, 'script-only.mcworld'); await zipDirectory(source, archive, { includeEmptyDirectories: true });
  const before = await fingerprints(x.run), result = await waitJob(x.manager, (await x.manager.importWorld(x.server.id, archive, { name: 'Rejected script-only', filename: 'script.mcworld' })).id, 'failed');
  assert.match(result.message, /^resource_packs\/script-fixture: pack của world không được hỗ trợ: Module script/);
  assert.match(result.message, /không cài Script API/); assert.equal(result.message.includes('loại pack không khớp'), false);
  assert.deepEqual(await fingerprints(x.run), before);
});

test('an invalid shared dependency reports the same actionable unsupported-pack prefix and preserves both trees', async t => {
  const x = await operationFixture(t), globalId = randomUUID(), global = manifest(globalId, randomUUID(), 'Global unsupported <img src=x> & English'); global.format_version = 1;
  await pack(x.run, 'invalid-shared', global);
  const source = path.join(x.dataDir, 'invalid-dependency'); await writeWorld(source);
  const local = manifest(); local.dependencies = [{ uuid: globalId, version: [1, 0, 0] }]; await pack(source, 'dependent', local);
  await fs.writeFile(path.join(source, 'world_resource_packs.json'), JSON.stringify([{ pack_id: local.header.uuid, version: [1, 0, 0] }]));
  const archive = path.join(x.dataDir, 'invalid-dependency.mcworld'); await zipDirectory(source, archive, { includeEmptyDirectories: true });
  const before = await fingerprints(x.run), sourceBefore = await fingerprints(source);
  const result = await waitJob(x.manager, (await x.manager.importWorld(x.server.id, archive, { name: 'Rejected dependency', filename: 'dependency.mcworld' })).id, 'failed');
  assert.equal(result.message, 'Global unsupported <img src=x> & English: pack của world không được hỗ trợ: Panel hiện hỗ trợ manifest format_version=2.');
  assert.deepEqual(await fingerprints(x.run), before); assert.deepEqual(await fingerprints(source), sourceBefore);
});
