#!/usr/bin/env python3
"""Fixed-purpose worker removal. No shell, arbitrary target, package purge or world deletion."""
import argparse
import contextlib
try:
    import fcntl
except ImportError:  # Offline fixtures may run on Windows; production is Linux.
    fcntl = None
import hashlib
import importlib.util
import json
import ipaddress
import os
import pathlib
import re
import ssl
import shlex
import stat
import subprocess
import sys
import time
sys.dont_write_bytecode = True

UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$', re.I)
NETWORK_KEYS = ('net.core.rmem_max', 'net.core.wmem_max', 'net.ipv4.tcp_congestion_control', 'net.core.default_qdisc')
UNIT = 'vortex-node.service'
WORK_BASE = '/var/lib/vortex-node-removal'
LOCK = '/run/vortex-os-maintenance.lock'


class RemovalError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise RemovalError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def execute(args, timeout=30, missing=False):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env={**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    require(len(result.stdout) <= 8 * 1024 * 1024, 'Host output exceeds its bound.')
    if result.returncode and not missing:
        raise RemovalError('A fixed host inspection or cleanup command failed.')
    return result.stdout.strip()


class Host:
    def __init__(self, root=None, run=execute, enforce_owner=True):
        self.root = pathlib.Path(root) if root else None
        self.run = run
        self.enforce_owner = enforce_owner
        self.install = self.path('/opt/vortex-node')
        self.config = self.path('/etc/vortex-node.json')
        self.tls = self.path('/etc/vortex-node')
        self.unit = self.path('/etc/systemd/system/' + UNIT)
        self.data = self.path('/var/lib/vortex-node')
        self.work_base = self.path(WORK_BASE)

    def path(self, absolute):
        return self.root / absolute.lstrip('/') if self.root else pathlib.Path(absolute)

