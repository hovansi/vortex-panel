import test from 'node:test';
import assert from 'node:assert/strict';
import { federationFixture, COLLISION_ID } from './nodes080-fixture.js';

test('remote HEAD preserves status without parsing empty JSON or advertising untransformed representation metadata', async t => {
  const f = await federationFixture(t);
  const local = await f.request(`/servers/${COLLISION_ID}`, { method: 'HEAD', raw: true });
  assert.equal(local.status, 200); assert.equal(await local.text(), '');
  const id = f.remote(0), peer = f.agents[0];
  const centralGet = await f.request(`/servers/${id}`, { raw: true });
  const centralBytes = Buffer.from(await centralGet.arrayBuffer()).length;
  const rawHead = await fetch(`${peer.endpoint}/api/servers/${COLLISION_ID}`, { method: 'HEAD', headers: { Authorization: `Bearer ${peer.token}` } });
  assert.notEqual(Number(rawHead.headers.get('content-length')), centralBytes, 'Controller GET adds node identity metadata, changing the JSON representation');
  t.diagnostic(JSON.stringify({ centralGetBytes: centralBytes, upstreamRepresentationBytes: Number(rawHead.headers.get('content-length')) }));
  await rawHead.arrayBuffer();
  for (const suffix of ['', '/logs', '/files', '/file?path=config/readme.txt', '/file?path=missing.txt']) {
    const upstream = await fetch(`${peer.endpoint}/api/servers/${COLLISION_ID}${suffix}`, { method: 'HEAD', headers: { Authorization: `Bearer ${peer.token}` } });
    const proxied = await f.request(`/servers/${id}${suffix}`, { method: 'HEAD', raw: true });
    assert.equal(proxied.status, upstream.status, suffix);
    assert.equal(proxied.headers.get('content-type'), upstream.headers.get('content-type'), suffix);
    // These values describe the agent's raw JSON, while the controller GET
    // transforms resource identities and localization. Omit instead of lying.
    for (const header of ['content-length', 'etag', 'last-modified', 'content-encoding']) assert.equal(proxied.headers.get(header), null, `${suffix}: ${header}`);
    assert.equal(await upstream.text(), ''); assert.equal(await proxied.text(), '');
  }
  const binarySuffix = '/files/download?path=config/readme.txt';
  const binaryUpstream = await fetch(`${peer.endpoint}/api/servers/${COLLISION_ID}${binarySuffix}`, { method: 'HEAD', headers: { Authorization: `Bearer ${peer.token}` } });
  const binaryProxy = await f.request(`/servers/${id}${binarySuffix}`, { method: 'HEAD', raw: true });
  assert.equal(binaryProxy.status, 200);
  for (const header of ['content-type', 'content-length', 'etag', 'last-modified', 'content-disposition']) assert.equal(binaryProxy.headers.get(header), binaryUpstream.headers.get(header), header);
  assert.equal(await binaryUpstream.text(), ''); assert.equal(await binaryProxy.text(), '');
  const viewer = await f.createUser('head-limited-viewer', { role: 'viewer', serverIds: [id] });
  assert.equal((await f.request(`/servers/${id}`, { actor: viewer, method: 'HEAD', raw: true })).status, 200);
  assert.equal((await f.request(`/servers/${id}/file?path=keys/server_identity_key.pem`, { actor: viewer, method: 'HEAD', raw: true })).status, 403);
  assert.equal((await f.request(`/servers/${f.remote(1)}`, { actor: viewer, method: 'HEAD', raw: true })).status, 403);
});
