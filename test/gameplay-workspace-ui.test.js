import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_RULES } from '../server/gameplay.js';

// A deliberately small DOM adapter executes the real module event handlers.
// It does not claim visual/browser acceptance or start a Minecraft process.
class Slot {
  constructor() { this.dataset = {}; this.attributes = []; this.textContent = ''; this.innerHTML = ''; this.isConnected = true; this.listeners = new Map(); this.attrs = new Map(); this.nodeType = 0; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  async emit(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
}
const languageDocument = { documentElement: { lang: '' }, addEventListener() {}, dispatchEvent() {}, querySelectorAll() { return []; }, createTreeWalker() { return { nextNode() { return false; } }; } };
globalThis.document = languageDocument;
globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.NodeFilter = { SHOW_TEXT: 4 };
globalThis.HTMLDialogElement = class {};
globalThis.HTMLTemplateElement = class {};
const { gameplayMarkup, bindGameplay, worldRuleResultMarkup } = await import('../public/gameplay-workspace.js');
const { plainUI, setLanguage } = await import('../public/i18n.js');
const worldRevision = 'c'.repeat(64);
const rule = (key, value = null, status = 'not-queried') => ({ ...GAME_RULES.find(item => item.key === key), value, status });
const context = { icon: name => `<svg data-icon="${name}"></svg>`, canManage: () => true };
function fixture({ available = true, canManage = true, api = async () => { throw Error('Unexpected API call'); }, panelConfirm = async () => true } = {}) {
  const data = { server: { id: 'worker:world' }, available, busy: false, cheatsEnabled: false, world: { name: 'My <world>', revision: worldRevision }, rules: [rule('showcoordinates', false, 'confirmed'), rule('showdaysplayed'), rule('keepinventory', false, 'confirmed'), rule('pvp', true, 'confirmed')] };
  const panel = new Slot(), form = new Slot(), submit = new Slot(), error = new Slot(), state = new Slot(), draft = new Slot(), results = new Slot();
  const rows = new Map(), inputs = new Map(), queries = ['all', 'display', 'survival'].map(id => { const button = new Slot(); button.dataset.gameplayQuery = id; return button; });
  for (const spec of data.rules) {
    const row = new Slot(), status = new Slot(), feedback = new Slot(), input = new Slot(); input.checked = spec.value === true; input.value = spec.value ?? '';
    row.querySelector = selector => ({ '[data-rule-status]': status, '[data-rule-feedback]': feedback })[selector] ?? null; row.status = status; row.feedback = feedback; rows.set(spec.key, row); inputs.set(spec.key, input);
  }
  form.elements = { namedItem: key => inputs.get(key) };
  form.querySelector = selector => ({ '[type=submit]': submit, '[data-gameplay-error]': error, '[data-rule-draft]': draft, '[data-gameplay-results]': results })[selector] ?? rows.get(/^\[data-rule="([^"]+)"\]$/.exec(selector)?.[1]) ?? null;
  panel.querySelector = selector => ({ '[data-gamerule-form]': form, '[data-gameplay-state]': state })[selector] ?? null;
  panel.querySelectorAll = selector => selector === '[data-gameplay-query]' ? queries : [];
  const requests = [], confirmations = [], ctx = { ...context, canManage: () => canManage, api: async (path, options) => { requests.push({ path, ...structuredClone(options) }); return api(path, options); }, panelConfirm: async value => { confirmations.push(value); return panelConfirm(value); } };
  bindGameplay({ querySelector: () => panel }, data, ctx);
  return { data, panel, form, submit, error, state, draft, results, rows, inputs, queries, requests, confirmations };
}

test('world markup prominently exposes coordinates once, groups verified controls and explains world persistence in EN/VI', () => {
  const data = { server: { id: 'world' }, available: true, world: { name: '<script>world</script>' }, rules: GAME_RULES.map(spec => ({ ...spec, value: null, status: 'not-queried' })) };
  const markup = gameplayMarkup(data, context);
  for (const [language, phrase] of [['en', 'Show coordinates'], ['vi', 'Hiện tọa độ']]) {
    setLanguage(language); const html = plainUI(markup);
    assert.ok(html.includes(phrase)); assert.equal((html.match(/data-rule="showcoordinates"/g) || []).length, 1);
    assert.equal((html.match(/data-rule-group="/g) || []).length, 6); assert.equal((html.match(/class="gamerule-row /g) || []).length, GAME_RULES.length);
    assert.match(html, /gamerule-featured[^]*data-rule="showcoordinates"/); assert.match(html, /server\.properties/); assert.match(html, /backup/);
    assert.match(html, /&lt;script&gt;world&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
    for (const name of ['showcoordinates', 'showdaysplayed', 'doimmediaterespawn', 'freezedamage']) assert.match(html, new RegExp(`name="${name}"[^>]*disabled`));
  }
  setLanguage('en'); assert.match(plainUI(markup), /No values guessed/); assert.match(plainUI(markup), /world’s values automatically/);
});

test('native unknown values stay indeterminate and locked; stopped/read-only contexts cannot issue manually triggered operations', async () => {
  for (const options of [{ available: false }, { canManage: false }]) {
    const f = fixture(options); assert.equal(f.inputs.get('showdaysplayed').indeterminate, true);
    assert.ok([...f.inputs.values()].every(input => input.disabled)); assert.ok(f.queries.every(button => button.disabled));
    f.inputs.get('showcoordinates').checked = true; await f.form.emit('change'); await f.queries[0].emit('click'); await f.form.emit('submit'); assert.equal(f.requests.length, 0);
  }
});

test('reading one group sends only its keys, shows rejected engine feedback and preserves another group’s draft', async () => {
  const f = fixture({ api: async () => ({ world: { name: 'My world', revision: worldRevision }, rules: [{ key: 'showcoordinates', value: true, status: 'confirmed', nativeFeedback: 'showcoordinates = true' }, { key: 'showdaysplayed', value: null, status: 'rejected', nativeFeedback: 'Syntax error: <unsupported>' }], confirmed: false }) });
  f.inputs.get('keepinventory').checked = true; await f.form.emit('change'); await f.queries[1].emit('click');
  assert.deepEqual(f.requests[0], { path: '/servers/worker%3Aworld/gamerules/query', method: 'POST', body: { worldRevision, keys: ['showcoordinates', 'showdaysplayed'] } });
  assert.equal(f.confirmations.length, 0); assert.equal(f.inputs.get('keepinventory').checked, true); assert.equal(f.inputs.get('showcoordinates').checked, true);
  assert.equal(f.inputs.get('showdaysplayed').disabled, true); assert.equal(f.inputs.get('showdaysplayed').indeterminate, true);
  assert.match(plainUI(f.rows.get('showdaysplayed').status.textContent), /Rejected by engine/); assert.match(plainUI(f.rows.get('showdaysplayed').feedback.innerHTML), /&lt;unsupported&gt;/);
  assert.match(plainUI(f.draft.textContent), /1 unsaved changes/); assert.equal(f.form.dataset.dirty, 'true'); assert.equal(f.submit.disabled, false);
});

test('overlapping group reread asks before replacing drafts and a canceled prompt sends nothing', async () => {
  const f = fixture({ panelConfirm: async () => false }); f.inputs.get('showcoordinates').checked = true; await f.form.emit('change'); await f.queries[1].emit('click');
  assert.equal(f.confirmations.length, 1); assert.equal(f.requests.length, 0); assert.equal(f.inputs.get('showcoordinates').checked, true); assert.equal(f.form.dataset.dirty, 'true');
});

test('a fresh confirmed query replaces a previous rejection instead of retaining its stale error evidence', async () => {
  let calls = 0;
  const f = fixture({ api: async () => ({ confirmed: ++calls > 1, rules: calls === 1 ? [{ key: 'showdaysplayed', value: null, status: 'rejected', message: 'Unsupported on earlier read', nativeFeedback: 'Unknown game rule showdaysplayed' }] : [{ key: 'showdaysplayed', value: true, status: 'confirmed', nativeFeedback: 'showdaysplayed = true' }] }) });
  await f.queries[1].emit('click'); assert.match(plainUI(f.rows.get('showdaysplayed').feedback.innerHTML), /Unsupported on earlier read/);
  await f.queries[1].emit('click'); assert.equal(f.inputs.get('showdaysplayed').disabled, false); assert.equal(f.inputs.get('showdaysplayed').indeterminate, false);
  const evidence = plainUI(f.rows.get('showdaysplayed').feedback.innerHTML); assert.match(evidence, /showdaysplayed = true/); assert.doesNotMatch(evidence, /Unsupported|Unknown game rule/);
});

test('actual submit emits expected values and separates confirmed, rejected and genuinely unsent drafts without replay', async () => {
  const f = fixture({ api: async () => ({ allConfirmed: false, results: [
    { key: 'showcoordinates', requested: true, value: true, status: 'confirmed', acceptedToConsole: true, confirmedApplied: true, nativeFeedback: 'showcoordinates = true' },
    { key: 'keepinventory', requested: true, status: 'rejected', acceptedToConsole: true, confirmedApplied: false, nativeFeedback: 'Invalid game rule keepinventory' },
    { key: 'pvp', requested: false, status: 'not-sent', acceptedToConsole: false, confirmedApplied: false }
  ] }) });
  f.inputs.get('showcoordinates').checked = true; f.inputs.get('keepinventory').checked = true; f.inputs.get('pvp').checked = false; await f.form.emit('change'); await f.form.emit('submit');
  assert.deepEqual(f.requests[0], { path: '/servers/worker%3Aworld/gamerules', method: 'PATCH', body: { worldRevision, changes: { showcoordinates: true, keepinventory: true, pvp: false }, expected: { showcoordinates: false, keepinventory: false, pvp: true } } });
  assert.equal(f.requests.length, 1); assert.equal(f.inputs.get('showcoordinates').disabled, false); assert.equal(f.rows.get('showcoordinates').dataset.ruleState, 'confirmed');
  assert.equal(f.inputs.get('keepinventory').disabled, true); assert.equal(f.rows.get('keepinventory').dataset.ruleState, 'rejected');
  assert.equal(f.inputs.get('pvp').checked, false); assert.equal(f.inputs.get('pvp').disabled, false); assert.equal(f.rows.get('pvp').dataset.ruleState, 'draft');
  const html = plainUI(f.results.innerHTML); for (const state of ['confirmed', 'rejected', 'not-sent']) assert.match(html, new RegExp(`data-rule-outcome="${state}"`));
  assert.match(html, /Invalid game rule keepinventory/); assert.match(html, /draft retained/); assert.match(plainUI(f.draft.textContent), /1 unsaved changes/);
});

test('in-flight rule reads serialize controls, show busy state and never repaint a detached workspace', async () => {
  let resolve; const pending = new Promise(yes => { resolve = yes; }); const f = fixture({ api: async () => pending });
  const run = f.queries[1].emit('click'); assert.equal(f.queries[1].getAttribute('aria-busy'), 'true'); assert.ok(f.queries.every(button => button.disabled));
  await f.queries[0].emit('click'); assert.equal(f.requests.length, 1); f.panel.isConnected = false;
  resolve({ rules: [{ key: 'showcoordinates', value: true, status: 'confirmed' }], confirmed: true }); await run;
  assert.equal(f.inputs.get('showcoordinates').checked, false); assert.equal(f.queries[1].getAttribute('aria-busy'), null);
});

test('outcome renderer never promotes a receipt or an inconsistent confirmation and escapes opaque feedback', () => {
  for (const response of [{ status: 'unconfirmed', acceptedToConsole: true }, { status: 'confirmed', confirmedApplied: false }, { status: 'unconfirmed', confirmedApplied: true }, { status: 'not-sent', acceptedToConsole: true }]) {
    const html = plainUI(worldRuleResultMarkup({ ...response, requested: true, nativeFeedback: '<img src=x onerror=bad>' }, rule('showcoordinates')));
    assert.match(html, /data-rule-outcome="unconfirmed"/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|Applied &amp; read back/); assert.match(html, /No automatic retries/);
  }
});
