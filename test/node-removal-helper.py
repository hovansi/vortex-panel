"""Offline real-file removal tests. Every host command and process is modeled."""
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import sys
import unittest
import uuid
from unittest import mock
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('removal', pathlib.Path(__file__).parents[1] / 'server/node-removal.py')
removal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(removal)


class RemovalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vortex-removal-helper-')
        self.addCleanup(self.temporary.cleanup)
        self.host = removal.Host(self.temporary.name, self.command, enforce_owner=False)
        self.node_id, self.request_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.commands, self.firewall = [], []
        self.active, self.enabled, self.extra_processes, self.loop_rows = True, True, [], []
        self.after_stop = None
        for relative in ['/opt/vortex-node/releases/legacy', '/etc/vortex-node', '/etc/systemd/system', '/var/lib/vortex-node/servers', '/var/lib/vortex-node/.storage', '/proc/self', '/proc/sys/kernel/random', '/run', '/var/lib/bedrock-panel', removal.WORK_BASE + '/' + self.request_id]:
            self.host.path(relative).mkdir(parents=True, exist_ok=True)
        self.release = self.host.install / 'releases/legacy'
        self.current = self.host.install / 'current'
        if os.name == 'nt':
            # Windows has no native directory symlink privilege in this runner.
            # Only activation-link primitives are modeled; every deleted file,
            # hash, hardlink, path check and preservation assertion stays real.
            self.current.write_text('fixture activation link')
            old_is_link, old_resolve = pathlib.Path.is_symlink, pathlib.Path.resolve
            self.link_mock = mock.patch.object(pathlib.Path, 'is_symlink', autospec=True, side_effect=lambda value: value == self.current or old_is_link(value))
            self.resolve_mock = mock.patch.object(pathlib.Path, 'resolve', autospec=True, side_effect=lambda value, *a, **kw: self.release if value == self.current else old_resolve(value, *a, **kw))
            self.link_mock.start(); self.addCleanup(self.link_mock.stop)
            self.resolve_mock.start(); self.addCleanup(self.resolve_mock.stop)
        else:
            self.current.symlink_to(self.release, target_is_directory=True)
        self.host.unit.write_text('ExecStart=' + json.dumps(str(self.host.path('/usr/bin/node'))) + ' ' + json.dumps(str(self.current / 'server/node-cli.js')) + ' serve\n')
        self.host.config.write_text(json.dumps({'schemaVersion': 1, 'nodeId': self.node_id, 'token': 'PRIVATE_TOKEN_FIXTURE', 'dataDir': str(self.host.data), 'tls': {'certFile': str(self.host.tls / 'tls.crt'), 'keyFile': str(self.host.tls / 'tls.key')}}))
        (self.host.tls / 'tls.crt').write_text('fixture certificate')
        (self.host.tls / 'tls.key').write_text('PRIVATE_KEY_FIXTURE')
        self.write_store()
        self.host.path('/proc/self/mountinfo').write_text('1 0 1:1 / / rw - ext4 /dev/root rw\n')
        self.host.path('/proc/sys/kernel/random/boot_id').write_text(str(uuid.uuid4()))
        (self.release / 'server.js').write_text('unproven legacy source bytes')
        (self.host.data / 'customer-note.txt').write_text('unrelated customer bytes')
        self.host.path('/var/lib/bedrock-panel/world-marker').write_text('separate legacy panel world bytes')
        self.host.processes = lambda: ([4242] if self.active else []) + self.extra_processes
        self.host.os_lock = contextlib.nullcontext
        self.host.zram = lambda cleanup=False: {'present': False, 'owned': False, 'components': []}
        cert = mock.patch.object(removal.ssl, 'PEM_cert_to_DER_cert', return_value=b'fixture certificate DER')
        cert.start(); self.addCleanup(cert.stop)

    def write_store(self, **fields):
        value = {'servers': [], 'jobs': [], 'users': [], 'settings': {}, **fields}
        (self.host.data / 'panel.json').write_text(json.dumps(value))

    def command(self, args, timeout=30, missing=False):
        self.commands.append(list(args))
        if args[0] == 'systemctl':
            if args[1] == 'show':
                name = next(v.split('=', 1)[1] for v in args if v.startswith('--property='))
                if name == 'LoadState':
                    return 'loaded' if args[2] == removal.UNIT else 'not-found'
                return {'FragmentPath': str(self.host.unit), 'DropInPaths': '', 'ActiveState': 'active' if self.active else 'inactive', 'MainPID': '4242' if self.active else '0', 'WorkingDirectory': str(self.release), 'ExecStart': '{ path=/usr/bin/node ; argv[]=/usr/bin/node ' + str(self.current / 'server/node-cli.js') + ' serve ; }', 'UnitFileState': 'enabled' if self.enabled else 'disabled'}.get(name, '')
            if args[1] == 'stop':
                self.active = False
                if self.after_stop:
                    self.after_stop()
            if args[1] == 'disable':
                self.enabled = False
            return ''
        if args[0] == 'losetup':
            return json.dumps({'loopdevices': self.loop_rows})
        if args[:3] == ['nft', '-j', 'list']:
            return '{"nftables":[]}'
        if args[:3] == ['ufw', 'show', 'added']:
            return '\n'.join(self.firewall)
        if args[:4] == ['ufw', '--force', 'delete', 'allow']:
            self.firewall.remove('ufw ' + ' '.join(args[3:]))
            return ''
        raise AssertionError('Unexpected host command: ' + repr(args))

    def prepared(self):
        plan = self.host.plan(self.node_id)
        (self.host.data / '.removal-intent.json').write_text(json.dumps({'nodeId': self.node_id, 'requestId': self.request_id, 'revision': plan['revision']}))
        return plan

    def assert_preserved(self):
        self.assertEqual((self.host.data / 'customer-note.txt').read_text(), 'unrelated customer bytes')
        self.assertEqual((self.release / 'server.js').read_text(), 'unproven legacy source bytes')
        self.assertEqual(self.host.path('/var/lib/bedrock-panel/world-marker').read_text(), 'separate legacy panel world bytes')

    def test_plan_reports_unproven_source_shared_tools_and_separate_panel(self):
        plan = self.host.plan(self.node_id)
        self.assertEqual(plan['status'], 'ready')
        self.assertTrue(plan['legacyOwnership'])
        self.assertFalse(plan['fullyClean'])
        retained = [v for v in plan['components'] if v['action'] == 'retain']
        self.assertTrue(any(v['path'] == str(self.host.install / 'releases') for v in retained))
        self.assertTrue(any(v['kind'] == 'legacy-panel' for v in retained))
        self.assertNotIn('PRIVATE_TOKEN_FIXTURE', json.dumps(plan))
        self.assertNotIn('PRIVATE_KEY_FIXTURE', json.dumps(plan))

    def test_nonempty_unknown_or_orphan_storage_and_native_activity_block(self):
        self.write_store(servers=[{'id': str(uuid.uuid4()), 'name': 'Must not delete'}])
        self.assertEqual(self.host.plan(self.node_id)['status'], 'blocked')
        self.write_store()
        orphan = self.host.data / '.storage/orphan.img'
        orphan.write_bytes(b'world image')
        self.assertEqual(self.host.plan(self.node_id)['status'], 'blocked')
        orphan.unlink()
        self.extra_processes = [9999]
        self.assertEqual(self.host.plan(self.node_id)['status'], 'blocked')
        self.extra_processes = []
        self.loop_rows = [{'back-file': str(self.host.data / '.storage/deleted.img') + ' (deleted)'}]
        self.assertEqual(self.host.plan(self.node_id)['status'], 'blocked')

    def test_wrong_node_stale_revision_and_hardlinked_config_never_stop_service(self):
        with self.assertRaises(removal.RemovalError):
            self.host.plan(str(uuid.uuid4()))
        plan = self.prepared()
        result = self.host.remove(self.node_id, self.request_id, 'a' * 64)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['effectStarted'])
        self.assertTrue(self.active)
        self.assertTrue(self.host.config.exists())
        os.link(self.host.config, self.host.tls / 'foreign-config-link')
        with self.assertRaises(removal.RemovalError):
            self.host.plan(self.node_id)
        self.assert_preserved()

    def test_actual_owned_files_removed_and_independent_verify_preserves_unknown_worlds(self):
        plan = self.prepared()
        result = self.host.remove(self.node_id, self.request_id, plan['revision'])
        self.assertEqual(result['status'], 'completed', result)
        self.assertFalse(self.active)
        self.assertFalse(self.enabled)
        self.assertFalse(self.host.unit.exists())
        self.assertFalse(self.host.config.exists())
        self.assertFalse(os.path.lexists(self.current))
        self.assertFalse((self.host.data / '.removal-intent.json').exists())
        self.assertTrue(self.host.verify(self.node_id, self.request_id)['verified'])
        self.assert_preserved()
        self.assertTrue(any(row['path'] == str(self.host.install / 'releases') for row in result['retained']))
        self.assertFalse(any('apt' in row or 'purge' in row for row in self.commands))

    def test_identity_substitution_after_stop_is_partial_and_never_claims_success(self):
        plan = self.prepared()
        self.after_stop = lambda: (self.host.tls / 'tls.key').write_text('changed by unrelated administrator')
        result = self.host.remove(self.node_id, self.request_id, plan['revision'])
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(result['effectStarted'])
        self.assertFalse(self.host.verify(self.node_id, self.request_id)['verified'])
        self.assertEqual((self.host.tls / 'tls.key').read_text(), 'changed by unrelated administrator')
        self.assert_preserved()

    def test_tagged_firewall_receipt_removes_exact_owned_tuple_and_keeps_foreign_policy(self):
        rule = {'source': '203.0.113.25', 'port': 8443, 'protocol': 'tcp', 'comment': 'vortex-agent:' + self.node_id}
        (self.host.tls / 'firewall-owner.json').write_text(json.dumps({'schemaVersion': 1, 'nodeId': self.node_id, 'rules': [rule]}))
        owned = 'ufw allow from 203.0.113.25 to any port 8443 proto tcp comment vortex-agent:' + self.node_id
        foreign = 'ufw allow from 192.0.2.30 to any port 8443 proto tcp comment customer-access'
        self.firewall = [foreign, owned]
        plan = self.prepared()
        result = self.host.remove(self.node_id, self.request_id, plan['revision'])
        self.assertEqual(result['status'], 'completed', result)
        self.assertEqual(self.firewall, [foreign])
        self.assert_preserved()

    def test_unsafe_compressed_swap_blocks_before_any_effect(self):
        self.host.zram = lambda cleanup=False: {'present': True, 'owned': True, 'canCleanup': False, 'components': [], 'blockers': ['ZRAM_PRESSURE']}
        plan = self.host.plan(self.node_id)
        self.assertEqual(plan['status'], 'blocked')
        self.assertTrue(any(row['code'] == 'REMOVAL_ZRAM_BUSY' for row in plan['blockers']))
        self.assertTrue(self.active)

    def test_prepare_without_launch_can_only_cancel_matching_intact_worker(self):
        self.prepared()
        proof = self.host.verify(self.node_id, self.request_id)
        self.assertTrue(proof['safeToCancel'])
        self.assertFalse(proof['verified'])
        self.host.abort(self.node_id, self.request_id)
        self.assertTrue(self.active)
        self.assertTrue(self.host.unit.exists())
        self.assertTrue(self.host.config.exists())
        self.assertFalse((self.host.data / '.removal-intent.json').exists())
        self.assert_preserved()

    def test_unfamiliar_installed_memory_helper_is_never_imported(self):
        del self.host.__dict__['zram']
        directory = self.host.path('/etc/vortex-zram'); directory.mkdir()
        (directory / 'owner.json').write_text(json.dumps({'role': 'worker', 'nodeId': self.node_id}))
        helper = self.host.path('/usr/local/libexec/vortex-host-zram.py'); helper.parent.mkdir(parents=True)
        marker = self.host.data / 'unknown-helper-executed'
        helper.write_text('import pathlib\npathlib.Path(' + repr(str(marker)) + ').write_text("must never execute")\n')
        with self.assertRaisesRegex(removal.RemovalError, 'differs from the packaged source'):
            self.host.plan(self.node_id)
        self.assertFalse(marker.exists())
        self.assertTrue(self.active)
        self.assert_preserved()


if __name__ == '__main__':
    unittest.main()
