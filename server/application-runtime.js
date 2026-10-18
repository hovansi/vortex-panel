import fs from 'node:fs/promises';
import nativePath from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import { applicationKind, isApplication, normalizeApplication, applicationEnvironment, applicationStarterSources, redactApplicationOutput, applicationIssue } from './application-schema.js';
import { createApplicationRuntimeCatalog, normalizeRuntimePin, publicRuntimePin, PYTHON_BUILD_RESOURCES } from './application-runtime-catalog.js';
import { createManagedRuntimeStore } from './application-managed-runtime.js';
export { APPLICATION_KINDS, APPLICATION_LIMITS, APPLICATION_MESSAGES, normalizeApplication, publicApplication, isApplication, applicationKind, applicationRevision, applicationEnvironmentNameAllowed, applicationEntrypointAllowed, applicationStarterSources, redactApplicationOutput, applicationErrorPayload } from './application-schema.js';

const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const absent = error => error?.code === 'ENOENT';
const TOOLS = Object.freeze({ unshare: '/usr/bin/unshare', setpriv: '/usr/bin/setpriv', bwrap: '/usr/bin/bwrap', python: '/usr/bin/python3', getent: '/usr/bin/getent', useradd: '/usr/sbin/useradd', userdel: '/usr/sbin/userdel', groupdel: '/usr/sbin/groupdel' });
const CONTROL_ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' });
const CORE_ALTERNATIVES = Object.freeze(['awk', 'cc', 'c++', 'cpp']);
// Fixed trusted setup only. unshare execs this interpreter in the same PID in
// a private mount namespace. No application code or ENV is used while root.
export const APPLICATION_MOUNT_SETUP = `import os, sys, json, stat, ctypes, pathlib
try:
    expected = json.loads(sys.argv[1])
    if os.getuid() != 0 or os.geteuid() != 0 or os.stat('/proc/self/ns/mnt').st_ino == os.stat('/proc/' + str(os.getppid()) + '/ns/mnt').st_ino:
        raise ValueError()
    with open('/proc/self/mountinfo', 'r', encoding='utf-8') as stream:
        mountinfo = stream.read(1048577)
    if len(mountinfo) > 1048576 or any(field.startswith(('shared:', 'master:', 'propagate_from:')) for line in mountinfo.splitlines() for field in line.split(' - ', 1)[0].split()[6:]):
        raise ValueError()
    cwd = os.stat('.')
    if not stat.S_ISDIR(cwd.st_mode) or (cwd.st_ino, cwd.st_dev, cwd.st_uid, cwd.st_gid) != (expected['ino'], expected['dev'], expected['uid'], expected['gid']) or expected['uid'] <= 0 or expected['gid'] <= 0:
        raise ValueError()
    target = os.lstat('/mnt')
    if not stat.S_ISDIR(target.st_mode) or stat.S_ISLNK(target.st_mode) or target.st_uid != 0 or target.st_mode & 0o022 or os.path.realpath('/mnt') != '/mnt' or not expected['setpriv'].startswith('/') or len(sys.argv) < 3:
        raise ValueError()
    libc = ctypes.CDLL(None, use_errno=True)
    mount = libc.mount
    mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
    mount.restype = ctypes.c_int
    if mount(b'tmpfs', b'/mnt', b'tmpfs', 2 | 4 | 8, b'size=1048576,mode=755') != 0:
        raise ValueError()
    os.mkdir('/mnt/workspace', 0o755)
    if mount(b'/proc/self/cwd', b'/mnt/workspace', None, 4096, None) != 0:
        raise ValueError()
    alias = os.stat('/mnt/workspace')
    if (alias.st_ino, alias.st_dev, alias.st_uid, alias.st_gid) != (cwd.st_ino, cwd.st_dev, cwd.st_uid, cwd.st_gid):
        raise ValueError()
    runtime_mounts = expected.get('runtimeMounts', [])
    if not isinstance(runtime_mounts, list) or len(runtime_mounts) > 2:
        raise ValueError()
    seen = set()
    for entry in runtime_mounts:
        source, target = entry['source'], entry['target']
        if target not in ('/mnt/runtime-node', '/mnt/runtime-python') or target in seen or not isinstance(source, str) or not source.startswith('/') or os.path.realpath(source) != source:
            raise ValueError()
        seen.add(target); current = '/'
        for part in pathlib.PurePosixPath(source).parts[1:]:
            current = os.path.join(current, part); info = os.lstat(current)
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError()
        original = os.stat(source)
        if original.st_ino != entry['ino'] or original.st_dev != entry['dev']:
            raise ValueError()
        os.mkdir(target, 0o755)
        if mount(os.fsencode(source), os.fsencode(target), None, 4096, None) != 0 or mount(None, os.fsencode(target), None, 4096 | 32 | 1 | 2 | 4, None) != 0:
            raise ValueError()
        bound = os.stat(target)
        if (bound.st_ino, bound.st_dev) != (original.st_ino, original.st_dev):
            raise ValueError()
        with open('/proc/self/mountinfo', 'r', encoding='utf-8') as stream:
            mounts = stream.read(1048577)
        rows = [line.split(' - ', 1)[0].split() for line in mounts.splitlines() if len(line.split(' - ', 1)[0].split()) >= 6 and line.split(' - ', 1)[0].split()[4] == target]
        if len(mounts) > 1048576 or len(rows) != 1 or not {'ro', 'nosuid', 'nodev'}.issubset(set(rows[0][5].split(','))):
            raise ValueError()
    core_aliases = expected.get('coreAliases', [])
    if not isinstance(core_aliases, list) or len(core_aliases) > 4:
        raise ValueError()
    seen = set()
    for entry in core_aliases:
        if not isinstance(entry, dict) or set(entry) != {'name', 'source', 'target', 'ino', 'dev'}:
            raise ValueError()
        name, source, target = entry['name'], entry['source'], entry['target']
        if name not in ('awk', 'cc', 'c++', 'cpp') or name in seen or target != '/mnt/core-' + name or not isinstance(source, str) or not source.startswith('/usr/') or os.path.realpath(source) != source:
            raise ValueError()
        seen.add(name); current = '/'
        for part in pathlib.PurePosixPath(source).parts[1:]:
            current = os.path.join(current, part); info = os.lstat(current)
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or current != source and not stat.S_ISDIR(info.st_mode):
                raise ValueError()
        original = os.stat(source)
        if not stat.S_ISREG(original.st_mode) or original.st_uid != 0 or original.st_mode & 0o022 or original.st_nlink != 1 or not original.st_mode & 0o111 or original.st_ino != entry['ino'] or original.st_dev != entry['dev']:
            raise ValueError()
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        os.close(descriptor)
        if mount(os.fsencode(source), os.fsencode(target), None, 4096, None) != 0 or mount(None, os.fsencode(target), None, 4096 | 32 | 1 | 2 | 4, None) != 0:
            raise ValueError()
        bound = os.stat(target)
        if not stat.S_ISREG(bound.st_mode) or bound.st_uid != 0 or bound.st_mode & 0o022 or bound.st_nlink != 1 or not bound.st_mode & 0o111 or (bound.st_ino, bound.st_dev) != (original.st_ino, original.st_dev):
            raise ValueError()
        with open('/proc/self/mountinfo', 'r', encoding='utf-8') as stream:
            mounts = stream.read(1048577)
        rows = [line.split(' - ', 1)[0].split() for line in mounts.splitlines() if len(line.split(' - ', 1)[0].split()) >= 6 and line.split(' - ', 1)[0].split()[4] == target]
        if len(mounts) > 1048576 or len(rows) != 1 or not {'ro', 'nosuid', 'nodev'}.issubset(set(rows[0][5].split(','))):
            raise ValueError()
    os.execve(expected['setpriv'], [expected['setpriv']] + sys.argv[2:], dict(os.environ))
except BaseException:
    os.write(2, b'Application private mount setup failed.\\n')
    os._exit(126)
`;
export const APPLICATION_ENV_FRAME_BYTES = 96 * 1024;
// This trusted interpreter runs only after UID drop and filesystem/namespace
// setup. Read exactly one frame so later console stdin belongs to the app.
// Do not include rejected input or exception text in the diagnostic.
export const APPLICATION_ENV_HANDOFF = `import os, sys, json
try:
    frame = bytearray()
    while True:
        byte = os.read(0, 1)
        if not byte or len(frame) >= ${APPLICATION_ENV_FRAME_BYTES}:
            raise ValueError()
        if byte == b'\\n':
            break
        frame.extend(byte)
    environment = json.loads(frame.decode('utf-8'))
    if not isinstance(environment, dict) or len(environment) > 96 or not all(isinstance(k, str) and isinstance(v, str) and k and '=' not in k and '\\x00' not in k and '\\x00' not in v for k, v in environment.items()) or len(sys.argv) < 2 or not sys.argv[1].startswith('/'):
        raise ValueError()
    os.execve(sys.argv[1], sys.argv[1:], environment)
except BaseException:
    os.write(2, b'Application environment handoff failed.\\n')
    os._exit(126)
`;
export const APPLICATION_SIGNAL = `import os, sys, json, signal
def finish(value):
    os.write(1, json.dumps(value).encode('utf-8'))
    os._exit(0)
def read(path, limit=131072):
    with open(path, 'r', encoding='utf-8') as stream:
        text = stream.read(limit + 1)
    if len(text) > limit:
        raise ValueError()
    return text
try:
    expected = json.loads(sys.argv[1])
    root = expected['root']
    scope = root + expected['relative']
    npm_script = expected.get('npmScript', False)
    if not isinstance(npm_script, bool):
        raise ValueError()
    def scope_ok():
        current = os.lstat(scope)
        if os.path.realpath(scope) != scope or current.st_ino != expected['ino'] or current.st_dev != expected['dev']:
            raise ValueError()
    def process(pid):
        base = '/proc/' + str(pid)
        status = dict(line.split(':', 1) for line in read(base + '/status').splitlines() if ':' in line)
        ids = [int(v) for v in status['Uid'].split()]
        gids = [int(v) for v in status['Gid'].split()]
        if len(ids) != 4 or any(v != expected['uid'] for v in ids) or len(gids) != 4 or any(v != expected['gid'] for v in gids) or read(base + '/cgroup').strip() != '0::' + expected['relative']:
            raise ValueError()
        stat = read(base + '/stat')
        fields = stat[stat.rfind(')') + 2:].split()
        return {'pid': pid, 'parent': int(fields[1]), 'start': int(fields[19]), 'nspid': [int(v) for v in status['NSpid'].split()], 'namespace': os.stat(base + '/ns/pid').st_ino, 'executable': os.readlink(base + '/exe')}
    scope_ok()
    supervisor = process(expected['supervisor'])
    if supervisor['executable'] != expected['supervisorExecutable']:
        raise ValueError()
    pids = [int(v) for v in read(scope + '/cgroup.procs', 65536).split()]
    if len(pids) > 512 or len(pids) != len(set(pids)) or any(pid <= 1 for pid in pids):
        raise ValueError()
    candidates = []
    inventory, initializers = {}, {}
    for pid in pids:
        try:
            item = process(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        inventory[pid] = item
        if len(item['nspid']) == len(supervisor['nspid']) + 1 and item['nspid'][-1] == 2:
            parent = process(item['parent'])
            if parent['parent'] != supervisor['pid'] or parent['nspid'][-1] != 1 or parent['namespace'] != item['namespace'] or item['executable'] not in expected['executables']:
                raise ValueError()
            initializers[pid] = parent
            candidates.append(item)
    if not candidates:
        finish({'sent': False, 'reason': 'not-running'})
    if len(candidates) != 1:
        raise ValueError()
    target = candidates[0]
    targets, verified = [target], {target['pid']: target}
    if npm_script:
        targets = []
        verified[initializers[target['pid']]['pid']] = initializers[target['pid']]
        for item in inventory.values():
            if item['pid'] == target['pid'] or item['executable'] not in expected['executables']:
                continue
            chain, seen, current = [], {item['pid']}, item
            while current['pid'] != target['pid']:
                if current['namespace'] != target['namespace'] or len(current['nspid']) != len(target['nspid']):
                    raise ValueError()
                parent = inventory.get(current['parent'])
                if parent is None or parent['pid'] in seen or len(chain) >= 512:
                    raise ValueError()
                seen.add(parent['pid']); chain.append(parent); current = parent
            # Signal application roots, allowing each application to stop its
            # own children. The npm PID2 wrapper must never be a fallback target.
            if any(parent['pid'] != target['pid'] and parent['executable'] in expected['executables'] for parent in chain):
                continue
            targets.append(item)
            verified[item['pid']] = item
            for parent in chain:
                verified[parent['pid']] = parent
        if not targets:
            finish({'sent': False, 'reason': 'not-running'})
        if len(targets) > 128:
            raise ValueError()
        targets.sort(key=lambda item: item['pid'])
    descriptors = []
    try:
        for item in targets:
            descriptors.append((item, os.pidfd_open(item['pid'], 0)))
        scope_ok()
        if process(supervisor['pid']) != supervisor:
            raise ValueError()
        for item in verified.values():
            if process(item['pid']) != item:
                raise ValueError()
        sent, pending = [], []
        for item, descriptor in descriptors:
            try:
                signal.pidfd_send_signal(descriptor, signal.SIGTERM, None, 0)
            except ProcessLookupError:
                continue
            except OSError:
                pending.append(item['pid'])
                continue
            sent.append(item['pid'])
    finally:
        for item, descriptor in descriptors:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if not sent:
        if pending:
            raise ValueError()
        finish({'sent': False, 'reason': 'not-running'})
    result = {'sent': True, 'signal': 'SIGTERM', 'pid': sent[0]}
    if npm_script:
        result['pids'] = sent
        if pending:
            result.update(partial=True, pendingPids=pending)
    finish(result)
except (FileNotFoundError, ProcessLookupError):
    finish({'sent': False, 'reason': 'not-running'})
except BaseException:
    os.write(2, b'Application signal verification failed.\\n')
    os._exit(126)
`;

