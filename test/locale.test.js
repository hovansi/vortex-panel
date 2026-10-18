import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { PANEL_MESSAGES } from '../server/locale-catalog.js';
import { negotiateLanguage, requestLanguage, translatePanelMessage, panelMessageMetadata, formatPanelMessage, localizeApiResponse, localizeWebSocketEvent } from '../server/locale.js';

test('language negotiation selects supported preferences and safely defaults to English', () => {
  for (const input of [undefined, '', '*', 'fr-FR,ja;q=0.8', 'vi;q=0', 'vi;q=abc', 'vi;q=2', 'vi;q=-1', 'vi;q=0.0000', 'vi;q=0,en;q=0', 'x'.repeat(8193)]) assert.equal(negotiateLanguage(input), 'en', String(input));
  assert.equal(negotiateLanguage('vi-VN, en;q=0.7'), 'vi');
  assert.equal(negotiateLanguage('vi;q=0.4,en-GB;q=0.9'), 'en');
  assert.equal(negotiateLanguage('en;q=0.5, vi;q=0.5'), 'en');
  assert.equal(negotiateLanguage('VI'), 'vi');
  assert.equal(requestLanguage({ url: '/ws?lang=vi', headers: { 'accept-language': 'en' } }), 'vi');
  assert.equal(requestLanguage({ url: '/ws?lang=unsupported', headers: { 'accept-language': 'vi' } }), 'en');
  assert.equal(requestLanguage({ url: '/api/servers/a/files/download?path=VI%2FEN.txt&lang=en', headers: { 'accept-language': 'vi' } }), 'en');
});

