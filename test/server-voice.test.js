import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { buildWorldVoice, WorldVoiceValidationError, WORLD_VOICE_TEMPLATES, worldVoiceErrorText } from '../public/world-voice.js';
import { trackBedrockPlayer } from '../server/bedrock-log.js';
import { createNativeWorldVoice, parseNativeWorldVoiceEvent, announceGracefulWorldPause, buildGracefulWorldPause, dispatchConsoleLine } from '../server/server-voice.js';
import { translatePanelMessage, localizeApiResponse } from '../server/locale.js';

// Format captured from a genuine 26.52 client join; identity values redacted.
// These parser fixtures do not claim a new Xbox authentication or game session.
const native = message => `[2026-10-14 10:04:54:224 INFO] ${message}`;
const connect = native('Player connected: Traveler, xuid: 1234567890123456');
const spawn = native('Player Spawned: Traveler xuid: 1234567890123456, pfid: REDACTED');
const disconnect = native('Player disconnected: Traveler, xuid: 1234567890123456, pfid: REDACTED');

test('welcome waits for native Spawned, correlates an online player and deduplicates one connection', () => {
  const server = { name: 'Sky Islands', status: 'running' }, online = new Map(), commands = [];
  const voice = createNativeWorldVoice({ server, online, send(command) { commands.push(command); return { acceptedToConsole: true }; } });
  assert.equal(voice.consume(spawn), false); // Spawn without connected identity.
  trackBedrockPlayer(online, connect); assert.equal(voice.consume(connect), false);
  assert.equal(voice.consume(spawn), true); assert.equal(voice.consume(spawn), false);
  assert.equal(commands.length, 1); assert.match(commands[0], /^say §b✦ /); assert.match(commands[0], /A new chapter opens/);
  assert.ok(!commands[0].includes('[Vortex]') && !commands[0].includes('[Server]'));
  assert.ok(new Set(commands[0].match(/§[0-9a-f]/g)).size >= 4);
  trackBedrockPlayer(online, disconnect); voice.consume(disconnect); trackBedrockPlayer(online, connect);
  assert.equal(voice.consume(spawn), true); assert.equal(commands.length, 2);
  server.messageLanguage = 'vi'; trackBedrockPlayer(online, disconnect); voice.consume(disconnect); trackBedrockPlayer(online, connect);
  assert.equal(voice.consume(spawn), true); assert.match(commands[2], /Một chương mới mở ra/);
});

test('native welcome rejects forged chat, foreign identities and unsupported lines without identity invention', () => {
  for (const line of [spawn.slice(spawn.indexOf('Player')), '<Traveler> ' + spawn, native('<Traveler> Player Spawned: Fake xuid: 12'), native('Player Spawned: Traveler xuid: 12oops'), '[2026-10-14 10:04:54:224 WARN] Player Spawned: Traveler xuid: 1234567890123456']) assert.equal(parseNativeWorldVoiceEvent(line), null, line);
  const online = new Map([['xuid:1234567890123456', { name: 'Someone else', xuid: '1234567890123456' }]]), server = { name: 'Sky', status: 'running' };
  let sends = 0; const voice = createNativeWorldVoice({ server, online, send() { sends++; return { acceptedToConsole: true }; } });
  assert.equal(voice.consume(spawn), false); assert.equal(sends, 0);
  const offline = parseNativeWorldVoiceEvent(native('Player Spawned: Offline User xuid: , pfid: '));
  assert.equal(offline.key, 'name:offline user'); assert.ok(!('xuid' in offline));
});

test('welcome respects the persisted toggle/state and isolates composition/send/warning failures', () => {
  const server = { name: 'Sky', status: 'running', worldVoiceEnabled: false }, online = new Map(); trackBedrockPlayer(online, connect);
  let calls = 0, warnings = 0;
  const voice = createNativeWorldVoice({ server, online, send() { calls++; throw Error('Closed pipe'); }, onWarning() { warnings++; throw Error('Warning logger failed'); } });
  assert.equal(voice.consume(spawn), false); assert.equal(calls, 0);
  server.worldVoiceEnabled = true; server.status = 'stopping'; assert.equal(voice.consume(spawn), false); assert.equal(calls, 0);
  server.status = 'running'; assert.equal(voice.consume(spawn), false); assert.equal(calls, 1); assert.equal(warnings, 1);
  server.name = '@a'; assert.equal(voice.consume(spawn), false); assert.equal(calls, 1); assert.equal(warnings, 2);
  const demoVoice = createNativeWorldVoice({ server: { name: 'Sky', status: 'running' }, online, send: () => ({ acceptedToConsole: false, simulated: true }) });
  assert.equal(demoVoice.consume(spawn), false);
});

