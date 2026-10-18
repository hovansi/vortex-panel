import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostnameController, validateHostname, validatePrettyHostname, changeHostname, hostnameErrorPayload } from '../server/hostname.js';
import { localizeApiResponse } from '../server/locale.js';
import { federationFixture } from './nodes080-fixture.js';

function fixture(name = 'original-host', hooks = {}) {
  const state = { current: name, static: name, transient: name, pretty: `Existing pretty ${name}` }, calls = [];
  let controller;
  const execFile = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    assert.equal(command, '/usr/bin/hostnamectl'); assert.equal(options.shell, false); assert.equal(options.timeout, 8000);
    assert.ok(options.maxBuffer <= 16384); assert.equal(options.env.LC_ALL, 'C'); assert.equal(Object.hasOwn(options.env, 'SETUP_TOKEN'), false);
    if (args.includes('set-hostname')) {
      await hooks.beforeSet?.();
      if (args.includes('--pretty')) {
        if (!hooks.noPrettyApply) state.pretty = args.at(-1);
        if (hooks.prettyCommandError) throw new Error('PRIVATE pretty error');
      } else {
        if (!hooks.noApply) state.current = state.static = state.transient = args.at(-1);
        if (hooks.partial) state.transient = name;
      }
      if (hooks.commandError) throw new Error('PRIVATE execution error must never reach HTTP');
      return { stdout: '', stderr: '' };
    }
    if (hooks.readError?.()) throw new Error('PRIVATE read failure');
    const mode = args.find(value => ['--static', '--transient', '--pretty'].includes(value)).slice(2);
    return { stdout: state[mode] + '\n', stderr: '' };
  };
  controller = createHostnameController({ platform: 'linux', uid: 0, hostname: () => state.current, execFile });
  return { state, calls, controller, input: async hostname => ({ hostname, revision: (await controller.read()).revision, confirmed: true }), setCalls: () => calls.filter(call => call.args.includes('set-hostname')) };
}

test('hostname validation canonicalizes only ASCII case and rejects whitespace, shell injection and Linux length boundaries', () => {
  for (const value of ['node-001', 'node.example.com', '1', 'a'.repeat(63), 'a'.repeat(62) + '.b']) assert.equal(validateHostname(value), value);
  assert.equal(validateHostname('VortexPanel'), 'vortexpanel'); assert.equal(validateHostname('NODE.Example.COM'), 'node.example.com');
  for (const value of ['', ' localhost', 'localhost', 'localhost.localdomain', 'LOCALHOST', 'LocalHost.LocalDomain', 'Node ', 'a'.repeat(64), 'a'.repeat(65), '-Hremote', 'name-', 'a..b', '.a', 'a.', 'name;id', '$(id)', 'a\nb', 'a\0b', 'đám-mây', 'Ｎode', 'Kelvin', 'node?', 'node_name', null, {}]) assert.throws(() => validateHostname(value), { code: 'HOSTNAME_INVALID' });
});

test('uppercase hostname request uses reviewed canonical argv, lowercased audit target and unchanged revision checks', async () => {
  const f = fixture(), events = [], input = await f.input('VortexPanel');
  const result = await changeHostname(f.controller, input, { store: { audit(action, detail) { events.push({ action, detail: JSON.parse(detail) }); } } });
  assert.equal(result.requestedHostname, 'VortexPanel'); assert.equal(result.canonicalHostname, 'vortexpanel'); assert.equal(result.normalized, true);
  assert.equal(result.hostname.current, 'vortexpanel'); assert.equal(result.hostname.pretty, 'Existing pretty original-host');
  assert.equal(f.setCalls()[0].args.at(-1), 'vortexpanel'); assert.equal(events[0].detail.to, 'vortexpanel');
  await assert.rejects(f.controller.change(input), { code: 'HOSTNAME_STALE' });
  const noop = await f.controller.change(await f.input('VORTEXPANEL'));
  assert.equal(noop.changed, false); assert.equal(noop.canonicalHostname, 'vortexpanel'); assert.equal(noop.normalized, true); assert.equal(f.setCalls().length, 1);
});

