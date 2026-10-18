import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { operationFixture, fingerprints, waitJob, zipEntries } from './worlds-fixture.js';
import { createStore } from '../server/store.js';
import { createManager } from '../server/manager.js';
import { parseProperties } from '../server/safety.js';
import { zipDirectory } from '../server/archives.js';

async function terminalJob(manager, id) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const record = manager.jobs().find(job => job.id === id);
    if (['completed', 'failed'].includes(record?.status) && record.finishedAt) return record;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('Isolated post-commit job did not reach a terminal state');
}

test('failed restore rollback retains both copies, both causes and recovery locations instead of reporting a stopped server', async t => {
  for (const mode of ['commit-and-rollback', 'commit-and-candidate-move', 'activation-and-rollback']) await t.test(mode, async t => {
    const x = await operationFixture(t); x.server.autoStart = true; x.server.autoRestart = true;
    const saved = await waitJob(x.manager, (await x.manager.backup(x.server.id)).id);
    const backup = x.manager.backups(x.server.id)[0], candidateBefore = await fingerprints(x.run);
    await fs.writeFile(path.join(x.run, 'worlds', 'Main', 'db', '000002.ldb'), 'Original live data before a failed restore must remain recoverable.');
    const originalBefore = await fingerprints(x.run), parent = path.dirname(x.run), originalRename = fs.rename;
    let primaryInjected = false;
    x.store.save = () => {
      if (mode.startsWith('commit-') && !primaryInjected && syncFs.existsSync(x.run) && syncFs.readdirSync(parent).some(name => name.startsWith('.rollback-'))) {
        primaryInjected = true; throw Error('Primary restore commit denied');
      }
      return x.save();
    };
    fs.rename = async (source, destination) => {
      if (mode === 'activation-and-rollback' && path.basename(source).startsWith('.restore-') && destination === x.run) {
        primaryInjected = true; throw Object.assign(Error('Primary restore activation denied'), { code: 'EACCES' });
      }
      if (primaryInjected && ((mode === 'commit-and-candidate-move' && source === x.run && path.basename(destination).startsWith('.restore-')) || (mode !== 'commit-and-candidate-move' && path.basename(source).startsWith('.rollback-') && destination === x.run))) {
        throw Object.assign(Error('Secondary restore rollback denied'), { code: 'EACCES' });
      }
      return originalRename(source, destination);
    };
    let outcome;
    try { outcome = await waitJob(x.manager, (await x.manager.restore(x.server.id, backup.id)).id, 'failed'); }
    finally { fs.rename = originalRename; x.store.save = x.save; }
    assert.match(outcome.message, mode === 'activation-and-rollback' ? /Primary restore activation denied/ : /Primary restore commit denied/);
    assert.match(outcome.message, /Secondary restore rollback denied/);
    assert.equal(x.server.status, 'error');
    const originalFolder = (await fs.readdir(parent)).find(name => name.startsWith('.rollback-')); assert.ok(originalFolder);
    assert.deepEqual(await fingerprints(path.join(parent, originalFolder)), originalBefore);
    const candidateFolder = mode === 'commit-and-candidate-move' ? 'run' : (await fs.readdir(parent)).find(name => name.startsWith('.restore-')); assert.ok(candidateFolder);
    const candidate = await fingerprints(path.join(parent, candidateFolder)), expected = { ...candidateBefore };
    // Restore deliberately normalizes managed network/debug settings. Every
    // other byte, including identity, world tables and runtime, stays intact.
    delete candidate['server.properties']; delete expected['server.properties'];
    assert.deepEqual(candidate, expected);
    const candidateProperties = parseProperties(await fs.readFile(path.join(parent, candidateFolder, 'server.properties'), 'utf8'));
    assert.equal(candidateProperties['server-port'], String(x.server.port)); assert.equal(candidateProperties.transport, x.server.transport);
    assert.ok(outcome.message.includes(`servers/${x.server.id}/${originalFolder}`));
    assert.ok(outcome.message.includes(`servers/${x.server.id}/${candidateFolder}`));
    assert.equal(x.manager.jobs().find(job => job.id === saved.id).status, 'completed');
    const marker = x.server.restoreRecoveryRequired;
    assert.equal(marker.original, `servers/${x.server.id}/${originalFolder}`); assert.equal(marker.candidate, `servers/${x.server.id}/${candidateFolder}`);
    assert.match(marker.primaryError, /Primary restore/); assert.match(marker.rollbackError, /Secondary restore rollback/);
    assert.equal(x.manager.getServer(x.server.id).recoveryRequired, true);
    const reloaded = createStore(x.dataDir); assert.deepEqual(reloaded.data.servers[0].restoreRecoveryRequired, marker);
    const restarted = await createManager({ store: reloaded, dataDir: x.dataDir, demo: false });
    const blocked = error => error.status === 409 && /restore chưa phục hồi/.test(error.message);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => String(url).startsWith('https:') ? Promise.reject(Error('Isolated recovery fixture disables catalog downloads')) : previousFetch(url, options);
    try {
      await restarted.initialize();
      assert.equal(restarted.getServer(x.server.id).status, 'error'); assert.equal(restarted.getServer(x.server.id).pid, null);
      assert.match(restarted.getServer(x.server.id).error, /Primary restore/);
      await assert.rejects(restarted.action(x.server.id, 'start'), blocked);
      await assert.rejects(restarted.action(x.server.id, 'start', true), blocked);
      for (const operation of [() => restarted.deleteServer(x.server.id), () => restarted.cloneServer(x.server.id, { name: 'Denied clone', eula: true, port: 32200, portV6: 32201 }), () => restarted.createWorld(x.server.id, { name: 'Denied fresh', seed: '' }), () => restarted.writeFile(x.server.id, 'server.properties', 'Denied write'), () => restarted.restore(x.server.id, backup.id)]) await assert.rejects(operation(), blocked);
      assert.equal(restarted.getServer(x.server.id).recoveryRequired, true);
      assert.deepEqual(restarted.backups(x.server.id).map(b => b.id), [backup.id]);
      await waitJob(restarted, (await restarted.verifyBackup(x.server.id, backup.id)).id);
      assert.equal(restarted.getServer(x.server.id).status, 'error');
      assert.deepEqual(reloaded.data.servers[0].restoreRecoveryRequired, marker);
      assert.deepEqual(await fingerprints(path.join(parent, originalFolder)), originalBefore);
    } finally { await restarted.close(); globalThis.fetch = previousFetch; }
  });
});

