import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorageController } from '../server/storage-volumes.js';

const GIB = 1024 ** 3;
const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const server = (diskGiB = 1) => ({ id: ID, storagePolicy: { mode: 'fixed', diskGiB } });

// Real scoped files/atomic records, injected Linux command/kernel boundary.
// These tests do not claim to have mounted ext4 or run Bedrock on Windows.
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-storage-'));
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  const sizes = new Map(), physicalBytes = new Map(), filesystems = new Map(), mounts = new Map(), calls = [], records = [];
  const faults = { value: null };
  let nextLoop = 1;
  const io = {
    ...fs,
    access: async (name, mode) => name.startsWith('/usr/') ? undefined : fs.access(name, mode),
    lstat: async name => {
      const actual = await fs.lstat(name);
      return new Proxy(actual, { get(target, key) {
        if (key === 'uid') return 0;
        if (key === 'mode') return (target.mode & ~0o777) | (target.isDirectory() ? 0o700 : 0o600);
        if (key === 'size' && sizes.has(name)) return sizes.get(name);
        if (key === 'blocks' && sizes.has(name)) return faults.value === 'sparse' ? 0 : (physicalBytes.get(name) ?? sizes.get(name)) / 512;
        return Reflect.get(target, key);
      } });
    },
    rename: async (source, target) => {
      if (faults.value === 'record-create' && target.endsWith('.json')) throw Object.assign(new Error('injected metadata ENOSPC'), { code: 'ENOSPC' });
      if (faults.value === 'record-after-grow' && target.endsWith('.json')) {
        const record = JSON.parse(await fs.readFile(source, 'utf8'));
        if (record.bytes > GIB && record.pendingGrowBytes === null) { faults.value = null; throw Object.assign(new Error('injected metadata ENOSPC'), { code: 'ENOSPC' }); }
      }
      if (target.endsWith('.json')) {
        const value = JSON.parse(await fs.readFile(source, 'utf8')), image = path.join(dataDir, '.storage', `${ID}.img`);
        records.push({ value, allocatedBytes: physicalBytes.get(image) ?? sizes.get(image) });
      }
      return fs.rename(source, target);
    },
    statfs: async target => {
      const mounted = mounts.get(target); assert.ok(mounted, 'Statfs needs an actual fixture mount binding');
      const bytes = filesystems.get(mounted.image).bytes;
      return { blocks: bytes / 4096 - 16, bavail: bytes / 4096 - 32, bsize: 4096 };
    },
  };
  async function execFile(executable, args, opts) {
    const tool = path.basename(executable); calls.push({ tool, args: [...args], timeout: opts.timeout, env: opts.env });
    if (tool === 'fallocate') {
      if (faults.value === 'allocate') throw Object.assign(new Error('injected full disk'), { code: 1 });
      const image = args.at(-1), bytes = Number(args[args.indexOf('--length') + 1]);
      if (faults.value === 'post-resize-allocate' && filesystems.get(image)?.bytes === bytes && bytes > GIB) throw Object.assign(new Error('injected allocation failure after resize'), { code: 1 });
      sizes.set(image, bytes); physicalBytes.set(image, bytes); return { stdout: '', stderr: '' };
    }
    if (tool === 'mkfs.ext4') {
      assert.ok(args.includes('nodiscard,lazy_itable_init=0,lazy_journal_init=0'), 'Formatting must preserve preallocated host blocks');
      filesystems.set(args.at(-1), { uuid: args[args.indexOf('-U') + 1], bytes: sizes.get(args.at(-1)) }); return { stdout: '', stderr: '' };
    }
    if (tool === 'dumpe2fs') {
      const info = filesystems.get(args.at(-1)); assert.ok(info);
      return { stdout: `Filesystem UUID: ${info.uuid}\nBlock count: ${info.bytes / 4096}\nBlock size: 4096\n`, stderr: '' };
    }
    if (tool === 'findmnt') {
      const target = args[args.indexOf('--mountpoint') + 1], found = mounts.get(target);
      if (!found) throw Object.assign(new Error('No mount'), { code: 1, stdout: '', stderr: '' });
      return { stdout: JSON.stringify({ filesystems: [{ target, source: found.source, fstype: 'ext4', options: 'rw,nodev,nosuid,noatime', uuid: filesystems.get(found.image)?.uuid || 'foreign' }] }), stderr: '' };
    }
    if (tool === 'losetup') return { stdout: JSON.stringify({ loopdevices: [...mounts.values()].map(value => ({ name: value.source, 'back-file': value.image, offset: 0, sizelimit: 0, autoclear: true })) }), stderr: '' };
    if (tool === 'mount') {
      const image = args.at(-2), target = args.at(-1); assert.ok(filesystems.has(image));
      const flags = args[args.indexOf('--options') + 1].split(','); assert.ok(flags.includes('noinit_itable') && flags.includes('nodiscard'), 'A mounted image must not start deferred inode-table zeroout or discard reservations');
      mounts.set(target, { image, source: `/dev/loop${nextLoop++}` }); return { stdout: '', stderr: '' };
    }
    if (tool === 'umount') {
      if (faults.value === 'busy') throw Object.assign(new Error('busy'), { code: 32 });
      mounts.delete(args.at(-1)); return { stdout: '', stderr: '' };
    }
    if (tool === 'e2fsck') return { stdout: '', stderr: '' };
    if (tool === 'resize2fs') {
      if (faults.value === 'resize') throw Object.assign(new Error('injected resize error'), { code: 1 });
      const image = args.at(-1); filesystems.get(image).bytes = sizes.get(image);
      if (['resize-punch', 'post-resize-allocate'].includes(faults.value)) physicalBytes.set(image, sizes.get(image) - 16 * 1024 ** 2);
      return { stdout: '', stderr: '' };
    }
    if (tool === 'du') {
      if (faults.value === 'du') throw Object.assign(new Error('scan failed'), { code: 1 });
      return { stdout: `1234567890\t${args.at(-1)}\n`, stderr: '' };
    }
    throw new Error(`Unexpected fixture executable ${tool}`);
  }
  const controller = createStorageController({ dataDir, fs: io, execFile, platform: 'linux', uid: 0, capSysAdmin: true, ...options });
  t.after(() => controller.close());
  assert.equal((await controller.initialize()).supported, true);
  return { controller, dataDir, io, calls, faults, sizes, physicalBytes, filesystems, mounts, records, image: path.join(dataDir, '.storage', `${ID}.img`), record: path.join(dataDir, '.storage', `${ID}.json`), target: path.join(dataDir, 'servers', ID) };
}

