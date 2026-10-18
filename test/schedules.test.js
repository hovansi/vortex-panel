import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createManager } from '../server/manager.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-schedules-'));
  const store = { data: { servers: [{ id: 'one', name: 'Scheduled', status: 'stopped' }, { id: 'two', name: 'Another', status: 'stopped' }], versions: [], jobs: [], schedules: [], activity: [], settings: {}, users: [] }, save() {}, audit() {} };
  const manager = await createManager({ store, dataDir: directory, demo: true });
  t.after(async () => { store.save = () => {}; await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const create = () => manager.createSchedule({ serverId: 'one', action: 'backup', intervalMinutes: 60, enabled: false });
  return { manager, store, create };
}

test('schedule create, edit and delete each commit the audit and state in one durable write', async t => {
  const { manager, store, create } = await fixture(t);
  let writes = 0; store.save = () => { writes++; };
  const schedule = manager.withActor({ username: 'scheduler' }, create);
  assert.equal(writes, 1); assert.equal(store.data.activity[0].user, 'scheduler');
  const record = store.data.schedules[0]; assert.notEqual(schedule, record);
  manager.withActor({ username: 'scheduler' }, () => manager.updateSchedule(schedule.id, { enabled: true, intervalMinutes: 90 }));
  assert.equal(writes, 2); assert.equal(record.intervalMinutes, 90); assert.equal(store.data.activity[0].action, 'schedule.update');
  manager.withActor({ username: 'scheduler' }, () => manager.deleteSchedule(schedule.id));
  assert.equal(writes, 3); assert.equal(store.data.schedules.length, 0); assert.equal(store.data.activity[0].action, 'schedule.delete');
});

test('failed schedule creation and deletion preserve original arrays and records', async t => {
  const { manager, store, create } = await fixture(t);
  const original = store.data.schedules, originalActivity = store.data.activity;
  store.save = () => { throw new Error('Schedule disk full'); };
  assert.throws(create, /Schedule disk full/); assert.equal(store.data.schedules, original); assert.equal(original.length, 0); assert.equal(store.data.activity, originalActivity);
  store.save = () => {}; const schedule = create();
  const records = store.data.schedules, record = records[0], activity = store.data.activity;
  store.save = () => { throw new Error('Schedule delete failed'); };
  assert.throws(() => manager.deleteSchedule(schedule.id), /Schedule delete failed/);
  assert.equal(store.data.schedules, records); assert.equal(store.data.schedules[0], record); assert.equal(store.data.activity, activity);
});

test('failed schedule editing restores fields, enabled state and nextRun without leaked audit', async t => {
  const { manager, store, create } = await fixture(t); const schedule = create();
  const record = store.data.schedules[0], before = structuredClone(record), activity = store.data.activity;
  store.save = () => { throw new Error('Schedule update failed'); };
  assert.throws(() => manager.updateSchedule(schedule.id, { enabled: true, action: 'command', command: 'list', intervalMinutes: 1 }), /Schedule update failed/);
  assert.equal(store.data.schedules[0], record); assert.deepEqual(record, before); assert.equal(store.data.activity, activity);
});

test('invalid schedule inputs do not appear to accept server moves or readonly runtime fields', async t => {
  const { manager, store, create } = await fixture(t); const schedule = create(); const before = structuredClone(store.data.schedules);
  for (const input of [null, [], { status: 'completed' }, { serverId: 'two' }, { intervalMinutes: 0 }, { enabled: 'false' }]) assert.throws(() => manager.updateSchedule(schedule.id, input), error => error.status === 400);
  assert.throws(() => manager.createSchedule(null), error => error.status === 400);
  assert.deepEqual(store.data.schedules, before);
});
