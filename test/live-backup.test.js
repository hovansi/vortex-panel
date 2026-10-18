import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createBackupConsole, parseBackupFiles, snapshotLiveServer } from '../server/live-backup.js';
import { writeWorld } from './worlds-fixture.js';

const ready = 'Data saved. Files are now ready to be copied.';
const header = body => `[2026-10-16 09:00:00:001 INFO] ${body}\n`;
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-live-backup-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'run'), destination = path.join(directory, 'snapshot');
  await fs.mkdir(root); await writeWorld(path.join(root, 'worlds', 'Main'));
  await fs.writeFile(path.join(root, 'server.properties'), 'level-name=Main\n');
  const names = ['level.dat', 'db/CURRENT', 'db/MANIFEST-000001', 'db/000002.ldb'];
  const list = [];
  for (const name of names) list.push(`Main/${name}:${(await fs.stat(path.join(root, 'worlds', 'Main', name))).size}`);
  const commands = [];
  const control = { async collect(command) {
    commands.push(command);
    if (command === 'save hold') return ['Saving...'];
    if (command === 'save query') return [ready, list.join(', ')];
    if (command === 'save resume') return ['Changes to the world are resumed.'];
    return [];
  } };
  return { directory, root, destination, commands, control, list, worldName: 'Main', console: control };
}

test('native snapshot manifests preserve Unicode, spaces and commas and reject incomplete or unsafe lists', async t => {
  const world = 'Thế giới, số 1';
  assert.deepEqual(parseBackupFiles([ready, `${world}/level.dat:12, ${world}/db/000001.log:0,`, 'Player connected: a visitor'], world), [{ relative: `worlds/${world}/level.dat`, size: 12 }, { relative: `worlds/${world}/db/000001.log`, size: 0 }]);
  for (const row of ['../Main/level.dat:2', 'Other/level.dat:2', 'Main/../level.dat:2', 'Main//level.dat:2', 'Main/db/file:-1', 'Main/db/file:9007199254740992', 'Main/db/file:2, Main/db/file:2', 'Main/db/file:2, Main/db/no-size', 'Main/db/file:2 … [truncated]']) {
    await t.test(row, () => assert.throws(() => parseBackupFiles([ready, 'Main/level.dat:2', row], 'Main'), error => error.status >= 400));
  }
  assert.throws(() => parseBackupFiles([ready, 'Main/level.dat:2'], 'Main'), /thiếu dữ liệu/);
  assert.throws(() => parseBackupFiles([ready, 'Main/db/file:2'], 'Main'), /thiếu dữ liệu/);
  assert.throws(() => parseBackupFiles([ready, 'Main/level.dat:2, Main/db/file:2'], 'Main', { maxBytes: 3 }), /vượt giới hạn/);
  assert.throws(() => parseBackupFiles([ready, 'Main/level.dat:2, Main/db/file:2'], 'Main', { maxEntries: 1 }), /vượt giới hạn/);
  assert.throws(() => parseBackupFiles(['A previous save has not been completed.'], 'Main'), /chưa xác nhận/);
});

test('captured Bedrock 1.26.52.3 native manifest accepts its bare file-list line and preserves all six byte limits', () => {
  // Captured by a fenced production console probe, 2026-10-16. BDS emits this
  // row without its normal INFO header; the initial probe incorrectly dropped it.
  const files = parseBackupFiles([
    '> save query',
    ready,
    'Bedrock level/db/000003.log:2321, Bedrock level/db/MANIFEST-000002:50, Bedrock level/db/CURRENT:16, Bedrock level/level.dat:3015, Bedrock level/level.dat_old:3015, Bedrock level/levelname.txt:13',
    '> vortex_probe_a971163b9134456490b8ebcfab93c58a'
  ], 'Bedrock level');
  assert.deepEqual(files, [
    { relative: 'worlds/Bedrock level/db/000003.log', size: 2321 },
    { relative: 'worlds/Bedrock level/db/MANIFEST-000002', size: 50 },
    { relative: 'worlds/Bedrock level/db/CURRENT', size: 16 },
    { relative: 'worlds/Bedrock level/level.dat', size: 3015 },
    { relative: 'worlds/Bedrock level/level.dat_old', size: 3015 },
    { relative: 'worlds/Bedrock level/levelname.txt', size: 13 }
  ]);
  assert.equal(files.reduce((total, file) => total + file.size, 0), 8430);
});

