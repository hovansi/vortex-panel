import test from 'node:test';
import assert from 'node:assert/strict';
import { bedrockLogLevel, trackBedrockPlayer } from '../server/bedrock-log.js';

test('native profiler INFO is not an error; explicit native severity wins', () => {
  assert.equal(bedrockLogLevel('[2026-10-14 01:00:00:123 INFO] profiler enabled=false errorMessage=(null)'), 'info');
  assert.equal(bedrockLogLevel('[2026-10-14 01:00:00:123 ERROR] Players will not be able to connect'), 'error');
  assert.equal(bedrockLogLevel('[2026-10-14 01:00:00:123 WARN] Pack validation'), 'warn');
  assert.equal(bedrockLogLevel('[INFO] Failed attempts: 0', 'warn'), 'info');
  assert.equal(bedrockLogLevel('Failed to open database'), 'error');
  assert.equal(bedrockLogLevel('errorMessage=(null)'), 'info');
  assert.equal(bedrockLogLevel('Unclassified stderr output', 'warn'), 'warn');
});

test('real empty-XUID native records track two offline players and disconnect independently', () => {
  const online = new Map();
  assert.equal(trackBedrockPlayer(online, '[2026-10-14 01:07:31:961 INFO] Player connected: VortexQABot, xuid: '), true);
  trackBedrockPlayer(online, '[2026-10-14 01:07:32:961 INFO] Player connected: VortexQABotB, xuid: ');
  assert.deepEqual([...online.values()], [{ name: 'VortexQABot', xuid: '' }, { name: 'VortexQABotB', xuid: '' }]);
  trackBedrockPlayer(online, '[2026-10-14 01:08:28:940 INFO] Player disconnected: VortexQABot, xuid: , pfid: ');
  assert.deepEqual([...online.values()], [{ name: 'VortexQABotB', xuid: '' }]);
  trackBedrockPlayer(online, '[2026-10-14 01:08:29:940 INFO] Player disconnected: vortexqabotb, xuid: , pfid: ');
  assert.equal(online.size, 0);
});

test('Xbox XUID stays an exact string; reconnect is idempotent and names may change', () => {
  const online = new Map(), xuid = '2533274999999999';
  trackBedrockPlayer(online, `Player connected: Gamer, xuid: ${xuid}`);
  trackBedrockPlayer(online, `Player connected: Renamed Gamer, xuid: ${xuid}, pfid: anything`);
  assert.deepEqual([...online.values()], [{ name: 'Renamed Gamer', xuid }]);
  trackBedrockPlayer(online, `Player disconnected: Gamer, xuid: ${xuid}, pfid: `);
  assert.equal(online.size, 0);
});

test('zero XUID uses separate names and chat or malformed output cannot create players', () => {
  const online = new Map();
  trackBedrockPlayer(online, 'Player connected: First, xuid: 0');
  trackBedrockPlayer(online, 'Player connected: Second, xuid: 0');
  assert.equal(online.size, 2);
  for (const line of ['<First> Player connected: Fake, xuid: 123', 'Player Spawned: Fake xuid: , pfid: ', 'Player connected: Fake, xuid: invalid', 'Player connected: Fake, xuid: 12oops']) assert.equal(trackBedrockPlayer(online, line), false);
  assert.equal(online.size, 2);
});