test('fixed volume provision verifies filesystem/backing image and supports reboot remount without formatting', async t => {
  const f = await fixture(t), result = await f.controller.provision(server());
  assert.equal(result.hardEnforced, true); assert.equal(result.enforcement, 'loop-ext4'); assert.equal(result.limitBytes, GIB);
  assert.equal(result.needsGrow, false); assert.ok(result.totalBytes < result.limitBytes);
  const record = JSON.parse(await fs.readFile(f.record)); assert.equal(record.serverId, ID); assert.equal(record.bytes, GIB);
  const formats = f.calls.filter(call => call.tool === 'mkfs.ext4').length;
  assert.deepEqual(await f.controller.unmount(server()), { ok: true, unmounted: true });
  const remounted = await f.controller.ensureMounted(server()); assert.equal(remounted.hardEnforced, true);
  assert.equal(f.calls.filter(call => call.tool === 'mkfs.ext4').length, formats);
  await assert.rejects(f.controller.provision(server()), { code: 'STORAGE_EXISTS' });
});

test('existing data is never hidden and foreign mounts are never unmounted or removed', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'world-marker'), 'preserve');
  await assert.rejects(f.controller.provision(server()), { code: 'STORAGE_UNMOUNTED_DATA' });
  assert.equal(await fs.readFile(path.join(f.target, 'world-marker'), 'utf8'), 'preserve');
  await fs.unlink(path.join(f.target, 'world-marker'));
  await f.controller.provision(server());
  f.mounts.set(f.target, { image: '/foreign/root.img', source: '/dev/loop99' });
  const before = f.calls.filter(call => call.tool === 'umount').length;
  await assert.rejects(f.controller.unmount(server()), { code: 'STORAGE_FOREIGN' });
  await assert.rejects(f.controller.remove(server()), { code: 'STORAGE_BUSY' });
  assert.equal(f.calls.filter(call => call.tool === 'umount').length, before);
  assert.equal((await fs.stat(f.image)).isFile(), true);
});

