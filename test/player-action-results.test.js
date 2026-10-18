import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildPlayerAction, parseNativePlayerResult, executePlayerAction, createGameplayConsole, quotePlayerName } from '../server/gameplay.js';
import { localizeApiResponse } from '../server/locale.js';

const target = { name: 'ExamplePlayer', xuid: '', connectionId: randomUUID() }, worldRevision = 'a'.repeat(64);
const native = (body, severity = 'INFO') => `[2026-10-17 13:04:09:980 ${severity}] ${body}`;
const request = (action, values) => buildPlayerAction({ worldRevision, action, target, ...(values ? { values } : {}) });
const fence = command => native(`Unknown command: ${command}. Please check that the command exists and that you have permission to use it.`, 'ERROR');
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const observed = [
  [request('give', { itemId: 'minecraft:diamond', count: 1 }), 'Gave Diamond * 1 to ExamplePlayer'],
  [request('deop'), 'De-opped: ExamplePlayer'],
  [request('op'), 'Opped: ExamplePlayer'],
  [request('teleport', { x: 1, y: 1, z: 1 }), 'Teleported ExamplePlayer to 1.50, 1.00, 1.50'],
  [request('kill'), 'Killed ExamplePlayer'],
  [request('heal'), 'Gave Instant Health * 4 to ExamplePlayer for 0 seconds'],
  [request('gamemode', { mode: 'creative' }), "Set ExamplePlayer's game mode to Creative"],
  [request('kick', { reason: 'Gay' }), "Kicked ExamplePlayer from the game: 'Gay'"]
];

test('observed Bedrock player feedback, including colon op/deop and zero-duration instant health, matches the exact action', () => {
  for (const [input, feedback] of observed) {
    const result = parseNativePlayerResult(native(feedback), input);
    assert.equal(result?.status, 'confirmed', feedback); assert.equal(result.confirmedApplied, true); assert.equal(result.reasonCode, 'native-confirmed'); assert.equal(result.nativeFeedback, feedback);
  }
  for (const action of ['give', 'deop']) {
    const input = observed.find(([row]) => row.spec.id === action)[0];
    const rejected = parseNativePlayerResult(native('No targets matched selector', 'ERROR'), input);
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.confirmedApplied, false); assert.equal(rejected.reasonCode, 'no-targets');
  }
  for (const [values, feedback] of [
    [{ x: -1, y: -2, z: -3 }, 'Teleported ExamplePlayer to -0.50, -2.00, -2.50'],
    [{ x: 0, y: 0, z: 0 }, 'Teleported ExamplePlayer to 0.50, 0.00, 0.50'],
    [{ x: -1.25, y: 1.5, z: 2.75 }, 'Teleported ExamplePlayer to -1.25, 1.50, 2.75']
  ]) assert.equal(parseNativePlayerResult(native(feedback), request('teleport', values))?.status, 'confirmed', feedback);
  assert.equal(observed.find(([row]) => row.spec.id === 'teleport')[0].command, 'teleport "ExamplePlayer" 1 1 1 true', 'Exact emitted command from the user trace');
});

test('different players, requested values, chats, input echoes and unknown localized feedback never confirm the requested action', () => {
  for (const [input, feedback] of observed) {
    for (const body of [feedback.replaceAll('ExamplePlayer', 'ExamplePlayer2'), feedback.replaceAll('ExamplePlayer', 'Other ExamplePlayer'), `<ExamplePlayer> ${feedback}`, `[Server] ${feedback}`]) assert.equal(parseNativePlayerResult(native(body), input), null, body);
    assert.equal(parseNativePlayerResult(`> ${input.command}`, input), null);
    assert.equal(parseNativePlayerResult(native(feedback, 'ERROR'), input), null);
  }
  for (const [input, body] of [
    [request('give', { itemId: 'minecraft:diamond', count: 1 }), 'Gave Apple * 1 to ExamplePlayer'],
    [request('give', { itemId: 'minecraft:diamond', count: 1 }), 'Gave Diamond * 64 to ExamplePlayer'],
    [request('give', { itemId: 'minecraft:diamond', count: 1 }), 'Gave Diamond * 1 to ExamplePlayer.'],
    [request('kill'), 'Killed ExamplePlayer.'],
    [request('heal'), 'Gave Speed effect * 4 to ExamplePlayer for 0 seconds'],
    [request('heal'), 'Gave Instant Health * 1 to ExamplePlayer for 30 seconds'],
    [request('teleport', { x: 1.5, y: 1, z: 1.5 }), 'Teleported ExamplePlayer to 10.50, 1.00, 1.50'],
    [request('teleport', { x: 1, y: 1, z: 1 }), 'Teleported ExamplePlayer to 1.00, 1.00, 1.00'],
    [request('teleport', { x: -1, y: -2, z: -3 }), 'Teleported ExamplePlayer to -1.50, -1.50, -3.50'],
    [request('gamemode', { mode: 'creative' }), "Set ExamplePlayer's game mode to Survival"],
    [request('deop'), 'Đã gỡ quyền của ExamplePlayer']
  ]) assert.equal(parseNativePlayerResult(native(body), input), null, body);
  for (const name of ['ExamplePlayer\u2028kill', 'ExamplePlayer\u2029op', '§aExamplePlayer', '@a[name=ExamplePlayer]']) assert.throws(() => quotePlayerName(name), { status: 400 });
});

