import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateNetwork, networkPortReservations } from '../server/safety.js';
import { createServerFirewall } from '../server/server-firewall.js';

const id = '0d433e32-1df1-4688-a42f-28031440e120';
const app = (changes = {}) => ({ id, name: 'Owned application', kind: 'nodejs', port: 31000, portV6: null, transport: 'tcp', udpPorts: null, debugPort: null, ...changes });
const bedrock = (changes = {}) => ({ id: 'a19070fa-b214-484d-9e43-4eb4330fd8f0', name: 'Existing Minecraft', port: 31000, portV6: 31001, transport: 'raknet', udpPorts: null, ...changes });

test('apps reserve one TCP port and can coexist with Bedrock UDP on the same port in both directions', () => {
  const expected = { port: 31000, portV6: null, transport: 'tcp', udpPorts: null, debugPort: null };
  for (const kind of ['python', 'nodejs']) assert.deepEqual(validateNetwork([bedrock()], null, { kind, port: '31000' }), expected);
  assert.deepEqual(networkPortReservations(app()), [{ protocol: 'tcp', port: 31000 }]);
  assert.equal(validateNetwork([app()], null, bedrock()).port, 31000);
});

test('same-protocol collisions include stopped apps, NetherNet signaling, Bedrock debugger and pending auto transport', () => {
  for (const other of [app({ id: 'other', status: 'stopped' }), bedrock({ transport: 'nethernet', udpPorts: '31002-31033' }), bedrock({ port: 31100, portV6: 31101, debugPort: 31000 }), bedrock({ transport: 'auto', udpPorts: '31002-31033' })]) {
    assert.throws(() => validateNetwork([other], null, app()), error => error.status === 409);
  }
  assert.throws(() => validateNetwork([app()], null, bedrock({ transport: 'nethernet', udpPorts: '31002-31033' })), error => error.status === 409);
  assert.throws(() => validateNetwork([bedrock()], null, bedrock({ id: 'new' })), error => error.status === 409);
  assert.equal(validateNetwork([app()], id, app()).port, 31000);
});

test('app network rejects Bedrock controls, unknown kinds and invalid port bounds instead of allocating UDP', () => {
  for (const changes of [{ portV6: 31001 }, { udpPorts: '31002-31033' }, { debugPort: 39999 }, { 'server-udp-ports': '31002-31033' }, { 'server-portv6': 31001 }, { 'force-inbound-debug-port': 39999 }, { transport: 'raknet' }, { transport: 'auto' }, { kind: 'unknown' }, { port: 22 }, { port: 65536 }, { port: 31000.5 }]) {
    assert.throws(() => validateNetwork([], null, app(changes)), error => error.status === 400);
  }
  assert.equal(validateNetwork([], null, app({ port: 65535 })).port, 65535);
});

function firewallFixture() {
  const rules = [{ port: '22', protocol: 'tcp', family: 'ipv4', owner: 'foreign-admin' }], calls = [];
  const firewall = createServerFirewall({ scope: path.resolve('output/application-firewall-scope'), platform: 'linux', uid: 0, exec: async (command, args) => {
    assert.equal(command, '/usr/sbin/ufw'); calls.push([...args]);
    if (args.join(' ') === 'status numbered') return { stdout: 'Status: active\n' + rules.map((row, i) => `[${i + 1}] ${row.port}/${row.protocol}${row.family === 'ipv6' ? ' (v6)' : ''} ALLOW IN Anywhere${row.family === 'ipv6' ? ' (v6)' : ''} # ${row.owner}`).join('\n') + '\n' };
    const remove = args[0] === '--force', fields = args.slice(remove ? 2 : 1);
    assert.ok(remove || args[0] === 'prepend'); assert.equal(fields[2], 'proto'); assert.equal(fields[3], 'tcp');
    const row = { protocol: fields[3], family: fields[5] === '::/0' ? 'ipv6' : 'ipv4', port: fields[9], owner: fields[11] };
    assert.equal(row.port, '31000'); assert.match(row.owner, /^vortex:[a-f0-9]{16}:[a-f0-9-]{36}$/);
    const index = rules.findIndex(value => Object.keys(row).every(key => value[key] === row[key]));
    if (remove && index >= 0) rules.splice(index, 1); else if (!remove && index < 0) rules.push(row);
    return { stdout: 'confirmed' };
  } });
  return { firewall, rules, calls };
}

test('actual scoped UFW controller applies only the app TCP port, preserves foreign rules, is idempotent and removes only its own rules', async () => {
  const f = firewallFixture(), server = app();
  const preview = await f.firewall.inspect(server);
  assert.equal(preview.transport, 'tcp');
  assert.deepEqual(preview.ports.map(row => [row.family, row.protocol, row.port]), [['ipv4', 'tcp', '31000'], ['ipv6', 'tcp', '31000']]);
  assert.ok(preview.ports.every(row => row.purposeI18n.en === 'Application TCP'));
  const applied = await f.firewall.apply(server, { revision: preview.revision, confirmed: true }); assert.equal(applied.ok, true); assert.equal(applied.added.length, 2);
  const writes = f.calls.filter(row => row[0] !== 'status').length;
  assert.equal((await f.firewall.apply(server, { revision: applied.revision, confirmed: true })).ok, true);
  assert.equal(f.calls.filter(row => row[0] !== 'status').length, writes);
  const removed = await f.firewall.remove(server, { revision: applied.revision, confirmed: true });
  assert.equal(removed.ok, true); assert.deepEqual(f.rules, [{ port: '22', protocol: 'tcp', family: 'ipv4', owner: 'foreign-admin' }]);
});

test('firewall rejects hybrid app/Bedrock plans before any host command', async () => {
  const f = firewallFixture(); await assert.rejects(f.firewall.inspect(app({ udpPorts: '31002-31033' })), { code: 'FIREWALL_NETWORK' });
  await assert.rejects(f.firewall.inspect(app({ kind: 'unknown' })), { code: 'FIREWALL_NETWORK' }); assert.equal(f.calls.length, 0);
});
