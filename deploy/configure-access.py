#!/usr/bin/env python3
"""Owned IP HTTPS provisioning and explicitly requested public-port migration.

No production action occurs on import. The installer performs preflight before
installing nginx, then calls apply after its local PID health check. This helper
does not install packages, enable UFW, obtain ACME certificates, or change DNS.
Ordinary upgrades preserve access; explicit migrations require byte-exact owned
proxy/certificate receipts and restore the previous endpoint on verified failure.
"""
import argparse
import base64
import contextlib
import hashlib
import importlib.util
import ipaddress
import json
import os
import pathlib
import re
import secrets
import shlex
import shutil
import ssl
import stat
import subprocess
import sys
import time
import urllib.request


class AccessError(RuntimeError):
    pass


DEFAULT_PUBLIC_PORT = 19191


def public_port(value):
    if isinstance(value, bool) or not re.fullmatch(r'[1-9][0-9]{0,4}', str(value)) or not 1 <= int(value) <= 65535 or int(value) == 80:
        raise AccessError('Public HTTPS port must be between 1 and 65535 and separate from HTTP challenge port 80.')
    return int(value)


def public_url(address, port):
    return 'https://' + address + (':' + str(public_port(port)) if int(port) != 443 else '')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        # These are two fixed HTTPS identity sources. A redirect must never send
        # an installer request to a private address, HTTP endpoint or third host.
        return None


def public_ipv4(value):
    try:
        address = ipaddress.ip_address(value.strip())
    except (ValueError, AttributeError):
        raise AccessError('Public address must be a globally routable IPv4 address.') from None
    if address.version != 4 or not address.is_global:
        raise AccessError('Public address must be a globally routable IPv4 address.')
    return str(address)


def discover_address(fetch=None):
    if fetch is None:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()))

        def fetch(url):
            request = urllib.request.Request(url, headers={'User-Agent': 'Vortex-Panel-installer'})
            with opener.open(request, timeout=10) as response:
                if response.status != 200 or response.geturl() != url:
                    raise AccessError('Public-IP endpoint returned an unexpected response.')
                data = response.read(129)
                if len(data) > 128:
                    raise AccessError('Public-IP response exceeds its size limit.')
                return data.decode('ascii').strip()
    try:
        first = public_ipv4(fetch('https://api.ipify.org'))
        second = public_ipv4(fetch('https://checkip.amazonaws.com/'))
    except (OSError, ValueError, UnicodeError, AccessError) as error:
        raise AccessError('Public-IP detection failed; retry with --public-ip YOUR_PUBLIC_IPV4.') from error
    if first != second:
        raise AccessError('Public-IP sources disagree; use --public-ip YOUR_PUBLIC_IPV4 explicitly.')
    return first


