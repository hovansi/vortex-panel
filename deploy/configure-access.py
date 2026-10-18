#!/usr/bin/env python3
"""Fresh-install IP HTTPS provisioning. Existing installations bypass this helper.

No production action occurs on import. The installer performs preflight before
installing nginx, then calls apply after its local PID health check. This helper
does not install packages, enable UFW, obtain ACME certificates, or change DNS.
"""
import argparse
import hashlib
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
    def __init__(self, root='/', run=None, sleep=time.sleep, owner_uid=0):
        self.root = pathlib.Path(root).resolve()
        self.run = run or Runner()
        self.sleep = sleep
        self.owner_uid = owner_uid
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
            data = handle.read(limit + 1)
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

    def check_listeners(self):
        result = self.run(['ss', '-H', '-ltnp', '( sport = :80 or sport = :443 )'])
        for line in result.stdout.splitlines():
            # ss is invoked as root; no PID/program information means ownership
            # is unknown and is therefore not safe to replace automatically.
            programs = re.findall(r'\("([^"\n]+)",pid=[0-9]+,fd=[0-9]+\)', line)
            if not programs or any(program != 'nginx' for program in programs):
                raise AccessError('TCP 80/443 is already used by another service; preserving it. Use --local-only.')
            if ':443 ' in line or ']:443 ' in line:
                raise AccessError('An existing HTTPS listener needs explicit configuration; preserving it.')

    def preflight(self, address=None):
        ip = public_ipv4(address) if address else discover_address()
        for name in (self.config, self.directory):
            if os.path.lexists(self.path(name)):
                raise AccessError('Public-access target already exists; preserving it: ' + name)
        stock = self.stock_nginx()
        self.check_listeners()
        return {'schema': 1, 'address': ip, 'createdAt': int(time.time()),
            'nginxSnapshot': stock, 'id': secrets.token_hex(12)}

    def validate_plan(self, plan):
        if not isinstance(plan, dict) or set(plan) != {'schema', 'address', 'createdAt', 'nginxSnapshot', 'id'} or plan['schema'] != 1:
            raise AccessError('Invalid public-access preflight plan.')
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
        self.check_listeners()
        for name in (self.config, self.directory):
            if os.path.lexists(self.path(name)):
                raise AccessError('Public-access target appeared after preflight; preserving it: ' + name)

    def environment(self, address):
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
        if not re.fullmatch(r'[0-9]{1,5}', values.get('PORT', '')) or not 1024 <= int(values['PORT']) <= 65535:
            raise AccessError('Panel loopback port is invalid or conflicts with the HTTPS proxy.')
        lines = [line for line in text.splitlines() if not re.match(r'^(?:PUBLIC_URL|TRUST_PROXY)=', line)]
        new = ('\n'.join(lines) + '\nTRUST_PROXY=1\nPUBLIC_URL=https://' + address + '\n').encode()
        return old, new, int(values['PORT'])

    def nginx_config(self, address, port):
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
'''.replace('ADDRESS', address).replace(':PORT;', ':' + str(port) + ';')).encode()

    def panel_pid(self):
        if self.run(['systemctl', 'is-active', '--quiet', 'vortex-panel'], check=False).returncode:
            raise AccessError('Panel service is not active.')
        pid = self.run(['systemctl', 'show', '--property', 'MainPID', '--value', 'vortex-panel']).stdout.strip()
        if not re.fullmatch(r'[1-9][0-9]*', pid):
            raise AccessError('Panel service PID is unavailable.')
        return pid

    def health(self, address, port, tls=False):
        for attempt in range(20):
            try:
                pid = self.panel_pid()
                args = ['curl', '--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '3']
                if tls:
                    args += ['--cacert', str(self.path(self.cert)), '--resolve', address + ':443:127.0.0.1', 'https://' + address + '/healthz']
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
                if token.lower() in aliases:
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

    def firewall(self, transaction):
        if not shutil.which('ufw'):
            return
        status = self.run(['ufw', 'status'], check=False)
        if status.returncode:
            raise AccessError('Installed UFW status could not be inspected; preserving firewall policy.')
        if status.stdout.startswith('Status: inactive\n'):
            return
        if not status.stdout.startswith('Status: active\n'):
            raise AccessError('Installed UFW returned an unfamiliar status; preserving firewall policy.')
        for port in (80, 443):
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
        old, new, port = self.environment(plan['address'])
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
            config = self.nginx_config(plan['address'], port)
            self.exclusive(self.config, config, 0o644)
            transaction['files'].append((self.config, config))
            self.run(['nginx', '-t'])
            self.replace_expected(self.env, old, new)
            transaction['environment'] = (old, new)
            self.run(['systemctl', 'restart', 'vortex-panel'])
            self.health(plan['address'], port)
            self.run(['systemctl', 'enable', 'nginx'])
            self.run(['systemctl', 'reload' if transaction['nginxActive'] else 'start', 'nginx'])
            self.firewall(transaction)
            pid = self.health(plan['address'], port, tls=True)
            fingerprint = self.run(['openssl', 'x509', '-in', str(self.path(self.cert)), '-noout', '-fingerprint', '-sha256']).stdout.strip()
            receipt = {'schema': 1, 'id': plan['id'], 'url': 'https://' + plan['address'],
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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'apply'))
    parser.add_argument('--plan', required=True)
    parser.add_argument('--public-ip')
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        raise AccessError('Run public-access provisioning as root.')
    setup = AccessSetup()
    # Plans live in the installer's private recovery directory. Refuse symlinks,
    # shared-write parents, alternate owners, oversized files, and stale plans.
    plan_name = str(pathlib.Path(args.plan).absolute())
    if args.action == 'preflight':
        setup.exclusive(plan_name, (json.dumps(setup.preflight(args.public_ip)) + '\n').encode())
        print('Public HTTPS preflight passed.')
    else:
        if args.public_ip:
            raise AccessError('--public-ip belongs to preflight, not apply.')
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
