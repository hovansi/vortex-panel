import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { zipDirectory, extractZip } from '../server/archives.js';
import { operationFixture, writeWorld, levelDat, zipEntries, fingerprints, waitJob } from './worlds-fixture.js';

test('world listing, root/wrapper import and .mcworld export preserve real opaque bytes and empty folders', async t => {
  const x = await operationFixture(t), original = await fingerprints(x.run);
  const listing = await x.manager.worlds(x.server.id);
  assert.equal(listing.current, 'Main'); assert.equal(listing.pending, null); assert.equal(listing.worlds[0].active, true);
  assert.equal(listing.worlds[0].displayName, 'Opaque world <img src=x> & English');
  assert.equal(listing.worlds[0].metadata.seed, '-9223372036854775808'); assert.equal(listing.worlds[0].validationMode, 'structural');
  assert.equal(listing.demo, false); assert.deepEqual(await fingerprints(x.run), original);
  x.server.status = 'running'; assert.equal((await x.manager.worlds(x.server.id)).worlds[0].state, 'ready'); x.server.status = 'stopped';
  const source = path.join(x.dataDir, 'source'); await writeWorld(source, 'Bản đồ · Save & English');
  const bytes = await fingerprints(source);
  for (const wrapped of [false, true]) {
    const name = wrapped ? 'Imported wrapper' : 'Imported root', archive = path.join(x.dataDir, `${name}.mcworld`);
    if (wrapped) { const outer = path.join(x.dataDir, 'outer'); await fs.mkdir(outer); await fs.cp(source, path.join(outer, 'one world'), { recursive: true }); await zipDirectory(outer, archive, { includeEmptyDirectories: true }); }
    else await zipDirectory(source, archive, { includeEmptyDirectories: true });
    const accepted = await x.manager.withActor({ username: 'world-operator' }, () => x.manager.importWorld(x.server.id, archive, { name, filename: 'single.mcworld' }));
    await fs.rm(archive); // The worker must own an independent upload copy.
    const completed = await waitJob(x.manager, accepted.id);
    assert.equal(completed.result.selected, false); assert.equal(completed.result.world.name, name);
    assert.deepEqual(await fingerprints(path.join(x.run, 'worlds', name)), bytes);
  }
  assert.equal((await x.manager.properties(x.server.id))['level-name'], 'Main');
  assert.ok(x.store.data.activity.some(event => event.action === 'world.import' && event.user === 'world-operator'));
  const artifactsBefore = (await fs.readdir(path.dirname(x.run))).filter(name => name.startsWith('.world-export-'));
  const preflight = await x.manager.exportWorldInfo(x.server.id, 'Imported root'); assert.equal(preflight.name, 'Imported root.mcworld');
  assert.deepEqual((await fs.readdir(path.dirname(x.run))).filter(name => name.startsWith('.world-export-')), artifactsBefore);
  const exported = await x.manager.exportWorld(x.server.id, 'Imported root'), unpacked = path.join(x.dataDir, 'exported');
  await extractZip(exported.path, unpacked); assert.deepEqual(await fingerprints(unpacked), bytes);
  assert.equal(await fs.stat(path.join(unpacked, 'keys')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(unpacked, 'server.properties')).catch(() => null), null);
  await exported.cleanup(); assert.equal(await fs.stat(exported.path).catch(() => null), null);
  assert.ok(!(await fs.readdir(path.dirname(x.run))).some(name => name.startsWith('.world-upload-') || name.startsWith('.world-import-')));
});

