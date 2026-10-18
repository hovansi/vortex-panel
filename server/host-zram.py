#!/usr/bin/python3
"""Vortex-owned host memory assistance. No fstab, sysctl or foreign swap changes.

The command interface accepts one bounded JSON document on stdin. It never
accepts a filesystem path, command, compression expression or device from HTTP.
The class is importable by the root uninstall helper with its existing flock.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

MIB = 1024 ** 2
GIB = 1024 ** 3
BASE = Path('/etc/vortex-zram')
HELPER = Path('/usr/local/libexec/vortex-host-zram.py')
UNIT = Path('/etc/systemd/system/vortex-zram.service')
LOCK = Path('/run/vortex-os-maintenance.lock')
UUID = re.compile(r'^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$')
DEVICE = re.compile(r'^/dev/zram(0|[1-9][0-9]{0,5})$')
SERVICES = {'panel': 'bedrock-panel.service', 'worker': 'vortex-node.service'}
STABLE_DEVICE_FIELDS = ('path', 'enabled', 'logicalSizeBytes', 'residentLimitBytes', 'algorithm', 'priority')
MAX_SAFE_INTEGER = (1 << 53) - 1


class ZramError(Exception):
    def __init__(self, code, unknown=False):
        super().__init__(code)
        self.code, self.unknown = code, unknown


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def recommended_size(total):
    if not isinstance(total, int) or total < 256 * MIB:
        raise ZramError('ZRAM_UNAVAILABLE')
    return {'logicalSizeBytes': total // (2 * MIB) * MIB if total < 4 * GIB else 2 * GIB,
            'residentLimitBytes': min(total // (4 * MIB) * MIB, GIB)}


def safe_to_disable(available, used, total):
    return available >= used + max(256 * MIB, (total + 9) // 10)


def parse_mm_stat(text):
    """Kernel mm_stat byte counters, not swap slot usage or promised savings."""
    if not isinstance(text, str) or len(text) > 4096:
        raise ZramError('ZRAM_UNAVAILABLE')
    fields = text.split()
    if len(fields) < 4 or not all(re.fullmatch(r'[0-9]+', value) for value in fields):
        raise ZramError('ZRAM_UNAVAILABLE')
    values = [int(value) for value in fields[:4]]
    if any(value > MAX_SAFE_INTEGER for value in values):
        raise ZramError('ZRAM_UNAVAILABLE')
    return dict(zip(('originalDataBytes', 'compressedDataBytes', 'residentBytes', 'residentLimitBytes'), values))


def parse_swaps(text):
    """/proc/swaps Size/Used are logical KiB; no storage medium is assumed."""
    if not isinstance(text, str) or len(text) > 1024 * 1024:
        raise ZramError('ZRAM_UNAVAILABLE')
    lines = text.splitlines()
    if not lines or lines[0].split() != ['Filename', 'Type', 'Size', 'Used', 'Priority']:
        raise ZramError('ZRAM_UNAVAILABLE')
    rows = {}
    for line in lines[1:]:
        if not line.strip():
            continue
        fields = line.split()
        if (len(fields) != 5 or fields[0] in rows or fields[1] not in ('file', 'partition')
                or not all(re.fullmatch(r'[0-9]+', value) for value in fields[2:4])
                or not re.fullmatch(r'-?[0-9]+', fields[4])):
            raise ZramError('ZRAM_UNAVAILABLE')
        size, used, priority = int(fields[2]) * 1024, int(fields[3]) * 1024, int(fields[4])
        if not 0 <= used <= size <= MAX_SAFE_INTEGER or abs(priority) > MAX_SAFE_INTEGER:
            raise ZramError('ZRAM_UNAVAILABLE')
        rows[fields[0]] = {'size': size, 'used': used, 'priority': priority}
    return rows


def summarize_swaps(rows, classify):
    summary = {'source': '/proc/swaps', 'scope': 'host', 'totalBytes': 0, 'usedBytes': 0,
               **{kind: {'totalBytes': 0, 'usedBytes': 0, 'areas': 0} for kind in ('zram', 'other', 'unknown')}}
    for filename, row in rows.items():
        kind = classify(filename)
        if kind not in ('zram', 'other'):
            kind = 'unknown'
        bucket = summary[kind]
        bucket['totalBytes'] += row['size']
        bucket['usedBytes'] += row['used']
        bucket['areas'] += 1
        summary['totalBytes'] += row['size']
        summary['usedBytes'] += row['used']
    if summary['totalBytes'] > MAX_SAFE_INTEGER:
        raise ZramError('ZRAM_UNAVAILABLE')
    summary['complete'] = summary['unknown']['areas'] == 0
    return summary


def validate_request(value, mutate=False):
    allowed = {'role', 'nodeId'} | ({'enabled', 'profile', 'revision', 'requestId', 'confirmed'} if mutate else set())
    if not isinstance(value, dict) or set(value) - allowed or value.get('role') not in SERVICES:
        raise ZramError('ZRAM_INPUT')
    node = value.get('nodeId')
    if not isinstance(node, str) or not (node == 'local' and value['role'] == 'panel' or UUID.fullmatch(node)):
        raise ZramError('ZRAM_TARGET')
    if mutate and (type(value.get('enabled')) is not bool or value.get('profile') != 'auto'
                   or value.get('confirmed') is not True or not UUID.fullmatch(str(value.get('requestId', '')))
                   or not re.fullmatch(r'[a-f0-9]{64}', str(value.get('revision', '')))):
        raise ZramError('ZRAM_INPUT')
    return value


def regular(path, private=True):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & (0o077 if private else 0o022):
        raise ZramError('ZRAM_OWNERSHIP')
    return info


def read_json(path):
    regular(path)
    if path.stat().st_size > 65536:
        raise ZramError('ZRAM_OWNERSHIP')
    return json.loads(path.read_text())


def atomic_json(path, value):
    if path.exists() or path.is_symlink():
        regular(path)
    temp = path.parent / ('.' + path.name + '.' + str(uuid.uuid4()) + '.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp.unlink()


@contextlib.contextmanager
def maintenance_lock():
    import fcntl
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o077:
            raise ZramError('ZRAM_OWNERSHIP')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ZramError('ZRAM_BUSY')
        yield
    finally:
        os.close(fd)


class HostZram:
    def __init__(self, role, node_id):
        validate_request({'role': role, 'nodeId': node_id})
        self.role, self.node_id = role, node_id

    def command(self, executable, args, timeout=20):
        try:
            result = subprocess.run([executable] + args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout, check=False,
                                    env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
        except subprocess.TimeoutExpired:
            raise ZramError('ZRAM_UNKNOWN', True)
        if result.returncode:
            raise ZramError('ZRAM_SYSTEM')
        return result.stdout.decode(errors='replace')

    def memory(self):
        values = {m[1]: int(m[2]) * 1024 for m in re.finditer(r'^(MemTotal|MemAvailable):\s+(\d+)\s+kB$', Path('/proc/meminfo').read_text(), re.M)}
        if not 0 <= values.get('MemAvailable', -1) <= values.get('MemTotal', -2):
            raise ZramError('ZRAM_UNAVAILABLE')
        return values['MemTotal'], values['MemAvailable']

    def swaps(self):
        return parse_swaps(Path('/proc/swaps').read_text())

    def swap_kind(self, filename):
        try:
            # Resolve kernel block identity, not a zram-looking filename. This
            # also handles a device opened through a /dev/disk/... alias.
            filename = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), filename)
            info = Path(filename).stat()
            if stat.S_ISBLK(info.st_mode):
                block = (Path('/sys/dev/block') / f'{os.major(info.st_rdev)}:{os.minor(info.st_rdev)}').resolve(strict=True)
                return 'zram' if re.fullmatch(r'zram[0-9]+', block.name) else 'other'
            return 'other' if stat.S_ISREG(info.st_mode) else 'unknown'
        except (OSError, ValueError, RuntimeError):
            return 'unknown'

    def ensure_directory(self):
        if not BASE.exists():
            BASE.mkdir(mode=0o700)
        info = BASE.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise ZramError('ZRAM_OWNERSHIP')

    def owner(self):
        if not BASE.exists():
            return None
        self.ensure_directory()
        if not (BASE / 'owner.json').exists():
            if any(BASE.iterdir()):
                raise ZramError('ZRAM_OWNERSHIP')
            return None
        owner = read_json(BASE / 'owner.json')
        if owner.get('schema') != 1 or not UUID.fullmatch(str(owner.get('ownerId', ''))) or owner.get('role') != self.role or owner.get('nodeId') != self.node_id or owner.get('serviceId') != SERVICES[self.role]:
            raise ZramError('ZRAM_OWNERSHIP')
        return owner

    def config(self, owner):
        if not owner:
            return {'enabled': False, 'profile': 'auto'}
        value = read_json(BASE / 'config.json')
        if value.get('ownerId') != owner['ownerId'] or type(value.get('enabled')) is not bool or value.get('profile') != 'auto':
            raise ZramError('ZRAM_OWNERSHIP')
        return value

    def state(self, owner):
        if not owner or not (BASE / 'state.json').exists():
            return {}
        value = read_json(BASE / 'state.json')
        if value.get('ownerId') != owner['ownerId']:
            raise ZramError('ZRAM_OWNERSHIP')
        return value

    def device(self, owner, state, swaps):
        path = state.get('device')
        if not path:
            return None
        if not DEVICE.fullmatch(path) or state.get('bootId') != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
            return None
        info = Path(path).lstat()
        if not stat.S_ISBLK(info.st_mode) or info.st_rdev != state.get('rdev'):
            raise ZramError('ZRAM_OWNERSHIP')
        directory = Path('/sys/block') / Path(path).name
        sysinfo = directory.stat()
        if sysinfo.st_dev != state.get('sysfsDev') or sysinfo.st_ino != state.get('sysfsIno'):
            raise ZramError('ZRAM_OWNERSHIP')
        # The swap UUID is created only on our newly allocated device and must
        # still match before destructive operations; never trust index alone.
        try:
            observed = self.command('/usr/sbin/blkid', ['-p', '-s', 'UUID', '-o', 'value', path]).strip()
        except ZramError:
            # A newly allocated device may fail before mkswap. Its kernel
            # object identity plus boot ID are still ours, but it must not
            # have become an active swap device or acquired another UUID.
            if state.get('stage') != 'allocated' or path in swaps:
                raise
            observed = None
        if observed is not None and observed != state.get('swapUuid'):
            raise ZramError('ZRAM_OWNERSHIP')
        statistics = parse_mm_stat((directory / 'mm_stat').read_text())
        return {'path': path, 'enabled': path in swaps, 'logicalSizeBytes': int((directory / 'disksize').read_text()),
                'swapUsedBytes': swaps.get(path, {}).get('used', 0), **statistics,
                'algorithm': re.search(r'\[([^]]+)\]', (directory / 'comp_algorithm').read_text())[1],
                'priority': swaps.get(path, {}).get('priority', 100)}

    def foreign(self, own_device=None):
        configurations = []
        for parent in ['/etc/systemd', '/run/systemd', '/usr/lib/systemd', '/usr/local/lib/systemd']:
            configurations.extend(Path(parent).glob('zram-generator.conf'))
            configurations.extend(Path(parent).glob('zram-generator.conf.d/*.conf'))
        configurations.extend(p for p in [Path('/etc/default/zramswap'), Path('/etc/init.d/zram-config')] if p.exists())
        for parent in ['/etc/systemd/system', '/usr/lib/systemd/system']:
            configurations.extend(p for p in Path(parent).glob('*zram*') if p != UNIT and p.name != 'vortex-zram.service' and not p.name.endswith('.target.wants'))
        devices = []
        for path in Path('/sys/block').glob('zram[0-9]*'):
            if '/dev/' + path.name != own_device and int((path / 'disksize').read_text()) > 0:
                devices.append(path.name)
        return bool(configurations or devices)

    def inspect(self):
        total, available = self.memory()
        owner = self.owner()
        config, state, swaps = self.config(owner), self.state(owner), self.swaps()
        device = self.device(owner, state, swaps) if owner else None
        external = self.foreign(device['path'] if device else None)
        operation = state.get('operation')
        stable = {'ownerId': owner and owner['ownerId'], 'config': config,
                  # Usage is live telemetry. A read must not invalidate a
                  # reviewed configuration just because compression changed.
                  'device': {k: device[k] for k in STABLE_DEVICE_FIELDS if device and k in device},
                  'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'external': external}
        return {'available': os.geteuid() == 0 and not (external and not owner),
                'reasonCode': 'ZRAM_EXTERNAL' if external and not owner else None,
                'ownership': 'vortex' if owner else 'external' if external else 'none',
                'physicalMemoryBytes': total, 'physicalAvailableBytes': available,
                'configured': {'enabled': config['enabled'], 'profile': 'auto'},
                'effective': {k: v for k, v in (device or {'enabled': False, 'logicalSizeBytes': 0, 'swapUsedBytes': 0, 'originalDataBytes': 0, 'compressedDataBytes': 0, 'residentBytes': 0, 'residentLimitBytes': 0, 'algorithm': None, 'priority': 100}).items() if k != 'path'},
                'swapSummary': summarize_swaps(swaps, self.swap_kind),
                'observedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'recommended': recommended_size(total), 'revision': digest(stable), 'operation': operation,
                'ownerId': owner and owner['ownerId'], 'externalPresent': external}

    def unit_text(self, owner):
        return ('# Vortex owner: ' + owner['ownerId'] + '\n[Unit]\nDescription=Vortex system memory assistance\n'
                'After=systemd-modules-load.service local-fs.target\nBefore=bedrock-panel.service vortex-node.service\n'
                '[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/libexec/vortex-host-zram.py boot\n'
                'RemainAfterExit=yes\nTimeoutStartSec=30\n[Install]\nWantedBy=multi-user.target\n')

    def verify_unit(self, owner):
        regular(UNIT, private=False)
        if UNIT.read_text() != self.unit_text(owner):
            raise ZramError('ZRAM_OWNERSHIP')

    def begin_owner(self):
        self.ensure_directory()
        if UNIT.exists() or UNIT.is_symlink():
            raise ZramError('ZRAM_OWNERSHIP')
        regular(HELPER, private=False)
        owner = {'schema': 1, 'ownerId': str(uuid.uuid4()), 'role': self.role, 'nodeId': self.node_id,
                 'serviceId': SERVICES[self.role], 'createdAt': time.time(), 'provenance': 'created-by-vortex-zram-first-enable'}
        atomic_json(BASE / 'owner.json', owner)
        atomic_json(BASE / 'config.json', {'ownerId': owner['ownerId'], 'enabled': False, 'profile': 'auto'})
        fd = os.open(UNIT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'w') as stream:
            stream.write(self.unit_text(owner))
            stream.flush()
            os.fsync(stream.fileno())
        self.command('/usr/bin/systemctl', ['daemon-reload'])
        return owner

    def apply(self, request, lock_held=False):
        validate_request(request, True)
        if not lock_held:
            with maintenance_lock():
                return self.apply(request, True)
        before = self.inspect()
        if before['revision'] != request['revision']:
            raise ZramError('ZRAM_STALE')
        if not before['available']:
            raise ZramError(before['reasonCode'] or 'ZRAM_UNAVAILABLE')
        owner = self.owner()
        if not owner and not request['enabled']:
            return before
        if not owner:
            owner = self.begin_owner()
        self.verify_unit(owner)
        state, config = self.state(owner), self.config(owner)
        operation = {'requestId': request['requestId'], 'enabled': request['enabled'], 'status': 'running', 'requestedAt': time.time()}
        state.update(ownerId=owner['ownerId'], operation=operation)
        atomic_json(BASE / 'state.json', state)
        try:
            current = self.inspect()
            if request['enabled']:
                if current['effective']['enabled']:
                    if not config['enabled']:
                        raise ZramError('ZRAM_OWNERSHIP')
                    # Active devices are never resized or reinitialized.
                    self.command('/usr/bin/systemctl', ['enable', 'vortex-zram.service'])
                else:
                    if state.get('device') and state.get('bootId') == Path('/proc/sys/kernel/random/boot_id').read_text().strip():
                        raise ZramError('ZRAM_OWNERSHIP')
                    if self.foreign():
                        raise ZramError('ZRAM_EXTERNAL')
                    self.command('/usr/sbin/modprobe', ['--ignore-install', 'zram', 'num_devices=0'])
                    index = Path('/sys/class/zram-control/hot_add').read_text().strip()
                    if not re.fullmatch(r'0|[1-9][0-9]{0,5}', index):
                        raise ZramError('ZRAM_UNKNOWN', True)
                    device = '/dev/zram' + index
                    directory = Path('/sys/block/zram' + index)
                    # Device nodes can arrive just after hot_add through udev.
                    for attempt in range(30):
                        try:
                            info = Path(device).lstat()
                            break
                        except FileNotFoundError:
                            if attempt == 29:
                                raise ZramError('ZRAM_UNKNOWN', True)
                            time.sleep(0.1)
                    if not stat.S_ISBLK(info.st_mode) or int((directory / 'disksize').read_text()) != 0:
                        raise ZramError('ZRAM_OWNERSHIP')
                    swap_uuid = str(uuid.uuid4())
                    sysinfo = directory.stat()
                    state.update(device=device, rdev=info.st_rdev, swapUuid=swap_uuid, stage='allocated',
                                 sysfsDev=sysinfo.st_dev, sysfsIno=sysinfo.st_ino,
                                 bootId=Path('/proc/sys/kernel/random/boot_id').read_text().strip())
                    atomic_json(BASE / 'state.json', state)
                    algorithms = (directory / 'comp_algorithm').read_text().replace('[', '').replace(']', '').split()
                    algorithm = next((v for v in ['lz4', 'lzo-rle', 'lzo'] if v in algorithms), None)
                    if algorithm:
                        (directory / 'comp_algorithm').write_text(algorithm)
                    size = current['recommended']
                    (directory / 'mem_limit').write_text(str(size['residentLimitBytes']))
                    (directory / 'disksize').write_text(str(size['logicalSizeBytes']))
                    self.command('/usr/sbin/mkswap', ['--uuid', swap_uuid, '--label', 'vortex-zram', device])
                    state['stage'] = 'formatted'
                    atomic_json(BASE / 'state.json', state)
                    self.command('/usr/sbin/swapon', ['--priority', '100', device])
                    state['stage'] = 'active'
                    atomic_json(BASE / 'state.json', state)
                    config.update(enabled=True)
                    atomic_json(BASE / 'config.json', config)
                    self.command('/usr/bin/systemctl', ['enable', 'vortex-zram.service'])
            else:
                device = self.device(owner, state, self.swaps())
                if device:
                    total, available = self.memory()
                    if device['enabled'] and not safe_to_disable(available, device['swapUsedBytes'], total):
                        raise ZramError('ZRAM_PRESSURE')
                    if device['enabled']:
                        self.command('/usr/sbin/swapoff', [device['path']], timeout=120)
                    if device['path'] in self.swaps():
                        raise ZramError('ZRAM_UNKNOWN', True)
                    # Recheck identity after swapoff, before destructive reset.
                    self.device(owner, state, self.swaps())
                    self.command('/usr/sbin/zramctl', ['--reset', device['path']])
                    Path('/sys/class/zram-control/hot_remove').write_text(Path(device['path']).name[4:])
                    for key in ['device', 'rdev', 'swapUuid', 'bootId', 'stage', 'sysfsDev', 'sysfsIno']:
                        state.pop(key, None)
                config.update(enabled=False)
                atomic_json(BASE / 'config.json', config)
                self.command('/usr/bin/systemctl', ['disable', 'vortex-zram.service'])
            operation.update(status='completed', completedAt=time.time())
        except ZramError as error:
            operation.update(status='unknown' if error.unknown else 'failed', errorCode=error.code, completedAt=time.time())
            raise
        finally:
            atomic_json(BASE / 'state.json', state)
        return self.inspect()

    def cleanup_owned(self, lock_held=False):
        """Root uninstall integration. Caller may hold maintenance_lock already.

        No files are removed unless our exact device is drained and inactive.
        This never removes the shared helper, lock inode, packages or disk swap.
        """
        if not lock_held:
            with maintenance_lock():
                return self.cleanup_owned(True)
        owner = self.owner()
        if not owner:
            return {'removed': False, 'retainedExternal': True}
        before = self.inspect()
        self.apply({'role': self.role, 'nodeId': self.node_id, 'enabled': False, 'profile': 'auto',
                    'confirmed': True, 'revision': before['revision'], 'requestId': str(uuid.uuid4())}, True)
        self.verify_unit(owner)
        UNIT.unlink()
        for name in ['state.json', 'config.json', 'owner.json']:
            regular(BASE / name)
        for name in ['state.json', 'config.json', 'owner.json']:
            (BASE / name).unlink()
        BASE.rmdir()
        self.command('/usr/bin/systemctl', ['daemon-reload'])
        return {'removed': True, 'ownerId': owner['ownerId'], 'retainedExternal': True}


def inspect_owned(role, node_id, service_id):
    """Internal root uninstall hook; no mutation and no foreign adoption."""
    if SERVICES.get(role) != service_id:
        raise ZramError('ZRAM_TARGET')
    host = HostZram(role, node_id)
    try:
        owner = host.owner()
        if not owner:
            return {'present': False, 'owned': False, 'canCleanup': True, 'blockers': [], 'components': []}
        host.verify_unit(owner)
        value = host.inspect()
        total, available = host.memory()
        safe = not value['effective']['enabled'] or safe_to_disable(available, value['effective']['swapUsedBytes'], total)
        return {'present': True, 'owned': True, 'canCleanup': safe,
                'blockers': [] if safe else ['ZRAM_PRESSURE'], 'ownerId': owner['ownerId'],
                'components': [str(UNIT), str(BASE / 'owner.json'), str(BASE / 'config.json'), str(BASE / 'state.json')]}
    except (ZramError, OSError, ValueError):
        return {'present': BASE.exists() or UNIT.exists(), 'owned': False, 'canCleanup': False,
                'blockers': ['ZRAM_OWNERSHIP'], 'components': []}


def cleanup_owned(role, node_id, service_id, lock_held=False):
    if SERVICES.get(role) != service_id:
        raise ZramError('ZRAM_TARGET')
    result = HostZram(role, node_id).cleanup_owned(lock_held)
    return {'ok': True, 'removed': result['removed'], 'retained': ['foreign-zram', 'disk-swap', 'shared-helper', 'shared-lock']}


def main():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ZramError('ZRAM_UNAVAILABLE')
    if len(sys.argv) != 2 or sys.argv[1] not in ['inspect', 'apply', 'boot']:
        raise ZramError('ZRAM_INPUT')
    if sys.argv[1] == 'boot':
        owner = read_json(BASE / 'owner.json')
        host = HostZram(owner.get('role'), owner.get('nodeId'))
        before = host.inspect()
        if not before['configured']['enabled']:
            return before
        return host.apply({'role': host.role, 'nodeId': host.node_id, 'enabled': True, 'profile': 'auto',
                           'confirmed': True, 'requestId': str(uuid.uuid4()), 'revision': before['revision']})
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        raise ZramError('ZRAM_INPUT')
    request = validate_request(json.loads(raw), sys.argv[1] == 'apply')
    host = HostZram(request['role'], request['nodeId'])
    return host.inspect() if sys.argv[1] == 'inspect' else host.apply(request)


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'zram': main()}, separators=(',', ':')))
    except Exception as error:
        print(json.dumps({'ok': False, 'code': error.code if isinstance(error, ZramError) else 'ZRAM_UNKNOWN',
                          'outcomeUnknown': error.unknown if isinstance(error, ZramError) else True}, separators=(',', ':')))
        sys.exit(1)