test('rejected generic and schedule queue commits preserve all 100 existing jobs and original references', async t => {
  const x = await operationFixture(t), jobs = Array.from({ length: 100 }, (_, index) => ({ id: `old-${index}`, status: 'completed' }));
  x.store.data.settings.logRetention = { finishedJobEntries: 100 };
  x.store.data.jobs = jobs;
  const schedule = x.manager.createSchedule({ serverId: x.server.id, action: 'command', command: 'list', intervalMinutes: 60, enabled: false }), scheduleBefore = structuredClone(x.store.data.schedules[0]), runBefore = await fingerprints(x.run);
  x.store.save = () => { throw Error('Initial queue persistence failure'); };
  await assert.rejects(x.manager.backup(x.server.id), /persistence failure/);
  assert.strictEqual(x.store.data.jobs, jobs); assert.equal(jobs.length, 100); assert.equal(jobs.at(-1).id, 'old-99'); assert.equal(Object.hasOwn(x.server, 'jobId'), false);
  assert.throws(() => x.manager.runSchedule(schedule.id), /persistence failure/);
  assert.strictEqual(x.store.data.jobs, jobs); assert.equal(jobs.length, 100); assert.deepEqual(x.store.data.schedules[0], scheduleBefore); assert.deepEqual(await fingerprints(x.run), runBefore);
});

