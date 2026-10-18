import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServerFirewall, serverFirewallErrorPayload } from '../server/server-firewall.js';

const server = changes => ({ id: '4fa97aaa-5e7f-4454-97ab-3c2f292d197a', transport: 'nethernet', port: 30000, portV6: 30001, udpPorts: '30002-30005', debugPort: 39999, ...changes });
const copy = value => structuredClone(value);
const own = (owner, port, protocol = 'udp', family = 'ipv4') => ({ owner, port, protocol, family, action: 'ALLOW', source: 'Anywhere' });
function fixture({ rows = [], active = true, failWrite = 0, beforeWrite, statusHook, scope = path.resolve('output/firewall-scope-a') } = {}) {
  const calls = []; let writes = 0, rawTail = '';
  const state = { rows: copy(rows), active, calls, setRaw(value) { rawTail = value; } };
  const exec = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    assert.equal(file, '/usr/sbin/ufw'); assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.maxBuffer, 1024 ** 2); assert.ok(options.timeout > 0);
    if (args.join(' ') === 'status numbered') {
      await statusHook?.(state);
      return { stdout: !state.active ? 'Status: inactive\n' : 'Status: active\n\n     To                         Action      From\n     --                         ------      ----\n' + state.rows.map((row, i) => `[${String(i + 1).padStart(2)}] ${row.port}${row.protocol === 'any' ? '' : '/' + row.protocol}${row.family === 'ipv6' ? ' (v6)' : ''}   ${row.action} IN    ${row.source || 'Anywhere'}${row.family === 'ipv6' ? ' (v6)' : ''}${row.owner ? ' # ' + row.owner : ''}`).join('\n') + '\n' + rawTail };
    }
    writes++; await beforeWrite?.(state, args, writes);
    if (writes === failWrite) throw new Error('PRIVATE UFW failure: never expose foreign command output');
    const remove = args[0] === '--force', offset = remove || args[0] === 'insert' ? 2 : 1;
    assert.ok(remove || ['insert', 'prepend'].includes(args[0]));
    const rule = args.slice(offset);
    assert.equal(rule[0], 'allow'); assert.equal(rule[1], 'in'); assert.equal(rule[2], 'proto'); assert.equal(rule[4], 'from'); assert.equal(rule[6], 'to'); assert.equal(rule[8], 'port'); assert.equal(rule[10], 'comment');
    const row = own(rule[11], rule[9], rule[3], rule[5] === '::/0' ? 'ipv6' : 'ipv4');
    // Mirror UFW frontend: insert positions are global across IPv4 then IPv6,
    // unlike prepend which selects the first position in the requested family.
    if (args[0] === 'insert') {
      const position = Number(args[1]), v4 = state.rows.filter(candidate => candidate.family === 'ipv4').length;
      if (row.family === 'ipv6' && position <= v4 || position > state.rows.length) throw new Error('Invalid position');
    }
    assert.equal(rule[5], rule[7]); assert.match(row.owner, /^vortex:[a-f0-9]{16}:[a-f0-9-]{36}$/);
    const same = candidate => candidate.family === row.family && candidate.protocol === row.protocol && candidate.port === row.port && (candidate.source || 'Anywhere') === 'Anywhere';
    if (remove) state.rows = state.rows.filter(candidate => !(same(candidate) && candidate.owner === row.owner && candidate.action === 'ALLOW'));
    // Actual UFW insert logic skips a matching tuple even when its action or
    // comment differs. A plain allow would replace it: never model that as safe.
    else if (!state.rows.some(same)) state.rows.unshift(row);
    return { stdout: remove ? 'Rule deleted\n' : 'Rule added\n' };
  };
  return { state, firewall: createServerFirewall({ scope, exec, platform: 'linux', uid: 0 }), writes: () => writes };
}

test('NetherNet derives TCP signaling and internal UDP/NAT ranges by family without opening debugger or ignored v6 property', async () => {
  const f = fixture(), current = server({ udpPorts: '203.0.113.1:41000-41001:30002-30003,[2001:db8::1]:42000:30005' });
  const preview = await f.firewall.inspect(current);
  assert.equal(preview.status, 'active'); assert.equal(preview.canApply, true); assert.equal(preview.ports.length, 6);
  assert.deepEqual(preview.ports.map(row => [row.family, row.protocol, row.port]), [['ipv4', 'tcp', '30000'], ['ipv4', 'udp', '30002:30003'], ['ipv4', 'udp', '30005'], ['ipv6', 'tcp', '30000'], ['ipv6', 'udp', '30002:30003'], ['ipv6', 'udp', '30005']]);
  assert.equal(JSON.stringify(preview).includes('39999'), false); assert.equal(JSON.stringify(preview).includes('41000'), false); assert.equal(f.writes(), 0);
  await assert.rejects(f.firewall.inspect(server({ transport: 'auto' })), { code: 'FIREWALL_NETWORK' });
});