test('allocation and ownership-record failures remove only the newly owned image, preserving prior data', async t => {
  const f = await fixture(t);
  f.faults.value = 'record-create';
  await assert.rejects(f.controller.provision(server()), { code: 'STORAGE_IO' });
  await assert.rejects(fs.stat(f.image), { code: 'ENOENT' }); await assert.rejects(fs.stat(f.record), { code: 'ENOENT' });
  assert.equal(f.calls.some(call => call.tool === 'mount'), false);
  f.faults.value = 'sparse';
  await assert.rejects(f.controller.provision(server()), { code: 'STORAGE_ALLOCATION' });
  await assert.rejects(fs.stat(f.image), { code: 'ENOENT' });
});

test('busy unmount preserves the volume; durable deletion can remove image after mountpoint is gone', async t => {
  const f = await fixture(t); await f.controller.provision(server());
  f.faults.value = 'busy'; await assert.rejects(f.controller.unmount(server()), { code: 'STORAGE_BUSY' });
  assert.equal((await fs.stat(f.image)).isFile(), true);
  f.faults.value = null; await f.controller.unmount(server()); await fs.rmdir(f.target);
  assert.deepEqual(await f.controller.remove(server()), { ok: true, removed: true });
  assert.deepEqual(await f.controller.remove(server()), { ok: true, removed: false, absent: true });
  const dangling = { id: SECOND, storagePolicy: { mode: 'fixed', diskGiB: 1 } };
  await fs.writeFile(path.join(f.dataDir, '.storage', `${SECOND}.img`), 'orphan');
  await assert.rejects(f.controller.unmount(dangling), { code: 'STORAGE_MISSING' });
});

test('desired growth remains pending on failure, retries without data replacement, and never shrinks', async t => {
  const f = await fixture(t); await f.controller.provision(server());
  const old = JSON.parse(await fs.readFile(f.record));
  f.faults.value = 'resize';
  await assert.rejects(f.controller.grow(server(2)), { code: 'STORAGE_IO', growthPending: true });
  let pending = await f.controller.stats(server(2), { fresh: true });
  assert.equal(pending.limitBytes, GIB); assert.equal(pending.needsGrow, true); assert.equal(pending.hardEnforced, true);
  assert.equal(JSON.parse(await fs.readFile(f.record)).pendingGrowBytes, 2 * GIB);
  f.faults.value = null;
  const grown = await f.controller.grow(server(2)); assert.equal(grown.limitBytes, 2 * GIB); assert.equal(grown.needsGrow, false);
  assert.equal(JSON.parse(await fs.readFile(f.record)).filesystemUUID, old.filesystemUUID);
  await assert.rejects(f.controller.grow(server(1)), { code: 'STORAGE_GROW_ONLY' });
});

