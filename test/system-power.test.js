import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSystemPowerController, systemPowerCommand, systemPowerErrorPayload } from '../server/system-power.js';
import { federationFixture, eventually } from './nodes080-fixture.js';

async function fixture(t, options = {}) {
  const dataDir = options.dataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-power-'));
  const calls = [], audit = [], releases = [], gates = [];
  const controller = createSystemPowerController({ dataDir, platform: 'linux', uid: 0, nodeId: 'local', bootId: 'inert-boot-one',
    probe: async () => ({ available: true, bootId: 'inert-boot-one' }),
    store: { audit(action, detail, actor) { audit.push({ action, detail: JSON.parse(detail), actor }); } },
    manager: { beginMaintenance(value) { gates.push(value); return () => releases.push(value); } },
    dispatch: async value => { calls.push(value); }, ...options });
  if (!options.dataDir) t.after(async () => { await controller.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const input = async (action = 'restart-service') => ({ nodeId: options.nodeId || 'local', action, confirmed: true, requestId: randomUUID(), revision: (await controller.read()).revision });
  return { controller, dataDir, calls, audit, releases, gates, input };
}

test('restart commands use fixed role allowlists, without shell or arbitrary target arguments', () => {
  const id = randomUUID();
  for (const [role, unit] of [['panel', 'bedrock-panel.service'], ['worker', 'vortex-node.service']]) {
    const restart = systemPowerCommand(role, 'restart-service', id);
    assert.equal(restart.command, '/usr/bin/systemd-run');
    assert.deepEqual(restart.args.slice(-4), ['/usr/bin/systemctl', '--no-ask-password', 'restart', unit]);
    assert.ok(restart.args.includes('--on-active=2s'));
    assert.deepEqual(systemPowerCommand(role, 'reboot', id).args.slice(-3), ['/usr/bin/systemctl', '--no-ask-password', 'reboot']);
  }
  for (const args of [['unknown', 'restart-service', id], ['panel', 'poweroff', id], ['panel', 'reboot', '$(reboot)']]) assert.throws(() => systemPowerCommand(...args), { code: 'POWER_INPUT' });
});

test('durable intent precedes dispatch, successful scheduling freezes admission, and retries never dispatch again', async t => {
  const f = await fixture(t), input = await f.input(), accepted = await f.controller.request(input, { user: { username: 'real-admin' } });
  assert.equal(accepted.accepted, true); assert.equal(accepted.operation.status, 'accepted'); assert.equal(f.calls.length, 0); assert.equal(f.gates.length, 1);
  const journal = JSON.parse(await fs.readFile(path.join(f.dataDir, 'power-operations.json'), 'utf8'));
  assert.equal(journal.records[0].requestId, input.requestId); assert.equal(journal.records[0].status, 'accepted');
  assert.equal(f.audit[0].actor, 'real-admin'); assert.equal(f.audit[0].action, 'host.power.requested');
  const replay = await f.controller.request(input); assert.equal(replay.replayed, true); assert.equal(f.gates.length, 1);
  await f.controller.dispatch(input.requestId); await f.controller.dispatch(input.requestId);
  assert.equal(f.calls.length, 1); assert.equal((await f.controller.read()).lastOperation.status, 'scheduled'); assert.equal(f.releases.length, 0);
  await assert.rejects(f.controller.request(await f.input('reboot')), { code: 'POWER_BUSY' });
  await assert.rejects(f.controller.request({ ...input, action: 'reboot' }), { code: 'POWER_REQUEST_ID' });
});

test('stale identity, wrong-node forms, missing confirmation and unknown fields cannot schedule anything', async t => {
  const f = await fixture(t), valid = await f.input();
  for (const [input, code] of [[{ ...valid, revision: '0'.repeat(64) }, 'POWER_STALE'], [{ ...valid, nodeId: randomUUID() }, 'POWER_TARGET'], [{ ...valid, confirmed: false }, 'POWER_CONFIRM'], [{ ...valid, command: 'reboot' }, 'POWER_INPUT'], [{ ...valid, requestId: '--reboot' }, 'POWER_REQUEST_ID']]) await assert.rejects(f.controller.request(input), { code });
  assert.equal(f.calls.length, 0); assert.equal(f.gates.length, 0);
});

test('busy manager, unavailable platform and persistence failure block execution and leave admission open', async t => {
  const busy = await fixture(t, { manager: { beginMaintenance() { throw new Error('Busy backup'); } } });
  await assert.rejects(busy.controller.request(await busy.input()), { code: 'POWER_BUSY' }); assert.equal(busy.calls.length, 0);
  const unavailable = await fixture(t, { probe: async () => ({ available: false, reasonCode: 'POWER_UNAVAILABLE' }) });
  assert.equal((await unavailable.controller.read()).available, false); await assert.rejects(unavailable.controller.request(await unavailable.input()), { code: 'POWER_UNAVAILABLE' });
  const failed = await fixture(t, { store: { audit() { throw new Error('PRIVATE DISK INFO'); } } });
  await assert.rejects(failed.controller.request(await failed.input()), error => {
    const payload = systemPowerErrorPayload(error, 'vi'); assert.equal(payload.code, 'POWER_AUDIT'); assert.equal(payload.error, payload.errorI18n.vi); assert.equal(JSON.stringify(payload).includes('PRIVATE'), false); return true;
  });
  assert.equal(failed.calls.length, 0); assert.equal(failed.releases.length, 1);
});

test('disconnected acceptance cancels once, scheduling errors are visible, and watchdog reports a missing restart', async t => {
  const cancelled = await fixture(t), input = await cancelled.input();
  await cancelled.controller.request(input); await cancelled.controller.cancel(input.requestId); await cancelled.controller.dispatch(input.requestId);
  assert.equal(cancelled.calls.length, 0); assert.equal((await cancelled.controller.read()).lastOperation.error, 'POWER_INTERRUPTED'); assert.equal(cancelled.releases.length, 1);
  const failed = await fixture(t, { dispatch: async () => { throw Object.assign(new Error('PRIVATE scheduling detail'), { code: 'ENOENT' }); } });
  const request = await failed.input(); await failed.controller.request(request); await failed.controller.dispatch(request.requestId);
  const row = (await failed.controller.read()).lastOperation; assert.equal(row.status, 'failed'); assert.equal(row.error, 'POWER_SCHEDULE_FAILED'); assert.equal(failed.releases.length, 1);
  assert.equal((await failed.controller.request(request)).replayed, true);
  let watchdog;
  const timeout = await fixture(t, { setTimer(callback, ms) { assert.equal(ms, 180000); watchdog = callback; return { unref() {} }; }, clearTimer() {} });
  const pending = await timeout.input(); await timeout.controller.request(pending); await timeout.controller.dispatch(pending.requestId); watchdog();
  await eventually(async () => assert.equal((await timeout.controller.read()).lastOperation.error, 'POWER_NOT_COMPLETED'));
  assert.equal((await timeout.controller.read()).lastOperation.status, 'unknown'); assert.equal(timeout.releases.length, 0);
  await assert.rejects(timeout.controller.request(await timeout.input()), { code: 'POWER_BUSY' });
  const uncertain = await fixture(t, { dispatch: async () => { throw Object.assign(new Error('PRIVATE bus timeout'), { code: 'ETIMEDOUT' }); } });
  const uncertainInput = await uncertain.input(); await uncertain.controller.request(uncertainInput); await uncertain.controller.dispatch(uncertainInput.requestId);
  assert.equal((await uncertain.controller.read()).lastOperation.status, 'unknown'); assert.equal(uncertain.releases.length, 0);
  assert.equal((await uncertain.controller.request(uncertainInput)).replayed, true);
  await assert.rejects(uncertain.controller.request(await uncertain.input()), { code: 'POWER_BUSY' });
});

test('a new service generation reconciles the durable result without reissuing old power requests', async t => {
  const first = await fixture(t, { instanceId: 'inert-generation-one' }), input = await first.input();
  await first.controller.request(input); await first.controller.dispatch(input.requestId); await first.controller.close();
  const next = await fixture(t, { dataDir: first.dataDir, instanceId: 'inert-generation-two' });
  t.after(() => next.controller.close());
  const after = await next.controller.read(); assert.equal(after.lastOperation.status, 'completed'); assert.notEqual(after.revision, input.revision);
  assert.equal((await next.controller.request(input)).replayed, true); assert.equal(next.calls.length, 0);
  await assert.rejects(next.controller.request({ ...input, requestId: randomUUID() }), { code: 'POWER_STALE' });
});

test('a reboot requires a new boot identity, and an uncertain dispatch is reconciled after an observed reboot', async t => {
  const first = await fixture(t, { instanceId: 'before-reboot', dispatch: async () => { throw Object.assign(new Error('Lost D-Bus reply'), { code: 'ETIMEDOUT' }); } });
  const input = await first.input('reboot'); await first.controller.request(input); await first.controller.dispatch(input.requestId); await first.controller.close();
  const unchanged = await fixture(t, { dataDir: first.dataDir, instanceId: 'restarted-without-reboot' });
  const unresolved = await unchanged.controller.read();
  assert.equal(unresolved.lastOperation.status, 'unknown'); assert.equal(unresolved.busy, true);
  assert.equal(unresolved.reasonI18n.id, 'panel.power.reboot_pending');
  assert.equal(unchanged.gates[0].restore, true);
  await assert.rejects(unchanged.controller.request(await unchanged.input('reboot')), { code: 'POWER_BUSY' });
  await unchanged.controller.close();
  const rebooted = await fixture(t, { dataDir: first.dataDir, instanceId: 'after-reboot', bootId: 'inert-boot-two' });
  t.after(() => rebooted.controller.close());
  assert.equal((await rebooted.controller.read()).lastOperation.status, 'completed');
  assert.equal((await rebooted.controller.request(input)).replayed, true); assert.equal(rebooted.calls.length, 0);
});

test('real authenticated HTTP routes enforce RBAC/CSRF, bind public IDs to enrolled agents and dispatch only after acceptance', async t => {
  function proxy() { let value; return { set(controller) { value = controller; }, read: (...args) => value ? value.read(...args) : Promise.resolve({ instanceId: 'inert-initial-fixture' }), request: (...args) => value.request(...args), dispatch: (...args) => value.dispatch(...args), cancel: (...args) => value.cancel(...args), close: () => value?.close() }; }
  const central = proxy(), agents = [proxy(), proxy()];
  const f = await federationFixture(t, { powerControllers: { central, agents } });
  const targets = [f.central, ...f.agents.map(agent => agent.runtime)], calls = [[], [], []];
  for (const [index, runtime] of targets.entries()) {
    const nodeId = index ? f.agents[index - 1].nodeId : 'local';
    const controller = createSystemPowerController({ role: index ? 'worker' : 'panel', nodeId, dataDir: index ? f.agents[index - 1].dataDir : path.join(f.root, 'controller'), store: runtime.store, manager: runtime.manager,
      probe: async () => ({ available: true, bootId: 'inert-http-boot' }), dispatch: async input => { calls[index].push(input); } });
    (index ? agents[index - 1] : central).set(controller);
  }
  const publicIds = ['local', ...f.agents.map(agent => agent.linked.id)];
  for (const role of ['operator', 'viewer']) {
    const actor = await f.createUser('power-' + role, { role, allServers: true });
    for (const id of [publicIds[0], publicIds[1]]) {
      assert.equal((await f.request(`/nodes/${id}/power`, { actor })).status, 403);
      assert.equal((await f.request(`/nodes/${id}/power`, { actor, body: {} })).status, 403);
    }
    assert.equal((await f.request('/host/power', { actor })).status, 403);
  }
  const read = (await f.request('/host/power')).data.power;
  const input = { nodeId: 'local', action: 'restart-service', confirmed: true, requestId: randomUUID(), revision: read.revision };
  assert.equal((await f.request('/host/power', { body: input, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/host/power', { body: input, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.request('/nodes/local/power', { body: { ...input, nodeId: publicIds[1] } })).status, 409);
  const remoteRead = (await f.request(`/nodes/${publicIds[1]}/power`)).data.power;
  assert.equal(remoteRead.nodeId, publicIds[1]); assert.equal(remoteRead.role, 'worker'); assert.equal(remoteRead.available, true);
  const remoteBody = { ...input, nodeId: publicIds[1], revision: remoteRead.revision, requestId: randomUUID() };
  assert.equal((await f.request(`/nodes/${publicIds[1]}/power`, { body: { ...remoteBody, revision: read.revision } })).status, 409);
  const accepted = await f.request(`/nodes/${publicIds[1]}/power`, { body: remoteBody });
  assert.equal(accepted.status, 202); assert.equal(accepted.data.operation.status, 'accepted'); assert.equal(accepted.data.power.nodeId, publicIds[1]);
  await eventually(() => assert.equal(calls[1].length, 1));
  const remotePending = (await f.request(`/nodes/${publicIds[1]}/power`)).data.power;
  assert.equal(remotePending.busy, true); assert.equal(remotePending.nodeId, publicIds[1]); assert.equal(remotePending.lastOperation.requestId, remoteBody.requestId);
  const pausedRemote = await f.request(`/nodes/${publicIds[1]}/hostname`, { method: 'PATCH', body: { hostname: 'blocked-during-restart', revision: '0'.repeat(64), confirmed: true } });
  assert.equal(pausedRemote.status, 409); assert.equal(pausedRemote.data.code, 'POWER_BUSY');
  assert.equal((await f.request(`/nodes/${publicIds[1]}/power`, { body: remoteBody })).data.replayed, true); assert.equal(calls[1].length, 1); assert.equal(calls[0].length, 0); assert.equal(calls[2].length, 0);
  const denied = await fetch(f.agents[1].endpoint + '/api/node/power', { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(denied.status, 401);
  const operator = { id: 'forwarded-operator', username: 'forwarded.operator', role: 'operator', allServers: true, serverIds: [] };
  const forbidden = await fetch(f.agents[1].endpoint + '/api/node/power', { headers: { Authorization: 'Bearer ' + f.agents[1].token, 'X-Vortex-Actor': Buffer.from(JSON.stringify(operator)).toString('base64url') } }); assert.equal(forbidden.status, 403);
  const forbiddenWrite = await fetch(f.agents[1].endpoint + '/api/node/power', { method: 'POST', headers: { Authorization: 'Bearer ' + f.agents[1].token, 'X-Vortex-Actor': Buffer.from(JSON.stringify(operator)).toString('base64url'), 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(forbiddenWrite.status, 403);
  let attempts = 0; const originalCall = f.central.nodes.call;
  f.central.nodes.call = async () => { attempts++; throw Object.assign(new Error('PRIVATE transport data'), { status: 504 }); };
  try {
    const unknown = await f.request(`/nodes/${publicIds[2]}/power`, { body: { ...input, nodeId: publicIds[2], requestId: randomUUID() } });
    assert.equal(unknown.status, 504); assert.equal(unknown.data.code, 'POWER_UNKNOWN'); assert.equal(unknown.data.outcomeUnknown, true); assert.equal(attempts, 1); assert.equal(JSON.stringify(unknown.data).includes('PRIVATE'), false);
  } finally { f.central.nodes.call = originalCall; }
  const localAccepted = await f.request('/host/power', { body: input }); assert.equal(localAccepted.status, 202);
  await eventually(() => assert.equal(calls[0].length, 1));
  assert.equal((await f.request('/nodes/local/power', { body: input })).data.replayed, true); assert.equal(calls[0].length, 1);
  const pending = await f.request('/host/power'); assert.equal(pending.data.power.busy, true); assert.equal(pending.headers.get('cache-control'), 'no-store');
  assert.equal(pending.data.power.lastOperation.baseline.revision, input.revision);
  assert.equal((await f.request('/nodes/provision', { body: {} })).status, 409);
  assert.equal((await f.request('/servers', { body: {} })).status, 409);
  assert.equal((await f.request(`/nodes/${publicIds[2]}/hostname`, { method: 'PATCH', body: {} })).status, 409);
  t.diagnostic('System power commands are injected and inert. HTTP sessions, Origin/CSRF, bearer forwarding, actor ACL and durable journals are real. No service or machine was restarted.');
});
