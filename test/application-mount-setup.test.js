import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { APPLICATION_MOUNT_SETUP } from '../server/application-runtime.js';

// Execute the actual fixed Python program with only mount/process primitives
// modeled. No test creates a real mount or namespace, or changes host files.
const model = `import os, sys, json, stat, ctypes, builtins, io, types
mode = sys.argv.pop(1)
calls = []
original_write = os.write
original_exit = os._exit
def exit_result(code):
    original_write(3,json.dumps(normalize(calls)).encode())
    original_exit(code)
os._exit = exit_result
os.getuid = lambda: 0
os.geteuid = lambda: 1000 if mode == 'nonroot' else 0
os.getppid = lambda: 77
os.path.join = __import__('posixpath').join
def status(filename):
    if filename in ('/usr/bin/mawk', '/mnt/core-awk'):
        return types.SimpleNamespace(st_mode=stat.S_IFREG | (0o644 if mode == 'core-not-executable' else 0o777 if mode == 'core-writable-after-check' else 0o755), st_nlink=2 if mode == 'core-hardlink' else 1, st_ino=41 if mode == 'core-exchanged' and filename == '/mnt/core-awk' else 40, st_dev=4, st_uid=60001 if mode == 'core-owner-after-check' else 0, st_gid=0)
    if filename in ('/private/cache/node', '/mnt/runtime-node'):
        return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_ino=30 if mode != 'runtime-exchanged' or filename != '/mnt/runtime-node' else 31, st_dev=4, st_uid=0, st_gid=0)
    if filename == '.':
        return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_ino=10, st_dev=4, st_uid=60001 if mode != 'foreign-cwd' else 60002, st_gid=60001)
    if filename == '/mnt/workspace':
        return types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_ino=10 if mode != 'alias-replaced' else 11, st_dev=4, st_uid=60001, st_gid=60001)
    return types.SimpleNamespace(st_ino=100 if mode == 'host-namespace' or filename == '/proc/77/ns/mnt' else 200)
os.stat = status
def lstatus(filename):
    if filename == '/usr/bin/mawk':
        return types.SimpleNamespace(st_mode=(stat.S_IFLNK if mode == 'core-link' else stat.S_IFREG) | (0o777 if mode == 'core-writable' else 0o755), st_uid=60001 if mode == 'core-owner' else 0)
    return types.SimpleNamespace(st_mode=(stat.S_IFLNK if mode == 'symlink-target' or mode == 'runtime-link' and filename == '/private/cache' else stat.S_IFDIR) | (0o777 if mode == 'writable-target' or mode == 'runtime-writable' and filename == '/private/cache' or mode == 'core-ancestor-writable' and filename == '/usr/bin' else 0o755), st_uid=0)
os.lstat = lstatus
os.path.realpath = lambda filename: '/foreign' if mode == 'noncanonical-target' or mode == 'core-noncanonical' and filename == '/usr/bin/mawk' else filename
def open_file(filename,*args,**kwargs):
    if filename != '/proc/self/mountinfo': raise ValueError()
    fields = ' shared:3' if mode == 'shared' else ' master:3' if mode == 'slave' else ''
    extra = '2 1 8:2 / /mnt/runtime-node ' + ('rw,nosuid,nodev' if mode == 'runtime-not-readonly' else 'ro,nosuid,nodev') + ' - ext4 /dev/runtime ro\\n' if any(call[:2] == ['mkdir','/mnt/runtime-node'] for call in calls) else ''
    core = '3 1 8:2 / /mnt/core-awk ' + ('rw,nosuid,nodev' if mode == 'core-not-readonly' else 'ro,nosuid,nodev') + ' - ext4 /dev/tool ro\\n' if any(call[:2] == ['open','/mnt/core-awk'] for call in calls) else ''
    return io.StringIO('1 0 8:1 / / rw' + fields + ' - ext4 /dev/root rw\\n' + extra + core)
builtins.open = open_file
class Mount:
    def __call__(self,*args):
        calls.append(['mount',*args])
        return -1 if mode == 'tmpfs-failed' or mode == 'bind-failed' and len(calls) == 3 or mode == 'runtime-remount-failed' and args[0] is None or mode == 'core-remount-failed' and args[0] is None and args[1] == b'/mnt/core-awk' else 0
mount = Mount()
ctypes.CDLL = lambda *args,**kwargs: types.SimpleNamespace(mount=mount)
os.mkdir = lambda directory,mode: calls.append(['mkdir',directory,mode])
os.O_NOFOLLOW = getattr(os,'O_NOFOLLOW',131072)
def open_alias(filename,flags,mode):
    calls.append(['open',filename,flags,mode]);return 9
os.open = open_alias
os.close = lambda descriptor: calls.append(['close',descriptor])
def normalize(value):
    if isinstance(value,bytes): return value.decode()
    if isinstance(value,(list,tuple)): return [normalize(item) for item in value]
    return value
def execute(filename,args,env):
    result={'executable':filename,'args':args,'calls':normalize(calls),'stdin':os.read(0,4096).decode()}
    original_write(1,json.dumps(result).encode());os._exit(0)
os.execve = execute
`;
async function run(mode, runtimeMounts = [], coreAliases = []) {
  const identity = { uid: 60001, gid: 60001, ino: 10, dev: 4, setpriv: '/usr/bin/setpriv', runtimeMounts, coreAliases };
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', model + APPLICATION_MOUNT_SETUP, mode, JSON.stringify(identity), '--reuid=60001', '/usr/bin/bwrap', '--', 'literal;$(not-a-shell)'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true, env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  let stdout = '', stderr = '', trace = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.stdio[3].on('data', chunk => trace += chunk);
  child.stdin.end('private-frame\nsubsequent-console\n');
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr, calls: JSON.parse(trace) })); });
}