test('retry growth admission counts physical blocks still needed even when desired metadata already increased', async t => {
  const f = await fixture(t); await f.controller.provision(server());
  f.faults.value = 'allocate';
  await assert.rejects(f.controller.grow(server(2)), { code: 'STORAGE_IO', growthPending: true });
  assert.equal(JSON.parse(await fs.readFile(f.record)).pendingGrowBytes, 2 * GIB);
  assert.equal(await f.controller.growthAdditionalBytes(server(2)), GIB);
  f.faults.value = 'sparse';
  assert.equal(await f.controller.growthAdditionalBytes(server(2)), 2 * GIB);
  f.faults.value = null; await f.controller.grow(server(2));
  assert.equal(await f.controller.growthAdditionalBytes(server(2)), 0);
});

test('post-resize record failure is recoverable and reports the actual larger filesystem before retry', async t => {
  const f = await fixture(t); await f.controller.provision(server());
  f.faults.value = 'record-after-grow';
  await assert.rejects(f.controller.grow(server(2)), { code: 'STORAGE_IO', growthPending: true });
  const actual = await f.controller.stats(server(2), { fresh: true });
  assert.equal(actual.limitBytes, 2 * GIB); assert.equal(actual.needsGrow, false);
  assert.equal((await f.controller.grow(server(2))).hardEnforced, true);
  assert.equal(JSON.parse(await fs.readFile(f.record)).pendingGrowBytes, null);
});

test('growth disables inherited lazy initialization and reestablishes physical reservation before its final record commits', async t => {
  const previous = process.env.RESIZE2FS_FORCE_LAZY_ITABLE_INIT;
  process.env.RESIZE2FS_FORCE_LAZY_ITABLE_INIT = '1';
  t.after(() => { if (previous === undefined) delete process.env.RESIZE2FS_FORCE_LAZY_ITABLE_INIT; else process.env.RESIZE2FS_FORCE_LAZY_ITABLE_INIT = previous; });
  const f = await fixture(t); await f.controller.provision(server());
  const uuid = JSON.parse(await fs.readFile(f.record)).filesystemUUID;
  f.faults.value = 'resize-punch';
  assert.equal((await f.controller.grow(server(2))).hardEnforced, true);
  const resize = f.calls.find(row => row.tool === 'resize2fs'), fsck = f.calls.find(row => row.tool === 'e2fsck');
  assert.equal(resize.env.RESIZE2FS_FORCE_ITABLE_INIT, '1'); assert.equal(resize.env.UNIX_IO_NOZEROOUT, '1'); assert.equal(Object.hasOwn(resize.env, 'RESIZE2FS_FORCE_LAZY_ITABLE_INIT'), false);
  assert.equal(process.env.RESIZE2FS_FORCE_LAZY_ITABLE_INIT, '1', 'Only the child environment is sanitized');
  assert.ok(fsck.args.includes('nodiscard'));
  assert.equal(f.calls.filter(row => row.tool === 'fallocate' && row.args.includes(String(2 * GIB))).length, 2);
  const final = f.records.find(row => row.value.bytes === 2 * GIB && row.value.pendingGrowBytes === null);
  assert.ok(final.allocatedBytes >= 2 * GIB); assert.equal(final.value.filesystemUUID, uuid);
});

test('post-resize allocation failure retains pending metadata and a fresh same-size retry repairs only the missing physical reservation', async t => {
  const f = await fixture(t); await f.controller.provision(server());
  // The injected mount does not hide a real directory on Windows. Keep the
  // byte sentinel in its inert backing file; native QA checks mounted worlds.
  await fs.writeFile(f.image, 'preserve real bytes');
  const original = JSON.parse(await fs.readFile(f.record)); f.faults.value = 'post-resize-allocate';
  await assert.rejects(f.controller.grow(server(2)), { code: 'STORAGE_IO', growthPending: true });
  const pending = JSON.parse(await fs.readFile(f.record)); assert.equal(pending.bytes, GIB); assert.equal(pending.pendingGrowBytes, 2 * GIB);
  assert.equal(await f.controller.growthAdditionalBytes(server(2)), 16 * 1024 ** 2);
  assert.equal(f.records.some(row => row.value.bytes === 2 * GIB && row.value.pendingGrowBytes === null), false);
  const resizeCount = f.calls.filter(row => row.tool === 'resize2fs').length; f.faults.value = null;
  assert.equal((await f.controller.grow(server(2))).hardEnforced, true); assert.equal(f.calls.filter(row => row.tool === 'resize2fs').length, resizeCount);
  assert.equal(await f.controller.growthAdditionalBytes(server(2)), 0);
  assert.equal(JSON.parse(await fs.readFile(f.record)).filesystemUUID, original.filesystemUUID); assert.equal(await fs.readFile(f.image, 'utf8'), 'preserve real bytes');
});

