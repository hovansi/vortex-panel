#!/usr/bin/env python3
"""Scoped native firewall persistence and uninstall verification.

Only Vortex's exact INPUT accept grammar is writable. Existing provider rules,
tables, policies, services and persistent-file ownership remain unchanged.
"""
import argparse
import contextlib
try:
    import fcntl
except ImportError:
    fcntl = None
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
OWNER = re.compile(r'^vortex:([a-f0-9]{16}):([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$')
SHA = re.compile(r'^[a-f0-9]{64}$')
SCOPE = re.compile(r'^[a-f0-9]{16}$')
MAX_FILE = 4 * 1024 * 1024
FAMILIES = {'ipv4': ('/etc/iptables/rules.v4', '/usr/sbin/iptables', '/usr/share/netfilter-persistent/plugins.d/15-ip4tables'),
            'ipv6': ('/etc/iptables/rules.v6', '/usr/sbin/ip6tables', '/usr/share/netfilter-persistent/plugins.d/25-ip6tables')}
REASON = 'Native firewall persistence is unavailable or requires manual review.'


class FirewallError(Exception):
    pass


def require(condition, message=REASON):
    if not condition:
        raise FirewallError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def execute(args, timeout=6, missing=False):
    require(os.name == 'posix' and isinstance(timeout, (int, float)) and 0 < timeout <= 30)
    require(all(hasattr(os, name) for name in ['waitid', 'P_PID', 'WEXITED', 'WNOHANG', 'WNOWAIT']) and signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL)
    process, selector = None, None
    identity_reserved = False
    output = bytearray()
    try:
        # A private process group lets timeout/output-limit cleanup reach a
        # command's children as well as its immediate process. No shell runs.
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   bufsize=0, close_fds=True, start_new_session=True,
                                   env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C'})
        identity_reserved = True
        selector = selectors.DefaultSelector()
        for stream, name, maximum in [(process.stdout, 'stdout', MAX_FILE), (process.stderr, 'stderr', 65536)]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, {'name': name, 'maximum': maximum, 'bytes': 0})
        deadline = time.monotonic() + timeout
        exit_code = None
        while selector.get_map() or exit_code is None:
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'Native firewall inspection timed out.')
            # WNOWAIT leaves even an exited leader unreaped: its PID/PGID
            # cannot be reused before the owned group has been cleaned up.
            try:
                status = os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                identity_reserved = False
                raise FirewallError('Native command ownership could not be verified.') from None
            if status is not None:
                exit_code = status.si_status if status.si_code == os.CLD_EXITED else -status.si_status
            if not selector.get_map():
                if exit_code is None:
                    time.sleep(min(remaining, 0.01))
                continue
            for key, _events in selector.select(min(remaining, 0.25)):
                state = key.data
                # Read only the remaining allowance plus one sentinel byte;
                # oversized output never enters an unbounded capture buffer.
                try:
                    chunk = os.read(key.fd, min(65536, state['maximum'] - state['bytes'] + 1))
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                state['bytes'] += len(chunk)
                require(state['bytes'] <= state['maximum'], 'Native firewall command output exceeded its bound.')
                if state['name'] == 'stdout':
                    output.extend(chunk)
        require(missing or exit_code == 0)
        return output.decode('utf-8').strip()
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            # Never signal a numeric group after reaping its leader. WNOWAIT
            # above reserves this child identity until after this group kill.
            if identity_reserved:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                raise FirewallError('Native firewall command cleanup could not be verified.') from None
            finally:
                for stream in [process.stdout, process.stderr]:
                    if stream is not None:
                        stream.close()


def valid_port(value):
    return isinstance(value, str) and bool(re.fullmatch(r'[1-9][0-9]{0,4}(?::[1-9][0-9]{0,4})?', value)) and all(1024 <= int(n) <= 65535 for n in value.split(':')) and int(value.split(':')[0]) <= int(value.split(':')[-1])


def rule_tokens(owner, protocol, port):
    require(OWNER.fullmatch(owner) and protocol in ['tcp', 'udp'] and valid_port(port))
    return ['-A', 'INPUT', '-p', protocol, '-m', protocol, '--dport', port, '-m', 'comment', '--comment', owner, '-j', 'ACCEPT']