test('trusted setup mounts only the private alias then execs setpriv literally without consuming stdin', async () => {
  const result = await run('valid'); assert.equal(result.code, 0); assert.equal(result.stderr, ''); const value = JSON.parse(result.stdout);
  assert.equal(value.executable, '/usr/bin/setpriv'); assert.deepEqual(value.args, ['/usr/bin/setpriv', '--reuid=60001', '/usr/bin/bwrap', '--', 'literal;$(not-a-shell)']);
  assert.deepEqual(value.calls, [['mount', 'tmpfs', '/mnt', 'tmpfs', 14, 'size=1048576,mode=755'], ['mkdir', '/mnt/workspace', 493], ['mount', '/proc/self/cwd', '/mnt/workspace', null, 4096, null]]);
  assert.equal(value.stdin, 'private-frame\nsubsequent-console\n');
});

test('the actual fixed helper refuses host/shared namespace, foreign cwd or unsafe target without mounting', async () => {
  for (const mode of ['nonroot', 'host-namespace', 'shared', 'slave', 'foreign-cwd', 'symlink-target', 'writable-target', 'noncanonical-target']) {
    const result = await run(mode); assert.equal(result.code, 126, mode); assert.equal(result.stdout, '', mode); assert.equal(result.stderr, 'Application private mount setup failed.\n', mode); assert.deepEqual(result.calls, [], mode);
  }
});

test('failed tmpfs/bind or exchanged alias never reaches the privilege drop/application payload', async () => {
  for (const mode of ['tmpfs-failed', 'bind-failed', 'alias-replaced']) {
    const result = await run(mode); assert.equal(result.code, 126, mode); assert.equal(result.stdout, '', mode); assert.equal(result.stderr, 'Application private mount setup failed.\n', mode);
  }
});
test('private runtime cache is aliased and verified read-only before UID drop without exposing its private parent', async () => {
  const mounts = [{ source: '/private/cache/node', target: '/mnt/runtime-node', ino: 30, dev: 4 }];
  const result = await run('valid', mounts); assert.equal(result.code, 0); const value = JSON.parse(result.stdout);
  assert.ok(value.calls.some(row => row[0] === 'mount' && row[1] === '/private/cache/node' && row[2] === '/mnt/runtime-node' && row[4] === 4096));
  assert.ok(value.calls.some(row => row[0] === 'mount' && row[1] === null && row[2] === '/mnt/runtime-node' && row[4] === 4135));
  for (const mode of ['runtime-exchanged', 'runtime-link', 'runtime-writable', 'runtime-not-readonly', 'runtime-remount-failed']) { const denied = await run(mode, mounts); assert.equal(denied.code, 126, mode); assert.equal(denied.stdout, '', mode); }
  for (const invalid of [[{ ...mounts[0], target: '/root' }], [mounts[0], mounts[0]], [{ ...mounts[0], ino: 31 }]]) assert.equal((await run('valid', invalid)).code, 126);
});
test('fixed core executable aliases verify their original inode and read-only bind before UID drop', async () => {
  const alias = { name: 'awk', source: '/usr/bin/mawk', target: '/mnt/core-awk', ino: 40, dev: 4 };
  const result = await run('valid', [], [alias]); assert.equal(result.code, 0); const value = JSON.parse(result.stdout);
  assert.ok(value.calls.some(row => row[0] === 'open' && row[1] === alias.target));
  assert.ok(value.calls.some(row => row[0] === 'mount' && row[1] === alias.source && row[2] === alias.target && row[4] === 4096));
  assert.ok(value.calls.some(row => row[0] === 'mount' && row[1] === null && row[2] === alias.target && row[4] === 4135));
  assert.equal(value.executable, '/usr/bin/setpriv'); assert.equal(value.stdin, 'private-frame\nsubsequent-console\n');
  for (const mode of ['core-owner', 'core-writable', 'core-link', 'core-ancestor-writable', 'core-noncanonical', 'core-hardlink', 'core-not-executable', 'core-exchanged', 'core-not-readonly', 'core-remount-failed', 'core-owner-after-check', 'core-writable-after-check']) { const denied = await run(mode, [], [alias]); assert.equal(denied.code, 126, mode); assert.equal(denied.stdout, '', mode); }
  for (const invalid of [[{ ...alias, source: '/root/foreign' }], [{ ...alias, target: '/mnt/other' }], [{ ...alias, name: 'python' }], [{ ...alias, ino: 41 }], [{ ...alias, injected: true }], [alias, alias]]) assert.equal((await run('valid', [], invalid)).code, 126);
});
