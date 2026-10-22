#!/usr/bin/env python3
"""Source-only Vortex update. Never installs packages or changes managed data/configuration."""
import argparse
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shutil
import ssl
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
try:
    import fcntl
except ImportError:
    fcntl = None
sys.dont_write_bytecode = True

REPOSITORY = 'hovansi/vortex-panel'
API = 'https://api.github.com/repos/' + REPOSITORY + '/releases/'
UUID = re.compile(r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$', re.I)
VERSION = re.compile(r'^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$')
SHA = re.compile(r'^[a-f0-9]{64}$')
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_SOURCE = 256 * 1024 * 1024
MAX_MEMBER = 4 * 1024 * 1024
BEDROCK_MEMBERS = {'deploy/bedrock-box64-arm64.tar.xz': 16 * 1024 * 1024,
                   'deploy/bedrock-box64-arm64.json': 64 * 1024}
ROLES = {'panel': ('/opt/vortex-panel', '/etc/vortex-panel.env', 'vortex-panel.service', 'server/index.js'), 'worker': ('/opt/vortex-node', '/etc/vortex-node.json', 'vortex-node.service', 'server/node-cli.js')}


class UpdateError(Exception):
    pass


def require(value, message):
    if not value:
        raise UpdateError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def file_digest(filename):
    h = hashlib.sha256()
    with open(filename, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def run(args, timeout=45, allow_failure=False, cwd=None, env=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env or {**os.environ, 'LC_ALL': 'C', 'LANG': 'C'})
    require(len(result.stdout) + len(result.stderr) <= 8 * 1024 * 1024, 'Host command output exceeds its safe bound.')
    require(allow_failure or result.returncode == 0, 'A fixed update command failed. Review the private update log.')
    return result


def safe_name(value):
    require(isinstance(value, str) and 0 < len(value) <= 512 and '\\' not in value and not any(ord(char) < 32 or ord(char) == 127 for char in value) and not value.startswith('/') and all(part not in ('', '.', '..') for part in value.split('/')), 'Unsafe release path.')
    require(not value.startswith(('node_modules/', 'data/', 'output/', 'test/', '.git/')) and value not in ('.env',), 'Release contains private or generated files.')
    return value


def version_tuple(value):
    require(isinstance(value, str) and VERSION.fullmatch(value), 'A stable semantic version is required.')
    return tuple(int(part) for part in value.split('.'))


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname in ('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com') and parsed.port in (None, 443) and not parsed.username and not parsed.password and not parsed.fragment, 'Release download left the official HTTPS origin allowlist.')


def fetch(url, maximum, expected_size=None):
    validate_url(url)
    context = ssl.create_default_context(); context.minimum_version = ssl.TLSVersion.TLSv1_2
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), ReleaseRedirect(), urllib.request.HTTPSHandler(context=context))
    request = urllib.request.Request(url, headers={'User-Agent': 'Vortex-Panel-Updater', 'Accept': 'application/vnd.github+json' if url.startswith(API) else 'application/octet-stream'})
    with opener.open(request, timeout=45) as response:
        validate_url(response.url)
        length = response.headers.get('Content-Length')
        require(length is None or int(length) <= maximum, 'Release response exceeds its safe bound.')
        data = response.read(maximum + 1)
        require(len(data) <= maximum and (expected_size is None or len(data) == expected_size), 'Release download is truncated or oversized.')
        return data


def release_metadata(version):
    version_tuple(version)
    release = json.loads(fetch(API + 'tags/v' + version, 2 * 1024 * 1024))
    require(release.get('tag_name') == 'v' + version and release.get('draft') is False and release.get('prerelease') is False and release.get('html_url') == 'https://github.com/' + REPOSITORY + '/releases/tag/v' + version, 'Release identity is not a published official stable release.')
    names = ['vortex-panel-' + version + '.zip', 'release-manifest.json', 'SHA256SUMS', 'install.sh']
    assets = release.get('assets')
    require(isinstance(assets, list) and len(assets) <= 30, 'Invalid release assets.')
    result = {}
    for name in names:
        matches = [row for row in assets if row.get('name') == name]
        require(len(matches) == 1, 'A required release asset is missing or duplicated.')
        row = matches[0]
        require(row.get('state') == 'uploaded' and row.get('browser_download_url') == 'https://github.com/' + REPOSITORY + '/releases/download/v' + version + '/' + name and isinstance(row.get('size'), int) and 0 < row['size'] <= MAX_ARCHIVE and re.fullmatch(r'sha256:[a-f0-9]{64}', row.get('digest') or ''), 'Release asset identity or publisher digest is invalid.')
        result[name] = {'url': row['browser_download_url'], 'bytes': row['size'], 'sha256': row['digest'][7:]}
    return result


def asset_bytes(row, maximum):
    data = fetch(row['url'], maximum, row['bytes'])
    require(hashlib.sha256(data).hexdigest() == row['sha256'], 'Release publisher SHA-256 verification failed.')
    return data


def inspect_manifest(data, version, assets):
    value = json.loads(data)
    require(value.get('schema') == 1 and value.get('name') == 'vortex-panel' and value.get('version') == version and value.get('repository') == REPOSITORY and value.get('tag') == 'v' + version, 'Manifest belongs to a different release.')
    archive = value.get('archive', {})
    name = 'vortex-panel-' + version + '.zip'
    require(archive == {'name': name, 'bytes': assets[name]['bytes'], 'sha256': assets[name]['sha256']}, 'Archive and publisher manifest disagree.')
    rows = value.get('inventory')
    require(isinstance(rows, list) and 1 <= len(rows) <= 3000 and value.get('sourceFiles') == len(rows), 'Release inventory is missing or oversized.')
    names = set()
    for row in rows:
        require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256', 'mode'}, 'Release inventory schema changed.')
        name = safe_name(row['path'])
        member_limit = BEDROCK_MEMBERS.get(name, MAX_MEMBER)
        require(name not in names and type(row['bytes']) is int and 0 <= row['bytes'] <= member_limit and isinstance(row['sha256'], str) and SHA.fullmatch(row['sha256']) and row['mode'] in (0o100644, 0o100755), 'Invalid release inventory member.')
        names.add(name)
    require(not names.intersection(BEDROCK_MEMBERS) or set(BEDROCK_MEMBERS) <= names, 'Release contains an incomplete Bedrock runtime bundle.')
    require(sum(row['bytes'] for row in rows) <= MAX_SOURCE and {'package.json', 'package-lock.json', 'server/index.js', 'server/node-cli.js', 'server/node-runtime.js'} <= names, 'Release source is incomplete or oversized.')
    return value