test('verified hostname change uses only static/transient argv and preserves pretty hostname', async () => {
  const f = fixture(), before = await f.controller.read(), result = await f.controller.change(await f.input('new-node'));
  assert.equal(result.ok, true); assert.equal(result.changed, true); assert.equal(result.hostname.current, 'new-node');
  assert.equal(result.hostname.static, 'new-node'); assert.equal(result.hostname.transient, 'new-node'); assert.equal(result.hostname.pretty, before.pretty);
  assert.deepEqual(f.setCalls()[0].args, ['--no-ask-password', '--static', '--transient', 'set-hostname', 'new-node']);
  assert.notEqual(result.hostname.revision, before.revision); assert.equal(result.prettyPreserved, true);
  const same = await f.controller.change(await f.input('new-node')); assert.equal(same.changed, false); assert.equal(f.setCalls().length, 1);
});

test('friendly hostname is explicit, preserves entered case, and leaves DNS lowercase with a recorded intent', async () => {
  const f = fixture(), events = [], input = { ...await f.input('Vortex-Panel'), prettyHostname: 'Vortex-Panel' };
  assert.equal((await f.controller.read()).prettyEditable, true);
  const result = await changeHostname(f.controller, input, { store: { audit(action, detail) { events.push({ action, detail: JSON.parse(detail) }); } } });
  assert.equal(result.hostname.static, 'vortex-panel'); assert.equal(result.hostname.current, 'vortex-panel'); assert.equal(result.hostname.transient, 'vortex-panel');
  assert.equal(result.hostname.pretty, 'Vortex-Panel'); assert.equal(result.prettyRequested, true); assert.equal(result.prettyPreserved, false); assert.equal(result.normalized, true);
  assert.deepEqual(f.setCalls().map(call => call.args), [['--no-ask-password','--static','--transient','set-hostname','vortex-panel'],['--no-ask-password','--pretty','set-hostname','Vortex-Panel']]);
  assert.equal(events[0].detail.prettyTo, 'Vortex-Panel'); assert.equal(events[0].detail.prettyFrom, 'Existing pretty original-host');
  const noop = await f.controller.change({ ...await f.input('VORTEX-PANEL'), prettyHostname: 'Vortex-Panel' }); assert.equal(noop.changed, false); assert.equal(f.setCalls().length, 2);
});

test('friendly-only rename and explicit clearing never rewrite an already matching DNS name', async () => {
  const f = fixture('vortex-panel');
  const pretty = await f.controller.change({ ...await f.input('vortex-panel'), prettyHostname: 'Vortex Panel · Máy chủ' });
  assert.equal(pretty.hostname.pretty, 'Vortex Panel · Máy chủ'); assert.equal(f.setCalls().length, 1); assert.equal(f.setCalls()[0].args.includes('--static'), false);
  const clear = await f.controller.change({ ...await f.input('vortex-panel'), prettyHostname: '' }); assert.equal(clear.hostname.pretty, ''); assert.equal(f.state.current, 'vortex-panel');
});

test('friendly hostname boundaries reject malformed values before any command, and an omitted value keeps legacy behavior', async () => {
  for (const value of ['', 'Vortex-Panel', 'Vortex Panel · Máy chủ', 'A'.repeat(128)]) assert.equal(validatePrettyHostname(value), value);
  for (const value of [null, {}, 1, 'A'.repeat(129), '界'.repeat(100), ' node', 'node ', 'node\nname', 'node\0name', 'node\u0085name', 'node\u009fname', 'node\u2028name', 'node\u2029name', '\ud800']) assert.throws(() => validatePrettyHostname(value), { code: 'HOSTNAME_PRETTY_INVALID' });
  const f = fixture(); await assert.rejects(f.controller.change({ ...await f.input('safe-name'), prettyHostname: 'bad\nname' }), { code: 'HOSTNAME_PRETTY_INVALID' }); assert.equal(f.setCalls().length, 0);
  const legacy = await f.controller.change(await f.input('SAFE-NAME')); assert.equal(legacy.prettyRequested, false); assert.equal(legacy.prettyPreserved, true); assert.equal(f.state.pretty, 'Existing pretty original-host');
});

