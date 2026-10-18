"""Offline boundary fixtures for the real fresh-install access transaction."""
import hashlib
import email.message
import importlib.util
import io
import json
import os
import pathlib
import shutil
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.response
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('vortex_access', sys.argv[1])
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
IP = '8.8.4.4'  # Public address syntax fixture; all networking is forbidden.
OPENSSL = shutil.which('openssl')
if not OPENSSL and os.name == 'nt' and pathlib.Path('C:/Program Files/Git/usr/bin/openssl.exe').is_file():
    OPENSSL = 'C:/Program Files/Git/usr/bin/openssl.exe'


class Fixture:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.calls = []
        self.pid = 101
        self.listeners = ''
        self.nginx_active = True
        self.nginx_enabled = True
        self.bad_tls = False
        self.bad_pid = False
        self.bad_nginx = False
        self.partial_openssl = False
        self.real_openssl = False
        self.ufw = False
        self.ufw_active = False
        self.ufw_bad_status = False
        self.rules = []
        self.existing_ports = set()
        self.fail_ufw_port = None
        self.unknown_ufw = False
        self.after_tls = None
        self.conffiles = ''

    def write(self, name, data, mode=0o644):
        target = self.root / name.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        os.chmod(target, mode)

    def seed_nginx(self):
        files = {'/etc/nginx/nginx.conf': b'vendor nginx configuration\n',
            '/etc/nginx/sites-available/default': b'vendor default site\n'}
        for name, data in files.items():
            self.write(name, data)
        for directory in ('conf.d', 'sites-enabled', 'modules-enabled'):
            (self.root / 'etc/nginx' / directory).mkdir(exist_ok=True)
        self.conffiles = '\n'.join(' ' + name + ' ' + hashlib.md5(data).hexdigest() for name, data in files.items()) + '\n'

    def __call__(self, args, *, check=True, timeout=30):
        self.calls.append(args)
        code, output = 0, ''
        if args[0] == 'ss':
            output = self.listeners
        elif args[0] == 'dpkg-query':
            output = self.conffiles
        elif args[0] == 'openssl' and self.real_openssl:
            if not OPENSSL:
                raise AssertionError('Offline certificate test requires openssl (Ubuntu default or Git for Windows).')
            return access.Runner()([OPENSSL, *args[1:]], check=check, timeout=timeout)
        elif args[0] == 'openssl' and args[1] == 'req':
            pathlib.Path(args[args.index('-keyout') + 1]).write_bytes(b'fixture private key')
            if self.partial_openssl:
                raise access.AccessError('openssl fixture failed after writing key')
            pathlib.Path(args[args.index('-out') + 1]).write_bytes(b'fixture certificate')
        elif args[0] == 'openssl':
            output = 'sha256 Fingerprint=fixture\n'
        elif args[0] == 'nginx':
            code = 1 if self.bad_nginx else 0
            # The rollback test needs the restored vendor config to validate.
            if not (self.root / 'etc/nginx/conf.d/vortex-panel.conf').exists():
                code = 0
        elif args[0] == 'systemctl':
            action, service = args[1], args[-1]
            if action == 'is-active':
                code = 0 if service == 'bedrock-panel' or self.nginx_active else 3
            elif action == 'is-enabled':
                code = 0 if self.nginx_enabled else 1
            elif action == 'show':
                output = str(self.pid) + '\n'
            elif action == 'restart' and service == 'bedrock-panel':
                self.pid += 1
            elif service == 'nginx':
                if action in ('start', 'reload'):
                    self.nginx_active = True
                elif action == 'stop':
                    self.nginx_active = False
                elif action == 'enable':
                    self.nginx_enabled = True
                elif action == 'disable':
                    self.nginx_enabled = False
        elif args[0] == 'curl':
            tls = '--cacert' in args
            if tls and self.after_tls:
                self.after_tls()
            code = 60 if tls and self.bad_tls else 0
            output = json.dumps({'ok': True, 'service': 'vortex-mc', 'processId': self.pid + (1 if self.bad_pid else 0)})
        elif args[0] == 'ufw':
            if args[1] == 'status':
                output = 'Status: active\n' if self.ufw_active else 'Status: inactive\n'
                code = 1 if self.ufw_bad_status else 0
            elif args[1:3] == ['show', 'added']:
                output = '\n'.join(self.rules) + ('\n' if self.rules else '')
            elif args[1] == 'allow':
                port = int(args[2].split('/')[0])
                if port not in self.existing_ports:
                    self.rules.append('ufw ' + ' '.join(args[1:]))
                if port == self.fail_ufw_port:
                    code = 1
                if self.unknown_ufw:
                    raise subprocess.TimeoutExpired(args, 30)
            elif args[1:4] == ['--force', 'delete', 'allow']:
                self.rules.remove('ufw ' + ' '.join(args[3:]))
            else:
                raise AssertionError(args)
        else:
            raise AssertionError('Unexpected process: ' + repr(args))
        if code and check:
            raise access.AccessError('Injected command failure: ' + args[0])
        return subprocess.CompletedProcess(args, code, output, '')


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vortex-access-offline-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.fixture = Fixture(self.root)
        self.setup = access.AccessSetup(self.root, self.fixture, sleep=lambda _: None,
            owner_uid=os.getuid() if hasattr(os, 'getuid') else 0)
        self.environment = b'HOST=127.0.0.1\nPORT=3000\nDATA_DIR=/var/lib/bedrock-panel\nTRUST_PROXY=0\n'
        self.fixture.write('/etc/bedrock-panel.env', self.environment, 0o600)
        # Any accidental network call is a test failure, including discovery.
        self.network = patch('socket.socket.connect', side_effect=AssertionError('network forbidden'))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.which = patch.object(access.shutil, 'which', side_effect=lambda name: '/usr/sbin/ufw' if name == 'ufw' and self.fixture.ufw else None)
        self.which.start()
        self.addCleanup(self.which.stop)

    def plan(self):
        plan = self.setup.preflight(IP)
        self.fixture.seed_nginx()  # Simulate apt installing its untouched defaults.
        return plan

    def assert_restored(self):
        self.assertEqual((self.root / 'etc/bedrock-panel.env').read_bytes(), self.environment)
        self.assertFalse((self.root / 'etc/nginx/conf.d/vortex-panel.conf').exists())
        self.assertFalse((self.root / 'etc/vortex-panel').exists())
        self.assertEqual((self.root / 'etc/nginx/sites-available/default').read_bytes(), b'vendor default site\n')

    def test_discovery_agreement_and_invalid_values(self):
        self.assertEqual(access.discover_address(lambda _: IP), IP)
        values = iter([IP, '1.1.1.1'])
        with self.assertRaisesRegex(access.AccessError, 'disagree'):
            access.discover_address(lambda _: next(values))
        for value in ('127.0.0.1', '10.0.0.1', '169.254.169.254', '203.0.113.10', '::1', '8.8.4.4;echo nope', 'example.com'):
            with self.subTest(value=value), self.assertRaises(access.AccessError):
                self.setup.preflight(value)
        self.assertFalse((self.root / 'etc/vortex-panel').exists())

    def test_unknown_web_listener_prevents_mutation(self):
        self.fixture.listeners = 'LISTEN 0 128 0.0.0.0:443 0.0.0.0:* users:(("apache2",pid=12,fd=3))\n'
        with self.assertRaisesRegex(access.AccessError, 'another service'):
            self.setup.preflight(IP)
        self.assertFalse(any(call[0] == 'systemctl' for call in self.fixture.calls))
        self.assertFalse((self.root / 'etc/vortex-panel').exists())

    def test_ip_redirect_is_rejected_before_destination_request(self):
        calls = []
        def first_response(handler, request):
            calls.append(request.full_url)
            headers = email.message.Message()
            headers['Location'] = 'http://169.254.169.254/metadata'
            response = urllib.response.addinfourl(io.BytesIO(b''), headers, request.full_url, 302)
            response.msg = 'Found'
            return response
        with patch.object(access.urllib.request.HTTPSHandler, 'https_open', first_response):
            with self.assertRaisesRegex(access.AccessError, 'detection failed'):
                access.discover_address()
        self.assertEqual(calls, ['https://api.ipify.org'])

    def test_unknown_nginx_site_or_config_is_preserved(self):
        self.fixture.seed_nginx()
        site = self.root / 'etc/nginx/conf.d/customer.conf'
        site.write_text('customer existing bytes')
        with self.assertRaisesRegex(access.AccessError, 'unfamiliar'):
            self.setup.preflight(IP)
        self.assertEqual(site.read_text(), 'customer existing bytes')
        site.unlink()
        (self.root / 'etc/nginx/nginx.conf').write_text('customer custom main config')
        with self.assertRaisesRegex(access.AccessError, 'customized'):
            self.setup.preflight(IP)
        self.assertFalse((self.root / 'etc/vortex-panel').exists())

    def test_valid_install_verifies_tls_and_current_pid(self):
        result = self.setup.apply(self.plan())
        self.assertEqual(result['url'], 'https://' + IP)
        self.assertTrue(result['localTlsHealthVerified'])
        self.assertFalse(result['externalReachabilityVerified'])
        self.assertEqual(result['checkedPanelPid'], self.fixture.pid)
        self.assertIn(b'PUBLIC_URL=https://' + IP.encode(), (self.root / 'etc/bedrock-panel.env').read_bytes())
        tls = next(call for call in self.fixture.calls if call[0] == 'curl' and '--cacert' in call)
        self.assertIn(IP + ':443:127.0.0.1', tls)
        self.assertNotIn('--insecure', tls)
        config = (self.root / 'etc/nginx/conf.d/vortex-panel.conf').read_text()
        self.assertIn('X-Forwarded-For $remote_addr;', config)
        self.assertIn('proxy_set_header Upgrade $http_upgrade;', config)
        self.assertNotIn('default_server', config)
        self.assertFalse(any(call[0] == 'ufw' for call in self.fixture.calls))
        self.assertEqual((self.root / 'etc/nginx/sites-available/default').read_bytes(), b'vendor default site\n')

    def test_tls_failure_rolls_back_only_owned_changes(self):
        plan = self.plan()
        self.fixture.bad_tls = True
        self.fixture.ufw = self.fixture.ufw_active = True
        self.fixture.rules = ['ufw allow 22/tcp comment customer-ssh']
        with self.assertRaisesRegex(access.AccessError, 'TLS/PID'):
            self.setup.apply(plan)
        self.assert_restored()
        self.assertEqual(self.fixture.rules, ['ufw allow 22/tcp comment customer-ssh'])

    def test_wrong_health_pid_never_passes(self):
        plan = self.plan()
        self.fixture.bad_pid = True
        with self.assertRaisesRegex(access.AccessError, 'PID readiness'):
            self.setup.apply(plan)
        self.assert_restored()

    def test_nginx_invalid_configuration_restores_files(self):
        plan = self.plan()
        self.fixture.bad_nginx = True
        with self.assertRaisesRegex(access.AccessError, 'nginx'):
            self.setup.apply(plan)
        self.assert_restored()
        self.assertFalse(any(call[:3] == ['systemctl', 'restart', 'bedrock-panel'] for call in self.fixture.calls))

    def test_partial_certificate_failure_cleans_own_key(self):
        plan = self.plan()
        self.fixture.partial_openssl = True
        with self.assertRaisesRegex(access.AccessError, 'openssl'):
            self.setup.apply(plan)
        self.assert_restored()

    def test_existing_firewall_rule_is_never_deleted(self):
        plan = self.plan()
        self.fixture.bad_tls = True
        self.fixture.ufw = self.fixture.ufw_active = True
        self.fixture.existing_ports = {80}
        self.fixture.rules = ['ufw allow 80/tcp comment customer-web']
        with self.assertRaises(access.AccessError):
            self.setup.apply(plan)
        self.assertEqual(self.fixture.rules, ['ufw allow 80/tcp comment customer-web'])
        self.assertFalse(any(call[:5] == ['ufw', '--force', 'delete', 'allow', '80/tcp'] for call in self.fixture.calls))
        self.assert_restored()

    def test_disabled_firewall_remains_disabled(self):
        self.fixture.ufw = True
        self.setup.apply(self.plan())
        self.assertFalse(any(call[0] == 'ufw' and call[1] != 'status' for call in self.fixture.calls))

    def test_uninspectable_firewall_never_reports_success(self):
        plan = self.plan()
        self.fixture.ufw = self.fixture.ufw_bad_status = True
        with self.assertRaisesRegex(access.AccessError, 'status could not be inspected'):
            self.setup.apply(plan)
        self.assert_restored()
        self.assertFalse(any(call[:2] == ['ufw', 'allow'] for call in self.fixture.calls))

    def test_ufw_failure_after_mutation_rolls_back_owned_rule(self):
        plan = self.plan()
        self.fixture.ufw = self.fixture.ufw_active = True
        self.fixture.fail_ufw_port = 443
        with self.assertRaisesRegex(access.AccessError, 'firewall'):
            self.setup.apply(plan)
        self.assert_restored()
        self.assertEqual(self.fixture.rules, [])

    def test_uncertain_firewall_outcome_requires_manual_recovery(self):
        plan = self.plan()
        self.fixture.ufw = self.fixture.ufw_active = self.fixture.unknown_ufw = True
        with self.assertRaisesRegex(access.AccessError, 'mutation outcome is unknown'):
            self.setup.apply(plan)
        self.assert_restored()
        self.assertEqual(len(self.fixture.rules), 1)
        self.assertIn('vortex-panel-' + plan['id'], self.fixture.rules[0])
        self.assertFalse(any(call[:3] == ['ufw', '--force', 'delete'] for call in self.fixture.calls))

    def test_existing_complex_firewall_rules_keep_their_comments(self):
        plan = self.plan()
        self.fixture.ufw = self.fixture.ufw_active = True
        self.fixture.rules = ['ufw allow proto tcp from any to any port 80 comment customer-web',
            "ufw allow 'Nginx Full' comment customer-nginx"]
        before = list(self.fixture.rules)
        self.setup.apply(plan)
        self.assertEqual(self.fixture.rules, before)
        self.assertFalse(any(call[:2] == ['ufw', 'allow'] for call in self.fixture.calls))

    def test_partial_exclusive_write_does_not_leave_candidate_config(self):
        plan = self.plan()
        with patch.object(access.os, 'fsync', side_effect=OSError('fixture storage full')):
            with self.assertRaisesRegex(OSError, 'storage full'):
                self.setup.apply(plan)
        self.assert_restored()

    def test_partial_write_never_removes_concurrently_changed_bytes(self):
        plan = self.plan()
        def administrator_edit(descriptor):
            os.lseek(descriptor, 0, os.SEEK_SET)
            os.write(descriptor, b'administrator bytes')
            os.ftruncate(descriptor, len(b'administrator bytes'))
            raise OSError('fixture fsync failure after concurrent edit')
        with patch.object(access.os, 'fsync', side_effect=administrator_edit):
            with self.assertRaisesRegex(access.AccessError, 'content changed concurrently'):
                self.setup.apply(plan)
        self.assertEqual((self.root / 'etc/nginx/conf.d/vortex-panel.conf').read_bytes(), b'administrator bytes')
        self.assertEqual((self.root / 'etc/bedrock-panel.env').read_bytes(), self.environment)

    def test_actual_generated_certificate_passes_ip_tls_verification(self):
        plan = self.plan()
        self.fixture.real_openssl = True
        self.setup.apply(plan)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(str(self.setup.path(self.setup.cert)), str(self.setup.path(self.setup.key)))
        client_context = ssl.create_default_context(cafile=str(self.setup.path(self.setup.cert)))
        def handshake(hostname):
            incoming_client, outgoing_client = ssl.MemoryBIO(), ssl.MemoryBIO()
            incoming_server, outgoing_server = ssl.MemoryBIO(), ssl.MemoryBIO()
            client = client_context.wrap_bio(incoming_client, outgoing_client, server_hostname=hostname)
            server = server_context.wrap_bio(incoming_server, outgoing_server, server_side=True)
            client_ready = server_ready = False
            for _ in range(100):
                try:
                    client.do_handshake()
                    client_ready = True
                except ssl.SSLWantReadError:
                    pass
                incoming_server.write(outgoing_client.read())
                try:
                    server.do_handshake()
                    server_ready = True
                except ssl.SSLWantReadError:
                    pass
                incoming_client.write(outgoing_server.read())
                if client_ready and server_ready:
                    return client.version()
            self.fail('In-memory TLS handshake did not complete')
        self.assertIn(handshake(IP), ('TLSv1.2', 'TLSv1.3'))
        with self.assertRaises(ssl.SSLCertVerificationError):
            handshake('1.1.1.1')

    def test_concurrent_administrator_file_edit_is_preserved(self):
        plan = self.plan()
        self.fixture.bad_tls = True
        def edit():
            (self.root / 'etc/nginx/conf.d/vortex-panel.conf').write_bytes(b'administrator edit')
        self.fixture.after_tls = edit
        with self.assertRaisesRegex(access.AccessError, 'recovery needs review'):
            self.setup.apply(plan)
        self.assertEqual((self.root / 'etc/nginx/conf.d/vortex-panel.conf').read_bytes(), b'administrator edit')
        self.assertEqual((self.root / 'etc/bedrock-panel.env').read_bytes(), self.environment)

    def test_plan_expiry_and_changed_baseline_prevent_mutation(self):
        plan = self.plan()
        plan['createdAt'] -= 21601
        with self.assertRaisesRegex(access.AccessError, 'expired'):
            self.setup.apply(plan)
        self.assertFalse((self.root / 'etc/vortex-panel').exists())
        plan['createdAt'] += 21601
        (self.root / 'etc/nginx/nginx.conf').write_text('changed during apt')
        with self.assertRaisesRegex(access.AccessError, 'customized'):
            self.setup.apply(plan)
        self.assertFalse((self.root / 'etc/vortex-panel').exists())

    def test_existing_public_environment_is_not_reconfigured(self):
        plan = self.plan()
        self.fixture.write('/etc/bedrock-panel.env', self.environment + b'PUBLIC_URL=https://example.com\n', 0o600)
        with self.assertRaisesRegex(access.AccessError, 'fresh local-only'):
            self.setup.apply(plan)
        self.assertFalse((self.root / 'etc/vortex-panel').exists())


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], sys.argv[2]], verbosity=2)
