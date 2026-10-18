import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { operationFixture, fingerprints, waitJob } from './worlds-fixture.js';
import { verifyZip } from '../server/archives.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function savedBackup(x) { await waitJob(x.manager, (await x.manager.backup(x.server.id)).id); return x.manager.backups(x.server.id)[0]; }
const backupPath = (x, id) => path.join(x.dataDir, 'servers', x.server.id, 'backups', id + '.zip');
async function failedVerify(x, backup) {
  const archive = backupPath(x, backup.id), original = await fs.readFile(archive), tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 1; await fs.writeFile(archive, tampered);
  const job = await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id, 'failed');
  assert.match(job.message, /SHA-256/);
  assert.deepEqual(x.server.backupVerificationFailure, { backupId: backup.id, message: job.message });
  return { archive, original, message: job.message };
}

test('new backups persist actual ZIP SHA-256/CRC evidence and restore empty directories, world bytes and identity', async t => {
  const x = await operationFixture(t), worldBefore = await fingerprints(path.join(x.run, 'worlds'));
  const identity = await fs.readFile(path.join(x.run, 'keys', 'server_identity_key.pem')), runtime = await fs.readFile(path.join(x.run, 'bedrock_server'));
  const record = await savedBackup(x), archive = path.join(x.dataDir, 'servers', x.server.id, 'backups', record.id + '.zip');
  assert.equal(record.sha256, hash(await fs.readFile(archive))); assert.equal(record.checksumOrigin, 'created'); assert.equal(record.integrity.status, 'verified');
  const checked = await verifyZip(archive); assert.equal(record.integrity.entries, checked.entries); assert.equal(record.integrity.unpackedBytes, checked.unpackedBytes);
  assert.equal(record.restoreCompatible, true); assert.equal(record.locked, false); assert.ok(checked.paths.includes('worlds/Main/structures/empty'));
  assert.equal(checked.paths.includes('bedrock_server'), false);
  await fs.writeFile(path.join(x.run, 'worlds', 'Main', 'db', '000002.ldb'), 'Changed actual fixture bytes');
  await fs.rm(path.join(x.run, 'worlds', 'Main', 'structures', 'empty'), { recursive: true });
  await fs.mkdir(path.join(x.run, 'worlds', 'Unexpected'));
  await waitJob(x.manager, (await x.manager.restore(x.server.id, record.id)).id);
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), worldBefore);
  assert.deepEqual(await fs.readFile(path.join(x.run, 'keys', 'server_identity_key.pem')), identity); assert.deepEqual(await fs.readFile(path.join(x.run, 'bedrock_server')), runtime);
});

test('strict restore/download verification rejects tampered SHA and CRC before world activation', async t => {
  const x = await operationFixture(t), record = await savedBackup(x), archive = path.join(x.dataDir, 'servers', x.server.id, 'backups', record.id + '.zip');
  const original = await fs.readFile(archive), before = await fingerprints(x.run);
  const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 1; await fs.writeFile(archive, tampered);
  const rejected = await waitJob(x.manager, (await x.manager.restore(x.server.id, record.id)).id, 'failed'); assert.match(rejected.message, /SHA-256/);
  await assert.rejects(x.manager.downloadBackup(x.server.id, record.id), error => error.status === 409 && /SHA-256/.test(error.message));
  assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'failed'); assert.deepEqual(await fingerprints(x.run), before);
  // An externally replaced hash cannot conceal an invalid ZIP; CRC/layout are
  // independently checked by the streaming parser before restore staging.
  const invalid = Buffer.from('Not a ZIP archive, even though its new hash matches.'); await fs.writeFile(archive, invalid);
  x.server.backups[0].sha256 = hash(invalid);
  const crcRejected = await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, record.id)).id, 'failed'); assert.match(crcRejected.message, /ZIP không hợp lệ/);
  assert.deepEqual(await fingerprints(x.run), before);
  await fs.writeFile(archive, original); x.server.backups[0].sha256 = record.sha256;
  x.server.version = '1.26.51.1'; await assert.rejects(x.manager.restore(x.server.id, record.id), error => error.status === 409 && /phiên bản khác/.test(error.message));
  assert.equal(x.manager.backups(x.server.id)[0].restoreCompatible, false);
});