test('a player result requires its trailing boundary; stale internal errors and pre-fence output cannot settle it', async () => {
  const writes = []; let settled = false;
  const console = createGameplayConsole({ timeoutMs: 200, send(command, options) { writes.push({ command, options }); return { acceptedToConsole: true }; } });
  const input = request('deop'), pending = console.run(async control => { await control.fence(); return executePlayerAction(input, { console: control }); }); pending.then(() => { settled = true; });
  console.consume(native('De-opped: ExamplePlayer')); assert.equal(writes.length, 1);
  console.consume(fence(writes[0].command)); await flush();
  assert.equal(writes[1].command, 'deop "ExamplePlayer"'); assert.equal(writes[2].options.internal, true);
  console.consume(fence(writes[0].command)); console.consume(native('De-opped: ExamplePlayer')); await flush(); assert.equal(settled, false);
  await assert.rejects(console.run(() => {}), { status: 409 });
  console.consume(fence(writes[2].command)); const result = await pending;
  assert.equal(result.status, 'confirmed'); assert.equal(result.confirmedApplied, true); assert.equal(result.acceptedToConsole, true); assert.equal(result.correlation.completed, true); assert.equal(result.clientReceiptConfirmed, false);
  assert.equal(writes.filter(row => row.command.startsWith('deop ')).length, 1);
});

test('missing completion boundary, conflicting feedback and native close stay unconfirmed without action retries', async () => {
  for (const mode of ['missing-boundary', 'conflicting', 'closed', 'boundary-write-failed']) {
    const writes = []; let console;
    console = createGameplayConsole({ timeoutMs: 12, send(command, options) {
      writes.push({ command, options });
      if (options.internal && writes.length === 1) queueMicrotask(() => console.consume(fence(command)));
      else if (!options.internal) queueMicrotask(() => {
        console.consume(native('De-opped: ExamplePlayer'));
        if (mode === 'conflicting') console.consume(native('No targets matched selector', 'ERROR'));
        if (mode === 'closed') console.close();
      });
      else if (mode === 'conflicting') queueMicrotask(() => console.consume(fence(command)));
      else if (mode === 'boundary-write-failed') throw new Error('Controlled trailing marker write failure');
      return { acceptedToConsole: true };
    } });
    const result = await console.run(async control => { await control.fence(); return executePlayerAction(request('deop'), { console: control }); });
    assert.equal(result.status, 'unconfirmed', mode); assert.equal(result.confirmedApplied, false); assert.equal(result.acceptedToConsole, true); assert.equal(writes.filter(row => row.command.startsWith('deop ')).length, 1);
    assert.equal(result.correlation.completed, mode === 'conflicting');
    if (mode === 'missing-boundary') assert.equal(result.nativeFeedback, 'De-opped: ExamplePlayer', 'Unconfirmed observed feedback remains reviewable');
  }
});

test('feedback arriving after an end boundary cannot confirm that action or a different subsequent action', async () => {
  const writes = [], console = createGameplayConsole({ timeoutMs: 200, send(command, options) { writes.push({ command, options }); return { acceptedToConsole: true }; } });
  const begin = input => console.run(async control => { await control.fence(); return executePlayerAction(input, { console: control }); });
  const first = begin(request('deop')); console.consume(fence(writes[0].command)); await flush();
  console.consume(fence(writes[2].command)); const missing = await first; assert.equal(missing.status, 'unconfirmed');
  const second = begin(request('op')); console.consume(native('De-opped: ExamplePlayer')); console.consume(fence(writes[3].command)); await flush();
  console.consume(fence(writes[2].command)); console.consume(native('De-opped: ExamplePlayer')); console.consume(native('Opped: ExamplePlayer')); console.consume(fence(writes[5].command));
  const result = await second; assert.equal(result.status, 'confirmed'); assert.equal(result.nativeFeedback, 'Opped: ExamplePlayer');
});

