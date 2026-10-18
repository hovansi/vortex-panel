import { PANEL_MESSAGES } from './locale-catalog.js';
import { nodeErrorPayload } from './node-messages.js';

export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'vi']);
const byId = new Map(PANEL_MESSAGES.map(entry => [entry.id, entry]));
const exact = new Map(PANEL_MESSAGES.filter(entry => !entry.metadataOnly && !/\{\d+\}/.test(entry.vi)).map(entry => [entry.vi, entry]));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = PANEL_MESSAGES.filter(entry => !entry.metadataOnly && /\{\d+\}/.test(entry.vi)).map(entry => {
  const slots = [];
  let position = 0, expression = '^';
  for (const match of entry.vi.matchAll(/\{(\d+)\}/g)) {
    expression += escape(entry.vi.slice(position, match.index)) + '([\\s\\S]*?)';
    position = match.index + match[0].length;
    slots.push(Number(match[1]));
  }
  expression += escape(entry.vi.slice(position)) + '$';
  return { entry, slots, pattern: new RegExp(expression), specificity: entry.vi.replace(/\{\d+\}/g, '').length };
}).sort((a, b) => b.specificity - a.specificity);

// Language is selected for each request/connection, never from process-global state.
// An explicit unsupported choice falls back to English instead of inheriting a
// browser language; language negotiation does not change any access decision.
export function language(value) {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value.toLowerCase()) ? value.toLowerCase() : DEFAULT_LANGUAGE;
}
export function negotiateLanguage(header) {
  if (typeof header !== 'string' || header.length > 8192) return DEFAULT_LANGUAGE;
  const choices = header.split(',').slice(0, 32).map((item, order) => {
    const [tag, ...options] = item.trim().split(';');
    const quality = options.find(option => /^\s*q\s*=/i.test(option));
    const match = quality?.match(/^\s*q\s*=\s*(0(?:\.\d{1,3})?|1(?:\.0{1,3})?)\s*$/i);
    const q = quality ? match ? Number(match[1]) : 0 : 1;
    const normalized = /^[a-z]{2}(?:-[a-z0-9]{2,8})*$/i.test(tag) ? tag.split('-')[0].toLowerCase() : '';
    return { language: normalized, q, order };
  }).filter(item => item.q > 0 && SUPPORTED_LANGUAGES.includes(item.language)).sort((a, b) => b.q - a.q || a.order - b.order);
  return choices[0]?.language || DEFAULT_LANGUAGE;
}
export function requestLanguage(req) {
  // Download links cannot set Accept-Language themselves. Their explicit lang
  // parameter is restricted to the two supported identifiers.
  try {
    const query = new URL(req.originalUrl || req.url, 'http://localhost').searchParams;
    if (query.has('lang')) return language(query.get('lang'));
  } catch {}
  return negotiateLanguage(req.headers?.['accept-language']);
}

function matchMessage(message) {
  if (typeof message !== 'string' || message.length > 32768) return null;
  if (exact.has(message)) return { entry: exact.get(message), params: [] };
  for (const item of patterns) {
    const match = item.pattern.exec(message);
    if (!match) continue;
    const params = [];
    item.slots.forEach((slot, index) => { params[slot] = match[index + 1]; });
    return { entry: item.entry, params };
  }
  return null;
}
function render(entry, params, locale, depth = 0) {
  return entry[locale].replace(/\{(\d+)\}/g, (_placeholder, index) => {
    const value = String(params[index] ?? '');
    // Only parameters explicitly known to be generated error/phrase messages
    // are translated. Names, file paths, UUIDs, versions, ports and keys are opaque.
    return depth < 5 && entry.nested?.includes(Number(index)) ? translatePanelMessage(value, locale, depth + 1) : value;
  });
}
export function translatePanelMessage(message, locale = DEFAULT_LANGUAGE, depth = 0) {
  if (typeof message !== 'string') return message;
  locale = language(locale);
  if (locale === 'vi') return message;
  const matched = matchMessage(message);
  if (matched) return render(matched.entry, matched.params, locale, depth);
  // Rollback failures are appended to a canonical panel/system error. Each
  // known suffix has a fixed boundary; the path/error parameters stay intact.
  if (depth < 5) for (const entry of PANEL_MESSAGES.filter(value => value.fragment && value.vi.startsWith('; '))) {
    const boundary = entry.vi.split('{')[0], position = message.indexOf(boundary);
    if (position < 0) continue;
    const suffix = matchMessage(message.slice(position));
    if (suffix?.entry.id === entry.id) return translatePanelMessage(message.slice(0, position), locale, depth + 1) + render(entry, suffix.params, locale, depth + 1);
  }
  return message;
}
export function panelMessageMetadata(message) {
  const matched = matchMessage(message);
  if (matched) return { id: matched.entry.id, params: matched.params, en: render(matched.entry, matched.params, 'en'), vi: message };
  const en = translatePanelMessage(message, 'en');
  return en !== message ? { id: 'panel.composite', params: [], en, vi: message } : null;
}
export function formatPanelMessage(id, params = []) {
  const entry = byId.get(id);
  if (!entry || !Array.isArray(params)) return null;
  return { id, params: [...params], en: render(entry, params, 'en'), vi: render(entry, params, 'vi') };
}