test('RakNet uses exact IPv4/v6 UDP ports; inactive and unsupported UFW never enable or mutate anything', async () => {
  const f = fixture({ active: false }), s = server({ transport: 'raknet', udpPorts: null }), preview = await f.firewall.inspect(s);
  assert.deepEqual(preview.ports.map(row => [row.family, row.protocol, row.port]), [['ipv4', 'udp', '30000'], ['ipv6', 'udp', '30001']]);
  const result = await f.firewall.apply(s, { revision: preview.revision, confirmed: true }); assert.equal(result.ok, false); assert.equal(result.partial, false); assert.equal(result.status, 'inactive'); assert.equal(f.writes(), 0);
  let called = false; const unsupported = createServerFirewall({ scope: path.resolve('output/test'), platform: 'win32', uid: 0, exec() { called = true; } });
  assert.equal((await unsupported.inspect(s)).supported, false); assert.equal(called, false);
});

test('foreign coverage is left intact, missing scoped rules precede obsolete deletion and reconciliation is idempotent', async () => {
  const f = fixture({ rows: [own('administrator SSH rule', '22', 'tcp'), own('foreign existing game', '30000', 'tcp')] }), s = server();
  let preview = await f.firewall.inspect(s); f.state.rows.push(own(preview.owner, '29900')); preview = await f.firewall.inspect(s);
  assert.equal(preview.ports[0].state, 'covered'); assert.equal(preview.obsoleteRules.length, 1); assert.equal(JSON.stringify(preview).includes('administrator SSH rule'), false);
  const result = await f.firewall.apply(s, { revision: preview.revision, confirmed: true });
  assert.equal(result.ok, true); assert.equal(result.added.length, 3); assert.equal(result.removed.length, 1);
  assert.ok(f.state.rows.some(row => row.owner === 'foreign existing game')); assert.ok(f.state.rows.some(row => row.owner === 'administrator SSH rule'));
  const mutations = f.state.calls.filter(call => call.args[0] !== 'status'); assert.equal(mutations.at(-1).args[0], '--force');
  const count = f.writes(); const again = await f.firewall.apply(s, { revision: result.revision, confirmed: true }); assert.equal(again.ok, true); assert.equal(f.writes(), count);
});

test('a foreign tuple introduced between observation and insertion is not claimed or overwritten', async () => {
  const foreign = own('concurrent foreign owner', '30000', 'tcp');
  const f = fixture({ beforeWrite(state, _args, count) { if (count === 1) state.rows.push(copy(foreign)); } }), s = server();
  const preview = await f.firewall.inspect(s), result = await f.firewall.apply(s, { revision: preview.revision, confirmed: true });
  assert.equal(result.ok, true); assert.deepEqual(f.state.rows.find(row => row.owner === foreign.owner), foreign); assert.equal(result.ports[0].state, 'covered'); assert.equal(result.added.length, 3);
});

test('shrinking an owned UDP range installs its replacement first while split foreign coverage needs no new rule', async () => {
  const f = fixture(), s = server(); let preview = await f.firewall.inspect(s);
  f.state.rows.push(own(preview.owner, '30002:30033'), own('foreign split A', '30002:30003', 'udp', 'ipv6'), own('foreign split B', '30004:30005', 'udp', 'ipv6'));
  preview = await f.firewall.inspect(s); assert.equal(preview.ports.find(port => port.family === 'ipv4' && port.protocol === 'udp').state, 'missing');
  assert.equal(preview.ports.find(port => port.family === 'ipv6' && port.protocol === 'udp').state, 'covered');
  const result = await f.firewall.apply(s, { revision: preview.revision, confirmed: true });
  assert.equal(result.ok, true); assert.ok(f.state.rows.some(row => row.owner === preview.owner && row.port === '30002:30005')); assert.equal(f.state.rows.some(row => row.owner === preview.owner && row.port === '30002:30033'), false);
  assert.equal(f.state.rows.filter(row => row.owner?.startsWith('foreign split')).length, 2); assert.equal(result.removed.length, 1);
});

test('stale network and firewall revisions reject before writes, including a network change during the last observation', async () => {
  const f = fixture(), s = server(), preview = await f.firewall.inspect(s);
  await assert.rejects(f.firewall.apply(server({ port: 31000 }), { revision: preview.revision, confirmed: true }), { code: 'FIREWALL_STALE', status: 409 });
  f.state.rows.push(own('foreign', '80', 'tcp'));
  await assert.rejects(f.firewall.apply(s, { revision: preview.revision, confirmed: true }), { code: 'FIREWALL_STALE' }); assert.equal(f.writes(), 0);
  const current = server(); let observations = 0;
  const g = fixture({ statusHook() { if (++observations === 3) current.port = 31000; } }), inspected = await g.firewall.inspect(current);
  const result = await g.firewall.apply(current, { revision: inspected.revision, confirmed: true }, () => current);
  assert.equal(result.ok, false); assert.equal(result.partial, false); assert.equal(g.writes(), 0);
});