test('partial DNS failure does not touch friendly name and partial friendly failure is truthfully reported without replay', async () => {
  const dns = fixture('old-host', { partial: true });
  await assert.rejects(dns.controller.change({ ...await dns.input('new-node'), prettyHostname: 'New Node' }), error => error.code === 'HOSTNAME_VERIFY' && error.changed === true);
  assert.equal(dns.state.pretty, 'Existing pretty old-host'); assert.equal(dns.setCalls().length, 1);
  const pretty = fixture('old-host', { noPrettyApply: true });
  await assert.rejects(pretty.controller.change({ ...await pretty.input('new-node'), prettyHostname: 'New Node' }), error => error.code === 'HOSTNAME_VERIFY' && error.changed === true && error.hostname.current === 'new-node' && error.hostname.pretty === 'Existing pretty old-host');
  assert.equal(pretty.setCalls().length, 2);
  const warned = fixture('old-host', { prettyCommandError: true });
  const result = await warned.controller.change({ ...await warned.input('new-node'), prettyHostname: 'New Node' }); assert.equal(result.ok, true); assert.equal(result.hostname.pretty, 'New Node'); assert.equal(result.warnings.length, 1); assert.equal(warned.setCalls().length, 2);
});

test('stale revision, missing confirmation and unknown fields never execute the mutation', async () => {
  const f = fixture(), input = await f.input('new-node'); f.state.static = 'external-edit';
  await assert.rejects(f.controller.change(input), { code: 'HOSTNAME_STALE', status: 409 });
  await assert.rejects(f.controller.change({ ...input, confirmed: false }), { code: 'HOSTNAME_CONFIRM' });
  await assert.rejects(f.controller.change({ ...input, command: 'id' }), { code: 'HOSTNAME_INPUT' });
  await assert.rejects(f.controller.change({ hostname: 'new-node', confirmed: true }), { code: 'HOSTNAME_REVISION' });
  assert.equal(f.setCalls().length, 0);
});

test('root/platform/systemd failures expose truthful readonly capability without pretending to apply', async () => {
  let called = 0;
  const unsupported = createHostnameController({ platform: 'win32', uid: 0, hostname: () => 'windows-fixture', execFile: async () => { called++; } });
  const row = await unsupported.read(); assert.equal(row.editable, false); assert.equal(row.revision, null); assert.equal(row.current, 'windows-fixture'); assert.equal(called, 0);
  const unprivileged = createHostnameController({ platform: 'linux', uid: 1000, hostname: () => 'fixture', execFile: async () => ({ stdout: 'fixture\n' }) });
  assert.equal((await unprivileged.read()).editable, false);
  const absent = createHostnameController({ platform: 'linux', uid: 0, hostname: () => 'fixture', execFile: async () => { throw new Error('private D-Bus error'); } });
  const missing = await absent.read(); assert.equal(missing.editable, false); assert.equal(missing.static, null); assert.equal(missing.current, 'fixture'); assert.equal(JSON.stringify(missing).includes('private D-Bus'), false);
});

test('command timeout/error is not blindly retried and independently observed success is distinguished', async () => {
  const applied = fixture('old-host', { commandError: true });
  const success = await applied.controller.change(await applied.input('new-node')); assert.equal(success.ok, true); assert.equal(success.hostname.current, 'new-node'); assert.equal(success.warnings.length, 1); assert.equal(applied.setCalls().length, 1);
  const failed = fixture('old-host', { commandError: true, noApply: true });
  await assert.rejects(failed.controller.change(await failed.input('new-node')), error => {
    const payload = hostnameErrorPayload(error, 'vi'); assert.equal(payload.outcomeUnknown, true); assert.equal(payload.hostname.current, 'old-host'); assert.equal(JSON.stringify(payload).includes('PRIVATE'), false); assert.equal(payload.error, payload.errorI18n.vi); return true;
  });
  assert.equal(failed.setCalls().length, 1);
  const partial = fixture('old-host', { partial: true });
  await assert.rejects(partial.controller.change(await partial.input('new-node')), error => error.code === 'HOSTNAME_VERIFY' && error.changed === true && error.hostname.transient === 'old-host');
  let written = false;
  const unreadable = fixture('old-host', { beforeSet: () => { written = true; }, readError: () => written });
  await assert.rejects(unreadable.controller.change(await unreadable.input('new-node')), error => error.outcomeUnknown === true && error.changed === undefined && error.hostname.revision === null);
});

