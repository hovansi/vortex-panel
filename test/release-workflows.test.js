import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const scripts = [...release.matchAll(/node --input-type=module <<'NODE'\n([\s\S]*?)^          NODE$/gm)]
  .map(match => match[1].split('\n').map(line => line.replace(/^          /, '')).join('\n'));
const execute = (source, scope) => new vm.Script(source.replace(/^import .* from 'node:[^']+';\n/gm, ''))
  .runInNewContext(scope, { timeout: 2000 });
const head = 'a'.repeat(40);
const env = { RELEASE_TAG: 'v0.16.0', GITHUB_REF_TYPE: 'tag', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: head,
  GH_REPO: 'example/vortex-panel', GITHUB_REPOSITORY: 'example/vortex-panel',
  GITHUB_SERVER_URL: 'https://github.com', RUNNER_TEMP: '/synthetic-runner-temp' };

function tagCheck(change = {}) {
  const values = { version: '0.16.0', lockVersion: '0.16.0', rootVersion: '0.16.0', head, tagged: head, ...change };
  return execute(scripts[0], {
    process: { env: { ...env, ...values.env } },
    readFileSync: path => JSON.stringify(path === 'package.json' ? { version: values.version }
      : { version: values.lockVersion, packages: { '': { version: values.rootVersion } } }),
    execFileSync: (command, args) => {
      assert.equal(command, 'git');
      return args[1] === 'HEAD' ? values.head : values.tagged;
    },
  });
}

function publisher(options = {}) {
  const names = ['vortex-panel-0.16.0.zip', 'SHA256SUMS', 'install.sh', 'release-manifest.json'];
  const bytes = new Map(names.map(name => [name, Buffer.from(`synthetic-${name}\n`)]));
  bytes.set('SHA256SUMS', Buffer.from(names.filter(name => name !== 'SHA256SUMS').map(name =>
    `${createHash('sha256').update(bytes.get(name)).digest('hex')}  ${name}\n`).join('')));
  if (options.badChecksum) bytes.set('SHA256SUMS', Buffer.from(`${'0'.repeat(64)}  vortex-panel-0.16.0.zip\n`));
  const state = { calls: [], created: false, uploaded: false, published: false, commitReads: 0,
    tagExists: !options.tagMissing, tagWrites: 0, releaseWrites: 0, uploadWrites: [], publishWrites: 0,
    idReads: 0, publishedTagReads: 0, draftTagReads: 0, listReads: 0, notes: [] };
  const written = new Map();
  const uploaded = [];
  const asset = (name, index) => ({ id: 1000 + index, name, state: 'uploaded', size: bytes.get(name).length,
    digest: `sha256:${createHash('sha256').update(bytes.get(name)).digest('hex')}` });
  const releaseRow = () => ({ id: 123, tag_name: 'v0.16.0', target_commitish: head, draft: !state.published,
    prerelease: false, assets: uploaded.map(row => ({ ...row })),
    html_url: 'https://github.com/example/vortex-panel/releases/tag/v0.16.0' });
  const response = row => ({ status: 0, stdout: typeof row === 'string' ? row : JSON.stringify(row) });
  const absent = () => ({ status: 1, stdout: 'HTTP/2.0 404 response\r\n\r\n' });
  const failure = () => ({ status: 1, stdout: '' });
  const scope = {
    process: { env: { ...env, ...options.env } }, join, createHash,
    console: { log: value => state.notes.push(value) },
    readFileSync: (path, encoding) => {
      if (path === 'package.json') return JSON.stringify({ version: options.version || '0.16.0' });
      const value = written.get(path) || bytes.get(path.split(/[\\/]/).at(-1));
      assert.ok(value, path);
      return encoding === 'utf8' ? value.toString('utf8') : value;
    },
    readdirSync: () => [...names],
    lstatSync: path => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1,
      size: bytes.get(path.split(/[\\/]/).at(-1)).length }),
    writeFileSync: (path, content, flags) => {
      assert.equal(flags.flag, 'wx'); assert.equal(written.has(path), false);
      written.set(path, Buffer.from(content)); state.notes.push(content);
    },
    execFileSync: (command, args) => { assert.equal(command, 'git'); assert.deepEqual(Array.from(args), ['rev-parse', 'HEAD']); return head; },
    spawnSync: (command, args, limits) => {
      assert.equal(command, 'gh'); assert.equal(limits.timeout, 120000); assert.equal(limits.shell, undefined);
      assert.ok(!args.includes('--clobber') && !args.includes('delete') && !args.includes('delete-asset'));
      assert.equal(args[0], 'api'); // Every release mutation is bound to a numeric ID, never a CLI tag lookup.
      state.calls.push([...args]);
      if (args.includes('--method')) {
        const index = args.indexOf('--method'), method = args[index + 1], target = args[index + 2];
        if (target.endsWith('/git/refs')) {
          assert.deepEqual(Array.from(args), ['api', '--method', 'POST', `repos/${env.GH_REPO}/git/refs`,
            '-f', 'ref=refs/tags/v0.16.0', '-f', `sha=${head}`]);
          assert.equal(state.tagExists, false);
          state.tagExists = true; state.tagWrites++;
          if (options.tagWrite === 'timeout') return { status: null, error: new Error('synthetic unknown tag write'), stdout: '' };
          if (options.tagWrite === 'failed') return failure();
          return response({ ref: 'refs/tags/v0.16.0', object: { type: 'commit', sha: head } });
        }
        if (method === 'POST' && target === `repos/${env.GH_REPO}/releases`) {
          assert.ok(args.includes('Content-Type: application/json'));
          assert.equal(state.created, false); state.created = true; state.releaseWrites++;
          const payload = JSON.parse(written.get(args.at(-1)));
          assert.equal(payload.tag_name, 'v0.16.0'); assert.equal(payload.target_commitish, head);
          assert.equal(payload.draft, true); assert.equal(payload.prerelease, false);
          assert.equal(payload.name, 'Vortex Panel 0.16.0'); assert.match(payload.body, /download\/install\.sh \| sudo bash/);
          if (options.fail === 'create') return failure();
          const row = releaseRow(); if (options.badCreate) options.badCreate(row);
          return response(row);
        }
        if (method === 'POST' && target.startsWith('https://uploads.github.com/')) {
          assert.equal(state.created, true);
          const url = new URL(target), name = url.searchParams.get('name');
          assert.equal(url.origin, 'https://uploads.github.com');
          assert.equal(url.pathname, `/repos/${env.GH_REPO}/releases/123/assets`);
          assert.ok(names.includes(name) && !state.uploadWrites.includes(name));
          assert.ok(args.includes('Content-Type: application/octet-stream'));
          assert.equal(args.at(-1).split(/[\\/]/).at(-1), name);
          const row = asset(name, state.uploadWrites.length + 1);
          state.uploadWrites.push(name); uploaded.push(row); state.uploaded = true;
          if (options.fail === 'upload') return failure();
          const acknowledged = { ...row }; if (options.badUpload) options.badUpload(acknowledged);
          return response(acknowledged);
        }
        assert.equal(method, 'PATCH'); assert.equal(target, `repos/${env.GH_REPO}/releases/123`);
        assert.ok(args.includes('Content-Type: application/json'));
        assert.equal(uploaded.length, 4); assert.equal(state.published, false);
        assert.deepEqual(JSON.parse(written.get(args.at(-1))), { draft: false, make_latest: 'true' });
        state.published = true; state.publishWrites++;
        if (options.fail === 'edit') return failure();
        return response(releaseRow());
      }
      if (args.includes('--include')) {
        if (args.at(-1).includes('/git/ref/')) {
          if (options.tagProbe === 'timeout') return { status: null, error: new Error('synthetic tag probe timeout'), stdout: '' };
          if (options.tagProbe) return { status: 1, stdout: `HTTP/2.0 ${options.tagProbe} response\r\n\r\n` };
          return state.tagExists ? response('HTTP/2.0 200 OK\r\n\r\n') : absent();
        }
        state.publishedTagReads++;
        if (options.preflight === 'exists') return response('HTTP/2.0 200 OK\r\n\r\n');
        if (options.preflight === 'timeout') return { status: null, error: new Error('synthetic timeout'), stdout: '' };
        return { status: 1, stdout: `HTTP/2.0 ${options.preflight || '404'} response\r\n\r\n` };
      }
      const target = args[1];
      if (target === `repos/${env.GH_REPO}`) return response({ private: options.private === true });
      if (target.endsWith('/commits/v0.16.0')) {
        assert.equal(state.tagExists, true); state.commitReads++;
        return response({ sha: options.movedTag && state.commitReads === options.movedTag ? 'b'.repeat(40) : head });
      }
      const listing = /\/releases\?per_page=100&page=(\d+)$/.exec(target);
      if (listing) {
        state.listReads++;
        if (options.listFailure) return failure();
        if (options.listMalformed) return response({ error: 'invalid listing' });
        const page = Number(listing[1]);
        if (options.fullPages || options.draftSecondPage && page === 1) {
          return response(Array.from({ length: 100 }, (_, index) => ({ id: page * 1000 + index + 1, tag_name: `v8.${page}.${index}`, draft: false })));
        }
        if (options.existingDraft || options.draftSecondPage && page === 2) return response([{ id: 99, tag_name: 'v0.16.0', draft: true }]);
        const rows = state.created ? [releaseRow()] : [];
        if (options.duplicateAfterCreate && state.created) rows.push({ id: 124, tag_name: 'v0.16.0', draft: true });
        return response(rows);
      }
      if (target.endsWith('/releases/tags/v0.16.0')) {
        // Model the real documented endpoint: unpublished drafts are not found.
        if (!state.published) { state.draftTagReads++; return absent(); }
        return response(releaseRow());
      }
      assert.equal(target, `repos/${env.GH_REPO}/releases/123`);
      state.idReads++;
      if (options.afterCreateReadFails && !state.uploaded || options.afterPublishReadFails && state.published) return failure();
      const row = releaseRow(); if (options.corrupt && state.uploaded) options.corrupt(row);
      return response(row);
    },
  };
  try { execute(scripts[1], scope); }
  catch (error) { state.error = error; }
  return state;
}

