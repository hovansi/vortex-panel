import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_VOICE_TEMPLATES, WORLD_VOICE_LIMITS, WORLD_VOICE_FORMATTING,
  buildWorldVoice, parseWorldVoicePreview, sanitizeWorldVoiceText,
  normalizeWorldVoiceLanguage, getWorldVoiceTemplate,
  worldVoiceErrorText, WorldVoiceValidationError
} from '../public/world-voice.js';

const decoded = command => JSON.parse(command.slice('tellraw @a '.length));
const isError = (code, field) => error => error instanceof WorldVoiceValidationError && error.code === code && (field === undefined || error.field === field);
const fixture = {
  welcome: { worldName: 'Vortex Client Lab', playerName: 'ExamplePlayer' },
  restart: { seconds: 30, address: '203.0.113.10:19232' },
  backup: { phase: 'planned' },
  restore: { phase: 'planned', backupName: 'Before the journey.zip' },
  maintenance: { phase: 'planned', note: 'Expected return 20:30 UTC' },
  custom: { tone: 'adventure', message: 'Build your next chapter.' }
};

test('all six templates can produce one literal tellraw command in EN and VI', () => {
  assert.deepEqual(WORLD_VOICE_TEMPLATES.map(template => template.id), Object.keys(fixture));
  for (const template of WORLD_VOICE_TEMPLATES) {
    assert.ok(template.label.en && template.label.vi && template.description.en && template.description.vi);
    for (const language of ['en', 'vi']) {
      const voice = buildWorldVoice({ templateId: template.id, values: fixture[template.id], language, method: 'tellraw' });
      assert.equal(voice.method, 'tellraw');
      assert.equal(voice.language, language);
      assert.ok(voice.command.startsWith('tellraw @a '));
      assert.deepEqual(decoded(voice.command), { rawtext: [{ text: voice.message }] });
      assert.equal(voice.plainText, voice.segments.map(segment => segment.text).join(''));
      assert.ok(voice.command.length <= WORLD_VOICE_LIMITS.command);
      assert.equal(/[\r\n\0\u2028\u2029]/u.test(voice.command), false);
      assert.equal(/§k/i.test(voice.message), false);
      assert.ok(voice.plainText.startsWith('✦ '));
      assert.equal(/\[(?:World|Thế giới|Vortex|Server)\]/i.test(voice.plainText), false);
    }
  }
});

test('default EN and independently selected VI preserve opaque player/world names', () => {
  assert.equal(normalizeWorldVoiceLanguage('VI-vn'), 'vi');
  for (const language of [undefined, 'de', null, 'english']) assert.equal(normalizeWorldVoiceLanguage(language), 'en');
  const values = { worldName: 'English VI & Minecraft', playerName: '@CallMeHak' };
  const en = buildWorldVoice({ values }), vi = buildWorldVoice({ values, language: 'vi' });
  assert.equal(en.method, 'say');
  assert.equal(en.language, 'en');
  assert.ok(en.command.startsWith('say §b✦ '));
  assert.ok(en.plainText.includes('Welcome, @CallMeHak.'));
  assert.ok(vi.plainText.includes('Chào @CallMeHak.'));
  for (const voice of [en, vi]) assert.ok(voice.plainText.includes(values.worldName));
  assert.notEqual(en.plainText, vi.plainText);
});

test('restart includes exact countdown/address, disconnection and readiness instructions', () => {
  for (const language of ['en', 'vi']) {
    const voice = buildWorldVoice({ templateId: 'restart', language, values: { seconds: '00030', address: 'host.example:19232' } });
    assert.equal(voice.normalizedValues.seconds, 30);
    assert.ok(voice.plainText.includes('30'));
    assert.ok(voice.plainText.includes('host.example:19232'));
    assert.ok(voice.plainText.includes(language === 'vi' ? 'ngắt kết nối' : 'disconnected'));
    assert.ok(voice.plainText.includes(language === 'vi' ? 'khi server đã online' : 'once the server is online'));
  }
  const fallback = buildWorldVoice({ templateId: 'restart', values: { seconds: 1 } });
  assert.ok(fallback.plainText.includes('from your server list once the server is online'));
  for (const seconds of [0, -1, 86401, 1.2, NaN, Infinity, '', ' ', '1e2', '1.0', '30\nstop', null, true]) {
    if (seconds === null) continue; // null means use the declared default.
    assert.throws(() => buildWorldVoice({ templateId: 'restart', values: { seconds } }), isError('seconds', 'seconds'));
  }
});

