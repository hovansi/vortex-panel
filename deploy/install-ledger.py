#!/usr/bin/env python3
"""Private installer evidence for conservative Vortex removal.

Capture MUST precede package, account and installation changes.  A missing old
baseline is never reconstructed from the current host.  This ledger grants no
authority to remove arbitrary paths; fleet-removal.py has its own fixed roots.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import uuid

NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
LAYOUT = {
    'panel': {'source': '/opt/vortex-panel', 'data': '/var/lib/vortex-panel', 'config': '/etc/vortex-panel', 'unit': 'vortex-panel.service', 'manifest': 'install-manifest.json'},
    'worker': {'source': '/opt/vortex-node', 'data': '/var/lib/vortex-node', 'config': '/etc/vortex-node', 'unit': 'vortex-node.service', 'manifest': 'install-ledger.json'},
}
EXTRA = ['/usr/local/libexec/vortex-host-zram.py', '/usr/local/libexec/vortex-application-isolation.py', '/etc/nginx/conf.d/vortex-panel.conf']
# These mutable components have feature-specific ownership journals and exact
# template/marker proofs. Capture their prior presence without adopting a file
# that a concurrent administrator may have created during installation.
MAINTENANCE_CAPTURE = ['/etc/sysctl.d/70-vortex-panel-network.conf', '/etc/sysctl.d/70-vortex-node-network.conf',
                       '/etc/systemd/system/vortex-panel-tls-renew.service', '/etc/systemd/system/vortex-panel-tls-renew.timer']
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$', re.I)
INSTALLER_PACKAGES = set('ca-certificates curl openssl unzip zip rsync xz-utils tar iproute2 procps coreutils findutils libc6 libgcc-s1 libstdc++6 libatomic1 zlib1g libcurl4 nftables ufw e2fsprogs util-linux bubblewrap python3 python3-venv kmod gcc make pkg-config libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev liblzma-dev libncurses-dev libgdbm-dev uuid-dev libzstd-dev nginx'.split())
# Optional shared access packages lack an exact per-APT transaction receipt;
# conservatively leave them unproven instead of adopting a concurrent install.
ROLE_PACKAGES = {'worker': INSTALLER_PACKAGES - {'nginx'},
                 'panel': set('ca-certificates curl unzip rsync xz-utils libcurl4 libstdc++6 libatomic1 nftables e2fsprogs util-linux bubblewrap python3 python3-venv kmod iproute2 gcc make pkg-config libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev liblzma-dev libncurses-dev libgdbm-dev uuid-dev libzstd-dev'.split())}


class EvidenceError(ValueError):
    pass


def require(condition, text):
    if not condition:
        raise EvidenceError(text)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    require(result.returncode == 0 and len(result.stdout) <= 32 * 1024 ** 2, 'Installer baseline inspection failed.')
    return result.stdout


def safe(path, directory=False, private=False):
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'Unsafe installer evidence path.')
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'Untrusted installer evidence ancestor.')
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & (0o077 if private else 0o022), 'Untrusted installer evidence.')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Invalid installer evidence type.')
    return info


def load(path):
    info = safe(path, private=True)
    require(info.st_size <= 48 * 1024 ** 2, 'Installer evidence exceeds bound.')
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    safe(path.parent, directory=True)
    if os.path.lexists(path):
        safe(path, private=True)
    temp = path.parent / ('.vortex-ledger-' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temp.exists():
            temp.unlink()


def machine():
    value = Path('/etc/machine-id').read_text().strip()
    require(re.fullmatch('[a-f0-9]{32}', value), 'Host identity is unavailable.')
    return value


def packages():
    manual = set(run(['apt-mark', 'showmanual']).splitlines())
    rows = []
    for line in run(['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${db:Status-Status}\n']).splitlines():
        fields = line.split('\t')
        require(len(fields) == 3, 'Package baseline is ambiguous.')
        if fields[2] == 'installed':
            rows.append({'name': fields[0], 'version': fields[1], 'manual': fields[0] in manual or fields[0].split(':')[0] in manual})
    return rows


def identity(path, content=True):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Special or hard-linked installer path.')
    row = {'path': str(path), 'kind': 'directory' if stat.S_ISDIR(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'file',
           'dev': info.st_dev, 'ino': info.st_ino, 'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}
    if row['kind'] == 'file' and content:
        require(info.st_size <= 256 * 1024 ** 2, 'Installer source exceeds hash bound.')
        with open(path, 'rb') as stream:
            hasher = hashlib.sha256()
            for block in iter(lambda: stream.read(1024 ** 2), b''):
                hasher.update(block)
            row['sha256'] = hasher.hexdigest()
    if row['kind'] == 'symlink':
        row['target'] = os.readlink(path)
    return row


def accounts():
    values = {}
    for name in ['vortex-panel', 'bedrock-panel']:
        result = subprocess.run(['getent', 'passwd', name], capture_output=True, text=True, timeout=10)
        require(result.returncode in [0, 2], 'Account baseline is unavailable.')
        values[name] = result.stdout.strip() or None
    return values


def capture(args):
    require(not os.path.lexists(args.capture_file) and not os.path.lexists(resume_file(args)), 'Previous installer evidence must be reviewed and explicitly resumed, never overwritten.')
    layout = LAYOUT[args.role]
    paths = [layout['source'], layout['data'], layout['config'], '/etc/systemd/system/' + layout['unit']]
    if args.role == 'panel':
        paths += ['/opt/bedrock-panel', '/var/lib/bedrock-panel', '/etc/bedrock-panel.env', '/etc/systemd/system/bedrock-panel.service', '/etc/vortex-panel.env']
    else:
        paths += ['/etc/vortex-node.json']
    paths += EXTRA + MAINTENANCE_CAPTURE
    before = {'paths': {path: identity(path) if os.path.lexists(path) else None for path in paths}, 'accounts': accounts(), 'services': {}}
    for unit in [layout['unit'], 'nginx.service']:
        before['services'][unit] = {key: subprocess.run(['systemctl', 'show', unit, '--property=' + key, '--value'], capture_output=True, text=True, timeout=15).stdout.strip() for key in ['LoadState', 'ActiveState', 'UnitFileState']}
    unknown = False
    try:
        before['packages'] = packages()
    except (ValueError, OSError, subprocess.SubprocessError):
        before['packages'] = []
        unknown = True
    if args.bootstrap_baseline:
        bootstrap = load(args.bootstrap_baseline)
        require(bootstrap.get('schemaVersion') == 1 and bootstrap.get('machineId') == machine(), 'Bootstrap baseline belongs to another host.')
        require(isinstance(bootstrap.get('packages'), list) and len(bootstrap['packages']) < 100000, 'Bootstrap package baseline is invalid.')
        for row in bootstrap['packages']:
            require(set(row) >= {'name', 'version', 'manual'} and re.fullmatch('[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?', row['name']) and isinstance(row['version'], str) and type(row['manual']) is bool, 'Invalid bootstrap package evidence.')
        before['packages'] = bootstrap['packages']
        unknown = bootstrap.get('baselineUnknown') is True
    existing = any(before['paths'][path] is not None for path in paths if path not in EXTRA + MAINTENANCE_CAPTURE)
    value = {'schemaVersion': 1, 'role': args.role, 'machineId': machine(), 'capturedAt': time.time(), 'packageBaselineKnown': not unknown, 'baselineUnknown': unknown or existing, 'freshInstall': not existing, 'before': before}
    write(args.capture_file, value)
    return {'ok': True, 'captureFile': args.capture_file, 'baselineUnknown': value['baselineUnknown']}


def validate_capture(args):
    value = load(args.capture_file)
    require(value.get('schemaVersion') == 1 and value.get('role') == args.role and value.get('machineId') == machine() and isinstance(value.get('before'), dict) and isinstance(value['before'].get('packages'), list), 'Preserved installer capture does not match this host.')
    require(re.fullmatch('[a-f0-9]{64}', args.capture_sha256 or '') and hashlib.sha256(Path(args.capture_file).read_bytes()).hexdigest() == args.capture_sha256, 'Preserved installer baseline differs from the operator-reviewed SHA-256.')
    return {'ok': True, 'captureFile': args.capture_file, 'captureSHA256': args.capture_sha256, 'baselinePreserved': True}


def resume_file(args):
    return '/run/vortex-install-ledger-' + args.role + '-resume.json'


def capture_resume(args):
    validated = validate_capture(args)
    baseline = load(args.capture_file)
    # A reviewed original capture does not establish who installed a package
    # or shared helper during the recovery gap. Attribute only changes made
    # after this retry's own snapshot; preserve the original baseline bytes.
    value = {'schemaVersion': 1, 'role': args.role, 'machineId': machine(), 'captureSHA256': args.capture_sha256,
             'capturedAt': time.time(), 'packages': packages(), 'accounts': accounts(),
             'paths': {path: identity(path) if os.path.lexists(path) else None for path in baseline['before']['paths']}}
    write(resume_file(args), value)
    return {**validated, 'resumeFile': resume_file(args), 'gapOwnershipAssumed': False}


def finalize(args):
    layout = LAYOUT[args.role]
    require(args.source_dir == layout['source'], 'Only a dedicated canonical source root can receive installer ownership.')
    data_path = Path(args.data_dir or '')
    require(data_path.is_absolute() and '..' not in data_path.parts and str(data_path) not in ['/', '/var', '/var/lib', '/opt', '/etc', '/home', '/root', '/usr', '/tmp'], 'Panel data root is not dedicated.')
    before = load(args.capture_file)
    require(before.get('schemaVersion') == 1 and before.get('role') == args.role and before.get('machineId') == machine(), 'Installer capture does not match this host.')
    transaction = before['before']
    resumed = None
    if os.path.lexists(resume_file(args)):
        resumed = load(resume_file(args))
        require(resumed.get('schemaVersion') == 1 and resumed.get('role') == args.role and resumed.get('machineId') == machine()
                and resumed.get('captureSHA256') == hashlib.sha256(Path(args.capture_file).read_bytes()).hexdigest()
                and isinstance(resumed.get('packages'), list) and isinstance(resumed.get('accounts'), dict) and isinstance(resumed.get('paths'), dict), 'Resume invocation evidence no longer matches its original capture.')
        transaction = resumed
    transaction_packages = {row['name']: row for row in transaction['packages']}
    transaction_accounts = transaction['accounts']
    transaction_packages_known = before.get('packageBaselineKnown') is True
    config = Path(layout['config'])
    if not config.exists():
        config.mkdir(mode=0o700)
    safe(config, directory=True)
    target = config / layout['manifest']
    previous = load(target) if target.exists() else None
    if previous:
        require(previous.get('schemaVersion') == 1 and previous.get('product') == ('vortex-panel' if args.role == 'panel' else 'vortex-node') and previous.get('machineId') == machine() and UUID.fullmatch(previous.get('installId', '')), 'Existing installer evidence belongs to another installation.')
        before = {key: previous[key] for key in ['before', 'freshInstall', 'baselineUnknown']}
    install_id = previous['installId'] if previous else str(uuid.uuid4())
    node_id = 'local' if args.role == 'panel' else json.loads(Path('/etc/vortex-node.json').read_text())['nodeId']
    require(node_id == 'local' or UUID.fullmatch(node_id), 'Invalid installed identity.')
    roots = {'source': identity(layout['source'], False), 'data': identity(args.data_dir, False), 'config': identity(layout['config'], False)}
    rows = {row['path']: row for row in (previous or {}).get('components', [])}
    def record(path, origin):
        row = identity(path)
        require(row['uid'] == 0 and (row['kind'] == 'symlink' or not row['mode'] & 0o022), 'Installed source ownership is unsafe.')
        row.update(createdByInstallId=install_id, existedBefore=False, origin=origin)
        rows[str(path)] = row
        require(len(rows) <= 150000, 'Installer evidence exceeds component bound.')
        if row['kind'] == 'directory':
            for child in sorted(Path(path).iterdir()):
                record(child, origin)
    source_before = before['before']['paths'].get(layout['source'])
    source = Path(layout['source'])
    # A new dedicated root is ours. On upgrades only previously recorded paths
    # or newly created release directories can gain source-file ownership.
    if source_before is None:
        record(source, 'installer-created-dedicated-source')
    else:
        current = source / 'current'
        if current.is_symlink():
            release = current.resolve(strict=True)
            require(release.parent == source / 'releases', 'Current release escaped the dedicated source root.')
            if not any(row.get('path') == str(release) for row in rows.values()):
                record(release, 'installer-created-release')
            record(current, 'installer-release-link')
    for path in EXTRA + ['/etc/systemd/system/' + layout['unit'], '/etc/vortex-panel.env' if args.role == 'panel' else '/etc/vortex-node.json']:
        if os.path.lexists(path) and (path in transaction['paths'] and transaction['paths'][path] is None or path in rows):
            record(path, 'installer-created-fixed-component')
    # The config directory can also hold its older worker manifest. Record only
    # files created in a fresh config root; an existing TLS/helper is not adopted.
    if before['before']['paths'].get(layout['config']) is None:
        for child in config.iterdir():
            if child != target:
                record(child, 'installer-created-configuration')
    now = packages()
    current_packages = {row['name']: row for row in now}
    old = {row['name']: row for row in before['before']['packages']}
    # An upgrade must never claim a foreign package added after the original
    # install. Only direct installer targets absent at THIS invocation's
    # capture can acquire new ownership. Original baseline stays immutable.
    introduced_map = {row['name']: row for row in (previous or {}).get('introduced', {}).get('packages', [])}
    unproven = [row['name'] for row in transaction_packages.values() if resumed and row['name'] not in old and row['name'] not in introduced_map]
    for row in now:
        if not transaction_packages_known or row['name'] in transaction_packages or row['name'] in old:
            continue
        if row['name'].split(':')[0] in ROLE_PACKAGES[args.role]:
            introduced_map.setdefault(row['name'], {**row, 'origin': 'installer-requested-and-absent-at-transaction-capture'})
        else:
            unproven.append(row['name'])
    introduced = list(introduced_map.values())
    manual_changes = {row['name']: row for row in (previous or {}).get('manualMarkChanges', [])}
    for row in now:
        name = row['name']
        if name not in old:
            continue
        if row['manual'] == old[name]['manual']:
            manual_changes.pop(name, None)
        elif (transaction_packages_known and name in transaction_packages and name.split(':')[0] in ROLE_PACKAGES[args.role]
              and transaction_packages[name]['manual'] != row['manual']):
            manual_changes[name] = {'name': name, 'beforeManual': old[name]['manual'], 'afterManual': row['manual'], 'afterVersion': row['version'],
                                    'origin': 'direct-installer-target-manual-mark-changed-in-captured-transaction'}
    service_account = (previous or {}).get('introduced', {}).get('serviceAccount')
    if args.role == 'panel':
        require(args.service_user in ['root', 'vortex-panel', 'bedrock-panel'], 'Unknown panel account.')
        account_name = args.service_user if args.service_user != 'root' else 'vortex-panel'
        account = accounts()[account_name]
        if service_account is None and account and not before['baselineUnknown'] and before['before']['accounts'].get(account_name) is None and transaction_accounts.get(account_name) is None:
            service_account = {'name': account_name, 'passwd': account, 'introduced': True}
    value = {'schemaVersion': 1, 'product': 'vortex-panel' if args.role == 'panel' else 'vortex-node', 'role': args.role,
             'installId': install_id, 'nodeId': node_id, 'machineId': machine(), 'freshInstall': before['freshInstall'],
             'baselineUnknown': before['baselineUnknown'], 'createdAt': (previous or {}).get('createdAt', time.time()), 'updatedAt': time.time(),
             'fullRemovalEligible': args.data_dir == layout['data'],
             'before': before['before'], 'roots': roots, 'components': list(rows.values()), 'introduced': {'packages': introduced, 'serviceAccount': service_account},
             'baselineChangedPackages': sorted(name for name, row in old.items() if name not in current_packages or current_packages[name]['version'] != row['version'])}
    value['unprovenNewPackages'] = sorted(set((previous or {}).get('unprovenNewPackages', [])) | set(unproven))
    value['manualMarkChanges'] = list(manual_changes.values())
    value['unknownManualMarkChanges'] = [row['name'] for row in now if row['name'] in old and row['manual'] != old[row['name']]['manual'] and row['name'] not in manual_changes]
    if resumed:
        value['recovery'] = {'originalCaptureSHA256': resumed['captureSHA256'], 'invocationCapturedAt': resumed['capturedAt'], 'gapOwnershipAssumed': False}
    write(target, value)
    Path(args.capture_file).unlink()
    if resumed:
        Path(resume_file(args)).unlink()
    return {'ok': True, 'manifest': str(target), 'installId': install_id, 'baselineUnknown': value['baselineUnknown']}



def failure_payload(error):
    value = {'ok': False, 'error': 'Private installer evidence could not be verified; baseline restoration was not claimed.'}
    # Only require() supplies a fixed source message. Other exception strings
    # can contain package output, paths or private file contents and stay hidden.
    if isinstance(error, EvidenceError):
        value['reason'] = str(error)
    else:
        value['category'] = ('filesystem' if isinstance(error, OSError) else
                             'command' if isinstance(error, subprocess.SubprocessError) else
                             'json' if isinstance(error, json.JSONDecodeError) else
                             'value' if isinstance(error, ValueError) else 'unexpected')
        trace = error.__traceback__
        while trace:
            if trace.tb_frame.f_code.co_filename == __file__:
                value['inspection'] = {'function': trace.tb_frame.f_code.co_name, 'line': trace.tb_lineno}
            trace = trace.tb_next
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['capture', 'finalize', 'validate-capture', 'capture-resume'])
    parser.add_argument('--role', required=True, choices=LAYOUT)
    parser.add_argument('--capture-file')
    parser.add_argument('--bootstrap-baseline')
    parser.add_argument('--capture-sha256')
    parser.add_argument('--source-dir')
    parser.add_argument('--data-dir')
    parser.add_argument('--service-user', default='root')
    args = parser.parse_args()
    require(os.name == 'posix' and os.geteuid() == 0, 'Installer evidence requires Linux root.')
    args.capture_file = args.capture_file or '/run/vortex-install-ledger-' + args.role + '.json'
    require(args.capture_file == '/run/vortex-install-ledger-' + args.role + '.json', 'Installer capture location is fixed.')
    print(json.dumps(capture(args) if args.operation == 'capture' else validate_capture(args) if args.operation == 'validate-capture' else capture_resume(args) if args.operation == 'capture-resume' else finalize(args), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(failure_payload(error)))
        raise SystemExit(1)
