import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createNodes } from '../server/nodes.js';
import { createStore } from '../server/store.js';
import { capacityErrorPayload } from '../server/capacity.js';
import { federationFixture } from './nodes080-fixture.js';

test('remote create preserves canonical capacity identity and EN/VI through the real controller and agent HTTP handlers', async t => {
  const f = await federationFixture(t), agent = f.agents[0];
  const before = { servers: agent.store.data.servers.map(row => row.id), jobs: agent.store.data.jobs.map(row => row.id), central: f.central.store.data.servers.map(row => row.id) };
  let code = 'CAPACITY_MEMORY', calls = 0;
  t.mock.method(agent.runtime.manager, 'createServer', async () => {
    calls++;
    // Synthetic admission failure, real authenticated transport and handlers.
    throw Object.assign(new Error('Synthetic admission rejected the requested ceiling'), { status: 409, code });
  });
  const request = { nodeId: agent.linked.id, name: 'Rejected fixture only', portAllocation: 'manual', port: 42000, portV6: 42001, resourcePolicy: { mode: 'fixed', cpuCores: 0.1, memoryMiB: 256 }, storagePolicy: { mode: 'fixed', diskGiB: 1 } };
  for (code of ['CAPACITY_MEMORY', 'CAPACITY_CPU', 'CAPACITY_MEMORY_PRESSURE']) {
    for (const language of ['en', 'vi']) {
      const result = await f.request('/servers', { body: request, headers: { 'Accept-Language': language } });
      assert.equal(result.status, 409);
      assert.deepEqual(result.data, capacityErrorPayload({ code }, language));
      assert.equal(result.data.errorI18n.id, `panel.capacity.${code.toLowerCase()}`);
    }
  }
  assert.equal(calls, 6, 'Each rejected create is sent once; no automatic retry');
  assert.deepEqual(agent.store.data.servers.map(row => row.id), before.servers);
  assert.deepEqual(agent.store.data.jobs.map(row => row.id), before.jobs);
  assert.deepEqual(f.central.store.data.servers.map(row => row.id), before.central);
  assert.equal((await f.request('/nodes')).data.nodes.find(row => row.id === agent.linked.id).online, true, 'Known rejection must not mark the node outcome unknown/offline');
  t.diagnostic('Real local HTTP controller→agent request/session/actor and bilingual error transport; capacity denial is injected, without native allocation or OS mutation.');
});

test('remote JSON failures whitelist capacity identities and never import unknown codes or peer-owned translation metadata', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-node-create-errors-'));
  const nodes = createNodes({ store: createStore(directory), localManager: {}, dataDir: directory });
  t.after(async () => { await nodes.close(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const fail = value => nodes.readJson({ statusCode: 409, stream: Readable.from([Buffer.from(JSON.stringify(value))]) });
  const unknown = { error: 'Opaque peer failure', code: 'UNTRUSTED_PRIVATE_CODE', errorI18n: { id: 'untrusted.translation', en: 'untrusted', vi: 'untrusted' } };
  for (const code of [unknown.code, { toString: 'x' }, ['CAPACITY_MEMORY'], [{ toString: 'x' }], [null], [], null, 42, true]) {
    const value = { ...unknown, code };
    await assert.rejects(fail(value), error => {
      assert.equal(error.status, 409); assert.deepEqual(error.body, value);
      assert.equal(error.code, undefined); assert.equal(error.errorI18n, undefined);
      return true;
    });
  }
  const known = { ...unknown, code: 'CAPACITY_MEMORY' };
  await assert.rejects(fail(known), error => {
    const canonical = capacityErrorPayload({ code: known.code });
    assert.equal(error.status, 409); assert.equal(error.code, known.code);
    assert.deepEqual(error.errorI18n, canonical.errorI18n);
    assert.notDeepEqual(error.errorI18n, known.errorI18n);
    return true;
  });
});
