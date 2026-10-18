import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createNodeRemovalController, createNodeRemovalAgent } from '../server/node-removal.js';
import { federationFixture } from './nodes080-fixture.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(callback) { const until = Date.now() + 3000; let error; do { try { return await callback(); } catch (value) { error = value; } await pause(10); } while (Date.now() < until); throw error; }
function modelIntentOwner(t, filename, changes = () => ({ uid: 0 })) {
  const original = nativeFs.lstatSync;
  // The native-agent fixture models a root worker even when CI runs as an
  // unprivileged user. Preserve the real file's type, links, mode and size;
  // model only this fixture's owner unless a rejection case changes a field.
  t.mock.method(nativeFs, 'lstatSync', (target, ...args) => {
    const info = original(target, ...args);
    if (typeof target !== 'string' || path.resolve(target) !== path.resolve(filename)) return info;
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, changes());
  });
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-removal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const node = { id: randomUUID(), agentId: randomUUID(), name: 'Owned fixture worker', endpoint: 'https://fixture.example:8443', inventory: [] }, user = { id: randomUUID(), username: 'removal-admin', role: 'admin' };
  const fingerprint = 'A'.repeat(64), revision = 'b'.repeat(64), sshInput = () => ({ host: 'fixture.example', port: 22, username: 'root', password: 'PRIVATE_SSH_FIXTURE', hostFingerprint: 'SHA256:' + 'c'.repeat(43) });
  const plan = { schemaVersion: 1, agentId: node.agentId, revision, status: 'ready', serverCount: 0, blockers: [], components: [], fingerprint, sshRequired: true, legacyOwnership: true, fullyClean: false };
  const store = { data: { nodes: [node], nodeRemovalJobs: [] }, saves: 0, save() { this.saves++; if (options.failSave?.()) throw new Error('PRIVATE_PERSIST_FIXTURE'); } };
  const calls = [], commands = []; let dispatched = 0, unlinked = 0, frozen = false;
  const nodes = {
    get(id) { const found = store.data.nodes.find(row => row.id === id); if (!found) throw Object.assign(new Error('missing'), { status: 404 }); return found; },
    credentials() { return { fingerprint }; }, actorHeader() { return 'fixture-actor'; },
    async call(_node, input) { calls.push(input); if (input.path.endsWith('/plan')) return options.blocked ? { ...plan, status: 'blocked', serverCount: 1 } : { ...plan }; if (input.path.endsWith('/prepare')) { frozen = true; if (options.lostPrepare) throw new Error('prepare response lost'); return { accepted: true, nodeId: node.agentId, requestId: input.body.requestId }; } if (input.path.endsWith('/abort')) { frozen = false; return { ok: true }; } throw new Error('unexpected worker request'); },
    async beginRemoval(id, requestId) { if (node.removalOperationId && node.removalOperationId !== requestId) throw new Error('locked'); node.removalOperationId = requestId; store.save(); },
    async cancelRemoval() { delete node.removalOperationId; store.save(); },
    async completeRemoval(id, requestId, actor, proof, commit) { assert.equal(proof.verified, true); assert.equal(requestId, node.removalOperationId); assert.equal(actor.role, 'admin'); if (options.failUnlink) throw new Error('PRIVATE_PERSIST_FIXTURE'); commit(); store.data.nodes = []; store.save(); unlinked++; },
  };
  const helper = await fs.readFile(new URL('../server/node-removal.py', import.meta.url));
  const zramReference = await fs.readFile(new URL('../server/host-zram.py', import.meta.url));
  let currentJob;
  const connection = {
    async exec(command) {
      commands.push(command);
      if (command.includes(' systemd-run ') || command.startsWith('/usr/bin/systemd-run')) { dispatched++; if (options.lostDispatch) throw new Error('PRIVATE_SSH_FIXTURE'); return { stdout: '', code: 0 }; }
      if (command.startsWith('sha256sum')) return { stdout: createHash('sha256').update(command.includes('host-zram.reference.py') ? zramReference : helper).digest('hex') + ' helper.py', code: 0 };
      if (command.includes(' plan --node-id ')) return { stdout: JSON.stringify(options.wrongIdentity ? { ...plan, agentId: randomUUID() } : plan), code: 0 };
      if (command.includes(' verify --node-id ')) { const job = currentJob || store.data.nodeRemovalJobs[0]; if (options.preparedOnlyProof) return { stdout: JSON.stringify({ schemaVersion: 1, nodeId: node.agentId, requestId: job.requestId, safeToCancel: true, inventoryEmpty: true, activeWorkerVerified: true, verified: false, revision, fingerprint }), code: 0 }; return { stdout: JSON.stringify({ schemaVersion: 1, nodeId: options.wrongProof ? randomUUID() : node.agentId, requestId: job.requestId, verified: !options.incompleteProof, inventoryEmpty: true, serviceRemoved: true, filesVerified: true, processesAbsent: true, mountsAbsent: true, firewallRemoved: true, networkCountersRemoved: true, zramRemoved: true, remainingOwnedPaths: [], retained: [{ path: '/opt/vortex-node/releases/legacy', reason: 'No original ownership receipt.' }] }), code: 0 }; }
      return { stdout: '', code: 0 };
    }, async write(filename, bytes) { assert.deepEqual(bytes, filename.endsWith('host-zram.reference.py') ? zramReference : helper); },
    async read() { const job = currentJob || store.data.nodeRemovalJobs[0]; return Buffer.from(JSON.stringify({ nodeId: node.agentId, requestId: job.requestId, status: options.failedBeforeEffects ? 'failed' : 'completed', effectStarted: !options.failedBeforeEffects, retained: [] })); },
  };
  const ssh = async (input, callback) => { assert.equal(input.hostFingerprint, sshInput().hostFingerprint); if (options.sshDenied) throw new Error('PRIVATE_SSH_FIXTURE'); return callback(connection); };
  const controller = createNodeRemovalController({ nodes, store, dataDir: root, projectDir: path.resolve('.'), ssh, pollIntervalMs: 1, operationTimeoutMs: 100, sleep: pause });
  t.after(() => controller.close());
  const input = () => ({ nodeId: node.id, revision, requestId: randomUUID(), confirmed: true, confirmationName: node.name, ssh: sshInput() });
  return { controller, nodes, store, node, user, input, sshInput, calls, commands, root, get dispatched() { return dispatched; }, get unlinked() { return unlinked; }, get frozen() { return frozen; }, setJob(value) { currentJob = value; } };
}

