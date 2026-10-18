import test from 'node:test';
import assert from 'node:assert/strict';
import { probeHostZramCapabilities, hostZramErrorPayload } from '../server/host-zram.js';

function boundary(changes = {}) {
  const calls = [], reads = [], checks = [], inspected = [];
  const helperPath = '/usr/local/libexec/vortex-host-zram.py';
  const options = { role: 'worker', processId: 4321, platform: 'linux', uid: 0,
    io: { accessSync(file) { checks.push(file); if (file === changes.missingTool) throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
      lstatSync(file) {
        inspected.push(file);
        if (file !== helperPath) {
          const unsafe = file === changes.unsafeParent || calls.some(call => call.command.endsWith('systemctl')) && file === changes.lateUnsafeParent;
          return { isDirectory: () => !(unsafe && changes.parentLink), uid: unsafe && changes.parentUid !== undefined ? changes.parentUid : 0, mode: unsafe && changes.parentMode !== undefined ? changes.parentMode : 0o40755 };
        }
        return { isFile: () => !changes.symlink, uid: changes.ownerUid ?? 0, mode: changes.mode ?? 0o100755, nlink: changes.links ?? 1 };
      },
      readFileSync(file) { reads.push(file); return Buffer.from(file === helperPath && changes.altered ? 'untrusted helper' : 'matching immutable helper bytes'); } },
    execFile: async (command, args, commandOptions) => { calls.push({ command, args, commandOptions });
      if (command.endsWith('systemd-detect-virt')) {
        if (changes.container) return { stdout: '' };
        throw Object.assign(Error('not a container'), { code: 1 });
      }
      if (command.endsWith('modprobe')) {
        if (changes.moduleMissing) throw Object.assign(Error('INERT private module error'), { code: 1 });
        return { stdout: '' };
      }
      return { stdout: `MainPID=${changes.mainPid ?? 4321}\nActiveState=${changes.activeState ?? 'active'}\nTimeoutStopUSec=${changes.grace ?? '4min'}\n` };
    }, ...changes.options };
  return { options, calls, reads, checks, inspected };
}

test('zram capability requires the exact managed PID, root, immutable matching helper and sufficient effective service stop grace', async () => {
  for (const grace of ['3min', '4min', '180s', '180000ms', 'infinity']) {
    const f = boundary({ grace });
    assert.deepEqual(await probeHostZramCapabilities(f.options), { available: true, serviceId: 'vortex-node.service' });
    assert.ok(f.checks.includes('/usr/bin/python3')); assert.ok(f.checks.includes('/usr/sbin/modprobe')); assert.ok(f.checks.includes('/usr/sbin/swapoff'));
    const show = f.calls.find(c => c.command.endsWith('systemctl'));
    assert.ok(show.args.includes('--property=TimeoutStopUSec')); assert.ok(show.args.includes('vortex-node.service'));
    assert.equal(show.commandOptions.shell, false);
  }
  for (const change of [{ grace: '1min' }, { grace: '179s' }, { grace: '' }, { grace: 'invalid' }, { mainPid: 9999 }, { activeState: 'inactive' },
    { container: true }, { options: { uid: 1000 } }, { options: { demo: true } }, { options: { platform: 'win32' } }]) {
    await assert.rejects(probeHostZramCapabilities(boundary(change).options), { code: 'ZRAM_UNAVAILABLE' });
  }
  for (const change of [{ altered: true }, { symlink: true }, { ownerUid: 1000 }, { mode: 0o100777 }, { links: 2 }]) {
    await assert.rejects(probeHostZramCapabilities(boundary(change).options), { code: 'ZRAM_OWNERSHIP' });
  }
  const missing = boundary({ missingTool: '/usr/sbin/modprobe' });
  await assert.rejects(probeHostZramCapabilities(missing.options), { code: 'ENOENT' });
  assert.equal(missing.calls.length, 0);
});

test('zram capability checks the running kernel module with fixed read-only arguments and a clear translated missing-support reason', async () => {
  const safe = boundary(); await probeHostZramCapabilities(safe.options);
  const module = safe.calls.find(call => call.command.endsWith('modprobe'));
  assert.deepEqual(module.args, ['--dry-run', '--ignore-install', 'zram', 'num_devices=0']);
  assert.equal(module.command, '/usr/sbin/modprobe'); assert.equal(module.commandOptions.shell, false);
  assert.equal(module.commandOptions.timeout, 8000);
  const missing = boundary({ moduleMissing: true });
  let failure;
  await assert.rejects(probeHostZramCapabilities(missing.options), error => { failure = error; return error.code === 'ZRAM_MODULE'; });
  for (const language of ['en', 'vi']) {
    const value = hostZramErrorPayload(failure, language);
    assert.equal(value.code, 'ZRAM_MODULE'); assert.equal(value.errorI18n.id, 'panel.zram.module');
    assert.ok(value.errorI18n.en.length > 20); assert.ok(value.errorI18n.vi.length > 20);
    assert.equal(value.error, value.errorI18n[language]); assert.doesNotMatch(value.error, /INERT/);
  }
  assert.equal(missing.calls.filter(call => call.command.endsWith('modprobe')).length, 1);
  assert.ok(!missing.calls.some(call => call.command.endsWith('systemctl')), 'A failed dry-run cannot proceed to later capability approval');
});

test('zram runtime refuses linked, writable or nonroot helper ancestors through root and rechecks after async service inspection', async () => {
  const safe = boundary(); await probeHostZramCapabilities(safe.options);
  assert.deepEqual(safe.inspected.slice(0, 5), ['/usr/local/libexec', '/usr/local', '/usr', '/', '/usr/local/libexec/vortex-host-zram.py']);
  for (const unsafeParent of ['/usr/local/libexec', '/usr/local', '/usr', '/']) {
    for (const change of [{ parentLink: true }, { parentUid: 1000 }, { parentMode: 0o40777 }, { parentMode: 0o40775 }]) {
      const f = boundary({ unsafeParent, ...change });
      await assert.rejects(probeHostZramCapabilities(f.options), { code: 'ZRAM_OWNERSHIP' });
      assert.equal(f.calls.length, 0, 'An unsafe ancestor is rejected before executing system tools');
      assert.equal(f.reads.length, 0);
    }
  }
  const changed = boundary({ lateUnsafeParent: '/usr/local/libexec', parentMode: 0o40777 });
  await assert.rejects(probeHostZramCapabilities(changed.options), { code: 'ZRAM_OWNERSHIP' });
  assert.ok(changed.calls.some(call => call.command.endsWith('systemctl')), 'The fresh check catches an ancestor changed during the async probe');
});