test('scope isolates same raw UUID from another panel and malformed owned or conflicting rules refuse mutation', async () => {
  const a = fixture(), s = server(), first = await a.firewall.inspect(s);
  const b = fixture({ scope: path.resolve('output/firewall-scope-b'), rows: [own(first.owner, '29900'), own(first.owner, '30000', 'tcp')] });
  const preview = await b.firewall.inspect(s); assert.notEqual(preview.owner, first.owner); assert.equal(preview.obsoleteRules.length, 0);
  const result = await b.firewall.apply(s, { revision: preview.revision, confirmed: true }); assert.equal(result.ok, true); assert.ok(b.state.rows.some(row => row.owner === first.owner && row.port === '29900'));
  for (const bad of [{ ...own('foreign deny', '30000', 'tcp'), action: 'DENY' }, own(first.owner, '30000', 'any')]) {
    const f = fixture({ rows: [bad] }), seen = await f.firewall.inspect(s); assert.equal(seen.canApply, false);
    const rejected = await f.firewall.apply(s, { revision: seen.revision, confirmed: true }); assert.equal(rejected.ok, false); assert.equal(f.writes(), 0);
  }
});

test('a failed command reports confirmed partial changes, preserves old owned rules and never exposes command stderr', async () => {
  const f = fixture({ failWrite: 2 }), s = server(); let preview = await f.firewall.inspect(s); f.state.rows.push(own(preview.owner, '29900')); preview = await f.firewall.inspect(s);
  const result = await f.firewall.apply(s, { revision: preview.revision, confirmed: true });
  assert.equal(result.ok, false); assert.equal(result.partial, true); assert.equal(result.added.length, 1); assert.equal(result.removed.length, 0); assert.ok(f.state.rows.some(row => row.port === '29900'));
  assert.equal(JSON.stringify(result).includes('PRIVATE UFW'), false); assert.equal(f.state.calls.some(call => call.args.includes('enable') || call.args.includes('reset') || call.args.includes('default')), false);
});

test('all factories serialize host mutations and a queued stale preview cannot overwrite concurrent server changes', async () => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { entered = resolve; });
  const f = fixture({ async beforeWrite(_state, _args, count) { if (count === 1) { entered(); await gate; } } }), s = server(), preview = await f.firewall.inspect(s);
  const first = f.firewall.apply(s, { revision: preview.revision, confirmed: true }); await pending;
  const second = f.firewall.apply(s, { revision: preview.revision, confirmed: true });
  release(); assert.equal((await first).ok, true); await assert.rejects(second, { code: 'FIREWALL_STALE' });
  assert.equal(f.writes(), 4);
  await assert.rejects(f.firewall.apply(s, { revision: preview.revision, confirmed: false }), { code: 'FIREWALL_INPUT' });
  assert.ok(serverFirewallErrorPayload({ code: 'FIREWALL_STALE' }, 'vi').errorI18n.vi); assert.equal(serverFirewallErrorPayload({ code: 'PRIVATE_FAILURE' }), null);
});

test('explicit removal deletes only this scope/server comments and never promises to close foreign-covered ports', async () => {
  const f = fixture(), s = server(); let preview = await f.firewall.inspect(s);
  const otherScope = preview.owner.replace(/^vortex:[a-f0-9]{16}:/, 'vortex:0000000000000000:');
  f.state.rows.push(own(preview.owner, '30000', 'tcp'), own(preview.owner, '29900'), own(otherScope, '30000', 'tcp'), own('foreign admin', '22', 'tcp'));
  preview = await f.firewall.inspect(s); assert.equal(preview.canRemove, true);
  const result = await f.firewall.remove(s, { revision: preview.revision, confirmed: true });
  assert.equal(result.ok, true); assert.equal(result.removed.length, 2); assert.equal(result.added.length, 0); assert.equal(result.canRemove, false); assert.equal(result.managedRules.length, 0);
  assert.equal(result.ports[0].state, 'covered'); assert.ok(f.state.rows.some(row => row.owner === otherScope)); assert.ok(f.state.rows.some(row => row.owner === 'foreign admin'));
  assert.match(result.message, /Foreign rules may still allow/);
  const count = f.writes(); assert.equal((await f.firewall.remove(s, { revision: result.revision, confirmed: true })).ok, true); assert.equal(f.writes(), count);
  await assert.rejects(f.firewall.remove(s, { revision: preview.revision, confirmed: true }), { code: 'FIREWALL_STALE' });
});

test('family-local prepend supports first IPv6 rules after existing IPv4 SSH/web rules and never uses their global indexes', async () => {
  const foreign = [own('SSH', '22', 'tcp'), own('HTTP', '80', 'tcp'), own('HTTPS', '443', 'tcp')];
  const f = fixture({ rows: foreign }), s = server(), preview = await f.firewall.inspect(s);
  const result = await f.firewall.apply(s, { revision: preview.revision, confirmed: true });
  assert.equal(result.ok, true); assert.equal(result.partial, false); assert.equal(result.added.length, 4);
  assert.ok(result.ports.filter(port => port.family === 'ipv6').every(port => port.state === 'managed'));
  assert.ok(f.state.calls.filter(call => call.args[0] !== 'status').every(call => call.args[0] === 'prepend'));
  assert.deepEqual(f.state.rows.filter(row => ['SSH', 'HTTP', 'HTTPS'].includes(row.owner)), foreign);
});
