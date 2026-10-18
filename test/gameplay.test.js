import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GAME_RULES, GAME_ITEMS, PLAYER_ACTIONS, validateRuleQuery, validateRuleChanges, buildPlayerAction, quotePlayerName, parseNativeRule, parseNativeRuleResponse, parseNativePlayerResult, createGameplayConsole, trackGameplayPlayer, connectedGameplayPlayers, assertGameplayPlayer, applyGameRuleChanges } from '../server/gameplay.js';
import { localizeApiResponse } from '../server/locale.js';

const worldRevision = 'a'.repeat(64), target = { name: 'A Traveler', xuid: '253000000000001', connectionId: randomUUID() };
const native = body => `[2026-10-14 13:04:09:980 INFO] ${body}`;
const request = (action, values) => ({ worldRevision, action, target, ...(values ? { values } : {}) });
const bad = fn => assert.throws(fn, error => error.status === 400);

test('world rule schemas enforce typed whitelist, exact expectations and app ceilings without guessing defaults', () => {
  assert.ok(GAME_RULES.every(rule => rule.requiresCheats === false && !Object.hasOwn(rule, 'value')));
  assert.equal(GAME_RULES.find(rule => rule.key === 'keepinventory').type, 'boolean');
  assert.deepEqual(validateRuleQuery({ worldRevision, keys: ['keepinventory', 'randomtickspeed'] }).keys, ['keepinventory', 'randomtickspeed']);
  assert.deepEqual(validateRuleChanges({ worldRevision, changes: { keepinventory: true, randomtickspeed: 3 }, expected: { keepinventory: false, randomtickspeed: 1 } }).keys, ['keepinventory', 'randomtickspeed']);
  for (const input of [null, [], {}, { worldRevision, keys: [] }, { worldRevision, keys: ['keepinventory', 'keepinventory'] }, { worldRevision, keys: ['keepInventory'] }, { worldRevision, keys: ['unsupported'] }, { worldRevision, command: 'stop' }]) bad(() => validateRuleQuery(input));
  for (const input of [{ changes: { keepinventory: 'true' }, expected: { keepinventory: false } }, { changes: { randomtickspeed: 4097 }, expected: { randomtickspeed: 1 } }, { changes: { spawnradius: -1 }, expected: { spawnradius: 0 } }, { changes: { keepinventory: true }, expected: {} }, { changes: { keepinventory: true }, expected: { keepinventory: false, pvp: true } }, { changes: { pvp: false }, expected: { pvp: 'true' } }]) bad(() => validateRuleChanges({ worldRevision, ...input }));
});

test('curated player commands target one safely quoted connected identity and reject selector/newline injection', () => {
  assert.equal(quotePlayerName(target.name), '"A Traveler"');
  assert.equal(buildPlayerAction(request('give', { itemId: 'minecraft:apple', count: 2 })).command, 'give "A Traveler" minecraft:apple 2');
  assert.equal(buildPlayerAction(request('heal')).command, 'effect "A Traveler" instant_health 1 4 true');
  assert.equal(buildPlayerAction(request('teleport', { x: 0, y: 65.5, z: -2 })).command, 'teleport "A Traveler" 0 65.5 -2 true');
  assert.equal(buildPlayerAction(request('gamemode', { mode: 'creative' })).command, 'gamemode creative "A Traveler"');
  for (const name of ['@a', '"name"', 'a\nkill @a', 'a\\b', '*', 'A\u202eB', '\ud800', ' traveler ']) bad(() => buildPlayerAction({ ...request('kill'), target: { ...target, name } }));
  for (const input of [{ ...request('kill'), command: 'kill @a' }, { ...request('kill'), target: { ...target, xuid: '18446744073709551616' } }, { ...request('kill'), target: { ...target, connectionId: '-'.repeat(36) } }, request('give', { itemId: 'minecraft:command_block', count: 1 }), request('give', { itemId: 'minecraft:apple', count: '1' }), request('give', { itemId: 'minecraft:apple', count: 65 }), request('heal', { duration: 100 }), request('teleport', { x: 0, y: Infinity, z: 0 }), request('gamemode', { mode: 'spectator\nstop' })]) bad(() => buildPlayerAction(input));
  assert.equal(PLAYER_ACTIONS.find(item => item.id === 'kick').requiresCheats, false);
  assert.equal(PLAYER_ACTIONS.find(item => item.id === 'give').requiresCheats, true);
  assert.ok(GAME_ITEMS.every(item => /^minecraft:[a-z_]+$/.test(item.id)));
});

