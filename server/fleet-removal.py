#!/usr/bin/env python3
"""Fixed-purpose native Vortex erasure with detached receipts.

No HTTP supplied path or command is accepted.  The caller must authenticate the
SSH host, freeze admission, explicitly confirm data erasure, then independently
verify this receipt over the same pinned SSH connection.  A verified uninstall
can still retain unknown shared state; baselineRestored is a separate claim.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import ssl
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$', re.I)
SHA = re.compile(r'^[a-f0-9]{64}$')
MACHINE = re.compile(r'^[a-f0-9]{32}$')
ZONE = re.compile(r'^(?:[A-Za-z0-9_+-]+/)*[A-Za-z0-9_+-]+$')
NETWORK_KEYS = ('net.core.rmem_max', 'net.core.wmem_max', 'net.ipv4.tcp_congestion_control', 'net.core.default_qdisc')
TLS_PATHS = ('/etc/vortex-panel/tls-management.json', '/etc/vortex-panel/acme', '/etc/vortex-panel/tls-managed', '/opt/vortex-panel/acme-runtime',
             '/var/lib/vortex-panel-acme', '/var/lib/vortex-panel-acme-logs', '/var/log/vortex-panel-acme', '/etc/systemd/system/vortex-panel-tls-renew.service', '/etc/systemd/system/vortex-panel-tls-renew.timer')
WORK = '/run/vortex-fleet-removal'
LOCK = '/run/vortex-os-maintenance.lock'
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
SOURCE = Path(__file__).resolve(strict=True)
PROTECTED_PACKAGES = re.compile(r'^(?:lib|linux-|base-|ubuntu-|network|cloud-|openssh|python3|systemd|apparmor|wireless-|(?:ssh|dbus|sudo|login|passwd|apt|dpkg|ufw|nftables|iptables|iproute2|netplan|ca-certificates|coreutils|findutils|procps|util-linux|mount|e2fsprogs|kmod|init|bash|dash|tar|gzip|xz-utils|tzdata|rsyslog|snapd|grub|udev|openssl|curl)(?:$|[-.:]))')


class RemovalError(Exception):
    pass


def require(value, message):
    if not value:
        raise RemovalError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def package_digest(rows):
    require(isinstance(rows, list) and len(rows) <= 100000, 'Package baseline exceeds its bound.')
    normalized = []
    for row in rows:
        require(isinstance(row, dict) and re.fullmatch('[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?', str(row.get('name', ''))) and isinstance(row.get('version'), str) and type(row.get('manual')) is bool, 'Package baseline is invalid.')
        normalized.append({key: row[key] for key in ['name', 'version', 'manual']})
    require(len({row['name'] for row in normalized}) == len(normalized), 'Package baseline has duplicate identities.')
    return digest(sorted(normalized, key=lambda row: row['name']))


def execute(args, timeout=40, missing=False, input_text=None):
    result = subprocess.run([str(value) for value in args], input=input_text, capture_output=True, text=True, timeout=timeout,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C', 'DEBIAN_FRONTEND': 'noninteractive', 'NEEDRESTART_MODE': 'l', 'NEEDRESTART_SUSPEND': '1'})
    require(len(result.stdout) <= 32 * 1024 ** 2 and len(result.stderr) <= 1024 ** 2, 'Host command exceeded its output bound.')
    require(missing or result.returncode == 0, 'A fixed host inspection or cleanup command failed.')
    return result.stdout.strip()


def validate(value, mutation=False):
    require(isinstance(value, dict), 'Invalid removal request.')
    allowed = {'schemaVersion', 'role', 'nodeId', 'machineId', 'requestId', 'revision', 'confirmedErase', 'panelId', 'workerProofs'}
    require(not set(value) - allowed and value.get('schemaVersion') == 1 and value.get('role') in ['panel', 'worker'], 'Unsupported removal request.')
    require(value.get('nodeId') == 'local' if value['role'] == 'panel' else UUID.fullmatch(str(value.get('nodeId', ''))), 'Invalid target identity.')
    if mutation:
        require(MACHINE.fullmatch(str(value.get('machineId', ''))) and UUID.fullmatch(str(value.get('requestId', ''))) and SHA.fullmatch(str(value.get('revision', ''))) and SHA.fullmatch(str(value.get('panelId', ''))) and value.get('confirmedErase') is True, 'Explicit pinned erasure confirmation is required.')
    return value


def identity_revision(identity):
    value = {key: row for key, row in identity.items() if key not in ['accounts', 'storage']}
    value['accounts'] = [{key: row[key] for key in ['name', 'passwd', 'group', 'uid', 'gid', 'record']} for row in identity['accounts']]
    value['storage'] = [{**{key: row[key] for key in ['target', 'source', 'fstype', 'filesystemUUID', 'record']}, 'image': {key: item for key, item in row['image'].items() if key != 'mtimeNs'}} for row in identity['storage']]
    return digest(value)


class Host:
    def __init__(self, root=None, run=execute, enforce_owner=True):
        # The optional fixture root is deliberately not exposed by the CLI.
        self.root = Path(root) if root else None
        self.run = run
        self.enforce_owner = enforce_owner
        self.allowed_uids = {0}

    def path(self, name):
        require(str(name).startswith('/') and '..' not in Path(name).parts, 'Unsafe fixed host path.')
        return self.root / str(name).lstrip('/') if self.root else Path(name)

    def logical(self, path):
        return '/' + str(Path(path).relative_to(self.root)).replace('\\', '/') if self.root else str(path)

    def safe(self, path, missing=False, link=False, mutable=False):
        path = Path(path)
        require(path.is_absolute() and '..' not in path.parts, 'Unsafe owned path.')
        for parent in reversed(path.parents):
            if not os.path.lexists(parent):
                continue
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'An owned path ancestor is linked or not a directory.')
            if self.enforce_owner:
                uids = self.allowed_uids if mutable and hasattr(self, 'data') and (parent == self.data or self.data in parent.parents) else {0}
                require(info.st_uid in uids and not info.st_mode & 0o022, 'An owned path ancestor has unsafe ownership or access.')
        try:
            info = path.lstat()
        except FileNotFoundError:
            require(missing, 'An expected owned path is missing.')
            return None
        require(link or not stat.S_ISLNK(info.st_mode), 'An owned path was replaced by a symbolic link.')
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Special files and hard links are preserved.')
        if self.enforce_owner:
            require(info.st_uid in (self.allowed_uids if mutable else {0}) and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022 or mutable and info.st_uid != 0), 'An owned path has unsafe ownership or access.')
        return info

    def read(self, path, maximum=1024 ** 2, private=False, mutable=False):
        info = self.safe(path, mutable=mutable)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum and (not private or not self.enforce_owner or not info.st_mode & 0o077), 'Ownership evidence is not a bounded private regular file.')
        fd = os.open(path, os.O_RDONLY | NOFOLLOW)
        try:
            current = os.fstat(fd)
            require((info.st_dev, info.st_ino) == (current.st_dev, current.st_ino) and current.st_nlink == 1, 'Ownership evidence changed while opening.')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                value = stream.read(maximum + 1)
            require(len(value) <= maximum, 'Ownership evidence exceeds its bound.')
            return value
        finally:
            os.close(fd)

    def load(self, path, maximum=1024 ** 2, private=False, mutable=False):
        return json.loads(self.read(path, maximum, private, mutable))

    def stamp(self, path, content=True, link=False, mutable=False):
        info = self.safe(path, link=link, mutable=mutable)
        value = {'path': str(path), 'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'file', 'dev': info.st_dev, 'ino': info.st_ino,
                 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
        if value['kind'] == 'file':
            value.update(size=info.st_size, mtimeNs=info.st_mtime_ns)
        if value['kind'] == 'file' and content:
            value['sha256'] = hashlib.sha256(self.read(path, 256 * 1024 ** 2, mutable=mutable)).hexdigest()
        if value['kind'] == 'symlink':
            value['target'] = os.readlink(path)
        return value

    def same(self, row, content=True, mutable=False):
        require(isinstance(row, dict) and set(row) >= {'path', 'kind', 'dev', 'ino', 'uid', 'mode'} and row['kind'] in ['file', 'directory', 'symlink'], 'A path identity receipt is incomplete.')
        if row['kind'] == 'file' and content:
            require(SHA.fullmatch(str(row.get('sha256', ''))), 'A file identity receipt has no content hash.')
        if row['kind'] == 'symlink':
            require(isinstance(row.get('target'), str), 'A link identity receipt has no target.')
        actual = self.stamp(row['path'], content=content, link=row['kind'] == 'symlink', mutable=mutable)
        return all(actual.get(key) == value for key, value in row.items() if key in actual)

    def machine(self):
        value = self.read(self.path('/etc/machine-id'), 128).decode().strip()
        require(MACHINE.fullmatch(value), 'Host identity is unavailable.')
        return value

    def property(self, name, unit=None):
        return self.run(['systemctl', 'show', unit or self.unit, '--property=' + name, '--value'], missing=True)

    def configure(self, request):
        self.role, self.node_id = request['role'], request['nodeId']
        canonical = 'vortex-panel' if self.role == 'panel' else 'vortex-node'
        self.unit = canonical + '.service'
        if self.role == 'panel' and self.property('FragmentPath', self.unit) != str(self.path('/etc/systemd/system/' + self.unit)):
            legacy = 'bedrock-panel.service'
            require(self.property('FragmentPath', legacy) == str(self.path('/etc/systemd/system/' + legacy)), 'A managed panel service was not found.')
            self.unit, canonical = legacy, 'bedrock-panel'
        self.install = self.path('/opt/' + canonical)
        self.data = self.path('/var/lib/' + canonical)
        self.config_root = self.path('/etc/vortex-panel' if self.role == 'panel' else '/etc/vortex-node')
        self.config = self.path('/etc/' + canonical + '.env' if self.role == 'panel' else '/etc/vortex-node.json')
        self.unit_file = self.path('/etc/systemd/system/' + self.unit)
        self.safe(self.install)
        if request.get('machineId'):
            require(request['machineId'] == self.machine(), 'The pinned SSH machine identity changed.')
        unit_text = self.read(self.unit_file, 65536).decode()
        require(self.property('FragmentPath') == str(self.unit_file), 'The service is not the fixed native installation.')
        directives = {}
        for line in unit_text.splitlines():
            if '=' in line and not line.lstrip().startswith(('#', ';')):
                key, value = line.split('=', 1)
                directives.setdefault(key, []).append(value)
        require(not any(key.startswith('Exec') and key != 'ExecStart' for key in directives), 'Custom service lifecycle commands require independent review.')
        require(len(directives.get('ExecStart', [])) == 1 and len(directives.get('WorkingDirectory', [])) == 1, 'The service command is ambiguous.')
        current = self.install / 'current'
        self.safe(current, link=True)
        require(current.is_symlink(), 'The managed release link is missing.')
        release = current.resolve(strict=True)
        require(release.parent == self.install / 'releases', 'The active release escaped the dedicated source root.')
        self.safe(release)
        entry = 'server/index.js' if self.role == 'panel' else 'server/node-cli.js'
        args = shlex.split(directives['ExecStart'][0])
        require(len(args) == (2 if self.role == 'panel' else 3) and Path(args[0]).is_absolute() and args[1] in [str(current / entry), str(release / entry)] and (self.role == 'panel' or args[2] == 'serve'), 'The service does not execute the Vortex entry point.')
        loaded_start = self.property('ExecStart')
        require(str(current / entry) in loaded_start or str(release / entry) in loaded_start, 'The loaded service command differs from the installation file.')
        require(not self.property('ExecStop') and not self.property('ExecStopPost'), 'The loaded service has a custom stop command.')
        require(directives['WorkingDirectory'][0] in [str(current), str(release)] and self.property('WorkingDirectory') in [str(current), str(release)], 'The service working directory changed.')
        require(directives.get('KillMode', ['mixed']) == ['mixed'] and directives.get('TimeoutStopSec', ['240']) == ['240'], 'Custom shutdown policy requires review.')
        self.node_binary = args[0]
        executable = Path(args[0]).resolve(strict=True)
        require(Path(args[0]).name == 'node' and (args[0] in [str(self.path('/usr/bin/node')), str(self.path('/usr/local/bin/node'))] or self.install in Path(args[0]).parents), 'The service interpreter is outside the fixed system or private Vortex runtime.')
        self.safe(executable)
        user = directives.get('User', ['root'])
        require(len(user) == 1 and user[0] in ['root', 'vortex-panel', 'bedrock-panel'] and (self.role == 'panel' or user[0] == 'root'), 'The service account is unfamiliar.')
        if user[0] != 'root':
            account = self.run(['getent', 'passwd', user[0]]).split(':')
            require(len(account) == 7 and account[0] == user[0] and account[5] == str(self.data) and account[6] == '/usr/sbin/nologin' and account[2].isdigit() and int(account[2]) > 0, 'The panel account is not dedicated.')
            self.allowed_uids.add(int(account[2]))
        self.safe(self.data, mutable=True)
        drop_paths = self.property('DropInPaths').split()
        drop = self.path('/etc/systemd/system/' + self.unit + '.d/vortex-memory.conf')
        require(not drop_paths or drop_paths == [str(drop)] and self.read(drop, 4096) == b'[Service]\nTimeoutStopSec=240\n', 'Custom service overrides require review.')
        self.drop = drop if drop_paths else None
        config = self.read(self.config, 65536, private=True).decode()
        if self.role == 'worker':
            value = json.loads(config)
            require(value.get('schemaVersion') == 1 and value.get('nodeId') == self.node_id and value.get('dataDir') == str(self.data), 'The worker configuration does not match the pinned identity or dedicated data root.')
            tls = value.get('tls') or {}
            require(tls.get('certFile') == str(self.config_root / 'tls.crt') and tls.get('keyFile') == str(self.config_root / 'tls.key'), 'Custom worker TLS paths require independent review.')
            require(isinstance(value.get('token'), str) and 43 <= len(value['token']) <= 256, 'Worker credential identity is invalid.')
            certificate = self.read(self.config_root / 'tls.crt', 512 * 1024).decode()
            self.token_hash = hashlib.sha256(value['token'].encode()).hexdigest()
            self.cert_fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest().upper()
        else:
            paths = [line.split('=', 1)[1].strip('"\r') for line in config.splitlines() if line.startswith('DATA_DIR=')]
            require(paths == [str(self.data)], 'Custom panel data paths require independent review.')
        package = self.load(release / 'package.json', 65536)
        require(package.get('name') in ['vortex-panel', 'bedrock-panel', 'minecraft-bedrock-panel'] and package.get('type') == 'module', 'The source package is not Vortex.')
        self.release = release
        return {'unit': self.stamp(self.unit_file), 'config': self.stamp(self.config), 'current': self.stamp(current, link=True), 'release': self.stamp(release, False),
                'source': self.stamp(self.install, False), 'data': self.stamp(self.data, False, mutable=True), 'configDirectory': self.stamp(self.config_root, False) if self.config_root.exists() else None,
                'interpreter': self.stamp(executable),
                'drop': self.stamp(self.drop) if self.drop else None}

    def inventory(self):
        store = self.load(self.data / 'panel.json', 32 * 1024 ** 2, private=True, mutable=True)
        require(store.get('schemaVersion') in [1, 2] and isinstance(store.get('servers'), list) and isinstance(store.get('jobs'), list) and isinstance(store.get('nodes', []), list), 'The Vortex inventory is invalid.')
        require(isinstance(store.get('nodeProvisionJobs', []), list), 'The provisioning job inventory is invalid.')
        self.active_job_count = sum(1 for row in [*store['jobs'], *store.get('nodeProvisionJobs', [])] if isinstance(row, dict) and row.get('status') in ['queued', 'running'])
        require(len(store['servers']) <= 10000 and len(store.get('nodes', [])) <= 512, 'The Vortex inventory exceeds its bound.')
        servers = []
        for row in store['servers']:
            require(isinstance(row, dict) and UUID.fullmatch(str(row.get('id', ''))), 'A server identity is invalid.')
            servers.append({'id': row['id'], 'kind': row.get('kind', 'bedrock'), 'storagePolicy': row.get('storagePolicy')})
        require(len({row['id'] for row in servers}) == len(servers), 'Server identities are duplicated.')
        linked = []
        if self.role == 'panel':
            for row in store.get('nodes', []):
                require(UUID.fullmatch(str(row.get('id', ''))) and UUID.fullmatch(str(row.get('agentId', ''))), 'A linked worker identity is invalid.')
                linked.append({'id': row['id'], 'agentId': row['agentId']})
            require(len({row['id'] for row in linked}) == len(linked) and len({row['agentId'] for row in linked}) == len(linked), 'Linked worker identities are duplicated.')
        else:
            require(not store.get('users') and not store.get('nodes'), 'A worker data root contains panel accounts or linked workers.')
        return {'servers': sorted(servers, key=lambda row: row['id']), 'linkedWorkers': sorted(linked, key=lambda row: row['id'])}

    def worker_proofs(self, linked, proofs):
        require(isinstance(proofs, list) and len(proofs) <= 512, 'Worker removal proofs are invalid.')
        expected = {(row['id'], row['agentId']) for row in linked}
        seen = set()
        for row in proofs:
            require(isinstance(row, dict) and row.get('schemaVersion') == 1 and row.get('role') == 'worker' and (row.get('linkId'), row.get('nodeId')) in expected and row.get('verified') is True and row.get('outcomeStatus') == 'completed' and MACHINE.fullmatch(str(row.get('machineId', ''))) and UUID.fullmatch(str(row.get('requestId', ''))) and SHA.fullmatch(str(row.get('panelId', ''))) and SHA.fullmatch(str(row.get('revision', ''))), 'A linked worker lacks verified completed pinned native removal evidence.')
            key = (row['linkId'], row['nodeId'])
            require(key not in seen and all(row.get(key) is True for key in ['inventoryEmpty', 'serviceRemoved', 'filesVerified', 'processesAbsent', 'mountsAbsent', 'firewallRemoved', 'networkCountersRemoved', 'zramRemoved', 'accountsRemoved']), 'Worker evidence is duplicate or incomplete.')
            require(not row.get('remainingOwnedPaths'), 'A worker still has owned components.')
            seen.add(key)
        return seen == expected

    def ledger(self):
        path = self.config_root / ('install-manifest.json' if self.role == 'panel' else 'install-ledger.json')
        legacy = self.role == 'worker' and not path.exists() and (self.config_root / 'install-manifest.json').exists()
        if legacy:
            path = self.config_root / 'install-manifest.json'
        if not path.exists():
            return None
        value = self.load(path, 48 * 1024 ** 2, private=True)
        if legacy:
            require(value.get('schemaVersion') == 1 and value.get('product') == 'vortex-node' and value.get('nodeId') == self.node_id and UUID.fullmatch(str(value.get('installId', ''))) and isinstance(value.get('components'), list) and len(value['components']) <= 150000, 'Legacy worker ownership evidence is invalid.')
            value.update(role='worker', machineId=self.machine(), baselineUnknown=True, freshInstall=False, roots={'source': self.stamp(self.install, False), 'data': self.stamp(self.data, False, mutable=True)}, introduced={'packages': [], 'serviceAccount': None})
        value['_receiptPath'] = str(path)
        value['_receiptSHA'] = hashlib.sha256(self.read(path, 48 * 1024 ** 2, private=True)).hexdigest()
        require(value.get('schemaVersion') == 1 and value.get('product') == ('vortex-panel' if self.role == 'panel' else 'vortex-node') and value.get('role') == self.role and value.get('nodeId') == self.node_id and value.get('machineId') == self.machine() and UUID.fullmatch(str(value.get('installId', ''))) and isinstance(value.get('components'), list) and len(value['components']) <= 150000, 'Installer evidence does not match the current host and installation.')
        for name, path in [('source', self.install), ('data', self.data)]:
            root = value.get('roots', {}).get(name, {})
            require(root.get('path') == str(path) and self.same(root, False, name == 'data'), 'The dedicated installation root no longer matches its installer evidence.')
        return value

    def processes(self, uids=None):
        found = []
        proc = self.path('/proc')
        require(proc.is_dir(), 'Process inventory is unavailable.')
        for entry in proc.iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                values = []
                for name in ['cwd', 'exe', 'root']:
                    try:
                        values.append(os.readlink(entry / name).removesuffix(' (deleted)'))
                    except FileNotFoundError:
                        pass
                fd_dir = entry / 'fd'
                if fd_dir.exists():
                    for fd in fd_dir.iterdir():
                        try:
                            values.append(os.readlink(fd).removesuffix(' (deleted)'))
                        except FileNotFoundError:
                            pass
                maps_path = entry / 'maps'
                if maps_path.exists():
                    with maps_path.open() as stream:
                        maps = stream.read(8 * 1024 ** 2 + 1)
                    require(len(maps) <= 8 * 1024 ** 2, 'Process memory-map inventory exceeds its bound.')
                    for line in maps.splitlines():
                        fields = line.split(None, 5)
                        if len(fields) == 6 and fields[5].startswith('/'):
                            values.append(fields[5].removesuffix(' (deleted)'))
                hit = any(value == str(parent) or value.startswith(str(parent) + '/') for value in values for parent in [self.data, self.install])
                if uids:
                    status = (entry / 'status').read_text()
                    fields = re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)', status, re.M)
                    require(fields is not None, 'Process account identity is unavailable.')
                    hit = hit or any(int(value) in uids for value in fields.groups())
                if hit:
                    found.append(int(entry.name))
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                raise RemovalError('Process and open-file inventory cannot be verified.')
        return sorted(set(found))

    def mounts(self, global_inventory=False):
        raw = self.read_proc('/proc/self/mountinfo', 8 * 1024 ** 2)
        rows = []
        decode = lambda value: re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)
        for line in raw.splitlines():
            fields = line.split()
            require(len(fields) >= 10 and '-' in fields, 'Mount inventory is invalid.')
            index = fields.index('-')
            require(index + 3 < len(fields), 'Mount inventory is invalid.')
            target = decode(fields[4])
            if global_inventory or any(target == str(parent) or target.startswith(str(parent) + '/') for parent in [self.data, self.install, self.config_root]):
                rows.append({'target': target, 'source': decode(fields[index + 2]), 'fstype': fields[index + 1], 'options': fields[5].split(',')})
        return rows

    def read_proc(self, name, bound):
        with open(self.path(name), 'r') as stream:
            value = stream.read(bound + 1)
        require(len(value) <= bound, 'Kernel inventory exceeds its bound.')
        return value

    def loops(self):
        value = json.loads(self.run(['losetup', '--json', '--list', '--output', 'NAME,BACK-FILE,OFFSET,SIZELIMIT,AUTOCLEAR']))
        rows = value.get('loopdevices')
        require(isinstance(rows, list) and len(rows) <= 10000, 'Loop inventory is invalid.')
        return rows

    def owned_storage(self, mounts=None):
        mounts = self.mounts() if mounts is None else mounts
        loops = self.loops()
        global_mounts = self.mounts(global_inventory=True)
        rows = []
        for mounted in mounts:
            target = Path(mounted['target'])
            require(target.parent == self.data / 'servers' and UUID.fullmatch(target.name) and mounted['fstype'] == 'ext4' and re.fullmatch(r'/dev/loop\d+', mounted['source']) and {'rw', 'nodev', 'nosuid'}.issubset(mounted['options']), 'A foreign or unfamiliar mount is preserved.')
            record_path = self.data / '.storage' / (target.name + '.json')
            record = self.load(record_path, 16384, private=True, mutable=True)
            image = self.data / '.storage' / (target.name + '.img')
            info = self.safe(image, mutable=True)
            require(record.get('schemaVersion') == 1 and record.get('serverId') == target.name and UUID.fullmatch(str(record.get('filesystemUUID', ''))) and type(record.get('bytes')) is int and record['bytes'] >= 1024 ** 3 and info.st_size in [record['bytes'], record.get('pendingGrowBytes')], 'A storage ownership receipt is invalid.')
            candidates = [row for row in loops if row.get('name') == mounted['source']]
            require(len(candidates) == 1 and candidates[0].get('back-file') == str(image) and int(candidates[0].get('offset', -1)) == 0 and int(candidates[0].get('sizelimit', -1)) == 0, 'A storage loop is not exclusively owned.')
            require([row['target'] for row in global_mounts if row['source'] == mounted['source']] == [mounted['target']], 'An owned loop is also mounted outside its dedicated server target.')
            observed = self.run(['blkid', '-p', '-s', 'UUID', '-o', 'value', str(image)])
            require(observed.lower() == record['filesystemUUID'].lower(), 'A storage filesystem identity changed.')
            rows.append({**mounted, 'image': self.stamp(image, False, mutable=True), 'record': self.stamp(record_path, mutable=True), 'filesystemUUID': record['filesystemUUID']})
        # A detached image is safe only if it has the same bounded ownership
        # receipt; a loop also mounted elsewhere is retained and blocks erasure.
        mount_sources = {row['source'] for row in rows}
        for loop in loops:
            back = str(loop.get('back-file', '')).removesuffix(' (deleted)')
            if back.startswith(str(self.data) + '/') or back.startswith(str(self.install) + '/'):
                if loop.get('name') in mount_sources:
                    continue
                image = Path(back)
                require(image.parent == self.data / '.storage' and image.suffix == '.img' and UUID.fullmatch(image.stem) and re.fullmatch(r'/dev/loop\d+', str(loop.get('name', ''))) and int(loop.get('offset', -1)) == 0 and int(loop.get('sizelimit', -1)) == 0 and not any(row['source'] == loop['name'] for row in global_mounts), 'An unaccounted or externally mounted storage loop is retained.')
                record_path = image.with_suffix('.json')
                record = self.load(record_path, 16384, private=True, mutable=True)
                info = self.safe(image, mutable=True)
                require(record.get('schemaVersion') == 1 and record.get('serverId') == image.stem and UUID.fullmatch(str(record.get('filesystemUUID', ''))) and type(record.get('bytes')) is int and record['bytes'] >= 1024 ** 3 and info.st_size in [record['bytes'], record.get('pendingGrowBytes')] and self.run(['blkid', '-p', '-s', 'UUID', '-o', 'value', str(image)]).lower() == record['filesystemUUID'].lower(), 'A detached storage loop lacks a matching ownership receipt.')
                rows.append({'target': None, 'source': loop['name'], 'fstype': 'ext4', 'options': [], 'image': self.stamp(image, False, mutable=True), 'record': self.stamp(record_path, mutable=True), 'filesystemUUID': record['filesystemUUID']})
        return rows

    def app_accounts(self):
        base = self.data / '.application-users'
        if not base.exists():
            return []
        self.safe(base, mutable=True)
        scope = hashlib.sha256(str(self.data).encode()).hexdigest()[:8]
        rows = []
        for path in base.iterdir():
            if path.name.startswith('.probe-'):
                continue
            build = re.fullmatch(r'\.build-([a-f0-9-]{36})\.json', path.name)
            if build:
                value = self.load(path, 65536, private=True, mutable=True)
                require(UUID.fullmatch(build[1]) and value.get('schema') == 1 and value.get('id') == build[1] and UUID.fullmatch(str(value.get('serverId', ''))) and value.get('purpose') == 'python-runtime-build', 'An application build receipt is invalid.')
                continue
            require(UUID.fullmatch(path.stem) and path.suffix == '.json', 'An application account receipt is unfamiliar.')
            value = self.load(path, 65536, private=True, mutable=True)
            name = 'vxapp_' + scope + '_' + path.stem.replace('-', '')[:16]
            require(value.get('schema') == 1 and value.get('scope') == scope and value.get('serverId') == path.stem and value.get('username') == name and UUID.fullmatch(str(value.get('ownerId', ''))) and value.get('state') in ['creating', 'active', 'releasing'], 'Application account ownership is invalid.')
            passwd = self.run(['getent', 'passwd', name], missing=True)
            group = self.run(['getent', 'group', name], missing=True)
            require(passwd == self.local_account('passwd', name) and group == self.local_account('group', name), 'An application identity is not an exclusive local account.')
            if passwd:
                fields, groups = passwd.split(':'), group.split(':')
                require(len(fields) == 7 and len(groups) == 4 and fields[0] == groups[0] == name and fields[4] == 'vortex-app,' + scope + ',' + path.stem + ',' + value['ownerId'] and fields[5] == '/nonexistent' and fields[6] == '/usr/sbin/nologin' and fields[2].isdigit() and fields[3].isdigit() and int(fields[2]) > 0 and groups[2] == fields[3] and not groups[3] and (value.get('uid') is None or value['uid'] == int(fields[2])) and (value.get('gid') is None or value['gid'] == int(fields[3])), 'An application account was repurposed and is preserved.')
                value.update(uid=int(fields[2]), gid=int(fields[3]))
                self.allowed_uids.add(value['uid'])
            elif group:
                fields = group.split(':')
                require(len(fields) == 4 and fields[0] == name and fields[2] == str(value.get('gid')) and not fields[3], 'An application group was repurposed.')
            if type(value.get('uid')) is int and value['uid'] > 0:
                self.allowed_uids.add(value['uid'])
            rows.append({'record': self.stamp(path, mutable=True), 'name': name, 'passwd': passwd, 'group': group, 'uid': value.get('uid'), 'gid': value.get('gid')})
        return rows

    def local_account(self, kind, name):
        require(kind in ['passwd', 'group'] and re.fullmatch(r'[a-z_][a-z0-9_-]{0,63}', name), 'Invalid fixed private account identity.')
        rows = [line for line in self.read(self.path('/etc/' + kind), 8 * 1024 ** 2).decode().splitlines() if line.startswith(name + ':')]
        require(len(rows) <= 1, 'A local account database contains duplicate identities.')
        return rows[0] if rows else ''

    def migration_receipt(self, marker):
        raw_path = marker.get('transactionPath', '')
        require(isinstance(raw_path, str) and SHA.fullmatch(str(marker.get('transactionSHA256', ''))), 'The committed migration proof is missing.')
        logical = Path(raw_path)
        require(logical.name == 'transaction.json' and logical.parent.parent == Path('/var/backups/vortex-panel') and re.fullmatch(r'migration-[A-Za-z0-9_-]{10,100}', logical.parent.name), 'The migration receipt escaped its fixed private backup root.')
        path = self.path(raw_path)
        content = self.read(path, 8 * 1024 ** 2, private=True)
        require(hashlib.sha256(content).hexdigest() == marker['transactionSHA256'], 'The committed migration receipt changed.')
        value = json.loads(content)
        require(value.get('schemaVersion') == 1 and value.get('id') == marker.get('migrationId') and value.get('machineId') == self.machine() and value.get('state') == 'committed' and value.get('data') == '/var/lib/bedrock-panel' and value.get('moveData') is True and value.get('canonicalSource') == '/opt/vortex-panel' and value.get('canonicalData') == '/var/lib/vortex-panel', 'The migration receipt belongs to another installation or is not committed.')
        moves = value.get('moves')
        require(isinstance(moves, list) and all(isinstance(row, dict) for row in moves), 'The migration root evidence is invalid.')
        for old, new, current in [('/opt/bedrock-panel', '/opt/vortex-panel', self.install), ('/var/lib/bedrock-panel', '/var/lib/vortex-panel', self.data)]:
            info = current.lstat()
            require(any(row.get('old') == old and row.get('new') == new and row.get('identity') == [info.st_dev, info.st_ino] for row in moves), 'The migrated root identity no longer matches its transaction.')
        return path, value

    def artifact_stamp(self, path):
        info = self.safe(path)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 1024 ** 4 and (not self.enforce_owner or not info.st_mode & 0o077), 'A migration artifact is not a bounded private exclusive file.')
        fd = os.open(path, os.O_RDONLY | NOFOLLOW)
        try:
            current = os.fstat(fd)
            require((current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns), 'A migration artifact changed before hashing.')
            hasher = hashlib.sha256()
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                for block in iter(lambda: stream.read(1024 ** 2), b''):
                    hasher.update(block)
            current = os.fstat(fd)
            require(current.st_nlink == 1 and (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) == (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns), 'A migration artifact changed while hashing.')
            return {'path': str(path), 'kind': 'file', 'dev': info.st_dev, 'ino': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode), 'size': info.st_size, 'mtimeNs': info.st_mtime_ns, 'sha256': hasher.hexdigest()}
        finally:
            os.close(fd)

    def migration_artifacts(self):
        if self.role != 'panel':
            return [], []
        base = self.path('/var/backups/vortex-panel')
        if not base.exists():
            return [], []
        self.safe(base)
        require(not self.enforce_owner or not base.stat().st_mode & 0o077, 'The Vortex backup root is no longer private.')
        marker_path = self.data / '.vortex-layout.json'
        proofs, retained = [], []
        owned_directory = None
        if marker_path.exists():
            marker = self.load(marker_path, 4096, private=True, mutable=True)
            require(not self.enforce_owner or marker_path.lstat().st_uid == 0, 'The migration marker is not root-owned.')
            receipt_path, receipt = self.migration_receipt(marker)
            artifacts = receipt.get('artifacts')
            require(isinstance(artifacts, list) and len(artifacts) <= 4096, 'The committed migration has no bounded artifact ownership inventory.')
            rows = []
            for row in artifacts:
                require(isinstance(row, dict) and set(row) >= {'path', 'sha256', 'dev', 'ino', 'uid', 'mode'} and SHA.fullmatch(str(row.get('sha256', ''))), 'A migration artifact receipt is invalid.')
                path = self.path(row['path'])
                require(path.parent == receipt_path.parent and path != receipt_path, 'A migration artifact escaped its transaction directory.')
                actual = self.artifact_stamp(path)
                require(all(actual[key] == row[key] for key in ['sha256', 'dev', 'ino', 'uid', 'mode']), 'A migration backup artifact changed; it was preserved.')
                rows.append(actual)
            names = {row['path'] for row in rows} | {str(receipt_path)}
            require(len(names) == len(rows) + 1 and {str(path) for path in receipt_path.parent.iterdir()} == names, 'Unrecorded files remain in the migration backup; the complete recovery directory is preserved.')
            proofs.append({'directory': self.stamp(receipt_path.parent, False), 'receipt': self.artifact_stamp(receipt_path), 'artifacts': rows, 'marker': self.stamp(marker_path, mutable=True)})
            owned_directory = receipt_path.parent
        for path in base.iterdir():
            if path != owned_directory:
                retained.append({'kind': 'external-backup', 'path': str(path), 'reason': 'An external backup has no matching committed migration artifact proof; retained for review.'})
        return proofs, retained

    def firewall(self):
        expected = []
        receipt = self.config_root / 'firewall-owner.json'
        if self.role == 'worker' and receipt.exists():
            value = self.load(receipt, 65536, private=True)
            require(value.get('schemaVersion') == 1 and value.get('nodeId') == self.node_id and isinstance(value.get('rules'), list) and len(value['rules']) <= 64, 'The enrollment firewall receipt is invalid.')
            for rule in value['rules']:
                require(set(rule) == {'source', 'port', 'protocol', 'comment'} and type(rule['port']) is int and 1024 <= rule['port'] <= 65535 and rule['protocol'] == 'tcp' and rule['comment'] == 'vortex-agent:' + self.node_id, 'The firewall tuple is invalid.')
                ipaddress.ip_address(rule['source'])
                expected.append(['ufw', 'allow', 'from', rule['source'], 'to', 'any', 'port', str(rule['port']), 'proto', 'tcp', 'comment', rule['comment']])
        access = self.config_root / 'access.json'
        access_id = None
        if self.role == 'panel' and access.exists():
            value = self.load(access, 65536, private=True)
            require(value.get('schema') == 1 and re.fullmatch('[a-f0-9]{24}', str(value.get('id', ''))), 'The access firewall receipt is invalid.')
            access_id = value['id']
            for port in [80, 443]:
                expected.append(['ufw', 'allow', str(port) + '/tcp', 'comment', 'vortex-panel-' + access_id + '-' + str(port)])
        firewall_scope = str(self.data)
        marker = self.data / '.vortex-layout.json'
        if self.role == 'panel' and marker.exists():
            value = self.load(marker, 4096, private=True, mutable=True)
            require(not self.enforce_owner or marker.lstat().st_uid == 0, 'The migration scope marker is not root-owned.')
            require(self.data == self.path('/var/lib/vortex-panel') and value.get('schemaVersion') == 1 and (UUID.fullmatch(str(value.get('migrationId', ''))) or MACHINE.fullmatch(str(value.get('migrationId', '')))) and value.get('previousDataDir') == '/var/lib/bedrock-panel' and value.get('dataDir') == '/var/lib/vortex-panel' and value.get('firewallScope') == '/var/lib/bedrock-panel' and value.get('machineId') == self.machine(), 'The legacy firewall scope proof is invalid.')
            self.migration_receipt(value)
            firewall_scope = str(self.path('/var/lib/bedrock-panel'))
        scope = hashlib.sha256(firewall_scope.encode()).hexdigest()[:16]
        server_pattern = re.compile(r'^vortex:' + scope + r':([a-f0-9-]{36})$')
        # No receipt and no servers can mean UFW was never installed. An
        # existing binary must still be inspected; its inactive rules matter.
        if not self.path('/usr/sbin/ufw').exists() and self.root is None:
            require(not expected, 'UFW ownership exists but its inspection tool is missing.')
            return []
        commands = []
        for line in self.run(['ufw', 'show', 'added']).splitlines():
            if line.strip().startswith('ufw '):
                command = shlex.split(line)
                comments = [command[index + 1] for index, word in enumerate(command[:-1]) if word == 'comment']
                require(len(comments) <= 1, 'A firewall command is ambiguous.')
                comment = comments[0] if comments else ''
                own = comment == 'vortex-agent:' + self.node_id or bool(access_id and comment.startswith('vortex-panel-' + access_id + '-')) or bool(server_pattern.fullmatch(comment))
                if not own:
                    continue
                if command in expected:
                    commands.append(command)
                    continue
                match = server_pattern.fullmatch(comment)
                # UFW show added normalizes prepend away. Only the exact shape
                # emitted by server-firewall.js is eligible for deletion.
                valid_port = lambda text: bool(re.fullmatch(r'[0-9]{1,5}(?::[0-9]{1,5})?', text) and all(1 <= int(port) <= 65535 for port in text.split(':')) and int(text.split(':')[0]) <= int(text.split(':')[-1]))
                full = len(command) == 13 and command[:4] == ['ufw', 'allow', 'in', 'proto'] and command[4] in ['tcp', 'udp'] and command[5] == 'from' and command[7] == 'to' and command[6] == command[8] and command[6] in ['any', '0.0.0.0/0', '::/0'] and command[9] == 'port' and valid_port(command[10]) and command[11:] == ['comment', comment]
                # UFW's own get_show_added() renders any-to-any inbound rules
                # in this short form, discarding their original prepend syntax.
                short = len(command) == 5 and command[:2] == ['ufw', 'allow'] and command[3:] == ['comment', comment] and '/' in command[2] and command[2].rsplit('/', 1)[1] in ['tcp', 'udp'] and valid_port(command[2].rsplit('/', 1)[0])
                valid = match is not None and UUID.fullmatch(match[1]) and (full or short)
                require(valid, 'An unfamiliar tagged firewall rule is preserved.')
                commands.append(command)
        return commands

    def zram(self, cleanup=False):
        owner_path = self.path('/etc/vortex-zram/owner.json')
        if not owner_path.exists():
            return {'present': False, 'owned': False, 'canCleanup': True}
        owner = self.load(owner_path, 65536, private=True)
        if owner.get('role') != self.role or owner.get('nodeId') != self.node_id:
            return {'present': True, 'owned': False, 'canCleanup': True, 'retainedForeign': True}
        reference = SOURCE.with_name('host-zram.reference.py')
        if not reference.exists():
            reference = SOURCE.with_name('host-zram.py')
        helper = self.path('/usr/local/libexec/vortex-host-zram.py')
        actual = hashlib.sha256(self.read(helper)).hexdigest()
        same_reference = actual == hashlib.sha256(self.read(reference)).hexdigest()
        if not same_reference:
            ledger = self.ledger()
            same_reference = bool(ledger and any(row.get('path') == str(helper) and row.get('sha256') == actual and row.get('existedBefore') is False and row.get('createdByInstallId') == ledger['installId'] and self.same(row) for row in ledger['components']))
        if not same_reference:
            packaged = self.release / 'server/host-zram.py'
            same_reference = packaged.exists() and actual == hashlib.sha256(self.read(packaged)).hexdigest()
        require(same_reference, 'The installed memory helper differs from its trusted removal reference and ownership receipt.')
        require(self.root is None, 'Real zram operations cannot run against fixture paths.')
        spec = importlib.util.spec_from_file_location('vortex_removal_zram', reference)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.cleanup_owned(self.role, self.node_id, self.unit, lock_held=True) if cleanup else module.inspect_owned(self.role, self.node_id, self.unit)

    def maintenance_reference(self, name):
        require(name in ['host-network-tuning', 'host-tls'], 'Unrecognized host maintenance reference.')
        reference = SOURCE.with_name(name + '.reference.py')
        if not reference.exists():
            reference = SOURCE.with_name(name + '.py')
        if not reference.exists():
            reference = self.release / 'server' / (name + '.py')
        self.read(reference, 1024 ** 2)
        return reference

    def maintenance_module(self, name):
        reference = self.maintenance_reference(name)
        spec = importlib.util.spec_from_file_location('vortex_removal_' + name.replace('-', '_'), reference)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, reference

    def network_profile(self):
        name = 'vortex-panel' if self.role == 'panel' else 'vortex-node'
        state_path = self.config_root / 'network-tuning.json'
        profile_path = self.path('/etc/sysctl.d/70-' + name + '-network.conf')
        if not os.path.lexists(state_path) and not os.path.lexists(profile_path):
            return None
        module, reference = self.maintenance_module('host-network-tuning')
        profile = module.NetworkProfile(self.role, self.root or Path('/'))
        value = profile.inspect()
        require(value.get('canRestore') is True or value.get('status') == 'restored' and not os.path.lexists(profile_path), 'Owned network profile cannot be restored without altering foreign configuration.')
        return {'revision': value['revision'], 'state': self.stamp(state_path), 'profile': self.stamp(profile_path) if os.path.lexists(profile_path) else None,
                'referenceSHA256': hashlib.sha256(self.read(reference)).hexdigest(), 'restoreRequired': value.get('canRestore') is True}

    def host_timezone(self):
        filename = self.data / 'timezone-operations.json'
        if not os.path.lexists(filename):
            return None
        value = self.load(filename, 1024 ** 2, private=True, mutable=True)
        def valid_zone(zone):
            return isinstance(zone, str) and len(zone) <= 128 and ZONE.fullmatch(zone) and '..' not in zone
        require(value.get('schema') == 1 and value.get('nodeId') == self.node_id and value.get('role') == self.role and valid_zone(value.get('originalTimezone'))
                and isinstance(value.get('records'), list) and 0 < len(value['records']) <= 512, 'Timezone restoration journal does not match this installation.')
        for row in value['records']:
            require(isinstance(row, dict) and UUID.fullmatch(str(row.get('requestId', ''))) and valid_zone(row.get('timezone')) and valid_zone(row.get('previousTimezone'))
                    and SHA.fullmatch(str(row.get('revision', ''))) and isinstance(row.get('instanceId'), str) and len(row['instanceId']) <= 128
                    and row.get('status') == 'completed', 'An incomplete or invalid timezone operation must be reviewed before removal.')
        current = self.run(['/usr/bin/timedatectl', 'show', '--property=Timezone', '--value'])
        require(valid_zone(current), 'The actual OS timezone could not be verified.')
        installed = self.run(['/usr/bin/timedatectl', 'list-timezones', '--no-pager']).splitlines()
        require(len(installed) <= 4096 and all(valid_zone(zone) for zone in installed) and (value['originalTimezone'] in installed or value['originalTimezone'] in ['UTC', current]), 'The original timezone is no longer installed.')
        return {'journal': self.stamp(filename, mutable=True), 'original': value['originalTimezone'], 'lastRequested': value['records'][-1]['timezone'], 'observed': current}

    def tls_management(self):
        if self.role != 'panel':
            return None
        runtime = self.path('/run/vortex-panel-tls')
        if not any(os.path.lexists(self.path(name)) for name in TLS_PATHS) and not os.path.lexists(runtime):
            return None
        module, reference = self.maintenance_module('host-tls')
        manager = module.TLSManager(root=str(self.root or '/'))
        value = manager.removal_plan()
        require(value.get('canCleanup') is True and SHA.fullmatch(str(value.get('revision', ''))), 'Managed HTTPS ownership or renewal state requires review before removal.')
        require(isinstance(value.get('components'), list) and len(value['components']) <= len(TLS_PATHS) and all(name in TLS_PATHS for name in value['components']), 'HTTPS cleanup escaped its fixed ownership paths.')
        if os.path.lexists(runtime):
            info = self.safe(runtime)
            require(stat.S_ISDIR(info.st_mode) and (not self.enforce_owner or not info.st_mode & 0o077) and all(path.name == 'operation.lock' for path in runtime.iterdir()), 'A foreign HTTPS runtime file must be preserved.')
            if os.path.lexists(runtime / 'operation.lock'):
                self.read(runtime / 'operation.lock', 4096, private=True)
                require(not manager.operation_active(), 'An HTTPS operation is active.')
        return {**value, 'referenceSHA256': hashlib.sha256(self.read(reference)).hexdigest()}

    def source_entries(self, ledger, tls=None):
        rows, retained = [], []
        profile = self.path('/etc/sysctl.d/70-' + ('vortex-panel' if self.role == 'panel' else 'vortex-node') + '-network.conf')
        maintenance = {profile}
        if self.role == 'panel':
            maintenance.update(self.path('/etc/systemd/system/vortex-panel-tls-renew.' + suffix) for suffix in ['service', 'timer'])
        for row in (ledger or {}).get('components', []):
            path = Path(row.get('path', ''))
            shared = path in [self.path('/usr/local/libexec/vortex-host-zram.py'), self.path('/usr/local/libexec/vortex-application-isolation.py')]
            extra = path == self.path('/etc/nginx/conf.d/vortex-panel.conf') and self.role == 'panel' or path in maintenance
            fixed = path in [self.unit_file, self.config]
            require(path.is_absolute() and (any(path == parent or parent in path.parents for parent in [self.install, self.config_root]) or shared or extra or fixed), 'Installer evidence escaped the fixed removal roots.')
            # Explicit erasure covers the complete dedicated, service-verified
            # source/config roots, including mutable caches and old releases.
            # Installer hashes authorize only components outside those roots.
            if any(path == parent or parent in path.parents for parent in [self.install, self.config_root]):
                continue
            # Mutable sysctl/TLS components have stronger feature-specific
            # ownership receipts and are restored by their copied helper.
            if path in maintenance:
                continue
            if not os.path.lexists(path):
                continue
            if shared and self.shared_helper_needed(path):
                retained.append({'kind': 'shared-helper', 'path': str(path), 'reason': 'Another Vortex role still uses this shared helper.'})
                continue
            try:
                require(row.get('existedBefore') is False and row.get('createdByInstallId') == ledger['installId'], 'No exclusive installer origin.')
                require(self.same(row), 'Installed component changed after its receipt.')
                rows.append({key: row[key] for key in ['path', 'kind', 'dev', 'ino', 'uid', 'gid', 'mode', 'sha256', 'target'] if key in row})
            except (RemovalError, OSError):
                retained.append({'kind': row.get('kind', 'file'), 'path': str(path), 'reason': 'Installer ownership or content changed; retained for review.'})
        # Earlier releases installed the exact packaged helper without a full
        # baseline ledger. Matching the verified active release counterpart is
        # still content provenance; an unfamiliar shared helper is retained.
        for absolute, relative in [('/usr/local/libexec/vortex-host-zram.py', 'server/host-zram.py'), ('/usr/local/libexec/vortex-application-isolation.py', 'deploy/application-isolation.py')]:
            path, reference = self.path(absolute), self.release / relative
            if not os.path.lexists(path) or any(row['path'] == str(path) for row in rows) or self.shared_helper_needed(path):
                continue
            try:
                require(reference.exists() and self.read(path) == self.read(reference), 'No exact active-release counterpart.')
                rows.append(self.stamp(path))
                retained = [row for row in retained if row.get('path') != str(path)]
            except (RemovalError, OSError):
                if not any(row.get('path') == str(path) for row in retained):
                    retained.append({'kind': 'shared-helper', 'path': str(path), 'reason': 'Shared helper has no exact installer or active-release content proof.'})
        nginx = self.path('/etc/nginx/conf.d/vortex-panel.conf')
        if self.role == 'panel' and tls and tls.get('owned') and nginx.exists() and not any(row['path'] == str(nginx) for row in rows):
            require(SHA.fullmatch(str(tls.get('currentConfigSHA256', ''))) and hashlib.sha256(self.read(nginx, 65536)).hexdigest() == tls['currentConfigSHA256'], 'Managed HTTPS proxy changed after its removal review.')
            rows.append(self.stamp(nginx))
            retained = [row for row in retained if row.get('path') != str(nginx)]
        if self.role == 'panel' and nginx.exists() and not any(row['path'] == str(nginx) for row in rows):
            try:
                receipt = self.load(self.config_root / 'access.json', 65536, private=True)
                address = receipt.get('url', '').removeprefix('https://')
                require(receipt.get('schema') == 1 and receipt.get('url') == 'https://' + str(ipaddress.IPv4Address(address)) and re.fullmatch('[a-f0-9]{24}', str(receipt.get('id', ''))), 'The legacy IP access receipt is invalid.')
                env = self.read(self.config, 65536, private=True).decode()
                ports = [line.split('=', 1)[1].strip('"\r') for line in env.splitlines() if line.startswith('PORT=')]
                require(len(ports) == 1 and ports[0].isdigit() and 1024 <= int(ports[0]) <= 65535, 'The proxy upstream port is ambiguous.')
                certificate = self.read(self.config_root / 'tls/ip.crt', 512 * 1024, private=True).decode()
                fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest().upper()
                require(str(receipt.get('fingerprint', '')).split('=')[-1].replace(':', '').upper() == fingerprint, 'The legacy access certificate identity changed.')
                require(self.read(nginx, 65536) == self.access_config(address, int(ports[0])), 'The Vortex nginx configuration was changed.')
                rows.append(self.stamp(nginx))
                retained = [row for row in retained if row.get('path') != str(nginx)]
            except (RemovalError, OSError, ValueError):
                if not any(row.get('path') == str(nginx) for row in retained):
                    retained.append({'kind': 'proxy-configuration', 'path': str(nginx), 'reason': 'The proxy has no exact installer or managed-access content proof.'})
        return rows, retained

    @staticmethod
    def access_config(address, port):
        return ('''# Vortex Panel fresh-install IP HTTPS; managed by configure-access.py.
map $http_upgrade $vortex_connection_upgrade { default upgrade; '' close; }
server {
    listen 80;
    server_name ADDRESS;
    return 308 https://ADDRESS$request_uri;
}
server {
    listen 443 ssl;
    server_name ADDRESS;
    ssl_certificate /etc/vortex-panel/tls/ip.crt;
    ssl_certificate_key /etc/vortex-panel/tls/ip.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    client_max_body_size 1025m;
    client_body_timeout 120s;
    access_log /var/log/nginx/vortex-panel.access.log;
    error_log /var/log/nginx/vortex-panel.error.log;
    location / {
        proxy_pass http://127.0.0.1:PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $vortex_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
'''.replace('ADDRESS', address).replace(':PORT;', ':' + str(port) + ';')).encode()

    def other_installation(self):
        units = ['vortex-panel.service', 'bedrock-panel.service'] if self.role == 'worker' else ['vortex-node.service']
        return any(os.path.lexists(self.path('/etc/systemd/system/' + unit)) for unit in units)

    def isolation_identity(self):
        receipt = self.path('/var/lib/vortex-application-isolation/apparmor.json')
        if not receipt.exists():
            return None
        value = self.load(receipt, 65536, private=True)
        require(isinstance(value.get('owners'), dict), 'Application isolation ownership is invalid.')
        if self.unit not in value['owners']:
            return None
        return {'receipt': self.stamp(receipt), 'owners': sorted(value['owners']), 'profile': self.stamp(self.path('/etc/apparmor.d/vortex-application-bwrap'))}

    def shared_helper_needed(self, path):
        if self.other_installation():
            return True
        if Path(path).name == 'vortex-host-zram.py':
            owner = self.path('/etc/vortex-zram/owner.json')
            if owner.exists():
                try:
                    value = self.load(owner, 65536, private=True)
                    return value.get('role') != self.role or value.get('nodeId') != self.node_id
                except (RemovalError, OSError, ValueError):
                    return True
        if Path(path).name == 'vortex-application-isolation.py':
            receipt = self.path('/var/lib/vortex-application-isolation/apparmor.json')
            if receipt.exists():
                try:
                    value = self.load(receipt, 65536, private=True)
                    return not isinstance(value.get('owners'), dict) or bool(set(value['owners']) - {self.unit})
                except (RemovalError, OSError, ValueError):
                    return True
        return False

    def plan(self, request):
        identity = self.configure(request)
        accounts = self.app_accounts()
        inventory = self.inventory()
        ledger = self.ledger()
        host_components, host_blockers = {}, []
        for key, inspect, code, message, vietnamese in [
                ('networkProfile', self.network_profile, 'FLEET_NETWORK_PROFILE', 'The network profile is foreign, changed or cannot be restored safely.', 'Cấu hình mạng thuộc bên ngoài, đã bị sửa hoặc chưa thể khôi phục an toàn.'),
                ('hostTimezone', self.host_timezone, 'FLEET_TIMEZONE', 'The timezone journal is invalid or an earlier OS timezone change still needs verification.', 'Nhật ký múi giờ không hợp lệ hoặc thay đổi múi giờ hệ điều hành trước đó chưa được xác minh.'),
                ('managedTLS', self.tls_management, 'FLEET_TLS', 'Managed HTTPS or renewal ownership needs review before its certificate data can be erased.', 'Cần kiểm tra quyền quản lý HTTPS và dịch vụ gia hạn trước khi xóa dữ liệu chứng chỉ.')]:
            try:
                host_components[key] = inspect()
            except Exception:
                host_components[key] = None
                host_blockers.append({'code': code, 'message': message, 'messageI18n': {'id': 'panel.removal.' + code.lower(), 'en': message, 'vi': vietnamese, 'params': []}})
        entries, retained = self.source_entries(ledger, host_components['managedTLS'])
        package_preview = {'retained': [], 'removed': []}
        self.cleanup_packages(ledger, package_preview, dry_run=True)
        retained.extend(package_preview['retained'])
        firewall = self.firewall()
        storage = self.owned_storage()
        zram = self.zram()
        migration, backup_retained = self.migration_artifacts()
        retained.extend(backup_retained)
        blockers = list(host_blockers)
        if self.active_job_count:
            blockers.append({'code': 'FLEET_JOBS', 'message': 'Wait for queued or running server/provisioning jobs to finish before erasing this VPS.'})
        if zram.get('canCleanup') is False:
            blockers.append({'code': 'FLEET_ZRAM', 'message': 'Owned compressed swap cannot be safely drained or its ownership is uncertain.'})
        if any(row.get('kind') == 'proxy-configuration' for row in retained):
            blockers.append({'code': 'FLEET_SHARED_CONFIGURATION', 'message': 'An externally customized proxy still refers to Vortex configuration; preserve it for administrator review before erasing TLS data.'})
        workers_verified = self.worker_proofs(inventory['linkedWorkers'], request.get('workerProofs', [])) if self.role == 'panel' else True
        if not workers_verified:
            blockers.append({'code': 'FLEET_WORKERS', 'message': 'Every linked worker must be independently verified removed before the main VPS can launch.'})
        machine = self.machine()
        panel_id = digest({'machineId': machine, 'role': self.role, 'nodeId': self.node_id, 'data': {key: identity['data'][key] for key in ['path', 'dev', 'ino', 'uid']}})
        require(not request.get('panelId') or request['panelId'] == panel_id, 'The confirmed data inventory belongs to another installation.')
        service_account = (ledger or {}).get('introduced', {}).get('serviceAccount')
        if service_account and (ledger or {}).get('before', {}).get('accounts', {}).get(service_account.get('name')) is not None:
            service_account = None
        identity.update(machineId=machine, panelId=panel_id, role=self.role, nodeId=self.node_id, inventory=inventory, entries=entries, firewall=firewall, storage=storage, accounts=accounts,
                        unitName=self.unit, install=str(self.install), dataRoot=str(self.data), configRoot=str(self.config_root), nodeBinary=self.node_binary,
                        ledgerSHA=digest(ledger) if ledger else None, ownedZram=zram.get('owned') is True,
                        serviceAccount=service_account,
                        packageBaselineSHA256=package_digest(ledger['before']['packages']) if ledger and isinstance(ledger.get('before', {}).get('packages'), list) else None,
                        isolation=self.isolation_identity(), zramRevision=zram.get('revision'),
                        migration=migration, **host_components,
                        network=self.load(self.data / '.network-metrics.json', 4096, private=True, mutable=True) if (self.data / '.network-metrics.json').exists() else None)
        if identity['network']:
            network = identity['network']
            require(network.get('schemaVersion') == 1 and UUID.fullmatch(str(network.get('owner', ''))) and network.get('table') == 'vortex_metrics_' + network['owner'].replace('-', ''), 'Network ownership receipt is invalid.')
        revision = identity_revision(identity)
        components = [{'kind': 'mutable-data', 'path': str(self.data), 'action': 'erase', 'reason': 'Explicitly confirmed Vortex inventory, servers, worlds, storage images and private caches.'},
                      {'kind': 'dedicated-source', 'path': str(self.install), 'action': 'erase', 'reason': 'Fixed source root verified from the native service, release link and Vortex package identity.'},
                      {'kind': 'service', 'path': str(self.unit_file), 'action': 'remove', 'reason': 'Verified native Vortex service.'}]
        if identity['configDirectory']:
            components.append({'kind': 'dedicated-configuration', 'path': str(self.config_root), 'action': 'erase', 'reason': 'Dedicated Vortex configuration root verified by fixed service and TLS/config paths.'})
        components += [{'kind': row['kind'], 'path': row['path'], 'action': 'remove', 'reason': 'Exact installer origin and current content match.'} for row in entries]
        components += [{'kind': 'firewall', 'path': ' '.join(row), 'action': 'remove', 'reason': 'Exact Vortex-owned rule.'} for row in firewall]
        components += [{'kind': 'migration-backup', 'path': row['directory']['path'], 'action': 'erase', 'reason': 'Committed migration receipt and exact artifact content hashes match this installation.'} for row in migration]
        components += [{'kind': 'package', 'path': name, 'action': 'purge', 'reason': 'Exact installer origin, unused current state and bounded APT simulation match.'} for name in package_preview.get('packageCandidates', [])]
        if host_components['networkProfile']:
            components.append({'kind': 'network-profile', 'path': host_components['networkProfile']['profile']['path'] if host_components['networkProfile']['profile'] else str(self.config_root / 'network-tuning.json'), 'action': 'restore', 'reason': 'Restore only unchanged Vortex-applied kernel values and remove the exact owned profile.'})
        if host_components['hostTimezone']:
            components.append({'kind': 'host-timezone', 'path': host_components['hostTimezone']['original'], 'action': 'restore', 'reason': 'Restore the original OS timezone only while the last completed Vortex choice is still active.'})
        if host_components['managedTLS']:
            components += [{'kind': 'managed-https', 'path': name, 'action': 'remove', 'reason': 'Exact Vortex TLS markers, renewal unit templates and unchanged managed proxy verified.'} for name in host_components['managedTLS'].get('components', [])]
        baseline = bool(ledger and not ledger.get('baselineUnknown') and not ledger.get('baselineChangedPackages') and not ledger.get('unprovenNewPackages') and not ledger.get('unknownManualMarkChanges'))
        preexisting_removed = [row['path'] for row in entries if (ledger or {}).get('before', {}).get('paths', {}).get(row['path']) is not None]
        if preexisting_removed:
            baseline = False
            retained.append({'kind': 'baseline', 'path': 'pre-install Vortex components', 'reason': 'Explicit removal includes Vortex components that predated this installation; their former presence cannot also be restored: ' + ','.join(preexisting_removed)})
        if ledger and ledger.get('unprovenNewPackages'):
            retained.append({'kind': 'packages', 'path': ','.join(ledger['unprovenNewPackages']), 'reason': 'Dependencies or concurrent package additions have no exact direct installer transaction origin; preserved.'})
        if ledger and ledger.get('unknownManualMarkChanges'):
            retained.append({'kind': 'package-marks', 'path': ','.join(ledger['unknownManualMarkChanges']), 'reason': 'APT manual marks changed without exact installer transaction evidence; preserved.'})
        if not ledger or ledger.get('baselineUnknown'):
            retained.append({'kind': 'baseline', 'path': 'pre-install operating-system state', 'reason': 'No trustworthy pre-install package baseline exists; unknown shared state is preserved.'})
        baseline = baseline and not retained
        return {'schemaVersion': 1, 'role': self.role, 'nodeId': self.node_id, 'machineId': machine, 'panelId': panel_id, 'revision': revision, 'status': 'blocked' if blockers else 'ready',
                'serverCount': len(inventory['servers']), 'linkedWorkers': inventory['linkedWorkers'], 'workersVerified': workers_verified, 'blockers': blockers, 'components': components,
                'retained': retained, 'baselineRestorable': baseline, 'requiresEraseConfirmation': True, 'sshRequired': True,
                'tokenHash': getattr(self, 'token_hash', None), 'certFingerprint': getattr(self, 'cert_fingerprint', None),
                'layout': {'sourceDir': str(self.install), 'dataDir': str(self.data), 'configFile': str(self.config), 'service': self.unit, 'helperPath': str(SOURCE), 'helperSHA256': hashlib.sha256(self.read(SOURCE)).hexdigest(), 'protocol': 1},
                '_identity': identity, '_ledger': ledger}

    @contextlib.contextmanager
    def lock(self):
        import fcntl
        path = self.path(LOCK)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (not self.enforce_owner or info.st_uid == 0 and not info.st_mode & 0o077), 'The OS maintenance lock is unsafe.')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RemovalError('Another operating-system operation is running.')
            yield
        finally:
            os.close(fd)

    def save(self, path, value, mutable=False):
        path = Path(path)
        self.safe(path.parent, mutable=mutable)
        if os.path.lexists(path):
            self.safe(path, mutable=mutable)
        temporary = path.parent / ('.write-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(value, stream, sort_keys=True, separators=(',', ':'))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        finally:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()

    def workspace(self, request_id, create=False):
        require(UUID.fullmatch(str(request_id)), 'Invalid operation identity.')
        base = self.path(WORK)
        if create and not base.exists():
            self.safe(base.parent)
            base.mkdir(mode=0o700)
        self.safe(base)
        require(not self.enforce_owner or not base.stat().st_mode & 0o077, 'The private removal parent is not private.')
        target = base / request_id
        if create:
            target.mkdir(mode=0o700)
        self.safe(target)
        require(not self.enforce_owner or not target.stat().st_mode & 0o077, 'The operation workspace is not private.')
        return target

    def copy(self, source, target, limit=1024 ** 2):
        data = self.read(source, limit)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def prepare(self, request):
        with self.lock():
            plan = self.plan(request)
            require(plan['status'] == 'ready' and plan['revision'] == request['revision'], 'The removal preview changed or linked worker cleanup is incomplete.')
            intent_path = self.data / '.fleet-removal-intent.json'
            require(not os.path.lexists(intent_path), 'An existing removal admission freeze requires review.')
            work = self.workspace(request['requestId'], True)
            self.copy(SOURCE, work / 'helper.py')
            zram_reference = SOURCE.with_name('host-zram.reference.py')
            if not zram_reference.exists():
                zram_reference = SOURCE.with_name('host-zram.py')
            self.copy(zram_reference, work / 'host-zram.reference.py')
            for feature, name in [('networkProfile', 'host-network-tuning'), ('managedTLS', 'host-tls')]:
                if plan['_identity'].get(feature):
                    reference = self.maintenance_reference(name)
                    require(hashlib.sha256(self.read(reference)).hexdigest() == plan['_identity'][feature]['referenceSHA256'], 'A host maintenance reference changed before detached staging.')
                    self.copy(reference, work / (name + '.reference.py'))
            network = SOURCE.with_name('network-metrics.js')
            self.copy(network, work / 'network-metrics.mjs')
            self.copy(network.with_name('safety.js'), work / 'safety.js')
            self.save(work / 'package.json', {'type': 'module'})
            isolation = self.release / 'deploy/application-isolation.py'
            if not isolation.exists():
                isolation = SOURCE.with_name('application-isolation.py')
            if not isolation.exists():
                isolation = self.path('/usr/local/libexec/vortex-application-isolation.py')
            if isolation.exists():
                self.copy(isolation, work / 'application-isolation.reference.py')
            self.save(work / 'request.json', request)
            self.save(work / 'plan.json', plan)
            intent = {key: request[key] for key in ['schemaVersion', 'role', 'nodeId', 'machineId', 'panelId', 'requestId', 'revision', 'confirmedErase']}
            self.save(intent_path, {**intent, 'createdAt': time.time()}, mutable=True)
            self.save(work / 'result.json', {'schemaVersion': 1, 'role': self.role, 'nodeId': self.node_id, 'machineId': plan['machineId'], 'panelId': plan['panelId'], 'requestId': request['requestId'], 'status': 'prepared', 'phase': 'prepared', 'effectStarted': False, 'removed': [], 'retained': plan['retained'], 'createdAt': time.time()})
            return {'schemaVersion': 1, 'ok': True, 'status': 'prepared', 'role': self.role, 'nodeId': self.node_id, 'machineId': plan['machineId'], 'panelId': plan['panelId'], 'requestId': request['requestId'],
                    'helperPath': str(work / 'helper.py'), 'receiptPath': str(work / 'result.json'), 'unit': 'vortex-fleet-remove-' + request['requestId'] + '.service',
                    'launchArgv': self.launch_args(work, request['requestId'], self.role)}

    def launch_args(self, work, request_id, role):
        return ['systemd-run', '--unit=vortex-fleet-remove-' + request_id, '--collect', '--on-active=' + ('10s' if role == 'panel' else '1s'), '--timer-property=AccuracySec=100ms', '--property=Type=oneshot', '--property=User=root', '--property=Group=root', '--property=UMask=0077',
                '--property=TimeoutStartSec=1800', '--property=StandardOutput=null', '--property=StandardError=null', '--property=WorkingDirectory=/', '--', '/usr/bin/python3', '-I', str(work / 'helper.py'), 'apply', '--request-id', request_id]

    def saved(self, request):
        work = self.workspace(request['requestId'])
        saved = self.load(work / 'request.json', 512 * 1024, private=True)
        require(all(request.get(key) == saved.get(key) for key in ['role', 'nodeId', 'machineId', 'requestId', 'panelId', 'revision']), 'The operation receipt belongs to another pinned request.')
        require(self.machine() == saved['machineId'], 'The SSH host machine identity changed.')
        return work, saved

    def launch(self, request):
        work, saved = self.saved(request)
        with self.lock():
            result = self.load(work / 'result.json', 32 * 1024 ** 2, private=True)
            require(result.get('status') == 'prepared' and not (work / 'launched.json').exists(), 'A dispatched operation is never launched twice.')
            # A failed/unknown dispatch is deliberately not auto-replayed or
            # cancelled: systemd might already have accepted the timer.
            self.save(work / 'launched.json', {'requestId': saved['requestId'], 'machineId': saved['machineId'], 'launchedAt': time.time()})
            self.run(self.launch_args(work, saved['requestId'], saved['role']))
        return {'schemaVersion': 1, 'ok': True, 'status': 'dispatched', 'requestId': request['requestId'], 'receiptPath': str(work / 'result.json'), 'expectedDisconnect': self.role == 'panel' if hasattr(self, 'role') else saved['role'] == 'panel'}

    def restore_identity(self, identity):
        self.role, self.node_id, self.unit = identity['role'], identity['nodeId'], identity['unitName']
        require(self.role in ['panel', 'worker'] and (self.node_id == 'local' if self.role == 'panel' else UUID.fullmatch(str(self.node_id))), 'The saved operation role or identity is invalid.')
        require(self.unit in (['vortex-panel.service', 'bedrock-panel.service'] if self.role == 'panel' else ['vortex-node.service']), 'The saved operation service is not a fixed Vortex role.')
        prefix = self.unit.removesuffix('.service')
        require(identity['install'] == str(self.path('/opt/' + prefix)) and identity['dataRoot'] == str(self.path('/var/lib/' + prefix)) and identity['configRoot'] == str(self.path('/etc/vortex-panel' if self.role == 'panel' else '/etc/vortex-node')), 'Saved removal roots escaped the fixed role layout.')
        self.install, self.data, self.config_root = Path(identity['install']), Path(identity['dataRoot']), Path(identity['configRoot'])
        self.unit_file = Path(identity['unit']['path'])
        expected_config = self.path('/etc/' + prefix + '.env' if self.role == 'panel' else '/etc/vortex-node.json')
        require(self.unit_file == self.path('/etc/systemd/system/' + self.unit) and identity['config']['path'] == str(expected_config) and identity['source']['path'] == str(self.install) and identity['data']['path'] == str(self.data) and identity['current']['path'] == str(self.install / 'current'), 'Saved fixed-component paths changed.')
        allowed = {str(self.unit_file), str(expected_config), str(self.path('/usr/local/libexec/vortex-host-zram.py')), str(self.path('/usr/local/libexec/vortex-application-isolation.py')),
                   str(self.path('/etc/systemd/system/' + self.unit + '.d/vortex-memory.conf'))}
        if self.role == 'panel':
            allowed.add(str(self.path('/etc/nginx/conf.d/vortex-panel.conf')))
        require(all(row.get('path') in allowed for row in identity['entries']), 'Saved file cleanup escaped the fixed component allowlist.')
        network_profile = identity.get('networkProfile')
        if network_profile:
            expected_profile = str(self.path('/etc/sysctl.d/70-' + ('vortex-panel' if self.role == 'panel' else 'vortex-node') + '-network.conf'))
            require(network_profile.get('state', {}).get('path') == str(self.config_root / 'network-tuning.json') and (network_profile.get('profile') is None or network_profile['profile'].get('path') == expected_profile)
                    and SHA.fullmatch(str(network_profile.get('referenceSHA256', ''))), 'Saved network restoration paths changed.')
        timezone = identity.get('hostTimezone')
        if timezone:
            require(timezone.get('journal', {}).get('path') == str(self.data / 'timezone-operations.json') and all(isinstance(timezone.get(key), str) and len(timezone[key]) <= 128 and ZONE.fullmatch(timezone[key]) and '..' not in timezone[key] for key in ['original', 'lastRequested', 'observed']), 'Saved timezone restoration identity changed.')
        tls = identity.get('managedTLS')
        if tls:
            require(self.role == 'panel' and SHA.fullmatch(str(tls.get('referenceSHA256', ''))) and isinstance(tls.get('components'), list) and all(name in TLS_PATHS for name in tls['components']), 'Saved HTTPS cleanup escaped its fixed paths.')
            if tls.get('owned'):
                require(tls.get('configPath') == '/etc/nginx/conf.d/vortex-panel.conf' and SHA.fullmatch(str(tls.get('currentConfigSHA256', ''))) and SHA.fullmatch(str(tls.get('restoredConfigSHA256', ''))), 'Saved HTTPS proxy proof changed.')
        self.allowed_uids = {0, identity['data']['uid']} | {row['uid'] for row in identity.get('accounts', []) if row.get('uid')}

    def cleanup_timezone(self, identity, result):
        proof = identity.get('hostTimezone')
        if not proof:
            result['hostTimezoneRestoration'] = {'outcome': 'not-managed'}
            return
        require(self.same(proof['journal'], True, True), 'Timezone ownership journal changed before restoration.')
        current = self.run(['/usr/bin/timedatectl', 'show', '--property=Timezone', '--value'])
        require(isinstance(current, str) and len(current) <= 128 and ZONE.fullmatch(current), 'The actual timezone is unavailable during restoration.')
        if current != proof['lastRequested']:
            result['hostTimezoneRestoration'] = {'outcome': 'preserved-external'}
            result['retained'].append({'kind': 'baseline', 'path': 'administrator timezone', 'reason': 'The OS timezone changed after the last completed Vortex request; the administrator choice was preserved.'})
            return
        if current != proof['original']:
            self.run(['/usr/bin/timedatectl', '--no-ask-password', 'set-timezone', proof['original']])
        require(self.run(['/usr/bin/timedatectl', 'show', '--property=Timezone', '--value']) == proof['original'], 'Original OS timezone restoration was not verified.')
        result['hostTimezoneRestoration'] = {'outcome': 'restored', 'timezone': proof['original']}

    def cleanup_network_profile(self, identity, work, result):
        proof = identity.get('networkProfile')
        if not proof:
            result['networkProfileRestoration'] = {'outcome': 'not-managed'}
            return
        require(self.same(proof['state']) and (not proof.get('profile') or self.same(proof['profile'])), 'Network ownership evidence changed before restoration.')
        helper = work / 'host-network-tuning.reference.py'
        require(hashlib.sha256(self.read(helper)).hexdigest() == proof['referenceSHA256'], 'Detached network helper changed.')
        value = json.loads(self.run(['/usr/bin/python3', '-I', '-B', str(helper), 'restore-owned', '--role', self.role], timeout=45))
        network = value.get('network') or {}
        require(value.get('ok') is True and network.get('enabled') is False and network.get('status') == 'restored' and isinstance(network.get('restoredKeys'), list) and isinstance(network.get('preservedKeys'), list)
                and set(network['restoredKeys'] + network['preservedKeys']).issubset(NETWORK_KEYS), 'Owned network profile restoration was not verified.')
        expected = {key: network.get('current', {}).get(key) for key in network['restoredKeys']}
        require(all(isinstance(value, str) and len(value) <= 128 for value in expected.values()), 'Restored network values are incomplete.')
        profile = self.path('/etc/sysctl.d/70-' + ('vortex-panel' if self.role == 'panel' else 'vortex-node') + '-network.conf')
        require(not os.path.lexists(profile), 'An owned persistent network profile remains.')
        result['networkProfileRestoration'] = {'outcome': 'restored', 'values': expected, 'preservedKeys': network['preservedKeys']}
        if network['preservedKeys']:
            result['retained'].append({'kind': 'baseline', 'path': 'administrator network settings', 'reason': 'Later administrator network values were preserved instead of restoring the pre-Vortex values.'})

    def cleanup_tls_management(self, identity, work, result):
        proof = identity.get('managedTLS')
        if not proof:
            result['managedTLSRestoration'] = {'outcome': 'not-managed'}
            return
        helper = work / 'host-tls.reference.py'
        require(hashlib.sha256(self.read(helper)).hexdigest() == proof['referenceSHA256'], 'Detached HTTPS helper changed.')
        value = json.loads(self.run(['/usr/bin/python3', '-I', '-B', str(helper), 'restore-owned'], timeout=180,
                                   input_text=json.dumps({'revision': proof['revision'], 'confirmed': True})))
        restored = value.get('tlsRemoval') or {}
        require(value.get('ok') is True and restored.get('restored') is True and isinstance(restored.get('removed'), list)
                and set(restored['removed']) == set(proof['components']) and all(not os.path.lexists(self.path(name)) for name in proof['components']), 'Managed HTTPS cleanup was not independently observed.')
        if proof.get('owned'):
            require(restored.get('configSHA256') == proof['restoredConfigSHA256'] and hashlib.sha256(self.read(self.path('/etc/nginx/conf.d/vortex-panel.conf'), 65536)).hexdigest() == proof['restoredConfigSHA256'], 'Restored HTTPS proxy does not match its pinned original hash.')
        runtime = self.path('/run/vortex-panel-tls')
        if os.path.lexists(runtime):
            info = self.safe(runtime)
            require(stat.S_ISDIR(info.st_mode) and (not self.enforce_owner or not info.st_mode & 0o077) and all(path.name == 'operation.lock' for path in runtime.iterdir()), 'Foreign HTTPS runtime content appeared during cleanup.')
            lock = runtime / 'operation.lock'
            if os.path.lexists(lock):
                import fcntl
                self.read(lock, 4096, private=True)
                fd = os.open(lock, os.O_RDONLY | NOFOLLOW)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    require(os.fstat(fd).st_ino == lock.lstat().st_ino, 'HTTPS runtime lock changed before cleanup.')
                    lock.unlink()
                finally:
                    os.close(fd)
            runtime.rmdir()
        result['managedTLSRestoration'] = {'outcome': 'restored', 'removed': restored['removed'], 'configSHA256': restored.get('configSHA256'), 'runtimeRemoved': not os.path.lexists(runtime)}

    def tree_inventory(self, root, expected, mutable):
        require(self.same(expected, False, mutable), 'The dedicated root changed before erasure.')
        root_dev = Path(root).lstat().st_dev
        rows = []
        pending = [Path(root)]
        while pending:
            path = pending.pop()
            info = self.safe(path, link=True, mutable=mutable)
            require(info.st_dev == root_dev, 'A mounted or foreign filesystem remains in the dedicated data root.')
            require(not stat.S_ISREG(info.st_mode) or info.st_nlink == 1, 'A hard-linked data file is preserved.')
            require(len(rows) < 2000000, 'Dedicated tree inventory exceeds its bound.')
            row = self.stamp(path, False, link=True, mutable=mutable)
            rows.append(row)
            if stat.S_ISDIR(info.st_mode):
                pending.extend(path.iterdir())
        return rows

    def erase_tree(self, root, expected, mutable=False):
        rows = self.tree_inventory(root, expected, mutable)
        for row in sorted(rows, key=lambda row: -len(Path(row['path']).parts)):
            require(self.same(row, False, mutable), 'A dedicated tree path changed during erasure.')
            path = Path(row['path'])
            path.rmdir() if row['kind'] == 'directory' else path.unlink()

    def remove_entries(self, entries, result, work):
        for row in sorted(entries, key=lambda row: (row['kind'] == 'directory', -len(Path(row['path']).parts))):
            path = Path(row['path'])
            if not os.path.lexists(path):
                continue
            require(self.same(row), 'An installer-owned component changed immediately before deletion.')
            try:
                path.rmdir() if row['kind'] == 'directory' else path.unlink()
            except OSError:
                require(row['kind'] == 'directory', 'An installer-owned file could not be removed.')
                result['retained'].append({'kind': 'directory', 'path': str(path), 'reason': 'Unrecorded or changed content remains.'})
                continue
            result['removed'].append(str(path))
        self.save(work / 'result.json', result)

    def cleanup_isolation(self, work, result):
        receipt_path = self.path('/var/lib/vortex-application-isolation/apparmor.json')
        if not receipt_path.exists():
            return
        receipt = self.load(receipt_path, 65536, private=True)
        token = receipt.get('owners', {}).get(self.unit)
        if token is None:
            return
        reference = work / 'application-isolation.reference.py'
        require(reference.exists(), 'The AppArmor ownership verifier is unavailable; policy evidence was preserved.')
        require(re.fullmatch('[a-f0-9]{32}', str(token)) and re.fullmatch('[a-f0-9]{32}', str(receipt.get('nonce', ''))), 'AppArmor ownership tokens are invalid.')
        transaction = work / 'isolation-transaction.json'
        self.save(transaction, {'schema': 1, 'nonce': receipt['nonce'], 'owner': self.unit, 'token': token})
        self.run(['/usr/bin/python3', '-I', str(reference), 'rollback', '--owner', self.unit, '--transaction', str(transaction)], timeout=120)
        if not receipt_path.exists():
            state = receipt_path.parent
            lock = state / '.lock'
            if lock.exists():
                self.safe(lock)
                lock.unlink()
            with contextlib.suppress(OSError):
                state.rmdir()
        result['removed'].append('owned AppArmor owner:' + self.unit)

    def cleanup_network(self, identity, work):
        network = identity.get('network')
        if not network:
            return
        # Reuse the complete nftables structural verifier, rather than trusting
        # table-name prefixes. close() never creates a missing counter table.
        program = 'import {pathToFileURL} from "node:url";const {createNetworkMetrics}=await import(pathToFileURL(process.argv[1]));const c=createNetworkMetrics({dataDir:process.argv[2]});await c.initialize();const r=await c.close();if(r?.cleaned!==true)process.exit(1);'
        self.run([identity['nodeBinary'], '--input-type=module', '-e', program, str(work / 'network-metrics.mjs'), str(self.data)], timeout=60)
        tables = json.loads(self.run(['nft', '-j', 'list', 'tables'])).get('nftables')
        require(isinstance(tables, list) and not any(row.get('table', {}).get('family') == 'inet' and row.get('table', {}).get('name') == network['table'] for row in tables), 'Owned network counters were not removed.')

    def cleanup_accounts(self, identity, ledger, result):
        for row in identity['accounts']:
            require(not self.processes({row['uid']}) if row.get('uid') else True, 'An application account still has processes.')
            require(self.run(['getent', 'passwd', row['name']], missing=True) == row['passwd'] and self.run(['getent', 'group', row['name']], missing=True) == row['group'], 'An application account changed before removal.')
            require(self.local_account('passwd', row['name']) == row['passwd'] and self.local_account('group', row['name']) == row['group'], 'The private local application account changed before removal.')
            if row['passwd']:
                self.run(['userdel', row['name']])
            if self.run(['getent', 'group', row['name']], missing=True):
                self.run(['groupdel', row['name']])
            require(not self.run(['getent', 'passwd', row['name']], missing=True) and not self.run(['getent', 'group', row['name']], missing=True), 'An application account remains.')
            require(not self.local_account('passwd', row['name']) and not self.local_account('group', row['name']), 'A private application identity remains in the local account databases.')
            result['removed'].append('account:' + row['name'])
        account = (ledger or {}).get('introduced', {}).get('serviceAccount')
        if account:
            if ledger.get('before', {}).get('accounts', {}).get(account.get('name')) is not None:
                result['retained'].append({'kind': 'shared-account', 'path': account.get('name'), 'reason': 'This account existed in the original host baseline and is preserved.'})
                return
            fields = account.get('passwd', '').split(':')
            require(account.get('introduced') is True and account.get('name') in ['vortex-panel', 'bedrock-panel'] and len(fields) == 7 and fields[0] == account['name'] and fields[5] == str(self.data) and fields[6] == '/usr/sbin/nologin' and fields[2].isdigit() and int(fields[2]) > 0, 'Panel account evidence is invalid.')
            current = self.run(['getent', 'passwd', account['name']], missing=True)
            if current:
                if current != account['passwd'] or self.local_account('passwd', account['name']) != current or self.processes({int(fields[2])}):
                    result['retained'].append({'kind': 'account', 'path': account['name'], 'reason': 'Panel account changed or remains in use.'})
                else:
                    self.run(['userdel', account['name']])
                    group = self.run(['getent', 'group', account['name']], missing=True).split(':')
                    if len(group) == 4 and group[2] == fields[3] and not group[3]:
                        self.run(['groupdel', account['name']])
                    result['removed'].append('account:' + account['name'])

    def cleanup_packages(self, ledger, result, dry_run=False):
        try:
            self._cleanup_packages(ledger, result, dry_run)
        except (RemovalError, OSError, subprocess.SubprocessError):
            if result.get('packageMutationStarted'):
                raise
            result['retained'].append({'kind': 'packages', 'path': 'installer package candidates', 'reason': 'Package ownership, current use or the exact APT simulation could not be verified; no package mutation was started.'})

    def _cleanup_packages(self, ledger, result, dry_run=False):
        if not ledger:
            return
        if self.other_installation():
            if ledger.get('introduced', {}).get('packages'):
                result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(row.get('name', '') for row in ledger['introduced']['packages'])), 'reason': 'Another Vortex role remains on this host and can require these shared installer packages.'})
            return
        candidates = []
        manual = set(self.run(['apt-mark', 'showmanual']).splitlines()) if ledger.get('introduced', {}).get('packages') else set()
        for row in ledger.get('introduced', {}).get('packages', []):
            name = row.get('name', '')
            require(re.fullmatch('[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?', name), 'Invalid introduced package evidence.')
            if any(item.get('name') == name for item in ledger.get('before', {}).get('packages', [])):
                result['retained'].append({'kind': 'package', 'path': name, 'reason': 'The original host baseline already contained this package; it cannot be removed as installer-introduced.'})
                continue
            if row.get('origin') != 'installer-requested-and-absent-at-transaction-capture':
                result['retained'].append({'kind': 'package', 'path': name, 'reason': 'No exact installer transaction origin was recorded.'})
                continue
            if PROTECTED_PACKAGES.match(name):
                result['retained'].append({'kind': 'package', 'path': name, 'reason': 'Shared operating-system, networking or security component is preserved.'})
                continue
            current = self.run(['dpkg-query', '-W', '-f=${db:Status-Status}\t${Version}\t${Essential}\t${Priority}', name], missing=True).split('\t')
            if not current or current[0] != 'installed':
                continue
            marked = name in manual or name.split(':')[0] in manual
            if len(current) != 4 or current[1] != row.get('version') or current[2] == 'yes' or current[3] in ['required', 'important'] or marked != row.get('manual'):
                result['retained'].append({'kind': 'package', 'path': name, 'reason': 'Introduced package changed or is required by the host.'})
                continue
            candidates.append(name)
        if not candidates:
            return
        # Reject any reverse dependency outside this same proven-introduced
        # set. apt's complete simulation is checked again before mutation.
        selected = set(candidates)
        for name in list(selected):
            reverse = self.run(['apt-cache', 'rdepends', '--installed', name])
            dependencies = {line.strip().lstrip('|') for line in reverse.splitlines()[2:] if re.fullmatch(r'\s*\|?[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?', line)}
            if dependencies - selected:
                selected.remove(name)
        changed = True
        while changed:
            changed = False
            for name in list(selected):
                reverse = self.run(['apt-cache', 'rdepends', '--installed', name])
                dependencies = {line.strip().lstrip('|') for line in reverse.splitlines()[2:] if re.fullmatch(r'\s*\|?[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?', line)}
                if dependencies - selected:
                    selected.remove(name)
                    changed = True
        for name in set(candidates) - selected:
            result['retained'].append({'kind': 'package', 'path': name, 'reason': 'Another installed package depends on it.'})
        if not selected:
            return
        # Package-owned configuration changed after installation is foreign use
        # evidence. Active executables and opened package files are checked by
        # dpkg ownership; uncertain use retains the complete selected set.
        for name in sorted(selected):
            config = self.run(['dpkg-query', '-W', '-f=${Conffiles}', name])
            for line in config.splitlines():
                # execute() trims the command's outer whitespace, so the
                # first row can legitimately have no dpkg indentation.
                match = re.fullmatch(r'\s*(/\S+)\s+([a-f0-9]{32})(?:\s+obsolete)?\s*', line)
                if not match:
                    result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'Package conffile metadata is unfamiliar; the complete candidate set is preserved.'})
                    return
                if os.path.lexists(self.path(match[1])):
                    info = self.safe(self.path(match[1]))
                    if not stat.S_ISREG(info.st_mode) or hashlib.md5(self.read(self.path(match[1]), 16 * 1024 ** 2)).hexdigest() != match[2]:
                        result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'Package configuration was customized after installation; the complete candidate set is preserved.'})
                        return
        proc = self.path('/proc')
        executables = set()
        for entry in proc.iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                executable = os.readlink(entry / 'exe').removesuffix(' (deleted)')
                if executable.startswith(('/usr/', '/bin/', '/sbin/')):
                    executables.add(executable)
            except FileNotFoundError:
                continue
            except PermissionError:
                result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'Package process use cannot be completely inspected.'})
                return
        for executable in executables:
            owners = self.run(['dpkg-query', '-S', executable], missing=True)
            if any(line.split(': ', 1)[0] in selected for line in owners.splitlines() if ': ' in line):
                result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'An introduced package is being used by another live process.'})
                return
        audit = self.run(['dpkg', '--audit'])
        require(not audit, 'An existing package transaction requires review; package cleanup was stopped.')
        args = ['apt-get', '-o', 'DPkg::Lock::Timeout=120', '--no-auto-remove', 'purge', '--', *sorted(selected)]
        simulation = self.run([*args[:3], '--simulate', *args[3:]], timeout=120)
        removed = set()
        for line in simulation.splitlines():
            fields = line.split()
            if fields and fields[0] in ['Inst', 'Conf']:
                result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'APT would install or alter another package; the complete candidate set is preserved.'})
                return
            if fields and fields[0] in ['Remv', 'Purg']:
                if len(fields) < 2 or fields[1] not in selected:
                    result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'APT would remove an unproven package; the complete candidate set is preserved.'})
                    return
                removed.add(fields[1])
        if removed != selected:
            result['retained'].append({'kind': 'packages', 'path': ','.join(sorted(selected)), 'reason': 'APT did not confirm exactly the introduced package set; all candidates are preserved.'})
            return
        if dry_run:
            result['packageCandidates'] = sorted(selected)
            return
        result['packageMutationStarted'] = True
        self.run([*args[:3], '-y', *args[3:]], timeout=600)
        for name in sorted(selected):
            state = self.run(['dpkg-query', '-W', '-f=${db:Status-Status}', name], missing=True)
            require(state in ['', 'not-installed'], 'An introduced package was not fully removed.')
            result['removed'].append('package:' + name)

    def restore_package_marks(self, ledger, result):
        if not ledger or not ledger.get('manualMarkChanges'):
            return
        if self.other_installation():
            result['retained'].append({'kind': 'package-marks', 'path': ','.join(sorted(row.get('name', '') for row in ledger['manualMarkChanges'])), 'reason': 'Another Vortex role remains on this host and can require the current APT manual marks.'})
            return
        manual = set(self.run(['apt-mark', 'showmanual']).splitlines())
        for row in ledger.get('manualMarkChanges', []):
            name = row.get('name', '')
            require(re.fullmatch('[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?', name) and type(row.get('beforeManual')) is bool and type(row.get('afterManual')) is bool and row['beforeManual'] != row['afterManual'] and row.get('origin') == 'direct-installer-target-manual-mark-changed-in-captured-transaction', 'APT manual-mark transaction evidence is invalid.')
            current = self.run(['dpkg-query', '-W', '-f=${db:Status-Status}\t${Version}', name], missing=True).split('\t')
            marked = name in manual or name.split(':')[0] in manual
            if current != ['installed', row.get('afterVersion')] or marked != row['afterManual']:
                result['retained'].append({'kind': 'package-marks', 'path': name, 'reason': 'Package version or manual mark changed after the installer transaction.'})
                continue
            self.run(['apt-mark', 'manual' if row['beforeManual'] else 'auto', name])
            fresh = set(self.run(['apt-mark', 'showmanual']).splitlines())
            require((name in fresh or name.split(':')[0] in fresh) == row['beforeManual'], 'A pre-install APT manual mark was not restored.')
            result.setdefault('restored', []).append('apt-mark:' + name)

    def current_package_digest(self):
        manual = set(self.run(['apt-mark', 'showmanual']).splitlines())
        rows = []
        for line in self.run(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${db:Status-Status}\n']).splitlines():
            fields = line.split('\t')
            require(len(fields) == 3, 'The current package baseline is ambiguous.')
            if fields[2] == 'installed':
                rows.append({'name': fields[0], 'version': fields[1], 'manual': fields[0] in manual or fields[0].split(':')[0] in manual})
        return package_digest(rows)

    def apply(self, request):
        work, saved = self.saved(request)
        result = self.load(work / 'result.json', 32 * 1024 ** 2, private=True)
        require(result.get('status') == 'prepared', 'A native removal is never replayed after effects begin.')
        plan = self.load(work / 'plan.json', 64 * 1024 ** 2, private=True)
        identity = plan['_identity']
        try:
            with self.lock():
                require(plan.get('revision') == saved['revision'] and identity_revision(identity) == saved['revision'], 'The prepared identity receipt no longer matches the confirmed preview.')
                require((digest(plan['_ledger']) if plan.get('_ledger') else None) == identity.get('ledgerSHA'), 'The prepared installer evidence changed.')
                self.restore_identity(identity)
                current = self.plan(saved)
                require(current['status'] == 'ready' and current['revision'] == saved['revision'], 'The frozen host identity changed before removal.')
                intent = self.load(self.data / '.fleet-removal-intent.json', 512 * 1024, private=True, mutable=True)
                require(all(intent.get(key) == saved.get(key) for key in ['requestId', 'nodeId', 'machineId', 'panelId', 'revision', 'confirmedErase']), 'The admission freeze belongs to another operation.')
                result.update(status='running', phase='stopping', effectStarted=True, startedAt=time.time())
                self.save(work / 'result.json', result)
                # Stop certificate renewal before the source process check:
                # a timer must not start a new source-reading job mid-erasure.
                self.cleanup_tls_management(identity, work, result)
                self.save(work / 'result.json', result)
                self.run(['systemctl', 'disable', self.unit])
                self.run(['systemctl', 'stop', self.unit], timeout=270)
                require(self.property('ActiveState') not in ['active', 'activating', 'deactivating'] and self.property('MainPID') in ['', '0'], 'The Vortex service did not stop gracefully.')
                require(not self.processes({row['uid'] for row in identity['accounts'] if row.get('uid')}), 'Processes or open files remain in the source/data; no erasure was attempted.')
                result['phase'] = 'storage'
                self.save(work / 'result.json', result)
                for row in self.owned_storage():
                    require(self.same(row['image'], False, True) and self.same(row['record'], True, True), 'Storage ownership changed before ordinary unmount.')
                    if row['target'] is not None:
                        self.run(['umount', '--', row['target']], timeout=120)
                    else:
                        self.run(['losetup', '--detach', '--', row['source']], timeout=30)
                require(not self.mounts(), 'A mount remains; no forced or lazy unmount is permitted.')
                for row in self.owned_storage():
                    require(row['target'] is None and self.same(row['image'], False, True) and self.same(row['record'], True, True), 'A storage loop changed after unmount.')
                    self.run(['losetup', '--detach', '--', row['source']], timeout=30)
                require(not [row for row in self.loops() if str(row.get('back-file', '')).removesuffix(' (deleted)').startswith(str(self.data) + '/')], 'A storage loop remains busy; its data is preserved.')
                result['phase'] = 'host-components'
                self.save(work / 'result.json', result)
                if identity['ownedZram']:
                    require(self.zram(cleanup=True).get('ok') is True, 'Owned compressed swap cleanup was not confirmed.')
                self.cleanup_network_profile(identity, work, result)
                self.cleanup_timezone(identity, result)
                self.cleanup_network(identity, work)
                for command in identity['firewall']:
                    self.run(['ufw', '--force', 'delete', *command[1:]])
                require(not self.firewall(), 'An owned firewall rule remains.')
                self.cleanup_isolation(work, result)
                self.cleanup_accounts(identity, plan.get('_ledger'), result)
                # Shutdown saves diagnostics. Revalidate inventory identity and
                # the private root inode, not the mutable store's old hash.
                require(self.inventory() == identity['inventory'], 'The server or linked-worker inventory changed during shutdown.')
                require(not self.processes() and not self.mounts(), 'A new process or mount appeared before data erasure.')
                result['phase'] = 'erasing'
                self.save(work / 'result.json', result)
                # Inventory every tree before deleting any tree, so linked,
                # special, foreign-owned or hard-linked content fails closed.
                self.tree_inventory(self.data, identity['data'], True)
                self.tree_inventory(self.install, identity['source'], False)
                if identity.get('configDirectory'):
                    self.tree_inventory(self.config_root, identity['configDirectory'], False)
                self.erase_tree(self.data, identity['data'], True)
                result['removed'].append(str(self.data))
                self.erase_tree(self.install, identity['source'])
                result['removed'].append(str(self.install))
                if identity.get('configDirectory'):
                    if plan.get('_ledger'):
                        ledger_path = Path(plan['_ledger']['_receiptPath'])
                        require(hashlib.sha256(self.read(ledger_path, 48 * 1024 ** 2, private=True)).hexdigest() == plan['_ledger']['_receiptSHA'], 'Installer receipt changed during removal.')
                    self.erase_tree(self.config_root, identity['configDirectory'])
                    result['removed'].append(str(self.config_root))
                entries = list(identity['entries'])
                # Unit/config are independently proven by the running service,
                # including older installations without installer evidence.
                for row in [identity['unit'], identity['config'], identity.get('drop')]:
                    if row and not any(item['path'] == row['path'] for item in entries):
                        entries.append(row)
                tls = identity.get('managedTLS')
                if tls and tls.get('owned'):
                    nginx = self.path('/etc/nginx/conf.d/vortex-panel.conf')
                    require(result.get('managedTLSRestoration', {}).get('outcome') == 'restored' and hashlib.sha256(self.read(nginx, 65536)).hexdigest() == tls['restoredConfigSHA256'], 'Managed proxy changed after its verified restoration.')
                    entries = [row for row in entries if row['path'] != str(nginx)] + [self.stamp(nginx)]
                self.remove_entries(entries, result, work)
                for migration in identity.get('migration', []):
                    directory = Path(migration['directory']['path'])
                    require(self.same(migration['directory'], False), 'Migration backup directory identity changed before erasure.')
                    files = [*migration['artifacts'], migration['receipt']]
                    require({str(path) for path in directory.iterdir()} == {row['path'] for row in files}, 'Migration backup content changed before erasure.')
                    for row in files:
                        require(self.artifact_stamp(Path(row['path'])) == row, 'A migration artifact changed before erasure.')
                    for row in files:
                        Path(row['path']).unlink()
                        result['removed'].append(row['path'])
                    directory.rmdir()
                backup_root = self.path('/var/backups/vortex-panel')
                if identity.get('migration') and backup_root.exists():
                    with contextlib.suppress(OSError):
                        backup_root.rmdir()
                for parent in [self.install / 'releases', self.install / 'tools', self.install / 'runtime', self.install, self.config_root / 'tls', self.config_root, self.path('/etc/systemd/system/' + self.unit + '.d')]:
                    if parent.exists():
                        self.safe(parent)
                        with contextlib.suppress(OSError):
                            parent.rmdir()
                self.run(['systemctl', 'daemon-reload'])
                self.run(['systemctl', 'reset-failed', self.unit], missing=True)
                if self.role == 'panel' and any(row['path'] == str(self.path('/etc/nginx/conf.d/vortex-panel.conf')) for row in entries):
                    self.run(['nginx', '-t'])
                    baseline = (plan.get('_ledger') or {}).get('before', {}).get('services', {}).get('nginx.service', {})
                    if baseline.get('ActiveState') == 'active':
                        self.run(['systemctl', 'reload', 'nginx'])
                    elif baseline and not self.other_installation():
                        # Stop only a stock, installer-introduced nginx with no
                        # remaining user site. Unknown nginx use is preserved.
                        foreign = [path for folder in ['/etc/nginx/conf.d', '/etc/nginx/sites-enabled'] for path in self.path(folder).glob('*') if str(path) != str(self.path('/etc/nginx/sites-enabled/default'))]
                        if not foreign:
                            self.run(['systemctl', 'stop', 'nginx'])
                            if baseline.get('UnitFileState') not in ['enabled', 'enabled-runtime']:
                                self.run(['systemctl', 'disable', 'nginx'])
                result['phase'] = 'packages'
                self.save(work / 'result.json', result)
                self.cleanup_packages(plan.get('_ledger'), result)
                self.restore_package_marks(plan.get('_ledger'), result)
                result.update(status='removed', phase='verifying')
                self.save(work / 'result.json', result)
                proof = self.verify(saved)
                require(proof['verified'], 'Independent native removal conditions were not satisfied.')
                baseline_restored = False
                if plan['baselineRestorable'] and not result['retained']:
                    try:
                        baseline_restored = identity.get('packageBaselineSHA256') == self.current_package_digest()
                    except (RemovalError, OSError, subprocess.SubprocessError):
                        baseline_restored = False
                    if not baseline_restored:
                        result['retained'].append({'kind': 'baseline', 'path': 'pre-install packages', 'reason': 'Installed package names, versions or manual marks differ from the original baseline; foreign changes are preserved.'})
                result.update(status='completed', phase='complete', finishedAt=time.time(), verified=True, baselineRestored=baseline_restored)
                self.save(work / 'result.json', result)
                # Success retains only bounded evidence and a standalone
                # verifier on tmpfs. Original package/file inventories and
                # executable references are needed only for failed recovery.
                self.save(work / 'plan.json', {'schemaVersion': 1, '_identity': identity, 'baselineRestorable': plan['baselineRestorable']})
                for name in ['host-zram.reference.py', 'host-network-tuning.reference.py', 'host-tls.reference.py', 'network-metrics.mjs', 'safety.js', 'package.json', 'application-isolation.reference.py', 'isolation-transaction.json']:
                    reference = work / name
                    if reference.exists():
                        self.safe(reference)
                        reference.unlink()
        except Exception as error:
            result.update(status='partial' if result.get('effectStarted') else 'failed', phase='review', finishedAt=time.time(), verified=False,
                          error=str(error) if isinstance(error, RemovalError) else 'Native cleanup stopped after an unverified host operation. Review the private receipt before recovery.')
            self.save(work / 'result.json', result)
        return self.public(result)

    def verify(self, request):
        work, saved = self.saved(request)
        plan = self.load(work / 'plan.json', 64 * 1024 ** 2, private=True)
        identity = plan['_identity']
        require(identity_revision(identity) == saved['revision'] and identity.get('role') == saved['role'] and identity.get('nodeId') == saved['nodeId'] and identity.get('machineId') == saved['machineId'] and identity.get('panelId') == saved['panelId'], 'The independent identity receipt no longer matches the pinned request.')
        self.restore_identity(identity)
        result = self.load(work / 'result.json', 32 * 1024 ** 2, private=True)
        inactive = self.property('ActiveState') not in ['active', 'activating', 'deactivating'] and self.property('MainPID') in ['', '0']
        service_removed = inactive and not os.path.lexists(self.unit_file) and self.property('UnitFileState') not in ['enabled', 'enabled-runtime', 'linked', 'linked-runtime']
        remaining = [str(path) for path in [self.data, self.install] if os.path.lexists(path)]
        if identity.get('configDirectory') and os.path.lexists(self.config_root):
            remaining.append(str(self.config_root))
        retained_paths = {row.get('path') for row in result.get('retained', [])}
        remaining += [row['path'] for row in identity['entries'] if row['kind'] != 'directory' and row['path'] not in retained_paths and os.path.lexists(row['path'])]
        remaining += [row['path'] for row in [identity['unit'], identity['config'], identity['current']] if os.path.lexists(row['path'])]
        remaining += [row['directory']['path'] for row in identity.get('migration', []) if os.path.lexists(row['directory']['path'])]
        process_free = not self.processes({row['uid'] for row in identity.get('accounts', []) if row.get('uid')})
        mount_free = not self.mounts() and not [row for row in self.loops() if str(row.get('back-file', '')).removesuffix(' (deleted)').startswith(str(self.data) + '/')]
        commands = []
        if identity['firewall']:
            commands = [shlex.split(line) for line in self.run(['ufw', 'show', 'added']).splitlines() if line.strip().startswith('ufw ')]
        owner_comments = {row[-1] for row in identity['firewall']}
        firewall_removed = not any(any(command[index + 1] in owner_comments for index, word in enumerate(command[:-1]) if word == 'comment') for command in commands)
        network_removed = True
        if identity.get('network'):
            tables = json.loads(self.run(['nft', '-j', 'list', 'tables'])).get('nftables')
            require(isinstance(tables, list), 'Independent nftables verification is unavailable.')
            network_removed = not any(row.get('table', {}).get('family') == 'inet' and row.get('table', {}).get('name') == identity['network']['table'] for row in tables)
        zram_removed = not identity['ownedZram'] or not os.path.lexists(self.path('/etc/vortex-zram/owner.json')) and not os.path.lexists(self.path('/etc/systemd/system/vortex-zram.service')) and self.property('ActiveState', 'vortex-zram.service') not in ['active', 'activating', 'deactivating']
        network_profile_restored, timezone_restored, managed_tls_removed = self.verify_host_maintenance(identity, result)
        isolation_removed = True
        if identity.get('isolation'):
            receipt = self.path('/var/lib/vortex-application-isolation/apparmor.json')
            if receipt.exists():
                owners = self.load(receipt, 65536, private=True).get('owners')
                isolation_removed = isinstance(owners, dict) and bool(owners) and self.unit not in owners
            else:
                isolation_removed = not os.path.lexists(self.path('/etc/apparmor.d/vortex-application-bwrap'))
        account_names = [row['name'] for row in identity.get('accounts', [])]
        if identity.get('serviceAccount'):
            account_names.append(identity['serviceAccount']['name'])
        accounts_removed = all(not self.run(['getent', 'passwd', name], missing=True) and not self.run(['getent', 'group', name], missing=True) and not self.local_account('passwd', name) and not self.local_account('group', name) for name in account_names)
        # A retained source file is honest partial cleanup, even if it no longer
        # runs. Never turn retained changed components into a full-success proof.
        owned_retained = [row for row in result.get('retained', []) if row.get('kind') not in ['baseline', 'package', 'packages', 'package-marks', 'shared-helper', 'shared-account', 'external-backup'] and row.get('path') != 'pre-install operating-system state']
        files_verified = not remaining and not owned_retained and isolation_removed and network_profile_restored and timezone_restored and managed_tls_removed
        verified = service_removed and files_verified and process_free and mount_free and firewall_removed and network_removed and zram_removed and accounts_removed and result.get('effectStarted') is True and result.get('status') in ['removed', 'completed']
        baseline_restored = bool(verified and result.get('baselineRestored'))
        if baseline_restored:
            try:
                baseline_restored = bool(identity.get('packageBaselineSHA256') and identity['packageBaselineSHA256'] == self.current_package_digest())
            except (RemovalError, OSError, subprocess.SubprocessError):
                baseline_restored = False
        return {'schemaVersion': 1, 'role': saved['role'], 'nodeId': saved['nodeId'], 'machineId': saved['machineId'], 'panelId': saved['panelId'], 'revision': saved['revision'], 'requestId': saved['requestId'], 'verified': verified,
                'inventoryEmpty': not os.path.lexists(self.data), 'serviceRemoved': service_removed, 'filesVerified': files_verified, 'processesAbsent': process_free, 'mountsAbsent': mount_free,
                'firewallRemoved': firewall_removed, 'networkCountersRemoved': network_removed, 'zramRemoved': zram_removed, 'accountsRemoved': accounts_removed,
                'applicationIsolationRemoved': isolation_removed,
                'networkProfileRestored': network_profile_restored, 'timezoneRestorationVerified': timezone_restored, 'managedTLSRemoved': managed_tls_removed,
                'remainingOwnedPaths': sorted(set(remaining)), 'retained': result.get('retained', []), 'outcomeStatus': result.get('status'), 'effectStarted': result.get('effectStarted', False),
                'baselineRestored': baseline_restored, 'receiptPath': str(work / 'result.json')}

    def verify_host_maintenance(self, identity, result):
        network, timezone, tls = True, True, True
        if identity.get('networkProfile'):
            restored = result.get('networkProfileRestoration') or {}
            profile = self.path('/etc/sysctl.d/70-' + ('vortex-panel' if self.role == 'panel' else 'vortex-node') + '-network.conf')
            network = restored.get('outcome') == 'restored' and not os.path.lexists(profile) and isinstance(restored.get('values'), dict) and set(restored['values']).issubset(NETWORK_KEYS)
            if network:
                try:
                    network = all(self.read(self.path('/proc/sys/' + key.replace('.', '/')), 4096).decode().strip() == value for key, value in restored['values'].items())
                except (RemovalError, OSError, UnicodeError):
                    network = False
        if identity.get('hostTimezone'):
            restored = result.get('hostTimezoneRestoration') or {}
            timezone = restored.get('outcome') in ['restored', 'preserved-external']
            if timezone and restored['outcome'] == 'restored':
                try:
                    timezone = self.run(['/usr/bin/timedatectl', 'show', '--property=Timezone', '--value']) == identity['hostTimezone']['original']
                except (RemovalError, OSError, subprocess.SubprocessError):
                    timezone = False
        if identity.get('managedTLS'):
            restored = result.get('managedTLSRestoration') or {}
            tls = restored.get('outcome') == 'restored' and all(not os.path.lexists(self.path(name)) for name in TLS_PATHS) and not os.path.lexists(self.path('/run/vortex-panel-tls'))
            if tls:
                tls = all(self.property('ActiveState', 'vortex-panel-tls-renew.' + suffix) not in ['active', 'activating', 'deactivating'] and self.property('UnitFileState', 'vortex-panel-tls-renew.' + suffix) not in ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'] for suffix in ['service', 'timer'])
        return bool(network), bool(timezone), bool(tls)

    def status(self, request):
        work, _ = self.saved(request)
        return self.public(self.load(work / 'result.json', 32 * 1024 ** 2, private=True))

    def abort(self, request):
        work, saved = self.saved(request)
        with self.lock():
            result = self.load(work / 'result.json', 32 * 1024 ** 2, private=True)
            require(result.get('status') == 'prepared' and result.get('effectStarted') is False and not (work / 'launched.json').exists(), 'Only an unlaunched prepared operation can be cancelled.')
            for suffix in ['.service', '.timer']:
                unit = 'vortex-fleet-remove-' + saved['requestId'] + suffix
                require(self.property('LoadState', unit) == 'not-found', 'A detached cleanup may already be scheduled; cancellation is refused.')
            plan = self.load(work / 'plan.json', 64 * 1024 ** 2, private=True)
            self.restore_identity(plan['_identity'])
            intent = self.data / '.fleet-removal-intent.json'
            value = self.load(intent, 512 * 1024, private=True, mutable=True)
            require(all(value.get(key) == saved.get(key) for key in ['requestId', 'nodeId', 'machineId', 'panelId', 'revision']), 'Admission freeze identity changed.')
            intent.unlink()
            result.update(status='cancelled', phase='cancelled', finishedAt=time.time())
            self.save(work / 'result.json', result)
            return {'schemaVersion': 1, 'ok': True, 'requestId': saved['requestId'], 'nodeId': saved['nodeId'], 'status': 'cancelled', 'effectStarted': False}

    @staticmethod
    def public(value):
        return {key: item for key, item in value.items() if key not in ['_identity', '_ledger', 'plan']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['plan', 'prepare', 'launch', 'apply', 'status', 'verify', 'abort'])
    parser.add_argument('--request-id')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'Native fleet removal requires Linux root.')
    host = Host()
    if args.request_id is not None:
        require(args.action in ['apply', 'status', 'verify'], 'Only detached apply/status/verify accept a saved CLI operation identity.')
        require(UUID.fullmatch(str(args.request_id)), 'Detached apply requires a saved operation identity.')
        work = host.workspace(args.request_id)
        require(Path(__file__).absolute() == work / 'helper.py', 'Saved operations must run from their private detached workspace.')
        request = validate(host.load(work / 'request.json', 512 * 1024, private=True), True)
    else:
        require(args.request_id is None, 'Only detached apply accepts a CLI operation identity.')
        raw = sys.stdin.buffer.read(512 * 1024 + 1)
        require(len(raw) <= 512 * 1024, 'Removal request exceeds its bound.')
        request = validate(json.loads(raw), args.action != 'plan')
    result = getattr(host, args.action)(request)
    print(json.dumps(host.public(result), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'schemaVersion': 1, 'ok': False, 'error': str(error) if isinstance(error, RemovalError) else 'Native removal could not be verified. No success was inferred.'}, separators=(',', ':')))
        raise SystemExit(1)
