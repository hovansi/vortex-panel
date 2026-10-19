#!/usr/bin/env python3
"""Small, reversible network profile. No routes or live qdiscs are replaced."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

KEYS = ('net.core.rmem_max', 'net.core.wmem_max',
        'net.ipv4.tcp_congestion_control', 'net.core.default_qdisc')
BUFFER_FLOOR = 4 * 1024 * 1024
MAX_FILE = 256 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


class NetworkProfile:
    # All production paths are fixed; the command line never accepts a root path.
    def __init__(self, role, root=Path('/')):
        require(role in ('panel', 'worker'), 'NETWORK_INPUT')
        self.role = role
        self.root = Path(root)
        self.name = 'vortex-panel' if role == 'panel' else 'vortex-node'
        self.state = self.path('/etc/' + self.name + '/network-tuning.json')
        self.profile = self.path('/etc/sysctl.d/70-' + self.name + '-network.conf')

    def path(self, name):
        require(name.startswith('/') and '..' not in Path(name).parts, 'NETWORK_PATH')
        return self.root / name.lstrip('/')

    def trusted(self, path, directory=False, private=False):
        path = Path(path)
        require(path.is_relative_to(self.root), 'NETWORK_PATH')
        for item in [path, *path.parents]:
            if item == self.root.parent and self.root != Path('/'):
                break
            info = item.lstat()
            require(not stat.S_ISLNK(info.st_mode), 'NETWORK_OWNERSHIP')
            if self.root == Path('/'):
                require(info.st_uid == 0 and not info.st_mode & (0o077 if item == path and private else 0o022), 'NETWORK_OWNERSHIP')
            if item != path:
                require(stat.S_ISDIR(info.st_mode), 'NETWORK_OWNERSHIP')
            if item == self.root:
                break
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= MAX_FILE, 'NETWORK_OWNERSHIP')
        return info

    def read_text(self, path, private=False):
        self.trusted(path, private=private)
        return path.read_text(encoding='utf-8').strip()

    def atomic(self, path, content, private=False):
        self.trusted(path.parent, directory=True)
        if os.path.lexists(path):
            self.trusted(path, private=private)
        temp = path.parent / ('.vortex-network-' + uuid.uuid4().hex)
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600 if private else 0o644)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            if os.name == 'posix':
                fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        finally:
            if temp.exists():
                temp.unlink()

    def save(self, value):
        self.atomic(self.state, json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n', private=True)

    def machine(self):
        value = self.read_text(self.path('/etc/machine-id'))
        require(re.fullmatch('[a-f0-9]{32}', value), 'NETWORK_IDENTITY')
        return value

    def load(self):
        if not os.path.lexists(self.state):
            return None
        value = json.loads(self.read_text(self.state, private=True))
        require(value.get('schemaVersion') == 1 and value.get('role') == self.role and value.get('machineId') == self.machine()
                and value.get('status') in ('applying', 'applied', 'restoring', 'restored', 'failed')
                and isinstance(value.get('values'), dict) and set(value['values']).issubset(KEYS)
                and re.fullmatch('[a-f0-9]{64}', value.get('profileSHA256', '')), 'NETWORK_OWNERSHIP')
        for key, row in value['values'].items():
            require(set(row) == {'before', 'after'} and all(isinstance(v, str) and re.fullmatch('[a-zA-Z0-9_ -]{1,128}', v) for v in row.values()), 'NETWORK_OWNERSHIP')
        return value

    def read_key(self, key):
        require(key in KEYS or key == 'net.ipv4.tcp_available_congestion_control', 'NETWORK_KEY')
        try:
            return self.read_text(self.path('/proc/sys/' + key.replace('.', '/')))
        except FileNotFoundError:
            return None

    def write_key(self, key, value):
        require(key in KEYS, 'NETWORK_KEY')
        target = self.path('/proc/sys/' + key.replace('.', '/'))
        self.trusted(target)
        # /proc sysctl files require a direct write, not atomic replacement.
        with target.open('w', encoding='ascii') as stream:
            stream.write(value + '\n')
        require(self.read_key(key) == value, 'NETWORK_VERIFY')

    def overrides(self):
        result = set()
        # Explicit administrator and transient settings take precedence over
        # this optional profile. Distribution defaults are not adopted as ours.
        files = [self.path('/etc/sysctl.conf')]
        for folder in ['/etc/sysctl.d', '/run/sysctl.d']:
            directory = self.path(folder)
            if directory.exists():
                self.trusted(directory, directory=True)
                files += list(directory.glob('*.conf'))
        for file in files:
            if file == self.profile or not os.path.lexists(file):
                continue
            # /etc/sysctl.d/99-sysctl.conf commonly links /etc/sysctl.conf.
            # Read only this known alias; foreign symlinks are never followed.
            if file.is_symlink():
                if str(file.readlink()) in ('../sysctl.conf', '/etc/sysctl.conf'):
                    continue
                result.update(KEYS)
                continue
            text = self.read_text(file)
            for line in text.splitlines():
                match = re.match(r'^\s*-?\s*([a-zA-Z0-9_.\/]+)\s*=', line)
                if match:
                    key = match[1].replace('/', '.')
                    if key in KEYS:
                        result.add(key)
        return sorted(result)

    def body(self, values):
        return '# Managed by Vortex. Restore through the panel before editing.\n' + ''.join(key + ' = ' + row['after'] + '\n' for key, row in sorted(values.items()))

    def profile_matches(self, state):
        if not os.path.lexists(self.profile):
            return False
        self.trusted(self.profile)
        return hashlib.sha256(self.profile.read_bytes()).hexdigest() == state['profileSHA256']

    def inspect(self):
        current = {key: self.read_key(key) for key in KEYS}
        available = self.read_key('net.ipv4.tcp_available_congestion_control')
        state = self.load()
        exists = os.path.lexists(self.profile)
        profile_owned = bool(state and state['status'] != 'restored' and self.profile_matches(state))
        overrides = self.overrides()
        drift = [key for key, row in (state or {}).get('values', {}).items() if current[key] != row['after']] if state and state['status'] != 'restored' else []
        blockers = []
        if exists and not profile_owned:
            blockers.append('NETWORK_FOREIGN_PROFILE')
        if state and state['status'] in ('applying', 'restoring', 'failed'):
            blockers.append('NETWORK_RECOVERY')
        if state and state['status'] == 'applied' and not profile_owned:
            blockers.append('NETWORK_PROFILE_CHANGED')
        if drift:
            blockers.append('NETWORK_DRIFT')
        values = {}
        skipped = []
        for key in KEYS:
            value = current[key]
            target = None
            reason = None
            if key in overrides:
                reason = 'administrator-override'
            elif value is None:
                reason = 'kernel-unavailable'
            elif key.endswith(('rmem_max', 'wmem_max')):
                if value.isdigit() and int(value) < BUFFER_FLOOR:
                    target = str(BUFFER_FLOOR)
                else:
                    reason = 'sufficient-or-custom'
            elif key.endswith('tcp_congestion_control'):
                if 'bbr' not in (available or '').split():
                    reason = 'bbr-unavailable'
                elif value in ('cubic', 'reno'):
                    target = 'bbr'
                else:
                    reason = 'already-bbr-or-custom'
            elif key.endswith('default_qdisc'):
                bbr = current['net.ipv4.tcp_congestion_control'] == 'bbr' or values.get('net.ipv4.tcp_congestion_control', {}).get('after') == 'bbr'
                if bbr and value == 'pfifo_fast':
                    target = 'fq'
                else:
                    reason = 'existing-queue-preserved'
            if target is not None:
                values[key] = {'before': value, 'after': target}
            else:
                skipped.append({'key': key, 'reason': reason})
        owned = (state or {}).get('values', {}) if profile_owned else {}
        revision = digest([self.role, self.machine(), current, available, state, overrides, exists, profile_owned])
        return {'schemaVersion': 1, 'role': self.role, 'available': not blockers, 'enabled': profile_owned and state['status'] == 'applied',
                'status': (state or {}).get('status', 'unconfigured'), 'revision': revision,
                'current': current, 'availableCongestionControls': (available or '').split(),
                'changes': [{'key': key, **row} for key, row in values.items()], 'ownedValues': owned,
                'skipped': skipped, 'blockers': blockers, 'drift': drift,
                'canRestore': bool(profile_owned and state['status'] != 'restored'),
                'profilePath': '/etc/sysctl.d/70-' + self.name + '-network.conf',
                'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}

    def apply(self, revision):
        before = self.inspect()
        require(before['revision'] == revision, 'NETWORK_STALE')
        require(before['available'], before['blockers'][0] if before['blockers'] else 'NETWORK_UNAVAILABLE')
        if not before['changes']:
            return {**before, 'changed': False}
        original = self.load()
        values = dict(before['ownedValues'])
        values.update({row['key']: {'before': row['before'], 'after': row['after']} for row in before['changes']})
        content = self.body(values)
        state = {'schemaVersion': 1, 'role': self.role, 'machineId': self.machine(), 'status': 'applying', 'values': values,
                 'profileSHA256': hashlib.sha256(content.encode()).hexdigest()}
        previous_content = self.profile.read_text() if os.path.lexists(self.profile) else None
        self.save(state)  # Durable originals before the first system mutation.
        applied = []
        try:
            self.atomic(self.profile, content)
            for row in before['changes']:
                # Recheck each value against the reviewed plan, not a blind sysctl --system.
                require(self.read_key(row['key']) == row['before'], 'NETWORK_STALE')
                applied.append(row)
                self.write_key(row['key'], row['after'])
            state['status'] = 'applied'
            self.save(state)
        except Exception:
            rollback_ok = True
            for row in reversed(applied):
                try:
                    if self.read_key(row['key']) == row['after']:
                        self.write_key(row['key'], row['before'])
                except Exception:
                    rollback_ok = False
            try:
                if self.profile_matches(state):
                    if previous_content is None:
                        self.profile.unlink()
                    else:
                        self.atomic(self.profile, previous_content)
                else:
                    rollback_ok = False
                if rollback_ok:
                    if original:
                        self.save(original)
                    else:
                        self.state.unlink()
                else:
                    state['status'] = 'failed'
                    self.save(state)
            except Exception:
                pass  # Keep the pre-mutation durable recovery record.
            raise ValueError('NETWORK_APPLY_FAILED' if rollback_ok else 'NETWORK_RECOVERY')
        return {**self.inspect(), 'changed': True}

    def restore(self, revision=None):
        before = self.inspect()
        if revision is not None:
            require(before['revision'] == revision, 'NETWORK_STALE')
        state = self.load()
        if not state or state['status'] == 'restored':
            require(not os.path.lexists(self.profile), 'NETWORK_FOREIGN_PROFILE')
            return {**before, 'changed': False, 'restoredKeys': [], 'preservedKeys': []}
        require(self.profile_matches(state), 'NETWORK_PROFILE_CHANGED')
        state['status'] = 'restoring'
        self.save(state)
        restored, preserved = [], []
        administrator_values = self.overrides()
        for key, row in state['values'].items():
            if key not in administrator_values and self.read_key(key) == row['after']:
                self.write_key(key, row['before'])
                restored.append(key)
            else:
                preserved.append(key)
        # A user-modified profile is never removed, including a concurrent edit.
        require(self.profile_matches(state), 'NETWORK_PROFILE_CHANGED')
        self.profile.unlink()
        state['status'] = 'restored'
        self.save(state)
        return {**self.inspect(), 'changed': True, 'restoredKeys': restored, 'preservedKeys': preserved}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('inspect', 'plan', 'apply', 'restore', 'apply-auto', 'restore-owned'))
    parser.add_argument('--role', choices=('panel', 'worker'), required=True)
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0, 'NETWORK_UNAVAILABLE')
    import fcntl
    lock = '/run/vortex-network-' + args.role + '.lock'
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077, 'NETWORK_OWNERSHIP')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        profile = NetworkProfile(args.role)
        if args.action in ('inspect', 'plan'):
            result = profile.inspect()
        elif args.action == 'apply-auto':
            observed = profile.inspect()
            result = profile.apply(observed['revision'])
        elif args.action == 'restore-owned':
            result = profile.restore()
        else:
            raw = sys.stdin.read(16385)
            require(len(raw) <= 16384, 'NETWORK_INPUT')
            value = json.loads(raw or '{}')
            require(isinstance(value, dict) and set(value).issubset({'revision', 'confirmed'}) and value.get('confirmed') is True
                    and re.fullmatch('[a-f0-9]{64}', value.get('revision', '')), 'NETWORK_INPUT')
            result = profile.apply(value['revision']) if args.action == 'apply' else profile.restore(value['revision'])
        print(json.dumps({'ok': True, 'network': result}, separators=(',', ':')))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error) if re.fullmatch('NETWORK_[A-Z_]+', str(error)) else 'NETWORK_UNAVAILABLE'
        print(json.dumps({'ok': False, 'code': code}, separators=(',', ':')))
        raise SystemExit(1)