test('default kick narrative follows explicit server language and custom reason remains one opaque safe line', () => {
  assert.match(buildPlayerAction(request('kick')).command, /The gate rests/);
  assert.match(buildPlayerAction(request('kick'), 'vi').command, /Cánh cổng/);
  assert.match(buildPlayerAction(request('kick'), 'vi-VN').command, /The gate rests/);
  assert.equal(buildPlayerAction(request('kick', { reason: 'Please return in a moment.' })).command, 'kick "A Traveler" Please return in a moment.');
  for (const reason of ['@a', 'bad\nstop', '§cReason', 'x\u202ey', '\ud800', ' '.repeat(2), 'x'.repeat(161)]) bad(() => buildPlayerAction(request('kick', { reason })));
});

test('only fresh timestamped native typed rule output qualifies; chat, command echo and other rules do not', () => {
  assert.deepEqual(parseNativeRule(native('keepinventory = false'), 'keepinventory'), { value: false, nativeFeedback: 'keepinventory = false' });
  assert.equal(parseNativeRule(native('randomtickspeed = 1'), 'randomtickspeed').value, 1);
  for (const line of ['keepinventory = false', '> gamerule keepinventory', native('<A Traveler> keepinventory = false'), native('[Server] keepinventory = false'), native('pvp = true'), native('keepinventory = 1'), native('keepinventory = false and more')]) assert.equal(parseNativeRule(line, 'keepinventory'), null);
  for (const level of ['WARN', 'WARNING', 'ERROR']) assert.equal(parseNativeRule(native('keepinventory = true').replace('INFO]', `${level}]`), 'keepinventory'), null);
});

test('world controls use verified stable console names, useful bilingual descriptions and no guessed world defaults', () => {
  const required = ['showcoordinates', 'showdaysplayed', 'doimmediaterespawn', 'keepinventory', 'pvp', 'falldamage', 'firedamage', 'drowningdamage', 'freezedamage', 'tntexplodes', 'respawnblocksexplode', 'doinsomnia', 'recipesunlock', 'dolimitedcrafting', 'projectilescanbreakblocks', 'tntexplosiondropdecay'];
  assert.equal(new Set(GAME_RULES.map(rule => rule.key)).size, GAME_RULES.length);
  for (const key of required) {
    const spec = GAME_RULES.find(rule => rule.key === key); assert.ok(spec, key);
    assert.deepEqual(validateRuleChanges({ worldRevision, changes: { [key]: true }, expected: { [key]: false } }).keys, [key]);
    for (const value of [true, false]) assert.equal(parseNativeRule(native(`${key} = ${value}`), key)?.value, value);
  }
  assert.equal(GAME_RULES[0].key, 'showcoordinates'); assert.equal(GAME_RULES[0].featured, true);
  for (const spec of GAME_RULES) {
    assert.ok(['display', 'survival', 'environment', 'mobs', 'building', 'advanced'].includes(spec.group));
    assert.ok(spec.description.en.length > 15 && spec.description.vi.length > 15); assert.notEqual(spec.description.en, spec.description.vi);
    assert.equal(Object.hasOwn(spec, 'default'), false); assert.equal(Object.hasOwn(spec, 'value'), false);
  }
  for (const key of ['showdays', 'immediaterespawn', 'keepInventory', 'showCoordinates', '__proto__', 'showcoordinates\nstop']) bad(() => validateRuleQuery({ worldRevision, keys: [key] }));
});

test('rule response parser distinguishes old-engine rejection, permissions and unrelated native output', () => {
  const old = parseNativeRuleResponse(native('Syntax error: Unexpected "showdaysplayed": at "gamerule >>showdaysplayed<<"').replace('INFO]', 'ERROR]'), 'showdaysplayed');
  assert.equal(old.status, 'rejected'); assert.equal(old.reasonCode, 'unsupported-or-invalid-rule');
  const permission = parseNativeRuleResponse(native('You do not have permission to use this command.'), 'showcoordinates');
  assert.equal(permission.status, 'rejected'); assert.equal(permission.reasonCode, 'permission-denied');
  assert.equal(parseNativeRuleResponse(native('Game rule showcoordinates has been updated to true'), 'showcoordinates'), null);
  assert.equal(parseNativeRuleResponse(native('Game rule showcoordinates has been updated to true'), 'showcoordinates', { mutation: true }).setFeedback, true);
  for (const line of [native('World saved'), native('pvp = true'), native('[Server] Syntax error: no'), native('<Player> showcoordinates = true'), native('Game rule showcoordinates has been updated to true').replace('INFO]', 'WARN]')]) assert.equal(parseNativeRuleResponse(line, 'showcoordinates', { mutation: true }), null);
  assert.equal(parseNativeRuleResponse(native('showdays = true'), 'showdays'), null);
});