test('explicit same-policy retry can repair an older finalized image without formatting or resizing it', async t => {
  const f = await fixture(t); await f.controller.provision(server(2));
  const before = JSON.parse(await fs.readFile(f.record)), inode = (await fs.lstat(f.image)).ino;
  await fs.writeFile(f.image, 'old completed image');
  f.physicalBytes.set(f.image, 2 * GIB - 16 * 1024 ** 2);
  assert.equal(await f.controller.growthAdditionalBytes(server(2)), 16 * 1024 ** 2);
  const formats = f.calls.filter(row => row.tool === 'mkfs.ext4').length;
  assert.equal((await f.controller.grow(server(2))).hardEnforced, true);
  assert.equal(f.calls.filter(row => row.tool === 'mkfs.ext4').length, formats); assert.equal(f.calls.some(row => row.tool === 'resize2fs'), false);
  assert.equal((await fs.lstat(f.image)).ino, inode); assert.deepEqual(JSON.parse(await fs.readFile(f.record)), before); assert.equal(await fs.readFile(f.image, 'utf8'), 'old completed image');
});

test('legacy usage is bounded/cached and a failed measurement remains unknown instead of zero', async t => {
  let clock = Date.now();
  const f = await fixture(t, { now: () => clock }), legacy = { id: ID };
  await fs.mkdir(f.target);
  const first = await f.controller.stats(legacy); assert.equal(first.usedBytes, 1234567890); assert.equal(first.hardEnforced, false); assert.equal(first.limitBytes, null);
  await f.controller.stats(legacy); assert.equal(f.calls.filter(call => call.tool === 'du').length, 1);
  clock += 5001; await f.controller.stats(legacy); assert.equal(f.calls.filter(call => call.tool === 'du').length, 2);
  f.faults.value = 'du'; const failed = await f.controller.stats(legacy, { fresh: true });
  assert.equal(failed.usedBytes, null); assert.equal(failed.hardEnforced, false); assert.ok(failed.reason);
  const du = f.calls.find(call => call.tool === 'du'); assert.ok(du.args.includes('--one-file-system')); assert.equal(du.timeout, 15000);
});

test('server and ownership-record path tampering cannot reach another image', async t => {
  const f = await fixture(t);
  await assert.rejects(f.controller.provision({ id: '../foreign', storagePolicy: server().storagePolicy }), { code: 'STORAGE_INPUT' });
  await f.controller.provision(server()); await f.controller.unmount(server());
  const record = JSON.parse(await fs.readFile(f.record)); record.serverId = SECOND; await fs.writeFile(f.record, JSON.stringify(record));
  await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_PATH' });
  assert.equal((await fs.stat(f.image)).isFile(), true);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'vortex-storage-foreign-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.rmdir(f.target); await fs.symlink(external, f.target, process.platform === 'win32' ? 'junction' : 'dir');
  record.serverId = ID; await fs.writeFile(f.record, JSON.stringify(record));
  await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_PATH' });
});

function blockRecordRead(f, id = ID) {
  const original = f.io.lstat, record = path.join(f.dataDir, '.storage', `${id.toLowerCase()}.json`);
  let armed = true, enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const released = new Promise(resolve => { releaseResolve = resolve; });
  f.io.lstat = async filename => {
    if (armed && filename === record) { armed = false; enteredResolve(); await released; }
    return original(filename);
  };
  return {
    async entered() {
      let timer;
      try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned record read did not enter its bounded gate')), 5000); })]); }
      finally { clearTimeout(timer); }
    },
    release() { armed = false; releaseResolve(); f.io.lstat = original; },
  };
}
function track(pending, promise) { pending.push(promise); promise.catch(() => {}); return promise; }