def canonical_ufw(tokens, scope):
    """UFW owns its own input chains; its dedicated remover handles these."""
    if tokens[:2] not in [['-A', 'ufw-user-input'], ['-A', 'ufw6-user-input']]:
        return False
    values, modules = {}, []
    for index in range(2, len(tokens), 2):
        if index + 1 >= len(tokens):
            return False
        flag, value = tokens[index:index + 2]
        if flag == '-m':
            modules.append(value)
        elif flag in ['-p', '--dport', '-j', '--comment', '-s', '-d'] and flag not in values:
            values[flag] = value
        else:
            return False
    owner = OWNER.fullmatch(values.get('--comment', ''))
    protocol = values.get('-p')
    return bool(owner and owner[1] == scope and protocol in ['tcp', 'udp'] and valid_port(values.get('--dport'))
                and values.get('-j') == 'ACCEPT' and sorted(modules) == sorted([protocol, 'comment'])
                and all(values.get(flag) in [None, '0.0.0.0/0', '::/0'] for flag in ['-s', '-d']))


def parse_owned(line, scope):
    """Unknown rules sharing this installation's ownership tag fail closed."""
    require(SCOPE.fullmatch(scope))
    marker = 'vortex:' + scope + ':'
    if marker not in line:
        return None
    try:
        tokens = shlex.split(line, comments=False, posix=True)
    except ValueError:
        raise FirewallError() from None
    if canonical_ufw(tokens, scope):
        return None
    require(len(tokens) == 14 and tokens[10] == '--comment')
    owner = tokens[11]
    match = OWNER.fullmatch(owner)
    require(match and match[1] == scope and tokens == rule_tokens(owner, tokens[3], tokens[7]))
    return {'owner': owner, 'protocol': tokens[3], 'port': tokens[7]}


def parse_saved(raw, scope, require_layout=True):
    require(isinstance(raw, bytes) and len(raw) <= MAX_FILE and b'\x00' not in raw)
    try:
        lines = raw.decode('utf-8').splitlines(keepends=True)
    except UnicodeError:
        raise FirewallError() from None
    require(len(lines) <= 100000)
    table = None
    filter_start = filter_end = None
    first_rule = None
    input_seen = False
    rows = []
    for index, physical in enumerate(lines):
        line = physical.rstrip('\r\n')
        own = parse_owned(line, scope)
        if line.startswith('*'):
            require(table is None)
            table = line[1:]
            if table == 'filter':
                require(filter_start is None)
                filter_start = index
        elif line == 'COMMIT':
            require(table is not None)
            if table == 'filter':
                filter_end = index
            table = None
        elif table == 'filter':
            if line.startswith(':INPUT '):
                require(not input_seen and first_rule is None)
                input_seen = True
            if line.startswith('-') and first_rule is None:
                first_rule = index
        if own:
            require(table == 'filter' and filter_start is not None and input_seen)
            rows.append({**own, 'index': index})
    if not require_layout and not rows:
        # A foreign empty/other-table save file has no Vortex rules to remove.
        # Applying new rules still requires the complete filter layout below.
        return {'lines': lines, 'rows': [], 'insert': None}
    require(table is None and filter_start is not None and filter_end is not None and input_seen)
    return {'lines': lines, 'rows': rows, 'insert': first_rule if first_rule is not None else filter_end}