test('update cleanup failure keeps successful new runtime and preserved empty world folders; clone remains independent', async t => {
  const x = await operationFixture(t); await fs.mkdir(path.join(x.run, 'custom-empty', 'nested'), { recursive: true });
  const worldBefore = await fingerprints(path.join(x.run, 'worlds')), oldIdentity = await fs.readFile(path.join(x.run, 'keys', 'server_identity_key.pem'));
  // A minimal inert ELF header exercises package validation and file activation.
  // No process is started and this fixture does not prove native BDS gameplay.
  const elf = Buffer.alloc(2048); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18); elf.write('New inert runtime fixture', 64);
  const archive = path.join(x.dataDir, 'bedrock-server-1.26.53.1.zip');
  await zipEntries(archive, [{ name: 'bedrock_server', content: elf }, { name: 'server.properties', content: await fs.readFile(path.join(x.run, 'server.properties')) }]);
  await x.manager.importVersion(archive, '1.26.53.1', 'stable');
  const originalRm = fs.rm; fs.rm = async (target, options) => { if (path.basename(target).startsWith('.rollback-')) throw Object.assign(Error('Update rollback cleanup denied'), { code: 'EPERM' }); return originalRm(target, options); };
  let upgraded; try { upgraded = await waitJob(x.manager, (await x.manager.upgrade(x.server.id, { version: '1.26.53.1' })).id); } finally { fs.rm = originalRm; }
  assert.equal(upgraded.status, 'completed'); assert.match(upgraded.warnings[0], /cleanup denied/); assert.match(upgraded.message, /cảnh báo/);
  assert.equal(x.manager.getServer(x.server.id).version, '1.26.53.1'); assert.deepEqual(await fs.readFile(path.join(x.run, 'bedrock_server')), elf);
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), worldBefore); assert.ok((await fs.stat(path.join(x.run, 'custom-empty', 'nested'))).isDirectory());
  assert.deepEqual(await fs.readFile(path.join(x.run, 'keys', 'server_identity_key.pem')), oldIdentity);
  const rollback = (await fs.readdir(path.dirname(x.run))).find(name => name.startsWith('.rollback-')); assert.ok(rollback); assert.equal(await fs.readFile(path.join(path.dirname(x.run), rollback, 'bedrock_server'), 'utf8'), 'Inert fixture. It must never be executed.');
  const cloned = await x.manager.cloneServer(x.server.id, { name: 'Independent empty folders', port: 34300, portV6: 34301, eula: true }); await waitJob(x.manager, cloned.job.id);
  const target = path.join(x.dataDir, 'servers', cloned.server.id, 'run'); assert.deepEqual(await fingerprints(path.join(target, 'worlds')), worldBefore); assert.ok((await fs.stat(path.join(target, 'custom-empty', 'nested'))).isDirectory());
  assert.equal(await fs.stat(path.join(target, 'keys')).catch(() => null), null);
  await fs.writeFile(path.join(target, 'worlds', 'Main', 'db', '000002.ldb'), 'Independent clone bytes'); assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), worldBefore);
});

test('completion audit write failure keeps already committed backup/import results completed with durable warnings', async t => {
  for (const type of ['backup', 'world-import']) await t.test(type, async t => {
    const x = await operationFixture(t), before = await fingerprints(x.run);
    const archive = path.join(x.dataDir, 'post-commit-world.mcworld');
    if (type === 'world-import') await zipDirectory(path.join(x.run, 'worlds', 'Main'), archive, { includeEmptyDirectories: true });
    let injected = false;
    x.store.save = () => { if (!injected && x.store.data.activity[0]?.action === type + '.complete') { injected = true; throw Object.assign(Error('Completion audit sink rejects the write'), { code: 'ENOSPC' }); } return x.save(); };
    const accepted = type === 'backup' ? await x.manager.backup(x.server.id) : await x.manager.importWorld(x.server.id, archive, { name: 'Committed import', filename: 'post-commit.mcworld' });
    const result = await terminalJob(x.manager, accepted.id);
    const committedStore = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'));
    if (type === 'backup') { assert.equal(committedStore.servers[0].backups.length, 1); assert.ok((await fs.stat(path.join(x.dataDir, 'servers', x.server.id, 'backups', committedStore.servers[0].backups[0].id + '.zip'))).size > 0); }
    else { assert.ok(committedStore.activity.some(event => event.action === 'world.import')); assert.deepEqual(await fingerprints(path.join(x.run, 'worlds', 'Committed import')), await fingerprints(path.join(x.run, 'worlds', 'Main'))); }
    assert.equal(injected, true); assert.equal(result.status, 'completed'); assert.equal(result.operationCompleted, true); assert.equal(result.completionAuditRecorded, false); assert.equal(result.completionStatusPersisted, true);
    assert.ok(result.warnings.some(warning => warning.includes('Completion audit sink rejects the write'))); assert.match(result.message, /cảnh báo/);
    const reloaded = createStore(x.dataDir), persisted = reloaded.data.jobs.find(job => job.id === accepted.id); assert.equal(persisted.status, 'completed'); assert.deepEqual(persisted.warnings, result.warnings);
    assert.equal(persisted.completionAuditRecorded, false); assert.equal(persisted.completionStatusPersisted, true); assert.equal(reloaded.data.activity.some(event => event.action === type + '.complete'), false);
    if (type === 'backup') {
      assert.equal(x.manager.backups(x.server.id).length, 1); const record = x.manager.backups(x.server.id)[0]; assert.equal(record.integrity.status, 'verified');
      assert.ok((await fs.stat(path.join(x.dataDir, 'servers', x.server.id, 'backups', record.id + '.zip'))).size > 0);
      assert.deepEqual(await fingerprints(x.run), before);
    } else {
      assert.equal(result.result.world.name, 'Committed import'); assert.equal(result.result.selected, false);
      assert.deepEqual(await fingerprints(path.join(x.run, 'worlds', 'Committed import')), await fingerprints(path.join(x.run, 'worlds', 'Main')));
      assert.equal((await x.manager.properties(x.server.id))['level-name'], 'Main');
      assert.ok(reloaded.data.activity.some(event => event.action === 'world.import'));
    }
    assert.equal(x.server.status, 'stopped'); assert.equal(x.manager.getServer(x.server.id).busy, false);
  });
});