export function createApplicationRuntime(options = {}) {
  const io = options.fs || fs, command = options.execFile || execute, platform = options.platform || process.platform, uid = options.uid ?? process.getuid?.() ?? -1;
  const path = platform === 'linux' ? nativePath.posix : nativePath;
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || 'data'), privateRoot = path.join(dataDir, '.application-users');
  const resourceController = options.resourceController, tools = { ...TOOLS, ...options.tools }, nodePath = options.nodePath || process.execPath;
  const runtimeStorageController = options.storageController;
  const scope = createHash('sha256').update(dataDir).digest('hex').slice(0, 8), active = new Set(), accountLocks = new Map(), controllers = new Set();
  const activeBuildVolumes = new Set();
  const installTimeoutMs = options.installTimeoutMs ?? 600000;
  const runtimeArch = options.arch || process.arch;
  const catalog = options.catalog || createApplicationRuntimeCatalog({ fetch: options.fetch, platform, arch: options.arch || process.arch });
  const managed = options.managedStore || createManagedRuntimeStore({ dataDir, fs: io, fetch: options.fetch, trustedFile, canonical, command: run, python: tools.python, arch: options.arch || process.arch });
  let closed = false, initialized = false, initializing = null, runtime = null;
  let buildPrerequisites = null, buildPrerequisitesAt = 0;
  const catalogStates = new Map();
  let currentCapabilities = { supported: false, isolation: 'nonroot-bubblewrap', hostNetwork: true, networkIsolated: false, reason: applicationIssue('APPLICATION_UNSUPPORTED').message, reasonI18n: applicationIssue('APPLICATION_UNSUPPORTED').errorI18n, runtimes: { nodejs: { available: false, version: null }, python: { available: false, version: null } } };
  const ensureOpen = () => { if (closed) throw applicationIssue('APPLICATION_CLOSED', 503); };
  const idOf = server => { if (!server || !UUID.test(server.id || '') || !isApplication(server)) throw applicationIssue('APPLICATION_INPUT', 400); return server.id; };
  const names = server => { const id = idOf(server); return { id, workspace: path.join(dataDir, 'servers', id, 'run'), record: path.join(privateRoot, id + '.json'), username: `vxapp_${scope}_${id.replaceAll('-', '').slice(0, 16)}` }; };
  const config = server => normalizeApplication(server.application, { kind: applicationKind(server) });
  async function exists(filename) { try { return await io.lstat(filename); } catch (error) { if (absent(error)) return null; throw error; } }
  async function canonical(filename, { file = false, privateMode = false } = {}) {
    if (!path.isAbsolute(filename) || await io.realpath(filename) !== filename) throw applicationIssue('APPLICATION_PATH');
    let current = path.parse(filename).root;
    for (const component of filename.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component); const stat = await io.lstat(current);
      if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022 || current !== filename && !stat.isDirectory()) throw applicationIssue('APPLICATION_PATH');
    }
    const stat = await io.lstat(filename);
    if (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) throw applicationIssue('APPLICATION_PATH');
    if (privateMode && (stat.mode & 0o777) !== (file ? 0o600 : 0o700)) throw applicationIssue('APPLICATION_PATH');
    return stat;
  }
  async function rootPrivateDirectory() {
    await canonical(dataDir);
    if (!await exists(privateRoot)) await io.mkdir(privateRoot, { mode: 0o700 });
    await canonical(privateRoot, { privateMode: true });
  }
  async function trustedFile(filename, executable = false) {
    const resolved = await io.realpath(filename); await canonical(resolved, { file: true });
    const info = await io.lstat(resolved); if (executable && !(info.mode & 0o111)) throw applicationIssue('APPLICATION_PATH');
    return resolved;
  }
  async function coreToolAliases() {
    const aliases = [];
    for (const name of CORE_ALTERNATIVES) {
      const filename = '/etc/alternatives/' + name, info = await exists(filename);
      if (!info) continue;
      await canonical('/etc/alternatives');
      if (info.uid !== 0 || !info.isSymbolicLink() && info.mode & 0o022) throw applicationIssue('APPLICATION_PATH');
      const source = await trustedFile(filename, true);
      if (!source.startsWith('/usr/')) throw applicationIssue('APPLICATION_PATH');
      const identity = await io.lstat(source);
      aliases.push({ name, source, target: '/mnt/core-' + name, ino: identity.ino, dev: identity.dev });
    }
    return aliases;
  }
  async function systemConfiguration(filename) {
    try { return await trustedFile(filename); }
    catch (error) {
      // Ubuntu's DNS stub is maintained by systemd-resolved's dedicated UID.
      // This exception is public, read-only resolver data, never a runtime or
      // arbitrary service-owned path. All other trust rules remain root-only.
      if (filename !== '/etc/resolv.conf' || error.code !== 'APPLICATION_PATH') throw error;
      const resolved = await io.realpath(filename);
      if (!['/run/systemd/resolve/stub-resolv.conf', '/run/systemd/resolve/resolv.conf'].includes(resolved)) throw error;
      await canonical('/run/systemd');
      const service = await lookup('passwd', 'systemd-resolve');
      if (!service || service.length !== 7 || service[0] !== 'systemd-resolve' || !/^\d+$/.test(service[2]) || !/^\d+$/.test(service[3]) || Number(service[2]) <= 0 || Number(service[3]) <= 0) throw error;
      const parent = '/run/systemd/resolve', directory = await io.lstat(parent), file = await io.lstat(resolved);
      if (await io.realpath(parent) !== parent || await io.realpath(resolved) !== resolved || !directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 65536 || [directory, file].some(info => info.uid !== Number(service[2]) || info.gid !== Number(service[3]) || info.mode & 0o022)) throw error;
      return resolved;
    }
  }
  async function run(executable, args, extra = {}) { return command(executable, args, { timeout: 10000, maxBuffer: 65536, env: { ...CONTROL_ENV }, windowsHide: true, ...extra }); }
  async function lookup(database, name) {
    try { const result = await run(tools.getent, [database, name]); const lines = result.stdout.trim().split('\n'); if (lines.length !== 1 || !lines[0]) throw applicationIssue('APPLICATION_ACCOUNT'); return lines[0].split(':'); }
    catch (error) { if (error?.code === 2) return null; throw applicationIssue('APPLICATION_ACCOUNT'); }
  }
  function sandboxArgs(account, commandArgs, selected = runtime) {
    const args = ['--reuid=' + account.uid, '--regid=' + account.gid, '--clear-groups', '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', tools.bwrap,
      '--unshare-user', '--uid', String(account.uid), '--gid', String(account.gid), '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib'];
    if (runtime.lib64) args.push('--symlink', 'usr/lib64', '/lib64');
    if (selected.nodePrefix !== '/usr') args.push('--ro-bind', '/mnt/runtime-node', '/runtime/node');
    if (selected.pythonPrefix) args.push('--ro-bind', '/mnt/runtime-python', '/runtime/python');
    args.push('--dir', '/etc');
    if (selected.coreAliases?.length) args.push('--dir', '/etc/alternatives');
    for (const entry of selected.coreAliases || []) args.push('--ro-bind', entry.target, '/etc/alternatives/' + entry.name);
    for (const entry of runtime.etcFiles) args.push('--ro-bind', entry.source, entry.target);
    args.push('--bind', '/mnt/workspace', '/workspace', '--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp', '--chdir', '/workspace', '--remount-ro', '/', '--', ...commandArgs);
    return args;
  }
  function isolationArgs(account, identity, commandArgs, selected = runtime) {
    return ['--mount', '--propagation', 'private', '--', tools.python, '-I', '-c', APPLICATION_MOUNT_SETUP,
      JSON.stringify({ uid: account.uid, gid: account.gid, ino: identity.ino, dev: identity.dev, setpriv: tools.setpriv, runtimeMounts: selected.mounts || [], coreAliases: selected.coreAliases || [] }), ...sandboxArgs(account, commandArgs, selected)];
  }
  async function runtimeMounts(selected) {
    const mounts = [];
    for (const [source, target] of [[selected.nodePrefix !== '/usr' && selected.nodePrefix, '/mnt/runtime-node'], [selected.pythonPrefix, '/mnt/runtime-python']]) if (source) { const info = await canonical(source); mounts.push({ source, target, ino: info.ino, dev: info.dev }); }
    return mounts;
  }
  async function probe() {
    const nobody = await lookup('passwd', 'nobody');
    if (!nobody || nobody[0] !== 'nobody' || !/^\d+$/.test(nobody[2]) || !/^\d+$/.test(nobody[3]) || Number(nobody[2]) <= 0 || Number(nobody[3]) <= 0) throw applicationIssue('APPLICATION_UNSUPPORTED');
    const account = { uid: Number(nobody[2]), gid: Number(nobody[3]) }, probeRoot = await io.mkdtemp(path.join(privateRoot, '.probe-')), workspace = path.join(probeRoot, 'workspace');
    try {
      await io.chmod(probeRoot, 0o700); await io.mkdir(workspace, { mode: 0o700 }); await io.chown(workspace, account.uid, account.gid);
      const program = "const fs=require('node:fs');const status=fs.readFileSync('/proc/self/status','utf8');let outside=false;try{fs.readdirSync('/root');outside=true}catch{};fs.writeFileSync('/workspace/probe','owned',{flag:'wx',mode:0o600});console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:status.match(/^Groups:[ \\t]*([^\\r\\n]*)/m)?.[1].trim(),cwd:process.cwd(),map:fs.readFileSync('/proc/self/uid_map','utf8'),gidMap:fs.readFileSync('/proc/self/gid_map','utf8'),caps:status.match(/^CapEff:\\s*(.+)$/m)?.[1],capabilities:Object.fromEntries(['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].map(name=>[name,status.match(new RegExp('^'+name+':\\\\s*(.+)$','m'))?.[1]])),noNewPrivs:Number(status.match(/^NoNewPrivs:\\s*(\\d+)$/m)?.[1]),outside}));";
      const response = await run(tools.unshare, isolationArgs(account, await io.lstat(workspace), [runtime.nodeExecutable, '-e', program]), { cwd: workspace, env: applicationEnvironment({ environment: [] }, { port: 30000, username: 'nobody', nodeDirectory: runtime.nodeDirectory }), timeout: 10000 });
      const value = JSON.parse(response.stdout.trim());
      const oneMapping = (text, id) => {
        if (typeof text !== 'string' || !/^\s*\d+\s+\d+\s+\d+\s*$/.test(text)) return false;
        const mapping = text.trim().split(/\s+/).map(Number);
        return mapping.every(Number.isSafeInteger) && mapping[0] === id && [id, 0].includes(mapping[1]) && mapping[2] === 1;
      };
      // --dev may add an inner user namespace whose parent ID is zero. The
      // host-visible freshly created inode must still belong to the dropped
      // nobody UID/GID; accepting an inner zero map alone would not prove that.
      const probeFile = path.join(workspace, 'probe'), hostFile = await io.lstat(probeFile);
      if (value.uid !== account.uid || value.gid !== account.gid || value.cwd !== '/workspace' || !/^0+$/.test(value.caps || '') || !['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every(name => /^0+$/.test(value.capabilities?.[name] || '')) || value.noNewPrivs !== 1 || value.groups !== '' || value.outside !== false || !oneMapping(value.map, account.uid) || !oneMapping(value.gidMap, account.gid) || !hostFile.isFile() || hostFile.isSymbolicLink() || hostFile.nlink !== 1 || hostFile.uid !== account.uid || hostFile.gid !== account.gid || (await io.readFile(probeFile, 'utf8')) !== 'owned') throw applicationIssue('APPLICATION_UNSUPPORTED');
    } finally { await io.rm(probeRoot, { recursive: true, force: true }); }
  }
  async function initialize() {
    ensureOpen(); if (initializing) return initializing; if (initialized) return currentCapabilities;
    initializing = (async () => {
      let phase = 'platform', systemFile = null;
      try {
        if (platform !== 'linux' || uid !== 0) throw applicationIssue('APPLICATION_UNSUPPORTED');
        phase = 'resource-controller';
        await resourceController?.initialize?.();
        if ((await resourceController?.capabilities?.())?.pidsSupported !== true) throw applicationIssue('APPLICATION_UNSUPPORTED');
        phase = 'private-directory'; await rootPrivateDirectory();
        phase = 'trusted-tools';
        for (const tool of Object.values(tools)) await trustedFile(tool, true);
        phase = 'node-runtime'; const actualNode = await trustedFile(nodePath, true), prefix = path.dirname(path.dirname(actualNode));
        if (path.basename(actualNode) !== 'node' || path.basename(path.dirname(actualNode)) !== 'bin' || !['/usr', '/usr/local'].includes(prefix) && !/^node-v?\d+\.\d+\.\d+-linux-(?:x64|arm64)$/.test(path.basename(prefix))) throw applicationIssue('APPLICATION_UNSUPPORTED');
        await canonical(prefix);
        const nodeVersion = (await run(actualNode, ['--version'])).stdout.trim(); if (!/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw applicationIssue('APPLICATION_UNSUPPORTED');
        const candidates = [path.join(prefix, 'lib/node_modules/npm/bin/npm-cli.js'), ...(prefix === '/usr' ? ['/usr/share/nodejs/npm/bin/npm-cli.js'] : [])];
        let npm = null;
        for (const candidate of candidates) if (await exists(candidate)) { npm = await trustedFile(candidate); break; }
        phase = 'python-runtime'; const pythonVersion = (await run(tools.python, ['--version'])).stdout.trim(); if (!/^Python 3\.\d+\.\d+$/.test(pythonVersion)) throw applicationIssue('APPLICATION_UNSUPPORTED');
        let venv = false; try { await run(tools.python, ['-m', 'venv', '--help']); venv = true; } catch {}
        phase = 'system-files'; const etcFiles = [];
        for (const filename of ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']) { systemFile = path.basename(filename); if (await exists(filename)) etcFiles.push({ source: await systemConfiguration(filename), target: filename }); }
        systemFile = 'ssl/certs'; if (await exists('/etc/ssl/certs')) { const source = await io.realpath('/etc/ssl/certs'); await canonical(source); etcFiles.push({ source, target: '/etc/ssl/certs' }); } systemFile = null;
        runtime = { nodePrefix: prefix, nodeExecutable: prefix === '/usr' ? actualNode : '/runtime/node/bin/node', nodeDirectory: prefix === '/usr' ? '/usr/bin' : '/runtime/node/bin', npm: npm && (prefix === '/usr' ? npm : '/runtime/node/' + path.relative(prefix, npm).split(path.sep).join('/')), nodeVersion, pythonVersion, venv, lib64: Boolean(await exists('/usr/lib64')), etcFiles };
        runtime.mounts = await runtimeMounts(runtime); runtime.coreAliases = await coreToolAliases();
        phase = 'nonroot-sandbox-probe'; await probe();
        currentCapabilities = { supported: true, isolation: 'nonroot-bubblewrap', hostNetwork: true, networkIsolated: false, reason: null, reasonI18n: null, tasksMax: 128, runtimes: { nodejs: { available: true, version: nodeVersion, dependenciesAvailable: Boolean(npm) }, python: { available: venv, version: pythonVersion, dependenciesAvailable: venv } } };
      } catch (error) { currentCapabilities = { ...currentCapabilities, supported: false, reason: applicationIssue('APPLICATION_UNSUPPORTED').message, reasonI18n: applicationIssue('APPLICATION_UNSUPPORTED').errorI18n, reasonCode: 'APPLICATION_UNSUPPORTED', diagnosticPhase: phase }; try { options.onDiagnostic?.({ phase, ...(systemFile ? { systemFile } : {}), code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : 'APPLICATION_PROBE_FAILED' }); } catch {} }
      initialized = true; return currentCapabilities;
    })().finally(() => { initializing = null; });
    return initializing;
  }
  function capabilities() { return structuredClone(currentCapabilities); }
  async function pendingBuildCleanup() {
    // Admission only inspects existing build receipts. A Bedrock-only host may
    // never have initialized application isolation; do not create its private
    // directory just to prove that no earlier build is pending.
    if (!await exists(privateRoot)) return [];
    await canonical(privateRoot, { privateMode: true }); const rows = [];
    for (const filename of await io.readdir(privateRoot)) {
      const match = /^\.build-([a-f0-9-]{36})\.json$/.exec(filename); if (!match || activeBuildVolumes.has(match[1])) continue;
      if (!UUID.test(match[1]) || rows.length >= 64) throw applicationIssue('APPLICATION_RUNTIME_CLEANUP');
      const target = path.join(privateRoot, filename); const info = await canonical(target, { file: true, privateMode: true }); if (info.size > 4096) throw applicationIssue('APPLICATION_RUNTIME_CLEANUP');
      let value; try { value = JSON.parse(await io.readFile(target, 'utf8')); } catch { throw applicationIssue('APPLICATION_RUNTIME_CLEANUP'); }
      if (value.schema !== 1 || value.id !== match[1] || !UUID.test(value.serverId || '') || value.purpose !== 'python-runtime-build' || !Number.isFinite(Date.parse(value.createdAt))) throw applicationIssue('APPLICATION_RUNTIME_CLEANUP');
      rows.push({ volumeId: value.id, serverId: value.serverId, createdAt: value.createdAt });
    }
    return rows;
  }
  async function assertNoPendingBuilds() {
    await initialize(); ensureOpen(); if (platform !== 'linux' || uid !== 0) return;
    const cleanupPending = await pendingBuildCleanup(); if (cleanupPending.length) throw applicationIssue('APPLICATION_RUNTIME_CLEANUP', 409, { cleanupPending });
  }
  async function runtimeCatalog({ refresh = false } = {}) {
    await initialize(); ensureOpen();
    if (!buildPrerequisites || refresh || Date.now() - buildPrerequisitesAt > 30000) { buildPrerequisites = currentCapabilities.supported ? await managed.prerequisites() : { ready: false, missing: ['Linux application isolation'], packages: [], resources: { ...PYTHON_BUILD_RESOURCES } }; buildPrerequisitesAt = Date.now(); }
    const build = buildPrerequisites;
    let cleanupPending = [];
    if (platform === 'linux' && uid === 0) try { cleanupPending = await pendingBuildCleanup(); } catch { cleanupPending = [{ volumeId: null, serverId: null, reasonCode: 'APPLICATION_RUNTIME_CLEANUP' }]; }
    if (refresh && currentCapabilities.supported) await Promise.allSettled(['nodejs', 'python'].map(kind => resolveCatalogKind(kind)));
    const known = catalog.snapshot();
    return { ...capabilities(), managed: true, selection: 'latest-stable', cleanupPending, runtimes: Object.fromEntries(Object.entries(currentCapabilities.runtimes).map(([kind, row]) => [kind, { ...row, startupModes: kind === 'nodejs' ? ['entrypoint', 'npm-script'] : ['entrypoint', 'python-module'], managedAvailable: currentCapabilities.supported && !cleanupPending.length && (kind !== 'python' || build.ready), latest: catalogStates.get(kind)?.status === 'verified' ? known.find(pin => pin.kind === kind) || null : null, catalog: catalogStates.get(kind) || { status: 'not-checked', checkedAt: null }, prerequisites: kind === 'python' ? build : { ready: currentCapabilities.supported, missing: [] } }])) };
  }
  async function resolveCatalogKind(kind) {
    try { const pin = await catalog.resolve(kind); catalogStates.set(kind, { status: 'verified', checkedAt: pin.resolvedAt }); return pin; }
    catch (error) { const issue = error.code?.startsWith('APPLICATION_') ? error : applicationIssue('APPLICATION_RUNTIME_CATALOG', 502); catalogStates.set(kind, { status: 'unavailable', checkedAt: new Date().toISOString(), errorCode: issue.code, reason: issue.message, reasonI18n: issue.errorI18n }); throw issue; }
  }
  async function resolveRuntime(kind) {
    await initialize(); ensureOpen(); if (!currentCapabilities.supported || !['nodejs', 'python'].includes(kind)) throw applicationIssue('APPLICATION_UNSUPPORTED'); await assertNoPendingBuilds();
    if (kind === 'python' && !(await managed.prerequisites()).ready) throw applicationIssue('APPLICATION_RUNTIME_TOOLS');
    return resolveCatalogKind(kind);
  }
  async function selectedRuntime(server) {
    if (!server.runtime) return runtime;
    const pin = normalizeRuntimePin(server.runtime, { kind: applicationKind(server), arch: options.arch || process.arch }), selected = await managed.installed(pin);
    if (!selected) throw applicationIssue('APPLICATION_RUNTIME_PIN');
    return pin.kind === 'nodejs' ? { ...runtime, nodePrefix: selected.prefix, nodeExecutable: selected.executable, nodeDirectory: selected.nodeDirectory, npm: selected.npm, nodeVersion: pin.version, selected }
      : { ...runtime, pythonPrefix: selected.prefix, pythonExecutable: selected.executable, pythonVersion: `Python ${pin.version}`, selected };
  }
  async function runtimeAvailability(server) {
    await initialize(); ensureOpen();
    const kind = applicationKind(server);
    if (!server.runtime) return { mode: 'legacy', kind, available: currentCapabilities.supported && currentCapabilities.runtimes[kind]?.available === true, version: server.version || currentCapabilities.runtimes[kind]?.version || null };
    try { const selected = await selectedRuntime(server); return { mode: 'managed', kind, available: currentCapabilities.supported, version: server.runtime.version, source: server.runtime.source, executable: selected.selected.executable }; }
    catch (error) { return { mode: 'managed', kind, available: false, version: server.runtime.version, reason: applicationIssue('APPLICATION_RUNTIME_PIN').message, reasonI18n: applicationIssue('APPLICATION_RUNTIME_PIN').errorI18n }; }
  }
  async function supported(server) { await initialize(); ensureOpen(); if (!currentCapabilities.supported || !server.runtime && !currentCapabilities.runtimes[applicationKind(server)]?.available) throw applicationIssue('APPLICATION_UNSUPPORTED'); }
  async function record(server) {
    const target = names(server); await canonical(privateRoot, { privateMode: true });
    if (!await exists(target.record)) return null;
    await canonical(target.record, { file: true, privateMode: true });
    const value = JSON.parse(await io.readFile(target.record, 'utf8'));
    if (value.schema !== 1 || value.serverId !== target.id || value.scope !== scope || value.username !== target.username || !UUID.test(value.ownerId || '') || !['creating', 'active', 'releasing'].includes(value.state) || value.state !== 'creating' && (!Number.isSafeInteger(value.uid) || value.uid <= 0 || !Number.isSafeInteger(value.gid) || value.gid <= 0)) throw applicationIssue('APPLICATION_ACCOUNT');
    return value;
  }
  async function writeRecord(server, value, previous = null) {
    const { record: filename } = names(server), temporary = path.join(privateRoot, '.record-' + randomUUID());
    const old = previous && await io.lstat(filename);
    try {
      await io.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await canonical(temporary, { file: true, privateMode: true });
      if (old) { const current = await io.lstat(filename); if (current.ino !== old.ino || current.dev !== old.dev || await io.readFile(filename, 'utf8') !== JSON.stringify(previous) + '\n') throw applicationIssue('APPLICATION_ACCOUNT'); }
      else if (await exists(filename)) throw applicationIssue('APPLICATION_ACCOUNT');
      await io.rename(temporary, filename);
    } finally { await io.rm(temporary, { force: true }).catch(() => {}); }
  }
  function verifyAccount(value, passwd, group) {
    const comment = `vortex-app,${scope},${value.serverId},${value.ownerId}`;
    if (!passwd || !group || passwd.length !== 7 || group.length !== 4 || passwd[0] !== value.username || group[0] !== value.username || passwd[4] !== comment || passwd[5] !== '/nonexistent' || passwd[6] !== '/usr/sbin/nologin' || !/^\d+$/.test(passwd[2]) || Number(passwd[2]) <= 0 || !/^\d+$/.test(passwd[3]) || Number(passwd[3]) <= 0 || group[2] !== passwd[3] || group[3] || value.uid != null && value.uid !== Number(passwd[2]) || value.gid != null && value.gid !== Number(passwd[3])) throw applicationIssue('APPLICATION_ACCOUNT');
    return { ...value, uid: Number(passwd[2]), gid: Number(passwd[3]) };
  }
  async function account(server, create = false) {
    let value = await record(server); const target = names(server);
    if (!value) {
      if (!create || await lookup('passwd', target.username) || await lookup('group', target.username)) throw applicationIssue('APPLICATION_ACCOUNT');
      value = { schema: 1, serverId: target.id, scope, username: target.username, ownerId: randomUUID(), state: 'creating', createdAt: new Date().toISOString() };
      await writeRecord(server, value);
      await run(tools.useradd, ['--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--user-group', '--comment', `vortex-app,${scope},${target.id},${value.ownerId}`, value.username]);
    }
    if (value.state === 'releasing') throw applicationIssue('APPLICATION_ACCOUNT');
    const verified = verifyAccount(value, await lookup('passwd', value.username), await lookup('group', value.username));
    if (value.state !== 'active') { const updated = { ...verified, state: 'active' }; await writeRecord(server, updated, value); value = updated; }
    else value = verified;
    return value;
  }
  async function noProcesses(value) {
    for (const name of await io.readdir(options.procPath || '/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { const text = await io.readFile(path.join(options.procPath || '/proc', name, 'status'), 'utf8'), ids = text.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m); if (ids?.slice(1).some(id => Number(id) === value.uid)) throw applicationIssue('APPLICATION_BUSY'); }
      catch (error) { if (error.code === 'APPLICATION_BUSY') throw error; if (!['ENOENT', 'ESRCH'].includes(error.code)) throw applicationIssue('APPLICATION_BUSY'); }
    }
  }
  async function exclusiveAccount(server, operation) {
    const id = idOf(server); if (accountLocks.has(id)) throw applicationIssue('APPLICATION_BUSY');
    const promise = operation(); accountLocks.set(id, promise); try { return await promise; } finally { accountLocks.delete(id); }
  }
  async function prepareWorkspace(server, { seed = false } = {}) {
    ensureOpen(); await supported(server);
    return exclusiveAccount(server, async () => {
      if (server.pid || ['running', 'starting', 'stopping'].includes(server.status)) throw applicationIssue('APPLICATION_BUSY');
      const target = names(server); const parent = path.dirname(target.workspace); await canonical(parent);
      if (!await exists(target.workspace)) await io.mkdir(target.workspace, { mode: 0o700 });
      const workspace = await io.lstat(target.workspace); if (!workspace.isDirectory() || workspace.isSymbolicLink() || await io.realpath(target.workspace) !== target.workspace) throw applicationIssue('APPLICATION_PATH');
      const owner = await account(server, true); await noProcesses(owner);
      if (seed) {
        if ((await io.readdir(target.workspace)).length) throw applicationIssue('APPLICATION_PATH');
        for (const [filename, content] of Object.entries(applicationStarterSources(server.kind))) await io.writeFile(path.join(target.workspace, filename), content, { flag: 'wx', mode: 0o600 });
      }
      const stack = [target.workspace], changes = []; let entries = 0;
      while (stack.length) {
        const filename = stack.pop(), info = await io.lstat(filename); if (++entries > 50000 || info.isSymbolicLink() && filename === target.workspace || !info.isDirectory() && !info.isFile() && !info.isSymbolicLink() || info.isFile() && info.nlink !== 1) throw applicationIssue('APPLICATION_PATH');
        if (info.uid !== 0 && info.uid !== owner.uid || info.gid !== 0 && info.gid !== owner.gid) throw applicationIssue('APPLICATION_PATH');
        changes.push({ filename, info });
        if (info.isDirectory()) for (const name of await io.readdir(filename)) stack.push(path.join(filename, name));
      }
      for (const { filename, info } of changes) {
        const current = await io.lstat(filename);
        if (current.ino !== info.ino || current.dev !== info.dev || current.mode !== info.mode || current.uid !== info.uid || current.gid !== info.gid || current.nlink !== info.nlink) throw applicationIssue('APPLICATION_PATH');
        if (info.uid !== owner.uid || info.gid !== owner.gid) {
          if (info.isSymbolicLink()) await io.lchown(filename, owner.uid, owner.gid);
          else await io.chown(filename, owner.uid, owner.gid);
        }
      }
      const home = path.join(target.workspace, '.home'); if (!await exists(home)) { await io.mkdir(home, { mode: 0o700 }); await io.chown(home, owner.uid, owner.gid); }
      else if (!(await io.lstat(home)).isDirectory() || (await io.lstat(home)).isSymbolicLink()) throw applicationIssue('APPLICATION_PATH');
      return { workspace: target.workspace, username: owner.username, uid: owner.uid, gid: owner.gid, kind: applicationKind(server) };
    });
  }
  async function regularWorkspaceFile(workspace, relative) {
    let filename = workspace;
    for (const part of relative.split('/')) { filename = path.join(filename, part); const info = await io.lstat(filename); if (info.isSymbolicLink() || filename !== path.join(workspace, relative) && !info.isDirectory()) throw applicationIssue('APPLICATION_PATH'); }
    const info = await io.lstat(filename); if (!info.isFile() || info.nlink !== 1) throw applicationIssue('APPLICATION_ENTRYPOINT_MISSING'); return filename;
  }
  async function launchPlan(server, { purpose = 'start', commandArgs, workspaceOverride, runtimeOverride } = {}) {
    ensureOpen(); await supported(server); if (!['start', 'install'].includes(purpose)) throw applicationIssue('APPLICATION_INPUT', 400);
    const owner = await account(server), target = names(server), application = config(server), selected = { ...(runtimeOverride || await selectedRuntime(server)) }; await noProcesses(owner);
    selected.mounts = await runtimeMounts(selected); selected.coreAliases = await coreToolAliases();
    if (workspaceOverride) target.workspace = workspaceOverride;
    const info = await io.lstat(target.workspace); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner.uid || info.gid !== owner.gid) throw applicationIssue('APPLICATION_PATH');
    let argv = commandArgs;
    if (purpose === 'start') {
      const mode = application.startup?.mode || 'entrypoint';
      if (mode === 'entrypoint') try { await regularWorkspaceFile(target.workspace, application.entrypoint); } catch (error) { if (absent(error)) throw applicationIssue('APPLICATION_ENTRYPOINT_MISSING'); throw error; }
      if (server.kind === 'nodejs') {
        if (mode === 'npm-script') {
          const manifest = await projectManifest(target.workspace, 'package.json');
          if (!selected.npm || !manifest || typeof manifest.scripts?.[application.startup.script] !== 'string') throw applicationIssue('APPLICATION_STARTUP_SCRIPT');
          argv = [selected.nodeExecutable, selected.npm, 'run', application.startup.script, '--', ...application.args];
        } else argv = [selected.nodeExecutable, '/workspace/' + application.entrypoint, ...application.args];
      } else { await regularWorkspaceFile(target.workspace, '.venv/pyvenv.cfg'); argv = mode === 'python-module' ? ['/workspace/.venv/bin/python', '-u', '-m', application.startup.module, ...application.args] : ['/workspace/.venv/bin/python', '-u', '/workspace/' + application.entrypoint, ...application.args]; }
    }
    if (!Array.isArray(argv) || !argv.length) throw applicationIssue('APPLICATION_INPUT', 400);
    let stdinPrelude;
    if (purpose === 'start') {
      stdinPrelude = JSON.stringify(applicationEnvironment(application, { port: server.port, username: owner.username, nodeDirectory: selected.nodeDirectory })) + '\n';
      if (Buffer.byteLength(stdinPrelude) > APPLICATION_ENV_FRAME_BYTES) throw applicationIssue('APPLICATION_ENVIRONMENT', 400);
      argv = [tools.python, '-I', '-c', APPLICATION_ENV_HANDOFF, ...argv];
    }
    return { executable: tools.unshare, args: isolationArgs(owner, info, argv, selected), options: { cwd: target.workspace, env: applicationEnvironment(application, { port: server.port, username: owner.username, install: true, nodeDirectory: selected.nodeDirectory }), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: false }, ...(stdinPrelude ? { stdinPrelude } : {}), execution: { cleanEnvironment: true }, runtime: { kind: applicationKind(server), mode: server.runtime ? 'managed' : 'legacy', version: server.kind === 'nodejs' ? selected.nodeVersion : selected.pythonVersion, isolation: 'nonroot-bubblewrap', uid: owner.uid, gid: owner.gid, hostNetwork: true, networkIsolated: false } };
  }
  async function start(server, { resourceHandle } = {}) {
    await prepareWorkspace(server); const plan = await launchPlan(server), handle = resourceHandle || await resourceController.prepare(server.id, server.resourcePolicy, { tasksMax: 128 });
    if (typeof handle.spawnWithArgs !== 'function') { await handle.cleanup().catch(() => {}); throw applicationIssue('APPLICATION_UNSUPPORTED'); }
    const launched = handle.spawnWithArgs(plan.executable, plan.args, plan.options, plan.execution);
    launched.child.stdin.on('error', () => {});
    if (plan.stdinPrelude) launched.child.stdin.write(plan.stdinPrelude);
    return { ...launched, resourceHandle: handle, runtime: plan.runtime };
  }
  async function signalApplication(server, { resourceHandle, supervisorPid, signal = 'SIGTERM' } = {}) {
    ensureOpen(); idOf(server);
    if (platform !== 'linux' || uid !== 0 || signal !== 'SIGTERM' || !Number.isSafeInteger(supervisorPid) || supervisorPid <= 1 || !resourceHandle?.effective?.kernelEnforced || !resourceHandle.effective.applied || typeof resourceHandle.stats !== 'function') throw applicationIssue('APPLICATION_SIGNAL');
    await resourceHandle.stats();
    const owner = await account(server), relative = resourceHandle.effective.cgroupPath, root = options.cgroupRoot || '/sys/fs/cgroup';
    if (typeof relative !== 'string' || !relative.startsWith('/') || relative.split('/').some(part => part === '..' || part === '.') || !new RegExp('^vortex-server-' + server.id + '-[a-f0-9-]+$').test(path.basename(relative))) throw applicationIssue('APPLICATION_SIGNAL');
    const scope = root + relative, identity = await canonical(scope), selected = await selectedRuntime(server), nodeExecutable = selected.nodeExecutable, hostNode = await io.realpath(nodePath), python = await io.realpath(tools.python);
    const executables = server.runtime ? [...new Set([selected.selected.hostExecutable, selected.selected.executable])] : server.kind === 'nodejs' ? [...new Set([hostNode, nodeExecutable].filter(Boolean))] : [python];
    const npmScript = applicationKind(server) === 'nodejs' && config(server).startup?.mode === 'npm-script';
    try {
      const response = await run(tools.python, ['-I', '-c', APPLICATION_SIGNAL, JSON.stringify({ root, relative, ino: identity.ino, dev: identity.dev, uid: owner.uid, gid: owner.gid, supervisor: supervisorPid, supervisorExecutable: await io.realpath(tools.bwrap), executables, npmScript })]);
      const value = JSON.parse(response.stdout);
      if (value?.sent === false && value.reason === 'not-running') return { sent: false, reason: 'not-running' };
      if (value?.sent !== true || value.signal !== 'SIGTERM' || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw applicationIssue('APPLICATION_SIGNAL');
      if (npmScript && (!Array.isArray(value.pids) || value.pids.length < 1 || value.pids.length > 128 || value.pid !== value.pids[0] || new Set(value.pids).size !== value.pids.length || value.pids.some(pid => !Number.isSafeInteger(pid) || pid <= 1))) throw applicationIssue('APPLICATION_SIGNAL');
      if (npmScript && (value.partial !== undefined || value.pendingPids !== undefined) && (value.partial !== true || !Array.isArray(value.pendingPids) || value.pendingPids.length < 1 || value.pids.length + value.pendingPids.length > 128 || new Set(value.pendingPids).size !== value.pendingPids.length || value.pendingPids.some(pid => !Number.isSafeInteger(pid) || pid <= 1 || value.pids.includes(pid)))) throw applicationIssue('APPLICATION_SIGNAL');
      return { sent: true, signal: 'SIGTERM', pid: value.pid, ...(npmScript ? { pids: [...value.pids], ...(value.partial ? { partial: true, pendingPids: [...value.pendingPids] } : {}) } : {}) };
    } catch { throw applicationIssue('APPLICATION_SIGNAL'); }
  }
  async function installCommand(server, argv, { signal, onOutput = () => {}, workspaceOverride, runtimeOverride, resourcePolicy = server.resourcePolicy, timeoutMs = installTimeoutMs } = {}) {
    const plan = await launchPlan(server, { purpose: 'install', commandArgs: argv, workspaceOverride, runtimeOverride }), handle = await resourceController.prepare(server.id, resourcePolicy, { tasksMax: 128 });
    if (typeof handle.spawnWithArgs !== 'function') { await handle.cleanup().catch(() => {}); throw applicationIssue('APPLICATION_UNSUPPORTED'); }
    let child, timer, force, deadline, abort, closePromise, childClosed = false, failure, outputBytes = 0;
    const wait = (promise, timeout) => Promise.race([promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(applicationIssue('APPLICATION_DEPENDENCIES')), timeout); })]).finally(() => clearTimeout(deadline));
    try {
      ({ child, ready: plan.ready } = handle.spawnWithArgs(plan.executable, plan.args, plan.options, plan.execution));
      const terminate = () => { failure ||= applicationIssue('APPLICATION_DEPENDENCIES'); child.kill('SIGTERM'); force ||= setTimeout(() => child.kill('SIGKILL'), 1500); force.unref?.(); };
      closePromise = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, reason) => { childClosed = true; resolve({ code, signal: reason }); }); }); closePromise.catch(() => {});
      for (const stream of [child.stdout, child.stderr]) {
        let pending = ''; stream.setEncoding('utf8');
        const output = line => { try { onOutput(redactApplicationOutput(line, server.application)); } catch { terminate(); } };
        stream.on('data', text => {
          outputBytes += Buffer.byteLength(text); pending += text;
          if (outputBytes > 2 * 1024 ** 2 || Buffer.byteLength(pending) > 65536) { pending = ''; return terminate(); }
          let newline; while ((newline = pending.indexOf('\n')) !== -1) { output(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
        });
        stream.on('end', () => { if (pending) output(pending); pending = ''; });
      }
      abort = terminate; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) terminate();
      timer = setTimeout(terminate, timeoutMs); await wait(plan.ready, timeoutMs + 5000); const result = await wait(closePromise, timeoutMs + 5000);
      if (failure || result.code !== 0) throw applicationIssue('APPLICATION_DEPENDENCIES');
      return { exitCode: result.code };
    } catch {
      if (child && !childClosed) { child.kill('SIGKILL'); try { await wait(closePromise, 3000); } catch {} }
      throw applicationIssue('APPLICATION_DEPENDENCIES', 409, !childClosed && child ? { cleanupPending: handle.effective?.cgroupPath || server.id } : {});
    } finally { clearTimeout(timer); clearTimeout(force); clearTimeout(deadline); if (abort) signal?.removeEventListener('abort', abort); if (!child || childClosed) await handle.cleanup(); }
  }
  async function installDependencies(server, options = {}) {
    ensureOpen(); await prepareWorkspace(server); ensureOpen();
    const controller = new AbortController(), relay = () => controller.abort(); controllers.add(controller); options.signal?.addEventListener('abort', relay, { once: true }); if (options.signal?.aborted) relay();
    const operation = (async () => {
      const application = config(server), target = names(server), commands = [], selected = await selectedRuntime(server);
      if (server.kind === 'python') {
        commands.push([selected.pythonExecutable || tools.python, '-m', 'venv', '/workspace/.venv']);
        if (application.dependencies === 'auto' && await exists(path.join(target.workspace, 'requirements.txt'))) { await regularWorkspaceFile(target.workspace, 'requirements.txt'); commands.push(['/workspace/.venv/bin/python', '-m', 'pip', 'install', '--no-input', '-r', '/workspace/requirements.txt']); }
      } else if (application.dependencies === 'auto' && await exists(path.join(target.workspace, 'package.json'))) {
        if (!selected.npm) throw applicationIssue('APPLICATION_UNSUPPORTED'); await regularWorkspaceFile(target.workspace, 'package.json');
        const lockName = await exists(path.join(target.workspace, 'npm-shrinkwrap.json')) ? 'npm-shrinkwrap.json' : 'package-lock.json';
        const lock = await exists(path.join(target.workspace, lockName)); if (lock) await regularWorkspaceFile(target.workspace, lockName);
        commands.push([selected.nodeExecutable, selected.npm, lock ? 'ci' : 'install', '--no-audit', '--no-fund']);
      }
      for (let index = 0; index < commands.length; index++) { if (controller.signal.aborted) throw applicationIssue('APPLICATION_DEPENDENCIES'); options.onProgress?.({ completed: index, total: commands.length }); await installCommand(server, commands[index], { ...options, signal: controller.signal }); }
      await noProcesses(await account(server));
      return { installed: commands.length > 0, commandsCompleted: commands.length, kind: applicationKind(server), version: server.kind === 'nodejs' ? selected.nodeVersion : selected.pythonVersion, manifest: server.kind === 'nodejs' ? 'package.json' : 'requirements.txt', manifestFingerprint: await manifestSignature(server) };
    })();
    active.add(operation); try { return await operation; } finally { active.delete(operation); controllers.delete(controller); options.signal?.removeEventListener('abort', relay); }
  }
  async function releaseWorkspace(server) {
    ensureOpen(); if (platform !== 'linux' || uid !== 0) throw applicationIssue('APPLICATION_UNSUPPORTED'); await rootPrivateDirectory();
    return exclusiveAccount(server, async () => {
      let value = await record(server); if (!value) return { removed: false, alreadyAbsent: true };
      await noProcesses(value);
      const passwd = await lookup('passwd', value.username), group = await lookup('group', value.username);
      if (passwd) { value = verifyAccount(value, passwd, group); const releasing = { ...value, state: 'releasing' }; await writeRecord(server, releasing, await record(server)); value = releasing; await run(tools.userdel, [value.username]); }
      else if (value.state !== 'releasing' && !(value.state === 'creating' && !group)) throw applicationIssue('APPLICATION_ACCOUNT');
      if (await lookup('passwd', value.username)) throw applicationIssue('APPLICATION_ACCOUNT');
      const remaining = await lookup('group', value.username);
      if (remaining) { if (remaining[2] !== String(value.gid) || remaining[3]) throw applicationIssue('APPLICATION_ACCOUNT'); await run(tools.groupdel, [value.username]); }
      await canonical(names(server).record, { file: true, privateMode: true });
      if (JSON.stringify(await record(server)) !== JSON.stringify(value)) throw applicationIssue('APPLICATION_ACCOUNT');
      await io.unlink(names(server).record);
      return { removed: true, username: value.username };
    });
  }
  async function ensureRuntime(server, options = {}) {
    ensureOpen(); await supported(server); const pin = normalizeRuntimePin(server.runtime, { kind: applicationKind(server), arch: runtimeArch });
    const controller = new AbortController(), relay = () => controller.abort(); controllers.add(controller); options.signal?.addEventListener('abort', relay, { once: true }); if (options.signal?.aborted) relay();
    const operation = managed.ensure(pin, { ...options, signal: controller.signal, beforePromote: async () => { await noProcesses(await account(server)); }, validate: async selected => {
      const output = [], selectedOverride = server.kind === 'nodejs' ? { ...runtime, nodePrefix: selected.prefix, nodeExecutable: selected.executable, nodeDirectory: selected.nodeDirectory, npm: selected.npm, nodeVersion: pin.version } : { ...runtime, pythonPrefix: selected.prefix, pythonExecutable: selected.executable, pythonVersion: `Python ${pin.version}` };
      const argv = server.kind === 'nodejs' ? [selected.executable, '--version'] : [selected.executable, '-I', '-c', 'import sys, ssl, sqlite3, bz2, lzma, ctypes, zlib, venv, ensurepip; print("Python " + sys.version.split()[0])'];
      await installCommand(server, argv, { signal: controller.signal, runtimeOverride: selectedOverride, resourcePolicy: { mode: 'fixed', cpuCores: server.kind === 'python' ? PYTHON_BUILD_RESOURCES.cpuCores : 0.1, memoryMiB: server.kind === 'python' ? PYTHON_BUILD_RESOURCES.memoryMiB : 256 }, onOutput: line => { output.push(line); options.onOutput?.(line); } });
      if (output.join('\n').trim() !== (server.kind === 'nodejs' ? pin.version : `Python ${pin.version}`)) throw applicationIssue('APPLICATION_RUNTIME_PIN');
      await noProcesses(await account(server));
    }, volume: async () => {
      const storage = runtimeStorageController, owner = await account(server);
      if (!storage || (await storage.capabilities()).fixedSupported !== true) throw applicationIssue('APPLICATION_RUNTIME_BUILD');
      const volume = { id: randomUUID(), kind: 'python', storagePolicy: { mode: 'fixed', diskGiB: 3 } }, destination = path.join(dataDir, 'servers', volume.id), ledger = path.join(privateRoot, '.build-' + volume.id + '.json');
      activeBuildVolumes.add(volume.id);
      try { await io.writeFile(ledger, JSON.stringify({ schema: 1, id: volume.id, serverId: server.id, createdAt: new Date().toISOString(), purpose: 'python-runtime-build' }) + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) { activeBuildVolumes.delete(volume.id); throw error; }
      try { const stats = await storage.provision(volume); if (stats?.hardEnforced !== true || stats.limitBytes !== PYTHON_BUILD_RESOURCES.volumeBytes) throw applicationIssue('APPLICATION_RUNTIME_BUILD'); }
      catch (error) { try { await storage.unmount(volume); await storage.remove(volume); await io.rm(destination, { recursive: true, force: true }); await io.unlink(ledger); } catch { error.cleanupPending = volume.id; } finally { activeBuildVolumes.delete(volume.id); } throw error; }
      return { path: destination, quarantine: () => activeBuildVolumes.delete(volume.id), close: async () => { try { await noProcesses(owner); await storage.unmount(volume); await storage.remove(volume); await canonical(destination); await io.rm(destination, { recursive: true, force: true }); await io.unlink(ledger); } catch (error) { throw applicationIssue('APPLICATION_RUNTIME_BUILD', 409, { cleanupPending: volume.id, cause: error }); } finally { activeBuildVolumes.delete(volume.id); } } };
    }, build: async ({ workspace, onOutput, signal }) => {
      const owner = await account(server); await noProcesses(owner);
      await trustedFile('/usr/bin/nice', true); await trustedFile('/usr/bin/make', true); await trustedFile('/usr/bin/gcc', true); await trustedFile('/bin/sh', true);
      const pending = [workspace]; let count = 0;
      while (pending.length) { const filename = pending.pop(), info = await io.lstat(filename); if (++count > 100000) throw applicationIssue('APPLICATION_PATH'); if (info.isSymbolicLink()) await io.lchown(filename, owner.uid, owner.gid); else { await io.chown(filename, owner.uid, owner.gid); if (info.isDirectory()) for (const name of await io.readdir(filename)) pending.push(path.join(filename, name)); } }
      const buildOptions = { signal, onOutput, workspaceOverride: workspace, runtimeOverride: runtime, timeoutMs: PYTHON_BUILD_RESOURCES.timeoutMs, resourcePolicy: { mode: 'fixed', cpuCores: PYTHON_BUILD_RESOURCES.cpuCores, memoryMiB: PYTHON_BUILD_RESOURCES.memoryMiB } };
      const deadline = Date.now() + PYTHON_BUILD_RESOURCES.timeoutMs;
      const executeBuild = argv => { const remaining = deadline - Date.now(); if (remaining <= 0) throw applicationIssue('APPLICATION_RUNTIME_BUILD'); return installCommand(server, argv, { ...buildOptions, timeoutMs: remaining }); };
      try {
        const smoke = [];
        await installCommand(server, ['/usr/bin/awk', 'BEGIN { if (2 + 2 != 4) exit 1; print "VORTEX_AWK_READY" }'], { ...buildOptions, timeoutMs: Math.min(10000, Math.max(1, deadline - Date.now())), onOutput: line => { smoke.push(line); onOutput?.(line); } });
        if (smoke.join('\n').trim() !== 'VORTEX_AWK_READY') throw applicationIssue('APPLICATION_RUNTIME_BUILD');
        await executeBuild(['/usr/bin/nice', '-n', '10', '/bin/sh', './configure', '--prefix=/runtime/python', '--disable-test-modules', '--with-ensurepip=install']);
        await executeBuild(['/usr/bin/nice', '-n', '10', '/usr/bin/make', '-j1']);
        await executeBuild(['/usr/bin/nice', '-n', '10', '/usr/bin/make', '-j1', 'DESTDIR=/workspace/output', 'altinstall']);
        await noProcesses(owner); return path.join(workspace, 'output/runtime/python');
      } catch (error) { throw applicationIssue('APPLICATION_RUNTIME_BUILD', 409, error.cleanupPending ? { cleanupPending: error.cleanupPending } : {}); }
    } });
    active.add(operation); try { const selected = await operation; return { ...publicRuntimePin(pin), cached: true, executable: selected.executable }; }
    finally { active.delete(operation); controllers.delete(controller); options.signal?.removeEventListener('abort', relay); }
  }
  async function projectManifest(workspace, relative) {
    let handle;
    try {
      const root = await io.lstat(workspace), filename = await regularWorkspaceFile(workspace, relative), info = await io.lstat(filename);
      if (root.uid <= 0 || info.uid !== root.uid || info.size > 1024 ** 2) throw applicationIssue('APPLICATION_PATH');
      handle = await io.open(filename, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0)); const current = await handle.stat();
      if (!current.isFile() || current.nlink !== 1 || current.uid !== root.uid || current.ino !== info.ino || current.dev !== info.dev || current.size > 1024 ** 2) throw applicationIssue('APPLICATION_PATH');
      const buffer = Buffer.alloc(1024 ** 2 + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 ** 2) throw applicationIssue('APPLICATION_INPUT', 400); const text = buffer.subarray(0, bytesRead).toString('utf8');
      return relative.endsWith('.json') ? JSON.parse(text) : text;
    }
    catch (error) { if (absent(error)) return null; if (error instanceof SyntaxError) throw applicationIssue('APPLICATION_INPUT', 400); throw error; }
    finally { await handle?.close(); }
  }
  async function readProject(server) {
    idOf(server); const target = names(server), manifests = [], packages = []; let packagesTruncated = false;
    const safeText = text => redactApplicationOutput(String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 500), server.application);
    const dependencyCount = value => value && typeof value === 'object' && !Array.isArray(value) ? Math.min(Object.keys(value).length, 10000) : 0;
    const kind = applicationKind(server), runtimeInfo = server.runtime ? publicRuntimePin(server.runtime) : { mode: 'legacy', kind, version: server.version, source: 'host', method: 'existing-host-runtime' };
    const manifestChanged = Boolean(server.dependencyState?.manifestFingerprint && server.dependencyState.manifestFingerprint !== await manifestSignature(server));
    const dependencyState = { status: manifestChanged ? 'outdated' : server.dependencyState?.status || 'unknown', installedAt: server.dependencyState?.installedAt || null, manifestChanged, kind, manifest: kind === 'nodejs' ? 'package.json' : 'requirements.txt' };
    if (!await exists(target.workspace)) return { runtime: runtimeInfo, manifests, packages, packagesTruncated, dependencyState };
    if (kind === 'nodejs') {
      const value = await projectManifest(target.workspace, 'package.json');
      const scripts = value?.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts) ? Object.entries(value.scripts).filter(([name, command]) => /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(name) && typeof command === 'string').slice(0, 100).map(([name, command]) => ({ name, command: safeText(command) })) : [];
      manifests.push({ name: 'package.json', present: value !== null, packageManager: 'npm', dependencies: dependencyCount(value?.dependencies), devDependencies: dependencyCount(value?.devDependencies), scripts });
      for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) manifests.push({ name, present: Boolean(await projectManifest(target.workspace, name)), packageManager: 'npm', dependencies: 0, devDependencies: 0, scripts: [] });
      const modules = path.join(target.workspace, 'node_modules'), info = await exists(modules);
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink()) throw applicationIssue('APPLICATION_PATH');
        const roots = [];
        for (const name of await io.readdir(modules)) {
          if (name.startsWith('@')) { const scopePath = path.join(modules, name), info = await io.lstat(scopePath); if (!info.isDirectory() || info.isSymbolicLink()) continue; for (const child of await io.readdir(scopePath)) { roots.push(`node_modules/${name}/${child}/package.json`); if (roots.length >= 1000) break; } }
          else if (!name.startsWith('.')) roots.push(`node_modules/${name}/package.json`);
          if (roots.length >= 1000) { packagesTruncated = true; break; }
        }
        for (const relative of roots) { try { const item = await projectManifest(target.workspace, relative); if (item && typeof item.name === 'string' && typeof item.version === 'string') packages.push({ name: safeText(item.name), version: safeText(item.version) }); } catch (error) { if (error.code !== 'APPLICATION_PATH') throw error; } }
      }
    } else {
      const requirements = await projectManifest(target.workspace, 'requirements.txt');
      manifests.push({ name: 'requirements.txt', present: requirements !== null, packageManager: 'pip', dependencies: requirements === null ? 0 : requirements.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).length, devDependencies: 0, scripts: [] });
      const lib = path.join(target.workspace, '.venv/lib'), libInfo = await exists(lib);
      if (libInfo) {
        if (!libInfo.isDirectory() || libInfo.isSymbolicLink()) throw applicationIssue('APPLICATION_PATH');
        for (const name of (await io.readdir(lib)).filter(name => /^python3\.\d+$/.test(name)).slice(0, 4)) {
          const relative = `.venv/lib/${name}/site-packages`, directory = path.join(target.workspace, relative), info = await exists(directory); if (!info) continue;
          let cursor = target.workspace; for (const part of relative.split('/')) { cursor = path.join(cursor, part); const stat = await io.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw applicationIssue('APPLICATION_PATH'); }
          for (const entry of await io.readdir(directory)) { if (!entry.endsWith('.dist-info')) continue; if (packages.length >= 1000) { packagesTruncated = true; break; } const metadata = await projectManifest(target.workspace, `${relative}/${entry}/METADATA`); if (typeof metadata === 'string') { const name = /^Name: ([^\r\n]+)/m.exec(metadata)?.[1], version = /^Version: ([^\r\n]+)/m.exec(metadata)?.[1]; if (name && version) packages.push({ name: safeText(name), version: safeText(version) }); } }
        }
      }
    }
    packages.sort((a, b) => a.name.localeCompare(b.name)); return { runtime: runtimeInfo, manifests, packages, packagesTruncated, dependencyState };
  }
  async function manifestSignature(server) {
    const workspace = names(server).workspace, rows = [], filenames = server.kind === 'nodejs' ? ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'] : ['requirements.txt'];
    for (const relative of filenames) {
      try { const filename = await regularWorkspaceFile(workspace, relative), info = await io.lstat(filename); if (info.size > 1024 ** 2) throw applicationIssue('APPLICATION_INPUT', 400); const text = await io.readFile(filename, 'utf8'); if (Buffer.byteLength(text) > 1024 ** 2) throw applicationIssue('APPLICATION_INPUT', 400); rows.push([relative, createHash('sha256').update(text).digest('hex')]); }
      catch (error) { if (absent(error)) rows.push([relative, null]); else throw error; }
    }
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  async function inspectProject(server) {
    ensureOpen(); idOf(server);
    if (server.pid || server.jobId || server.cloneJobId || !['stopped', 'error'].includes(server.status)) throw applicationIssue('APPLICATION_BUSY');
    return exclusiveAccount(server, async () => { const target = names(server); if (!await exists(target.workspace)) return readProject(server); const owner = await account(server); await noProcesses(owner); return readProject(server); });
  }
  return { initialize, capabilities, runtimeCatalog, resolveRuntime, ensureRuntime, runtimeAvailability, assertNoPendingBuilds, inspectProject, prepareWorkspace, launchPlan, start, signalApplication, installDependencies, releaseWorkspace, redact: (server, text) => redactApplicationOutput(text, server.application), async close() { closed = true; for (const controller of controllers) controller.abort(); if (initializing) await initializing.catch(() => {}); await managed.close(); await Promise.allSettled([...active, ...accountLocks.values()]); } };
}