def worker_files(text, inventory):
    match = re.search(r'export const NODE_RUNTIME_FILES = Object\.freeze\(\[(.*?)\]\);', text, re.S)
    require(match, 'Worker source inventory is not a static explicit list.')
    body = re.sub(r'//[^\n]*', '', match.group(1))
    files = re.findall(r"'([^']+)'", body)
    require(re.sub(r"'[^']+'|[\s,]", '', body) == '' and len(files) == len(set(files)) and {'package.json', 'package-lock.json', 'server/node-cli.js', 'server/node-runtime.js'} <= set(files) and all(safe_name(name) in inventory for name in files), 'Worker source inventory is invalid.')
    return set(files)


def unpack(archive, destination, manifest, role):
    require(not destination.exists(), 'Update source stage already exists.')
    inventory = {row['path']: row for row in manifest['inventory']}
    with zipfile.ZipFile(archive) as stream:
        members = stream.infolist()
        require(len(members) == len(inventory) and {member.filename for member in members} == set(inventory), 'Archive inventory differs from its manifest.')
        for member in members:
            row = inventory[member.filename]
            require(safe_name(member.filename) == member.filename and member.create_system == 3 and member.external_attr >> 16 == row['mode'] and member.file_size == row['bytes'] and not member.flag_bits & 1 and not member.is_dir(), 'Unsafe ZIP source member.')
        os.mkdir(destination, 0o755)
        for member in members:
            row = inventory[member.filename]
            data = stream.read(member)
            require(len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256'], 'Source file SHA-256 differs from its manifest.')
            target = destination / member.filename
            target.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, row['mode'] & 0o777)
            with os.fdopen(fd, 'wb') as output:
                output.write(data)
        package = json.loads((destination / 'package.json').read_text())
        lock = json.loads((destination / 'package-lock.json').read_text())
        require(package.get('name') == 'vortex-panel' and package.get('version') == manifest['version'] and lock.get('version') == manifest['version'] and lock.get('packages', {}).get('', {}).get('version') == manifest['version'], 'Package metadata differs from the release.')
        if role == 'worker':
            # The public worker list is a static string array. Never execute the
            # downloaded module as root simply to discover which files to copy.
            files = worker_files((destination / 'server/node-runtime.js').read_text(), inventory)
            for name in inventory:
                if name not in files:
                    (destination / name).unlink()
            for root, directories, names in os.walk(destination, topdown=False):
                if not directories and not names and pathlib.Path(root) != destination:
                    pathlib.Path(root).rmdir()