test('a failed final status save preserves completed operation in memory and explicitly reports unacknowledged final metadata', async t => {
  const x = await operationFixture(t), before = await fingerprints(x.run); let rejected = 0;
  x.store.save = () => {
    if (x.store.data.jobs.some(job => job.type === 'backup' && job.status === 'completed' && job.finishedAt) && !Object.hasOwn(x.server, 'jobId')) { rejected++; throw Object.assign(Error('Final job state sink rejects the write'), { code: 'EIO' }); }
    return x.save();
  };
  const result = await terminalJob(x.manager, (await x.manager.backup(x.server.id)).id);
  const committedCatalog = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.equal(committedCatalog.servers[0].backups.length, 1); assert.ok((await fs.stat(path.join(x.dataDir, 'servers', x.server.id, 'backups', committedCatalog.servers[0].backups[0].id + '.zip'))).size > 0);
  assert.equal(rejected, 1); assert.equal(result.status, 'completed'); assert.equal(result.operationCompleted, true); assert.equal(result.completionAuditRecorded, true); assert.equal(result.completionStatusPersisted, false);
  assert.ok(result.warnings.some(warning => warning.includes('Final job state sink rejects the write'))); assert.match(result.message, /cảnh báo/);
  assert.equal(x.server.backups.length, 1); const catalog = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')); assert.equal(catalog.servers[0].backups.length, 1);
  const persisted = catalog.jobs.find(job => job.id === result.id); assert.equal(persisted.finishedAt, null); assert.equal(persisted.completionStatusPersisted, false);
  assert.deepEqual(await fingerprints(x.run), before); assert.equal(x.manager.getServer(x.server.id).busy, false);
});