test('real console rule reads wait for a closing fence, reject conflicting values and never infer support after timeout', async () => {
  for (const scenario of ['confirmed', 'unsupported', 'conflict', 'timeout']) {
    let control; const writes = [];
    control = createGameplayConsole({ timeoutMs: 18, send(command, options) {
      writes.push({ command, options });
      if (options.internal) { if (scenario !== 'timeout') queueMicrotask(() => control.consume(native(`Unknown command: ${command}. Please check that the command exists.`))); }
      else queueMicrotask(() => {
        control.consume(native('showcoordinates = true').replace('INFO]', 'WARN]'));
        if (scenario === 'unsupported') control.consume(native('Unknown game rule: showcoordinates').replace('INFO]', 'ERROR]'));
        else if (scenario !== 'timeout') { control.consume(native('showcoordinates = true')); if (scenario === 'conflict') control.consume(native('showcoordinates = false')); }
      });
      return { acceptedToConsole: true };
    } });
    const result = await control.run(console => console.exchange('gamerule showcoordinates', line => parseNativeRuleResponse(line, 'showcoordinates'), { endFence: true }));
    assert.equal(writes.length, 2); assert.equal(writes[0].command, 'gamerule showcoordinates'); assert.match(writes[1].command, /^vortex_query_/);
    if (scenario === 'confirmed') { assert.equal(result.status, 'confirmed'); assert.equal(result.reasonCode, 'native-rule-value'); assert.equal(result.value, true); assert.equal(result.boundaryConfirmed, true); }
    else if (scenario === 'unsupported') { assert.equal(result.status, 'rejected'); assert.equal(result.reasonCode, 'unsupported-or-invalid-rule'); assert.equal(Object.hasOwn(result, 'value'), false); }
    else { assert.equal(result.status, 'unconfirmed'); assert.notEqual(result.confirmedApplied, true); assert.equal(result.reasonCode, scenario === 'conflict' ? 'feedback-conflict' : 'feedback-boundary-missing'); }
    control.close();
  }
});

test('rule mutation acknowledgement is bounded and requires matching readback; rejection preserves unsent tail', async () => {
  const input = validateRuleChanges({ worldRevision, changes: { showcoordinates: true, keepinventory: true }, expected: { showcoordinates: false, keepinventory: false } });
  for (const scenario of ['rejected', 'mismatch']) {
    const writes = []; const result = await applyGameRuleChanges(input, { guard: async () => {}, query: async key => ({ key, value: false, status: 'confirmed', nativeFeedback: `${key} = false` }), console: { exchange: async (command, match, options) => {
      writes.push(command); assert.equal(options.endFence, true);
      const response = scenario === 'rejected' ? match(native('Invalid game rule showcoordinates').replace('INFO]', 'ERROR]')) : match(native('Game rule showcoordinates has been updated to true'));
      return { acceptedToConsole: true, status: 'confirmed', ...response };
    } } });
    assert.equal(writes.length, 1); assert.equal(result.allConfirmed, false); assert.equal(result.results[0].confirmedApplied, false);
    assert.equal(result.results[0].reasonCode, scenario === 'rejected' ? 'unsupported-or-invalid-rule' : 'readback-mismatch');
    assert.equal(result.results[1].status, 'not-sent'); assert.equal(result.results[1].acceptedToConsole, false);
  }
  const response = localizeApiResponse('/api/servers/a/gamerules', { message: 'Bedrock từ chối quyền thực hiện lệnh luật thế giới.' }, 'en');
  assert.equal(response.message, 'Bedrock denied permission to execute the world rule command.');
});