test('legacy checksums require explicit establishment, mark provenance honestly and verification writes no extraction tree', async t => {
  const x = await operationFixture(t), created = await savedBackup(x), record = x.server.backups[0];
  delete record.sha256; delete record.checksumOrigin; delete record.integrity;
  assert.equal(x.manager.backups(x.server.id)[0].sha256, null); assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'unverified');
  await assert.rejects(x.manager.restore(x.server.id, created.id), error => error.status === 409 && /thiết lập mốc/.test(error.message));
  const runBefore = await fingerprints(x.run), directoryBefore = (await fs.readdir(path.dirname(x.run))).sort();
  x.server.status = 'running';
  const job = await x.manager.verifyBackup(x.server.id, created.id); await assert.rejects(x.manager.action(x.server.id, 'stop'), error => error.status === 409);
  const checked = await waitJob(x.manager, job.id);
  assert.equal(checked.result.backup.checksumOrigin, 'established'); assert.equal(checked.result.backup.integrity.status, 'established'); assert.equal(checked.result.backup.sha256, created.sha256);
  assert.equal(x.server.status, 'running'); assert.deepEqual(await fingerprints(x.run), runBefore); assert.deepEqual((await fs.readdir(path.dirname(x.run))).sort(), directoryBefore);
  x.server.status = 'stopped'; await waitJob(x.manager, (await x.manager.restore(x.server.id, created.id)).id);
  assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'established');
});

test('locked snapshots survive rolling retention and manual deletion, and pin commits roll back safely', async t => {
  const x = await operationFixture(t); x.server.backupRetention = 1;
  const locked = await savedBackup(x), archive = path.join(x.dataDir, 'servers', x.server.id, 'backups', locked.id + '.zip'), bytes = await fs.readFile(archive);
  x.server.status = 'running'; const pin = await x.manager.setBackupLocked(x.server.id, locked.id, { locked: true }); assert.equal(pin.backup.locked, true); x.server.status = 'stopped';
  await assert.rejects(x.manager.deleteBackup(x.server.id, locked.id), error => error.status === 409 && /mở khóa/.test(error.message));
  const firstRolling = await savedBackup(x); const newest = await savedBackup(x);
  assert.deepEqual(x.manager.backups(x.server.id).map(record => record.id), [newest.id, locked.id]); assert.deepEqual(await fs.readFile(archive), bytes);
  assert.equal(await fs.stat(path.join(path.dirname(archive), firstRolling.id + '.zip')).catch(() => null), null);
  const originalArray = x.server.backups, before = structuredClone(originalArray), activity = x.store.data.activity;
  x.store.save = () => { throw Error('Pin metadata commit rejected'); };
  await assert.rejects(x.manager.setBackupLocked(x.server.id, locked.id, { locked: false }), /commit rejected/);
  assert.strictEqual(x.server.backups, originalArray); assert.strictEqual(x.store.data.activity, activity); assert.deepEqual(x.server.backups, before); assert.deepEqual(await fs.readFile(archive), bytes);
  x.store.save = x.save; await x.manager.setBackupLocked(x.server.id, locked.id, { locked: false });
  await savedBackup(x); assert.equal(x.manager.backups(x.server.id).length, 1); assert.equal(await fs.stat(archive).catch(() => null), null);
  for (const input of [{ locked: 'true' }, { locked: true, ignored: 1 }, null, []]) await assert.rejects(x.manager.setBackupLocked(x.server.id, x.server.backups[0].id, input), error => error.status === 400);
  x.server.backups.push(...Array.from({ length: 50 }, () => ({ id: randomUUID(), locked: true, name: 'Protected fixture' })));
  await assert.rejects(x.manager.setBackupLocked(x.server.id, x.server.backups[0].id, { locked: true }), error => error.status === 409 && /50/.test(error.message));
});