test('planned and complete operations differ and restore explicitly warns about replaced progress', () => {
  for (const templateId of ['backup', 'restore', 'maintenance']) {
    for (const language of ['en', 'vi']) {
      const planned = buildWorldVoice({ templateId, language }), complete = buildWorldVoice({ templateId, language, values: { phase: 'complete' } });
      assert.notEqual(planned.plainText, complete.plainText);
      if (templateId === 'restore') assert.ok(planned.plainText.includes(language === 'vi' ? 'Tiến trình sau bản sao đó sẽ bị thay thế' : 'Progress after that backup will be replaced'));
    }
    assert.throws(() => buildWorldVoice({ templateId, values: { phase: 'failed' } }), isError('choice', 'phase'));
  }
});

test('free text cannot inject console lines or § style and reports changed fields', () => {
  const dirty = '  §kInvisible §cRED\r\nstop\0\t/gamemode creative\u2028op @a\u2029done\u202e!  ';
  const voice = buildWorldVoice({ templateId: 'custom', method: 'tellraw', values: { message: dirty } });
  assert.equal(voice.normalizedValues.message, 'Invisible RED stop /gamemode creative op @a done!');
  assert.deepEqual(voice.changedFields, ['message']);
  assert.ok(decoded(voice.command).rawtext[0].text.includes('op @a'));
  assert.equal(/[\r\n\0\u2028\u2029\u202e]/u.test(voice.command), false);
  assert.equal(/§[kc]/.test(voice.message), false);
  assert.equal(sanitizeWorldVoiceText('\u001b[31mRed\u001b[0m §Qword §odd §'), 'Red word dd');
});

test('JSON preserves quotes, backslashes, selectors, email and HTML-looking text literally', () => {
  const message = '@a @e[type=player] <img src=x onerror="alert(1)"> user@example.com C:\\worlds\\ExamplePlayer "hello" \'quote\'';
  const voice = buildWorldVoice({ templateId: 'custom', method: 'tellraw', values: { message } });
  assert.equal(voice.normalizedValues.message, message);
  assert.deepEqual(voice.changedFields, []);
  assert.ok(decoded(voice.command).rawtext[0].text.includes(message));
  assert.ok(voice.segments.some(segment => segment.text.includes('<img src=x onerror="alert(1)">')));
  assert.deepEqual(Object.keys(decoded(voice.command)), ['rawtext']);
  assert.deepEqual(Object.keys(decoded(voice.command).rawtext[0]), ['text']);
});

test('Unicode names and emoji stay exact, while incomplete surrogate characters are rejected', () => {
  const worldName = 'Thế giới 👩‍🚀', playerName = 'Va\u0301nSi';
  const voice = buildWorldVoice({ values: { worldName, playerName }, method: 'tellraw', language: 'vi' });
  assert.equal(voice.normalizedValues.worldName, worldName);
  assert.equal(voice.normalizedValues.playerName, playerName);
  assert.ok(decoded(voice.command).rawtext[0].text.includes(worldName));
  for (const message of ['\ud800', '\udfff', 'end\ud800x', 'first\udfff']) assert.throws(() => buildWorldVoice({ templateId: 'custom', values: { message } }), isError('unicode', 'message'));
});