class Host:
    def __init__(self, role, node_id, root=None, execute=run, enforce_owner=True):
        require(role in ROLES and (node_id == 'local' if role == 'panel' else bool(UUID.fullmatch(node_id or ''))), 'Invalid fixed update role or identity.')
        self.role, self.node_id, self.root, self.run, self.enforce_owner = role, node_id, pathlib.Path(root) if root else None, execute, enforce_owner
        install, config, self.unit, self.entry = ROLES[role]
        self.install, self.config = self.path(install), self.path(config)
        self.base = self.install / 'updates'

    def path(self, name):
        return self.root / name.lstrip('/') if self.root else pathlib.Path(name)

    def safe(self, filename, directory=False, private=False):
        filename = pathlib.Path(filename)
        for parent in reversed(filename.parents):
            info = parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink() and (not self.enforce_owner or info.st_uid == 0 and not info.st_mode & 0o022), 'An update ancestor is linked or writable by another user.')
        info = filename.lstat()
        require(not filename.is_symlink() and (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1) and (not self.enforce_owner or info.st_uid == 0 and not info.st_mode & (0o077 if private else 0o022)), 'An update path is not exclusively trusted.')
        return info

    def read(self, filename, maximum=16 * 1024 * 1024, private=False):
        info = self.safe(filename, private=private)
        require(info.st_size <= maximum, 'An update input exceeds its safe bound.')
        return filename.read_bytes()

    def machine(self):
        value = self.read(self.path('/etc/machine-id'), 1024).decode().strip()
        require(re.fullmatch(r'[a-f0-9]{32}', value), 'Invalid machine identity.')
        return value

    def atomic(self, filename, value):
        temporary = filename.with_name(filename.name + '.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(value, stream, sort_keys=True); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
            os.replace(temporary, filename)
        finally:
            if temporary.exists():
                temporary.unlink()

    def config_info(self):
        raw = self.read(self.config, 1024 * 1024, private=True)
        if self.role == 'worker':
            value = json.loads(raw)
            require(value.get('nodeId') == self.node_id and isinstance(value.get('token'), str) and 43 <= len(value['token']) <= 256, 'SSH installation does not match the linked worker.')
            data = value.get('dataDir')
            token_hash = hashlib.sha256(value['token'].encode()).hexdigest()
        else:
            text = raw.decode()
            values = re.findall(r'^DATA_DIR=([^\r\n]+)$', text, re.M)
            require(len(values) == 1, 'Panel data directory is not explicitly configured.')
            data = values[0]
            if len(data) >= 2 and data[0] == data[-1] and data[0] in ('"', "'"):
                data = data[1:-1]
            token_hash = None
        require(isinstance(data, str) and data.startswith('/') and not any(c in data for c in ('\x00', '\n', '\\')) and pathlib.PurePosixPath(data).as_posix() == data and data not in ('/', '/var', '/var/lib', '/opt', '/etc', '/run', '/root', '/home', '/tmp', '/var/tmp'), 'Update requires a dedicated absolute data root.')
        data = self.path(data)
        self.safe(data, directory=True)
        store = json.loads(self.read(data / 'panel.json', 64 * 1024 * 1024, private=True))
        require(isinstance(store, dict) and isinstance(store.get('servers'), list) and isinstance(store.get('jobs'), list), 'Managed store schema is invalid.')
        return raw, data, store, token_hash

    def service(self):
        result = self.run(['/usr/bin/systemctl', 'show', self.unit, '--property=MainPID,ActiveState,SubState,User,Group,FragmentPath,ExecStart', '--no-pager']).stdout
        values = dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
        require(values.get('User', '') in ('', 'root') and values.get('Group', '') in ('', 'root') and values.get('FragmentPath') == '/etc/systemd/system/' + self.unit, 'Source update requires the canonical managed root service.')
        require(values.get('ActiveState') == 'active' and values.get('SubState') == 'running' and re.fullmatch(r'[1-9][0-9]*', values.get('MainPID', '')), 'The managed service is not running.')
        require(str(pathlib.PurePosixPath(ROLES[self.role][0]) / 'current' / self.entry) in values.get('ExecStart', ''), 'The managed service uses a custom entry point.')
        return values, int(values['MainPID'])

    def inspect(self):
        self.safe(self.install, directory=True)
        self.safe(self.install / 'releases', directory=True)
        link = self.install / 'current'
        require(link.is_symlink(), 'Managed current release must be a symlink.')
        source = link.resolve(strict=True)
        require(source.parent == self.install / 'releases', 'Current source is outside the managed release root.')
        self.safe(source, directory=True)
        package_bytes = self.read(source / 'package.json')
        version = json.loads(package_bytes).get('version'); version_tuple(version)
        raw_config, data, store, token_hash = self.config_info()
        unit_bytes = self.read(self.path('/etc/systemd/system/' + self.unit), 1024 * 1024)
        service, pid = self.service()
        active = [row.get('id') for row in store['servers'] if row.get('status') not in ('stopped', 'error') or row.get('resumeOnPanelStart') or row.get('jobId') or row.get('cloneJobId')]
        jobs = [row.get('id') for row in store['jobs'] if row.get('status') in ('queued', 'running')]
        blockers = []
        entry_text = self.read(source / ('server/node-agent.js' if self.role == 'worker' else self.entry)).decode('utf-8')
        if not (source / 'server/panel-update.js').is_file() or 'createPanelUpdateIntentProbe' not in entry_text:
            blockers.append({'code': 'UPDATE_PROTOCOL_REQUIRED', 'message': 'This legacy installation needs a one-time maintenance upgrade before safe one-click updates; its running workloads were not stopped.'})
        if active:
            blockers.append({'code': 'UPDATE_SERVERS_RUNNING', 'message': 'Stop all servers on this VPS before updating; the updater never stops customer workloads automatically.', 'serverIds': active})
        if jobs:
            blockers.append({'code': 'UPDATE_JOBS_RUNNING', 'message': 'Wait for managed jobs to finish before updating.', 'jobIds': jobs})
        data_info = data.stat()
        identity = {'schemaVersion': 1, 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine(), 'source': str(source.relative_to(self.root)) if self.root else str(source), 'version': version, 'dataDir': str(data.relative_to(self.root)) if self.root else str(data), 'dataDev': data_info.st_dev, 'dataIno': data_info.st_ino, 'configSHA256': hashlib.sha256(raw_config).hexdigest(), 'unitSHA256': hashlib.sha256(unit_bytes).hexdigest(), 'packageSHA256': hashlib.sha256(package_bytes).hexdigest(), 'tokenHash': token_hash, 'serverCount': len(store['servers']), 'serverIds': sorted(row['id'] for row in store['servers'])}
        identity['installationId'] = digest({key: value for key, value in identity.items() if key not in ('version', 'source', 'packageSHA256')})
        identity['revision'] = digest(identity)
        return {**identity, 'status': 'blocked' if blockers else 'ready', 'blockers': blockers, 'processId': pid}

    def workspace(self, request_id):
        require(UUID.fullmatch(request_id or ''), 'A unique update request ID is required.')
        self.safe(self.base, directory=True, private=True)
        root = self.base / request_id
        self.safe(root, directory=True, private=True)
        return root

    def load(self, request_id):
        root = self.workspace(request_id)
        value = json.loads(self.read(root / 'request.json', 2 * 1024 * 1024, private=True))
        require(value.get('requestId') == request_id and value.get('machineId') == self.machine() and value.get('role') == self.role and value.get('nodeId') == self.node_id, 'Update receipt belongs to another installation.')
        return root, value

    def status(self, request_id):
        require(UUID.fullmatch(request_id or ''), 'A unique update request ID is required.')
        self.safe(self.install, directory=True)
        if not self.base.exists() and not self.base.is_symlink():
            return {'ok': True, 'status': 'absent', 'requestId': request_id, 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine()}
        self.safe(self.base, directory=True, private=True)
        if not (self.base / request_id).exists() and not (self.base / request_id).is_symlink():
            return {'ok': True, 'status': 'absent', 'requestId': request_id, 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine()}
        record = self.load(request_id)[1]
        result = self.public(record)
        if record['status'] == 'scheduled':
            try:
                result['canCancel'] = self.dispatch_inactive(record)
            except BaseException:
                result['canCancel'] = False
        return result

    @contextlib.contextmanager
    def lock(self):
        require(fcntl is not None, 'Native update requires Linux file locking.')
        filename = self.path('/run/vortex-os-maintenance.lock')
        fd = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (not self.enforce_owner or info.st_uid == 0 and not info.st_mode & 0o077), 'OS maintenance lock is unsafe.')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise UpdateError('Another OS maintenance operation is running.')
            yield
        finally:
            os.close(fd)

    def assert_expected(self, observed, expected):
        require(observed['revision'] == expected['revision'] and observed['installationId'] == expected['installationId'] and observed['status'] == 'ready', 'Installation changed or customer workloads are active; update was not activated.')

    def prepare(self, request):
        require(set(request) == {'schemaVersion', 'role', 'nodeId', 'requestId', 'revision', 'installationId', 'version', 'manifestSHA256', 'archiveSHA256'} and request['schemaVersion'] == 1 and request['role'] == self.role and request['nodeId'] == self.node_id and all(SHA.fullmatch(request.get(key, '')) for key in ('revision', 'installationId', 'manifestSHA256', 'archiveSHA256')) and UUID.fullmatch(request['requestId']), 'Update request is invalid.')
        with self.lock():
            observed = self.inspect(); self.assert_expected(observed, request)
            require(version_tuple(request['version']) > version_tuple(observed['version']), 'Only a newer stable source release can be installed.')
            require(shutil.disk_usage(self.install).free >= 512 * 1024 * 1024, 'Source update needs at least 512 MiB free disk for isolated staging and rollback.')
            if not self.base.exists():
                self.base.mkdir(mode=0o700)
            self.safe(self.base, directory=True, private=True)
            root = self.base / request['requestId']
            require(not root.exists(), 'This update request already exists; inspect its receipt instead of replaying it.')
            root.mkdir(mode=0o700)
            self.safe(pathlib.Path(__file__))
            shutil.copyfile(__file__, root / 'helper.py'); os.chmod(root / 'helper.py', 0o600)
            record = {**request, 'machineId': self.machine(), 'before': observed, 'createdAt': time.time(), 'status': 'preparing'}
            self.atomic(root / 'request.json', record)
            try:
                assets = release_metadata(request['version'])
                require(assets['release-manifest.json']['sha256'] == request['manifestSHA256'] and assets['vortex-panel-' + request['version'] + '.zip']['sha256'] == request['archiveSHA256'], 'The published release changed after approval; refresh its plan.')
                manifest_bytes = asset_bytes(assets['release-manifest.json'], 4 * 1024 * 1024)
                manifest = inspect_manifest(manifest_bytes, request['version'], assets)
                sums = asset_bytes(assets['SHA256SUMS'], 64 * 1024).decode('ascii')
                checksums = dict((name, sha) for sha, name in re.findall(r'^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$', sums, re.M))
                require(all(checksums.get(name) == row['sha256'] for name, row in assets.items() if name != 'SHA256SUMS'), 'Published checksums disagree with release asset digests.')
                archive = root / 'source.zip'; archive.write_bytes(asset_bytes(assets['vortex-panel-' + request['version'] + '.zip'], MAX_ARCHIVE)); os.chmod(archive, 0o600)
                source = self.install / 'releases' / ('update-' + request['version'] + '-' + request['requestId'])
                unpack(archive, source, manifest, self.role)
                source_identity = self.safe(source, directory=True)
                os.chmod(source, 0o700)
                require(not os.path.lexists(source / 'node_modules'), 'New source already contains generated dependencies.')
                record['targetSource'] = str(source)
                manifest_file = root / 'manifest.json'
                manifest_file.write_bytes(manifest_bytes); os.chmod(manifest_file, 0o600)
                self.atomic(root / 'request.json', record)
                # No package-manager lifecycle scripts or system package changes.
                service, pid = self.service()
                node = self.path('/proc/' + str(pid) + '/exe').resolve(strict=True)
                require(node.name == 'node' and node.is_file() and os.access(node, os.X_OK), 'Cannot resolve the current trusted Node interpreter.')
                node_version = self.run([str(node), '-p', 'process.versions.node']).stdout.strip()
                require(version_tuple(node_version)[0] >= 22, 'This release needs Node.js 22 or newer; upgrade the host runtime separately.')
                npm = node.parent / 'npm'
                if not npm.exists():
                    npm = pathlib.Path(shutil.which('npm') or '')
                require(npm.is_absolute() and npm.is_file() and os.access(npm, os.X_OK), 'A trusted npm executable is required for source dependencies.')
                npm_real = npm.resolve(strict=True); self.safe(npm_real)
                env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(root), 'LC_ALL': 'C', 'LANG': 'C', 'npm_config_registry': 'https://registry.npmjs.org/', 'npm_config_ignore_scripts': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false'}
                cache = root / 'npm-cache'; cache.mkdir(mode=0o700)
                cache_identity = cache.stat()
                try:
                    self.run([str(node), str(npm_real), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', str(cache)], timeout=600, cwd=source, env=env)
                finally:
                    try:
                        self.remove_private_cache(cache, cache_identity.st_dev, cache_identity.st_ino)
                    except BaseException:
                        record['cacheRetainedForReview'] = True
                current_source = self.safe(source, directory=True)
                require((current_source.st_dev, current_source.st_ino) == (source_identity.st_dev, source_identity.st_ino), 'New source identity changed during dependency installation.')
                record['dependencyRoot'] = self.staged_dependencies(source, normalize=True)
                os.chmod(source, 0o755)
                for name in ('server/node-cli.js', self.entry):
                    self.run([str(node), '--check', str(source / name)])
                self.source_verified(source, manifest)
                self.assert_expected(self.inspect(), observed)
                record.update({'status': 'prepared', 'preparedAt': time.time(), 'targetVersion': request['version'], 'helperSHA256': file_digest(root / 'helper.py')})
                self.atomic(root / 'request.json', record)
                self.write_intent(record)
                return self.public(record)
            except BaseException as error:
                record.update({'status': 'failed', 'error': str(error)[:2048], 'finishedAt': time.time()}); self.atomic(root / 'request.json', record)
                raise

    def public(self, value):
        keys = ('schemaVersion', 'requestId', 'role', 'nodeId', 'machineId', 'installationId', 'revision', 'version', 'status', 'createdAt', 'preparedAt', 'launchedAt', 'finishedAt', 'error', 'proof', 'rolledBack', 'targetSource')
        return {'ok': True, **{key: value[key] for key in keys if key in value}}

    def staged_dependencies(self, source, identity=None, normalize=False):
        source = pathlib.Path(source)
        source_info = self.safe(source, directory=True)
        require(source.parent == self.install / 'releases' and source.name.startswith('update-') and UUID.fullmatch(source.name[-36:]) and VERSION.fullmatch(source.name[7:-37]), 'Dependency target is not a new update release.')
        require(not normalize or stat.S_IMODE(source_info.st_mode) == 0o700, 'Dependency normalization requires private new staging.')
        directory = source / 'node_modules'
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and not directory.is_symlink() and info.st_dev == source_info.st_dev, 'Staged dependencies must be a real local directory.')
        proof = {'dev': info.st_dev, 'ino': info.st_ino}
        require(normalize or identity == proof, 'Staged dependency identity changed.')
        if not self.root:
            with open('/proc/self/mountinfo', encoding='utf-8') as stream:
                mounts = stream.read(8 * 1024 * 1024 + 1)
            require(len(mounts) <= 8 * 1024 * 1024, 'Dependency mount inspection exceeds its bound.')
            for line in mounts.splitlines():
                fields = line.split()
                require(len(fields) >= 6, 'Dependency mount inventory is invalid.')
                target = re.sub(r'\\([0-7]{3})', lambda value: chr(int(value.group(1), 8)), fields[4])
                require(target != str(directory) and not target.startswith(str(directory) + '/'), 'A filesystem is mounted inside staged dependencies.')
        rows, pending = [(directory, info)], [directory]
        while pending:
            parent = pending.pop()
            for path in sorted(parent.iterdir()):
                observed = path.lstat()
                require(observed.st_dev == info.st_dev, 'Staged dependencies crossed a filesystem boundary.')
                if stat.S_ISDIR(observed.st_mode):
                    pending.append(path)
                elif stat.S_ISREG(observed.st_mode):
                    require(observed.st_nlink == 1, 'Staged dependencies contain a hard link.')
                elif stat.S_ISLNK(observed.st_mode):
                    link = os.readlink(path)
                    require(not os.path.isabs(link), 'Staged dependency link is absolute.')
                    lexical = pathlib.Path(os.path.normpath(path.parent / link))
                    require(lexical.is_relative_to(directory) and lexical != directory, 'Staged dependency link leaves its tree.')
                    target = path.resolve(strict=True)
                    require(target.is_relative_to(directory) and target != directory and target.is_file() and not target.is_symlink(), 'Staged dependency link escaped its tree or is not a file.')
                    target_info = target.lstat()
                    require(target_info.st_dev == info.st_dev and target_info.st_nlink == 1, 'Staged dependency link targets an unsafe file.')
                else:
                    raise UpdateError('Staged dependencies contain a special file.')
                rows.append((path, observed))
                require(len(rows) <= 150000, 'Staged dependencies exceed their entry bound.')
        if normalize:
            # Validate the complete private tree before changing any inode. Never
            # follow npm .bin links; they may point only to verified local files.
            for path, observed in sorted(rows, key=lambda row: not stat.S_ISDIR(row[1].st_mode)):
                current = path.lstat()
                require((current.st_dev, current.st_ino, current.st_mode, current.st_nlink) == (observed.st_dev, observed.st_ino, observed.st_mode, observed.st_nlink), 'Staged dependency changed during normalization.')
                if stat.S_ISLNK(observed.st_mode):
                    os.chown(path, 0, 0, follow_symlinks=False)
                    continue
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if stat.S_ISDIR(observed.st_mode) else 0))
                try:
                    opened = os.fstat(descriptor)
                    require((opened.st_dev, opened.st_ino, opened.st_mode, opened.st_nlink) == (observed.st_dev, observed.st_ino, observed.st_mode, observed.st_nlink), 'Staged dependency inode changed.')
                    os.fchown(descriptor, 0, 0)
                    os.fchmod(descriptor, 0o755 if stat.S_ISDIR(opened.st_mode) or opened.st_mode & 0o111 else 0o644)
                finally:
                    os.close(descriptor)
            return self.staged_dependencies(source, identity=proof)
        for path, observed in rows:
            require(observed.st_uid == 0 and observed.st_gid == 0 and (stat.S_ISLNK(observed.st_mode) or stat.S_IMODE(observed.st_mode) in (0o644, 0o755) and (not stat.S_ISDIR(observed.st_mode) or stat.S_IMODE(observed.st_mode) == 0o755)), 'Staged dependency ownership or mode is unsafe.')
        return proof

    def source_verified(self, source, manifest):
        inventory = {row['path']: row for row in manifest['inventory']}
        expected = set(inventory)
        if self.role == 'worker':
            runtime_list = source / 'server/node-runtime.js'; self.safe(runtime_list)
            require(file_digest(runtime_list) == inventory['server/node-runtime.js']['sha256'], 'Worker source list changed.')
            expected = worker_files(runtime_list.read_text(), inventory)
        for row in manifest['inventory']:
            if row['path'] not in expected:
                continue
            filename = source / row['path']
            self.safe(filename)
            require(file_digest(filename) == row['sha256'], 'Approved source was changed after release verification.')

    def remove_private_cache(self, directory, device, inode):
        info = self.safe(directory, directory=True, private=True)
        require(info.st_dev == device and info.st_ino == inode and directory.name == 'npm-cache' and UUID.fullmatch(directory.parent.name) and directory.parent.parent == self.base, 'Staging cache ownership changed; it was retained.')
        require(getattr(shutil.rmtree, 'avoids_symlink_attacks', False), 'This platform cannot safely clean the private staging cache.')
        if not self.root:
            with open('/proc/self/mountinfo', encoding='utf-8') as stream:
                mounts = stream.read(8 * 1024 * 1024 + 1)
            require(len(mounts) <= 8 * 1024 * 1024, 'Mount inspection exceeds its bound.')
            for line in mounts.splitlines():
                fields = line.split()
                require(len(fields) >= 6, 'Mount inventory is invalid.')
                target = re.sub(r'\\([0-7]{3})', lambda value: chr(int(value.group(1), 8)), fields[4])
                require(target != str(directory) and not target.startswith(str(directory) + '/'), 'A filesystem is mounted inside the private staging cache; it was retained.')
        shutil.rmtree(directory)

    def retain_recovery_snapshots(self):
        rows = []
        folders = list(self.base.iterdir())
        require(len(folders) <= 4096, 'Update receipt history needs administrator review before retention can continue.')
        for folder in folders:
            if not UUID.fullmatch(folder.name):
                continue
            self.safe(folder, directory=True, private=True)
            record = json.loads(self.read(folder / 'request.json', 2 * 1024 * 1024, private=True))
            if record.get('requestId') != folder.name or record.get('machineId') != self.machine() or record.get('role') != self.role or record.get('nodeId') != self.node_id:
                continue
            # Unknown and unsuccessful requests retain all recovery evidence.
            if record.get('status') == 'completed' and record.get('proof', {}).get('independentlyVerified') is True:
                rows.append((record.get('finishedAt', 0), folder, record))
        for stamp, folder, record in sorted(rows, key=lambda row: row[0], reverse=True)[3:]:
            for name, expected in (('panel.before.json', record.get('metadataSnapshotSHA256')), ('source.zip', record.get('archiveSHA256'))):
                filename = folder / name
                if not filename.exists() or not expected:
                    continue
                self.safe(filename, private=True)
                require(file_digest(filename) == expected, 'Old recovery evidence changed; it was retained.')
                filename.unlink()

    def intent_path(self):
        return self.config_info()[1] / '.panel-update-intent.json'

    def write_intent(self, record):
        filename = self.intent_path()
        require(not filename.exists() and not filename.is_symlink(), 'Another durable source update intent exists.')
        self.atomic(filename, {'schemaVersion': 1, 'requestId': record['requestId'], 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine(), 'installationId': record['installationId']})

    def clear_intent(self, record, missing_ok=False):
        filename = self.intent_path()
        if missing_ok and not filename.exists() and not filename.is_symlink():
            return
        value = json.loads(self.read(filename, 4096, private=True))
        require(value == {'schemaVersion': 1, 'requestId': record['requestId'], 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine(), 'installationId': record['installationId']}, 'Durable update intent changed; it was retained for administrator review.')
        filename.unlink()

    def abort(self, request_id):
        with self.lock():
            root, record = self.load(request_id)
            require(record['status'] == 'prepared' or record['status'] == 'scheduled' and self.dispatch_inactive(record), 'Only a prepared or independently inactive undispatched update may be cancelled.')
            observed = self.inspect()
            require(observed['revision'] == record['before']['revision'], 'Original source identity changed; cancellation was refused.')
            self.health((self.install / 'current').resolve(strict=True), -1)
            self.clear_intent(record)
            record.update({'status': 'cancelled', 'finishedAt': time.time()}); self.atomic(root / 'request.json', record)
            return self.public(record)

    def dispatch_inactive(self, record):
        if record['status'] != 'scheduled' or not isinstance(record.get('launchedAt'), (int, float)) or time.time() - record['launchedAt'] < 120:
            return False
        unit = 'vortex-update-' + record['requestId']
        for suffix in ('.timer', '.service'):
            state = self.run(['/usr/bin/systemctl', 'show', unit + suffix, '--property=ActiveState', '--value'], allow_failure=True).stdout.strip()
            if state not in ('inactive', 'failed'):
                return False
        jobs = self.run(['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--no-pager']).stdout
        return unit not in jobs

    def launch(self, request_id):
        with self.lock():
            root, record = self.load(request_id)
            require(record['status'] == 'prepared' and record.get('helperSHA256') == file_digest(root / 'helper.py'), 'Update is not prepared or its helper changed; it will not be replayed.')
            self.assert_expected(self.inspect(), record['before'])
            record.update({'status': 'scheduled', 'launchedAt': time.time()}); self.atomic(root / 'request.json', record)
            unit = 'vortex-update-' + request_id
            result = self.run(['/usr/bin/systemd-run', '--quiet', '--unit=' + unit, '--on-active=' + ('10s' if self.role == 'panel' else '2s'), '--property=Type=oneshot', '--property=UMask=0077', '--property=TimeoutStartSec=300', '--', '/usr/bin/python3', '-I', '-B', str(root / 'helper.py'), 'apply', '--role', self.role, '--node-id', self.node_id, '--request-id', request_id], allow_failure=True)
            require(result.returncode == 0, 'Update dispatch outcome is unknown. Inspect the existing request; do not replay it automatically.')
            return self.public(record)

    def protection(self):
        raw_config, data, store, token_hash = self.config_info()
        # The panel may persist job/activity timestamps while shutting down.
        # Customer definitions, account configuration and selections must remain.
        protected = {key: store.get(key) for key in ('schedules', 'settings')}
        protected['users'] = [{key: value for key, value in row.items() if key not in {'mfaLastCounter', 'mfaRecoveryHashes'}} for row in store.get('users', [])]
        transient = {'status', 'players', 'memoryMB', 'cpuPercent', 'jobId', 'cloneJobId', 'storageMountError', 'resumeOnPanelStart'}
        protected['servers'] = [{key: value for key, value in row.items() if key not in transient} for row in store['servers']]
        protected['nodes'] = [{key: value for key, value in row.items() if key not in {'lastSeen', 'inventory'}} for row in store.get('nodes', [])]
        return {'configSHA256': hashlib.sha256(raw_config).hexdigest(), 'unitSHA256': file_digest(self.path('/etc/systemd/system/' + self.unit)), 'dataDev': data.stat().st_dev, 'dataIno': data.stat().st_ino, 'storeSHA256': digest(protected)}

    def health(self, expected, previous_pid, freeze_request=None):
        service, pid = self.service()
        require(pid != previous_pid, 'Service process was not replaced by the approved update.')
        source = (self.install / 'current').resolve(strict=True)
        require(source == pathlib.Path(expected), 'Current source is not the approved release.')
        # The process command and working directory bind the service to the source;
        # loopback HTTP and authenticated TLS identity prove API readiness.
        cwd = self.path('/proc/' + str(pid) + '/cwd').resolve(strict=True)
        require(cwd == source, 'Updated service is not running from the approved source.')
        if self.role == 'worker':
            node = self.path('/proc/' + str(pid) + '/exe').resolve(strict=True)
            result = self.run([str(node), str(source / 'server/node-cli.js'), 'check'], timeout=10)
            value = json.loads(result.stdout)
            require(value.get('ok') is True and value.get('processId') == pid and value.get('nodeId') == self.node_id, 'Worker authenticated readiness failed.')
        else:
            raw = self.read(self.config, 1024 * 1024, private=True).decode()
            ports = re.findall(r'^PORT=([0-9]+)$', raw, re.M)
            port = int(ports[0]) if len(ports) == 1 else 3000
            require(1 <= port <= 65535, 'Invalid managed listener port.')
            request = urllib.request.Request('http://127.0.0.1:' + str(port) + '/healthz')
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=5) as response:
                value = json.loads(response.read(65537))
            require(value.get('ok') is True and value.get('service') == 'vortex-panel' and value.get('processId') == pid and value.get('version') == json.loads((source / 'package.json').read_text())['version'], 'Panel loopback readiness failed.')
        if freeze_request:
            require(value.get('maintenance', {}).get('active') is True and value['maintenance'].get('action') == 'update' and value['maintenance'].get('requestId') == freeze_request, 'The running service did not acknowledge the exact source update admission freeze. No workload was stopped.')
        return pid

    def apply(self, request_id):
        with self.lock():
            root, record = self.load(request_id)
            require(record['status'] == 'scheduled' and record.get('helperSHA256') == file_digest(root / 'helper.py'), 'Update is not scheduled or helper changed; no replay is allowed.')
            try:
                observed = self.inspect(); self.assert_expected(observed, record['before'])
                target = pathlib.Path(record['targetSource'])
                require(target.parent == self.install / 'releases' and target.name == 'update-' + record['version'] + '-' + request_id, 'Update source target is invalid.')
                self.safe(target, directory=True)
                manifest_bytes = self.read(root / 'manifest.json', 4 * 1024 * 1024, private=True)
                require(hashlib.sha256(manifest_bytes).hexdigest() == record['manifestSHA256'], 'Prepared manifest changed.')
                self.source_verified(target, json.loads(manifest_bytes))
                self.staged_dependencies(target, identity=record.get('dependencyRoot'))
                previous = (self.install / 'current').resolve(strict=True)
                self.health(previous, -1, freeze_request=request_id)
                # Admission ACK is live and includes the UUID. A previously admitted
                # lifecycle change must also have finished before this last check.
                self.assert_expected(self.inspect(), record['before'])
                protection = self.protection(); previous_pid = observed['processId']
            except BaseException as error:
                record.update({'status': 'failed', 'rolledBack': True, 'activationStarted': False, 'error': str(error)[:2048], 'finishedAt': time.time()}); self.atomic(root / 'request.json', record)
                self.clear_intent(record)
                return self.public(record)
            record.update({'status': 'applying', 'beforeProtection': protection}); self.atomic(root / 'request.json', record)
            changed = False
            try:
                self.run(['/usr/bin/systemctl', 'stop', self.unit], timeout=240)
                require(self.protection() == protection, 'Customer definitions or configuration changed during shutdown; source was not switched.')
                # Private recovery evidence only. Never blindly restore this
                # database: doing so could resurrect consumed MFA recovery codes.
                data = self.config_info()[1]
                store_before = self.read(data / 'panel.json', 64 * 1024 * 1024, private=True)
                backup = root / 'panel.before.json'
                fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as output:
                    output.write(store_before); output.flush(); os.fsync(output.fileno())
                record['metadataSnapshotSHA256'] = hashlib.sha256(store_before).hexdigest()
                self.atomic(root / 'request.json', record)
                self.switch(target); changed = True
                self.run(['/usr/bin/systemctl', 'start', self.unit], timeout=60)
                pid = None
                for attempt in range(60):
                    try:
                        pid = self.health(target, previous_pid); break
                    except BaseException:
                        time.sleep(1)
                require(pid is not None and self.protection() == protection, 'Updated source did not become healthy or protected data changed.')
                record.update({'status': 'completed', 'finishedAt': time.time(), 'proof': {'schemaVersion': 1, 'requestId': request_id, 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine(), 'installationId': record['installationId'], 'version': record['version'], 'archiveSHA256': record['archiveSHA256'], 'verified': True, 'sourceVerified': True, 'serviceHealthy': True, 'configurationPreserved': True, 'dataIdentityPreserved': True, 'customerDefinitionsPreserved': True, 'processId': pid}})
                self.atomic(root / 'request.json', record)
            except BaseException as error:
                rolled_back = False
                try:
                    if changed:
                        self.run(['/usr/bin/systemctl', 'stop', self.unit], timeout=240)
                        self.switch(previous)
                    self.run(['/usr/bin/systemctl', 'start', self.unit], timeout=60)
                    for attempt in range(30):
                        try:
                            self.health(previous, previous_pid)
                            require(self.protection() == protection, 'Protected customer definitions changed; source rollback does not rewrite customer data.')
                            rolled_back = True; break
                        except BaseException:
                            time.sleep(1)
                except BaseException:
                    pass
                record.update({'status': 'failed' if rolled_back else 'unknown', 'rolledBack': rolled_back, 'error': str(error)[:2048], 'finishedAt': time.time()}); self.atomic(root / 'request.json', record)
                if rolled_back:
                    self.clear_intent(record)
            return self.public(record)

    def switch(self, target):
        temporary = self.install / 'current.update-next'
        require(not temporary.exists() and not temporary.is_symlink(), 'Release switch path already exists.')
        temporary.symlink_to(target)
        os.replace(temporary, self.install / 'current')

    def verify(self, request_id):
        with self.lock():
            return self.verify_locked(request_id)

    def verify_locked(self, request_id):
        root, record = self.load(request_id)
        require(record['status'] == 'completed' and record.get('proof', {}).get('verified') is True, 'This update does not have a completed native receipt.')
        info = self.inspect()
        require(info['version'] == record['version'] and info['installationId'] == record['installationId'] and self.protection() == record['beforeProtection'], 'Independent update verification failed; protected installation changed.')
        manifest = json.loads(self.read(root / 'manifest.json', 4 * 1024 * 1024, private=True)); self.source_verified(pathlib.Path(record['targetSource']), manifest)
        pid = self.health(record['targetSource'], record['before']['processId'])
        result = {**record['proof'], 'processId': pid, 'independentlyVerified': True}
        warning = {'recoveryRetentionNeedsReview': True, 'recoveryRetentionReasonCode': 'recovery-retention-needs-review', 'recoveryRetentionPath': str(self.base)}
        # Persist the conservative review notice before attempting cleanup. A
        # lost response or interrupted cleanup must not erase its warning from
        # the durable status proof, even though source verification succeeded.
        result.update(warning)
        record['proof'] = result; record['verifiedAt'] = time.time(); self.atomic(root / 'request.json', record)
        self.clear_intent(record, missing_ok=True)
        try:
            self.retain_recovery_snapshots()
            for key in warning:
                result.pop(key, None)
        except BaseException:
            result.update(warning)
        try:
            self.atomic(root / 'request.json', record)
        except BaseException:
            # The first durable proof already retains this notice. Do not turn
            # successful service/source verification into a false rollback, or
            # return a clean proof while the persisted proof still needs review.
            result.update(warning)
        return {'ok': True, **result}

    def verify_rollback(self, request_id):
        root, record = self.load(request_id)
        require(record['status'] == 'failed' and record.get('rolledBack') is True, 'Update does not have a known rollback receipt.')
        info = self.inspect()
        require(info['revision'] == record['before']['revision'] and info['version'] == record['before']['version'], 'Original installation identity was not restored.')
        self.health((self.install / 'current').resolve(strict=True), -1)
        if record.get('beforeProtection'):
            require(self.protection() == record['beforeProtection'], 'Original customer definitions or configuration changed.')
        return {'ok': True, 'schemaVersion': 1, 'requestId': request_id, 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine(), 'installationId': info['installationId'], 'version': info['version'], 'rolledBack': True, 'independentlyVerified': True}

    def attest(self, request):
        require(set(request) == {'schemaVersion', 'role', 'nodeId', 'requestId', 'revision', 'installationId', 'version', 'manifestSHA256', 'archiveSHA256'} and request['schemaVersion'] == 1 and request['role'] == self.role and request['nodeId'] == self.node_id and UUID.fullmatch(request.get('requestId', '')), 'Current source attestation request is invalid.')
        observed = self.inspect(); self.assert_expected(observed, request)
        require(observed['version'] == request['version'], 'Current source attestation cannot upgrade or downgrade a release.')
        assets = release_metadata(request['version'])
        require(assets['release-manifest.json']['sha256'] == request['manifestSHA256'] and assets['vortex-panel-' + request['version'] + '.zip']['sha256'] == request['archiveSHA256'], 'The approved current release changed.')
        manifest = inspect_manifest(asset_bytes(assets['release-manifest.json'], 4 * 1024 * 1024), request['version'], assets)
        self.source_verified((self.install / 'current').resolve(strict=True), manifest)
        self.health((self.install / 'current').resolve(strict=True), -1)
        return {'ok': True, 'schemaVersion': 1, 'requestId': request['requestId'], 'role': self.role, 'nodeId': self.node_id, 'machineId': self.machine(), 'installationId': observed['installationId'], 'version': observed['version'], 'archiveSHA256': request['archiveSHA256'], 'alreadyCurrent': True, 'verified': True, 'sourceVerified': True, 'serviceHealthy': True, 'configurationPreserved': True, 'dataIdentityPreserved': True, 'customerDefinitionsPreserved': True, 'independentlyVerified': True}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise UpdateError('Managed health endpoint redirected.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'prepare', 'launch', 'status', 'verify', 'verify-rollback', 'attest', 'apply', 'abort'))
    parser.add_argument('--role', choices=tuple(ROLES), required=True)
    parser.add_argument('--node-id', required=True)
    parser.add_argument('--request-id')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0 and pathlib.Path('/run/systemd/system').is_dir(), 'Verified update requires managed root Linux with systemd.')
    host = Host(args.role, args.node_id)
    if args.action == 'plan':
        result = {'ok': True, **host.inspect()}
        host.health((host.install / 'current').resolve(strict=True), -1)
        result['serviceHealthy'] = True
    elif args.action in ('prepare', 'attest'):
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1); require(len(raw) <= 2 * 1024 * 1024, 'Request exceeds its safe bound.')
        result = host.prepare(json.loads(raw)) if args.action == 'prepare' else host.attest(json.loads(raw))
    elif args.action == 'launch':
        result = host.launch(args.request_id)
    elif args.action == 'apply':
        result = host.apply(args.request_id)
    elif args.action == 'verify':
        result = host.verify(args.request_id)
    elif args.action == 'verify-rollback':
        result = host.verify_rollback(args.request_id)
    elif args.action == 'abort':
        result = host.abort(args.request_id)
    else:
        result = host.status(args.request_id)
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        print(json.dumps({'ok': False, 'error': str(error)[:2048]}, separators=(',', ':')))
        sys.exit(1)