test('restore post-commit cleanup failure reports completed activation with retained rollback and warnings', async t => {
  const x = await operationFixture(t), backup = await savedBackup(x), originalWorld = await fingerprints(path.join(x.run, 'worlds'));
  await fs.writeFile(path.join(x.run, 'worlds', 'Main', 'db', '000002.ldb'), 'State before restore must remain in rollback');
  const originalRm = fs.rm; fs.rm = async (target, options) => { if (path.basename(target).startsWith('.rollback-')) throw Object.assign(Error('Restore rollback cleanup denied'), { code: 'EACCES' }); return originalRm(target, options); };
  let outcome; try { outcome = await waitJob(x.manager, (await x.manager.restore(x.server.id, backup.id)).id); } finally { fs.rm = originalRm; }
  assert.equal(outcome.status, 'completed'); assert.match(outcome.warnings[0], /cleanup denied/); assert.match(outcome.message, /cảnh báo/);
  assert.deepEqual(await fingerprints(path.join(x.run, 'worlds')), originalWorld);
  const rollback = (await fs.readdir(path.dirname(x.run))).find(name => name.startsWith('.rollback-')); assert.ok(rollback);
  assert.equal(await fs.readFile(path.join(path.dirname(x.run), rollback, 'worlds', 'Main', 'db', '000002.ldb'), 'utf8'), 'State before restore must remain in rollback');
});

test('missing backup bytes and ancestor symlinks fail verification without changing the active world', async t => {
  const x = await operationFixture(t), backup = await savedBackup(x), before = await fingerprints(x.run), directory = path.join(path.dirname(x.run), 'backups');
  const archive = path.join(directory, backup.id + '.zip'); await fs.rm(archive);
  assert.match((await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id, 'failed')).message, /Không tìm thấy/); assert.deepEqual(await fingerprints(x.run), before);
  const outside = path.join(x.dataDir, 'outside-backups'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, backup.id + '.zip'), 'Outside bytes must remain');
  await fs.rename(directory, directory + '-original'); await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(x.manager.downloadBackup(x.server.id, backup.id), error => error.status === 403); assert.equal(await fs.readFile(path.join(outside, backup.id + '.zip'), 'utf8'), 'Outside bytes must remain');
  await fs.rm(directory); await fs.rename(directory + '-original', directory);
});

test('explicit verification of a repaired archive clears only its own persisted error; download verification does not clear it', async t => {
  const x = await operationFixture(t), before = await fingerprints(x.run), backup = await savedBackup(x), failed = await failedVerify(x, backup);
  assert.deepEqual(x.server.backupVerificationFailure, { backupId: backup.id, message: failed.message });
  assert.equal(JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8')).servers[0].backupVerificationFailure.backupId, backup.id);
  await fs.writeFile(failed.archive, failed.original);
  await x.manager.downloadBackup(x.server.id, backup.id);
  assert.equal(x.server.error, failed.message); assert.equal(x.server.backupVerificationFailure.backupId, backup.id);
  assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'failed');
  await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id);
  assert.equal(x.server.error, null); assert.equal(x.server.backupVerificationFailure, null);
  assert.equal(x.manager.getServer(x.server.id).error, null); assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'verified');
  const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'));
  assert.equal(disk.servers[0].error, null); assert.equal(disk.servers[0].backupVerificationFailure, null);
  assert.deepEqual(await fingerprints(x.run), before); assert.deepEqual(await fs.readFile(failed.archive), failed.original);
});

test('two backups with identical SHA error messages retain the second failure when the first backup is repaired and verified', async t => {
  const x = await operationFixture(t), first = await savedBackup(x), second = await savedBackup(x);
  const a = await failedVerify(x, first), b = await failedVerify(x, second); assert.equal(a.message, b.message);
  await fs.writeFile(a.archive, a.original); await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, first.id)).id);
  assert.deepEqual(x.server.backupVerificationFailure, { backupId: second.id, message: b.message }); assert.equal(x.server.error, b.message);
  assert.equal(x.manager.backups(x.server.id).find(backup => backup.id === second.id).integrity.status, 'failed');
  await fs.writeFile(b.archive, b.original); await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, second.id)).id);
  assert.equal(x.server.error, null); assert.equal(x.server.backupVerificationFailure, null);
});

