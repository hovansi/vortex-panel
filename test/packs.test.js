import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { importPacks, inspectPacks, setPackEnabled, removePack, parsePackManifest } from '../server/packs.js';

const version = [1, 0, 0];
function manifest(kind, uuid = randomUUID(), dependencies = []) {
  return { format_version: 2, header: { name: `${kind} fixture`, description: 'Test data only', uuid, version, min_engine_version: [1, 21, 0] }, modules: [{ type: kind === 'behavior' ? 'data' : 'resources', uuid: randomUUID(), version }], dependencies };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-packs-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'run'); await fs.mkdir(path.join(root, 'worlds', 'Main'), { recursive: true });
  return { directory, root, options: { levelName: 'Main', serverVersion: '1.26.52.3', runtimeFiles: [] } };
}
async function zip(destination, entries, symlink = false) {
  const output = createWriteStream(destination); const archive = archiver('zip');
  const done = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); }); archive.pipe(output);
  for (const [name, contents] of Object.entries(entries)) archive.append(contents, { name });
  if (symlink) archive.symlink('linked', '../../escape');
  await archive.finalize(); await done;
}
const refs = (root, name, kind) => path.join(root, 'worlds', name, `world_${kind}_packs.json`);

test('manifest inspection rejects unsupported formats, scripts and duplicate module identities', () => {
  const pack = manifest('behavior'); assert.deepEqual(parsePackManifest(pack).errors, []);
  for (const mutation of [value => value.format_version = 3, value => value.header.version = '1.0.0', value => value.modules[0].uuid = value.header.uuid, value => value.modules[0].type = 'script', value => value.dependencies = [{ module_name: '@minecraft/server', version: '2.0.0' }]]) {
    const invalid = structuredClone(pack); mutation(invalid); assert.ok(parsePackManifest(invalid).errors.length);
  }
  assert.ok(parsePackManifest(pack, { serverVersion: '1.20.0.0' }).errors.some(error => error.includes('yêu cầu Minecraft')));
  for (const scope of ['world', 'any']) { const resource = manifest('resource'); resource.header.pack_scope = scope; assert.deepEqual(parsePackManifest(resource).errors, []); }
  for (const scope of ['global', 'unknown']) { const resource = manifest('resource'); resource.header.pack_scope = scope; assert.ok(parsePackManifest(resource).errors.some(error => error.includes('pack_scope'))); }
});

test('real mcaddon import activates exact dependencies, preserves registrations and removes references from all worlds', async t => {
  const { directory, root, options } = await fixture(t);
  const resource = manifest('resource'); const behavior = manifest('behavior', randomUUID(), [{ uuid: resource.header.uuid, version }]);
  const archive = path.join(directory, 'bundle.mcaddon');
  await zip(archive, { 'wrapper/behavior/manifest.json': JSON.stringify(behavior), 'wrapper/behavior/entities/test.json': '{}', 'wrapper/resource/manifest.json': JSON.stringify(resource), 'wrapper/resource/textures/test.txt': 'texture fixture' });
  const imported = await importPacks(root, archive, { ...options, filename: 'bundle.mcaddon' }); assert.equal(imported.packs.length, 2);
  const untouched = { pack_id: randomUUID(), version: [8, 4, 2], custom: { retain: true } };
  await fs.writeFile(refs(root, 'Main', 'behavior'), JSON.stringify([untouched]));
  const activated = await setPackEnabled(root, behavior.header.uuid, true, options); assert.equal(activated.activated.length, 2);
  const behaviorRefs = JSON.parse(await fs.readFile(refs(root, 'Main', 'behavior'), 'utf8')); assert.deepEqual(behaviorRefs[0], untouched); assert.equal(behaviorRefs[1].pack_id, behavior.header.uuid);
  assert.equal(JSON.parse(await fs.readFile(refs(root, 'Main', 'resource'), 'utf8'))[0].pack_id, resource.header.uuid);
  const inspected = await inspectPacks(root, options); assert.equal(inspected.packs.filter(pack => pack.enabled).length, 2); assert.equal(inspected.world.exists, true);
  await assert.rejects(setPackEnabled(root, resource.header.uuid, false, options), /đang bật và cần/);
  await assert.rejects(removePack(root, resource.header.uuid, options), /đang cần/);
  await setPackEnabled(root, behavior.header.uuid, false, options);
  await fs.mkdir(path.join(root, 'worlds', 'Inactive')); await fs.writeFile(refs(root, 'Inactive', 'behavior'), JSON.stringify([untouched, { pack_id: behavior.header.uuid, version, extra: 'retain others' }]));
  const removed = await removePack(root, behavior.header.uuid, options); assert.equal(removed.ok, true); assert.equal(removed.worldsUpdated, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(refs(root, 'Inactive', 'behavior'), 'utf8')), [untouched]);
  assert.equal((await inspectPacks(root, options)).packs.length, 1);
  const resourcePack = imported.packs.find(pack => pack.kind === 'resource');
  await assert.rejects(removePack(root, resource.header.uuid, { ...options, runtimeFiles: [`${resourcePack.folder}/manifest.json`] }), /được bảo vệ/);
  await assert.rejects(importPacks(root, archive, { ...options, filename: 'bundle.mcaddon' }), /đã tồn tại/);
});