class NativeFirewall:
    def __init__(self, root=None, run=execute, enforce_owner=True):
        # Fixture injection is intentionally unavailable through the CLI.
        self.root = Path(root) if root else None
        self.run = run
        self.enforce_owner = enforce_owner

    def path(self, absolute):
        return self.root / absolute.lstrip('/') if self.root else Path(absolute)

    def safe(self, filename, directory=False):
        filename = Path(filename)
        require(filename.is_absolute() and '..' not in filename.parts)
        for parent in reversed(filename.parents):
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode))
            require(not self.enforce_owner or info.st_uid == 0 and not info.st_mode & 0o022)
        info = filename.lstat()
        require(not stat.S_ISLNK(info.st_mode) and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1))
        require(not self.enforce_owner or info.st_uid == 0 and not info.st_mode & 0o022)
        return info

    @staticmethod
    def metadata(info):
        return {'dev': info.st_dev, 'ino': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                'bytes': info.st_size, 'mtimeNs': info.st_mtime_ns, 'ctimeNs': info.st_ctime_ns}

    def read(self, filename):
        before = self.safe(filename)
        require(before.st_size <= MAX_FILE)
        fd = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            require(self.metadata(os.fstat(fd)) == self.metadata(before))
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(MAX_FILE + 1)
            require(len(raw) <= MAX_FILE and self.metadata(os.fstat(fd)) == self.metadata(before))
            require(self.metadata(self.safe(filename)) == self.metadata(before))
        finally:
            os.close(fd)
        return {'stamp': {**self.metadata(before), 'sha256': hashlib.sha256(raw).hexdigest()}, 'raw': raw}

    def saved(self, scope, required=True):
        result = {}
        for family, (filename, _tool, _plugin) in FAMILIES.items():
            path = self.path(filename)
            if not os.path.lexists(path) and not required:
                result[family] = None
                continue
            value = self.read(path)
            value['parsed'] = parse_saved(value['raw'], scope, require_layout=required)
            result[family] = value
        return result

    def persistent_identity(self, scope):
        files = self.saved(scope)
        fields = self.run(['/usr/bin/systemctl', 'show', 'netfilter-persistent.service', '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,ExecStart'], timeout=6)
        status = dict(line.split('=', 1) for line in fields.splitlines() if '=' in line)
        require(status.get('LoadState') == 'loaded' and status.get('ActiveState') == 'active' and status.get('SubState') == 'exited' and status.get('UnitFileState') == 'enabled')
        fragment = status.get('FragmentPath')
        require(fragment in ['/lib/systemd/system/netfilter-persistent.service', '/usr/lib/systemd/system/netfilter-persistent.service', '/etc/systemd/system/netfilter-persistent.service'])
        # /lib is a distribution-managed symlink on usr-merged Ubuntu. Resolve
        # this fixed unit path before checking its root-owned real ancestors.
        unit = self.read(self.path(fragment).resolve(strict=True))
        require('path=/usr/sbin/netfilter-persistent' in status.get('ExecStart', '') and 'argv[]=/usr/sbin/netfilter-persistent start' in status['ExecStart'])
        plugins = {}
        for family, (_filename, _tool, plugin) in FAMILIES.items():
            value = self.read(self.path(plugin))
            require(value['stamp']['mode'] & 0o111)
            plugins[family] = value['stamp']
        stable_status = {key: status[key] for key in ['LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath']}
        return files, {'files': {family: value['stamp'] for family, value in files.items()}, 'service': stable_status, 'unit': unit['stamp'], 'plugins': plugins}

    def owner_state(self, owner):
        match = OWNER.fullmatch(owner or '')
        require(match)
        files, identity = self.persistent_identity(match[1])
        rows = [{key: row[key] for key in ['protocol', 'port']} | {'family': family} for family, value in files.items() for row in value['parsed']['rows'] if row['owner'] == owner]
        return files, {'schemaVersion': 1, 'owner': owner, 'revision': digest({'owner': owner, **identity}), 'ready': True, 'rules': rows}

    def inspect_owner(self, owner):
        require(OWNER.fullmatch(owner or ''))
        try:
            return self.owner_state(owner)[1]
        except (OSError, FirewallError, subprocess.SubprocessError, ValueError):
            return {'schemaVersion': 1, 'owner': owner, 'revision': digest({'owner': owner, 'unavailable': True}), 'ready': False, 'rules': [], 'reason': REASON}

    @contextlib.contextmanager
    def lock(self):
        require(fcntl is not None, 'Native firewall changes require Linux file locking.')
        filename = self.path('/run/vortex-native-firewall.lock')
        self.safe(filename.parent, directory=True)
        fd = os.open(filename, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (not self.enforce_owner or info.st_uid == 0 and not info.st_mode & 0o077))
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise FirewallError('Another native firewall operation is running.') from None
            yield
        finally:
            os.close(fd)

    def replace(self, family, before, raw):
        filename = self.path(FAMILIES[family][0])
        require(self.read(filename)['stamp'] == before['stamp'], 'Persistent firewall policy changed; refresh the preview.')
        temporary = filename.parent / ('.vortex-firewall-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            with os.fdopen(fd, 'wb') as stream:
                if os.name != 'nt':
                    os.fchown(stream.fileno(), before['stamp']['uid'], before['stamp']['gid'])
                os.fchmod(stream.fileno(), before['stamp']['mode'])
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            require(self.read(filename)['stamp'] == before['stamp'], 'Persistent firewall policy changed; the original file was preserved.')
            os.replace(temporary, filename)
            if os.name != 'nt':
                directory = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()

    def rewrite(self, value, selected, desired):
        parsed = value['parsed']
        removed = {row['index'] for row in parsed['rows'] if selected(row['owner'])}
        output = []
        for index, line in enumerate(parsed['lines']):
            if index == parsed['insert']:
                for row in desired:
                    rule_tokens(row['owner'], row['protocol'], row['port'])
                    output.append(f'-A INPUT -p {row["protocol"]} -m {row["protocol"]} --dport {row["port"]} -m comment --comment "{row["owner"]}" -j ACCEPT\n')
            if index not in removed:
                output.append(line)
        return ''.join(output).encode('utf-8')

    def sync_owner(self, owner, revision, rules):
        require(OWNER.fullmatch(owner or '') and SHA.fullmatch(revision or '') and isinstance(rules, list) and len(rules) <= 258)
        desired = []
        for row in rules:
            require(isinstance(row, dict) and set(row) == {'family', 'protocol', 'port'} and row['family'] in FAMILIES)
            rule_tokens(owner, row['protocol'], row['port'])
            desired.append({**row, 'owner': owner})
        require(len({(row['family'], row['protocol'], row['port']) for row in desired}) == len(desired))
        with self.lock():
            files, state = self.owner_state(owner)
            require(state['revision'] == revision, 'Persistent firewall policy changed; refresh the preview.')
            changed = False
            for family, before in files.items():
                raw = self.rewrite(before, lambda value: value == owner, [row for row in desired if row['family'] == family])
                if raw != before['raw']:
                    self.replace(family, before, raw)
                    changed = True
            result = self.inspect_owner(owner)
            require(result['ready'])
            require(sorted(result['rules'], key=lambda row: (row['family'], row['protocol'], row['port'])) == sorted(rules, key=lambda row: (row['family'], row['protocol'], row['port'])))
            return {**result, 'changed': changed}

    def live(self, scope):
        result = {}
        for family, (_filename, tool, _plugin) in FAMILIES.items():
            if self.root is None and not os.path.exists(tool):
                raise FirewallError('Native firewall inspection is unavailable; kernel rule absence was not inferred.')
            # -S has no traffic counters or generated timestamps. Inspect the
            # complete filter table so an unfamiliar tagged chain fails closed.
            raw = self.run([tool, '-w', '5', '-t', 'filter', '-S'], timeout=8)
            require(isinstance(raw, str) and len(raw.encode()) <= MAX_FILE)
            rows = [row for line in raw.splitlines() if (row := parse_owned(line, scope))]
            require(len(rows) <= 4096)
            result[family] = {'available': True, 'raw': raw, 'rows': rows}
        return result

    def inspect_scope(self, scope):
        require(SCOPE.fullmatch(scope or ''))
        files, live = self.saved(scope, required=False), self.live(scope)
        rows = []
        for family in FAMILIES:
            for row in live[family]['rows']:
                rows.append({**row, 'family': family, 'location': 'live'})
            if files[family]:
                for row in files[family]['parsed']['rows']:
                    rows.append({**{key: row[key] for key in ['owner', 'protocol', 'port']}, 'family': family, 'location': 'saved'})
        identity = {'files': {family: value['stamp'] if value else None for family, value in files.items()}, 'live': live}
        return {'schemaVersion': 1, 'scope': scope, 'revision': digest({'scope': scope, **identity}), 'rules': rows}

    def cleanup_scope(self, scope, expected):
        require(isinstance(expected, dict) and expected.get('schemaVersion') == 1 and expected.get('scope') == scope and SHA.fullmatch(expected.get('revision', '')))
        with self.lock():
            current = self.inspect_scope(scope)
            require(current == expected, 'Native firewall policy changed before cleanup; no rules were removed.')
            files = self.saved(scope, required=False)
            # Persist removal first so interruption cannot restore removed
            # live rules on the next boot. Only exact scoped lines are edited.
            for family, before in files.items():
                if before:
                    raw = self.rewrite(before, lambda _owner: True, [])
                    if raw != before['raw']:
                        self.replace(family, before, raw)
            for family, (_filename, tool, _plugin) in FAMILIES.items():
                for row in [value for value in current['rules'] if value['family'] == family and value['location'] == 'live']:
                    self.run([tool, '-w', '5', '-t', 'filter', '-D', *rule_tokens(row['owner'], row['protocol'], row['port'])[1:]], timeout=8)
            result = self.inspect_scope(scope)
            require(not result['rules'], 'An owned native firewall rule remains; cleanup was not inferred.')
            return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['inspect', 'sync'])
    parser.add_argument('--owner', required=True)
    parser.add_argument('--expected-revision')
    parser.add_argument('--rules')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0)
    controller = NativeFirewall()
    if args.command == 'inspect':
        require(args.expected_revision is None and args.rules is None)
        result = controller.inspect_owner(args.owner)
    else:
        require(isinstance(args.rules, str) and len(args.rules) <= 65536)
        result = controller.sync_owner(args.owner, args.expected_revision, json.loads(args.rules))
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'Native firewall operation could not be verified. Inspect the current rules before retrying.'}))
        sys.exit(1)
