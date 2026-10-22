import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const MAX_BYTES = 1024 * 1024, MAX_LINES = 8192;
const OWNER = /^vortex:[a-f0-9]{16}:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const helper = fileURLToPath(new URL('./firewall_native.py', import.meta.url));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = rule => `${rule.family}:${rule.protocol}:${rule.port}`;
const clean = rule => ({ family: rule.family, protocol: rule.protocol, port: rule.port });
const validPort = value => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}(?::[1-9][0-9]{0,4})?$/.test(value)) return false;
  const [first, last = first] = value.split(':').map(Number);
  return first >= 1024 && last <= 65535 && first <= last;
};
const validRule = rule => rule && ['ipv4', 'ipv6'].includes(rule.family) && ['tcp', 'udp'].includes(rule.protocol) && validPort(rule.port);
const tokensFor = (rule, owner) => ['-A', 'INPUT', '-p', rule.protocol, '-m', rule.protocol, '--dport', rule.port, '-m', 'comment', '--comment', owner, '-j', 'ACCEPT'];
const commandFor = (rule, owner, remove = false) => ['-w', '5', '-t', 'filter', ...(remove ? ['-D', 'INPUT'] : ['-I', 'INPUT', '1']), ...tokensFor(rule, owner).slice(2)];
function words(line) {
  const output = []; let value = '', quote = '', started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '\\' && quote !== "'") { if (++index >= line.length) throw new Error('Invalid firewall escape.'); value += line[index]; started = true; }
    else if (quote) { if (char === quote) quote = ''; else value += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { output.push(value); value = ''; started = false; } }
    else { value += char; started = true; }
  }
  if (quote) throw new Error('Unclosed firewall quote.');
  if (started) output.push(value);
  if (!output.length || output.length > 256 || output.some(token => token.length > 4096)) throw new Error('Invalid firewall tokens.');
  return output;
}
function canonical(tokens, family) {
  if (tokens.length !== 14 || !OWNER.test(tokens[11] || '')) return null;
  const rule = { family, protocol: tokens[3], port: tokens[7], comment: tokens[11] };
  return validRule(rule) && JSON.stringify(tokens) === JSON.stringify(tokensFor(rule, rule.comment)) ? rule : null;
}
export function parseNativeFilterSnapshot(stdout, family, owner) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_BYTES || !['ipv4', 'ipv6'].includes(family) || !OWNER.test(owner)) throw new Error('Invalid filter snapshot.');
  const lines = stdout.replaceAll('\r\n', '\n').split('\n');
  if (lines.length > MAX_LINES || /[\x00-\x08\x0b-\x1f\x7f]/.test(lines.join('\n'))) throw new Error('Invalid filter bytes.');
  const chains = [], rows = []; let opened = false, committed = false, unsafe = false;
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (line === '*filter') { if (opened || committed) throw new Error('Duplicate filter section.'); opened = true; continue; }
    if (line === 'COMMIT') { if (!opened || committed) throw new Error('Invalid filter commit.'); committed = true; continue; }
    if (!opened || committed) throw new Error('Unexpected filter data.');
    if (line.startsWith(':')) {
      const match = /^:([A-Za-z0-9_-]{1,64}) (ACCEPT|DROP|-) \[[0-9]{1,20}:[0-9]{1,20}\]$/.exec(line);
      if (!match || chains.some(row => row[0] === match[1]) || rows.length) throw new Error('Invalid filter chain.');
      chains.push([match[1], match[2]]); continue;
    }
    const tokens = words(line);
    if (tokens[0] !== '-A' || !chains.some(row => row[0] === tokens[1])) throw new Error('Unknown filter rule.');
    const comments = tokens.flatMap((token, index) => token === '--comment' ? [tokens[index + 1]] : []);
    if (comments.some(comment => typeof comment !== 'string')) throw new Error('Invalid firewall comment.');
    const rule = canonical(tokens, family), owned = comments.includes(owner);
    if (owned && (!rule || comments.length !== 1 || rule.comment !== owner)) unsafe = true;
    rows.push({ tokens, family, chain: tokens[1], owner: owned, canonical: Boolean(rule), ...(rule || {}) });
  }
  if (!opened || !committed || !['INPUT', 'FORWARD', 'OUTPUT'].every(name => chains.some(row => row[0] === name && row[1] !== '-'))) throw new Error('Incomplete native filter.');
  if (chains.some(row => /^ufw[-_]/i.test(row[0])) || rows.some(row => row.tokens.some(token => /^ufw[-_]/i.test(token)))) throw new Error('UFW filter context is present.');
  const barrier = rows.findIndex(row => row.chain === 'INPUT' && !row.canonical);
  rows.forEach((row, index) => { row.prioritySafe = row.chain === 'INPUT' && (barrier === -1 || index < barrier); });
  return { family, chains, rows, unsafe, raw: JSON.stringify({ chains, rules: rows.map(row => row.tokens) }) };
}
function validateNetwork(network, owner) {
  if (!network || !OWNER.test(owner) || !owner.endsWith(':' + network.serverId) || !Array.isArray(network.ports) || !network.ports.length || network.ports.length > 258 || network.ports.some(rule => !validRule(rule)) || new Set(network.ports.map(key)).size !== network.ports.length) throw new Error('Invalid native firewall request.');
}
function parsePersistence(stdout, owner) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_BYTES) throw new Error('Invalid persistence response.');
  const value = JSON.parse(stdout);
  if (!value || value.schemaVersion !== 1 || value.owner !== owner || typeof value.ready !== 'boolean' || !Array.isArray(value.rules) || value.rules.length > 4096 || value.rules.some(rule => !validRule(rule) || Object.keys(rule).sort().join(',') !== 'family,port,protocol') || value.ready && !SHA.test(value.revision || '')) throw new Error('Invalid persistence state.');
  return value;
}
export function createNativeFirewall({ exec, supported, present, assertNativeAllowed, commandTimeoutMs = 10000, maxDurationMs = 120000 } = {}) {
  if (typeof exec !== 'function' || typeof present !== 'function' || typeof assertNativeAllowed !== 'function') throw new Error('Invalid native firewall controller.');
  const options = { timeout: commandTimeoutMs, maxBuffer: MAX_BYTES, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
  const run = (filename, args) => exec(filename, args, options);
  const persistInspect = async owner => parsePersistence((await run('/usr/bin/python3', ['-I', helper, 'inspect', '--owner', owner])).stdout, owner);
  async function observe(owner) {
    await assertNativeAllowed();
    const results = await Promise.all([run('/usr/sbin/iptables-save', ['-t', 'filter']), run('/usr/sbin/ip6tables-save', ['-t', 'filter']), persistInspect(owner)]);
    const filters = ['ipv4', 'ipv6'].map((family, index) => parseNativeFilterSnapshot(results[index].stdout, family, owner));
    if (!filters.some(filter => filter.chains.some(row => row[0] === 'INPUT' && row[1] === 'DROP') || filter.rows.some(row => row.chain === 'INPUT'))) throw new Error('No existing native input policy.');
    const own = filters.flatMap(filter => filter.rows.filter(row => row.owner && row.canonical));
    return { filters, own, persistence: results[2], unsafe: filters.some(filter => filter.unsafe), raw: JSON.stringify(filters.map(filter => filter.raw)), foreign: digest(filters.map(filter => ({ chains: filter.chains, rules: filter.rows.filter(row => !row.owner).map(row => row.tokens) }))) };
  }
  function state(network, owner, observed, extra = {}) {
    const desired = new Set(network.ports.map(key)), own = observed?.own || [], saved = observed?.persistence.rules || [];
    const ports = network.ports.map(target => {
      const live = own.some(row => key(row) === key(target) && row.prioritySafe), persistent = saved.some(row => key(row) === key(target));
      return { ...target, state: live && persistent ? 'managed' : 'missing', live, saved: persistent };
    });
    const ready = Boolean(observed?.persistence.ready), unsafe = Boolean(observed?.unsafe), active = Boolean(observed);
    const obsolete = [...new Map([...own, ...saved].filter(row => !desired.has(key(row))).map(row => [key(row), clean(row)])).values()];
    const warningKeys = ['external', ...(!ready ? ['native_persistence'] : []), ...(unsafe ? ['unsafe'] : [])];
    return { ...network, backend: 'iptables', ports, supported, status: active ? 'active' : 'unavailable', canApply: supported && active && ready && !unsafe, canRemove: supported && active && ready && !unsafe && Boolean(own.length || saved.length), owner, revision: observed && ready ? digest({ backend: 'iptables', network, rules: observed.raw, persistence: observed.persistence.revision }) : null, managedRules: own.map(clean), savedRules: saved.map(clean), obsoleteRules: obsolete, persistence: { backend: 'netfilter-persistent', ready, verified: ready && ports.every(row => row.saved), managedRules: saved.map(clean) }, warnings: warningKeys.map(key => present(key).message), warningsI18n: warningKeys.map(key => present(key).messageI18n), ...present(!active ? 'unavailable' : !ready ? 'native_persistence' : unsafe ? 'unsafe' : 'native_ready'), ...extra };
  }
  async function inspect(network, owner) {
    validateNetwork(network, owner);
    try { return state(network, owner, await observe(owner)); }
    catch { return state(network, owner, null); }
  }
  async function apply(network, input, resolveNetwork, removeAll = false) {
    validateNetwork(network, `vortex:${input.scopeId}:${network.serverId}`);
    const owner = `vortex:${input.scopeId}:${network.serverId}`;
    let observed;
    try { observed = await observe(owner); }
    catch { const result = state(network, owner, null); return { ...result, ok: false, partial: false, added: [], removed: [], errors: [result.message], errorsI18n: [result.messageI18n] }; }
    let result = state(network, owner, observed);
    if (result.revision !== input.revision) throw Object.assign(new Error('FIREWALL_STALE'), { code: 'FIREWALL_STALE', status: 409 });
    const added = [], removed = [], errors = []; let attempts = 0;
    if (!(removeAll ? result.canRemove || result.canApply : result.canApply)) return { ...result, ok: false, partial: false, added, removed, errors: [result.message], errorsI18n: [result.messageI18n] };
    const identity = digest(network), began = performance.now(), desiredRules = removeAll ? [] : network.ports.map(clean), desired = new Set(desiredRules.map(key));
    const counts = value => Object.fromEntries(value.own.reduce((map, row) => map.set(key(row), (map.get(key(row)) || 0) + 1), new Map()));
    const fresh = async () => {
      if (performance.now() - began > maxDurationMs || digest(await resolveNetwork()) !== identity) throw new Error('Native firewall context changed.');
      const next = await observe(owner);
      if (digest(await resolveNetwork()) !== identity || next.raw !== observed.raw || next.persistence.revision !== observed.persistence.revision || !next.persistence.ready || next.unsafe) throw new Error('Native firewall revision changed.');
      observed = next;
    };
    const mutate = async (rule, remove) => {
      await fresh();
      const before = counts(observed), foreign = observed.foreign, persistent = observed.persistence.revision, ruleKey = key(rule);
      const expected = { ...before, [ruleKey]: (before[ruleKey] || 0) + (remove ? -1 : 1) };
      if (expected[ruleKey] < 0) throw new Error('Missing native rule.');
      if (!expected[ruleKey]) delete expected[ruleKey];
      attempts++;
      await run(rule.family === 'ipv4' ? '/usr/sbin/iptables' : '/usr/sbin/ip6tables', commandFor(rule, owner, remove));
      const next = await observe(owner);
      if (next.foreign !== foreign || next.persistence.revision !== persistent || JSON.stringify(Object.entries(counts(next)).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('Native rule mutation was not isolated.');
      observed = next;
      (remove ? removed : added).push(clean(rule));
    };
    try {
      // Remove only exact misplaced/obsolete/duplicate owned accepts. Foreign
      // rule ordering is preserved; fresh accepts are inserted at INPUT 1.
      const ownCounts = counts(observed);
      const replace = new Set(observed.own.filter(row => !desired.has(key(row)) || !row.prioritySafe || ownCounts[key(row)] > 1).map(key));
      // Exact-spec deletion removes the first matching occurrence. Remove all
      // copies of a tuple before replacing it so no blocked duplicate remains.
      for (const row of [...observed.own]) if (replace.has(key(row))) await mutate(row, true);
      for (const target of desiredRules) if (!observed.own.some(row => key(row) === key(target) && row.prioritySafe)) await mutate(target, false);
      await fresh();
      const live = observed.raw, foreign = observed.foreign;
      attempts++;
      const saved = parsePersistence((await run('/usr/bin/python3', ['-I', helper, 'sync', '--owner', owner, '--expected-revision', observed.persistence.revision, '--rules', JSON.stringify(desiredRules)])).stdout, owner);
      const next = await observe(owner);
      if (!saved.ready || next.persistence.revision !== saved.revision || next.raw !== live || next.foreign !== foreign || JSON.stringify([...saved.rules].map(key).sort()) !== JSON.stringify(desiredRules.map(key).sort())) throw new Error('Native persistence was not confirmed.');
      observed = next;
      if (digest(await resolveNetwork()) !== identity) throw new Error('Native network settings changed.');
    } catch {
      errors.push(present('partial').message);
      try { observed = await observe(owner); } catch { observed = null; }
    }
    result = state(network, owner, observed);
    const ok = errors.length === 0 && result.canApply && (removeAll ? result.managedRules.length === 0 && result.savedRules.length === 0 : result.ports.every(row => row.live && row.saved) && result.obsoleteRules.length === 0);
    return { ...result, ok, partial: !ok && attempts > 0, added, removed, errors, errorsI18n: errors.map(() => present('partial').messageI18n), ...present(ok ? removeAll ? 'removed' : 'complete' : 'partial') };
  }
  return { inspect, apply };
}