class Runner:
    def __call__(self, args, *, check=True, timeout=30):
        result = subprocess.run(args, check=False, capture_output=True, text=True,
            timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
        if check and result.returncode:
            # Command output can contain private environment values; keep it out
            # of the public installer error. Diagnostics remain in the journal.
            raise AccessError('Command failed: ' + args[0] + ' ' + ' '.join(args[1:3]))
        return result


class AccessSetup:
    def __init__(self, root='/', run=None, sleep=time.sleep, owner_uid=0, public_port=443):
        self.root = pathlib.Path(root).resolve()
        self.run = run or Runner()
        self.sleep = sleep
        self.owner_uid = owner_uid
        # The library default retains byte-exact legacy templates. The installer
        # CLI explicitly selects the current public default for fresh installs.
        self.public_port = globals()['public_port'](public_port)
        self.config = '/etc/nginx/conf.d/vortex-panel.conf'
        self.directory = '/etc/vortex-panel'
        self.cert = self.directory + '/tls/ip.crt'
        self.key = self.directory + '/tls/ip.key'
        self.receipt = self.directory + '/access.json'
        self.env = '/etc/vortex-panel.env'

    def path(self, name):
        if not name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
            raise AccessError('Unsafe system path.')
        return self.root / name.lstrip('/')

    def real_directory(self, name, create=False, mode=0o755):
        directory = self.path(name)
        for parent in reversed([directory, *directory.parents]):
            if parent == self.root.parent or self.root not in (parent, *parent.parents):
                continue
            if not parent.exists() and create:
                parent.mkdir(mode=mode if parent == directory else 0o755)
            info = parent.lstat()
            # /tmp and /var/tmp can contain the installer's private recovery
            # directory. Their root-owned sticky bit protects the next component;
            # the final requested directory itself must never be shared-write.
            shared = info.st_mode & 0o022 and not (parent != directory and info.st_mode & stat.S_ISVTX)
            if not stat.S_ISDIR(info.st_mode) or (os.name != 'nt' and (shared or info.st_uid != self.owner_uid)):
                raise AccessError('System parent must be a real, root-owned directory without shared write access: ' + name)
        return directory

    def read_regular(self, name, limit=1048576):
        self.real_directory(str(pathlib.PurePosixPath(name).parent))
        target = self.path(name)
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (os.name != 'nt' and (info.st_mode & 0o022 or info.st_uid != self.owner_uid)) or info.st_size > limit:
            raise AccessError('System file is not a bounded, private root-owned regular file: ' + name)
        with os.fdopen(os.open(target, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as handle:
            data = handle.read(min(limit, info.st_size) + 1)
            final = os.fstat(handle.fileno())
        if len(data) > limit or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
            raise AccessError('System file changed during inspection: ' + name)
        return data

    def exclusive(self, name, data, mode=0o600):
        self.real_directory(str(pathlib.PurePosixPath(name).parent), create=True)
        descriptor = os.open(self.path(name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
        created = os.fstat(descriptor)
        try:
            with os.fdopen(descriptor, 'wb') as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
        except BaseException as error:
            try:
                current = self.path(name).lstat()
                if (current.st_dev, current.st_ino) != (created.st_dev, created.st_ino) or not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                    raise AccessError('Partial output changed concurrently; preserving it for recovery: ' + name) from error
                partial = self.read_regular(name, max(len(data), 1))
                if not data.startswith(partial):
                    raise AccessError('Partial output content changed concurrently; preserving it for recovery: ' + name) from error
                self.path(name).unlink()
            except FileNotFoundError:
                pass
            raise

    def replace_expected(self, name, old, new):
        if self.read_regular(name) != old:
            raise AccessError('A system file changed concurrently; preserving it: ' + name)
        temporary = name + '.vortex-' + secrets.token_hex(8)
        self.exclusive(temporary, new)
        try:
            if self.read_regular(name) != old:
                raise AccessError('A system file changed concurrently; preserving it: ' + name)
            os.replace(self.path(temporary), self.path(name))
        finally:
            if os.path.lexists(self.path(temporary)):
                self.path(temporary).unlink()

    def stock_nginx(self):
        """Permit a vendor nginx install, but never remove its default site."""
        base = self.path('/etc/nginx')
        if not os.path.lexists(base):
            return {}
        self.real_directory('/etc/nginx')
        result = self.run(['dpkg-query', '-W', '-f=${Conffiles}', 'nginx-common'])
        expected = {}
        for line in result.stdout.splitlines():
            match = re.fullmatch(r' (/etc/nginx/\S+) ([0-9a-f]{32})(?: obsolete)?', line)
            if match:
                expected[match[1]] = match[2]
        for required in ('/etc/nginx/nginx.conf', '/etc/nginx/sites-available/default'):
            if required not in expected:
                raise AccessError('An existing nginx configuration is unfamiliar; preserving it. Use --local-only or configure access explicitly.')
        snapshot = {}
        for name, digest in expected.items():
            if not os.path.lexists(self.path(name)):
                raise AccessError('An existing nginx package configuration is incomplete; preserving it.')
            data = self.read_regular(name)
            if hashlib.md5(data, usedforsecurity=False).hexdigest() != digest:
                raise AccessError('Existing nginx configuration was customized; preserving it. Use --local-only.')
            snapshot[name] = hashlib.sha256(data).hexdigest()
        for directory in ('/etc/nginx/conf.d', '/etc/nginx/sites-enabled'):
            self.real_directory(directory)
            for entry in self.path(directory).iterdir():
                name = '/' + entry.relative_to(self.root).as_posix()
                if name != '/etc/nginx/sites-enabled/default' or not entry.is_symlink() or os.readlink(entry) != '/etc/nginx/sites-available/default':
                    raise AccessError('An existing nginx site is unfamiliar; preserving it. Use --local-only.')
        # Ubuntu modules are enabled only by package-owned links. Custom module
        # includes could change listeners and are outside the automatic setup.
        modules = self.path('/etc/nginx/modules-enabled')
        if modules.exists():
            self.real_directory('/etc/nginx/modules-enabled')
            for entry in modules.iterdir():
                if not entry.is_symlink() or not os.readlink(entry).startswith('/usr/share/nginx/modules-available/'):
                    raise AccessError('An existing nginx module include is unfamiliar; preserving it.')
                target = os.readlink(entry)
                owner = self.run(['dpkg-query', '-S', target]).stdout.strip()
                if not re.fullmatch(r'libnginx-mod-[a-z0-9-]+(?::[a-z0-9]+)?: ' + re.escape(target), owner):
                    raise AccessError('An existing nginx module is not package-owned; preserving it.')
                snapshot[target] = hashlib.sha256(self.read_regular(target)).hexdigest()
        return snapshot

    def check_listeners(self, port=None):
        port = self.public_port if port is None else public_port(port)
        result = self.run(['ss', '-H', '-ltnp', '( sport = :80 or sport = :' + str(port) + ' )'])
        for line in result.stdout.splitlines():
            # ss is invoked as root; no PID/program information means ownership
            # is unknown and is therefore not safe to replace automatically.
            programs = re.findall(r'\("([^"\n]+)",pid=[0-9]+,fd=[0-9]+\)', line)
            if not programs or any(program != 'nginx' for program in programs):
                raise AccessError('TCP 80/' + str(port) + ' is already used by another service; preserving it. Use --local-only.')
            if len(line.split()) < 4 or line.split()[3].rsplit(':', 1)[-1] == str(port):
                raise AccessError('An existing HTTPS listener needs explicit configuration; preserving it.')

    def preflight(self, address=None):
        if self.public_port == 3000:
            raise AccessError('Panel loopback and public HTTPS ports must be different.')
        ip = public_ipv4(address) if address else discover_address()
        for name in (self.config, self.directory):
            if os.path.lexists(self.path(name)):
                raise AccessError('Public-access target already exists; preserving it: ' + name)
        stock = self.stock_nginx()
        self.check_listeners()
        return {'schema': 2, 'address': ip, 'publicPort': self.public_port, 'createdAt': int(time.time()),
            'nginxSnapshot': stock, 'id': secrets.token_hex(12)}

    def validate_plan(self, plan):
        keys = {'schema', 'address', 'createdAt', 'nginxSnapshot', 'id'}
        if not isinstance(plan, dict) or plan.get('schema') not in (1, 2) or set(plan) != (keys if plan.get('schema') == 1 else keys | {'publicPort'}):
            raise AccessError('Invalid public-access preflight plan.')
        port = public_port(plan.get('publicPort', 443))
        if public_ipv4(plan['address']) != plan['address']:
            raise AccessError('Public-address plan must use its canonical IPv4 spelling.')
        if not re.fullmatch(r'[0-9a-f]{24}', str(plan['id'])) or not isinstance(plan['createdAt'], int) or not 0 <= time.time() - plan['createdAt'] <= 21600:
            raise AccessError('Public-access plan is expired or invalid; run preflight again.')
        if not isinstance(plan['nginxSnapshot'], dict):
            raise AccessError('Invalid nginx snapshot.')
        for name, expected in plan['nginxSnapshot'].items():
            if not isinstance(name, str) or not name.startswith(('/etc/nginx/', '/usr/share/nginx/modules-available/')) or not re.fullmatch('[0-9a-f]{64}', str(expected)) or hashlib.sha256(self.read_regular(name)).hexdigest() != expected:
                raise AccessError('Existing nginx files changed after preflight; preserving them.')
        # Recheck the package baseline after dependency installation, including
        # the case where preflight ran before nginx was installed at all.
        self.stock_nginx()
        self.check_listeners(port)
        for name in (self.config, self.directory):
            if os.path.lexists(self.path(name)):
                raise AccessError('Public-access target appeared after preflight; preserving it: ' + name)

    def environment(self, address, https_port=None):
        https_port = self.public_port if https_port is None else public_port(https_port)
        old = self.read_regular(self.env)
        try:
            text = old.decode('utf-8')
        except UnicodeError:
            raise AccessError('Panel environment is not UTF-8.') from None
        values = {}
        for line in text.splitlines():
            if re.match(r'^(?:HOST|PORT|PUBLIC_URL|TRUST_PROXY)=', line):
                key, value = line.split('=', 1)
                if key in values:
                    raise AccessError('Duplicate panel access setting; preserving the environment.')
                values[key] = value.strip('"\r')
        if values.get('HOST') != '127.0.0.1' or values.get('TRUST_PROXY', '0') != '0' or values.get('PUBLIC_URL'):
            raise AccessError('Automatic public access requires a fresh local-only panel environment.')
        if not re.fullmatch(r'[0-9]{1,5}', values.get('PORT', '')) or not 1024 <= int(values['PORT']) <= 65535 or int(values['PORT']) == https_port:
            raise AccessError('Panel loopback port is invalid or conflicts with the HTTPS proxy.')
        lines = [line for line in text.splitlines() if not re.match(r'^(?:PUBLIC_URL|TRUST_PROXY)=', line)]
        new = ('\n'.join(lines) + '\nTRUST_PROXY=1\nPUBLIC_URL=' + public_url(address, https_port) + '\n').encode()
        return old, new, int(values['PORT'])

    def nginx_config(self, address, port, https_port=None):
        https_port = self.public_port if https_port is None else public_port(https_port)
        if int(port) == https_port:
            raise AccessError('Panel loopback and public HTTPS ports must be different.')
        # Replace forwarded IP/proto headers: trust only this single loopback hop.
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
'''.replace('https://ADDRESS', public_url(address, https_port)).replace('ADDRESS', address)
            .replace('listen 443 ssl;', 'listen ' + str(https_port) + ' ssl;')
            .replace('proxy_set_header Host $host;', 'proxy_set_header Host ' + ('$host' if https_port == 443 else '$http_host') + ';')
            .replace(':PORT;', ':' + str(port) + ';')).encode()

    def panel_pid(self):
        if self.run(['systemctl', 'is-active', '--quiet', 'vortex-panel'], check=False).returncode:
            raise AccessError('Panel service is not active.')
        pid = self.run(['systemctl', 'show', '--property', 'MainPID', '--value', 'vortex-panel']).stdout.strip()
        if not re.fullmatch(r'[1-9][0-9]*', pid):
            raise AccessError('Panel service PID is unavailable.')
        return pid

    def health(self, address, port, tls=False, https_port=None, system_trust=False):
        https_port = self.public_port if https_port is None else public_port(https_port)
        for attempt in range(20):
            try:
                pid = self.panel_pid()
                args = ['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '3']
                if tls:
                    if not system_trust:
                        args += ['--cacert', str(self.path(self.cert))]
                    args += ['--resolve', address + ':' + str(https_port) + ':127.0.0.1', public_url(address, https_port) + '/healthz']
                else:
                    args += ['http://127.0.0.1:' + str(port) + '/healthz']
                response = self.run(args, check=False, timeout=5)
                if len(response.stdout) > 65536:
                    raise AccessError('Health response exceeds its size limit.')
                if response.returncode == 0:
                    value = json.loads(response.stdout)
                    if value.get('ok') is True and value.get('service') in ('vortex-panel', 'vortex-mc') and value.get('processId') == int(pid) and self.panel_pid() == pid:
                        return pid
            except (AccessError, ValueError, TypeError, AttributeError):
                pass
            if attempt != 19:
                self.sleep(1)
        raise AccessError('TLS/PID readiness failed.' if tls else 'Panel PID readiness failed.')

    def ufw_added(self):
        return self.run(['ufw', 'show', 'added']).stdout

    def firewall_conflict(self, saved, port):
        """Do not add over an existing HTTP(S) rule, including its comments.

        Some UFW versions update an existing rule's comment when an otherwise
        identical allow is submitted. Conservatively preserve even restricted or
        deny HTTP rules; an administrator's existing network policy wins.
        """
        aliases = {'http', 'www', 'https', 'www-secure', 'nginx http', 'nginx https',
            'nginx full', 'apache', 'apache full', 'apache secure', 'www full'}
        for line in saved.splitlines():
            if not line.startswith('ufw '):
                continue
            try:
                tokens = shlex.split(line)
            except ValueError:
                raise AccessError('Unable to inspect existing firewall rules safely.') from None
            if 'comment' in tokens:
                tokens = tokens[:tokens.index('comment')]
            for token in tokens[2:]:
                if token.lower() in aliases and port in (80, 443):
                    return True
                match = re.fullmatch(r'([0-9,:]+)(?:/(tcp|udp))?', token)
                if not match or match[2] == 'udp':
                    continue
                for group in match[1].split(','):
                    limits = group.split(':')
                    if len(limits) == 1 and int(limits[0]) == port:
                        return True
                    if len(limits) == 2 and int(limits[0]) <= port <= int(limits[1]):
                        return True
        return False

    def firewall(self, transaction, https_port=None):
        https_port = self.public_port if https_port is None else public_port(https_port)
        if not shutil.which('ufw'):
            return
        status = self.run(['ufw', 'status'], check=False)
        if status.returncode:
            raise AccessError('Installed UFW status could not be inspected; preserving firewall policy.')
        if status.stdout.startswith('Status: inactive\n'):
            return
        if not status.stdout.startswith('Status: active\n'):
            raise AccessError('Installed UFW returned an unfamiliar status; preserving firewall policy.')
        for port in (80, https_port):
            comment = 'vortex-panel-' + transaction['id'] + '-' + str(port)
            before = self.ufw_added()
            if self.firewall_conflict(before, port):
                print('TCP ' + str(port) + ': existing UFW policy preserved; it may restrict outside access.')
                continue
            transaction['firewall'].append({'port': port, 'comment': comment, 'before': before, 'after': None, 'state': 'pending'})
            result = self.run(['ufw', 'allow', str(port) + '/tcp', 'comment', comment], check=False)
            after = self.ufw_added()
            entry = transaction['firewall'][-1]
            remaining = ''.join(line for line in after.splitlines(keepends=True) if comment not in line)
            if comment in after and comment not in before and remaining == before:
                entry['after'] = after
                entry['state'] = 'owned'
            elif after == before:
                entry['state'] = 'unchanged'
            else:
                raise AccessError('Unexpected firewall change; retained for manual review: ' + comment)
            if result.returncode:
                raise AccessError('Unable to add the owned HTTPS firewall rule.')

    def rollback(self, transaction):
        errors = []
        # Remove only exactly the files this invocation created, and only while
        # their bytes still match. Never overwrite concurrent administrator edits.
        for name, expected in reversed(transaction['files']):
            try:
                if self.read_regular(name) != expected:
                    raise AccessError('Owned file changed concurrently: ' + name)
                self.path(name).unlink()
            except (OSError, AccessError) as error:
                errors.append(str(error))
        if transaction['environment'] is not None:
            old, new = transaction['environment']
            try:
                self.replace_expected(self.env, new, old)
                self.run(['systemctl', 'restart', 'vortex-panel'])
            except (OSError, AccessError) as error:
                errors.append(str(error))
        try:
            self.run(['nginx', '-t'])
            if transaction['nginxActive']:
                self.run(['systemctl', 'reload', 'nginx'])
            else:
                self.run(['systemctl', 'stop', 'nginx'])
            if not transaction['nginxEnabled']:
                self.run(['systemctl', 'disable', 'nginx'])
        except (OSError, AccessError) as error:
            errors.append(str(error))
        for rule in reversed(transaction['firewall']):
            if rule['state'] == 'unchanged':
                continue
            if rule['state'] == 'pending':
                errors.append('Firewall mutation outcome is unknown; inspect owned comment: ' + rule['comment'])
                continue
            try:
                if self.ufw_added() != rule['after']:
                    raise AccessError('Firewall changed concurrently; keep owned rule for manual review: ' + rule['comment'])
                self.run(['ufw', '--force', 'delete', 'allow', str(rule['port']) + '/tcp', 'comment', rule['comment']])
                if self.ufw_added() != rule['before']:
                    raise AccessError('Firewall rollback needs review: ' + rule['comment'])
            except (OSError, AccessError) as error:
                errors.append(str(error))
        for directory in reversed(transaction['directories']):
            try:
                self.path(directory).rmdir()
            except OSError:
                pass  # Never recursively delete unknown or concurrently-created files.
        return errors

    def apply(self, plan):
        self.validate_plan(plan)
        https_port = public_port(plan.get('publicPort', 443))
        old, new, port = self.environment(plan['address'], https_port)
        transaction = {'id': plan['id'], 'files': [], 'directories': [], 'environment': None, 'firewall': [],
            'nginxActive': self.run(['systemctl', 'is-active', '--quiet', 'nginx'], check=False).returncode == 0,
            'nginxEnabled': self.run(['systemctl', 'is-enabled', '--quiet', 'nginx'], check=False).returncode == 0}
        try:
            for name in (self.directory, self.directory + '/tls'):
                self.real_directory(name, create=True, mode=0o700)
                transaction['directories'].append(name)
            # openssl writes only inside a private, exclusively-owned directory.
            try:
                self.run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365',
                    '-keyout', str(self.path(self.key)), '-out', str(self.path(self.cert)),
                    '-subj', '/CN=' + plan['address'], '-addext', 'subjectAltName=IP:' + plan['address'],
                    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'extendedKeyUsage=serverAuth'], timeout=90)
            finally:
                # A failed openssl process may have written only its private key.
                # Capture these owned partial outputs for the same strict rollback.
                for name in (self.key, self.cert):
                    if os.path.lexists(self.path(name)):
                        os.chmod(self.path(name), 0o600)
                        transaction['files'].append((name, self.read_regular(name)))
            config = self.nginx_config(plan['address'], port, https_port)
            self.exclusive(self.config, config, 0o644)
            transaction['files'].append((self.config, config))
            self.run(['nginx', '-t'])
            self.replace_expected(self.env, old, new)
            transaction['environment'] = (old, new)
            self.run(['systemctl', 'restart', 'vortex-panel'])
            self.health(plan['address'], port)
            self.run(['systemctl', 'enable', 'nginx'])
            self.run(['systemctl', 'reload' if transaction['nginxActive'] else 'start', 'nginx'])
            self.firewall(transaction, https_port)
            pid = self.health(plan['address'], port, tls=True, https_port=https_port)
            fingerprint = self.run(['openssl', 'x509', '-in', str(self.path(self.cert)), '-noout', '-fingerprint', '-sha256']).stdout.strip()
            receipt = {'schema': 1, 'id': plan['id'], 'url': public_url(plan['address'], https_port), 'publicPort': https_port,
                'certificate': 'self-signed-ip-san', 'fingerprint': fingerprint,
                'checkedPanelPid': int(pid), 'localTlsHealthVerified': True,
                'externalReachabilityVerified': False, 'createdAt': int(time.time())}
            data = (json.dumps(receipt, indent=2) + '\n').encode()
            self.exclusive(self.receipt, data)
            transaction['files'].append((self.receipt, data))
            return receipt
        except BaseException as error:
            recovery = self.rollback(transaction)
            if recovery:
                raise AccessError(str(error) + '; automatic recovery needs review: ' + '; '.join(recovery)) from error
            raise

    def access_values(self):
        raw = self.read_regular(self.env)
        values = {}
        for line in raw.decode('utf-8').splitlines():
            if re.match(r'^(?:HOST|PORT|PUBLIC_URL|TRUST_PROXY|DATA_DIR)=', line):
                key, value = line.split('=', 1)
                if key in values:
                    raise AccessError('Duplicate panel access setting; preserving the environment.')
                values[key] = value.strip('"\r')
        return raw, values

    def stored_tcp_conflict(self, values, target):
        """Inspect local allocations only; linked worker ports belong to that VPS."""
        name = values.get('DATA_DIR', '')
        if not name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:
            raise AccessError('Panel data directory cannot be verified for public-port migration.')
        filename = self.path(name.rstrip('/') + '/panel.json')
        # A normal service account may own its private data, but never adopt an
        # arbitrary user or a symlink/shared-write ancestor as allocation proof.
        owners = {self.owner_uid}
        if os.name != 'nt':
            import pwd
            unit = self.read_regular('/etc/systemd/system/vortex-panel.service').decode()
            users = re.findall(r'^User=(root|vortex-panel)$', unit, re.M)
            if len(users) != 1:
                raise AccessError('Panel service ownership cannot be verified for public-port migration.')
            owners.add(pwd.getpwnam(users[0]).pw_uid)
        for parent in reversed([filename.parent, *filename.parent.parents]):
            if parent != self.root and self.root not in parent.parents:
                continue
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or os.name != 'nt' and (info.st_uid not in owners or info.st_mode & 0o022):
                raise AccessError('Panel allocation directory ownership is unsafe; preserving access.')
        if not os.path.lexists(filename):
            return
        info = filename.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 64 * 1024 * 1024 or os.name != 'nt' and (info.st_uid not in owners or info.st_mode & 0o077):
            raise AccessError('Panel allocation inventory is unsafe; preserving access.')
        fd = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as stream:
            raw = stream.read(min(64 * 1024 * 1024, info.st_size) + 1)
            final = os.fstat(stream.fileno())
        if len(raw) > 64 * 1024 * 1024 or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns):
            raise AccessError('Panel allocation inventory changed during inspection.')
        value = json.loads(raw)
        if not isinstance(value, dict) or not isinstance(value.get('servers'), list) or len(value['servers']) > 100000:
            raise AccessError('Panel local allocation inventory is invalid.')
        for row in value['servers']:
            if not isinstance(row, dict) or row.get('kind', 'bedrock') not in ('bedrock', 'nodejs', 'python'):
                raise AccessError('Panel local allocation schema is unsupported.')
            kind, transport = row.get('kind', 'bedrock'), row.get('transport') or 'raknet'
            if kind == 'bedrock' and transport not in ('raknet', 'nethernet', 'auto'):
                raise AccessError('Panel local transport allocation is unsupported.')
            ports = [row.get('port')] if kind != 'bedrock' or transport in ('nethernet', 'auto') else []
            if kind == 'bedrock' and row.get('debugPort') is not None:
                ports.append(row['debugPort'])
            for port in ports:
                if isinstance(port, bool) or not re.fullmatch(r'[1-9][0-9]{0,4}', str(port)) or not 1 <= int(port) <= 65535:
                    raise AccessError('Panel local TCP allocation is invalid.')
                if int(port) == target:
                    raise AccessError('Public HTTPS port is reserved by a local server, including stopped servers; choose another port.')

    def tls_manager(self):
        filename = pathlib.Path(__file__).resolve().parents[1] / 'server/host-tls.py'
        spec = importlib.util.spec_from_file_location('vortex_access_tls', filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.TLSManager(root=self.root, runner=self.run)

    @contextlib.contextmanager
    def tls_lock(self):
        import fcntl
        self.real_directory('/run/vortex-panel-tls', create=True, mode=0o700)
        name = self.path('/run/vortex-panel-tls/operation.lock')
        fd = os.open(name, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != self.owner_uid or info.st_mode & 0o077:
                raise AccessError('TLS operation lock ownership is unsafe.')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise AccessError('A certificate operation is active; retry the public-port migration after it finishes.') from None
            yield
        finally:
            os.close(fd)

    def upgrade_plan(self, target, created_at=None, lock_held=False):
        target = public_port(target)
        created_at = int(time.time()) if created_at is None else created_at
        preserve = {'schema': 1, 'action': 'preserve', 'publicPort': target, 'createdAt': created_at}
        if not os.path.lexists(self.path(self.receipt)) or not os.path.lexists(self.path(self.config)):
            raise AccessError('Existing access is not an installer-owned IP proxy; configure its public port manually. Existing access was preserved.')
        try:
            env_raw, values = self.access_values()
            receipt_raw = self.read_regular(self.receipt)
            receipt = json.loads(receipt_raw)
            url = values.get('PUBLIC_URL', '')
            match = re.fullmatch(r'https://([0-9.]+)(?::([1-9][0-9]{0,4}))?', url)
            if not match or receipt.get('schema') != 1 or receipt.get('url') != url or not re.fullmatch('[a-f0-9]{24}', str(receipt.get('id', ''))) or values.get('HOST') != '127.0.0.1' or values.get('TRUST_PROXY') != '1':
                raise AccessError('Existing public access was customized; it was preserved.')
            address, before_port = public_ipv4(match[1]), public_port(match[2] or 443)
            if 'publicPort' in receipt and (type(receipt['publicPort']) is not int or receipt['publicPort'] != before_port):
                raise AccessError('The access HTTPS port receipt changed; existing access was preserved.')
            if not re.fullmatch(r'[0-9]{1,5}', values.get('PORT', '')) or not 1024 <= int(values['PORT']) <= 65535:
                raise AccessError('Panel loopback port is invalid.')
            backend = int(values['PORT'])
            if backend == target:
                raise AccessError('Panel loopback and public HTTPS ports must be different.')
            self.stored_tcp_conflict(values, target)
            if before_port != target and self.run(['ss', '-H', '-ltnp', '( sport = :' + str(target) + ' )']).stdout.strip():
                raise AccessError('The requested public HTTPS TCP port is already used; existing access was preserved.')
            old = self.nginx_config(address, backend, before_port)
            current = self.read_regular(self.config)
            cert = self.read_regular(self.cert)
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.decode())).hexdigest()
            if str(receipt.get('fingerprint', '')).split('=')[-1].replace(':', '').lower() != fingerprint:
                raise AccessError('The access certificate identity changed; existing access was preserved.')
            new = self.nginx_config(address, backend, target)
            files = []
            tls_path, tls_before, tls_after = '/etc/vortex-panel/tls-management.json', None, None
            mode, serving_fingerprint = 'self-signed', fingerprint
            if os.path.lexists(self.path(tls_path)):
                manager = self.tls_manager()
                state = manager.state()
                if manager.pending(state) or not lock_held and manager.operation_active():
                    raise AccessError('A certificate operation needs to finish before changing the public port.')
                if manager.identity() != (address, backend):
                    raise AccessError('TLS access identity changed.')
                original, challenge, active = manager.configurations(state, address, backend)
                if current not in (original, challenge, active) or original != old:
                    raise AccessError('The HTTPS configuration was customized; existing access was preserved.')
                manager.public_port = target
                next_challenge = manager.challenge_config(new, address)
                next_active = next_challenge.replace(b'/etc/vortex-panel/tls/ip.crt', b'/etc/vortex-panel/tls-managed/active/fullchain.pem').replace(b'/etc/vortex-panel/tls/ip.key', b'/etc/vortex-panel/tls-managed/active/privkey.pem')
                candidate = new if current == original else next_challenge if current == challenge else next_active
                if current == active:
                    mode = 'public-ca'
                    serving_fingerprint = manager.generation(manager.active_generation(), address)['fingerprint']
                tls_before = self.read_regular(tls_path)
                state.update(originalConfig=base64.b64encode(new).decode(), address=address, port=backend, publicPort=target)
                tls_after = (json.dumps(state, separators=(',', ':')) + '\n').encode()
            elif current == old:
                candidate = new
            else:
                raise AccessError('The HTTPS configuration was customized; existing access was preserved.')
            if before_port == target:
                return {**preserve, 'reason': 'The panel already uses the requested public HTTPS port.'}
            previous = receipt.get('previousPublicPorts', [])
            if not isinstance(previous, list) or len(previous) > 16 or any(public_port(port) != port for port in previous):
                raise AccessError('The prior public-port ownership history is invalid.')
            previous = sorted(set([*previous, before_port]) - {target})
            if len(previous) > 16:
                raise AccessError('Public-port ownership history requires review before another migration.')
            next_receipt = {**receipt, 'url': public_url(address, target), 'publicPort': target, 'previousPublicPorts': previous, 'updatedAt': created_at}
            next_env = re.sub(r'^PUBLIC_URL=.*$', 'PUBLIC_URL=' + public_url(address, target), env_raw.decode(), flags=re.M).encode()
            for name, before, after in [(self.config, current, candidate), (self.env, env_raw, next_env), (self.receipt, receipt_raw, (json.dumps(next_receipt, indent=2) + '\n').encode())]:
                files.append({'path': name, 'before': base64.b64encode(before).decode(), 'after': base64.b64encode(after).decode()})
            if tls_before is not None:
                files.append({'path': tls_path, 'before': base64.b64encode(tls_before).decode(), 'after': base64.b64encode(tls_after).decode()})
            return {'schema': 1, 'action': 'migrate', 'id': receipt['id'], 'createdAt': created_at, 'address': address, 'backendPort': backend, 'fromPublicPort': before_port, 'publicPort': target, 'mode': mode, 'fingerprint': serving_fingerprint, 'files': files}
        except (OSError, UnicodeError, ValueError) as error:
            raise AccessError('Existing access ownership could not be verified; it was preserved.') from error
        except RuntimeError as error:
            if isinstance(error, AccessError):
                raise
            raise AccessError('Existing TLS ownership could not be verified; it was preserved.') from error

    def apply_upgrade(self, plan):
        if not isinstance(plan, dict) or plan.get('schema') != 1 or plan.get('action') not in ('migrate', 'preserve') or not isinstance(plan.get('createdAt'), int) or not 0 <= time.time() - plan['createdAt'] <= 21600:
            raise AccessError('Public-port migration plan is invalid or expired.')
        target = public_port(plan.get('publicPort'))
        if plan['action'] == 'preserve':
            return {'preserved': True, 'reason': plan.get('reason', 'Existing access was preserved.')}
        with self.tls_lock():
            # Rebuild the fixed-path candidate from current ownership evidence;
            # the private plan cannot grant authority to write arbitrary paths.
            actual = self.upgrade_plan(target, created_at=plan['createdAt'], lock_held=True)
            if {key: value for key, value in actual.items() if key != 'createdAt'} != {key: value for key, value in plan.items() if key != 'createdAt'}:
                raise AccessError('Panel access changed after migration preflight; it was preserved.')
            applied, firewall = [], {'id': plan['id'], 'firewall': []}
            try:
                self.health(plan['address'], plan['backendPort'])
                self.firewall(firewall, target)
                for row in plan['files']:
                    before, after = base64.b64decode(row['before'], validate=True), base64.b64decode(row['after'], validate=True)
                    self.replace_expected(row['path'], before, after)
                    applied.append((row['path'], before, after))
                self.run(['nginx', '-t'])
                self.run(['systemctl', 'restart', 'vortex-panel'])
                self.health(plan['address'], plan['backendPort'])
                _raw, values = self.access_values()
                self.stored_tcp_conflict(values, target)
                self.run(['systemctl', 'reload', 'nginx'])
                self.health(plan['address'], plan['backendPort'], tls=True, https_port=target, system_trust=plan['mode'] == 'public-ca')
                manager = self.tls_manager()
                manager.identity()
                manager.tls_health(plan['address'], plan['fingerprint'], None if plan['mode'] == 'public-ca' else self.cert)
                return {'url': public_url(plan['address'], target), 'migrated': True, 'certificatePreserved': True}
            except BaseException as error:
                recovery = []
                for name, before, after in reversed(applied):
                    try:
                        self.replace_expected(name, after, before)
                    except (OSError, AccessError) as failure:
                        recovery.append(str(failure))
                try:
                    self.run(['nginx', '-t'])
                    self.run(['systemctl', 'restart', 'vortex-panel'])
                    self.run(['systemctl', 'reload', 'nginx'])
                    self.health(plan['address'], plan['backendPort'], tls=True, https_port=plan['fromPublicPort'], system_trust=plan['mode'] == 'public-ca')
                except (OSError, AccessError, subprocess.SubprocessError) as failure:
                    recovery.append(str(failure))
                # Added rules retain the same ownership and exact-diff rollback
                # as fresh provisioning. Existing rules are never reordered.
                for rule in reversed(firewall['firewall']):
                    if rule['state'] == 'unchanged':
                        continue
                    try:
                        if rule['state'] != 'owned' or self.ufw_added() != rule['after']:
                            raise AccessError('Public-port firewall recovery needs review.')
                        self.run(['ufw', '--force', 'delete', 'allow', str(rule['port']) + '/tcp', 'comment', rule['comment']])
                        if self.ufw_added() != rule['before']:
                            raise AccessError('Public-port firewall changed during recovery.')
                    except (OSError, AccessError, subprocess.SubprocessError) as failure:
                        recovery.append(str(failure))
                if recovery:
                    raise AccessError('Public-port migration failed; recovery needs review: ' + '; '.join(recovery)) from error
                raise AccessError('Public-port migration failed; the previous endpoint was restored.') from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'apply', 'preflight-upgrade', 'apply-upgrade'))
    parser.add_argument('--plan', required=True)
    parser.add_argument('--public-ip')
    parser.add_argument('--public-port', type=public_port)
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise AccessError('Run public-access provisioning as root.')
    setup = AccessSetup(public_port=args.public_port if args.public_port is not None else DEFAULT_PUBLIC_PORT)
    # Plans live in the installer's private recovery directory. Refuse symlinks,
    # shared-write parents, alternate owners, oversized files, and stale plans.
    plan_name = str(pathlib.Path(args.plan).absolute())
    if args.action == 'preflight':
        setup.exclusive(plan_name, (json.dumps(setup.preflight(args.public_ip)) + '\n').encode())
        print('Public HTTPS preflight passed.')
    elif args.action == 'preflight-upgrade':
        if args.public_ip or args.public_port is None:
            raise AccessError('Existing access migration requires --public-port and preserves its current IP.')
        plan = setup.upgrade_plan(args.public_port)
        setup.exclusive(plan_name, (json.dumps(plan) + '\n').encode())
        print('Public HTTPS migration preflight passed.' if plan['action'] == 'migrate' else plan['reason'])
    elif args.action == 'apply-upgrade':
        if args.public_ip or args.public_port is not None:
            raise AccessError('Apply uses only the reviewed migration plan.')
        result = setup.apply_upgrade(json.loads(setup.read_regular(plan_name, 4 * 1024 * 1024)))
        if result.get('preserved'):
            print(result['reason'])
        else:
            print('Panel URL: ' + result['url'])
            print('Public HTTPS port updated; certificate identity and server data were preserved.')
    else:
        if args.public_ip or args.public_port is not None:
            raise AccessError('Apply uses only the reviewed public-access plan.')
        receipt = setup.apply(json.loads(setup.read_regular(plan_name, 65536)))
        print('Panel URL: ' + receipt['url'])
        print('TLS: self-signed IP certificate; the browser requires your explicit trust decision.')
        print(receipt['fingerprint'])
        print('Local TLS/PID health verified. Provider firewalls/NAT and outside reachability were not changed or verified.')


if __name__ == '__main__':
    try:
        main()
    except (AccessError, OSError, ValueError, subprocess.SubprocessError) as error:
        print('Vortex public access: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