test('verified uninstall records intent, checks SSH identity, dispatches once and unlinks only after independent proof', async t => {
  const f = await fixture(t), input = f.input(), requestId = input.requestId;
  const [first, retry] = await Promise.all([f.controller.start(f.node.id, input, f.user), f.controller.start(f.node.id, { ...f.input(), requestId }, f.user)]);
  assert.equal(first.id, retry.id); assert.equal(input.ssh.password, undefined);
  await eventually(() => assert.equal(f.controller.getJob(first.id).status, 'completed'));
  const result = f.controller.getJob(first.id);
  assert.equal(f.dispatched, 1); assert.equal(f.unlinked, 1); assert.equal(result.verified, true); assert.equal(result.cleanupScope, 'active-worker-components'); assert.ok(result.retainedComponents.length);
  assert.ok(f.commands.findIndex(value => value.includes(' verify --node-id ')) > f.commands.findIndex(value => value.startsWith('/usr/bin/systemd-run')));
  for (const value of [JSON.stringify(f.store.data), JSON.stringify(result), f.commands.join('\n')]) assert.equal(value.includes('PRIVATE_SSH_FIXTURE'), false);
  assert.equal(f.store.data.nodeRemovalJobs.length, 1);
});

test('202, disconnection, wrong receipt and failed completion persistence never imply uninstall success', async t => {
  for (const option of [{ lostDispatch: true }, { incompleteProof: true }, { wrongProof: true }, { failUnlink: true }]) {
    const f = await fixture(t, option), job = await f.controller.start(f.node.id, f.input(), f.user);
    await eventually(() => assert.ok(['unknown', 'partial'].includes(f.controller.getJob(job.id).status)));
    assert.equal(f.unlinked, 0); assert.equal(f.store.data.nodes.length, 1); assert.equal(f.node.removalOperationId, job.id); assert.equal(f.dispatched, 1);
    const resumed = await f.controller.verify(job.id, { nodeId: f.node.id, requestId: job.requestId, ssh: f.sshInput() }, f.user);
    assert.equal(resumed.id, job.id);
    await eventually(() => assert.ok((option.lostDispatch ? ['completed'] : ['unknown', 'partial']).includes(f.controller.getJob(job.id).status)));
    assert.equal(f.dispatched, 1, 'Recovery only verifies; it never dispatches removal again');
  }
});

