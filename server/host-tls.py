#!/usr/bin/env python3
"""Owned public-IP ACME lifecycle. No action occurs on import."""
import argparse
import base64
import datetime
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import sys
import time
import uuid

CERTBOT_VERSION = '5.8.0'
CONFIG = '/etc/nginx/conf.d/vortex-panel.conf'
STATE = '/etc/vortex-panel/tls-management.json'
ACME = '/etc/vortex-panel/acme'
WORK = '/var/lib/vortex-panel-acme'
LOGS = '/var/lib/vortex-panel-acme-logs'
RUNTIME = '/opt/vortex-panel/acme-runtime'
MANAGED = '/etc/vortex-panel/tls-managed'
UNIT = 'vortex-panel-tls-renew'
CA = 'https://acme-v02.api.letsencrypt.org/directory'


class TLSError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def need(value, code='TLS_OWNERSHIP'):
    if not value:
        raise TLSError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class TLSManager:
    def __init__(self, root='/', runner=None):
        self.root = Path(root).resolve()
        self.runner = runner or self.command

    def path(self, name):
        need(name.startswith('/') and '..' not in Path(name).parts)
        return self.root / name.lstrip('/')

    def directory(self, name, create=False, mode=0o700):
        target = self.path(name)
        for parent in reversed([target, *target.parents]):
            if parent != self.root and self.root not in parent.parents:
                continue
            if not parent.exists() and create:
                parent.mkdir(mode=mode if parent == target else 0o755)
            info = parent.lstat()
            need(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022)
        return target

    def read(self, name, maximum=131072):
        target = self.path(name)
        self.directory(str(Path(name).parent))
        info = target.lstat()
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1 and not info.st_mode & 0o022 and info.st_size <= maximum)
        fd = os.open(target, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            need(os.fstat(fd).st_ino == info.st_ino)
            raw = os.read(fd, maximum + 1)
            need(len(raw) <= maximum and target.lstat().st_ino == info.st_ino)
            return raw
        finally:
            os.close(fd)

    def write(self, name, raw, mode=0o600, expected=None):
        target = self.path(name)
        self.directory(str(Path(name).parent), create=True)
        if os.path.lexists(target):
            before = self.read(name)
            need(expected is not None and before == expected, 'TLS_CHANGED')
        else:
            need(expected is None, 'TLS_CHANGED')
        temporary = target.parent / ('.vortex-tls-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            if expected is not None:
                need(self.read(name) == expected, 'TLS_CHANGED')
            else:
                need(not os.path.lexists(target), 'TLS_CHANGED')
            os.replace(temporary, target)
            directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)

    def command(self, args, timeout=45, check=True):
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'DEBIAN_FRONTEND': 'noninteractive'})
        need(len(result.stdout) + len(result.stderr) <= 1024 * 1024, 'TLS_COMMAND')
        if check:
            need(result.returncode == 0, 'TLS_COMMAND')
        return result

    def state(self):
        if not os.path.lexists(self.path(STATE)):
            return {'schema': 1, 'jobs': []}
        value = json.loads(self.read(STATE))
        need(value.get('schema') == 1 and isinstance(value.get('jobs'), list) and len(value['jobs']) <= 16)
        return value

    def save(self, value):
        old = self.read(STATE) if os.path.lexists(self.path(STATE)) else None
        self.write(STATE, (json.dumps(value, separators=(',', ':')) + '\n').encode(), expected=old)

    def identity(self):
        values = {}
        for row in self.read('/etc/vortex-panel.env').decode().splitlines():
            if re.match(r'^(PUBLIC_URL|PORT|HOST|TRUST_PROXY)=', row):
                key, value = row.split('=', 1)
                need(key not in values)
                values[key] = value.strip('"')
        match = re.fullmatch(r'https://([0-9.]+)(?::443)?/?', values.get('PUBLIC_URL', ''))
        need(match and values.get('HOST') == '127.0.0.1' and values.get('TRUST_PROXY') == '1', 'TLS_ACCESS')
        address = ipaddress.ip_address(match[1])
        need(address.version == 4 and address.is_global and str(address) == match[1], 'TLS_ACCESS')
        need(re.fullmatch(r'[0-9]{1,5}', values.get('PORT', '')) and 1024 <= int(values['PORT']) <= 65535, 'TLS_ACCESS')
        return str(address), int(values['PORT'])

    def baseline(self, address, port):
        filename = Path(__file__).resolve().parents[1] / 'deploy/configure-access.py'
        spec = importlib.util.spec_from_file_location('vortex_access_template', filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.AccessSetup().nginx_config(address, port)

    def challenge_config(self, raw, address):
        old = '    return 308 https://' + address + '$request_uri;'
        replacement = '''    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/vortex-panel-acme/challenges;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 308 https://''' + address + '''$request_uri; }'''
        text = raw.decode()
        need(text.count(old) == 1, 'TLS_ACCESS')
        return text.replace(old, replacement).encode()

    def configurations(self, state, address, port):
        original = base64.b64decode(state['originalConfig'], validate=True) if state.get('originalConfig') else self.baseline(address, port)
        if state.get('originalConfig'):
            need(state.get('address') == address and state.get('port') == port, 'TLS_CHANGED')
        challenge = self.challenge_config(original, address)
        active = challenge.replace(b'/etc/vortex-panel/tls/ip.crt', (MANAGED + '/active/fullchain.pem').encode()).replace(b'/etc/vortex-panel/tls/ip.key', (MANAGED + '/active/privkey.pem').encode())
        return original, challenge, active

    def owned_directory(self, name, purpose):
        target = self.path(name)
        existed = os.path.lexists(target)
        self.directory(name, create=True)
        marker = name + '/vortex-owner.json'
        expected = {'schema': 1, 'owner': 'vortex-panel', 'purpose': purpose}
        if os.path.lexists(self.path(marker)):
            need(json.loads(self.read(marker)) == expected, 'TLS_OWNERSHIP')
        else:
            # An empty directory can be claimed; existing foreign content cannot.
            need(not existed or not any(target.iterdir()), 'TLS_OWNERSHIP')
            self.write(marker, (json.dumps(expected) + '\n').encode())
        return target

    def acme_file(self, name):
        need(name in ('fullchain.pem', 'privkey.pem'))
        link = self.path(ACME + '/live/vortex-panel-ip/' + name)
        self.directory(ACME + '/live/vortex-panel-ip')
        info = link.lstat()
        need(stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1)
        actual = link.resolve(strict=True)
        archive = self.path(ACME + '/archive/vortex-panel-ip')
        need(actual.parent == archive and re.fullmatch(name.split('.')[0] + r'[1-9][0-9]*\.pem', actual.name))
        relative = '/' + actual.relative_to(self.root).as_posix()
        raw = self.read(relative)
        if name == 'privkey.pem':
            need(not actual.lstat().st_mode & 0o077)
        return relative, raw

    def certificate(self, filename, address):
        target = self.path(filename)
        if not target.exists():
            return None
        actual = target.resolve(strict=True)
        self.read('/' + actual.relative_to(self.root).as_posix())
        args = ['openssl', 'x509', '-in', str(target), '-noout', '-enddate', '-issuer', '-fingerprint', '-sha256']
        result = self.runner(args, check=False)
        if result.returncode:
            return None
        values = dict(row.split('=', 1) for row in result.stdout.splitlines() if '=' in row)
        try:
            expires = datetime.datetime.strptime(values['notAfter'], '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
        except (KeyError, ValueError):
            return None
        # x509 -checkip only prints a message; its exit code is not a predicate.
        # verify checks the CA chain, validity period and exact IP SAN together.
        valid = self.runner(['openssl', 'verify', '-purpose', 'sslserver', '-verify_ip', address, '-untrusted', str(target), str(target)], check=False).returncode == 0
        fingerprint = values.get('sha256 Fingerprint') or values.get('SHA256 Fingerprint')
        need(isinstance(fingerprint, str) and re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}', fingerprint), 'TLS_VERIFY')
        return {'expiresAt': expires.isoformat(), 'issuer': values.get('issuer', '')[:256], 'fingerprint': fingerprint.replace(':', '').lower(), 'validForAddress': valid}

    def verify_pair(self, certificate, key, address):
        cert = self.certificate(certificate, address)
        need(cert and cert['validForAddress'], 'TLS_VERIFY')
        private = self.path(key)
        need(not private.lstat().st_mode & 0o077, 'TLS_OWNERSHIP')
        public = self.runner(['openssl', 'x509', '-in', str(self.path(certificate)), '-pubkey', '-noout']).stdout
        key_public = self.runner(['openssl', 'pkey', '-in', str(private), '-passin', 'pass:', '-pubout']).stdout
        need(public and public == key_public, 'TLS_KEY')
        return cert

    def active_generation(self):
        link = self.path(MANAGED + '/active')
        if not os.path.lexists(link):
            return None
        self.owned_directory(MANAGED, 'validated-certificate-generations')
        info = link.lstat()
        need(stat.S_ISLNK(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1)
        target = os.readlink(link)
        need(re.fullmatch(r'generations/[a-f0-9]{64}', target), 'TLS_OWNERSHIP')
        self.directory(MANAGED + '/' + target)
        return target.split('/')[1]

    def generation_files(self, identity):
        need(isinstance(identity, str) and re.fullmatch('[a-f0-9]{64}', identity), 'TLS_OWNERSHIP')
        self.owned_directory(MANAGED, 'validated-certificate-generations')
        base = MANAGED + '/generations/' + identity
        chain, key = self.read(base + '/fullchain.pem'), self.read(base + '/privkey.pem')
        need(digest(chain + b'\0' + key) == identity, 'TLS_OWNERSHIP')
        need(not self.path(base + '/privkey.pem').lstat().st_mode & 0o077, 'TLS_OWNERSHIP')
        return base

    def generation(self, identity, address):
        base = self.generation_files(identity)
        return self.verify_pair(base + '/fullchain.pem', base + '/privkey.pem', address)

    def stage_candidate(self, address):
        certificate, chain = self.acme_file('fullchain.pem')
        keyname, key = self.acme_file('privkey.pem')
        self.verify_pair(certificate, keyname, address)
        self.owned_directory(MANAGED, 'validated-certificate-generations')
        self.directory(MANAGED + '/generations', create=True)
        identity = digest(chain + b'\0' + key)
        base = MANAGED + '/generations/' + identity
        target = self.path(base)
        if os.path.lexists(target):
            need(self.read(base + '/fullchain.pem') == chain and self.read(base + '/privkey.pem') == key)
        else:
            staging = MANAGED + '/generations/.staging-' + uuid.uuid4().hex
            self.directory(staging, create=True)
            self.write(staging + '/fullchain.pem', chain, mode=0o644)
            self.write(staging + '/privkey.pem', key)
            self.verify_pair(staging + '/fullchain.pem', staging + '/privkey.pem', address)
            need(not os.path.lexists(target), 'TLS_CHANGED')
            os.rename(self.path(staging), target)
            directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        return identity, self.generation(identity, address)

    def switch_generation(self, identity, expected):
        need(self.active_generation() == expected, 'TLS_CHANGED')
        self.owned_directory(MANAGED, 'validated-certificate-generations')
        link = self.path(MANAGED + '/active')
        if identity is None:
            if expected is not None:
                link.unlink()
        else:
            need(re.fullmatch('[a-f0-9]{64}', identity), 'TLS_OWNERSHIP')
            self.directory(MANAGED + '/generations/' + identity)
            temporary = link.parent / ('.active-' + uuid.uuid4().hex)
            try:
                os.symlink('generations/' + identity, temporary)
                need(self.active_generation() == expected, 'TLS_CHANGED')
                os.replace(temporary, link)
            finally:
                temporary.unlink(missing_ok=True)
        directory = os.open(link.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def certificate_path(self, raw, active):
        if raw == active:
            identity = self.active_generation()
            need(identity, 'TLS_RECOVERY')
            return MANAGED + '/generations/' + identity + '/fullchain.pem'
        return '/etc/vortex-panel/tls/ip.crt'

    def inspect(self):
        state = self.state()
        try:
            address, port = self.identity()
            original, challenge, active = self.configurations(state, address, port)
            raw = self.read(CONFIG)
            need(raw in (original, challenge, active), 'TLS_EXTERNAL')
            cert = self.certificate(self.certificate_path(raw, active), address)
            timer = self.runner(['systemctl', 'is-enabled', '--quiet', UNIT + '.timer'], check=False).returncode == 0
            running = self.runner(['systemctl', 'is-active', '--quiet', UNIT + '.timer'], check=False).returncode == 0
            return {'available': True, 'address': address, 'mode': 'public-ca' if raw == active else 'self-signed', 'certificate': cert, 'automaticRenewal': timer and running, 'renewal': state.get('renewal'), 'revision': digest(raw + json.dumps(state, sort_keys=True).encode()), 'jobs': state['jobs'], 'recoveryRequired': bool(self.pending(state)), 'observedAt': timestamp()}
        except (OSError, ValueError, TLSError) as error:
            return {'available': False, 'mode': 'unmanaged', 'reasonCode': getattr(error, 'code', 'TLS_ACCESS'), 'revision': digest(json.dumps(state, sort_keys=True).encode()), 'jobs': state['jobs'], 'renewal': state.get('renewal'), 'recoveryRequired': bool(self.pending(state)), 'observedAt': timestamp()}

    def runtime(self):
        folder = self.path(RUNTIME)
        marker = RUNTIME + '/vortex-runtime.json'
        if folder.exists():
            self.directory(RUNTIME)
            need(json.loads(self.read(marker)) == {'certbot': CERTBOT_VERSION}, 'TLS_RUNTIME')
        else:
            self.directory(RUNTIME, create=True, mode=0o755)
            self.write(marker, json.dumps({'certbot': CERTBOT_VERSION}).encode())
        executable = str(folder / 'bin/certbot')
        if Path(executable).exists():
            result = self.runner([executable, '--version'], check=False)
            need(result.returncode == 0 and result.stdout.strip() == 'certbot ' + CERTBOT_VERSION, 'TLS_RUNTIME')
            return executable
        self.runner(['/usr/bin/python3', '-m', 'venv', str(folder)], timeout=90)
        self.runner([str(folder / 'bin/python'), '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-cache-dir', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', 'certbot==' + CERTBOT_VERSION], timeout=240)
        need(self.runner([executable, '--version']).stdout.strip() == 'certbot ' + CERTBOT_VERSION, 'TLS_RUNTIME')
        return executable

    def nginx_reload(self):
        self.runner(['nginx', '-t'])
        self.runner(['systemctl', 'reload', 'nginx'])

    def probe_challenge(self, address):
        directory = self.directory(WORK + '/challenges/.well-known/acme-challenge', create=True, mode=0o755)
        # nginx workers need traversal only for this public challenge tree.
        for name in [WORK, WORK + '/challenges', WORK + '/challenges/.well-known', WORK + '/challenges/.well-known/acme-challenge']:
            self.directory(name).chmod(0o755)
        name = 'vortex-probe-' + uuid.uuid4().hex
        filename = WORK + '/challenges/.well-known/acme-challenge/' + name
        self.write(filename, name.encode(), mode=0o644)
        try:
            # Panel and renewal services use UMask=0077. This random public
            # readiness token must be readable by nginx's unprivileged workers.
            self.path(filename).chmod(0o644)
            # systemctl reload acknowledges nginx's reload signal. The old
            # workers can still answer a fresh connection with their redirect
            # before the new challenge location becomes ready. Keep the token
            # available and retry only this local, exact-content readiness test.
            deadline = time.monotonic() + 8
            while True:
                remaining = deadline - time.monotonic()
                milliseconds = min(2000, int(remaining * 1000))
                need(milliseconds >= 1, 'TLS_CHALLENGE')
                duration = '%.3f' % (milliseconds / 1000)
                connect = '%.3f' % (min(milliseconds, 1000) / 1000)
                try:
                    result = self.runner(['curl', '--noproxy', '*', '--fail', '--silent', '--connect-timeout', connect, '--max-time', duration, '--resolve', address + ':80:127.0.0.1', 'http://' + address + '/.well-known/acme-challenge/' + name], timeout=remaining, check=False)
                except subprocess.TimeoutExpired:
                    raise TLSError('TLS_CHALLENGE') from None
                if result.returncode == 0 and result.stdout == name:
                    return
                need(time.monotonic() < deadline, 'TLS_CHALLENGE')
                time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        finally:
            self.path(filename).unlink(missing_ok=True)

    def timer(self):
        helper = Path(__file__).resolve()
        need(str(helper).startswith('/opt/vortex-panel/releases/'), 'TLS_LAYOUT')
        for suffix, raw in self.unit_templates().items():
            name = '/etc/systemd/system/' + UNIT + '.' + suffix
            if os.path.lexists(self.path(name)):
                need(self.read(name) == raw, 'TLS_EXTERNAL')
            else:
                self.write(name, raw, mode=0o644)
        self.runner(['systemctl', 'daemon-reload'])
        self.runner(['systemctl', 'enable', '--now', UNIT + '.timer'])

    @staticmethod
    def unit_templates():
        service = ('# Vortex-owned public-IP certificate renewal\n[Unit]\nDescription=Renew Vortex Panel public IP certificate\nAfter=network-online.target nginx.service\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 -I -B /opt/vortex-panel/current/server/host-tls.py renew\nTimeoutStartSec=600\nUMask=0077\n').encode()
        timer = ('# Vortex-owned public-IP certificate renewal\n[Unit]\nDescription=Check Vortex Panel certificate renewal\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=6h\nRandomizedDelaySec=15min\nPersistent=true\n[Install]\nWantedBy=timers.target\n').encode()
        return {'service': service, 'timer': timer}

    def tls_health(self, address, fingerprint=None, trusted_file=None):
        context = ssl.create_default_context(cafile=str(self.path(trusted_file))) if trusted_file else ssl.create_default_context()
        # nginx reload acknowledges the signal before workers necessarily accept
        # the new generation. Never accept a still-serving older CA certificate.
        deadline = time.monotonic() + 12
        while True:
            try:
                with socket.create_connection(('127.0.0.1', 443), timeout=3) as connection:
                    with context.wrap_socket(connection, server_hostname=address) as secured:
                        raw = secured.getpeercert(binary_form=True)
                        need(raw and (fingerprint is None or digest(raw) == fingerprint), 'TLS_VERIFY')
                        return
            except (OSError, ssl.SSLError, TLSError):
                if time.monotonic() >= deadline:
                    raise TLSError('TLS_VERIFY') from None
                time.sleep(0.2)

    def pending(self, state):
        return [*[(row, False) for row in state['jobs'] if row.get('status') in ('running', 'unknown')], *([(state['renewal'], True)] if state.get('renewal', {}).get('status') in ('running', 'unknown') else [])]

    def rollback(self, row, state, address, port):
        original, challenge, active = self.configurations(state, address, port)
        previous = base64.b64decode(row['previousConfig'], validate=True)
        need(previous in (original, challenge, active), 'TLS_RECOVERY')
        current = self.read(CONFIG)
        need(current in (original, challenge, active), 'TLS_EXTERNAL')
        before = row.get('previousGeneration')
        candidate = row.get('candidateGeneration')
        live = self.active_generation()
        need(live in (before, candidate, None), 'TLS_CHANGED')
        # Certbot's private lineage may fail without touching the serving pair.
        # Keep renewal retryable even if that previous certificate has expired.
        if current == previous and live == before:
            if before is not None:
                self.generation_files(before)
            return
        if previous == active:
            need(before, 'TLS_RECOVERY')
            certificate = self.generation(before, address)
            if live != before:
                self.switch_generation(before, live)
            if current != previous:
                self.write(CONFIG, previous, mode=0o644, expected=current)
            self.nginx_reload()
            self.tls_health(address, certificate['fingerprint'])
        else:
            if current != previous:
                self.write(CONFIG, previous, mode=0o644, expected=current)
            if live != before:
                self.switch_generation(before, live)
            self.nginx_reload()
            baseline = self.certificate('/etc/vortex-panel/tls/ip.crt', address)
            need(baseline, 'TLS_RECOVERY')
            self.tls_health(address, baseline['fingerprint'], '/etc/vortex-panel/tls/ip.crt')

    def activate(self, identity, certificate, row, state, address, port):
        _original, challenge, active = self.configurations(state, address, port)
        row['candidateGeneration'] = identity
        self.save(state)
        previous = row.get('previousGeneration')
        self.switch_generation(identity, previous)
        current = self.read(CONFIG)
        need(current in (challenge, active), 'TLS_CHANGED')
        if current != active:
            self.write(CONFIG, active, mode=0o644, expected=current)
        self.nginx_reload()
        self.tls_health(address, certificate['fingerprint'])

    def recover(self, request):
        need(isinstance(request, dict) and set(request) == {'revision', 'confirmed'} and isinstance(request.get('revision'), str) and re.fullmatch('[a-f0-9]{64}', request['revision']) and request.get('confirmed') is True, 'TLS_INPUT')
        need(self.inspect()['revision'] == request['revision'], 'TLS_CHANGED')
        state = self.state()
        active_operations = self.pending(state)
        need(len(active_operations) <= 1, 'TLS_RECOVERY')
        if not active_operations:
            return self.inspect()
        row, renewal = active_operations[0]
        address, port = self.identity()
        _original, _challenge, active = self.configurations(state, address, port)
        try:
            candidate = row.get('candidateGeneration')
            verified = False
            if candidate and self.read(CONFIG) == active and self.active_generation() == candidate:
                try:
                    certificate = self.generation(candidate, address)
                    self.tls_health(address, certificate['fingerprint'])
                    verified = True
                except (OSError, ValueError, TLSError, subprocess.SubprocessError):
                    # A crash may have persisted the config before nginx loaded
                    # it. Restore the previous pair if activation is unverified.
                    verified = False
            if verified:
                self.timer()
                row.update(status='completed', phase='verified', progress=100, completedAt=timestamp(), recovered=True, errorCode=None)
                if renewal:
                    row.update(lastSuccessAt=timestamp(), errorCode=None)
                else:
                    state['renewal'] = {'lastSuccessAt': timestamp(), 'errorCode': None}
            else:
                self.rollback(row, state, address, port)
                row.update(status='failed', phase='interrupted', errorCode='TLS_INTERRUPTED', completedAt=timestamp(), recovered=True)
            self.save(state)
        except BaseException as error:
            row.update(status='unknown', phase='recovery-required', errorCode='TLS_RECOVERY')
            self.save(state)
            raise TLSError('TLS_RECOVERY') from error
        return self.inspect()

    def issue(self, request):
        need(isinstance(request, dict) and set(request) == {'requestId', 'revision', 'confirmed', 'termsAccepted'}, 'TLS_INPUT')
        need(isinstance(request.get('requestId'), str) and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request['requestId'], re.I) and request.get('confirmed') is True and request.get('termsAccepted') is True, 'TLS_CONFIRM')
        need(isinstance(request.get('revision'), str) and re.fullmatch('[a-f0-9]{64}', request['revision']), 'TLS_INPUT')
        before = self.inspect()
        need(before['available'], before.get('reasonCode', 'TLS_ACCESS'))
        state = self.state()
        previous = next((row for row in state['jobs'] if row['id'] == request['requestId']), None)
        if previous:
            return self.inspect()
        need(not self.pending(state), 'TLS_RECOVERY')
        need(before['revision'] == request['revision'], 'TLS_CHANGED')
        address, port = self.identity()
        original, challenge, active = self.configurations(state, address, port)
        raw = self.read(CONFIG)
        need(raw in (original, challenge, active), 'TLS_EXTERNAL')
        state['originalConfig'] = base64.b64encode(original).decode()
        state['address'] = address
        state['port'] = port
        job = {'id': request['requestId'], 'status': 'running', 'phase': 'preparing', 'progress': 5, 'startedAt': timestamp(), 'previousGeneration': self.active_generation(), 'previousConfig': base64.b64encode(raw).decode()}
        state['jobs'] = [*state['jobs'][-15:], job]

        def progress(phase, value):
            job.update(phase=phase, progress=value)
            self.save(state)

        progress('preparing', 5)
        try:
            executable = self.runtime()
            progress('challenge', 30)
            self.owned_directory(ACME, 'certbot-private-lineage')
            self.owned_directory(WORK, 'acme-webroot-and-workspace')
            self.directory(WORK + '/work', create=True)
            self.owned_directory(LOGS, 'acme-private-logs')
            if raw == original:
                self.write(CONFIG, challenge, mode=0o644, expected=raw)
                self.nginx_reload()
            self.probe_challenge(address)
            progress('issuing', 55)
            args = [executable, 'certonly', '--config', '/dev/null', '--no-directory-hooks', '--non-interactive', '--agree-tos', '--register-unsafely-without-email', '--no-eff-email', '--required-profile', 'shortlived', '--webroot', '--webroot-path', str(self.path(WORK + '/challenges')), '--ip-address', address, '--cert-name', 'vortex-panel-ip', '--server', CA, '--config-dir', str(self.path(ACME)), '--work-dir', str(self.path(WORK + '/work')), '--logs-dir', str(self.path(LOGS)), '--max-log-backups', '3']
            result = self.runner(args, timeout=240, check=False)
            need(result.returncode == 0, 'TLS_ISSUANCE')
            identity, cert = self.stage_candidate(address)
            progress('activating', 80)
            self.activate(identity, cert, job, state, address, port)
            self.timer()
            state['renewal'] = {'lastSuccessAt': timestamp(), 'errorCode': None}
            job.update(status='completed', phase='verified', progress=100, completedAt=timestamp())
            self.save(state)
            return self.inspect()
        except BaseException as error:
            code = getattr(error, 'code', 'TLS_COMMAND')
            # A CA/network failure keeps the previously serving certificate.
            # Never replace a concurrent administrator edit during recovery.
            try:
                self.rollback(job, state, address, port)
            except BaseException:
                code = 'TLS_RECOVERY'
            job.update(status='unknown' if code == 'TLS_RECOVERY' else 'failed', phase='recovery-required' if code == 'TLS_RECOVERY' else 'failed', errorCode=code, completedAt=timestamp())
            self.save(state)
            raise TLSError(code) from error

    def renew(self):
        state = self.state()
        if self.pending(state):
            self.recover({'revision': self.inspect()['revision'], 'confirmed': True})
            state = self.state()
        value = self.inspect()
        need(value['available'] and value['mode'] == 'public-ca', 'TLS_ACCESS')
        address, port = self.identity()
        self.owned_directory(ACME, 'certbot-private-lineage')
        self.owned_directory(WORK, 'acme-webroot-and-workspace')
        state['renewal'] = {**state.get('renewal', {}), 'status': 'running', 'id': str(uuid.uuid4()), 'lastAttemptAt': timestamp(), 'previousGeneration': self.active_generation(), 'previousConfig': base64.b64encode(self.read(CONFIG)).decode()}
        state['renewal'].pop('candidateGeneration', None)
        self.save(state)
        try:
            executable = self.runtime()
            self.owned_directory(LOGS, 'acme-private-logs')
            args = [executable, 'renew', '--config', '/dev/null', '--no-directory-hooks', '--non-interactive', '--cert-name', 'vortex-panel-ip', '--config-dir', str(self.path(ACME)), '--work-dir', str(self.path(WORK + '/work')), '--logs-dir', str(self.path(LOGS)), '--max-log-backups', '3']
            need(self.runner(args, timeout=240, check=False).returncode == 0, 'TLS_RENEW')
            identity, certificate = self.stage_candidate(address)
            self.activate(identity, certificate, state['renewal'], state, address, port)
            state['renewal'].update(status='completed', lastSuccessAt=timestamp(), errorCode=None)
        except BaseException as error:
            code = getattr(error, 'code', 'TLS_RENEW')
            try:
                self.rollback(state['renewal'], state, address, port)
            except BaseException:
                code = 'TLS_RECOVERY'
            state['renewal'].update(status='unknown' if code == 'TLS_RECOVERY' else 'failed', errorCode=code)
            self.save(state)
            raise TLSError(code) from error
        self.save(state)
        return self.inspect()

    @staticmethod
    def cleanup_roots():
        return {ACME: ('vortex-owner.json', {'schema': 1, 'owner': 'vortex-panel', 'purpose': 'certbot-private-lineage'}),
                MANAGED: ('vortex-owner.json', {'schema': 1, 'owner': 'vortex-panel', 'purpose': 'validated-certificate-generations'}),
                WORK: ('vortex-owner.json', {'schema': 1, 'owner': 'vortex-panel', 'purpose': 'acme-webroot-and-workspace'}),
                LOGS: ('vortex-owner.json', {'schema': 1, 'owner': 'vortex-panel', 'purpose': 'acme-private-logs'}),
                '/var/log/vortex-panel-acme': ('vortex-owner.json', {'schema': 1, 'owner': 'vortex-panel', 'purpose': 'acme-private-logs'}),
                RUNTIME: ('vortex-runtime.json', {'certbot': CERTBOT_VERSION})}

    def tree_inventory(self, name):
        base = self.directory(name)
        mounts = []
        for row in Path('/proc/self/mountinfo').read_text().splitlines():
            fields = row.split()
            if len(fields) > 4:
                mount = re.sub(r'\\([0-7]{3})', lambda item: chr(int(item[1], 8)), fields[4])
                mounts.append(Path(mount))
        need(not any(mount == base or base in mount.parents for mount in mounts), 'TLS_MOUNT')
        rows, seen = [], set()
        for current, directories, files in os.walk(base, followlinks=False):
            for target in [Path(current), *[Path(current) / child for child in sorted([*directories, *files])]]:
                relative = target.relative_to(base).as_posix()
                if relative in seen:
                    continue
                seen.add(relative)
                info = target.lstat()
                need(info.st_uid == os.geteuid(), 'TLS_OWNERSHIP')
                kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'link' if stat.S_ISLNK(info.st_mode) else None
                need(kind and (kind == 'link' or not info.st_mode & 0o022) and (kind == 'directory' or info.st_nlink == 1), 'TLS_OWNERSHIP')
                row = {'path': relative, 'kind': kind, 'dev': info.st_dev, 'ino': info.st_ino, 'mode': info.st_mode, 'uid': info.st_uid, 'links': info.st_nlink, 'size': info.st_size, 'mtime': info.st_mtime_ns}
                if kind == 'link':
                    row['target'] = os.readlink(target)
                    try:
                        actual = target.resolve(strict=False)
                    except RuntimeError as error:
                        raise TLSError('TLS_OWNERSHIP') from error
                    internal = actual == base or base in actual.parents
                    interpreter = name == RUNTIME and target.parent == base / 'bin' and re.fullmatch(r'python(?:3(?:\.[0-9]+)?)?', target.name) and actual == Path('/usr/bin/python3').resolve(strict=True)
                    need(internal or interpreter, 'TLS_OWNERSHIP')
                rows.append(row)
                need(len(rows) <= 20000, 'TLS_OWNERSHIP')
        return sorted(rows, key=lambda row: row['path'])

    def cleanup_inventory(self):
        trees = {}
        for name, (marker, expected) in self.cleanup_roots().items():
            if not os.path.lexists(self.path(name)):
                continue
            self.directory(name)
            need(json.loads(self.read(name + '/' + marker)) == expected, 'TLS_OWNERSHIP')
            trees[name] = self.tree_inventory(name)
        units = {}
        for suffix, raw in self.unit_templates().items():
            unit = UNIT + '.' + suffix
            name = '/etc/systemd/system/' + unit
            for prefix in ('/etc/systemd/system/', '/run/systemd/system/'):
                need(not os.path.lexists(self.path(prefix + unit + '.d')), 'TLS_EXTERNAL')
            if os.path.lexists(self.path(name)):
                need(self.read(name) == raw, 'TLS_EXTERNAL')
                units[name] = digest(raw)
            else:
                need(self.runner(['systemctl', 'is-active', '--quiet', unit], check=False).returncode != 0, 'TLS_EXTERNAL')
        return trees, units

    def operation_active(self):
        lock = self.path('/run/vortex-panel-tls/operation.lock')
        if not os.path.lexists(lock):
            return False
        self.directory('/run/vortex-panel-tls')
        info = lock.lstat()
        need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1 and not info.st_mode & 0o077, 'TLS_OWNERSHIP')
        fd = os.open(lock, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fd, fcntl.LOCK_UN)
                return False
            except BlockingIOError:
                return True
        finally:
            os.close(fd)

    def removal_plan(self, lock_held=False):
        any_owned = os.path.lexists(self.path(STATE)) or any(os.path.lexists(self.path(name)) for name in self.cleanup_roots()) or any(os.path.lexists(self.path('/etc/systemd/system/' + UNIT + '.' + suffix)) for suffix in self.unit_templates())
        if not any_owned:
            return {'owned': False, 'canCleanup': True, 'revision': digest(b'no-owned-vortex-tls'), 'components': []}
        try:
            need(lock_held or not self.operation_active(), 'TLS_BUSY')
            state = self.state()
            need(state.get('originalConfig'), 'TLS_RECOVERY')
            address, port = self.identity()
            original, challenge, active = self.configurations(state, address, port)
            raw = self.read(CONFIG) if os.path.lexists(self.path(CONFIG)) else None
            need(raw is None or raw in (original, challenge, active), 'TLS_EXTERNAL')
            trees, units = self.cleanup_inventory()
            # An external virtual host must never lose a certificate it uses.
            trace = self.runner(['nginx', '-T'], check=False)
            need(trace.returncode == 0, 'TLS_EXTERNAL')
            section = None
            for line in (trace.stdout + '\n' + getattr(trace, 'stderr', '')).splitlines():
                match = re.fullmatch(r'# configuration file (.+):', line)
                if match:
                    section = match[1]
                if any(name in line for name in (ACME, MANAGED, WORK, RUNTIME)):
                    need(section == CONFIG or section == str(self.path(CONFIG)), 'TLS_EXTERNAL')
            proof = {'schema': 1, 'state': digest(self.read(STATE)), 'config': digest(raw) if raw is not None else None, 'trees': trees, 'units': units}
            return {'owned': True, 'canCleanup': True, 'revision': digest(json.dumps(proof, sort_keys=True).encode()), 'components': [*trees, *units, STATE], 'configPath': CONFIG, 'currentConfigSHA256': proof['config'], 'restoredConfigSHA256': digest(original), 'configSHA256': proof['config'], 'originalConfigSHA256': digest(original)}
        except (OSError, ValueError, TLSError, subprocess.SubprocessError) as error:
            return {'owned': True, 'canCleanup': False, 'revision': digest(b'blocked-vortex-tls'), 'components': [], 'reasonCode': getattr(error, 'code', 'TLS_OWNERSHIP')}

    def restore_owned(self, request):
        need(isinstance(request, dict) and set(request) == {'revision', 'confirmed'} and isinstance(request.get('revision'), str) and re.fullmatch('[a-f0-9]{64}', request['revision']) and request.get('confirmed') is True, 'TLS_INPUT')
        plan = self.removal_plan(lock_held=True)
        need(plan['canCleanup'], plan.get('reasonCode', 'TLS_OWNERSHIP'))
        need(plan['revision'] == request['revision'], 'TLS_CHANGED')
        if not plan['owned']:
            return {'owned': False, 'restored': True, 'removed': []}
        state = self.state()
        address, port = self.identity()
        original, _challenge, _active = self.configurations(state, address, port)
        trees, units = self.cleanup_inventory()
        if units:
            self.runner(['systemctl', 'stop', *[Path(name).name for name in units]])
            if '/etc/systemd/system/' + UNIT + '.timer' in units:
                self.runner(['systemctl', 'disable', UNIT + '.timer'])
            for name in units:
                need(self.runner(['systemctl', 'is-active', '--quiet', Path(name).name], check=False).returncode != 0, 'TLS_BUSY')
        if os.path.lexists(self.path(CONFIG)):
            current = self.read(CONFIG)
            need(current in self.configurations(state, address, port), 'TLS_EXTERNAL')
            if current != original:
                self.write(CONFIG, original, mode=0o644, expected=current)
                self.nginx_reload()
                baseline = self.certificate('/etc/vortex-panel/tls/ip.crt', address)
                need(baseline, 'TLS_RECOVERY')
                self.tls_health(address, baseline['fingerprint'], '/etc/vortex-panel/tls/ip.crt')
        # Revalidate every private tree before deleting any of them. Symlinks
        # are inventoried and unlinked; directory traversal never follows them.
        for name, inventory in trees.items():
            need(self.tree_inventory(name) == inventory, 'TLS_CHANGED')
        for name in units:
            need(self.read(name) == self.unit_templates()[Path(name).suffix[1:]], 'TLS_EXTERNAL')
        removed = []
        for name, inventory in trees.items():
            base = self.path(name)
            for row in sorted(inventory, key=lambda item: (item['path'].count('/'), len(item['path'])), reverse=True):
                target = base if row['path'] == '.' else base / row['path']
                info = target.lstat()
                need((info.st_dev, info.st_ino, info.st_mode, info.st_uid) == (row['dev'], row['ino'], row['mode'], row['uid']), 'TLS_CHANGED')
                if row['kind'] != 'directory':
                    need((info.st_size, info.st_mtime_ns, info.st_nlink) == (row['size'], row['mtime'], row['links']), 'TLS_CHANGED')
                target.rmdir() if row['kind'] == 'directory' else target.unlink()
            removed.append(name)
        for name in units:
            self.path(name).unlink()
            removed.append(name)
        self.path(STATE).unlink()
        removed.append(STATE)
        if units:
            self.runner(['systemctl', 'daemon-reload'])
        need(all(not os.path.lexists(self.path(name)) for name in removed), 'TLS_RECOVERY')
        return {'owned': True, 'restored': True, 'removed': removed, 'configPath': CONFIG, 'configSHA256': digest(original), 'runtimeLock': '/run/vortex-panel-tls/operation.lock'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['inspect', 'issue', 'renew', 'auto', 'recover', 'removal-plan', 'restore-owned'])
    args = parser.parse_args()
    need(os.geteuid() == 0 and sys.platform == 'linux', 'TLS_PLATFORM')
    manager = TLSManager()
    manager.directory('/run/vortex-panel-tls', create=True)
    fd = os.open('/run/vortex-panel-tls/operation.lock', os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    info = os.fstat(fd)
    need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and not info.st_mode & 0o077)
    try:
        if args.action not in ('inspect', 'removal-plan'):
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise TLSError('TLS_BUSY') from None
        if args.action == 'removal-plan':
            print(json.dumps({'ok': True, 'tlsRemoval': manager.removal_plan()}))
            return
        if args.action == 'restore-owned':
            raw = sys.stdin.buffer.read(8193)
            need(len(raw) <= 8192, 'TLS_INPUT')
            print(json.dumps({'ok': True, 'tlsRemoval': manager.restore_owned(json.loads(raw))}))
            return
        if args.action == 'inspect':
            operation_active = False
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(fd, fcntl.LOCK_UN)
            except BlockingIOError:
                operation_active = True
            value = manager.inspect()
            value['operationActive'] = operation_active
        elif args.action == 'recover':
            raw = sys.stdin.buffer.read(8193)
            need(len(raw) <= 8192, 'TLS_INPUT')
            value = manager.recover(json.loads(raw))
        elif args.action == 'renew':
            value = manager.renew()
        else:
            if args.action == 'auto':
                before = manager.inspect()
                if before.get('recoveryRequired'):
                    before = manager.recover({'revision': before['revision'], 'confirmed': True})
                if before.get('mode') == 'public-ca' and before.get('automaticRenewal'):
                    value = before
                else:
                    value = manager.issue({'requestId': str(uuid.uuid4()), 'revision': before['revision'], 'confirmed': True, 'termsAccepted': True})
            else:
                raw = sys.stdin.buffer.read(8193)
                need(len(raw) <= 8192, 'TLS_INPUT')
                value = manager.issue(json.loads(raw))
        print(json.dumps({'ok': True, 'tls': value}))
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, TLSError, subprocess.SubprocessError) as error:
        print(json.dumps({'ok': False, 'code': getattr(error, 'code', 'TLS_COMMAND')}))
        sys.exit(1)