function field(record, key, locale) {
  if (!record || typeof record[key] !== 'string') return record;
  const metadata = panelMessageMetadata(record[key]);
  return metadata ? { ...record, [key]: metadata[locale], [`${key}I18n`]: metadata } : record;
}
function joinedErrors(record, key, locale) {
  if (!record || typeof record[key] !== 'string') return record;
  // The version-history aggregator alone joins independent source errors with
  // this separator. It is not applied to names, paths or general user strings.
  const segments = record[key].split(' · ');
  if (segments.length < 2) return field(record, key, locale);
  const metadata = segments.map(panelMessageMetadata);
  if (!metadata.some(Boolean)) return record;
  const combined = { id: 'panel.history.errors', params: segments, en: segments.map((value, index) => metadata[index]?.en ?? value).join(' · '), vi: record[key] };
  return { ...record, [key]: combined[locale], [`${key}I18n`]: combined };
}
function messages(record, key, locale) {
  if (!record || !Array.isArray(record[key])) return record;
  const metadata = record[key].map(panelMessageMetadata);
  if (!metadata.some(Boolean)) return record;
  return { ...record, [key]: record[key].map((value, index) => metadata[index]?.[locale] ?? value), [`${key}I18n`]: metadata };
}
function notice(record, locale) { return messages(field(record, 'error', locale), 'warnings', locale); }
function resources(record, locale) { return record ? { ...record, ...(record.effective ? { effective: notice(record.effective, locale) } : {}) } : record; }
function server(record, locale) { const value = field(record, 'error', locale); return value?.resources ? { ...value, resources: resources(value.resources, locale) } : value; }
function world(record, locale) { return notice(record, locale); }
function backup(record, locale) {
  const localized = notice(record, locale);
  return localized?.integrity ? { ...localized, integrity: field(field(localized.integrity, 'error', locale), 'message', locale) } : localized;
}
function job(record, locale) {
  let localized = messages(field(field(record, 'message', locale), 'error', locale), 'warnings', locale);
  if (Array.isArray(record?.phaseHistory)) localized = { ...localized, phaseHistory: record.phaseHistory.slice(-16).map(row => field(row, 'message', locale)) };
  if (record?.type === 'node-provision' && record.messageI18n?.id?.startsWith('panel.node-provision.') && typeof record.messageI18n[locale] === 'string') localized = { ...localized, message: record.messageI18n[locale] };
  if (/^panel\.(?:capacity|storage|application)\./.test(record?.messageI18n?.id || '')) {
    const metadata = formatPanelMessage(record.messageI18n.id, record.messageI18n.params);
    if (metadata) localized = { ...localized, message: metadata[locale], messageI18n: metadata };
  }
  // A job result may contain world names, seeds and backup hashes. Translate
  // only known generated notices, never the user-controlled metadata payload.
  if (localized?.result && typeof localized.result === 'object') {
    const result = { ...localized.result };
    if (result.world) result.world = world(result.world, locale);
    if (result.backup) result.backup = backup(result.backup, locale);
    localized = { ...localized, result };
  }
  return localized;
}
function schedule(record, locale) { return field(record, 'error', locale); }
function version(record, locale) { return field(field(record, 'verificationError', locale), 'metadataError', locale); }
function versions(record, locale) {
  if (!record || typeof record !== 'object') return record;
  let localized = field(record, 'error', locale);
  if (Array.isArray(record.versions)) localized = { ...localized, versions: record.versions.map(value => version(value, locale)) };
  if (record.history) {
    let history = joinedErrors(record.history, 'error', locale);
    if (Array.isArray(history.sources)) history = { ...history, sources: history.sources.map(value => field(value, 'error', locale)) };
    localized = { ...localized, history };
  }
  return localized;
}
const authDetails = Object.freeze({
  'auth.setup': 'Tạo tài khoản quản trị',
  'auth.login': 'Đăng nhập', 'auth.mfa.login': 'Đăng nhập với xác thực hai bước',
  'auth.password': 'Đổi mật khẩu', 'auth.mfa.enable': 'Bật xác thực hai bước',
  'auth.mfa.disable': 'Tắt xác thực hai bước', 'auth.mfa.recovery': 'Tạo lại mã khôi phục',
});
function activity(record, locale) {
  // Audit detail can contain a complete user-entered shell/game command or a
  // filename. It is never translated through a generic message lookup.
  if (record?.detailI18n?.id) {
    const metadata = formatPanelMessage(record.detailI18n.id, record.detailI18n.params);
    if (metadata) return { ...record, detail: metadata[locale], detailI18n: metadata };
  }
  if (authDetails[record?.action] === record?.detail) return field(record, 'detail', locale);
  return record;
}
export function localizePanelLog(record, locale) {
  // Unmarked historical records and native Bedrock lines are intentionally
  // opaque, even when their text happens to equal a panel catalog message.
  return record?.source === 'panel' ? field(record, 'message', locale) : record;
}
function packs(record, locale) {
  if (!record || typeof record !== 'object') return record;
  let localized = messages(record, 'errors', locale);
  if (record.generatedName === true) localized = field(localized, 'name', locale);
  return localized;
}
function gameplayCatalog(record, locale) {
  const value = { ...record };
  for (const key of ['label', 'description']) if (record[key] && typeof record[key].en === 'string' && typeof record[key].vi === 'string') { value[key] = record[key][locale]; value[`${key}I18n`] = record[key]; }
  if (Array.isArray(record.fields)) value.fields = record.fields.map(item => gameplayCatalog(item, locale));
  return field(value, 'message', locale);
}
function nodeMetadata(record, locale) {
  let value = { ...record };
  if (record.capabilities?.resourceControl) value.capabilities = { ...record.capabilities, resourceControl: field(record.capabilities.resourceControl, 'reason', locale) };
  if (record.error) value = { ...value, ...(nodeErrorPayload(record.error, locale) || {}) };
  return value;
}

