import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const priorDocument = globalThis.document;
globalThis.document = { documentElement: { lang: '' }, addEventListener() {}, querySelectorAll() { return []; } };
let applicationModule;
try { applicationModule = await import('../public/application-workspace.js'); }
finally { if (priorDocument) globalThis.document = priorDocument; else delete globalThis.document; }
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const oldServer = { id: 'foreign-survival', name: 'Survival', kind: 'bedrock', status: 'running', version: '1.26.52.3', nodeId: 'worker' };
const newServer = { id: 'owned-new-app', name: 'New app', kind: 'nodejs', status: 'stopped', version: 'v22.23.3', nodeId: 'local' };

function harness() {
  const root = { innerHTML: '', classList: { add() {}, remove() {} }, setAttribute() {}, querySelector: () => null, contains: element => Boolean(element?.inWorkspace) };
  const results = { markup: '', contains: element => Boolean(element?.inResults) }, count = { text: '' };
  const dialogs = Object.fromEntries(['modal', 'palette', 'drawer', 'confirmation', 'server-picker'].map(id => ['#' + id, { open: false }]));
  const snapshot = { servers: [oldServer], nodes: [], jobs: [], versions: { latest: '1.26.52.3' } };
  const state = { auth: { authenticated: true, user: { role: 'admin' } }, view: 'servers', serverTab: 'console', render: 0, servers: [oldServer], nodes: [], data: snapshot, serverQuery: '', serverFilter: 'all', serverNodeFilter: 'all' };
  const context = { state, document: { activeElement: null }, rendering: false, refreshing: false, launching: false, dashboardRequest: 0, renderedDataSignature: '', renderedServerResultsSignature: '', applicationSettingsControls: null, createNodeSync: null, snapshotsRead: 0, paints: 0, resultPaints: 0,
    $: selector => selector === '#workspace' ? root : selector === '#server-results' && root.innerHTML.includes('id="server-results"') ? results : selector === '#server-result-count' && root.innerHTML.includes('id="server-result-count"') ? count : dialogs[selector] || null,
    $$: () => [],
    api: async path => { assert.equal(path, '/dashboard'); context.snapshotsRead++; return JSON.parse(JSON.stringify(context.snapshot)); },
    setServers: servers => { state.servers = servers; },
    findServer: () => state.servers.find(server => server.id === state.selected),
    syncApplicationConsoleAside: applicationModule.syncApplicationConsoleAside,
    uiHTML: (element, value) => {
      if (element === results) { root.innerHTML = root.innerHTML.replace(results.markup, String(value)); results.markup = String(value); context.resultPaints++; }
      else { element.innerHTML = String(value); results.markup = element.innerHTML.match(/<div id="server-results">([\s\S]*)<\/div>$/)?.[1] || ''; count.text = element.innerHTML.match(/id="server-result-count"[^>]*>([^<]*)/)?.[1] || ''; }
    },
    uiText: (element, value) => { assert.equal(element, count); root.innerHTML = root.innerHTML.replace(count.text, String(value)); count.text = String(value); },
    bindView: () => { context.paints++; },
    e: value => String(value ?? ''), t: value => value, nodeText: en => en, getLocale: () => 'en-US', canCreate: () => true,
    ht: (parts, ...values) => parts.map((part, index) => part + (values[index] ?? '')).join(''),
    heading: title => `<h1>${title}</h1>`, icon: () => '', btn: label => `<button>${label}</button>`, empty: title => `<p>${title}</p>`,
    countRatioUI: (shown, total) => `${shown}/${total} servers`, jobsMarkup: () => '',
    serverCard: server => `<article data-id="${server.id}">${server.name}</article>`,
    workspaceLoadingMarkup: () => '<p>Loading</p>', titleMap: { servers: 'Servers' },
    snapshot,
  };
  for (const name of ['queueOperationRefreshes', 'ingestTelemetrySnapshot', 'syncCommandControls', 'syncNodeAvailability', 'syncApplicationMetadata', 'syncSelects', 'syncTelemetry', 'syncResourceBudget', 'updateServerContext', 'syncFileWorkspace', 'syncFileEditor', 'syncOperationControls', 'syncRecoveryControls', 'syncJobDetails', 'updateNotifications', 'refreshOperationData', 'renderHostMini', 'destroySelects']) context[name] = () => {};
  context.updateConnection = () => { throw Error('Unexpected refresh error'); };
  vm.createContext(context);
  vm.runInContext(section('async function loadDashboard(', '\nasync function launch(') + '\n' + section('async function renderView(){', '\nfunction sparkline(') + '\n' + section('function filteredServers(){', '\nfunction contextSignature(') + '\n' + section('function dataSignature(){', '\nlet dashboardRefreshTimer') + '\n' + section('async function refreshData(){', "\nwindow.addEventListener('hashchange'"), context);
  return { context, state, root, dialogs, render: () => vm.runInContext('renderView()', context), refresh: () => vm.runInContext('refreshData()', context) };
}