test('retention failures stop further pruning and report a completed new backup while retaining every old archive', async t => {
  for (const mode of ['catalog-commit', 'quarantine-move']) await t.test(mode, async t => {
    const x = await operationFixture(t); for (let index = 0; index < 2; index++) await waitJob(x.manager, (await x.manager.backup(x.server.id)).id);
    const older = x.manager.backups(x.server.id), before = await fingerprints(path.join(x.dataDir, 'servers', x.server.id, 'backups'));
    x.manager.updateServer(x.server.id, { backupRetention: 1 });
    let attempts = 0, commitRejected = false; const rename = fs.rename;
    x.store.save = () => { if (mode === 'catalog-commit' && !commitRejected && x.store.data.activity[0]?.action === 'backup.retention') { commitRejected = true; throw Object.assign(Error('Retention catalog sink rejects the write'), { code: 'ENOSPC' }); } return x.save(); };
    fs.rename = async (source, destination) => {
      if (path.basename(destination).startsWith('.vortex-delete-backup-')) { attempts++; if (mode === 'quarantine-move') throw Object.assign(Error('Retention quarantine move is denied'), { code: 'EACCES' }); }
      return rename(source, destination);
    };
    let result; try { result = await terminalJob(x.manager, (await x.manager.backup(x.server.id)).id); } finally { fs.rename = rename; x.store.save = x.save; }
    assert.equal(JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')).servers[0].backups.length, 3); const retained = await fingerprints(path.join(x.dataDir, 'servers', x.server.id, 'backups')); for (const [name, value] of Object.entries(before)) assert.equal(retained[name], value); assert.equal(Object.keys(retained).filter(name => name.endsWith('.zip')).length, 3);
    assert.equal(result.status, 'completed'); assert.equal(result.operationCompleted, true); assert.equal(result.retentionComplete, false); assert.equal(result.completionStatusPersisted, true); assert.equal(attempts, 1);
    assert.ok(result.warnings.some(warning => warning.includes(mode === 'catalog-commit' ? 'Retention catalog sink rejects the write' : 'Retention quarantine move is denied'))); assert.match(result.message, /cảnh báo/);
    const records = x.manager.backups(x.server.id); assert.equal(records.length, 3); assert.deepEqual(records.slice(1).map(record => record.id), older.map(record => record.id)); assert.equal(records[0].integrity.status, 'verified');
    const after = await fingerprints(path.join(x.dataDir, 'servers', x.server.id, 'backups')); for (const [name, value] of Object.entries(before)) assert.equal(after[name], value);
    assert.equal(Object.keys(after).filter(name => name.endsWith('.zip')).length, 3); assert.equal(Object.keys(after).some(name => name.startsWith('.vortex-delete-')), false);
    const reloaded = createStore(x.dataDir); assert.equal(reloaded.data.servers[0].backups.length, 3); assert.equal(reloaded.data.jobs.find(job => job.id === result.id).retentionComplete, false);
  });
});

test('an operation commit failure still fails the job, rolls back the new backup and never claims operation completion', async t => {
  const x = await operationFixture(t), before = await fingerprints(x.run); let rejected = false;
  x.store.save = () => { if (!rejected && x.store.data.activity[0]?.action === 'backup.create') { rejected = true; throw Error('Primary backup catalog commit failed'); } return x.save(); };
  const result = await terminalJob(x.manager, (await x.manager.backup(x.server.id)).id);
  assert.equal(rejected, true); assert.equal(result.status, 'failed'); assert.equal(result.operationCompleted, false); assert.match(result.message, /Primary backup catalog commit failed/);
  assert.equal(x.manager.backups(x.server.id).length, 0); assert.deepEqual(await fingerprints(x.run), before);
  assert.equal((await fs.readdir(path.join(x.dataDir, 'servers', x.server.id, 'backups'))).length, 0);
});

test('a failed final status save after an operation error preserves the original failure and rollback evidence', async t => {
  const x = await operationFixture(t), before = await fingerprints(x.run); let primaryRejected = false, terminalRejected = 0;
  x.store.save = () => {
    if (!primaryRejected && x.store.data.activity[0]?.action === 'backup.create') { primaryRejected = true; throw Error('Original backup catalog failure'); }
    if (x.store.data.jobs.some(job => job.type === 'backup' && job.status === 'failed' && job.finishedAt) && !Object.hasOwn(x.server, 'jobId')) { terminalRejected++; throw Error('Secondary final status failure'); }
    return x.save();
  };
  const result = await terminalJob(x.manager, (await x.manager.backup(x.server.id)).id);
  assert.equal(primaryRejected, true); assert.equal(terminalRejected, 1);
  assert.equal(result.status, 'failed'); assert.equal(result.operationCompleted, false); assert.equal(result.completionStatusPersisted, false);
  assert.equal(result.message, 'Original backup catalog failure'); assert.equal(x.server.error, 'Original backup catalog failure');
  assert.ok(result.warnings.some(warning => warning.includes('Secondary final status failure')));
  assert.equal(x.manager.backups(x.server.id).length, 0); assert.deepEqual(await fingerprints(x.run), before);
  assert.equal((await fs.readdir(path.join(x.dataDir, 'servers', x.server.id, 'backups'))).length, 0);
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'));
  assert.equal(disk.servers[0].backups.length, 0); assert.equal(disk.jobs.find(job => job.id === result.id).message, result.message);
});