test('overlapping same-policy ensureMounted calls share one fresh owned verification without mutating the volume', async t => {
  const f = await fixture(t); await f.controller.provision(server());
  const before = f.calls.length, gate = blockRecordRead(f), pending = [];
  try {
    const first = track(pending, f.controller.ensureMounted(server())); await gate.entered();
    const second = track(pending, f.controller.ensureMounted(server()));
    const third = track(pending, f.controller.ensureMounted({ storagePolicy: { diskGiB: 1, mode: 'fixed' }, id: ID }));
    gate.release(); const results = await Promise.all([first, second, third]);
    for (const result of results) { assert.equal(result.hardEnforced, true); assert.equal(result.desiredLimitBytes, GIB); assert.deepEqual(result, results[0]); }
    assert.notStrictEqual(results[0], results[1]); results[0].usedBytes = -1; assert.ok(results[1].usedBytes >= 0);
    const calls = f.calls.slice(before); assert.equal(calls.filter(row => row.tool === 'dumpe2fs').length, 1);
    assert.equal(calls.some(row => ['mount', 'umount', 'mkfs.ext4', 'fallocate', 'resize2fs'].includes(row.tool)), false);
  } finally { gate.release(); await Promise.allSettled(pending); }
});

test('ensureMounted snapshots canonical identity and policy while different or invalid policies cannot join', async t => {
  const f = await fixture(t), id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef', owned = { id, storagePolicy: { mode: 'fixed', diskGiB: 1 } };
  await f.controller.provision(owned); const input = { id: id.toUpperCase(), storagePolicy: { diskGiB: 1, mode: 'fixed' } }, gate = blockRecordRead(f, id), pending = [];
  try {
    const first = track(pending, f.controller.ensureMounted(input)); await gate.entered();
    input.id = SECOND; input.storagePolicy.diskGiB = 2;
    const joined = track(pending, f.controller.ensureMounted(owned));
    await assert.rejects(f.controller.ensureMounted({ id, storagePolicy: { mode: 'fixed', diskGiB: 2 } }), { code: 'STORAGE_BUSY' });
    await assert.rejects(f.controller.ensureMounted({ id, storagePolicy: { mode: 'fixed', diskGiB: '1' } }), { code: 'STORAGE_POLICY' });
    gate.release(); for (const result of await Promise.all([first, joined])) assert.equal(result.desiredLimitBytes, GIB);
    await assert.rejects(fs.stat(path.join(f.dataDir, '.storage', `${SECOND}.img`)), { code: 'ENOENT' });
  } finally { gate.release(); await Promise.allSettled(pending); }
});

test('an in-flight mounted check retains exclusive admission against all mutators', async t => {
  const f = await fixture(t); await f.controller.provision(server()); const gate = blockRecordRead(f), pending = [];
  try {
    const first = track(pending, f.controller.ensureMounted(server())); await gate.entered(); const before = f.calls.length;
    for (const mutate of [() => f.controller.provision(server()), () => f.controller.unmount(server()), () => f.controller.remove(server()), () => f.controller.grow(server(2))]) await assert.rejects(mutate(), { code: 'STORAGE_BUSY' });
    assert.equal(f.calls.length, before); gate.release(); assert.equal((await first).hardEnforced, true);
  } finally { gate.release(); await Promise.allSettled(pending); }
});