test('world selection and fresh generation intent share atomic configuration rollback without replacing old worlds', async t => {
  const x = await operationFixture(t); await writeWorld(path.join(x.run, 'worlds', 'Another'), 'Another opaque name');
  const beforeWorlds = await fingerprints(path.join(x.run, 'worlds')), beforeProperties = await fs.readFile(path.join(x.run, 'server.properties'));
  x.store.save = () => { throw Error('Injected world selection commit failure'); };
  await assert.rejects(x.manager.selectWorld(x.server.id, { name: 'Another' }), /commit failure/);
  assert.deepEqual(await fs.readFile(path.join(x.run, 'server.properties')), beforeProperties);
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), beforeWorlds);
  x.store.save = x.save;
  const selected = await x.manager.withActor({ username: 'world-operator' }, () => x.manager.selectWorld(x.server.id, { name: 'Another' }));
  assert.equal(selected.world.state, 'ready'); assert.equal(selected.configuration.properties['level-name'], 'Another');
  assert.equal(x.store.data.activity[0].action, 'world.select'); assert.equal(x.store.data.activity[0].user, 'world-operator');
  const created = await x.manager.createWorld(x.server.id, { name: 'Fresh never generated', seed: '-9223372036854775808' });
  assert.equal(created.world.state, 'pending-generation'); assert.equal(created.world.exists, false);
  const listing = await x.manager.worlds(x.server.id); assert.equal(listing.pending.name, 'Fresh never generated'); assert.equal(listing.pending.seed, '-9223372036854775808');
  assert.equal(await fs.stat(path.join(x.run, 'worlds', 'Fresh never generated')).catch(() => null), null);
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), beforeWorlds);
  await x.manager.selectWorld(x.server.id, { name: 'Another' });
  assert.equal((await x.manager.properties(x.server.id))['level-seed'], '-9223372036854775808');
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), beforeWorlds);
  await assert.rejects(x.manager.createWorld(x.server.id, { name: 'Main', seed: 'different' }), error => error.status === 409);
  await assert.rejects(x.manager.selectWorld(x.server.id, { name: 'missing' }), error => error.status === 404);
  for (const input of [{ name: '../escape' }, { name: 'bad/name' }, { name: 'bad:port' }, { name: 'Fresh', seed: 123 }, { name: 'Fresh', seed: 'injected\nvalue' }]) await assert.rejects(x.manager.createWorld(x.server.id, input), error => error.status === 400);
  x.server.status = 'running';
  for (const operation of [() => x.manager.createWorld(x.server.id, { name: 'While running' }), () => x.manager.selectWorld(x.server.id, { name: 'Main' }), () => x.manager.exportWorld(x.server.id, 'Main'), () => x.manager.deleteWorld(x.server.id, 'Main', { name: 'Main' })]) await assert.rejects(operation(), error => error.status === 409);
  x.server.status = 'stopped';
});

test('world import rejects Java, ambiguous bundles, scripts, encryption, bad CRC and unsafe paths before activation', async t => {
  const x = await operationFixture(t), before = await fingerprints(x.run);
  const basic = [{ name: 'level.dat', content: levelDat() }, { name: 'db/CURRENT', content: 'MANIFEST-000001\n' }, { name: 'db/MANIFEST-000001', content: 'fixture manifest' }, { name: 'db/000002.ldb', content: 'world payload fixture' }];
  const invalid = [
    { label: 'java', entries: [{ name: 'level.dat', content: Buffer.from([0x1f, 0x8b, 0, 0]) }, { name: 'region/r.0.0.mca', content: 'Java fixture' }], pattern: /Java/ },
    { label: 'many', entries: [...basic, ...basic.map(entry => ({ ...entry, name: 'structures/second/' + entry.name }))], pattern: /nhiều world/ },
    { label: 'script', entries: [...basic, { name: 'behavior_packs/unsupported/scripts/start.js', content: 'console.log("unsupported")' }], pattern: /mã chạy/ },
    { label: 'encrypted', entries: [...basic, { name: 'resource_packs/locked/content.key', content: 'encrypted fixture' }], pattern: /mã hóa/ },
    { label: 'identity', entries: [...basic, { name: 'keys/server_identity_key.pem', content: 'must not export identity' }], pattern: /identity/ },
    { label: 'symlink', entries: [...basic, { name: 'outside', symlink: '../../escape' }], pattern: /liên kết/ },
  ];
  for (const { label, entries, pattern } of invalid) {
    const archive = path.join(x.dataDir, `${label}.mcworld`); await zipEntries(archive, entries);
    const accepted = await x.manager.importWorld(x.server.id, archive, { name: `Rejected ${label}`, filename: `${label}.mcworld` });
    const result = await waitJob(x.manager, accepted.id, 'failed'); assert.match(result.message, pattern, label);
    assert.deepEqual(await fingerprints(x.run), before, label);
  }
  const corrupt = path.join(x.dataDir, 'corrupt.zip'); await zipEntries(corrupt, basic, { store: true });
  const corruptBytes = await fs.readFile(corrupt), offset = corruptBytes.indexOf(Buffer.from('world payload fixture')); assert.ok(offset >= 0); corruptBytes[offset] ^= 1; await fs.writeFile(corrupt, corruptBytes);
  assert.match((await waitJob(x.manager, (await x.manager.importWorld(x.server.id, corrupt, { name: 'Bad CRC', filename: 'bad.zip' })).id, 'failed')).message, /CRC-32/);
  const traversal = path.join(x.dataDir, 'traversal.zip'); await zipEntries(traversal, [{ name: 'safe.txt', content: 'must stay contained' }]);
  const traversalBytes = await fs.readFile(traversal); for (let at = traversalBytes.indexOf(Buffer.from('safe.txt')); at >= 0; at = traversalBytes.indexOf(Buffer.from('safe.txt'))) Buffer.from('../x.txt').copy(traversalBytes, at); await fs.writeFile(traversal, traversalBytes);
  assert.match((await waitJob(x.manager, (await x.manager.importWorld(x.server.id, traversal, { name: 'Bad path', filename: 'bad.zip' })).id, 'failed')).message, /đường dẫn không an toàn|Đường dẫn không hợp lệ/);
  assert.deepEqual(await fingerprints(x.run), before);
  assert.ok(!(await fs.readdir(path.dirname(x.run))).some(name => name.startsWith('.world-upload-') || name.startsWith('.world-import-')));
});