test('wrong SSH node, authentication failure and nonempty inventory cannot dispatch or silently unlink', async t => {
  for (const option of [{ wrongIdentity: true }, { sshDenied: true }]) {
    const f = await fixture(t, option), job = await f.controller.start(f.node.id, f.input(), f.user);
    await eventually(() => assert.equal(f.controller.getJob(job.id).status, 'failed'));
    assert.equal(f.dispatched, 0); assert.equal(f.unlinked, 0); assert.equal(f.node.removalOperationId, undefined); assert.equal(f.frozen, false);
  }
  const blocked = await fixture(t, { blocked: true });
  await assert.rejects(blocked.controller.start(blocked.node.id, blocked.input(), blocked.user), /blocked or has changed/);
  await assert.rejects(blocked.controller.plan('local'), /main panel VPS/); assert.equal(blocked.dispatched, 0); assert.equal(blocked.store.data.nodeRemovalJobs.length, 0);
});

test('known failure before effects cancels worker freeze, while mismatched recovery SSH identity is refused', async t => {
  const f = await fixture(t, { failedBeforeEffects: true }), job = await f.controller.start(f.node.id, f.input(), f.user);
  await eventually(() => assert.equal(f.node.removalOperationId, undefined));
  assert.equal(f.frozen, false); assert.equal(f.controller.getJob(job.id).status, 'failed');
  await assert.rejects(f.controller.verify(job.id, { nodeId: f.node.id, requestId: job.requestId, ssh: { ...f.sshInput(), host: 'other.example' } }, f.user), /pinned SSH host/);
});

test('lost prepare response stays unknown until SSH proves an intact prelaunch worker and safely cancels matching freeze', async t => {
  const f = await fixture(t, { lostPrepare: true, preparedOnlyProof: true }), job = await f.controller.start(f.node.id, f.input(), f.user);
  await eventually(() => assert.equal(f.controller.getJob(job.id).status, 'unknown'));
  assert.equal(f.frozen, true); assert.equal(f.node.removalOperationId, job.id); assert.equal(f.dispatched, 0);
  await f.controller.verify(job.id, { nodeId: f.node.id, requestId: job.requestId, ssh: f.sshInput() }, f.user);
  await eventually(() => assert.equal(f.controller.getJob(job.id).status, 'failed'));
  assert.equal(f.frozen, false); assert.equal(f.node.removalOperationId, undefined); assert.equal(f.unlinked, 0); assert.equal(f.dispatched, 0); assert.equal(f.store.data.nodes.length, 1);
});

