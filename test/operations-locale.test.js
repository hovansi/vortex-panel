import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeApiResponse } from '../server/locale.js';

test('world and recovery notices translate without changing names, seeds, metadata or hashes', () => {
  const opaque = 'Vui lòng đăng nhập.';
  const warning = 'Dữ liệu thế giới đã thay đổi trong lúc kiểm tra; hãy dừng server và thử lại.';
  const world = { name: opaque, displayName: opaque, seed: '9223372036854775807', metadata: { displayName: opaque, seedString: '-9223372036854775808', error: opaque }, error: warning, warnings: [warning] };
  const body = { worlds: [world], current: opaque, pending: { name: opaque, seed: world.seed }, warnings: [warning] };
  const en = localizeApiResponse('/api/servers/id/worlds', body, 'en');
  assert.notEqual(en.worlds[0].error, warning);
  assert.equal(en.worlds[0].error, en.worlds[0].warnings[0]);
  assert.deepEqual(en.worlds[0].metadata, world.metadata);
  assert.deepEqual(en.pending, body.pending);
  assert.equal(en.worlds[0].name, opaque);
  assert.equal(en.worlds[0].seed, world.seed);
  assert.equal(body.worlds[0].error, warning);
  assert.equal(localizeApiResponse('/api/servers/id/worlds', body, 'vi').worlds[0].error, warning);

  const backup = { id: 'opaque', name: opaque, sha256: 'a'.repeat(64), checksumOrigin: 'established', reason: 'pre-update', integrity: { status: 'failed', error: opaque } };
  const localized = localizeApiResponse('/api/servers/id/backups', { backups: [backup] }, 'en').backups[0];
  assert.equal(localized.integrity.error, 'Please sign in.');
  for (const field of ['id', 'name', 'sha256', 'checksumOrigin', 'reason']) assert.equal(localized[field], backup[field]);
  const jobs = localizeApiResponse('/api/jobs', { jobs: [{ message: 'Đang xử lý', result: { world, backup, selected: false } }] }, 'en').jobs;
  assert.equal(jobs[0].message, 'Processing');
  assert.equal(jobs[0].result.world.error, en.worlds[0].error);
  assert.deepEqual(jobs[0].result.world.metadata, world.metadata);
  assert.equal(jobs[0].result.backup.integrity.error, 'Please sign in.');
  assert.equal(jobs[0].result.selected, false);
});