test('successful backup verification preserves unrelated runtime errors, restore recovery markers and running-state warnings', async t => {
  for (const guard of ['runtime-error', 'restore-recovery', 'running']) await t.test(guard, async t => {
    const x = await operationFixture(t), backup = await savedBackup(x), failed = await failedVerify(x, backup);
    const marker = x.server.backupVerificationFailure;
    if (guard === 'runtime-error') x.server.error = 'Unrelated native process failed to start';
    if (guard === 'restore-recovery') x.server.restoreRecoveryRequired = { original: 'servers/original', candidate: 'servers/candidate', primaryError: 'Keep both recovery copies', rollbackError: 'Do not clear recovery' };
    if (guard === 'running') x.server.status = 'running';
    const error = x.server.error, recovery = x.server.restoreRecoveryRequired; x.save();
    await fs.writeFile(failed.archive, failed.original); await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id);
    assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'verified');
    assert.equal(x.server.error, error); assert.strictEqual(x.server.backupVerificationFailure, marker); assert.strictEqual(x.server.restoreRecoveryRequired, recovery);
    const disk = JSON.parse(await fs.readFile(path.join(x.dataDir, 'panel.json'), 'utf8'));
    assert.equal(disk.servers[0].error, error); assert.deepEqual(disk.servers[0].backupVerificationFailure, marker);
    assert.deepEqual(disk.servers[0].restoreRecoveryRequired, recovery);
  });
});

test('another job failure relinquishes backup error ownership even when its failure has the same message', async t => {
  const x = await operationFixture(t), backup = await savedBackup(x), failed = await failedVerify(x, backup); let rejected = false;
  x.store.save = () => { if (!rejected && x.store.data.activity[0]?.action === 'backup.create') { rejected = true; throw Error(failed.message); } return x.save(); };
  await waitJob(x.manager, (await x.manager.backup(x.server.id)).id, 'failed'); x.store.save = x.save;
  assert.equal(rejected, true); assert.equal(x.server.error, failed.message); assert.equal(Object.hasOwn(x.server, 'backupVerificationFailure'), false);
  await fs.writeFile(failed.archive, failed.original); await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id);
  assert.equal(x.server.error, failed.message); assert.equal(Object.hasOwn(x.server, 'backupVerificationFailure'), false);
});

test('a failed verification-clear commit restores error ownership atomically before reporting the new metadata failure', async t => {
  const x = await operationFixture(t), backup = await savedBackup(x), failed = await failedVerify(x, backup), oldMarker = x.server.backupVerificationFailure;
  await fs.writeFile(failed.archive, failed.original); let rejected = false, rollbackObserved = false;
  x.store.save = () => {
    const action = x.store.data.activity[0]?.action;
    if (!rejected && action === 'backup.verify') {
      assert.equal(x.server.error, null); assert.equal(x.server.backupVerificationFailure, null);
      rejected = true; throw Error('Verified error-clear catalog commit failed');
    }
    if (rejected && action === 'backup.verify.failed') { rollbackObserved = true; assert.equal(x.server.error, failed.message); assert.strictEqual(x.server.backupVerificationFailure, oldMarker); }
    return x.save();
  };
  const job = await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id, 'failed'); x.store.save = x.save;
  assert.equal(rejected, true); assert.equal(rollbackObserved, true); assert.equal(job.operationCompleted, false);
  assert.equal(x.server.error, 'Verified error-clear catalog commit failed'); assert.deepEqual(x.server.backupVerificationFailure, { backupId: backup.id, message: x.server.error });
  assert.deepEqual(await fs.readFile(failed.archive), failed.original);
  await waitJob(x.manager, (await x.manager.verifyBackup(x.server.id, backup.id)).id);
  assert.equal(x.server.error, null); assert.equal(x.server.backupVerificationFailure, null); assert.equal(x.manager.backups(x.server.id)[0].integrity.status, 'verified');
});