test('bounded native console reader waits for its fence, accepts split UTF-8 and rejects timeout, overflow and process exit', async t => {
  for (const mode of ['normal', 'normal-raw', 'timeout', 'overflow', 'exit', 'stdin']) await t.test(mode, async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const sent = [];
    const control = createBackupConsole({ child, timeoutMs: mode === 'timeout' ? 50 : 1000, maxBytes: mode === 'overflow' ? 256 : 100000, send(command) {
      sent.push(command);
      if (mode === 'stdin') throw Error('Rejected stdin write');
      if (command === 'save query') {
        if (mode === 'exit') { queueMicrotask(() => child.emit('close', 1)); return { acceptedToConsole: true }; }
        const list = 'Main/level.dat:2, Main/db/Thế giới:3' + (mode === 'overflow' ? 'x'.repeat(1024) : '');
        const data = Buffer.from(header(ready) + (mode === 'normal-raw' ? list + '\n' : header(list)));
        queueMicrotask(() => { child.stdout.write(data.subarray(0, 103)); child.stdout.write(data.subarray(103)); });
      } else if (mode !== 'timeout') setImmediate(() => child.stdout.write(header(`Unknown command: ${command}. Please check that the command exists and that you have permission to use it.`)));
      return { acceptedToConsole: true };
    } });
    try {
      if (mode.startsWith('normal')) {
        const lines = await control.collect('save query'); assert.deepEqual(lines, [ready, 'Main/level.dat:2, Main/db/Thế giới:3']);
        assert.equal(sent.length, 2); assert.equal(control.isInternal(header(`Unknown command: ${sent[1]}.`).trim()), true);
      } else await assert.rejects(control.collect('save query'), new RegExp({ timeout: 'thời gian chờ', overflow: 'vượt giới hạn', exit: 'đã dừng', stdin: 'Rejected stdin' }[mode]));
    } finally { control.close(); }
    assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0); assert.equal(child.listenerCount('close'), 0);
  });
});

test('live snapshots copy exact native prefixes, omit stale DB files, preserve assets/empty folders and resume before other copying', async t => {
  const x = await fixture(t), active = path.join(x.root, 'worlds', 'Main'), table = path.join(active, 'db', '000002.ldb');
  const expected = await fs.readFile(table);
  await fs.appendFile(table, 'Native writes AFTER the snapshot boundary must not enter the backup.');
  await fs.writeFile(path.join(active, 'db', '999999.ldb'), 'Unlisted obsolete native table');
  await fs.writeFile(path.join(active, 'level.dat_old'), 'Unlisted old level');
  await fs.mkdir(path.join(active, 'resource_packs', 'embedded'), { recursive: true });
  await fs.writeFile(path.join(active, 'resource_packs', 'embedded', 'manifest.json'), '{"asset":"keep"}');
  await fs.writeFile(path.join(x.root, 'bedrock_server'), 'exclude the runtime');
  const original = x.control.collect;
  x.control.collect = async command => {
    const result = await original(command);
    if (command === 'save resume') assert.equal(await fs.stat(path.join(x.destination, 'server.properties')).catch(() => null), null);
    return result;
  };
  await snapshotLiveServer({ ...x, exclude: name => name === 'bedrock_server' });
  assert.deepEqual(await fs.readFile(path.join(x.destination, 'worlds', 'Main', 'db', '000002.ldb')), expected);
  for (const name of ['db/999999.ldb', 'level.dat_old']) assert.equal(await fs.stat(path.join(x.destination, 'worlds', 'Main', name)).catch(() => null), null);
  assert.equal(await fs.readFile(path.join(x.destination, 'worlds', 'Main', 'resource_packs', 'embedded', 'manifest.json'), 'utf8'), '{"asset":"keep"}');
  assert.ok((await fs.stat(path.join(x.destination, 'worlds', 'Main', 'structures', 'empty'))).isDirectory());
  assert.equal(await fs.stat(path.join(x.destination, 'bedrock_server')).catch(() => null), null);
  assert.deepEqual(x.commands, ['list', 'save hold', 'save query', 'save resume']);
  assert.ok((await fs.stat(table)).size > expected.length);
});

