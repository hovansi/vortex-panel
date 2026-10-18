import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeApiResponse } from '../server/locale.js';

test('node setup jobs follow each request language without changing identities or unrelated job text', () => {
  const setup = { id: 'setup-id', type: 'node-provision', serverId: null, phase: 'upload', message: 'Uploading source.', messageI18n: { id: 'panel.node-provision.upload', en: 'Uploading source.', vi: 'Đang tải source.', params: [] }, transfer: { loadedBytes: 73, totalBytes: 100, percent: 73 } };
  const native = { id: 'node:job', type: 'custom', message: 'Uploading source.', messageI18n: { en: 'Do not replace this opaque job.', vi: 'Không thay nội dung tùy ý.' } };
  const body = { jobs: [setup, native] };
  const vi = localizeApiResponse('/api/nodes/provision/jobs', body, 'vi');
  assert.equal(vi.jobs[0].message, 'Đang tải source.');
  assert.equal(vi.jobs[1].message, native.message);
  assert.deepEqual(vi.jobs[0].transfer, setup.transfer); assert.equal(vi.jobs[0].id, setup.id);
  assert.equal(localizeApiResponse('/api/jobs', body, 'en').jobs[0].message, setup.message);
  assert.equal(body.jobs[0].message, setup.message);
});

test('network access localizes generated status and per-rule notices while preserving ports, IDs and opaque fields', () => {
  const translated = { en: 'Saved ports.', vi: 'Cổng đã lưu.' }, message = { en: 'Check UFW.', vi: 'Kiểm tra UFW.' };
  const body = { serverId: 'node:server', owner: 'vortex:scope:server', revision: 'abc123', message: message.en, messageI18n: message, errors: ['Partial effect.'], errorsI18n: [{ en: 'Partial effect.', vi: 'Tác động một phần.' }], warnings: ['Cloud firewall.'], warningsI18n: [{ en: 'Cloud firewall.', vi: 'Firewall cloud.' }], ports: [{ protocol: 'udp', port: '19134:19165', family: 'ipv4', purpose: translated.en, purposeI18n: translated }], opaque: { content: message.en } };
  const vi = localizeApiResponse('/api/servers/node:server/network-access', body, 'vi');
  assert.equal(vi.message, message.vi); assert.deepEqual(vi.errors, ['Tác động một phần.']); assert.deepEqual(vi.warnings, ['Firewall cloud.']);
  assert.equal(vi.ports[0].purpose, translated.vi); assert.equal(vi.ports[0].port, body.ports[0].port);
  for (const key of ['serverId', 'owner', 'revision', 'opaque']) assert.deepEqual(vi[key], body[key]);
  assert.deepEqual(localizeApiResponse('/api/servers/node:server/file', body, 'vi'), body);
  assert.equal(body.message, message.en);
});