test('panel catalog has complete translations and keeps opaque template parameters unchanged', () => {
  assert.equal(new Set(PANEL_MESSAGES.map(message => message.id)).size, PANEL_MESSAGES.length);
  const slots = value => [...value.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
  for (const entry of PANEL_MESSAGES) {
    assert.ok(entry.en.trim(), entry.id);
    assert.deepEqual(slots(entry.en), slots(entry.vi), entry.id);
    const params = Array.from({ length: 8 }, (_, index) => `opaque_${index}_❤️_Vui lòng đăng nhập.`);
    const fill = value => value.replace(/\{(\d+)\}/g, (_match, index) => params[index]);
    const metadata = formatPanelMessage(entry.id, params);
    assert.equal(metadata.en, fill(entry.en), entry.id);
    assert.equal(metadata.vi, fill(entry.vi), entry.id);
    if (!entry.metadataOnly) assert.equal(translatePanelMessage(fill(entry.vi)), fill(entry.en), entry.id);
  }
  const name = 'Vui lòng đăng nhập. “server” <script> Đang xử lý ❤️';
  assert.equal(translatePanelMessage(`Cổng đang được server “${name}” sử dụng.`), `The port is already used by server “${name}”.`);
  const message = `Không thể lưu trạng thái panel: Không tìm thấy tệp.`;
  assert.equal(translatePanelMessage(message), 'Could not save the panel state: File not found.');
  assert.equal(translatePanelMessage(message, 'vi'), message);
  assert.equal(panelMessageMetadata(message).params[0], 'Không tìm thấy tệp.');
  const rollbackPath = 'Đang xử lý/❤️ original.txt';
  const rollback = `Đường dẫn không hợp lệ.; không thể hoàn tác ${rollbackPath}: Permission denied`;
  assert.equal(translatePanelMessage(rollback), `Invalid path.; could not roll back ${rollbackPath}: Permission denied`);
  const history = localizeApiResponse('/api/versions', { history: { error: 'Metadata phiên bản không phải JSON hợp lệ. · 3 mục metadata chưa đồng bộ; làm mới để thử lại.' } });
  assert.equal(history.history.error, 'The version metadata is not valid JSON. · 3 metadata entries have not synced. Refresh to try again.');
});

test('API schemas preserve names, paths, config values, file contents, pack metadata and native output', () => {
  const text = 'Vui lòng đăng nhập.';
  const filename = 'Đang xử lý <script>❤️.txt';
  const dashboard = { servers: [{ id: 'one', name: text, error: text }], jobs: [{ message: 'Đã đưa vào hàng đợi', serverId: 'one', name: text }], activity: [{ action: 'host.terminal', detail: text, user: text }, { action: 'auth.login', detail: 'Đăng nhập', user: text }, { action: 'server.command', detail: text, user: text }], host: { hostname: text } };
  const localized = localizeApiResponse('/api/dashboard', dashboard);
  assert.equal(localized.servers[0].name, text);
  assert.equal(localized.servers[0].error, 'Please sign in.');
  assert.equal(localized.jobs[0].message, 'Queued');
  assert.equal(localized.jobs[0].name, text);
  assert.equal(localized.activity[0].detail, text);
  assert.equal(localized.activity[0].user, text);
  assert.equal(localized.activity[1].detail, 'Signed in');
  assert.equal(localized.activity[1].user, text);
  assert.equal(localized.activity[2].detail, text);
  assert.equal(localized.host.hostname, text);
  assert.equal(dashboard.servers[0].error, text, 'serialization must not mutate canonical records');
  const file = { path: filename, content: text, revision: 'abc', protection: 'Tệp runtime được bảo vệ; hãy dùng công cụ cập nhật phiên bản.' };
  const fileResult = localizeApiResponse('/api/servers/one/file', file);
  assert.equal(fileResult.path, filename); assert.equal(fileResult.content, text); assert.equal(fileResult.revision, 'abc');
  assert.match(fileResult.protection, /^Runtime files are protected/);
  const configuration = { server: { name: text }, properties: { 'server-name': text, 'level-name': text, 'online-mode': 'false', transport: 'nethernet' }, network: { udpMode: 'custom', warnings: ['Dải UDP không hợp lệ.'] } };
  const configResult = localizeApiResponse('/api/servers/one/configuration', configuration);
  assert.deepEqual(configResult.properties, configuration.properties); assert.equal(configResult.network.udpMode, 'custom'); assert.equal(configResult.network.warnings[0], 'Invalid UDP range.');
  const pack = { name: text, description: 'Pack minh họa cho giao diện demo; không có nội dung Bedrock thật.', folder: filename, errors: ['Header UUID không hợp lệ.'] };
  const packResult = localizeApiResponse('/api/servers/one/packs', { packs: [pack], world: { name: text } });
  assert.equal(packResult.packs[0].name, text); assert.equal(packResult.packs[0].description, pack.description); assert.equal(packResult.packs[0].folder, filename); assert.equal(packResult.packs[0].errors[0], 'Invalid header UUID.'); assert.equal(packResult.world.name, text);
  assert.equal(translatePanelMessage(`Module ${text} chưa được hỗ trợ; chỉ hỗ trợ data/resources, không cài Script API.`), `Module ${text} is unsupported. Only data/resources modules are supported; Script API is not installed.`);
  assert.equal(translatePanelMessage('Module (thiếu type) chưa được hỗ trợ; chỉ hỗ trợ data/resources, không cài Script API.'), 'Module (thiếu type) is unsupported. Only data/resources modules are supported; Script API is not installed.');
  const output = { stdout: text, stderr: 'Đang xử lý', exitCode: 0 };
  assert.deepEqual(localizeApiResponse('/api/host/terminal', output), output);
  assert.deepEqual(localizeApiResponse('/api/auth/status', { user: { username: text }, csrfToken: text }), { user: { username: text }, csrfToken: text });
  for (const source of [undefined, 'native', 'command']) {
    const record = { time: '2026-10-14', level: 'info', message: text, ...(source ? { source } : {}) };
    const event = { type: 'log', serverId: 'one', log: record };
    assert.deepEqual(localizeWebSocketEvent(event), event);
    assert.deepEqual(localizeApiResponse('/api/servers/one/logs', { logs: [record] }).logs, [record]);
  }
  const panelEvent = localizeWebSocketEvent({ type: 'log', serverId: 'one', log: { source: 'panel', message: text } });
  assert.equal(panelEvent.log.message, 'Please sign in.'); assert.equal(panelEvent.log.messageI18n.vi, text);
});

test('generated audit metadata translates only its app phrase, preserving names and raw commands', () => {
  const name = 'Đăng nhập: <script> ❤️';
  const detailI18n = { id: 'panel.audit.schedule.automatic', params: [name, 'backup'] };
  const original = { action: 'schedule.run', detail: `${name}: backup (tự động)`, detailI18n, user: 'Đang xử lý' };
  const result = localizeApiResponse('/api/activity', { activity: [original, { action: 'schedule.run', detail: original.detail, user: original.user }] });
  assert.equal(result.activity[0].detail, `${name}: backup (automatic)`);
  assert.equal(result.activity[0].user, original.user);
  assert.equal(result.activity[1].detail, original.detail, 'unmarked historical details are opaque');
  const failed = { action: 'install.failed', detail: `${name}: Không tìm thấy tệp.`, detailI18n: { id: 'panel.audit.operation.failed', params: [name, 'Không tìm thấy tệp.'] } };
  assert.equal(localizeApiResponse('/api/activity', { activity: [failed] }).activity[0].detail, `${name}: File not found.`);
});

test('real HTTP requests and simultaneous WebSockets keep independent locales without changing authentication', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-locale-'));
  const runtime = await createApp({ dataDir, demo: true });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runtime.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const initial = await fetch(`${origin}/api/dashboard`);
  assert.equal(initial.status, 401); assert.equal(initial.headers.get('content-language'), 'en'); assert.match(initial.headers.get('vary'), /Accept-Language/i); assert.equal((await initial.json()).error, 'Please sign in.');
  const viAnonymous = await fetch(`${origin}/api/dashboard`, { headers: { 'Accept-Language': 'vi' } });
  assert.equal(viAnonymous.status, 401); assert.equal((await viAnonymous.json()).error, 'Vui lòng đăng nhập.');
  const authResponse = await fetch(`${origin}/api/auth/status`); const auth = await authResponse.json();
  const cookie = authResponse.headers.get('set-cookie').split(';')[0];
  const baseHeaders = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': auth.csrfToken, 'Content-Type': 'application/json' };
  async function request(route, locale, method = 'GET', body) {
    const response = await fetch(`${origin}/api${route}`, { method, headers: { ...baseHeaders, ...(locale ? { 'Accept-Language': locale } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, locale: response.headers.get('content-language'), data: await response.json() };
  }
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request('/servers/missing', index % 2 ? 'vi' : 'en')));
  results.forEach((result, index) => { assert.equal(result.status, 404); assert.equal(result.locale, index % 2 ? 'vi' : 'en'); assert.equal(result.data.error, index % 2 ? 'Không tìm thấy server.' : 'Server not found.'); assert.equal(result.data.errorI18n.en, 'Server not found.'); });
  assert.equal((await request('/servers/missing', 'ja')).data.error, 'Server not found.');
  assert.equal((await request('/servers/missing?lang=vi', 'en')).data.error, 'Không tìm thấy server.');
  const server = runtime.manager.listServers().find(record => record.status === 'running');
  const name = 'Vui lòng đăng nhập. <script> ❤️';
  assert.equal((await request(`/servers/${server.id}`, 'en', 'PATCH', { name })).data.server.name, name);
  const config = await request(`/servers/${server.id}/configuration`, 'en');
  assert.equal(config.data.properties['level-name'], 'Bedrock level'); assert.equal(config.data.server.name, name);
  const sockets = [];
  async function connect(locale) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + `/ws?lang=${locale}`, { headers: { Cookie: cookie, Origin: origin, 'Accept-Language': locale === 'en' ? 'vi' : 'en' } });
    const messages = []; ws.on('message', value => messages.push(JSON.parse(value.toString())));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    sockets.push(ws); return messages;
  }
  t.after(() => sockets.forEach(ws => ws.terminate()));
  const enMessages = await connect('en'), viMessages = await connect('vi'), fallbackMessages = await connect('unsupported');
  assert.equal((await request(`/servers/${server.id}/command`, 'vi', 'POST', { command: 'list Vui lòng đăng nhập.' })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 35));
  const command = '> list Vui lòng đăng nhập.';
  for (const messages of [enMessages, viMessages, fallbackMessages]) assert.ok(messages.some(message => message.type === 'log' && message.log.source === 'command' && message.log.message === command));
  assert.ok(enMessages.some(message => message.log?.message === 'DEMO · The command was recorded; no real Bedrock process is running.'));
  assert.ok(viMessages.some(message => message.log?.message === 'DEMO · Lệnh được ghi nhận; không có tiến trình Bedrock thật.'));
  assert.ok(fallbackMessages.some(message => message.log?.message === 'DEMO · The command was recorded; no real Bedrock process is running.'));
  const logs = await request(`/servers/${server.id}/logs`, 'en');
  assert.ok(logs.data.logs.some(record => record.source === 'command' && record.message === command));
  assert.ok(runtime.manager.logs(server.id).some(record => record.source === 'panel' && record.message === 'DEMO · Lệnh được ghi nhận; không có tiến trình Bedrock thật.'));
  const rejected = new WebSocket(origin.replace('http:', 'ws:') + '/ws?lang=vi', { headers: { Cookie: cookie, Origin: 'https://untrusted.example' } });
  const status = await new Promise(resolve => { rejected.once('unexpected-response', (_req, response) => { const code = response.statusCode; response.destroy(); resolve(code); }); rejected.once('error', () => {}); });
  assert.equal(status, 401);
});