test('player feedback matches exact target boundaries without chat or substring-name confusion', () => {
  const kill = buildPlayerAction(request('kill'));
  assert.equal(parseNativePlayerResult(native('Killed A Traveler'), kill).confirmedApplied, true);
  for (const line of [native('Killed A Traveler2'), native('Killed Other A Traveler'), native('<A Traveler> Killed A Traveler'), native('[Server] Killed A Traveler'), '> kill "A Traveler"']) assert.equal(parseNativePlayerResult(line, kill), null);
  assert.equal(parseNativePlayerResult(native('No targets matched selector'), kill).status, 'rejected');
});

test('native connect/disconnect generates per-connection tokens; stale/rejoined, duplicate name and changed XUID are rejected', () => {
  const online = new Map(), tokens = new Map(), line = native('Player connected: A Traveler, xuid: 253000000000001, pfid: [redacted]');
  assert.equal(trackGameplayPlayer(online, tokens, line), true);
  const first = connectedGameplayPlayers(online, tokens)[0]; assertGameplayPlayer(online, tokens, first);
  trackGameplayPlayer(online, tokens, line); assert.equal(connectedGameplayPlayers(online, tokens)[0].connectionId, first.connectionId);
  assert.equal(trackGameplayPlayer(online, tokens, 'Player disconnected: A Traveler, xuid: 253000000000001'), false);
  trackGameplayPlayer(online, tokens, native('Player disconnected: A Traveler, xuid: 253000000000001'));
  assert.throws(() => assertGameplayPlayer(online, tokens, first), error => error.status === 409);
  trackGameplayPlayer(online, tokens, line); const second = connectedGameplayPlayers(online, tokens)[0]; assert.notEqual(second.connectionId, first.connectionId);
  assert.throws(() => assertGameplayPlayer(online, tokens, first), error => error.status === 409);
  trackGameplayPlayer(online, tokens, native('Player connected: A Traveler, xuid: 253000000000002'));
  assert.throws(() => assertGameplayPlayer(online, tokens, second), error => error.status === 409);
});

test('native console fence serializes operations and ignores stale echoes/chat before exact fresh output', async () => {
  const writes = []; let console;
  console = createGameplayConsole({ timeoutMs: 100, send(command, options) { writes.push({ command, options }); if (options.internal) queueMicrotask(() => console.consume(native(`Unknown command: ${command}. Please check that the command exists and that you have permission to use it.`))); else queueMicrotask(() => { console.consume(native('<player> keepinventory = true')); console.consume('keepinventory = true'); console.consume(native('pvp = true')); console.consume(native('keepinventory = false')); }); return { acceptedToConsole: true, auditRecorded: true }; } });
  const result = await console.run(async control => { assert.equal(control.busy, true); await assert.rejects(control.run(() => {}), error => error.status === 409); await control.fence(); return control.exchange('gamerule keepinventory', line => parseNativeRule(line, 'keepinventory')); });
  assert.equal(result.value, false); assert.equal(result.acceptedToConsole, true); assert.equal(result.status, 'confirmed'); assert.equal(console.busy, false);
  assert.match(writes[0].command, /^vortex_query_[a-f0-9]{32}$/); assert.equal(writes[0].options.internal, true); assert.equal(writes[1].command, 'gamerule keepinventory');
});

test('timeout/closed native output honestly returns accepted without confirmation and never retries', async () => {
  let writes = 0; const console = createGameplayConsole({ timeoutMs: 12, send() { writes++; return { acceptedToConsole: true, warnings: ['Audit unavailable'] }; } });
  const result = await console.run(control => control.exchange('kill "A Traveler"', () => null));
  assert.equal(result.acceptedToConsole, true); assert.equal(result.confirmedApplied, false); assert.equal(result.status, 'unconfirmed'); assert.equal(writes, 1); assert.deepEqual(result.warnings, ['Audit unavailable']);
  const promise = console.run(control => control.exchange('kill "A Traveler"', () => null)); console.close(); const closed = await promise;
  assert.equal(closed.acceptedToConsole, true); assert.equal(closed.confirmedApplied, false); assert.equal(writes, 2); await assert.rejects(console.run(() => {}), error => error.status === 409);
});

