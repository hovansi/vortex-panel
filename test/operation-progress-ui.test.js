import test from 'node:test';
import assert from 'node:assert/strict';
import { updateJobProgress } from '../server/job-progress.js';

// Import the actual browser model without pretending that DOM rendering was
// tested. i18n's import-time language setup needs only this isolated stub.
const hadDocument = Object.hasOwn(globalThis, 'document'), previousDocument = globalThis.document;
globalThis.document = { documentElement: { lang: '' }, addEventListener() {}, querySelectorAll() { return []; } };
let progressModel;
try { ({ progressModel } = await import('../public/operation-progress.js')); }
finally { if (hadDocument) globalThis.document = previousDocument; else delete globalThis.document; }

test('browser progress model reads actual backend transfer schema without a transfer.phase field', () => {
  const job = { status: 'running', progress: 5 };
  updateJobProgress(job, 30, 'Measured download', { phase: 'download', transfer: { loadedBytes: 256, totalBytes: 1024 } });
  assert.equal(Object.hasOwn(job.transfer, 'phase'), false);
  const model = progressModel(job);
  assert.equal(model.downloading, true); assert.equal(model.loaded, 256); assert.equal(model.total, 1024); assert.equal(model.downloadPercent, 25); assert.equal(model.progress, 30); assert.equal(model.active, true);
});

test('browser progress model keeps unknown length indeterminate despite a supplied percentage', () => {
  const job = { status: 'running', progress: 0 };
  updateJobProgress(job, 20, 'Unknown total', { phase: 'download', transfer: { loadedBytes: 123, totalBytes: null, percent: 90 } });
  const model = progressModel(job);
  assert.equal(model.downloading, true); assert.equal(model.loaded, 123); assert.equal(model.total, null); assert.equal(model.downloadPercent, null); assert.equal(model.progress, 20);
});

test('browser progress never treats full downloaded bytes or uncommitted100 as completed workflow', () => {
  const job = { status: 'running', progress: 65, phase: 'download', transfer: { loadedBytes: 1024, totalBytes: 1024, percent: 100 } };
  const running = progressModel(job); assert.equal(running.downloadPercent, 100); assert.equal(running.progress, 65); assert.equal(running.completed, false); assert.equal(running.active, true);
  assert.equal(progressModel({ ...job, progress: 100 }).progress, 99);
  const failed = progressModel({ ...job, status: 'failed', progress: 100 }); assert.equal(failed.failed, true); assert.equal(failed.completed, false); assert.equal(failed.active, false); assert.equal(failed.progress, 99);
  const committed = progressModel({ status: 'completed', progress: 78, phase: 'activate' }); assert.equal(committed.completed, true); assert.equal(committed.active, false); assert.equal(committed.progress, 100);
});

test('browser progress clears transfer display when actual backend advances to extraction and verification', () => {
  const job = { status: 'running', progress: 0 };
  updateJobProgress(job, 65, 'Downloaded', { phase: 'download', transfer: { loadedBytes: 1024, totalBytes: 1024 } });
  updateJobProgress(job, 70, 'Extracting', { phase: 'extract' });
  const model = progressModel(job);
  assert.equal(model.downloading, false); assert.equal(model.phase, 'extract'); assert.equal(model.loaded, 0); assert.equal(model.total, null); assert.equal(model.downloadPercent, null); assert.equal(model.progress, 70);
});