test('nested mcpack bundles install with normalized roots and missing dependency fails without activation', async t => {
  const { directory, root, options } = await fixture(t); const pack = manifest('behavior');
  const inner = path.join(directory, 'inner.mcpack'); await zip(inner, { 'Nested/manifest.json': JSON.stringify(pack), 'Nested/blocks/test.json': '{}' });
  const outer = path.join(directory, 'outer.mcaddon'); await zip(outer, { 'inner.mcpack': await fs.readFile(inner) });
  const result = await importPacks(root, outer, { ...options, filename: 'outer.mcaddon' }); assert.equal(result.packs[0].folder, `behavior_packs/vortex-${pack.header.uuid}`);
  assert.equal(await fs.readFile(path.join(root, result.packs[0].folder, 'blocks/test.json'), 'utf8'), '{}');
  const missing = manifest('behavior', randomUUID(), [{ uuid: randomUUID(), version }]);
  const invalid = path.join(directory, 'missing.mcpack'); await zip(invalid, { 'manifest.json': JSON.stringify(missing) });
  await assert.rejects(importPacks(root, invalid, { ...options, filename: 'missing.mcpack' }), /Không tìm thấy pack/);
  assert.equal((await inspectPacks(root, options)).packs.length, 1);
  const world = path.join(directory, 'world.mcaddon'); await zip(world, { 'unsupported.mcworld': 'content' }); await assert.rejects(importPacks(root, world, { ...options, filename: 'world.mcaddon' }), /chỉ cài pack/);
});

test('addon durable commit failures roll back imported folders, both world registrations and removal', async t => {
  const { directory, root, options } = await fixture(t); const resource = manifest('resource'); const behavior = manifest('behavior', randomUUID(), [{ uuid: resource.header.uuid, version }]);
  const archive = path.join(directory, 'atomic.mcaddon'); await zip(archive, { 'BP/manifest.json': JSON.stringify(behavior), 'RP/manifest.json': JSON.stringify(resource) });
  const failing = { ...options, onCommit() { throw new Error('Injected durable audit failure'); } };
  await assert.rejects(importPacks(root, archive, { ...failing, filename: 'atomic.mcaddon' }), /audit failure/); assert.equal((await inspectPacks(root, options)).packs.length, 0);
  const imported = await importPacks(root, archive, { ...options, filename: 'atomic.mcaddon' });
  const original = '[\n  {"pack_id":"keep-me","version":[4,0,0],"custom":true}\n]\n'; await fs.writeFile(refs(root, 'Main', 'behavior'), original);
  await assert.rejects(setPackEnabled(root, behavior.header.uuid, true, failing), /audit failure/);
  assert.equal(await fs.readFile(refs(root, 'Main', 'behavior'), 'utf8'), original); assert.equal(await fs.stat(refs(root, 'Main', 'resource')).catch(() => null), null);
  await setPackEnabled(root, behavior.header.uuid, true, options);
  const before = await fs.readFile(refs(root, 'Main', 'behavior'), 'utf8');
  await assert.rejects(removePack(root, behavior.header.uuid, failing), /audit failure/);
  assert.equal(await fs.readFile(refs(root, 'Main', 'behavior'), 'utf8'), before);
  assert.ok(await fs.stat(path.join(root, imported.packs.find(pack => pack.kind === 'behavior').folder)));
});

test('pack archive protections reject traversal, symlinks and oversized compressed uploads', async t => {
  const { directory, root, options } = await fixture(t); const pack = manifest('behavior');
  const archive = path.join(directory, 'traversal.mcpack'); await zip(archive, { 'manifest.json': JSON.stringify(pack), 'safe.txt': 'data' });
  const bytes = await fs.readFile(archive);
  for (let index = bytes.indexOf('safe.txt'); index >= 0; index = bytes.indexOf('safe.txt', index + 8)) bytes.write('../x.txt', index);
  await fs.writeFile(archive, bytes); await assert.rejects(importPacks(root, archive, { ...options, filename: 'traversal.mcpack' }), error => error.status === 400 && /đường dẫn không an toàn/.test(error.message));
  assert.equal(await fs.stat(path.join(directory, 'x.txt')).catch(() => null), null);
  const linked = path.join(directory, 'linked.mcpack'); await zip(linked, { 'manifest.json': JSON.stringify(pack) }, true); await assert.rejects(importPacks(root, linked, { ...options, filename: 'linked.mcpack' }), /liên kết/);
  const oversized = path.join(directory, 'huge.mcpack'); await fs.writeFile(oversized, ''); await fs.truncate(oversized, 100 * 1024 ** 2 + 1);
  await assert.rejects(importPacks(root, oversized, { ...options, filename: 'huge.mcpack' }), /100 MiB/);
  assert.equal((await inspectPacks(root, options)).packs.length, 0);
});