test('failed fence prevents mutation, failed stdin never reports accepted, and match faults do not break native consumption', async () => {
  let writes = 0; const noFence = createGameplayConsole({ timeoutMs: 10, send() { writes++; return { acceptedToConsole: true }; } });
  await assert.rejects(noFence.run(async control => { await control.fence(); await control.exchange('kill "A Traveler"', () => null); }), error => error.status === 409); assert.equal(writes, 1);
  const broken = createGameplayConsole({ send() { throw Error('stdin failed'); } }); await assert.rejects(broken.run(control => control.exchange('op "A Traveler"', () => null)), /stdin failed/); assert.equal(broken.busy, false);
  const fault = createGameplayConsole({ timeoutMs: 10, send() { return { acceptedToConsole: true }; } }); const promise = fault.run(control => control.exchange('gamerule pvp', () => { throw Error('Matcher fault'); })); assert.doesNotThrow(() => fault.consume(native('pvp = true'))); assert.equal((await promise).confirmedApplied, false);
});

test('HTTP gameplay localization carries bilingual metadata while native feedback/player identity remain opaque', () => {
  const body = { available: true, world: { name: 'Không tìm thấy server.', revision: worldRevision }, rules: [{ ...GAME_RULES[0], nativeFeedback: 'keepinventory = false' }], actions: PLAYER_ACTIONS, itemCatalog: GAME_ITEMS, players: [target], reason: 'Cần server native đang chạy và sẵn sàng để dùng gameplay.' };
  for (const locale of ['en', 'vi']) { const result = localizeApiResponse('/api/servers/a/gameplay', body, locale); assert.equal(result.rules[0].label, GAME_RULES[0].label[locale]); assert.deepEqual(result.rules[0].labelI18n, GAME_RULES[0].label); assert.equal(result.rules[0].nativeFeedback, body.rules[0].nativeFeedback); assert.equal(result.world.name, body.world.name); assert.deepEqual(result.players, [target]); assert.equal(result.actions[0].fields[0].labelI18n.en, 'Item'); }
});

test('rule batch checks every current baseline before any write and reports genuine queried values after success', async () => {
  const input = validateRuleChanges({ worldRevision, changes: { keepinventory: true, randomtickspeed: 2 }, expected: { keepinventory: false, randomtickspeed: 1 } }), current = { keepinventory: false, randomtickspeed: 1 }, calls = [], cache = [];
  const options = { guard: async () => {}, query: async key => { calls.push('read:' + key); return { key, value: current[key], status: 'confirmed', nativeFeedback: `${key} = ${current[key]}` }; }, console: { exchange: async command => { calls.push(command); const [, key, value] = command.split(' '); current[key] = key === 'randomtickspeed' ? Number(value) : value === 'true'; return { acceptedToConsole: true, status: 'confirmed' }; } }, onRead: row => cache.push(row) };
  const result = await applyGameRuleChanges(input, options); assert.deepEqual(calls.slice(0, 2), ['read:keepinventory', 'read:randomtickspeed']); assert.equal(result.allConfirmed, true); assert.equal(result.partial, false); assert.equal(result.atomic, false); assert.deepEqual(result.results.map(row => row.value), [true, 2]); assert.equal(cache.length, 4);
  calls.length = 0; await assert.rejects(applyGameRuleChanges(input, options), error => error.status === 409); assert.ok(calls.every(call => call.startsWith('read:')));
});

test('world changes after enqueue preserve accepted truth, unsent tail and no retry; native timeouts never masquerade as applied', async () => {
  const input = validateRuleChanges({ worldRevision, changes: { keepinventory: true, pvp: false }, expected: { keepinventory: false, pvp: true } }); let writes = 0, changed = false;
  const options = { guard: async () => { if (changed) throw Object.assign(Error('World changed'), { status: 409 }); }, query: async key => ({ key, value: input.expected[key], status: 'confirmed' }), console: { exchange: async () => { writes++; changed = true; return { acceptedToConsole: true, status: 'confirmed' }; } } };
  const result = await applyGameRuleChanges(input, options); assert.equal(writes, 1); assert.equal(result.partial, true); assert.equal(result.results[0].acceptedToConsole, true); assert.equal(result.results[0].confirmedApplied, false); assert.equal(result.results[1].status, 'not-sent'); assert.equal(result.results[1].acceptedToConsole, false);
  writes = 0; const timeout = await applyGameRuleChanges(input, { ...options, guard: async () => {}, console: { exchange: async () => { writes++; return { acceptedToConsole: true, confirmedApplied: false, status: 'unconfirmed', message: 'Missing native feedback' }; } } }); assert.equal(writes, 1); assert.equal(timeout.allConfirmed, false); assert.equal(timeout.results[0].status, 'unconfirmed'); assert.ok(!Object.hasOwn(timeout.results[0], 'value')); assert.equal(timeout.results[1].status, 'not-sent');
});