test('world imports preserve supported embedded data/resource packs and reject missing or cyclic registrations', async t => {
  const x = await operationFixture(t), source = path.join(x.dataDir, 'with-packs'); await writeWorld(source);
  const id = randomUUID(), module = randomUUID(); await fs.mkdir(path.join(source, 'resource_packs', 'safe'), { recursive: true });
  const manifest = { format_version: 2, header: { uuid: id, name: 'Safe resource pack', description: 'Real JSON bytes, inert resource fixture.', version: [1, 0, 0], min_engine_version: [1, 26, 0] }, modules: [{ uuid: module, type: 'resources', version: [1, 0, 0] }] };
  await fs.writeFile(path.join(source, 'resource_packs', 'safe', 'manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(source, 'world_resource_packs.json'), JSON.stringify([{ pack_id: id, version: [1, 0, 0] }]));
  let archive = path.join(x.dataDir, 'safe-packs.mcworld'); await zipDirectory(source, archive, { includeEmptyDirectories: true });
  const accepted = await x.manager.importWorld(x.server.id, archive, { name: 'Pack world', filename: 'pack.mcworld' });
  const result = await waitJob(x.manager, accepted.id); assert.equal(result.result.world.metadata.embeddedPacks, 1); assert.equal(result.result.world.metadata.enabledPacks, 1);
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds', 'Pack world')), await fingerprints(source));
  await fs.writeFile(path.join(source, 'world_resource_packs.json'), JSON.stringify([{ pack_id: randomUUID(), version: [1, 0, 0] }]));
  archive = path.join(x.dataDir, 'missing-packs.zip'); await zipDirectory(source, archive); assert.match((await waitJob(x.manager, (await x.manager.importWorld(x.server.id, archive, { name: 'Missing packs', filename: 'bad.zip' })).id, 'failed')).message, /thiếu pack đã đăng ký/);
  manifest.dependencies = [{ uuid: id, version: [1, 0, 0] }]; await fs.writeFile(path.join(source, 'resource_packs', 'safe', 'manifest.json'), JSON.stringify(manifest));
  archive = path.join(x.dataDir, 'self-reference.zip'); await zipDirectory(source, archive); assert.match((await waitJob(x.manager, (await x.manager.importWorld(x.server.id, archive, { name: 'Cycle packs', filename: 'bad.zip' })).id, 'failed')).message, /phụ thuộc chính nó/);
});

test('failed world import/delete commits restore folders and metadata; post-commit cleanup is an honest warning', async t => {
  const x = await operationFixture(t), before = await fingerprints(x.run), archive = path.join(x.dataDir, 'new.mcworld'); await zipDirectory(path.join(x.run, 'worlds', 'Main'), archive, { includeEmptyDirectories: true });
  let rejectImport = true; x.store.save = () => { if (rejectImport && x.store.data.activity[0]?.action === 'world.import') { rejectImport = false; throw Error('World import audit rejects commit'); } x.save(); };
  await waitJob(x.manager, (await x.manager.importWorld(x.server.id, archive, { name: 'Uncommitted', filename: 'new.mcworld' })).id, 'failed');
  assert.deepEqual(await fingerprints(x.run), before); assert.equal((await x.manager.worlds(x.server.id)).worlds.length, 1);
  x.store.save = x.save; await writeWorld(path.join(x.run, 'worlds', 'Inactive')); const owned = await fingerprints(path.join(x.run, 'worlds', 'Inactive'));
  await assert.rejects(x.manager.deleteWorld(x.server.id, 'Main', { name: 'Main' }), error => error.status === 409);
  await assert.rejects(x.manager.deleteWorld(x.server.id, 'Inactive', { name: 'wrong confirmation' }), error => error.status === 400);
  let rejectDelete = true; x.store.save = () => { if (rejectDelete && x.store.data.activity[0]?.action === 'world.delete') { rejectDelete = false; throw Error('World delete audit rejects commit'); } x.save(); };
  await assert.rejects(x.manager.deleteWorld(x.server.id, 'Inactive', { name: 'Inactive' }), /rejects commit/); assert.deepEqual(await fingerprints(path.join(x.run, 'worlds', 'Inactive')), owned);
  x.store.save = x.save;
  const originalRm = fs.rm; fs.rm = async (target, options) => { if (path.basename(target).startsWith('.vortex-delete-server-Inactive-')) throw Object.assign(Error('World quarantine cleanup denied'), { code: 'EACCES' }); return originalRm(target, options); };
  let removed; try { removed = await x.manager.deleteWorld(x.server.id, 'Inactive', { name: 'Inactive' }); } finally { fs.rm = originalRm; }
  assert.equal(removed.ok, true); assert.match(removed.warnings[0], /cleanup denied/); assert.deepEqual(await fingerprints(path.join(x.dataDir, removed.cleanupPending)), owned);
  assert.ok(!(await x.manager.worlds(x.server.id)).worlds.some(world => world.name.includes('vortex-delete')));
  assert.equal(await fs.stat(path.join(x.run, 'worlds', 'Inactive')).catch(() => null), null);
  const recovery = x.store.data.activity.find(row => row.action === 'world.delete'); assert.ok(recovery);
  x.store.clearHistory({ activity: true, finishedJobs: true, confirmed: true });
  assert.ok(x.store.data.activity.includes(recovery), 'Explicit history clearing preserves the unresolved world cleanup pointer');
  recovery.time = '2025-01-01T00:00:00.000Z'; x.store.save();
  assert.ok(x.store.data.activity.includes(recovery), 'Age retention preserves the pointer while its owned quarantine exists');
  assert.deepEqual(await fingerprints(path.join(x.dataDir, removed.cleanupPending)), owned);
  await fs.rm(path.join(x.dataDir, removed.cleanupPending), { recursive: true }); x.store.save();
  assert.equal(x.store.data.activity.includes(recovery), false, 'Completed recovery makes the old pointer prunable');
});

test('long valid world names keep deletion, rollback and retained cleanup within the filesystem name bound', async t => {
  for (const [label, name] of [['230-byte ASCII', 'a'.repeat(230)], ['255-byte ASCII', 'b'.repeat(255)], ['255-byte UTF-8', '界'.repeat(85)]]) await t.test(label, async t => {
    const x = await operationFixture(t), world = path.join(x.run, 'worlds', name), digest = createHash('sha256').update(name).digest('hex');
    await writeWorld(world); const original = await fingerprints(world);
    const removed = await x.manager.deleteWorld(x.server.id, name, { name });
    assert.equal(removed.ok, true); assert.equal(removed.cleanupPending, undefined); await assert.rejects(fs.stat(world), { code: 'ENOENT' });
    assert.ok(x.store.data.activity[0].detail.startsWith(`${x.server.name}: ${name} [quarantine: `));
    await writeWorld(world); const activity = structuredClone(x.store.data.activity); let rejected = false;
    x.store.save = () => { if (!rejected && x.store.data.activity[0]?.action === 'world.delete') { rejected = true; throw Error('Long world deletion commit denied'); } return x.save(); };
    try { await assert.rejects(x.manager.deleteWorld(x.server.id, name, { name }), /Long world deletion commit denied/); } finally { x.store.save = x.save; }
    assert.equal(rejected, true); assert.deepEqual(await fingerprints(world), original); assert.deepEqual(x.store.data.activity, activity);
    const rm = fs.rm; let pending;
    fs.rm = async (target, options) => { if (String(target).startsWith(x.dataDir + path.sep) && path.basename(target).startsWith(`.vortex-delete-server-${digest}-`)) throw Object.assign(Error('Long world cleanup denied'), { code: 'EPERM' }); return rm(target, options); };
    try { pending = await x.manager.deleteWorld(x.server.id, name, { name }); } finally { fs.rm = rm; }
    assert.equal(pending.ok, true); assert.ok(pending.cleanupPending); assert.ok(Buffer.byteLength(path.basename(pending.cleanupPending)) <= 255);
    assert.ok(path.basename(pending.cleanupPending).startsWith(`.vortex-delete-server-${digest}-`));
    const quarantine = path.join(x.dataDir, pending.cleanupPending); assert.equal(path.dirname(quarantine), path.dirname(world)); assert.deepEqual(await fingerprints(quarantine), original);
    const pointer = x.store.data.activity.find(row => row.action === 'world.delete'); assert.ok(pointer.detail.includes(name)); pointer.time = '2025-01-01T00:00:00.000Z'; x.store.save();
    x.store.clearHistory({ activity: true, finishedJobs: true, confirmed: true }); assert.ok(x.store.data.activity.includes(pointer));
    await fs.rm(quarantine, { recursive: true }); x.store.save(); assert.equal(x.store.data.activity.includes(pointer), false);
  });
});

test('world tools reject ancestor symlinks and exclusive export/import locks block conflicting lifecycle operations', async t => {
  const x = await operationFixture(t), outside = path.join(x.dataDir, 'outside'); await writeWorld(outside, 'Outside untouched'); const bytes = await fingerprints(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'; await fs.symlink(outside, path.join(x.run, 'worlds', 'Linked'), linkType);
  const listing = await x.manager.worlds(x.server.id); assert.equal(listing.worlds.find(world => world.name === 'Linked').state, 'invalid');
  await assert.rejects(x.manager.exportWorld(x.server.id, 'Linked'), error => error.status === 403);
  await assert.rejects(x.manager.selectWorld(x.server.id, { name: 'Linked' }), error => error.status === 403);
  await assert.rejects(x.manager.deleteWorld(x.server.id, 'Linked', { name: 'Linked' }), error => error.status === 403);
  assert.deepEqual(await fingerprints(outside), bytes); await fs.rm(path.join(x.run, 'worlds', 'Linked'));
  const originalReaddir = fs.readdir; let release, enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve; }); const paused = new Promise(resolve => { release = resolve; });
  fs.readdir = async (target, options) => { if (target === path.join(x.run, 'worlds', 'Main')) { enteredResolve(); await paused; } return originalReaddir(target, options); };
  let exported; try { const exporting = x.manager.exportWorld(x.server.id, 'Main'); await entered; assert.equal(x.manager.getServer(x.server.id).busy, true); await assert.rejects(x.manager.action(x.server.id, 'start'), error => error.status === 409); await assert.rejects(x.manager.createWorld(x.server.id, { name: 'Racing' }), error => error.status === 409); release(); exported = await exporting; } finally { release?.(); fs.readdir = originalReaddir; }
  await exported.cleanup(); assert.equal(x.manager.getServer(x.server.id).busy, false);
});

test('a world metadata race while running is retryable changing state rather than a corruption claim', async t => {
  const x = await operationFixture(t), level = path.join(x.run, 'worlds', 'Main', 'level.dat'), original = await fs.readFile(level), open = fs.open;
  let raced = false; x.server.status = 'running';
  fs.open = async (filename, flags, ...args) => { if (filename === level && !raced) { raced = true; await fs.appendFile(level, Buffer.from([0])); } return open(filename, flags, ...args); };
  let result; try { result = await x.manager.worlds(x.server.id); } finally { fs.open = open; await fs.writeFile(level, original); x.server.status = 'stopped'; }
  assert.equal(result.worlds[0].state, 'changing'); assert.equal(result.worlds[0].retryable, true); assert.equal(result.worlds[0].valid, false); assert.match(result.worlds[0].error, /đang thay đổi/);
  assert.equal((await x.manager.worlds(x.server.id)).worlds[0].state, 'ready');
});