test('kick disconnect is expected after acceptance, while rejected and successful results retain bilingual target messages and opaque feedback', async () => {
  for (const [input, feedback] of [...observed, [request('deop'), 'No targets matched selector']]) {
    let console;
    console = createGameplayConsole({ send(command, options) {
      if (options.internal) queueMicrotask(() => console.consume(fence(command)));
      else queueMicrotask(() => { console.consume(native(feedback, feedback === 'No targets matched selector' ? 'ERROR' : 'INFO')); if (input.spec.id === 'kick') console.consume(native('Player disconnected: ExamplePlayer, xuid: ')); });
      return { acceptedToConsole: true, warnings: ['Lệnh đã được nhận nhưng không thể ghi nhật ký hoạt động.'] };
    } });
    const body = await console.run(async control => { await control.fence(); return executePlayerAction(input, { console: control }); });
    for (const language of ['en', 'vi']) {
      const response = localizeApiResponse('/api/servers/fixture/player-actions', body, language);
      assert.equal(response.message, response.messageI18n[language]); assert.equal(response.nativeFeedback, feedback); assert.deepEqual(response.target, target); assert.equal(response.clientReceiptConfirmed, false);
      assert.ok(response.message.includes('ExamplePlayer')); assert.ok(response.warnings.length);
    }
    assert.equal(body.status, feedback === 'No targets matched selector' ? 'rejected' : 'confirmed');
    if (body.status === 'rejected') assert.equal(body.reasonCode, 'no-targets');
  }
});

test('identical delayed feedback after an unconfirmed action never confirms its repeated action, but unrelated actions and targets continue', async () => {
  let console, feedback = null;
  console = createGameplayConsole({ send(command, options) {
    if (options.internal) queueMicrotask(() => console.consume(fence(command)));
    else if (feedback) queueMicrotask(() => console.consume(native(feedback)));
    return { acceptedToConsole: true };
  } });
  const run = input => console.run(async control => { await control.fence(); return executePlayerAction(input, { console: control }); });
  assert.equal((await run(request('deop'))).status, 'unconfirmed');
  feedback = 'De-opped: ExamplePlayer'; const repeated = await run(request('deop'));
  assert.equal(repeated.status, 'unconfirmed'); assert.equal(repeated.confirmedApplied, false); assert.equal(repeated.reasonCode, 'prior-feedback-ambiguous'); assert.equal(repeated.nativeFeedback, feedback);
  assert.match(repeated.messageI18n.en, /earlier identical action/);
  feedback = 'Opped: ExamplePlayer'; assert.equal((await run(request('op'))).status, 'confirmed');
  feedback = 'De-opped: OtherPlayer'; const other = buildPlayerAction({ worldRevision, action: 'deop', target: { ...target, name: 'OtherPlayer' } });
  assert.equal((await run(other)).status, 'confirmed');
  feedback = null; assert.equal((await run(request('teleport', { x: 1, y: 1, z: -1 }))).status, 'unconfirmed');
  feedback = 'Teleported ExamplePlayer to 1.50, 1.00, -0.50';
  const sameNativeCoordinates = await run(request('teleport', { x: 1.5, y: 1, z: -0.5 }));
  assert.equal(sameNativeCoordinates.status, 'unconfirmed'); assert.equal(sameNativeCoordinates.reasonCode, 'prior-feedback-ambiguous', 'Different coordinate literals with identical native feedback share the ambiguity fingerprint');
  let fresh; fresh = createGameplayConsole({ send(command, options) { queueMicrotask(() => fresh.consume(options.internal ? fence(command) : native('De-opped: ExamplePlayer'))); return { acceptedToConsole: true }; } });
  assert.equal((await fresh.run(async control => { await control.fence(); return executePlayerAction(request('deop'), { console: control }); })).status, 'confirmed', 'A separately created runtime has its own correlation history; no restart was requested');
});

test('explicit rejection and unsent actions never poison later confirmation; ambiguity capacity fails closed without evicting prior fingerprints', async () => {
  let console, feedback = 'No targets matched selector', rejectWrite = false;
  console = createGameplayConsole({ ambiguityLimit: 1, send(command, options) {
    if (options.internal) queueMicrotask(() => console.consume(fence(command)));
    else if (rejectWrite) throw Error('Controlled stdin rejected before enqueue');
    else if (feedback) queueMicrotask(() => console.consume(native(feedback, feedback === 'No targets matched selector' ? 'ERROR' : 'INFO')));
    return { acceptedToConsole: true };
  } });
  const run = input => console.run(async control => { await control.fence(); return executePlayerAction(input, { console: control }); });
  assert.equal((await run(request('deop'))).status, 'rejected');
  feedback = 'De-opped: ExamplePlayer'; assert.equal((await run(request('deop'))).status, 'confirmed');
  rejectWrite = true; await assert.rejects(run(request('kill')), /before enqueue/); rejectWrite = false;
  feedback = 'Killed ExamplePlayer'; assert.equal((await run(request('kill'))).status, 'confirmed');
  feedback = null; assert.equal((await run(request('deop'))).status, 'unconfirmed'); assert.equal((await run(request('op'))).status, 'unconfirmed');
  feedback = 'De-opped: ExamplePlayer'; const retained = await run(request('deop')); assert.equal(retained.status, 'unconfirmed'); assert.equal(retained.reasonCode, 'feedback-ambiguity-capacity');
  feedback = 'Killed ExamplePlayer'; const saturated = await run(request('kill')); assert.equal(saturated.status, 'unconfirmed'); assert.equal(saturated.reasonCode, 'feedback-ambiguity-capacity');
  assert.match(saturated.messageI18n.en, /tracking limit/);
});