test('a dashboard consumed during the create/job dialog still paints the new server after close', async () => {
  const h = harness();
  await h.render();
  assert.match(h.root.innerHTML, /1\/1 servers/);
  h.dialogs['#modal'].open = true;
  h.context.snapshot = { ...h.context.snapshot, servers: [newServer, oldServer] };
  await h.refresh();
  assert.equal(h.state.servers.length, 2, 'accepted dashboard was already consumed');
  assert.doesNotMatch(h.root.innerHTML, /owned-new-app/, 'modal guard must defer DOM replacement');
  h.dialogs['#modal'].open = false;
  await h.refresh(); // Identical snapshot: this used to lose its invalidation.
  assert.match(h.root.innerHTML, /data-id="owned-new-app"/);
  assert.match(h.root.innerHTML, /2\/2 servers/);
  const paints = h.context.paints;
  await h.refresh();
  assert.equal(h.context.paints, paints, 'unchanged applied data must not replace the DOM again');
});

test('focused controls keep their DOM and pending refresh is applied after focus leaves', async () => {
  const h = harness();
  await h.render();
  const focused = { inWorkspace: true, inResults: true, matches: () => true };
  h.context.document.activeElement = focused;
  h.context.snapshot = { ...h.context.snapshot, servers: [newServer, oldServer] };
  await h.refresh();
  await h.refresh();
  assert.equal(h.context.document.activeElement, focused);
  assert.equal(h.context.paints, 1);
  assert.doesNotMatch(h.root.innerHTML, /owned-new-app/);
  h.context.document.activeElement = null;
  await h.refresh();
  assert.match(h.root.innerHTML, /owned-new-app/);
  assert.equal(h.context.paints, 2);
});

test('closing the job dialog onto its Create trigger refreshes only results and preserves toolbar focus', async () => {
  const h = harness();
  await h.render();
  h.dialogs['#modal'].open = true;
  h.context.snapshot = { ...h.context.snapshot, servers: [newServer, oldServer] };
  await h.refresh();
  assert.doesNotMatch(h.root.innerHTML, /owned-new-app/);
  const createTrigger = { inWorkspace: true, inResults: false, matches: () => true };
  h.dialogs['#modal'].open = false;
  h.context.document.activeElement = createTrigger; // Native dialog focus restoration.
  await h.refresh();
  assert.match(h.root.innerHTML, /data-id="owned-new-app"/);
  assert.match(h.root.innerHTML, /2\/2 servers/);
  assert.equal(h.context.document.activeElement, createTrigger);
  assert.equal(h.context.paints, 1, 'the focused toolbar must not be replaced');
  assert.equal(h.context.resultPaints, 1);
  await h.refresh();
  assert.equal(h.context.resultPaints, 1, 'identical data must not keep replacing cards');
  h.context.document.activeElement = null;
  await h.refresh();
  assert.equal(h.context.paints, 2, 'the remaining whole-view invalidation is still pending');
});

test('actual Python runtime card and project labels show the runtime name once', async () => {
  const previous = globalThis.document;
  globalThis.document = { documentElement: { lang: '' }, addEventListener() {}, querySelectorAll() { return []; } };
  let application;
  try { application = await import('../public/application-workspace.js'); }
  finally { if (previous) globalThis.document = previous; else delete globalThis.document; }
  for (const version of ['Python 3.12.3', '3.12.3']) {
    const server = { kind: 'python', version };
    const markup = application.applicationRuntimeMarkup(server, { available: true, runtime: { version } }).replace(/<[^>]*>/g, ' ');
    assert.doesNotMatch(markup, /Python\s+Python/);
    assert.match(markup, /Python\s+3\.12\.3/);
    const context = { applicationName: application.applicationName, applicationVersionLabel: application.applicationVersionLabel, server };
    vm.createContext(context);
    vm.runInContext(section('function runtimeLabel(', '\nfunction serverCard('), context);
    assert.equal(vm.runInContext('runtimeLabel(server)', context), 'Python 3.12.3');
  }
  const markup = application.applicationRuntimeMarkup({ kind: 'nodejs' }, { available: true, runtime: { version: 'v22.23.3' } });
  assert.match(markup, /Node\.js/); assert.match(markup, /v22\.23\.3/);
  assert.doesNotMatch(application.applicationRuntimeMarkup({ kind: 'python', version: 'Python 3.11.0' }, { available: false }), /3\.11\.0/, 'unknown capability must not invent a currently detected version from saved metadata');
});
