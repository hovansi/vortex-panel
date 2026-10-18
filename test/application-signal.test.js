import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { APPLICATION_SIGNAL } from '../server/application-runtime.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const expected = { root: '/cg', relative: '/system.slice/unit/vortex-server-owned', ino: 123, dev: 4, uid: 60001, gid: 60001, supervisor: 111, supervisorExecutable: '/usr/bin/bwrap', executables: ['/runtime/node/bin/node'] };
// Execute the actual Python verifier against a process/cgroup model. The only
// signal syscall is replaced; no real PID is opened or signaled by this test.
const model = `import os, sys, json, signal, builtins, io, types
mode = sys.argv.pop(1)
expected = json.loads(sys.argv[1])
scope = expected['root'] + expected['relative']
calls = []
files = {scope + '/cgroup.procs': '111 112 222'}
for pid, parent, nspid in [(111, 77, '111'), (112, 111, '112 1'), (222, 112, '222 2')]:
    base = '/proc/' + str(pid)
    files[base + '/status'] = 'Uid: 60001 60001 60001 60001\\nGid: 60001 60001 60001 60001\\nNSpid: ' + nspid + '\\n'
    fields = ['S', str(parent)] + ['0'] * 17 + [str(pid * 10)]
    files[base + '/stat'] = str(pid) + ' (process name) ' + ' '.join(fields)
    files[base + '/cgroup'] = '0::' + expected['relative']
if mode == 'foreign-uid': files['/proc/222/status'] = files['/proc/222/status'].replace('60001', '60002')
if mode == 'foreign-cgroup': files['/proc/222/cgroup'] = '0::/foreign'
if mode == 'wrong-parent': files['/proc/112/stat'] = files['/proc/112/stat'].replace('S 111 ', 'S 999 ')
if mode == 'absent': files[scope + '/cgroup.procs'] = '111 112'
executables = {111: '/usr/bin/bwrap', 112: '/usr/bin/bwrap', 222: '/runtime/node/bin/node'}
if mode.startswith('npm-'):
    expected['npmScript'] = True
    files[scope + '/cgroup.procs'] = '111 112 222 333 444 555'
    for pid, parent, executable in [(333, 222, '/usr/bin/dash'), (444, 333, '/runtime/node/bin/node'), (555, 444, '/runtime/node/bin/node')]:
        base = '/proc/' + str(pid)
        files[base + '/status'] = files['/proc/222/status'].replace('222 2', str(pid) + ' ' + str(pid // 111 + 1))
        files[base + '/stat'] = str(pid) + ' (application process) ' + ' '.join(['S', str(parent)] + ['0'] * 17 + [str(pid * 10)])
        files[base + '/cgroup'] = '0::' + expected['relative']
        executables[pid] = executable
    if mode in ('npm-multiple', 'npm-second-open-fails', 'npm-recycled-after-open', 'npm-ancestor-reparented', 'npm-ancestor-recycled', 'npm-ancestor-cgroup', 'npm-ancestor-uid', 'npm-target-reexec', 'npm-supervisor-changed', 'npm-scope-replaced', 'npm-send-partial', 'npm-send-first-fails', 'npm-zero-delivery', 'npm-target-exits'):
        files[scope + '/cgroup.procs'] += ' 666'
        for suffix in ('status', 'stat', 'cgroup'): files['/proc/666/' + suffix] = files['/proc/444/' + suffix].replace('444', '666').replace('4440', '6660')
        executables[666] = '/runtime/node/bin/node'
    if mode == 'npm-no-app': files[scope + '/cgroup.procs'] = '111 112 222 333'
    if mode == 'npm-foreign-uid': files['/proc/333/status'] = files['/proc/333/status'].replace('60001', '60002')
    if mode == 'npm-foreign-gid': files['/proc/333/status'] = files['/proc/333/status'].replace('Gid: 60001', 'Gid: 60002')
    if mode == 'npm-foreign-cgroup': files['/proc/333/cgroup'] = '0::/foreign'
    if mode == 'npm-parent-cycle': files['/proc/333/stat'] = files['/proc/333/stat'].replace('S 222 ', 'S 444 ')
    if mode == 'npm-missing-ancestor': files[scope + '/cgroup.procs'] = '111 112 222 444 555'
    if mode == 'npm-duplicate-inventory': files[scope + '/cgroup.procs'] += ' 444'
    if mode == 'npm-too-many': files[scope + '/cgroup.procs'] = ' '.join(str(pid) for pid in range(1000, 1513))
    if mode == 'npm-too-many-roots':
        files[scope + '/cgroup.procs'] = '111 112 222 333 ' + ' '.join(str(pid) for pid in range(1000, 1129))
        for pid in range(1000, 1129):
            for suffix in ('status', 'stat', 'cgroup'): files['/proc/' + str(pid) + '/' + suffix] = files['/proc/444/' + suffix].replace('444', str(pid))
            executables[pid] = '/runtime/node/bin/node'
    if mode == 'npm-wrong-wrapper-exe': executables[222] = '/foreign/npm'
original_write = os.write
def write(fd, data):
    if fd == 1:
        value = json.loads(data)
        value['calls'] = calls
        data = json.dumps(value).encode('utf-8')
    return original_write(fd, data)
os.write = write
def open_file(path, *args, **kwargs):
    calls.append('read:' + path)
    if path not in files: raise FileNotFoundError()
    return io.StringIO(files[path])
builtins.open = open_file
os.path.realpath = lambda path: path
replaced = False
os.lstat = lambda path: types.SimpleNamespace(st_ino=124 if replaced else 123, st_dev=4)
os.stat = lambda path: types.SimpleNamespace(st_ino=1 if path == '/proc/111/ns/pid' else 3 if mode == 'npm-foreign-namespace' and path == '/proc/333/ns/pid' else 2)
os.readlink = lambda path: '/foreign/executable' if mode == 'wrong-exe' and path != '/proc/111/exe' else executables[int(path.split('/')[2])]
def pidfd_open(pid, flags):
    global replaced
    calls.append('pidfd-open:' + str(pid))
    if mode == 'recycled': files['/proc/222/stat'] = files['/proc/222/stat'].replace('2220', '9999')
    if mode == 'scope-replaced': replaced = True
    if pid == 666:
        if mode == 'npm-second-open-fails': raise PermissionError()
        if mode == 'npm-recycled-after-open': files['/proc/444/stat'] = files['/proc/444/stat'].replace('4440', '9999')
        if mode == 'npm-ancestor-reparented': files['/proc/333/stat'] = files['/proc/333/stat'].replace('S 222 ', 'S 999 ')
        if mode == 'npm-ancestor-recycled': files['/proc/333/stat'] = files['/proc/333/stat'].replace('3330', '9999')
        if mode == 'npm-ancestor-cgroup': files['/proc/333/cgroup'] = '0::/foreign'
        if mode == 'npm-ancestor-uid': files['/proc/333/status'] = files['/proc/333/status'].replace('60001', '60002')
        if mode == 'npm-target-reexec': executables[444] = '/foreign/replaced'
        if mode == 'npm-supervisor-changed': files['/proc/111/stat'] = files['/proc/111/stat'].replace('1110', '9999')
        if mode == 'npm-scope-replaced': replaced = True
    return 1000 + pid if mode.startswith('npm-') else 99
os.pidfd_open = pidfd_open
os.close = lambda descriptor: calls.append('close:' + str(descriptor))
def send(descriptor, sig, info, flags):
    calls.append('signal:' + str(descriptor) + ':' + str(int(sig)))
    if mode == 'npm-send-partial' and descriptor == 1666 or mode == 'npm-send-first-fails' and descriptor == 1444 or mode == 'npm-zero-delivery': raise PermissionError()
    if mode == 'npm-target-exits' and descriptor == 1444: raise ProcessLookupError()
    if mode.startswith('npm-'): calls.append('application-handler:' + str(descriptor - 1000))
    original_write(2, b'MODEL_SIGNAL_SENT\\n')
signal.pidfd_send_signal = send
original_exit = os._exit
def exit_with_trace(code):
    if mode.startswith('npm-') and code != 0: original_write(2, b'MODEL_TRACE=' + json.dumps(calls).encode() + b'\\n')
    original_exit(code)
os._exit = exit_with_trace
`;
async function verify(mode) {
  const child = spawn(python, ['-I', '-c', model + APPLICATION_SIGNAL, mode, JSON.stringify({ ...expected, npmScript: mode.startsWith('npm-') })], { env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
}

test('pidfd verifier selects only namespace PID2 under the exact supervisor and rechecks identity after opening', async () => {
  const result = await verify('valid'); assert.equal(result.code, 0); const value = JSON.parse(result.stdout); assert.equal(value.sent, true); assert.equal(value.pid, 222); assert.equal(value.signal, 'SIGTERM');
  const opened = value.calls.indexOf('pidfd-open:222'), signaled = value.calls.indexOf('signal:99:15'); assert.ok(opened > 0); assert.ok(signaled > opened); assert.ok(value.calls.slice(opened + 1, signaled).includes('read:/proc/222/stat')); assert.equal(value.calls.at(-1), 'close:99'); assert.ok(!value.calls.some(name => name.includes('/proc/999/')));
  const absent = await verify('absent'); assert.equal(absent.code, 0); assert.deepEqual({ ...JSON.parse(absent.stdout), calls: undefined }, { sent: false, reason: 'not-running', calls: undefined }); assert.equal(absent.stderr, '');
});

test('pidfd verifier refuses foreign UID/cgroup/ancestry/executable, recycled PID and replaced scope without signaling', async () => {
  for (const mode of ['foreign-uid', 'foreign-cgroup', 'wrong-parent', 'wrong-exe', 'recycled', 'scope-replaced']) {
    const result = await verify(mode); assert.equal(result.code, 126, mode); assert.equal(result.stdout, '', mode); assert.equal(result.stderr, 'Application signal verification failed.\n', mode);
  }
});

test('npm signals the actual application root through its shell, excluding wrapper and nested workers', async () => {
  const result = await verify('npm-valid'); assert.equal(result.code, 0, result.stderr); const value = JSON.parse(result.stdout);
  assert.deepEqual(value.pids, [444]); assert.equal(value.pid, 444); assert.ok(value.calls.includes('application-handler:444'));
  assert.equal(value.calls.some(call => /pidfd-open:(?:222|333|555)$/.test(call)), false);
  assert.equal(value.calls.filter(call => call.startsWith('signal:')).length, 1); assert.ok(value.calls.includes('close:1444'));
  const absent = await verify('npm-no-app'); assert.equal(absent.code, 0); const noApp = JSON.parse(absent.stdout); assert.equal(noApp.sent, false); assert.equal(noApp.calls.some(call => call.startsWith('pidfd-open:') || call.startsWith('signal:')), false);
});

test('multiple npm application roots open every pidfd and recheck the complete ancestry before the first signal', async () => {
  const result = await verify('npm-multiple'); assert.equal(result.code, 0, result.stderr); const value = JSON.parse(result.stdout); assert.deepEqual(value.pids, [444, 666]);
  const lastOpen = value.calls.indexOf('pidfd-open:666'), firstSignal = value.calls.findIndex(call => call.startsWith('signal:')); assert.ok(lastOpen > 0 && firstSignal > lastOpen);
  for (const pid of [111, 112, 222, 333, 444, 666]) assert.ok(value.calls.slice(lastOpen + 1, firstSignal).includes(`read:/proc/${pid}/stat`), `Recheck ${pid} before delivery`);
  assert.deepEqual(value.calls.filter(call => call.startsWith('application-handler:')), ['application-handler:444', 'application-handler:666']);
  assert.deepEqual(value.calls.slice(-2), ['close:1444', 'close:1666']);
});

test('npm refuses foreign intermediates, unsafe topology and inventory bounds before opening or signaling any target', async () => {
  for (const mode of ['npm-foreign-uid', 'npm-foreign-gid', 'npm-foreign-cgroup', 'npm-foreign-namespace', 'npm-parent-cycle', 'npm-missing-ancestor', 'npm-duplicate-inventory', 'npm-too-many', 'npm-too-many-roots', 'npm-wrong-wrapper-exe']) {
    const result = await verify(mode); assert.equal(result.code, 126, mode); assert.equal(result.stdout, '', mode); assert.equal(result.stderr.includes('MODEL_SIGNAL_SENT'), false, mode);
    const trace = JSON.parse(result.stderr.match(/MODEL_TRACE=(.*)/)[1]); assert.equal(trace.some(call => call.startsWith('pidfd-open:') || call.startsWith('signal:')), false, mode);
  }
});

test('npm revalidates target, supervisor, scope and every intermediate after all opens, closing acquired descriptors on refusal', async () => {
  for (const mode of ['npm-second-open-fails', 'npm-recycled-after-open', 'npm-ancestor-reparented', 'npm-ancestor-recycled', 'npm-ancestor-cgroup', 'npm-ancestor-uid', 'npm-target-reexec', 'npm-supervisor-changed', 'npm-scope-replaced']) {
    const result = await verify(mode); assert.equal(result.code, 126, mode); assert.equal(result.stdout, '', mode); assert.equal(result.stderr.includes('MODEL_SIGNAL_SENT'), false, mode);
    const trace = JSON.parse(result.stderr.match(/MODEL_TRACE=(.*)/)[1]); assert.equal(trace.some(call => call.startsWith('signal:')), false, mode); assert.ok(trace.includes('close:1444'), mode);
    if (mode !== 'npm-second-open-fails') assert.ok(trace.includes('close:1666'), mode);
  }
});

test('npm acknowledges partial delivery and exited targets without signaling the wrapper or discarding successful delivery', async () => {
  const partial = await verify('npm-send-partial'); assert.equal(partial.code, 0, partial.stderr); const delivered = JSON.parse(partial.stdout);
  assert.equal(delivered.sent, true); assert.equal(delivered.partial, true); assert.deepEqual(delivered.pids, [444]); assert.deepEqual(delivered.pendingPids, [666]); assert.equal(delivered.pid, 444);
  assert.deepEqual(delivered.calls.filter(call => call.startsWith('application-handler:')), ['application-handler:444']); assert.deepEqual(delivered.calls.slice(-2), ['close:1444', 'close:1666']);
  const exited = await verify('npm-target-exits'); assert.equal(exited.code, 0, exited.stderr); const value = JSON.parse(exited.stdout); assert.deepEqual(value.pids, [666]); assert.equal(value.pid, 666); assert.equal(value.partial, undefined);
  assert.equal([...delivered.calls, ...value.calls].some(call => call === 'pidfd-open:222' || call === 'signal:1222:15'), false);
  const firstFailed = await verify('npm-send-first-fails'); assert.equal(firstFailed.code, 0, firstFailed.stderr); const later = JSON.parse(firstFailed.stdout); assert.equal(later.partial, true); assert.deepEqual(later.pids, [666]); assert.deepEqual(later.pendingPids, [444]);
  const none = await verify('npm-zero-delivery'); assert.equal(none.code, 126); assert.equal(none.stderr.includes('MODEL_SIGNAL_SENT'), false); const trace = JSON.parse(none.stderr.match(/MODEL_TRACE=(.*)/)[1]); assert.deepEqual(trace.filter(call => call.startsWith('signal:')), ['signal:1444:15', 'signal:1666:15']); assert.deepEqual(trace.slice(-2), ['close:1444', 'close:1666']);
});