test('preview parses fixed colors/bold/italic/reset without executing or generating HTML', () => {
  const segments = parseWorldVoicePreview('§b§lWorld§c remains bold§o italic§r plain §knever obfuscated §x<img onerror=alert(1)>§');
  assert.deepEqual(segments.slice(0, 4), [
    { text: 'World', color: '#55FFFF', bold: true, italic: false },
    { text: ' remains bold', color: '#FF5555', bold: true, italic: false },
    { text: ' italic', color: '#FF5555', bold: true, italic: true },
    { text: ' plain ', color: '#FFFFFF', bold: false, italic: false }
  ]);
  assert.ok(segments.at(-1).text.includes('<img onerror=alert(1)>'));
  assert.equal(WORLD_VOICE_FORMATTING.obfuscated, false);
  for (const segment of segments) {
    assert.match(segment.color, /^#[\da-f]{6}$/i);
    assert.equal('html' in segment, false);
    assert.equal(typeof segment.bold, 'boolean');
    assert.equal(typeof segment.italic, 'boolean');
  }
});

test('safe classic say is explicit and refuses selector expansion without rewriting input', () => {
  const safe = buildWorldVoice({ templateId: 'custom', method: 'say', values: { message: 'Mail: user@example.com. Welcome, ExamplePlayer!' } });
  assert.equal(safe.command, `say ${safe.message}`);
  assert.ok(safe.message.includes('user@example.com'));
  for (const message of ['@a', 'Hello @e[type=player]', '@p welcome', 'Group @s, hello']) assert.throws(() => buildWorldVoice({ templateId: 'custom', method: 'say', values: { message } }), isError('saySelector'));
  assert.throws(() => buildWorldVoice({ templateId: 'custom', method: 'execute', values: { message: 'hello' } }), isError('method'));
});

test('field bounds reject excessive data instead of silently truncating operational facts', () => {
  const maximum = buildWorldVoice({ templateId: 'custom', method: 'tellraw', values: { message: '\\'.repeat(WORLD_VOICE_LIMITS.custom) } });
  assert.ok(maximum.command.length <= WORLD_VOICE_LIMITS.command);
  assert.equal(decoded(maximum.command).rawtext[0].text.includes('\\'.repeat(WORLD_VOICE_LIMITS.custom)), true);
  assert.throws(() => buildWorldVoice({ templateId: 'custom', values: { message: 'x'.repeat(WORLD_VOICE_LIMITS.custom + 1) } }), isError('length', 'message'));
  assert.throws(() => buildWorldVoice({ values: { worldName: 'x'.repeat(WORLD_VOICE_LIMITS.name + 1) } }), isError('length', 'worldName'));
  assert.throws(() => buildWorldVoice({ values: { worldName: '§k\0  ' } }), isError('required', 'worldName'));
  assert.throws(() => buildWorldVoice({ values: { worldName: 42 } }), isError('text', 'worldName'));
  assert.throws(() => buildWorldVoice({ templateId: 'custom', values: { message: {} } }), isError('text', 'message'));
  assert.throws(() => buildWorldVoice({ templateId: 'custom', values: [] }), isError('values'));
  assert.throws(() => getWorldVoiceTemplate('not-a-template'), isError('template'));
  assert.throws(() => buildWorldVoice({ templateId: 'custom', values: { message: 'Hello', tone: '__proto__' } }), isError('choice', 'tone'));
});

test('validation messages are EN/VI and never echo untrusted field data', () => {
  const error = new WorldVoiceValidationError('length', 'message', 320);
  assert.equal(worldVoiceErrorText(error, 'en'), 'Message must be at most 320 characters.');
  assert.equal(worldVoiceErrorText(error, 'vi'), 'Thông điệp không được vượt quá 320 ký tự.');
  assert.ok(worldVoiceErrorText(new WorldVoiceValidationError('saySelector'), 'en').includes('tellraw'));
  assert.ok(worldVoiceErrorText({ code: '<script>', field: '<img>' }, 'vi').includes('không hợp lệ'));
});