test('durable request audit failure blocks the OS command; postchange audit failure is an explicit warning', async () => {
  const f = fixture(), input = await f.input('new-node');
  await assert.rejects(changeHostname(f.controller, input, { store: { audit() { throw new Error('ENOSPC'); } }, user: { username: 'human-admin' } }), { code: 'HOSTNAME_AUDIT' });
  assert.equal(f.setCalls().length, 0); assert.equal(f.state.current, 'original-host');
  const events = [], store = { audit(action, detail, actor) { events.push({ action, detail: JSON.parse(detail), actor }); if (action === 'host.hostname.changed') throw new Error('ENOSPC'); } };
  const result = await changeHostname(f.controller, input, { store, user: { username: 'human-admin' }, nodeId: 'local' });
  assert.equal(result.ok, true); assert.equal(result.hostname.current, 'new-node'); assert.equal(result.warnings.length, 1); assert.equal(events[0].actor, 'human-admin'); assert.equal(events[0].detail.nodeId, 'local');
  assert.equal(JSON.stringify(result).includes('ENOSPC'), false);
});

test('host-wide request serialization and shutdown drain prevent overlapping or late hostname writes', async () => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const a = fixture('host-a', { beforeSet: async () => { began(); await gate; } }), b = fixture('host-b');
  const request = a.controller.change(await a.input('new-a')); await started;
  await assert.rejects(b.controller.change(await b.input('new-b')), { code: 'HOSTNAME_BUSY' });
  let closed = false; const closing = a.controller.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release(); assert.equal((await request).hostname.current, 'new-a'); await closing; assert.equal(closed, true);
  await assert.rejects(a.controller.change(await a.input('late-a')), { code: 'HOSTNAME_CLOSED' }); assert.equal(a.setCalls().length, 1); assert.equal(b.setCalls().length, 0);
});

test('demo hostname writes are explicitly simulated and bilingual reasons never rewrite the actual hostname value', async () => {
  const controller = createHostnameController({ demo: true, execFile: async () => { throw new Error('Must not execute'); } });
  const before = await controller.read(), result = await controller.change({ hostname: 'demo-example', revision: before.revision, confirmed: true });
  assert.equal(result.hostname.simulated, true); assert.equal(result.hostname.current, 'demo-example'); assert.equal(result.hostname.editable, true);
  const localized = localizeApiResponse('/api/nodes/local/hostname', result, 'vi'); assert.equal(localized.hostname.current, 'demo-example'); assert.equal(localized.hostname.reason, result.hostname.reasonI18n.vi);
});