test('Agent admission freeze survives restart, validates generation and rejects servers admitted during preflight', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-removal-agent-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  modelIntentOwner(t, path.join(directory, '.removal-intent.json'));
  const nodeId = randomUUID(), revision = 'f'.repeat(64), requestId = randomUUID(); let locked = false, servers = [], probes = 0;
  const manager = { listServers: () => servers, beginMaintenance(value) { assert.equal(value.action, 'uninstall'); locked = true; return () => { locked = false; }; } };
  const args = { nodeId, dataDir: directory, manager, platform: 'linux', uid: 0, execFile: async (_binary, argv) => { probes++; if (argv[1] === 'abort') { await fs.unlink(path.join(directory, '.removal-intent.json')); return { stdout: '{"ok":true}' }; } return { stdout: JSON.stringify({ agentId: nodeId, revision, status: 'ready', serverCount: 0 }) }; } };
  const agent = createNodeRemovalAgent(args); await agent.initialize();
  await assert.rejects(agent.prepare({ nodeId, revision: 'e'.repeat(64), requestId, confirmed: true }), /changed/); assert.equal(locked, false);
  await agent.prepare({ nodeId, revision, requestId, confirmed: true }); assert.equal(locked, true);
  const restored = createNodeRemovalAgent(args); await restored.initialize(); assert.equal(locked, true);
  assert.equal((await restored.prepare({ nodeId, revision, requestId, confirmed: true })).accepted, true);
  await restored.abort({ nodeId, requestId }); assert.equal(locked, false);
  servers = [{ id: randomUUID() }];
  await assert.rejects(restored.prepare({ nodeId, revision, requestId: randomUUID(), confirmed: true }), /admitted/); assert.equal(locked, false); assert.ok(probes >= 3);
});

test('Restored agent rejects unsafe or malformed intent before acquiring maintenance', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-removal-intent-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('vortex-removal-intent-'));
    return fs.rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, '.removal-intent.json');
  let statChanges = { uid: 0 }, maintenanceCalls = 0;
  modelIntentOwner(t, filename, () => statChanges);
  const nodeId = randomUUID(), intent = { nodeId, requestId: randomUUID(), revision: 'f'.repeat(64) };
  const cases = [
    { name: 'hard-linked intent', stat: { nlink: 2 } },
    { name: 'oversized intent', stat: { size: 65537 } },
    { name: 'malformed JSON', bytes: '{' },
    { name: 'another worker', fields: { nodeId: randomUUID() } },
    { name: 'invalid operation ID', fields: { requestId: 'invalid' } },
    { name: 'invalid generation', fields: { revision: 'invalid' } },
  ];
  if (process.platform === 'linux') cases.push(
    { name: 'non-root owner', stat: { uid: 1234 } },
    { name: 'group-readable intent', stat: { mode: 0o100640 } },
  );
  for (const current of cases) {
    await fs.writeFile(filename, current.bytes ?? JSON.stringify({ ...intent, ...current.fields }), { mode: 0o600 });
    statChanges = { uid: 0, ...current.stat };
    const agent = createNodeRemovalAgent({ nodeId, dataDir: directory, platform: 'linux', uid: 0,
      manager: { listServers: () => [], beginMaintenance() { maintenanceCalls++; throw new Error('Unsafe intent acquired maintenance'); } },
      execFile: async () => { throw new Error('Unsafe intent invoked native inspection'); },
    });
    await assert.rejects(agent.initialize(), error => error.code === 'NODE_REMOVAL' && error.status === 503, current.name);
    assert.equal(maintenanceCalls, 0, current.name);
  }
});

test('late remote mutation or removal cannot pass admission after main maintenance begins during earlier async work', async t => {
  const f = await federationFixture(t), id = f.agents[0].linked.id;
  const release = f.central.manager.beginMaintenance({ action: 'reboot', requestId: randomUUID() });
  try {
    assert.throws(() => f.central.nodes.beginMutation(id), /main-panel system operation/);
    await assert.rejects(f.central.nodes.beginRemoval(id, randomUUID(), f.admin.user), /main-panel system operation/);
    assert.equal(f.central.nodes.get(id).removalOperationId, undefined);
  } finally { release(); }
});

test('demo worker removal plan stays unsupported without invoking any native inspection', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-removal-demo-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agent = createNodeRemovalAgent({ nodeId: randomUUID(), dataDir: directory, demo: true, platform: 'linux', uid: 0, manager: { listServers: () => [], beginMaintenance() { throw new Error('native admission must not run'); } }, execFile: async () => { throw new Error('native helper must not run'); } });
  const plan = await agent.plan(); assert.equal(plan.status, 'unsupported'); assert.equal(plan.blockers[0].messageI18n.vi.includes('Linux'), true);
});