test('live snapshot failures always release their own hold and never invent a complete snapshot', async t => {
  for (const mode of ['not-ready', 'invalid-manifest', 'short-file', 'missing-file', 'write-failure', 'shutdown', 'hold-ack-lost', 'workspace-full']) await t.test(mode, async t => {
    const x = await fixture(t), collect = x.control.collect, open = fs.open;
    if (mode === 'short-file') await fs.truncate(path.join(x.root, 'worlds', 'Main', 'db', '000002.ldb'), 1);
    if (mode === 'missing-file') await fs.rm(path.join(x.root, 'worlds', 'Main', 'db', '000002.ldb'));
    x.control.collect = async command => {
      if (mode === 'hold-ack-lost' && command === 'save hold') { x.commands.push(command); throw Error('Hold receipt lost'); }
      if (mode === 'invalid-manifest' && command === 'save query') { x.commands.push(command); return [ready, 'Main/level.dat:1, ../outside/secret:10']; }
      if (mode === 'not-ready' && command === 'save query') { x.commands.push(command); return ['A previous save has not been completed.']; }
      return collect(command);
    };
    if (mode === 'write-failure') fs.open = async (target, ...args) => { if (target.startsWith(x.destination)) throw Error('Snapshot storage write denied'); return open(target, ...args); };
    try {
      await assert.rejects(snapshotLiveServer({ ...x, prepareTimeoutMs: 5, retryMs: 1, guard: () => { if (mode === 'shutdown' && x.commands.includes('save hold')) throw Error('Panel closing'); }, releaseGuard: () => {}, reserveWorkspace: async () => { if (mode === 'workspace-full') throw Error('No disk space for the snapshot'); } }));
    } finally { fs.open = open; }
    assert.equal(x.commands.at(-1), 'save resume'); assert.equal(x.commands.filter(command => command === 'save resume').length, 1);
  });
});

test('snapshot resume retries are idempotent, preserves primary errors, and does not release another backup hold', async t => {
  for (const mode of ['retry', 'unconfirmed', 'primary-and-resume', 'already-held']) await t.test(mode, async t => {
    const x = await fixture(t), collect = x.control.collect; let attempts = 0;
    if (mode === 'primary-and-resume') await fs.rm(path.join(x.root, 'worlds', 'Main', 'db', '000002.ldb'));
    x.control.collect = async command => {
      if (command === 'save hold' && mode === 'already-held') { x.commands.push(command); return ['Saving is already turned off.']; }
      if (command === 'save resume') {
        attempts++; x.commands.push(command);
        if (mode === 'retry' && attempts === 3) return ['Saving is already turned on.'];
        throw Error('No resume receipt');
      }
      return collect(command);
    };
    if (mode === 'retry') { await snapshotLiveServer(x); assert.equal(attempts, 3); }
    else if (mode === 'already-held') { await assert.rejects(snapshotLiveServer(x), /bản sao lưu khác/); assert.equal(attempts, 0); }
    else {
      await assert.rejects(snapshotLiveServer(x), error => /save resume/.test(error.message) && (mode !== 'primary-and-resume' || /Không tìm thấy/.test(error.message)));
      assert.ok(attempts >= 3);
    }
  });
});