test('ensureMounted never joins provision, unmount, remove or grow operations', async t => {
  for (const kind of ['provision', 'unmount', 'remove', 'grow']) {
    const f = await fixture(t);
    if (kind !== 'provision') await f.controller.provision(server());
    if (kind === 'remove') await f.controller.unmount(server());
    const gate = blockRecordRead(f), pending = [];
    try {
      const mutation = track(pending, f.controller[kind](kind === 'grow' ? server(2) : server())); await gate.entered(); const before = f.calls.length;
      await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_BUSY' }); assert.equal(f.calls.length, before);
      gate.release(); await mutation;
      if (kind === 'remove') await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_MISSING' });
      else assert.equal((await f.controller.ensureMounted(kind === 'grow' ? server(2) : server())).hardEnforced, true);
    } finally { gate.release(); await Promise.allSettled(pending); }
  }
});

test('a failed shared verification rejects every waiter once and an explicit later check verifies again', async t => {
  const f = await fixture(t); await f.controller.provision(server()); const owned = f.mounts.get(f.target), before = f.calls.length, gate = blockRecordRead(f), pending = [];
  try {
    const first = track(pending, f.controller.ensureMounted(server())); await gate.entered(); const second = track(pending, f.controller.ensureMounted(server()));
    f.mounts.set(f.target, { image: '/foreign/image.img', source: '/dev/loop99' }); gate.release(); const results = await Promise.allSettled([first, second]);
    for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'STORAGE_FOREIGN'); }
    assert.equal(f.calls.slice(before).filter(row => row.tool === 'dumpe2fs').length, 1); assert.equal(f.calls.slice(before).some(row => row.tool === 'umount'), false);
    f.mounts.set(f.target, owned); assert.equal((await f.controller.ensureMounted(server())).hardEnforced, true);
    assert.equal(f.calls.slice(before).filter(row => row.tool === 'dumpe2fs').length, 2);
  } finally { gate.release(); await Promise.allSettled(pending); }
});

test('completed mount checks are never reused after ownership, physical allocation or record availability changes', async t => {
  const f = await fixture(t); await f.controller.provision(server()); await Promise.all([f.controller.ensureMounted(server()), f.controller.ensureMounted(server())]);
  const record = await fs.readFile(f.record, 'utf8'); await fs.writeFile(f.record, JSON.stringify({ ...JSON.parse(record), serverId: SECOND }));
  await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_PATH' });
  await fs.writeFile(f.record, record); f.physicalBytes.set(f.image, 0); await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_ALLOCATION' });
  f.physicalBytes.set(f.image, GIB); assert.equal((await f.controller.ensureMounted(server())).hardEnforced, true);
  await fs.unlink(f.record); await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_MISSING' }); assert.equal((await fs.stat(f.image)).isFile(), true);
});

test('one server verification does not serialize another server through a shared mount-check cache', async t => {
  const f = await fixture(t), second = { id: SECOND, storagePolicy: { mode: 'fixed', diskGiB: 1 } };
  await f.controller.provision(server()); await f.controller.provision(second); const gate = blockRecordRead(f), pending = [];
  try {
    const first = track(pending, f.controller.ensureMounted(server())); await gate.entered();
    assert.equal((await f.controller.ensureMounted(second)).hardEnforced, true); gate.release(); assert.equal((await first).hardEnforced, true);
  } finally { gate.release(); await Promise.allSettled(pending); }
});

test('shutdown drains accepted verification waiters but never accepts a new join after close', async t => {
  const f = await fixture(t); await f.controller.provision(server()); const gate = blockRecordRead(f), pending = [];
  try {
    const first = track(pending, f.controller.ensureMounted(server())); await gate.entered(); const second = track(pending, f.controller.ensureMounted(server()));
    const closing = track(pending, f.controller.close()); await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_CLOSED', status: 503 });
    gate.release(); for (const result of await Promise.all([first, second])) assert.equal(result.hardEnforced, true); await closing;
    await assert.rejects(f.controller.ensureMounted(server()), { code: 'STORAGE_CLOSED', status: 503 });
  } finally { gate.release(); await Promise.allSettled(pending); }
});