test('CI and release keep read-only tests, pinned official actions and one verified publisher', () => {
  assert.equal(scripts.length, 2);
  for (const workflow of [ci, release]) {
    const actions = [...workflow.matchAll(/uses: ([^\n#]+)/g)].map(match => match[1].trim());
    assert.ok(actions.length > 0);
    assert.ok(actions.every(action => ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'].includes(action)));
    assert.equal((workflow.match(/persist-credentials: false/g) || []).length, actions.filter(a => a.startsWith('actions/checkout@')).length);
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.match(workflow, /os: \[ubuntu-22\.04, ubuntu-24\.04\]/);
    for (const command of ['npm ci', 'npm run check', 'npm test', 'bash -n deploy/bootstrap.sh']) assert.ok(workflow.includes(command));
    assert.ok(!/pull_request_target:|workflow_run:|secrets\.(?!GITHUB_TOKEN)/.test(workflow));
  }
  assert.equal((release.match(/contents: write/g) || []).length, 1);
  assert.match(release, /publish:[\s\S]*needs: verify[\s\S]*permissions:\n      contents: write/);
  assert.match(release, /tags: \['v\*'\]/);
  assert.match(release, /workflow_dispatch:\n    inputs:\n      tag:/);
  assert.match(release, /default: 'v0\.17\.1'/);
  assert.equal((release.match(/GH_TOKEN:/g) || []).length, 1);
  assert.match(release, /node scripts\/release\.js --repository "\$GITHUB_REPOSITORY" --output "output\/release\/\$RELEASE_TAG"/);
  assert.match(release, /sha256sum --check --strict SHA256SUMS/);
  assert.match(release, /bash -n install\.sh/);
  assert.match(release, /\/releases\/latest\/download\/install\.sh \| sudo bash\\n/);
  assert.doesNotMatch(release, /download\/bootstrap\.sh|sudo bash -s -- --root-mode/);
});

test('the exact workflow tag gate rejects mismatched package, lock or commit before publication', () => {
  tagCheck();
  for (const change of [{ env: { RELEASE_TAG: 'v0.16.1' } }, { env: { RELEASE_TAG: 'v0.16.0-rc.1' } },
    { env: { RELEASE_TAG: 'v00.16.0' } }, { lockVersion: '0.15.9' }, { rootVersion: '0.15.9' },
    { env: { GITHUB_REF_TYPE: 'branch' } }, { tagged: 'b'.repeat(40) }, { head: 'b'.repeat(40) }]) {
    assert.throws(() => tagCheck(change));
  }
});

test('a maintainer branch dispatch validates exact version and tested HEAD without requiring a preexisting local tag', () => {
  const manual = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch' };
  tagCheck({ env: manual, tagged: 'a missing local tag is irrelevant' });
  for (const change of [{ env: { ...manual, RELEASE_TAG: 'v0.16.1' } },
    { env: { ...manual, RELEASE_TAG: 'v0.16.0-rc.1' } },
    { env: { ...manual, GITHUB_REF_TYPE: 'tag' } }, { env: { GITHUB_EVENT_NAME: 'pull_request' } },
    { env: manual, lockVersion: '0.15.9' }, { env: manual, head: 'b'.repeat(40) }]) {
    assert.throws(() => tagCheck(change));
  }
});

test('publication requires confirmed release absence, public repository and unchanged remote tag', () => {
  for (const options of [{ preflight: 'exists' }, { preflight: '403' }, { preflight: '500' },
    { preflight: 'timeout' }, { private: true }, { movedTag: 1 }, { version: '0.16.1' }, { badChecksum: true }]) {
    const state = publisher(options);
    assert.ok(state.error); assert.equal(state.created, false); assert.equal(state.published, false);
  }
});

test('published-only tag lookup can return 404 for drafts while every draft operation stays on the acknowledged numeric ID', () => {
  const state = publisher();
  assert.equal(state.error, undefined); assert.equal(state.published, true);
  assert.equal(state.publishedTagReads, 1); assert.equal(state.draftTagReads, 0);
  assert.equal(state.idReads, 6);
  assert.equal(state.releaseWrites, 1); assert.equal(state.uploadWrites.length, 4); assert.equal(state.publishWrites, 1);
  const writes = state.calls.filter(args => args.includes('--method'));
  assert.ok(writes.slice(1, -1).every(args => args[3].startsWith('https://uploads.github.com/repos/example/vortex-panel/releases/123/assets?name=')));
  assert.equal(writes.at(-1)[3], 'repos/example/vortex-panel/releases/123');
});

test('authenticated bounded listing refuses existing drafts, later-page drafts, malformed pages and uncertain listing before mutation', () => {
  for (const options of [{ existingDraft: true }, { draftSecondPage: true }, { listFailure: true },
    { listMalformed: true }, { fullPages: true }]) {
    const state = publisher(options);
    assert.ok(state.error); assert.equal(state.tagWrites, 0); assert.equal(state.releaseWrites, 0);
    assert.equal(state.uploadWrites.length, 0); assert.equal(state.publishWrites, 0);
    if (options.draftSecondPage) assert.equal(state.listReads, 2);
    if (options.fullPages) assert.equal(state.listReads, 20);
  }
});

test('lost draft observations or invalid creation acknowledgements retain the single draft without replay', () => {
  for (const options of [{ afterCreateReadFails: true },
    { badCreate: row => { row.id = 0; } }, { badCreate: row => { row.draft = false; } },
    { badCreate: row => { row.target_commitish = 'b'.repeat(40); } },
    { badCreate: row => { row.assets = [{ id: 1001 }]; } }]) {
    const state = publisher(options);
    assert.ok(state.error); assert.equal(state.releaseWrites, 1); assert.equal(state.uploadWrites.length, 0);
    assert.equal(state.publishWrites, 0);
    if (options.afterCreateReadFails) assert.equal(state.idReads, 1);
  }
});

test('asset acknowledgements and ID reads must retain exact identities even when bytes and SHA256 match', () => {
  for (const options of [{ badUpload: row => { row.id = 0; } },
    { badUpload: row => { row.id = 9999; } },
    { badUpload: row => { if (row.name === 'SHA256SUMS') row.id = 1001; } },
    { corrupt: row => { row.assets[0].id++; } }]) {
    const state = publisher(options);
    assert.ok(state.error); assert.equal(state.releaseWrites, 1); assert.ok(state.uploadWrites.length <= 2);
    assert.equal(new Set(state.uploadWrites).size, state.uploadWrites.length); assert.equal(state.publishWrites, 0);
  }
});

test('a second release claiming the same tag after upload prevents the by-ID publication patch', () => {
  const state = publisher({ duplicateAfterCreate: true });
  assert.ok(state.error); assert.equal(state.releaseWrites, 1); assert.equal(state.uploadWrites.length, 4);
  assert.equal(state.publishWrites, 0); assert.equal(state.published, false);
});

test('only a verified manual dispatch creates a missing tag once before its new draft release', () => {
  const manual = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch' };
  const complete = publisher({ env: manual, tagMissing: true });
  assert.equal(complete.error, undefined); assert.equal(complete.published, true); assert.equal(complete.tagWrites, 1);
  const tagWrite = complete.calls.findIndex(args => args.includes('--method'));
  const releaseProbe = complete.calls.findIndex(args => args.includes('--include') && args.at(-1).includes('/releases/'));
  const draftCreate = complete.calls.findIndex(args => args.includes('--method') && args[3] === `repos/${env.GH_REPO}/releases`);
  assert.ok(releaseProbe < tagWrite && tagWrite < draftCreate);
  const matching = publisher({ env: manual });
  assert.equal(matching.error, undefined); assert.equal(matching.published, true); assert.equal(matching.tagWrites, 0);
  for (const options of [{ tagMissing: true }, { env: manual, movedTag: 1 },
    { env: manual, tagMissing: true, preflight: 'exists' },
    { env: manual, tagMissing: true, tagProbe: '403' }, { env: manual, tagMissing: true, tagProbe: '500' },
    { env: manual, tagMissing: true, tagProbe: 'timeout' }]) {
    const state = publisher(options);
    assert.ok(state.error); assert.equal(state.tagWrites, 0); assert.equal(state.created, false); assert.equal(state.published, false);
  }
});

test('failed, unknown or conflicting tag creation stops without replay or a draft release', () => {
  const manual = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch' };
  for (const change of [{ tagWrite: 'timeout' }, { tagWrite: 'failed' }, { movedTag: 1 }]) {
    const state = publisher({ env: manual, tagMissing: true, ...change });
    assert.ok(state.error); assert.equal(state.tagWrites, 1); assert.equal(state.created, false); assert.equal(state.published, false);
    assert.equal(state.calls.filter(args => args.includes('--method')).length, 1);
  }
});

test('bad uploaded asset evidence retains the draft without publishing or overwriting', () => {
  for (const corrupt of [row => { row.assets[0].digest = `sha256:${'0'.repeat(64)}`; },
    row => { row.assets[0].size++; }, row => { row.assets[0].state = 'starter'; },
    row => { row.assets[1] = { ...row.assets[0] }; }, row => { row.assets.pop(); }]) {
    const state = publisher({ corrupt });
    assert.ok(state.error); assert.equal(state.created, true); assert.equal(state.uploaded, true);
    assert.equal(state.published, false); assert.equal(state.uploadWrites.length, 1);
  }
});

test('only verified drafts publish, and failed operations or final observations never auto-replay', () => {
  const complete = publisher();
  assert.equal(complete.error, undefined); assert.equal(complete.published, true); assert.equal(complete.commitReads, 2);
  assert.equal(complete.releaseWrites, 1); assert.equal(complete.uploadWrites.length, 4); assert.equal(complete.publishWrites, 1);
  for (const options of [{ fail: 'create' }, { fail: 'upload' }, { movedTag: 2 }, { fail: 'edit' }, { afterPublishReadFails: true }]) {
    const state = publisher(options);
    assert.ok(state.error);
    assert.ok(state.releaseWrites <= 1 && state.publishWrites <= 1);
    assert.equal(new Set(state.uploadWrites).size, state.uploadWrites.length);
    if (options.fail === 'create') assert.equal(state.uploaded, false);
    if (options.fail === 'upload' || options.movedTag) assert.equal(state.published, false);
    // A lost publish acknowledgement or failed final GET is unknown/failed, never rollback or a second publish.
  }
});
