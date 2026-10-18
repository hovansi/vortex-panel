import test from 'node:test';
import assert from 'node:assert/strict';
import { updateJobProgress } from '../server/job-progress.js';
test('workflow milestones never regress and running download100 is separate from completion', () => {
  const job = { status: 'running', progress: 5 };
  updateJobProgress(job, 65, 'Download', { phase: 'download', transfer: { loadedBytes: 200, totalBytes: 200 } });
  assert.equal(job.progress, 65); assert.equal(job.transfer.percent, 100);
  updateJobProgress(job, 20, 'Extract', { phase: 'extract' }); assert.equal(job.progress, 65); assert.equal(job.transfer, undefined); assert.equal(job.phase, 'extract');
  updateJobProgress(job, 100, 'Activating', { phase: 'activate' }); assert.equal(job.progress, 99);
  updateJobProgress(job, Infinity); assert.equal(job.progress, 99);
});
test('unknown transport length stays indeterminate and transfer details clear at other phases', () => {
  const job = { progress: 0 }; updateJobProgress(job, 20, 'Download', { phase: 'download', transfer: { loadedBytes: 123, totalBytes: null, percent: 90 } });
  assert.deepEqual(job.transfer, { loadedBytes: 123, totalBytes: null, percent: null });
  assert.equal(updateJobProgress(job, 20, 'Download', { phase: 'download', transfer: { loadedBytes: 123, totalBytes: null } }), false);
  updateJobProgress(job, 90, 'Commit'); assert.equal(job.transfer, undefined); assert.equal(job.phase, 'work');
});