    def safe(self, filename, missing=False, link=False):
        filename = pathlib.Path(filename)
        require(filename.is_absolute() and '..' not in filename.parts, 'Unsafe removal path.')
        for parent in reversed(filename.parents):
            if parent.exists():
                info = parent.lstat()
                require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink(), 'A removal ancestor is linked or not a directory.')
                if self.enforce_owner:
                    require(info.st_uid == 0 and not info.st_mode & 0o022, 'A removal ancestor is writable by another user.')
        try:
            info = filename.lstat()
        except FileNotFoundError:
            if missing:
                return None
            raise RemovalError('An expected owned path is missing.')
        require(link or not stat.S_ISLNK(info.st_mode), 'An owned path was replaced by a link.')
        if self.enforce_owner:
            require(info.st_uid == 0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022), 'An owned path has unsafe ownership or permissions.')
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'An owned path is not an exclusive regular file.')
        return info

    def read(self, filename, maximum=4 * 1024 * 1024, private=False):
        info = self.safe(filename)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, 'An ownership record is not a bounded regular file.')
        if private and self.enforce_owner:
            require(not info.st_mode & 0o077, 'An ownership record is not private.')
        with open(filename, 'rb') as stream:
            content = stream.read(maximum + 1)
        require(len(content) <= maximum, 'An ownership record exceeds its bound.')
        return content

    def load(self, filename, maximum=4 * 1024 * 1024, private=False):
        return json.loads(self.read(filename, maximum, private))

    def stamp(self, filename, link=False):
        info = self.safe(filename, link=link)
        row = {'path': str(filename), 'dev': info.st_dev, 'ino': info.st_ino, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid,
               'kind': 'symlink' if stat.S_ISLNK(info.st_mode) else 'directory' if stat.S_ISDIR(info.st_mode) else 'file'}
        if row['kind'] == 'file':
            require(info.st_size <= 128 * 1024 * 1024, 'An owned source file exceeds the inspection bound.')
            row['sha256'] = hashlib.sha256(self.read(filename, 128 * 1024 * 1024)).hexdigest()
        if row['kind'] == 'symlink':
            row['target'] = os.readlink(filename)
        return row

    def same(self, row):
        return self.stamp(row['path'], link=row['kind'] == 'symlink') == row

    def property(self, name):
        return self.run(['systemctl', 'show', UNIT, '--property=' + name, '--value'], missing=True)

    def processes(self):
        found = []
        proc = self.path('/proc')
        if not proc.exists():
            raise RemovalError('Process inventory is unavailable.')
        for entry in proc.iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                values = [os.readlink(entry / part).removesuffix(' (deleted)') for part in ['cwd', 'exe']]
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                raise RemovalError('Process inventory cannot be verified.')
            if any(value == str(parent) or value.startswith(str(parent) + os.sep) for value in values for parent in [self.data, self.install]):
                found.append(int(entry.name))
        return sorted(found)

    def mounts(self):
        with open(self.path('/proc/self/mountinfo'), 'rb') as stream:
            text = stream.read(8 * 1024 * 1024 + 1).decode()
        require(len(text) <= 8 * 1024 * 1024, 'Mount inventory exceeds its bound.')
        found = []
        for line in text.splitlines():
            fields = line.split()
            require(len(fields) >= 10, 'Mount inventory is invalid.')
            target = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
            if any(target == str(parent) or target.startswith(str(parent) + os.sep) for parent in [self.data, self.install, self.tls]):
                found.append(target)
        return found

    def loops(self):
        value = json.loads(self.run(['losetup', '--json', '--list', '--output', 'BACK-FILE']))
        rows = value.get('loopdevices', [])
        require(isinstance(rows, list) and len(rows) <= 10000, 'Loop-device inventory is unknown.')
        return [row.get('back-file') for row in rows if any(str(row.get('back-file', '')).removesuffix(' (deleted)').startswith(str(parent) + os.sep) for parent in [self.data, self.install])]

    def firewall_rules(self):
        filename = self.tls / 'firewall-owner.json'
        if not filename.exists():
            return []
        value = self.load(filename, 65536, private=True)
        require(value.get('schemaVersion') == 1 and value.get('nodeId') == self.node_id and isinstance(value.get('rules'), list) and len(value['rules']) <= 64, 'Firewall ownership receipt is invalid.')
        commands = []
        for line in self.run(['ufw', 'show', 'added']).splitlines():
            if line.strip().startswith('ufw '):
                commands.append(shlex.split(line))
        rows = []
        expected_rows = []
        for rule in value['rules']:
            require(set(rule) == {'source', 'port', 'protocol', 'comment'} and type(rule['port']) is int and 1024 <= rule['port'] <= 65535 and rule['protocol'] == 'tcp' and rule['comment'] == 'vortex-agent:' + self.node_id, 'Firewall ownership tuple is invalid.')
            ipaddress.ip_address(rule['source'])
            expected = ['ufw', 'allow', 'from', rule['source'], 'to', 'any', 'port', str(rule['port']), 'proto', 'tcp', 'comment', rule['comment']]
            expected_rows.append(expected)
        require(not [row for row in commands if 'vortex-agent:' + self.node_id in row and row not in expected_rows], 'Tagged firewall rules changed and require manual review.')
        for rule, expected in zip(value['rules'], expected_rows):
            # Different order is not guessed: retaining an unfamiliar tuple is
            # safer than deleting a foreign policy merely sharing a comment.
            matching = [row for row in commands if rule['comment'] in row and row == expected]
            rows.append({**rule, 'present': bool(matching)})
        return rows

    def network_table(self):
        filename = self.data / '.network-metrics.json'
        if not filename.exists():
            return None
        value = self.load(filename, 4096, private=True)
        require(value.get('schemaVersion') == 1 and UUID.fullmatch(value.get('owner', '')) and value.get('table') == 'vortex_metrics_' + value['owner'].replace('-', ''), 'Network-counter ownership record is invalid.')
        tables = json.loads(self.run(['nft', '-j', 'list', 'tables'])).get('nftables')
        require(isinstance(tables, list) and len(tables) <= 10000, 'Network-counter inventory is unavailable.')
        return value['table'] if any(row.get('table', {}).get('family') == 'inet' and row.get('table', {}).get('name') == value['table'] for row in tables if isinstance(row, dict)) else None

    def zram(self, cleanup=False):
        owner = self.path('/etc/vortex-zram/owner.json')
        helper = self.path('/usr/local/libexec/vortex-host-zram.py')
        if not owner.exists():
            return {'present': False, 'owned': False, 'components': []}
        record = self.load(owner, 65536, private=True)
        if record.get('role') != 'worker' or record.get('nodeId') != self.node_id:
            return {'present': True, 'owned': False, 'components': [{'kind': 'zram', 'path': str(owner.parent), 'action': 'retain', 'reason': 'Separate or foreign compressed swap is preserved.'}]}
        self.safe(helper)
        source = pathlib.Path(__file__).resolve()
        reference = source.with_name('host-zram.reference.py' if source.name == 'helper.py' else 'host-zram.py')
        expected = hashlib.sha256(self.read(reference, 1024 * 1024)).hexdigest()
        require(hashlib.sha256(self.read(helper, 1024 * 1024)).hexdigest() == expected, 'The installed memory helper differs from the packaged source; it was not executed.')
        spec = importlib.util.spec_from_file_location('vortex_owned_zram', helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        if cleanup:
            return module.cleanup_owned(role='worker', node_id=self.node_id, service_id=UNIT, lock_held=True)
        return module.inspect_owned(role='worker', node_id=self.node_id, service_id=UNIT)

    def maintenance_module(self, filename, expected_sha=None):
        raw = self.read(filename, 2 * 1024 ** 2)
        require(expected_sha is None or hashlib.sha256(raw).hexdigest() == expected_sha, 'The owned host-maintenance helper changed.')
        spec = importlib.util.spec_from_file_location('vortex_worker_host_maintenance', filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        require(all(hasattr(module.Host, name) for name in ['network_profile', 'host_timezone', 'cleanup_network_profile', 'cleanup_timezone']), 'Update this worker before uninstalling its managed host settings.')
        host = module.Host(root=self.root, run=self.run, enforce_owner=self.enforce_owner)
        host.role, host.node_id, host.unit = 'worker', self.node_id, UNIT
        host.install, host.data, host.config_root = self.install, self.data, self.tls
        return host

    def host_maintenance(self, release):
        profile = self.path('/etc/sysctl.d/70-vortex-node-network.conf')
        if not any(os.path.lexists(path) for path in [profile, self.tls / 'network-tuning.json', self.data / 'timezone-operations.json']):
            return None
        reference = release / 'server/fleet-removal.py'
        ownership_file = self.tls / 'install-ledger.json'
        ownership = self.load(ownership_file, 48 * 1024 ** 2, private=True)
        machine = self.read(self.path('/etc/machine-id'), 128).decode().strip()
        require(ownership.get('schemaVersion') == 1 and ownership.get('product') == 'vortex-node' and ownership.get('role') == 'worker' and ownership.get('nodeId') == self.node_id
                and re.fullmatch('[a-f0-9]{32}', machine) and ownership.get('machineId') == machine and UUID.fullmatch(str(ownership.get('installId', '')))
                and isinstance(ownership.get('components'), list) and len(ownership['components']) <= 150000, 'Managed host restoration needs this worker installation receipt.')
        references = [reference]
        if os.path.lexists(profile) or os.path.lexists(self.tls / 'network-tuning.json'):
            references.append(release / 'server/host-network-tuning.py')
        for filename in references:
            actual = self.stamp(filename)
            require(any(row.get('path') == str(filename) and row.get('existedBefore') is False and row.get('createdByInstallId') == ownership['installId']
                        and all(row.get(key) == value for key, value in actual.items()) for row in ownership['components']), 'An unproven or changed host-maintenance helper was preserved without execution.')
        host = self.maintenance_module(reference)
        host.release = release
        network, timezone = host.network_profile(), host.host_timezone()
        return {'referenceSHA256': hashlib.sha256(self.read(reference, 2 * 1024 ** 2)).hexdigest(), 'installerReceipt': self.stamp(ownership_file), 'networkProfile': network, 'hostTimezone': timezone}

    def stage_host_maintenance(self, proof, release, work):
        require(proof.get('installerReceipt', {}).get('path') == str(self.tls / 'install-ledger.json') and self.same(proof['installerReceipt']), 'The host-maintenance installer receipt changed before private staging.')
        sources = [(release / 'server/fleet-removal.py', work / 'fleet-maintenance.reference.py', proof['referenceSHA256'])]
        if proof.get('networkProfile'):
            sources.append((release / 'server/host-network-tuning.py', work / 'host-network-tuning.reference.py', proof['networkProfile']['referenceSHA256']))
        for source, target, expected in sources:
            raw = self.read(source, 2 * 1024 ** 2)
            require(hashlib.sha256(raw).hexdigest() == expected and not os.path.lexists(target), 'A host-maintenance reference changed before private staging.')
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())

    def restore_host_maintenance(self, proof, work, result):
        host = self.maintenance_module(work / 'fleet-maintenance.reference.py', proof['referenceSHA256'])
        host.cleanup_network_profile(proof, work, result)
        host.cleanup_timezone(proof, result)

    def verify_host_maintenance(self, proof, result):
        network, timezone = True, True
        if proof and proof.get('networkProfile'):
            restored = result.get('networkProfileRestoration') or {}
            network = restored.get('outcome') == 'restored' and not os.path.lexists(self.path('/etc/sysctl.d/70-vortex-node-network.conf')) and isinstance(restored.get('values'), dict) and set(restored['values']).issubset(NETWORK_KEYS)
            if network:
                try:
                    network = all(self.read(self.path('/proc/sys/' + key.replace('.', '/')), 4096).decode().strip() == value for key, value in restored['values'].items())
                except (RemovalError, OSError, UnicodeError):
                    network = False
        if proof and proof.get('hostTimezone'):
            restored = result.get('hostTimezoneRestoration') or {}
            timezone = restored.get('outcome') in ['restored', 'preserved-external']
            if timezone and restored['outcome'] == 'restored':
                try:
                    timezone = self.run(['/usr/bin/timedatectl', 'show', '--property=Timezone', '--value']) == proof['hostTimezone']['original']
                except (RemovalError, OSError, subprocess.SubprocessError):
                    timezone = False
        return bool(network), bool(timezone)

    def plan(self, node_id):
        require(UUID.fullmatch(node_id or ''), 'Invalid worker identity.')
        self.node_id = node_id
        config = self.load(self.config, 65536, private=True)
        require(config.get('nodeId') == node_id and config.get('schemaVersion') == 1, 'The SSH host is not the enrolled worker.')
        require(config.get('dataDir') == str(self.data), 'Custom data paths require an independently reviewed cleanup; no removal was attempted.')
        tls = config.get('tls') or {}
        require(tls.get('certFile') == str(self.tls / 'tls.crt') and tls.get('keyFile') == str(self.tls / 'tls.key'), 'Custom TLS paths are retained; automatic removal is unavailable.')
        certificate = self.read(self.tls / 'tls.crt', 512 * 1024).decode()
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest().upper()
        require(self.property('FragmentPath') == str(self.unit), 'The worker is not the expected managed system service.')
        drop_in = self.path('/etc/systemd/system/vortex-node.service.d/vortex-memory.conf')
        drop_paths = self.property('DropInPaths').split()
        require(not drop_paths or drop_paths == [str(drop_in)] and self.read(drop_in, 4096) == b'[Service]\nTimeoutStopSec=240\n', 'Custom service overrides require manual review.')
        require(self.property('ActiveState') == 'active', 'The worker must be connected and active for an authenticated removal plan.')
        pid_text = self.property('MainPID')
        require(re.fullmatch(r'[1-9]\d*', pid_text or ''), 'The managed worker process could not be verified.')
        pid = int(pid_text)
        current = self.install / 'current'
        self.safe(current, link=True)
        require(current.is_symlink(), 'The worker current path is not an owned release link.')
        release = current.resolve(strict=True)
        require(release.parent == self.install / 'releases', 'The active release is outside the worker install root.')
        self.safe(release)
        require(self.property('WorkingDirectory') in [str(current), str(release)], 'The service working directory does not match the installed worker.')
        start = self.property('ExecStart')
        require(str(current / 'server/node-cli.js') in start or str(release / 'server/node-cli.js') in start, 'The service does not run the worker entry point.')
        unit_text = self.read(self.unit, 65536).decode()
        start_lines = [line[len('ExecStart='):] for line in unit_text.splitlines() if line.startswith('ExecStart=')]
        require(len(start_lines) == 1, 'The worker unit start command is ambiguous.')
        start_args = shlex.split(start_lines[0])
        require(len(start_args) == 3 and start_args[1] in [str(current / 'server/node-cli.js'), str(release / 'server/node-cli.js')] and start_args[2] == 'serve' and pathlib.Path(start_args[0]).is_absolute(), 'The worker unit start command is not the installed agent.')
        store = self.load(self.data / 'panel.json', 32 * 1024 * 1024, private=True)
        require(isinstance(store.get('servers'), list) and isinstance(store.get('jobs'), list), 'The worker inventory is unknown.')
        blockers = []
        def block(code, message):
            blockers.append({'code': code, 'message': message})
        if store['servers']:
            block('REMOVAL_SERVERS', 'Move or remove all game servers before uninstalling this VPS. No worlds will be deleted by uninstall.')
        if store.get('users'):
            block('REMOVAL_PANEL_DATA', 'This data directory contains panel accounts and cannot be removed as worker data.')
        if any(job.get('status') not in ['completed', 'failed', 'cancelled'] or job.get('recoveryRequired') or job.get('completionStatusPersisted') is False or (job.get('result') or {}).get('cleanupPending') for job in store['jobs']):
            block('REMOVAL_BUSY', 'Wait for all worker jobs and recovery work to finish.')
        if self.processes() != [pid]:
            block('REMOVAL_PROCESSES', 'Other processes still use the worker source or data.')
        if self.mounts() or self.loops():
            block('REMOVAL_MOUNTS', 'A storage mount remains inside the worker paths; it was preserved.')
        maintenance = None
        try:
            maintenance = self.host_maintenance(release)
        except Exception:
            message = 'Managed host settings cannot be verified for restoration. Update this worker or review its network profile and timezone journal before uninstalling.'
            block('REMOVAL_HOST_SETTINGS', message)
            blockers[-1]['messageI18n'] = {'id': 'panel.node-removal.host-settings', 'en': message, 'vi': 'Chưa xác minh được việc khôi phục thiết lập hệ thống. Cập nhật VPS phụ hoặc kiểm tra cấu hình mạng và nhật ký múi giờ trước khi gỡ.', 'params': []}
        for folder in [self.data / 'servers', self.data / '.storage']:
            if folder.exists():
                self.safe(folder)
                if any(folder.iterdir()):
                    block('REMOVAL_DATA_REMAINS', 'Server folders or storage images remain and require review before uninstall.')
        components = []
        entries = {}
        def add(filename, reason):
            info = self.safe(filename, missing=True, link=pathlib.Path(filename) == current)
            if info:
                row = self.stamp(filename, link=pathlib.Path(filename) == current)
                entries[str(filename)] = row
                components.append({'kind': row['kind'], 'path': str(filename), 'action': 'remove', 'reason': reason})
        for filename in [self.unit, self.config, self.tls / 'tls.crt', self.tls / 'tls.key', current, self.data / 'panel.json']:
            add(filename, 'Verified worker service, identity, connection or empty inventory.')
        if maintenance:
            if maintenance.get('networkProfile'):
                add(self.tls / 'network-tuning.json', 'Owned network profile state; removed only after restoring unchanged Vortex-applied values.')
                components.append({'kind': 'network-profile', 'path': str(self.path('/etc/sysctl.d/70-vortex-node-network.conf')), 'action': 'restore', 'reason': 'Restore only unchanged Vortex-applied values; preserve later administrator settings.'})
            if maintenance.get('hostTimezone'):
                add(self.data / 'timezone-operations.json', 'Verified role-bound timezone journal; original zone restored only if the last completed Vortex choice is still active.')
        if drop_paths:
            add(drop_in, 'Exact Vortex graceful-shutdown service override.')
        firewall = self.firewall_rules()
        if firewall:
            add(self.tls / 'firewall-owner.json', 'Exact tagged controller firewall ownership receipt.')
            for row in firewall:
                if row['present']:
                    components.append({'kind': 'firewall', 'path': 'TCP ' + str(row['port']) + ' from ' + row['source'], 'action': 'remove', 'reason': 'Exact tagged rule created by worker enrollment.'})
        network_table = self.network_table()
        if (self.data / '.network-metrics.json').exists():
            add(self.data / '.network-metrics.json', 'Verified worker network-counter identity.')
        if network_table:
            components.append({'kind': 'network-counters', 'path': network_table, 'action': 'remove', 'reason': 'The worker validates exclusive ownership before removing its counter table.'})
        manifest_path = self.tls / 'install-manifest.json'
        legacy = not manifest_path.exists()
        if not legacy:
            manifest = self.load(manifest_path, 16 * 1024 * 1024, private=True)
            require(manifest.get('schemaVersion') == 1 and manifest.get('product') == 'vortex-node' and manifest.get('nodeId') == node_id and UUID.fullmatch(manifest.get('installId', '')), 'Installer ownership receipt does not match this worker.')
            require(isinstance(manifest.get('components'), list) and len(manifest['components']) <= 50000, 'Installer ownership inventory exceeds its bound.')
            for row in manifest['components']:
                filename = pathlib.Path(row.get('path', ''))
                shared_helper = filename == self.path('/usr/local/libexec/vortex-host-zram.py')
                require(filename.is_absolute() and (shared_helper or any(filename == parent or parent in filename.parents for parent in [self.install, self.tls])), 'An installer-owned path escaped the worker roots.')
                if shared_helper and any(os.path.lexists(self.path('/etc/systemd/system/' + unit)) for unit in ['vortex-panel.service', 'bedrock-panel.service']):
                    components.append({'kind': 'shared-helper', 'path': str(filename), 'action': 'retain', 'reason': 'The host also has a main panel; its shared OS helper is preserved.'})
                    continue
                if str(filename) in entries or not os.path.lexists(filename):
                    continue
                if row.get('existedBefore') is False and row.get('createdByInstallId') == manifest['installId']:
                    try:
                        actual = self.stamp(filename, link=row.get('kind') == 'symlink')
                        expected = {key: row[key] for key in actual}
                        require(actual == expected, 'An installer-owned path changed since its receipt.')
                        entries[str(filename)] = actual
                        components.append({'kind': actual['kind'], 'path': str(filename), 'action': 'remove', 'reason': 'Exact installer ownership receipt.'})
                    except (RemovalError, KeyError):
                        components.append({'kind': row.get('kind', 'file'), 'path': str(filename), 'action': 'retain', 'reason': 'Ownership or content changed after installation.'})
            add(manifest_path, 'Installer ownership receipt; copied to the private operation before removal.')
        for folder in [self.install / 'releases', self.data, self.tls]:
            if folder.exists():
                components.append({'kind': 'directory', 'path': str(folder), 'action': 'retain', 'reason': 'Unrecorded files and diagnostic/recovery data are preserved; empty owned directories are removed only when safe.'})
        for filename in ['/etc/systemd/system/vortex-panel.service', '/opt/vortex-panel', '/var/lib/vortex-panel', '/etc/vortex-panel.env', '/etc/systemd/system/bedrock-panel.service', '/opt/bedrock-panel', '/var/lib/bedrock-panel', '/etc/bedrock-panel.env', '/etc/nginx/sites-available/bedrock-panel', '/etc/nginx/sites-enabled/bedrock-panel']:
            target = self.path(filename)
            if os.path.lexists(target):
                components.append({'kind': 'legacy-panel', 'path': str(target), 'action': 'retain', 'reason': 'Separate panel installation is outside this worker identity; its data and configuration are preserved.'})
        components.append({'kind': 'shared-tools', 'path': '/usr/local and operating-system packages', 'action': 'retain', 'reason': 'Shared Node.js, system packages and untagged firewall rules have no exclusive ownership receipt.'})
        zram = self.zram()
        components.extend({'kind': 'zram', 'path': row, 'action': 'remove', 'reason': 'Verified compressed swap owned by this worker.'} if isinstance(row, str) else row for row in zram.get('components', []))
        if zram.get('canCleanup') is False:
            block('REMOVAL_ZRAM_BUSY', zram.get('reason') or 'Owned compressed swap cannot be safely deactivated with current memory headroom.')
        boot = self.read(self.path('/proc/sys/kernel/random/boot_id'), 100).decode().strip()
        identity = {'agentId': node_id, 'fingerprint': fingerprint, 'pid': pid, 'bootId': boot, 'release': str(release), 'data': self.stamp(self.data), 'entries': list(entries.values()), 'firewall': firewall, 'networkTable': network_table, 'ownedZram': zram.get('owned') is True, 'nodeBinary': start_args[0]}
        if maintenance:
            identity['hostMaintenance'] = maintenance
        return {'schemaVersion': 1, 'agentId': node_id, 'revision': digest(identity), 'status': 'blocked' if blockers else 'ready', 'serverCount': len(store['servers']), 'blockers': blockers, 'components': components, 'sshRequired': True, 'legacyOwnership': legacy, 'fullyClean': False, 'fingerprint': fingerprint, 'processId': pid, 'bootId': boot, '_identity': identity}

    @contextlib.contextmanager
    def os_lock(self):
        require(fcntl is not None, 'Operating-system maintenance requires Linux.')
        filename = self.path(LOCK)
        fd = os.open(filename, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
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

    def workspace(self, request_id):
        require(UUID.fullmatch(request_id or ''), 'Invalid removal operation identity.')
        target = self.work_base / request_id
        self.safe(self.work_base)
        self.safe(target)
        require(not self.enforce_owner or not target.stat().st_mode & 0o077, 'The operation workspace is not private.')
        return target

    def save(self, filename, value):
        temporary = pathlib.Path(str(filename) + '.tmp')
        with open(temporary, 'x', encoding='utf8') as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, filename)
        if os.name != 'nt':
            descriptor = os.open(filename.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def remove(self, node_id, request_id, revision):
        work = self.workspace(request_id)
        result_path = work / 'result.json'
        require(not result_path.exists(), 'This operation already has an outcome; it will not be dispatched again.')
        result = {'schemaVersion': 1, 'requestId': request_id, 'nodeId': node_id, 'status': 'running', 'phase': 'checking', 'removed': [], 'retained': [], 'startedAt': time.time(), 'effectStarted': False}
        self.save(result_path, result)
        try:
            with self.os_lock():
                plan = self.plan(node_id)
                require(plan['status'] == 'ready' and plan['revision'] == revision, 'The worker removal plan changed; no cleanup was attempted.')
                intent = self.load(self.data / '.removal-intent.json', 65536, private=True)
                require(intent.get('requestId') == request_id and intent.get('nodeId') == node_id and intent.get('revision') == revision, 'The worker admission freeze does not match this operation.')
                plan['_identity']['entries'].append(self.stamp(self.data / '.removal-intent.json'))
                result['plan'] = plan
                result['retained'] = [row for row in plan['components'] if row['action'] == 'retain']
                self.save(result_path, result)
                maintenance = plan['_identity'].get('hostMaintenance')
                if maintenance:
                    self.stage_host_maintenance(maintenance, pathlib.Path(plan['_identity']['release']), work)
                if self.zram().get('owned'):
                    result['effectStarted'] = True
                    self.save(result_path, result)
                    outcome = self.zram(cleanup=True)
                    require(outcome.get('ok') is True, 'Owned compressed swap cleanup was not safely confirmed.')
                result.update(phase='stopping', effectStarted=True)
                self.save(result_path, result)
                self.run(['systemctl', 'disable', UNIT])
                self.run(['systemctl', 'stop', UNIT], timeout=270)
                require(self.property('ActiveState') not in ['active', 'activating', 'deactivating'] and self.property('MainPID') in ['0', ''], 'The managed worker has not stopped.')
                require(not self.processes() and not self.mounts() and not self.loops(), 'Processes or mounts remain; source/data were preserved.')
                if maintenance:
                    result['phase'] = 'host-maintenance'
                    self.save(result_path, result)
                    self.restore_host_maintenance(maintenance, work, result)
                    if maintenance.get('networkProfile'):
                        # Restoring the durable profile atomically updates its
                        # own state file. Only this verified fixed state may
                        # replace its preview stamp before erasure.
                        for row in plan['_identity']['entries']:
                            if row['path'] == str(self.tls / 'network-tuning.json'):
                                row.update(self.stamp(row['path']))
                    self.save(result_path, result)
                if self.network_table():
                    program = 'import {pathToFileURL} from "node:url";const {createNetworkMetrics}=await import(pathToFileURL(process.argv[1]));const c=createNetworkMetrics({dataDir:process.argv[2]});await c.initialize();const r=await c.close();if(r?.cleaned!==true)process.exit(1);'
                    self.run([plan['_identity']['nodeBinary'], '--input-type=module', '-e', program, str(self.install / 'current/server/network-metrics.js'), str(self.data)])
                    require(not self.network_table(), 'Owned network counters remain; their ownership record was preserved.')
                for rule in plan['_identity']['firewall']:
                    if rule['present']:
                        self.run(['ufw', '--force', 'delete', 'allow', 'from', rule['source'], 'to', 'any', 'port', str(rule['port']), 'proto', 'tcp', 'comment', rule['comment']])
                require(not any(row['present'] for row in self.firewall_rules()), 'An owned controller firewall rule remains; no success was inferred.')
                # Store shutdown can append diagnostics. The empty inventory is
                # revalidated after graceful stop; only that exact latest file
                # replaces the preview stamp.
                store = self.load(self.data / 'panel.json', 32 * 1024 * 1024, private=True)
                require(not store.get('servers') and not store.get('users'), 'Worker inventory changed during shutdown.')
                for row in plan['_identity']['entries']:
                    if row['path'] == str(self.data / 'panel.json'):
                        row.update(self.stamp(row['path']))
                result['phase'] = 'removing'
                self.save(result_path, result)
                entries = sorted(plan['_identity']['entries'], key=lambda row: (row['kind'] == 'directory', -len(pathlib.Path(row['path']).parts)))
                for row in entries:
                    filename = pathlib.Path(row['path'])
                    require(self.same(row), 'An owned path changed before deletion; remaining paths were preserved.')
                    if row['kind'] == 'directory':
                        try:
                            filename.rmdir()
                        except OSError:
                            result['retained'].append({'kind': 'directory', 'path': str(filename), 'action': 'retain', 'reason': 'Directory contains unrecorded files.'})
                            continue
                    else:
                        filename.unlink()
                    result['removed'].append(str(filename))
                    self.save(result_path, result)
                self.run(['systemctl', 'daemon-reload'])
                self.run(['systemctl', 'reset-failed', UNIT], missing=True)
                result.update(phase='verifying', status='removed')
                self.save(result_path, result)
                proof = self.verify(node_id, request_id)
                require(proof['verified'], 'Independent removal conditions were not satisfied.')
                result.update(status='completed', phase='complete', finishedAt=time.time())
                self.save(result_path, result)
                if maintenance:
                    for name, expected in [('fleet-maintenance.reference.py', maintenance['referenceSHA256']), ('host-network-tuning.reference.py', (maintenance.get('networkProfile') or {}).get('referenceSHA256'))]:
                        filename = work / name
                        if expected and os.path.lexists(filename) and hashlib.sha256(self.read(filename, 2 * 1024 ** 2)).hexdigest() == expected:
                            filename.unlink()
        except Exception:
            # Never expose command stderr, configuration, credentials or logs.
            result.update(status='partial' if result['effectStarted'] else 'failed', phase='review', finishedAt=time.time(), error='Worker removal stopped; retain this receipt and verify the remaining components before recovery.')
            self.save(result_path, result)
        return result

    def abort(self, node_id, request_id):
        # The same kernel lock excludes an already executing detached helper.
        with self.os_lock():
            require(self.property('ActiveState') == 'active', 'The worker is no longer active; cancellation is unsafe.')
            intent_path = self.data / '.removal-intent.json'
            intent = self.load(intent_path, 65536, private=True)
            require(intent.get('nodeId') == node_id and intent.get('requestId') == request_id, 'The cancellation belongs to another operation.')
            self.safe(intent_path)
            intent_path.unlink()
        return {'ok': True, 'nodeId': node_id, 'requestId': request_id}

    def verify(self, node_id, request_id):
        work = self.workspace(request_id)
        if not (work / 'result.json').exists():
            # A controller can stop after prepare but before launch. Only an
            # intact matching intent and absent detached unit permit cancel;
            # the abort command takes the OS lock and fences a late helper by
            # removing the intent it must re-read before its first effect.
            intent = self.load(self.data / '.removal-intent.json', 65536, private=True)
            require(intent.get('nodeId') == node_id and intent.get('requestId') == request_id, 'A prepared operation could not be identified for safe cancellation.')
            load_state = self.run(['systemctl', 'show', 'vortex-node-remove-' + request_id + '.service', '--property=LoadState', '--value'], missing=True)
            require(load_state == 'not-found', 'A detached cleanup may still be running; cancellation was not inferred.')
            current = self.plan(node_id)
            require(current['status'] == 'ready' and current['revision'] == intent.get('revision'), 'The prepared worker changed; cancellation was not inferred.')
            return {'schemaVersion': 1, 'nodeId': node_id, 'requestId': request_id, 'verified': False, 'safeToCancel': True, 'inventoryEmpty': True, 'activeWorkerVerified': True, 'revision': current['revision'], 'fingerprint': current['fingerprint']}
        result = self.load(work / 'result.json', 16 * 1024 * 1024, private=True)
        require(result.get('nodeId') == node_id and result.get('requestId') == request_id, 'The removal receipt belongs to another node or operation.')
        plan = result.get('plan') or {}
        require(plan.get('agentId') == node_id and plan.get('serverCount') == 0, 'The receipt does not prove a checked empty worker inventory.')
        self.node_id = node_id
        enabled = self.property('UnitFileState')
        inactive = self.property('ActiveState') not in ['active', 'activating', 'deactivating'] and self.property('MainPID') in ['0', '']
        missing = [row['path'] for row in plan.get('_identity', {}).get('entries', []) if row['kind'] != 'directory' and os.path.lexists(row['path'])]
        process_free = not self.processes()
        mount_free = not self.mounts() and not self.loops()
        identity = plan.get('_identity', {})
        firewall_removed = True
        if identity.get('firewall'):
            firewall_removed = not any('vortex-agent:' + node_id in shlex.split(line) for line in self.run(['ufw', 'show', 'added']).splitlines() if line.strip().startswith('ufw '))
        network_removed = True
        if identity.get('networkTable'):
            tables = json.loads(self.run(['nft', '-j', 'list', 'tables'])).get('nftables')
            require(isinstance(tables, list) and len(tables) <= 10000, 'Network-counter verification is unavailable.')
            network_removed = not any(row.get('table', {}).get('family') == 'inet' and row.get('table', {}).get('name') == identity['networkTable'] for row in tables if isinstance(row, dict))
        zram_removed = not identity.get('ownedZram') or not os.path.lexists(self.path('/etc/vortex-zram/owner.json')) and not os.path.lexists(self.path('/etc/systemd/system/vortex-zram.service'))
        network_profile_restored, timezone_restored = self.verify_host_maintenance(identity.get('hostMaintenance'), result)
        files_verified = not missing and network_profile_restored and timezone_restored
        verified = inactive and enabled not in ['enabled', 'enabled-runtime', 'linked', 'linked-runtime'] and files_verified and process_free and mount_free and firewall_removed and network_removed and zram_removed
        return {'schemaVersion': 1, 'requestId': request_id, 'nodeId': node_id, 'verified': verified, 'inventoryEmpty': True, 'serviceRemoved': inactive and not os.path.lexists(self.unit), 'filesVerified': files_verified, 'processesAbsent': process_free, 'mountsAbsent': mount_free, 'firewallRemoved': firewall_removed, 'networkCountersRemoved': network_removed, 'zramRemoved': zram_removed, 'networkProfileRestored': network_profile_restored, 'timezoneRestorationVerified': timezone_restored, 'remainingOwnedPaths': missing, 'retained': result.get('retained', []), 'outcomeStatus': result.get('status'), 'effectStarted': result.get('effectStarted', False)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['plan', 'execute', 'verify', 'abort'])
    parser.add_argument('--node-id', required=True)
    parser.add_argument('--request-id')
    parser.add_argument('--revision')
    args = parser.parse_args()
    require(os.geteuid() == 0 and sys.platform == 'linux', 'Worker uninstall requires the managed Linux administrator service.')
    host = Host()
    if args.command == 'plan':
        value = host.plan(args.node_id)
        value.pop('_identity', None)
    elif args.command == 'execute':
        value = host.remove(args.node_id, args.request_id, args.revision)
        value.pop('plan', None)
    elif args.command == 'verify':
        value = host.verify(args.node_id, args.request_id)
    else:
        value = host.abort(args.node_id, args.request_id)
    print(json.dumps(value, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Worker removal inspection failed. No success is inferred; review the private operation receipt.'}))
        sys.exit(1)