test('graceful announcements tell the actual three-second interruption and never claim completion', async () => {
  for (const language of ['en', 'vi']) for (const reason of ['stop', 'restart', 'backup']) {
    const server = { messageLanguage: language, players: 1 }, events = [];
    const sent = await announceGracefulWorldPause({ server, reason, send(command) { events.push(['send', command]); return { acceptedToConsole: true }; }, async wait(milliseconds) { events.push(['wait', milliseconds]); } });
    assert.equal(sent, true); assert.equal(events.length, 2); assert.equal(events[1][1], 3000);
    const message = buildGracefulWorldPause(server, reason);
    assert.equal(events[0][1], message.command); assert.equal(message.command.split('\n').length, 1); assert.ok(message.command.length < 1024);
    assert.match(message.plainText, language === 'en' ? /3 seconds/ : /3 giây/);
    assert.ok(!/is complete|has finished|đã hoàn tất|đã kết thúc/.test(message.plainText));
    if (reason === 'restart') assert.equal(message.templateId, 'restart');
    if (reason === 'backup') assert.match(message.plainText, language === 'en' ? /backup is planned/ : /Sắp sao lưu/);
  }
});

test('optional pre-stop announcements skip empty worlds/disabled voice and cannot abort shutdown on failures', async () => {
  for (const server of [{ players: 0 }, { players: 2, worldVoiceEnabled: false }]) {
    assert.equal(await announceGracefulWorldPause({ server, send: () => assert.fail('Notice should not send'), wait: () => assert.fail('No delay is needed') }), false);
  }
  let waited = 0;
  assert.equal(await announceGracefulWorldPause({ server: { players: 2 }, send() { throw Error('Pipe closed'); }, wait() { waited++; }, onWarning() { throw Error('Audit disk full'); } }), false); assert.equal(waited, 0);
  assert.equal(await announceGracefulWorldPause({ server: { players: 2 }, send: () => ({ acceptedToConsole: false }), wait() { waited++; } }), false); assert.equal(waited, 0);
});

test('stdin acceptance survives log/audit faults and backpressure, but write rejection is not acknowledged', () => {
  let received = '', writes = 0;
  const pipe = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { received += chunk; writes++; done(); } });
  const receipt = dispatchConsoleLine({ write: () => pipe.write('say §b✦ A new chapter opens.\n'), log() { throw Error('Event subscriber failed'); }, audit() { throw Error('Audit disk full'); } });
  assert.equal(receipt.acceptedToConsole, true); assert.equal(receipt.auditRecorded, false); assert.equal(receipt.simulated, false); assert.equal(receipt.warnings.length, 2); assert.equal(writes, 1); assert.equal(received.split('\n').length, 2);
  let logged = 0;
  assert.throws(() => dispatchConsoleLine({ write() { throw Error('Stdin rejected'); }, log() { logged++; }, audit() { assert.fail('Rejected command must not audit'); } }), /Stdin rejected/); assert.equal(logged, 0);
  const simulated = dispatchConsoleLine({ simulated: true, write() { assert.fail('Demo must not touch stdin'); }, log() {}, audit() {} });
  assert.equal(simulated.acceptedToConsole, false); assert.equal(simulated.simulated, true); assert.equal(simulated.auditRecorded, true); pipe.destroy();
});

test('announcement payload is opaque to panel locale and every validation phrase has EN/VI catalog coverage', () => {
  const composed = buildWorldVoice({ templateId: 'welcome', values: { worldName: 'Không tìm thấy server.' }, language: 'vi' });
  const payload = { announcement: { minecraftMessage: composed.message, preview: composed.segments, plainText: composed.plainText, normalizedValues: composed.normalizedValues, language: 'vi' } };
  assert.deepEqual(localizeApiResponse('/api/servers/id/announcement', payload, 'en'), payload);
  for (const field of WORLD_VOICE_TEMPLATES.flatMap(template => template.fields)) for (const code of field.type === 'select' ? ['choice'] : field.type === 'number' ? ['seconds'] : ['text', 'unicode', 'required', 'length']) {
    const error = new WorldVoiceValidationError(code, field.key, field.maxLength || field.max), vi = worldVoiceErrorText(error, 'vi');
    assert.equal(translatePanelMessage(vi, 'en'), worldVoiceErrorText(error, 'en'));
  }
  for (const code of ['template', 'values', 'method', 'messageLength', 'commandLength', 'saySelector']) {
    const error = new WorldVoiceValidationError(code, '', code === 'messageLength' ? 800 : code === 'commandLength' ? 1024 : undefined);
    assert.equal(translatePanelMessage(worldVoiceErrorText(error, 'vi'), 'en'), worldVoiceErrorText(error, 'en'));
  }
});