test('real authenticated HTTP hostname routes isolate Main and each agent, retain display names and enforce RBAC/CSRF', async t => {
  const central = fixture('main-machine'), agents = [fixture('agent-one'), fixture('agent-two')];
  const f = await federationFixture(t, { hostnameControllers: { central: central.controller, agents: agents.map(row => row.controller) } });
  const before = (await f.request('/nodes')).data.nodes.map(node => ({ id: node.id, name: node.name, endpoint: node.endpoint, agentId: node.agentId }));
  for (const [id, desired, target] of [['local', 'main-renamed', central], [f.agents[0].linked.id, 'agent-renamed', agents[0]]]) {
    const read = await f.request(`/nodes/${id}/hostname`); assert.equal(read.status, 200); assert.equal(read.data.hostname.current, target.state.current); assert.equal(read.data.hostname.editable, true);
    const body = { hostname: desired, prettyHostname: 'Vortex Friendly '+(id === 'local' ? 'Main' : 'Node'), revision: read.data.hostname.revision, confirmed: true };
    const changed = await f.request(`/nodes/${id}/hostname`, { method: 'PATCH', body }); assert.equal(changed.status, 200); assert.equal(changed.data.nodeId, id); assert.equal(changed.data.hostname.current, desired); assert.equal(changed.data.hostname.pretty, body.prettyHostname); assert.equal(changed.data.prettyRequested, true);
    assert.equal((await f.request(`/nodes/${id}/hostname`, { method: 'PATCH', body })).status, 409);
    assert.equal((await f.request(`/nodes/${id}/hostname`, { method: 'POST', body })).status, 404);
  }
  assert.equal(agents[1].state.current, 'agent-two');
  const after = (await f.request('/nodes')).data.nodes.map(node => ({ id: node.id, name: node.name, endpoint: node.endpoint, agentId: node.agentId })); assert.deepEqual(after, before);
  const remoteAudit = f.agents[0].store.data.activity.find(row => row.action === 'host.hostname.changed'); assert.equal(remoteAudit.user, 'nodes-admin'); assert.equal(JSON.parse(remoteAudit.detail).nodeId, f.agents[0].nodeId);
  for (const role of ['operator', 'viewer']) {
    const actor = await f.createUser('hostname-' + role, { role, allServers: true });
    for (const id of ['local', f.agents[0].linked.id]) {
      assert.equal((await f.request(`/nodes/${id}/hostname`, { actor })).status, 403);
      assert.equal((await f.request(`/nodes/${id}/hostname`, { actor, method: 'PATCH', body: { hostname: 'forbidden-host', revision: '0'.repeat(64), confirmed: true } })).status, 403);
    }
    const header = Buffer.from(JSON.stringify({ id: actor.user.id, username: actor.user.username, role, allServers: true, serverIds: [] })).toString('base64url');
    const direct = await fetch(f.agents[0].endpoint + '/api/node/hostname', { headers: { Authorization: 'Bearer ' + f.agents[0].token, 'X-Vortex-Actor': header } }); assert.equal(direct.status, 403);
    const directWrite = await fetch(f.agents[0].endpoint + '/api/node/hostname', { method: 'PATCH', headers: { Authorization: 'Bearer ' + f.agents[0].token, 'X-Vortex-Actor': header, 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: 'forbidden-agent', revision: '0'.repeat(64), confirmed: true }) }); assert.equal(directWrite.status, 403);
  }
  const read = (await f.request('/nodes/local/hostname')).data.hostname;
  assert.equal((await f.request('/nodes/local/hostname', { method: 'PATCH', body: { hostname: 'csrf-host', revision: read.revision, confirmed: true }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/nodes/local/hostname', { method: 'PATCH', body: { hostname: 'csrf-host', revision: read.revision, confirmed: true }, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  const remoteRead = (await f.request(`/nodes/${f.agents[0].linked.id}/hostname`)).data.hostname;
  assert.equal((await f.request(`/nodes/${f.agents[0].linked.id}/hostname`, { method: 'PATCH', body: { hostname: 'agent-renamed', revision: remoteRead.revision, confirmed: true, command: 'invalid' } })).status, 400);
  let attempts = 0; const originalCall = f.central.nodes.call;
  f.central.nodes.call = async () => { attempts++; throw Object.assign(new Error('PRIVATE failed transport data'), { status: 504 }); };
  try {
    const unknown = await f.request(`/nodes/${f.agents[0].linked.id}/hostname`, { method: 'PATCH', body: { hostname: 'unknown-outcome', revision: remoteRead.revision, confirmed: true } });
    assert.equal(unknown.status, 504); assert.equal(unknown.data.code, 'HOSTNAME_UNKNOWN'); assert.equal(unknown.data.outcomeUnknown, true); assert.equal(JSON.stringify(unknown.data).includes('PRIVATE'), false); assert.equal(attempts, 1);
  } finally { f.central.nodes.call = originalCall; }
  assert.equal(central.state.current, 'main-renamed'); assert.equal(agents[0].setCalls().length, 2); assert.equal(agents[1].setCalls().length, 0);
  assert.equal((await fetch(f.agents[0].endpoint + '/api/host/hostname', { method: 'PATCH', headers: { Authorization: 'Bearer ' + f.agents[0].token, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  t.diagnostic('All hostnamectl calls are injected in-memory OS boundaries. Sessions, Origin/CSRF, bearer forwarding, actor ACL and audit persistence use real HTTP; no actual machine hostname is changed.');
});
