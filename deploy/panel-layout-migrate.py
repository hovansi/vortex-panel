#!/usr/bin/python3
"""Offline, reversible conversion of the managed legacy panel layout.

Only the two historical default roots are renamed. Custom DATA_DIR values are
retained. No forced unmount, filesystem copy over a mount, account UID change,
or foreign service adoption is permitted. Recovery records remain private.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True

OLD_SOURCE = Path('/opt/bedrock-panel')
NEW_SOURCE = Path('/opt/vortex-panel')
OLD_DATA = Path('/var/lib/bedrock-panel')
NEW_DATA = Path('/var/lib/vortex-panel')
OLD_ENV = Path('/etc/bedrock-panel.env')
NEW_ENV = Path('/etc/vortex-panel.env')
OLD_UNIT = Path('/etc/systemd/system/bedrock-panel.service')
NEW_UNIT = Path('/etc/systemd/system/vortex-panel.service')
OLD_DROPINS = Path(str(OLD_UNIT) + '.d')
NEW_DROPINS = Path(str(NEW_UNIT) + '.d')
BACKUPS = Path('/var/backups/vortex-panel')
NODE_EXECUTABLE = 'node'
UUID = re.compile(r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')


def run(args, *, check=True, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=kwargs.pop('timeout', 300), **kwargs)


def trusted(path, *, directory=False, private=False):
    path = Path(path)
    for parent in [*reversed(path.parents), path]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe root-owned migration path: ' + str(parent))
        if parent != path and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Migration parent is not a directory: ' + str(parent))
    info = path.lstat()
    if directory and not stat.S_ISDIR(info.st_mode) or not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise RuntimeError('Unexpected migration file type: ' + str(path))
    if private and info.st_mode & 0o077:
        raise RuntimeError('Migration metadata must be private: ' + str(path))
    return info


def read_json(path):
    trusted(path, private=True)
    if path.stat().st_size > 32 * 1024 * 1024:
        raise RuntimeError('Oversized migration metadata: ' + str(path))
    return json.loads(path.read_text())


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sync_file(path):
    with path.open('rb') as stream:
        os.fsync(stream.fileno())


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load_helper(path):
    trusted(path)
    spec = importlib.util.spec_from_file_location('_vortex_layout_' + path.stem.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    with temporary.open('x', encoding='utf-8', newline='\n') as stream:
        os.chmod(temporary, 0o600)
        stream.write(json.dumps(value, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def service_flag(flag, name):
    return run(['systemctl', flag, '--quiet', name], check=False).returncode == 0


def text_conversion(text, move_data=False):
    # Infrastructure references only; no Bedrock protocol or user-content edits.
    for old, new in [(str(OLD_SOURCE), str(NEW_SOURCE)), (str(OLD_ENV), str(NEW_ENV)),
                     ('bedrock-panel.service', 'vortex-panel.service')]:
        text = re.sub(re.escape(old) + r'(?=$|[\s/"\x27:;])', lambda _: new, text)
    text = re.sub(r'(?m)^(User|Group)=bedrock-panel$', r'\1=vortex-panel', text)
    if move_data:
        text = re.sub(re.escape(str(OLD_DATA)) + r'(?=$|[\s/"\x27:;])', lambda _: str(NEW_DATA), text)
    return text


def mounts_below(path):
    result = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        if len(fields) < 10:
            raise RuntimeError('Cannot verify the host mount inventory.')
        target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if target == str(path) or target.startswith(str(path) + '/'):
            result.append(target)
    return result


def get_account(database, name):
    try:
        return pwd.getpwnam(name) if database == 'passwd' else grp.getgrnam(name)
    except KeyError:
        return None


def application_accounts(data):
    root = data / '.application-users'
    if not root.exists():
        return []
    trusted(root, directory=True, private=True)
    scope = hashlib.sha256(str(data).encode()).hexdigest()[:8]
    new_scope = hashlib.sha256(str(NEW_DATA).encode()).hexdigest()[:8]
    accounts = []
    for entry in root.iterdir():
        if not entry.name.endswith('.json') or not UUID.fullmatch(entry.stem):
            raise RuntimeError('Application migration needs completed account/build operations; review ' + str(entry))
        value = read_json(entry)
        server_id = value.get('serverId', '')
        name = 'vxapp_' + scope + '_' + server_id.replace('-', '')[:16]
        new_name = 'vxapp_' + new_scope + '_' + server_id.replace('-', '')[:16]
        user, group = get_account('passwd', name), get_account('group', name)
        if (value.get('schema') != 1 or not UUID.fullmatch(server_id) or entry.stem != server_id or
                value.get('scope') != scope or value.get('username') != name or
                value.get('state') != 'active' or not UUID.fullmatch(value.get('ownerId', '')) or
                not user or not group or value.get('uid') != user.pw_uid or value.get('gid') != user.pw_gid or
                user.pw_gid != group.gr_gid or group.gr_mem or user.pw_dir != '/nonexistent' or
                user.pw_shell != '/usr/sbin/nologin' or
                user.pw_gecos != 'vortex-app,' + scope + ',' + server_id + ',' + value['ownerId']):
            raise RuntimeError('Application account ownership must be repaired before migration: ' + str(entry))
        if get_account('passwd', new_name) or get_account('group', new_name):
            raise RuntimeError('Canonical application account name already exists: ' + new_name)
        accounts.append({'old': name, 'new': new_name, 'uid': user.pw_uid, 'gid': user.pw_gid,
                         'serverId': server_id, 'oldScope': scope, 'newScope': new_scope,
                         'ownerId': value['ownerId']})
    names = {account['old'] for account in accounts}
    if any(user.pw_name.startswith('vxapp_' + scope + '_') and user.pw_name not in names for user in pwd.getpwall()):
        raise RuntimeError('An application account lacks an ownership receipt; migration was not started.')
    return accounts


# Reuse the reviewed storage controller so image UUIDs, backing files and mount
# identities receive the same checks as ordinary storage operations.
STORAGE_SCRIPT = r'''
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const [source,data,operation,selected,verifyAccounts] = process.argv.slice(1);
const {activeDataProcesses} = await import(pathToFileURL(source+'/server/storage-cli.js'));
if (verifyAccounts==='yes'&&(await activeDataProcesses(data)).length) throw Error('Managed data processes remain active; stop them before migration.');
const {createStorageController} = await import(pathToFileURL(source+'/server/storage-volumes.js'));
const store=JSON.parse(await fs.readFile(data+'/panel.json','utf8'));
if(!Array.isArray(store.servers)||store.servers.length>10000)throw Error('Invalid stopped server inventory.');
const controller=createStorageController({dataDir:data});
const fixed=store.servers.filter(row=>row.storagePolicy?.mode==='fixed');
if(fixed.length && !(await controller.initialize()).supported)throw Error('Owned volume maintenance is unavailable.');
const requested=JSON.parse(selected),ids=[];
try {
  for(const row of fixed){
    if(operation==='inspect'){if(await controller.isMounted(row))ids.push(row.id);}
    else if(requested.includes(row.id)){
      if(operation==='unmount'){if((await controller.unmount(row))?.ok!==true||await controller.isMounted(row))throw Error('Owned volume failed to unmount.');}
      else {await controller.ensureMounted(row);if(!await controller.isMounted(row))throw Error('Owned volume failed to remount.');}
      ids.push(row.id);
    }
  }
  if(operation!=='inspect'&&ids.length!==requested.length)throw Error('Storage receipt inventory changed.');
  console.log(JSON.stringify(ids));
}finally{await controller.close();}
'''


def storage(source, data, operation, ids, verify_accounts=True):
    trusted(source / 'server/storage-cli.js')
    trusted(source / 'server/storage-volumes.js')
    try:
        result = run([NODE_EXECUTABLE, '--input-type=module', '-e', STORAGE_SCRIPT, source, data, operation, json.dumps(ids), 'yes' if verify_accounts else 'no'], timeout=600)
    except subprocess.CalledProcessError as error:
        detail = next((line.strip() for line in (error.stderr or '').splitlines() if re.match(r'^(?:Error|[A-Za-z]+Error):', line)), '')
        raise RuntimeError('Owned storage ' + operation + ' failed. Stop surviving workloads and review volume/application ownership before retrying. ' + detail[:400]) from None
    except subprocess.TimeoutExpired:
        raise RuntimeError('Owned storage maintenance timed out; retain the private migration receipt and inspect busy mounts before recovery.') from None
    value = json.loads(result.stdout)
    if not isinstance(value, list) or any(not isinstance(item, str) or not UUID.fullmatch(item) for item in value):
        raise RuntimeError('Invalid volume maintenance response.')
    return value


class Migration:
    def __init__(self, transaction):
        self.path = Path(transaction)
        if self.path.name != 'transaction.json' or self.path.parent.parent != BACKUPS or not re.fullmatch(r'migration-[A-Za-z0-9_-]{10,100}', self.path.parent.name):
            raise RuntimeError('Use /var/backups/vortex-panel/migration-TIMESTAMP/transaction.json for private recovery.')
        self.record = None

    def save(self):
        write_json(self.path, self.record)

    def load(self):
        trusted(self.path.parent, directory=True, private=True)
        self.record = read_json(self.path)
        if self.record.get('schemaVersion') != 1 or self.record.get('machineId') != Path('/etc/machine-id').read_text().strip():
            raise RuntimeError('Migration receipt is not for this machine.')

    def snapshot_file(self, path):
        if not path.exists():
            return
        trusted(path)
        backup = self.path.parent / ('config-' + str(len(self.record['files'])))
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
        sync_file(backup)
        self.record_artifact(backup)
        self.record['files'].append({'path': str(path), 'backup': backup.name,
                                     'mode': stat.S_IMODE(path.stat().st_mode),
                                     'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        self.save()

    def record_artifact(self, path):
        info = trusted(path, private=True)
        self.record.setdefault('artifacts', []).append({'path': str(path), 'sha256': file_digest(path),
                                                       'dev': info.st_dev, 'ino': info.st_ino,
                                                       'uid': info.st_uid, 'mode': stat.S_IMODE(info.st_mode)})

    def mutate_file(self, path, data):
        # Save the intended bytes before replacing them so a power interruption
        # after the write still has a known before/after state for recovery.
        self.record.setdefault('modifiedHashes', {})[str(path)] = hashlib.sha256(data).hexdigest()
        self.save()
        temporary = path.with_name('.' + path.name + '.vortex-' + self.record['id'])
        info = path.stat()
        with temporary.open('xb') as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)

    def rename(self, old, new):
        if not old.exists():
            return
        if os.path.lexists(new):
            raise RuntimeError('Migration destination already exists: ' + str(new))
        self.record['moves'].append({'old': str(old), 'new': str(new),
                                     'kind': 'directory' if old.is_dir() else 'file',
                                     'identity': [old.stat().st_dev, old.stat().st_ino]})
        self.save()
        os.rename(old, new)
        sync_directory(old.parent)

    def lock_data(self, data):
        if os.path.lexists(data / 'panel.lock'):
            raise RuntimeError('Panel data still has a process/maintenance lock. Resolve it before migration: ' + str(data / 'panel.lock'))
        identity = 'backup-layout-' + self.record['id']
        descriptor = os.open(data / 'panel.lock', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump({'pid': os.getpid(), 'identity': identity}, stream)
        self.record['dataLock'] = identity
        self.save()

    def unlock_data(self, data):
        lock = data / 'panel.lock'
        if not lock.exists():
            return
        # DATA_DIR may belong to the dedicated non-root service identity. The
        # root-created maintenance lock itself must still be private and exact.
        info = lock.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or
                info.st_mode & 0o077 or info.st_size > 4096 or data.resolve() != data):
            raise RuntimeError('Data maintenance lock changed during migration.')
        if json.loads(lock.read_text()).get('identity') == self.record.get('dataLock'):
            lock.unlink()

    def apply(self):
        global NODE_EXECUTABLE
        if BACKUPS.exists():
            trusted(BACKUPS, directory=True, private=True)
            for pending in BACKUPS.glob('migration-*/transaction.json'):
                if read_json(pending).get('state') not in ('committed', 'rolled-back'):
                    raise RuntimeError('A previous migration needs recovery: sudo python3 deploy/panel-layout-migrate.py rollback --transaction ' + str(pending))
        if not any(os.path.lexists(path) for path in (OLD_SOURCE, OLD_DATA, OLD_ENV, OLD_UNIT, OLD_DROPINS)):
            return
        if (OLD_DATA.exists() and not any(os.path.lexists(path) for path in (OLD_SOURCE, OLD_ENV, OLD_UNIT, OLD_DROPINS))
                and all(path.exists() for path in (NEW_SOURCE, NEW_ENV, NEW_UNIT))):
            # An explicitly configured canonical installation can retain an
            # unused historical default data directory (or explicitly use it
            # as custom data). Its name alone never establishes ownership.
            trusted(NEW_SOURCE, directory=True)
            trusted(NEW_ENV)
            trusted(NEW_UNIT)
            if ('Description=Vortex Panel' in NEW_UNIT.read_text() and
                    '/opt/vortex-panel/current/server/index.js' in NEW_UNIT.read_text()):
                print('Canonical panel configuration retained; the historical data path is not automatically adopted or moved.')
                return
        for path in (NEW_SOURCE, NEW_ENV, NEW_UNIT, NEW_DROPINS):
            if os.path.lexists(path):
                raise RuntimeError('Both legacy and canonical panel components exist. Reconcile them before updating: ' + str(path))
        if not OLD_UNIT.exists() or not OLD_ENV.exists() or not OLD_SOURCE.exists():
            raise RuntimeError('Incomplete legacy install. Restore its unit, environment and /opt/bedrock-panel source before migration.')
        trusted(OLD_SOURCE, directory=True)
        trusted(OLD_UNIT)
        trusted(OLD_ENV)
        unit = OLD_UNIT.read_text()
        if ('Description=Vortex Panel' not in unit or 'WorkingDirectory=/opt/bedrock-panel/current' not in unit or
                'EnvironmentFile=/etc/bedrock-panel.env' not in unit or '/opt/bedrock-panel/current/server/index.js' not in unit):
            raise RuntimeError('Legacy unit is custom or unfamiliar. Review and convert it explicitly before updating.')
        commands = re.findall(r'^ExecStart=(.+)$', unit, re.M)
        command = shlex.split(commands[-1]) if commands else []
        if len(command) != 2 or command[1] != str(OLD_SOURCE / 'current/server/index.js') or not Path(command[0]).is_absolute():
            raise RuntimeError('Legacy unit must identify one absolute panel Node interpreter before migration.')
        node_binary = Path(command[0]).resolve(strict=True)
        node_info = trusted(node_binary)
        if not node_info.st_mode & 0o111:
            raise RuntimeError('Legacy panel Node interpreter is not executable. Restore it before migration.')
        NODE_EXECUTABLE = str(node_binary)
        current = OLD_SOURCE / 'current'
        if not current.is_symlink():
            raise RuntimeError('Legacy current source must be a managed release symlink.')
        source = current.resolve(strict=True)
        if not source.is_relative_to(OLD_SOURCE / 'releases'):
            raise RuntimeError('Legacy source symlink is outside its managed releases directory.')
        trusted(source, directory=True)
        isolation_receipt = Path('/var/lib/vortex-application-isolation/apparmor.json')
        if isolation_receipt.exists():
            load_helper(source / 'deploy/application-isolation.py').IsolationInstaller().owned_receipt()
        zram_owner = Path('/etc/vortex-zram/owner.json')
        if zram_owner.exists():
            owned = read_json(zram_owner)
            if owned.get('role') == 'panel':
                memory = load_helper(source / 'server/host-zram.py').HostZram('panel', 'local')
                owner = memory.owner()
                memory.verify_unit(owner)
        configured = re.findall(r'^DATA_DIR=(.*)$', OLD_ENV.read_text(), re.M)
        configured = configured[-1].strip().strip('"') if configured else str(OLD_DATA)
        data = Path(configured)
        if not data.is_absolute() or str(data.resolve()) != str(data) or not data.is_dir():
            raise RuntimeError('Legacy DATA_DIR must be an existing canonical directory.')
        legacy_identity = get_account('passwd', 'bedrock-panel')
        info = data.lstat()
        if info.st_uid not in ({0, legacy_identity.pw_uid} if legacy_identity else {0}) or info.st_mode & 0o077:
            raise RuntimeError('Legacy DATA_DIR must be private and owned by the panel identity.')
        if (str(data) in ('/', '/etc', '/var', '/var/lib', '/opt', '/home', '/root', '/tmp', '/var/tmp') or
                any(data == Path(base) or data.is_relative_to(Path(base)) for base in ('/usr', '/etc', '/run', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/lib', '/lib64')) or
                data == OLD_SOURCE or data.is_relative_to(OLD_SOURCE) or OLD_SOURCE.is_relative_to(data)):
            raise RuntimeError('Legacy DATA_DIR must be a dedicated panel directory.')
        panel = data / 'panel.json'
        if not panel.is_file() or panel.is_symlink() or panel.stat().st_nlink != 1 or panel.stat().st_size > 32 * 1024**2:
            raise RuntimeError('Legacy DATA_DIR must contain a regular panel.json inventory.')
        # Custom data remains explicit in the env file and is never renamed.
        move_data = data == OLD_DATA
        if move_data and os.path.lexists(NEW_DATA):
            raise RuntimeError('Canonical data destination already exists; no data was overwritten.')
        if move_data and os.path.lexists(data / '.vortex-layout.json'):
            raise RuntimeError('Legacy data already contains a layout receipt; review its migration history first.')
        if move_data:
            if str(data) in mounts_below(data):
                raise RuntimeError('Legacy DATA_DIR is itself a mountpoint. Move the filesystem mount through administrator maintenance first; the installer will not rename it.')
        if mounts_below(OLD_SOURCE):
            raise RuntimeError('Legacy source contains mounted filesystems; unmount those explicitly before migration.')
        if OLD_DROPINS.exists():
            trusted(OLD_DROPINS, directory=True)
            for entry in OLD_DROPINS.iterdir():
                trusted(entry)
                if entry.suffix != '.conf':
                    raise RuntimeError('Review unexpected systemd drop-in: ' + str(entry))
        if not BACKUPS.exists():
            BACKUPS.mkdir(mode=0o700)
        trusted(BACKUPS, directory=True, private=True)
        self.path.parent.mkdir(mode=0o700)
        self.record = {'schemaVersion': 1, 'id': uuid.uuid4().hex, 'machineId': Path('/etc/machine-id').read_text().strip(),
                       'createdAt': time.time(), 'state': 'preparing', 'data': str(data), 'moveData': move_data,
                       'canonicalSource': str(NEW_SOURCE), 'canonicalData': str(NEW_DATA if move_data else data),
                       'sourceRelease': str(source), 'active': service_flag('is-active', 'bedrock-panel.service'),
                       'nodeBinary': str(node_binary),
                       'enabled': service_flag('is-enabled', 'bedrock-panel.service'), 'moves': [], 'files': [],
                       'mountedIds': [], 'accounts': [], 'accountChanges': [], 'mainAccountChanges': []}
        self.save()
        try:
            self.snapshot_file(OLD_ENV)
            self.snapshot_file(OLD_UNIT)
            for filename in ('/var/lib/vortex-application-isolation/apparmor.json', '/etc/vortex-zram/owner.json', '/etc/systemd/system/vortex-zram.service'):
                self.snapshot_file(Path(filename))
            self.record['state'] = 'stopping'
            self.save()
            run(['systemctl', 'stop', 'bedrock-panel.service'])
            if service_flag('is-active', 'bedrock-panel.service'):
                raise RuntimeError('Legacy service has not stopped.')
            self.lock_data(data)
            # Inspect application receipts even without fixed volumes, to prove
            # their dropped UIDs have no surviving processes.
            self.record['mountedIds'] = storage(source, data, 'inspect', [])
            self.save()
            if move_data:
                self.record['accounts'] = application_accounts(data)
                self.save()
            storage(source, data, 'unmount', self.record['mountedIds'])
            if any(target != str(data) or move_data for target in mounts_below(data)):
                raise RuntimeError('A foreign or busy data mount remains. No data directory was moved.')
            loops = json.loads(run(['losetup', '--json', '--list', '--output', 'BACK-FILE']).stdout).get('loopdevices', [])
            if move_data and any(str(row.get('back-file', '')).startswith(str(data) + '/') for row in loops):
                raise RuntimeError('A loop backing file remains attached to legacy data. Review it before migration.')
            # A complete stopped-data snapshot precedes every rename, including
            # sparse images, encryption keys and application identity receipts.
            size = int(run(['du', '-sx', '--block-size=1', data]).stdout.split()[0])
            if shutil.disk_usage(self.path.parent).free < size + max(64 * 1024**2, size // 20):
                raise RuntimeError('Insufficient free space for the private migration data snapshot. Free space in /var/backups/vortex-panel and retry.')
            archive = self.path.parent / 'data-before.tar'
            run(['tar', '--create', '--sparse', '--file', archive, '--directory', data, '--exclude=./panel.lock', '.'], timeout=86400)
            os.chmod(archive, 0o600)
            sync_file(archive)
            self.record_artifact(archive)
            self.record['dataBackup'] = archive.name
            self.save()
            run(['systemctl', 'disable', 'bedrock-panel.service'])
            self.rename(OLD_SOURCE, NEW_SOURCE)
            if node_binary.is_relative_to(OLD_SOURCE):
                NODE_EXECUTABLE = str(NEW_SOURCE / node_binary.relative_to(OLD_SOURCE))
            # Absolute current symlinks must follow the source rename.
            self.record['previousCurrentLink'] = os.readlink(NEW_SOURCE / 'current')
            self.save()
            if self.record['previousCurrentLink'].startswith(str(OLD_SOURCE) + '/'):
                temporary = NEW_SOURCE / ('.vortex-current-' + self.record['id'])
                temporary.symlink_to(self.record['previousCurrentLink'].replace(str(OLD_SOURCE), str(NEW_SOURCE), 1))
                os.replace(temporary, NEW_SOURCE / 'current')
                sync_directory(NEW_SOURCE)
            if move_data:
                self.rename(OLD_DATA, NEW_DATA)
                data = NEW_DATA
                marker = {'schemaVersion': 1, 'migrationId': self.record['id'],
                          'machineId': self.record['machineId'], 'previousDataDir': str(OLD_DATA),
                          'dataDir': str(NEW_DATA), 'firewallScope': str(OLD_DATA)}
                marker_bytes = (json.dumps(marker, indent=2) + '\n').encode()
                self.record['createdFiles'] = [{'path': str(data / '.vortex-layout.json'),
                                                'sha256': hashlib.sha256(marker_bytes).hexdigest()}]
                self.save()
                write_json(data / '.vortex-layout.json', marker)
            self.rename(OLD_ENV, NEW_ENV)
            self.rename(OLD_UNIT, NEW_UNIT)
            self.rename(OLD_DROPINS, NEW_DROPINS)
            environment = NEW_ENV.read_text()
            if move_data:
                environment = re.sub(r'(?m)^DATA_DIR=.*$', 'DATA_DIR=' + str(data), environment)
            self.mutate_file(NEW_ENV, environment.encode())
            os.chmod(NEW_ENV, 0o600)
            self.mutate_file(NEW_UNIT, text_conversion(NEW_UNIT.read_text(), move_data).encode())
            if NEW_DROPINS.exists():
                for entry in NEW_DROPINS.iterdir():
                    self.snapshot_file(entry)
                    self.mutate_file(entry, text_conversion(entry.read_text(), move_data).encode())
            for account in self.record['accounts']:
                self.record['accountChanges'].append(account)
                self.save()
                run(['groupmod', '--new-name', account['new'], account['old']])
                run(['usermod', '--login', account['new'], '--comment', 'vortex-app,' + account['newScope'] + ',' + account['serverId'] + ',' + account['ownerId'], account['old']])
                receipt = data / '.application-users' / (account['serverId'] + '.json')
                self.snapshot_file(receipt)
                value = read_json(receipt)
                value.update(scope=account['newScope'], username=account['new'])
                self.mutate_file(receipt, (json.dumps(value, indent=2) + '\n').encode())
            legacy_user = get_account('passwd', 'bedrock-panel')
            if legacy_user:
                if get_account('passwd', 'vortex-panel') or get_account('group', 'vortex-panel'):
                    raise RuntimeError('Both legacy and canonical panel accounts exist. Reconcile them without changing UIDs first.')
                old_group = get_account('group', 'bedrock-panel')
                if not old_group or legacy_user.pw_gid != old_group.gr_gid or old_group.gr_mem or legacy_user.pw_dir not in (self.record['data'], str(OLD_DATA)) or legacy_user.pw_shell != '/usr/sbin/nologin':
                    raise RuntimeError('Legacy panel account is custom; review it before migration.')
                self.record['mainAccountChanges'].append({'oldHome': legacy_user.pw_dir})
                self.save()
                run(['groupmod', '--new-name', 'vortex-panel', 'bedrock-panel'])
                run(['usermod', '--login', 'vortex-panel', '--home', str(data), 'bedrock-panel'])
            receipt = Path('/var/lib/vortex-application-isolation/apparmor.json')
            if receipt.exists():
                value = read_json(receipt)
                if 'bedrock-panel.service' in value.get('owners', {}):
                    snapshot = next(item for item in self.record['files'] if item['path'] == str(receipt))
                    if hashlib.sha256(receipt.read_bytes()).hexdigest() != snapshot['sha256']:
                        raise RuntimeError('Application isolation ownership changed concurrently; preserve the recovery receipt.')
                    if 'vortex-panel.service' in value['owners']:
                        raise RuntimeError('Both isolation ownership keys exist. Review them before migration.')
                    value['owners']['vortex-panel.service'] = value['owners'].pop('bedrock-panel.service')
                    self.mutate_file(receipt, (json.dumps(value, indent=2) + '\n').encode())
            owner = Path('/etc/vortex-zram/owner.json')
            if owner.exists():
                value = read_json(owner)
                if value.get('role') == 'panel' and value.get('serviceId') == 'bedrock-panel.service':
                    snapshot = next(item for item in self.record['files'] if item['path'] == str(owner))
                    if hashlib.sha256(owner.read_bytes()).hexdigest() != snapshot['sha256']:
                        raise RuntimeError('Memory assistance ownership changed concurrently; preserve the recovery receipt.')
                    value['serviceId'] = 'vortex-panel.service'
                    self.mutate_file(owner, (json.dumps(value, indent=2) + '\n').encode())
                    unit = Path('/etc/systemd/system/vortex-zram.service')
                    if unit.exists():
                        self.mutate_file(unit, unit.read_text().replace('bedrock-panel.service', 'vortex-panel.service').encode())
            self.unlock_data(data)
            run(['systemctl', 'daemon-reload'])
            if self.record['enabled']:
                run(['systemctl', 'enable', 'vortex-panel.service'])
            self.record['state'] = 'applied'
            self.save()
            print('Legacy layout migrated; private backup and rollback receipt: ' + str(self.path))
        except BaseException:
            try:
                self.rollback()
            except BaseException as recovery:
                print('Migration recovery needs review: ' + str(self.path) + ' (' + type(recovery).__name__ + ')', file=sys.stderr)
            raise

    def rollback(self):
        global NODE_EXECUTABLE
        if self.record is None:
            self.load()
        if self.record['state'] == 'rolled-back':
            return
        if self.record['state'] == 'committed':
            raise RuntimeError('A committed migration cannot be blindly reversed after new data writes; use the private snapshot during planned recovery.')
        run(['systemctl', 'stop', 'vortex-panel.service'], check=False)
        run(['systemctl', 'disable', 'vortex-panel.service'], check=False)
        if service_flag('is-active', 'vortex-panel.service'):
            raise RuntimeError('Canonical service must stop before rollback.')
        data_moved = self.record['moveData'] and NEW_DATA.exists() and not OLD_DATA.exists()
        data = NEW_DATA if data_moved else Path(self.record['data'])
        source = NEW_SOURCE / 'releases' / Path(self.record['sourceRelease']).name if NEW_SOURCE.exists() else Path(self.record['sourceRelease'])
        node_binary = Path(self.record['nodeBinary'])
        if node_binary.is_relative_to(OLD_SOURCE) and NEW_SOURCE.exists():
            node_binary = NEW_SOURCE / node_binary.relative_to(OLD_SOURCE)
        NODE_EXECUTABLE = str(node_binary)
        # Account names and data-path scopes can be between stages after an
        # interrupted rename. Guard the recorded UIDs directly in that case.
        app_uids = {account['uid'] for account in self.record['accounts']}
        for process in Path('/proc').iterdir():
            if not process.name.isdigit():
                continue
            try:
                status = (process / 'status').read_text()
                ids = re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)', status, re.M)
                if not ids or any(int(value) in app_uids for value in ids.groups()):
                    raise RuntimeError('A managed application UID remains active; stop it before recovery.')
                executable = os.readlink(process / 'exe')
                if Path(executable).name == 'bedrock_server':
                    cwd = os.readlink(process / 'cwd')
                    if cwd == str(data) or cwd.startswith(str(data) + '/') or executable.startswith(str(data) + '/'):
                        raise RuntimeError('A Bedrock process still uses the migration data directory.')
            except (FileNotFoundError, ProcessLookupError):
                continue
            except OSError as error:
                if error.errno == 22:  # Kernel thread without executable.
                    continue
                raise
        if data.exists() and (data / 'panel.json').exists():
            # Candidate readiness can have mounted volumes. Stop only mounts
            # verified against their owned image; never force unknown mounts.
            mounted = storage(source, data, 'inspect', [], verify_accounts=False)
            storage(source, data, 'unmount', mounted, verify_accounts=False)
            if data_moved and mounts_below(data):
                raise RuntimeError('A data mount remains; rollback preserved its recovery anchors.')
        for account in reversed(self.record['accountChanges']):
            if get_account('passwd', account['new']):
                run(['usermod', '--login', account['old'], '--comment', 'vortex-app,' + account['oldScope'] + ',' + account['serverId'] + ',' + account['ownerId'], account['new']])
            if get_account('group', account['new']):
                run(['groupmod', '--new-name', account['old'], account['new']])
        for item in self.record['mainAccountChanges']:
            if get_account('passwd', 'vortex-panel'):
                run(['usermod', '--login', 'bedrock-panel', '--home', item['oldHome'], 'vortex-panel'])
            if get_account('group', 'vortex-panel'):
                run(['groupmod', '--new-name', 'bedrock-panel', 'vortex-panel'])
        for item in self.record.get('createdFiles', []):
            target = Path(item['path'])
            if target.exists():
                info = target.lstat()
                if (target != data / '.vortex-layout.json' or target.resolve() != target or
                        not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                        info.st_nlink != 1 or info.st_mode & 0o077):
                    raise RuntimeError('Migration-created marker ownership changed.')
                content = target.read_bytes()
                if hashlib.sha256(content).hexdigest() != item['sha256']:
                    # A failed commit may have atomically appended the final
                    # transaction proof before its directory sync failed.
                    value = json.loads(content)
                    value.pop('transactionPath', None)
                    value.pop('transactionSHA256', None)
                    initial = (json.dumps(value, indent=2) + '\n').encode()
                    if hashlib.sha256(initial).hexdigest() != item['sha256']:
                        raise RuntimeError('Migration-created marker changed; review it before rollback: ' + str(target))
                target.unlink()
        # Restore mutable references before paths, translating snapshot paths
        # whose containing tree was renamed back after the snapshot was made.
        for item in reversed(self.record['files']):
            target = Path(item['path'])
            if not target.exists():
                for move in self.record['moves']:
                    old, new = Path(move['old']), Path(move['new'])
                    if target == old or target.is_relative_to(old):
                        candidate = new / target.relative_to(old)
                        if candidate.exists():
                            target = candidate
                            break
                    elif target == new or target.is_relative_to(new):
                        candidate = old / target.relative_to(new)
                        if candidate.exists():
                            target = candidate
                            break
            trusted(target)
            known_hashes = {item['sha256']}
            known_hashes.add(self.record.get('modifiedHashes', {}).get(str(target)))
            if hashlib.sha256(target.read_bytes()).hexdigest() not in known_hashes:
                raise RuntimeError('Configuration changed after migration snapshot; review it before recovery: ' + str(target))
            shutil.copyfile(self.path.parent / item['backup'], target)
            os.chmod(target, item['mode'])
            sync_file(target)
        if NEW_SOURCE.exists() and self.record.get('previousCurrentLink'):
            current = NEW_SOURCE / 'current'
            if current.exists() and not current.is_symlink():
                raise RuntimeError('Source rollback symlink changed; retaining recovery anchors.')
            temporary = NEW_SOURCE / ('.vortex-current-rollback-' + self.record['id'])
            temporary.symlink_to(self.record['previousCurrentLink'])
            os.replace(temporary, current)
            sync_directory(NEW_SOURCE)
        for move in reversed(self.record['moves']):
            old, new = Path(move['old']), Path(move['new'])
            if new.exists():
                if old.exists() or (move['kind'] == 'directory' and [new.stat().st_dev, new.stat().st_ino] != move['identity']):
                    raise RuntimeError('Migration path changed during rollback: ' + str(new))
                os.rename(new, old)
                sync_directory(old.parent)
        data = Path(self.record['data'])
        NODE_EXECUTABLE = self.record['nodeBinary']
        if data.exists():
            self.unlock_data(data)
            if self.record['mountedIds']:
                storage(Path(self.record['sourceRelease']), data, 'mount', self.record['mountedIds'])
        run(['systemctl', 'daemon-reload'])
        if self.record['enabled']:
            run(['systemctl', 'enable', 'bedrock-panel.service'])
        if self.record['active']:
            run(['systemctl', 'start', 'bedrock-panel.service'])
        self.record['state'] = 'rolled-back'
        self.save()
        print('Legacy service and layout restored. Private snapshot retained: ' + str(self.path.parent))

    def commit(self):
        self.load()
        if self.record['state'] != 'applied':
            raise RuntimeError('Migration is not ready to commit.')
        marker = None
        if self.record['moveData']:
            marker_path = NEW_DATA / '.vortex-layout.json'
            marker = json.loads(marker_path.read_text())
            if marker.get('migrationId') != self.record['id'] or marker.get('machineId') != self.record['machineId']:
                raise RuntimeError('Layout marker changed before migration commit.')
        self.record['state'] = 'committed'
        self.record['committedAt'] = time.time()
        try:
            self.save()
            if marker is not None:
                marker['transactionPath'] = str(self.path)
                marker['transactionSHA256'] = file_digest(self.path)
                write_json(marker_path, marker)
        except Exception:
            # A synchronous failure still permits automatic installer rollback.
            # A process/power interruption after a committed receipt leaves a
            # working canonical layout; its private snapshot is retained.
            self.record['state'] = 'applied'
            self.record.pop('committedAt', None)
            self.save()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('apply', 'rollback', 'commit'))
    parser.add_argument('--transaction', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Layout migration requires root.')
    os.umask(0o077)
    migration = Migration(args.transaction)
    getattr(migration, args.operation)()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Vortex layout migration: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