// Explicit response schemas. Do not recurse over arbitrary JSON: configuration,
// file text, manifest names/descriptions, usernames, native logs and stdout/stderr
// may contain text identical to the catalog and must retain their original bytes.
export function localizeApiResponse(requestPath, body, locale = DEFAULT_LANGUAGE) {
  locale = language(locale);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let result = notice(body, locale);
  const serverRoute = /^\/api\/servers(?:\/|$)/.test(requestPath);
  const dashboard = requestPath === '/api/dashboard';
  const nodesRoute = /^\/api\/nodes(?:\/|$)/.test(requestPath);
  if ((dashboard || nodesRoute) && Array.isArray(body.nodes)) result = { ...result, nodes: body.nodes.map(value => nodeMetadata(value, locale)) };
  if (nodesRoute && body.node) result = { ...result, node: nodeMetadata(body.node, locale) };
  if ((dashboard || serverRoute) && Array.isArray(body.servers)) result = { ...result, servers: body.servers.map(value => server(value, locale)) };
  if (dashboard && body.capabilities?.resourceControl) result = { ...result, capabilities: { ...body.capabilities, resourceControl: field(body.capabilities.resourceControl, 'reason', locale) } };
  if (serverRoute && body.server) result = { ...result, server: server(body.server, locale) };
  if ((dashboard || requestPath === '/api/jobs' || nodesRoute) && Array.isArray(body.jobs)) result = { ...result, jobs: body.jobs.map(value => job(value, locale)) };
  if ((serverRoute || nodesRoute || /^\/api\/(?:schedules|jobs)(?:\/|$)/.test(requestPath)) && body.job) result = { ...result, job: job(body.job, locale) };
  if (/^\/api\/schedules(?:\/|$)/.test(requestPath)) {
    if (Array.isArray(body.schedules)) result = { ...result, schedules: body.schedules.map(value => schedule(value, locale)) };
    if (body.schedule) result = { ...result, schedule: schedule(body.schedule, locale) };
  }
  if ((dashboard || requestPath === '/api/activity' || /^\/api\/servers\/[^/]+\/activity\/?$/.test(requestPath)) && Array.isArray(body.activity)) result = { ...result, activity: body.activity.map(value => activity(value, locale)) };
  if (dashboard && body.versions) result = { ...result, versions: versions(body.versions, locale) };
  if (/^\/api\/(?:versions(?:\/|$)|nodes\/[^/]+\/versions(?:\/|$)|servers\/[^/]+\/versions(?:\/|$))/.test(requestPath)) {
    result = versions(result, locale);
    if (body.version) result = { ...result, version: version(body.version, locale) };
  }
  if (/^\/api\/servers\/[^/]+\/logs\/?$/.test(requestPath) && Array.isArray(body.logs)) result = { ...result, logs: body.logs.map(value => localizePanelLog(value, locale)) };
  if (/^\/api\/servers\/[^/]+\/(?:files|file)\/?$/.test(requestPath)) {
    result = field(result, 'protection', locale);
    if (Array.isArray(body.files)) result = { ...result, files: body.files.map(value => field(value, 'protection', locale)) };
  }
  if (/^\/api\/servers\/[^/]+\/configuration\/?$/.test(requestPath) && body.network) result = { ...result, network: messages(body.network, 'warnings', locale) };
  if (/^\/api\/servers\/[^/]+\/network-access\/?$/.test(requestPath)) {
    if (typeof body.messageI18n?.[locale] === 'string') result = { ...result, message: body.messageI18n[locale] };
    for (const key of ['warnings', 'errors']) if (Array.isArray(body[key])) result = { ...result, [key]: body[key].map((value, index) => typeof body[`${key}I18n`]?.[index]?.[locale] === 'string' ? body[`${key}I18n`][index][locale] : value) };
    for (const key of ['ports', 'managedRules', 'obsoleteRules', 'added', 'removed']) if (Array.isArray(body[key])) result = { ...result, [key]: body[key].map(value => typeof value?.purposeI18n?.[locale] === 'string' ? { ...value, purpose: value.purposeI18n[locale] } : value) };
  }
  if (/^\/api\/(?:nodes\/[^/]+|node)\/hostname\/?$/.test(requestPath)) {
    if (body.hostname?.reasonI18n?.[locale]) result = { ...result, hostname: { ...body.hostname, reason: body.hostname.reasonI18n[locale] } };
    if (Array.isArray(body.warnings)) result = { ...result, warnings: body.warnings.map((value, index) => body.warningsI18n?.[index]?.[locale] || value) };
  }
  if (serverRoute && body.resourceControl) result = { ...result, resourceControl: field(body.resourceControl, 'reason', locale) };
  if (serverRoute && body.resources) result = { ...result, resources: resources(body.resources, locale) };
  if (/^\/api\/servers\/[^/]+\/(?:gameplay|gamerules(?:\/query)?|player-actions)\/?$/.test(requestPath)) {
    result = field(field(result, 'reason', locale), 'message', locale);
    if (Array.isArray(body.rules)) result = { ...result, rules: body.rules.map(value => gameplayCatalog(value, locale)) };
    if (Array.isArray(body.actions)) result = { ...result, actions: body.actions.map(value => gameplayCatalog(value, locale)) };
    if (Array.isArray(body.itemCatalog)) result = { ...result, itemCatalog: body.itemCatalog.map(value => gameplayCatalog(value, locale)) };
    if (Array.isArray(body.results)) result = { ...result, results: body.results.map(value => field(value, 'message', locale)) };
  }
  if (/^\/api\/servers\/[^/]+\/worlds(?:\/|$)/.test(requestPath)) {
    if (Array.isArray(body.worlds)) result = { ...result, worlds: body.worlds.map(value => world(value, locale)) };
    if (body.world) result = { ...result, world: world(body.world, locale) };
    if (body.configuration?.network) result = { ...result, configuration: { ...body.configuration, network: messages(body.configuration.network, 'warnings', locale) } };
  }
  if (/^\/api\/servers\/[^/]+\/backups(?:\/|$)/.test(requestPath)) {
    if (Array.isArray(body.backups)) result = { ...result, backups: body.backups.map(value => backup(value, locale)) };
    if (body.backup) result = { ...result, backup: backup(body.backup, locale) };
  }
  if (/^\/api\/servers\/[^/]+\/packs(?:\/|$)/.test(requestPath)) {
    if (Array.isArray(body.packs)) result = { ...result, packs: body.packs.map(value => packs(value, locale)) };
    if (body.pack) result = { ...result, pack: packs(body.pack, locale) };
  }
  if (requestPath === '/api/host/diagnostics' && Array.isArray(body.checks)) result = { ...result, checks: body.checks.map(value => field(field(value, 'name', locale), 'message', locale)) };
  return result;
}
export function localizeWebSocketEvent(event, locale = DEFAULT_LANGUAGE) {
  return event?.type === 'log' && event.log ? { ...event, log: localizePanelLog(event.log, language(locale)) } : event;
}
export function localeMiddleware(req, res, next) {
  const requestPath = req.path;
  if (!requestPath.startsWith('/api')) return next();
  const locale = requestLanguage(req);
  req.panelLanguage = locale;
  res.set('Content-Language', locale);
  res.vary('Accept-Language');
  const json = res.json;
  res.json = function (body) { return json.call(this, localizeApiResponse(requestPath, body, locale)); };
  next();
}
