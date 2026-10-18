"""Test-only private files/parser models. Never invokes host AppArmor or APT."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

spec = importlib.util.spec_from_file_location("isolation_helper", pathlib.Path(__file__).parents[1] / "deploy/application-isolation.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
POLICY = (pathlib.Path(__file__).parent / 'fixtures/apparmor-bwrap-userns-restrict-noble').read_bytes()


class Model(module.IsolationInstaller):
    def __init__(self, root):
        super().__init__(root, runner=self.command)
        for name in ("etc/apparmor.d", "var/lib", "tmp/transaction1", "tmp/transaction2"):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        self.calls = []
        self.profiles = {}
        self.fail_compile = self.fail_add = self.fail_receipt = self.fail_active_receipt = False
        self.probe_calls = []
        self.probe_profile = "unconfined"

    def prerequisites(self):
        return True

    def trusted(self, filename, *, directory=False, private=False, allow_tmp=False):
        # Windows has no Unix ownership/mode representation. The fixture owns a
        # fresh private tree and still checks real links/types/inode boundaries;
        # production ownership validation is exercised separately below.
        filename = pathlib.Path(filename)
        if self.root not in filename.parents and filename != self.root or filename.resolve() != filename:
            raise module.Unavailable("fixture-path-escape")
        value = filename.lstat()
        if filename.is_symlink() or directory and not filename.is_dir() or not directory and (not filename.is_file() or value.st_nlink != 1):
            raise module.Unavailable("fixture-path-unsafe")
        return value

    @contextlib.contextmanager
    def locked(self):
        self.state.mkdir(exist_ok=True)
        yield

    def loaded(self):
        return {name: row["mode"] for name, row in self.profiles.items()}

    def policy_inventory(self):
        return self.profiles.copy()

    def probe_bwrap_exec(self, label="unconfined"):
        self.probe_calls.append(label)
        if self.probe_profile != label:
            raise module.Unavailable("foreign-bwrap-exec-profile")
        return {"profile": label, "uid": 65534, "gid": 65534, "noNewPrivileges": True, "capabilitiesZero": True, "namespacesUnchanged": True, "argumentPipeHeldOpen": True}

    def distribution_profile(self):
        return POLICY, {"source": "inert-test-fixture"}

    def json_write(self, filename, value, **options):
        if filename == self.receipt and (self.fail_receipt or self.fail_active_receipt and value.get("state") == "active"):
            raise OSError("injected durable receipt ENOSPC")
        return super().json_write(filename, value, **options)

    def command(self, args, **options):
        args = [str(value) for value in args]
        self.calls.append(args)
        if "--skip-kernel-load" in args:
            if self.fail_compile:
                raise module.Unavailable("injected-compile-failure")
            return ""
        if "--names" in args:
            return "\n".join(module.PROFILE_NAMES)
        if "--add" in args:
            for name in module.PROFILE_NAMES[:1 if self.fail_add else 2]:
                self.profiles[name] = {"name": name, "attach": "/usr/bin/bwrap" if name == module.PROFILE_NAMES[0] else name, "mode": "enforce", "sha256": "a" * 64}
            if self.fail_add:
                raise module.Unavailable("injected-partial-load-failure")
            return ""
        if "--remove" in args:
            for name in module.PROFILE_NAMES:
                self.profiles.pop(name, None)
            return ""
        raise AssertionError("Unexpected fixture command: " + repr(args))

    def transaction(self, number=1):
        return self.root / "tmp" / ("transaction" + str(number)) / "operation.json"


class Checks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vortex-isolation-test-")
        self.root = pathlib.Path(self.temp.name).resolve()
        self.model = Model(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_policy_keeps_real_boundary_and_rejects_unconfined_abi_and_missing_stack(self):
        transformed = module.policy_bytes(POLICY)
        self.assertIn(b"profile vortex-bwrap /usr/bin/bwrap", transformed)
        self.assertIn(b"allow px /** -> vortex-bwrap//&vortex-unpriv-bwrap,", transformed)
        self.assertIn(b"audit deny capability,", transformed)
        for bad in (POLICY.replace(b"abi/4.0", b"abi/5.0"), POLICY.replace(b"attach_disconnected", b"unconfined"), POLICY.replace(b"audit deny capability,", b""), POLICY.replace(b"bwrap//&unpriv_bwrap", b"bwrap")):
            with self.assertRaises(module.Unavailable):
                module.policy_bytes(bad)

    def test_exact_verified_noble_fixture_changes_only_owned_profile_names_and_references(self):
        self.assertEqual(module.digest(POLICY), '11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9')
        transformed = module.policy_bytes(POLICY)
        inverse = transformed.replace(b'profile vortex-bwrap ', b'profile bwrap ').replace(b'profile vortex-unpriv-bwrap ', b'profile unpriv_bwrap ').replace(b'vortex-bwrap//&vortex-unpriv-bwrap', b'bwrap//&unpriv_bwrap').replace(b'&vortex-unpriv-bwrap', b'&unpriv_bwrap')
        self.assertEqual(inverse, POLICY)
        self.assertIn(b'allow pix /** -> &vortex-unpriv-bwrap,', transformed)
        self.assertNotIn(b'allow pix /** -> &vortex-bwrap', transformed)

    def test_noble_boundary_cannot_be_replaced_by_master_or_commented_capability_denial(self):
        for bad in (POLICY.replace(b'allow px /** -> bwrap//&unpriv_bwrap,', b'allow pix /** -> &bwrap//&unpriv_bwrap,'), POLICY.replace(b'audit deny capability,', b'# audit deny capability,'), POLICY.replace(b'allow pix /** -> &unpriv_bwrap,', b'# allow pix /** -> &unpriv_bwrap,'), POLICY.replace(b'allow px /** -> bwrap//&unpriv_bwrap,', b'# allow px /** -> bwrap//&unpriv_bwrap,')):
            with self.assertRaises(module.Unavailable):
                module.policy_bytes(bad)

    def test_fresh_prepare_and_exact_owned_rollback(self):
        result = self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(result["status"], "ready")
        self.assertFalse(result["globalSecuritySettingsChanged"])
        self.assertEqual(self.model.profile.read_bytes(), module.policy_bytes(POLICY))
        self.assertTrue(any("--add" in row for row in self.model.calls))
        self.assertFalse(any("--replace" in row for row in self.model.calls))
        self.assertEqual(self.model.rollback(module.OWNERS[0], self.model.transaction())["status"], "removed-owned-profile")
        self.assertFalse(self.model.profile.exists())
        self.assertFalse(self.model.profiles)

    def test_repeat_and_shared_owner_rollback_keep_other_service(self):
        self.model.prepare(module.OWNERS[0], self.model.transaction())
        extra = self.root / "tmp/transaction1/repeat.json"
        repeated = self.model.prepare(module.OWNERS[0], extra)
        self.assertFalse(repeated["addedOwner"])
        self.assertFalse(extra.exists())
        self.model.prepare(module.OWNERS[1], self.model.transaction(2))
        self.assertEqual(self.model.rollback(module.OWNERS[0], self.model.transaction())["status"], "retained-for-other-owner")
        self.assertTrue(self.model.profile.exists())
        self.assertEqual(set(json.loads(self.model.receipt.read_text())["owners"]), {module.OWNERS[1]})
        self.model.rollback(module.OWNERS[1], self.model.transaction(2))
        self.assertFalse(self.model.profile.exists())

    def test_foreign_profile_file_and_loaded_or_wildcard_attachments_are_preserved(self):
        foreign = self.root / "etc/apparmor.d/vendor"
        foreign.write_bytes(b"profile vendor /usr/bin/bwrap { }\n")
        with self.assertRaises(module.Unavailable):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(foreign.read_bytes(), b"profile vendor /usr/bin/bwrap { }\n")
        foreign.unlink()
        for name, attachment in (("other-bwrap", "other-bwrap"), ("vendor-wildcard", "/usr/bin/*"), ("vendor-opaque", "<unknown>")):
            self.model.profiles = {name: {"mode": "enforce", "attach": attachment}}
            with self.assertRaises(module.Unavailable):
                self.model.prepare(module.OWNERS[0], self.model.transaction())
            self.assertEqual(set(self.model.profiles), {name})
        self.assertFalse(self.model.calls)

    def test_compile_failure_never_creates_policy_or_transaction(self):
        self.model.fail_compile = True
        with self.assertRaises(module.Unavailable):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertFalse(self.model.profile.exists())
        self.assertFalse(self.model.transaction().exists())
        self.assertFalse(self.model.profiles)

    def test_partial_load_failure_retains_unknown_kernel_policy_and_recovery_anchors(self):
        self.model.profiles["other-service"] = {"mode": "enforce", "attach": "/usr/sbin/service", "sha256": "c" * 64}
        self.model.fail_add = True
        with self.assertRaises(module.Unavailable):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(set(self.model.profiles), {"other-service", module.PROFILE_NAMES[0]})
        self.assertTrue(self.model.profile.exists())
        self.assertTrue(self.model.receipt.exists())
        self.assertTrue(self.model.transaction().exists())
        self.assertFalse(any("--remove" in row for row in self.model.calls))

    def test_concurrent_foreign_same_name_before_add_failure_never_unloads_or_hides_recovery(self):
        command = self.model.command
        def concurrent(args, **options):
            if "--add" in args:
                self.model.profiles[module.PROFILE_NAMES[0]] = {"name": module.PROFILE_NAMES[0], "mode": "enforce", "attach": "/usr/bin/bwrap", "sha256": "f" * 64}
                raise module.Unavailable("EEXIST from concurrent foreign policy")
            return command(args, **options)
        self.model.runner = concurrent
        with self.assertRaisesRegex(module.Unavailable, "ownership-unknown"):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(self.model.profiles[module.PROFILE_NAMES[0]]["sha256"], "f" * 64)
        self.assertTrue(self.model.profile.exists())
        self.assertTrue(self.model.receipt.exists())
        self.assertTrue(self.model.transaction().exists())
        self.assertFalse(any("--remove" in row for row in self.model.calls))

    def test_successful_add_then_activation_commit_failure_rolls_back_only_matching_observed_hashes(self):
        self.model.fail_active_receipt = True
        with self.assertRaises(OSError):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertFalse(self.model.profiles)
        self.assertFalse(self.model.profile.exists())
        self.assertFalse(self.model.receipt.exists())
        self.assertTrue(any("--remove" in row for row in self.model.calls))

    def test_failed_receipt_write_rolls_back_only_exclusively_created_file(self):
        self.model.fail_receipt = True
        with self.assertRaises(OSError):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertFalse(self.model.profile.exists())
        self.assertFalse(self.model.transaction().exists())
        self.assertFalse(any("--add" in row for row in self.model.calls))

    def test_changed_profile_receipt_nonce_and_kernel_policy_refuse_destructive_rollback(self):
        self.model.prepare(module.OWNERS[0], self.model.transaction())
        original = self.model.profile.read_bytes()
        self.model.profile.write_bytes(original + b"# admin change\n")
        with self.assertRaises(module.Unavailable):
            self.model.rollback(module.OWNERS[0], self.model.transaction())
        self.assertTrue(self.model.profiles)
        self.model.profile.write_bytes(original)
        self.model.profiles[module.PROFILE_NAMES[0]]["sha256"] = "b" * 64
        with self.assertRaises(module.Unavailable):
            self.model.rollback(module.OWNERS[0], self.model.transaction())
        self.assertTrue(self.model.profile.exists())

    def test_tar_selects_only_exact_regular_bounded_member_never_extracting_other_paths(self):
        def archive(rows):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as output:
                for name, content, kind in rows:
                    item = tarfile.TarInfo(name)
                    item.mode = 0o644
                    item.type = kind
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        item.linkname = "/etc/shadow"
                    else:
                        item.size = len(content)
                    output.addfile(item, io.BytesIO(content))
            stream.seek(0)
            return stream
        valid = [("../../must-never-extract", b"outside", tarfile.REGTYPE), ("./" + module.MEMBER, POLICY, tarfile.REGTYPE)]
        self.assertEqual(module.select_profile_member(archive(valid)), POLICY)
        for rows in ([(module.MEMBER, b"", tarfile.SYMTYPE)], [(module.MEMBER, b"", tarfile.LNKTYPE)], [(module.MEMBER, b"x" * (module.MAX_PROFILE + 1), tarfile.REGTYPE)], valid + [(module.MEMBER, POLICY, tarfile.REGTYPE)]):
            with self.assertRaises(module.Unavailable):
                module.select_profile_member(archive(rows))
        self.assertFalse((self.root / "must-never-extract").exists())

    def test_package_acquisition_checks_candidate_sha_size_and_download_only(self):
        self.model.state.mkdir(exist_ok=True)
        content = b"inert signed repository artifact fixture"
        def command(args, **options):
            args = [str(value) for value in args]
            self.model.calls.append(args)
            if "policy" in args:
                return "apparmor-profiles:\n  Candidate: 4.0.fixture\n"
            if "show" in args:
                return "Package: apparmor-profiles\nVersion: 4.0.fixture\nSize: " + str(len(content)) + "\nSHA256: " + module.digest(content) + "\n"
            if "download" in args:
                (pathlib.Path(options["cwd"]) / "exact.deb").write_bytes(content)
                return ""
            raise AssertionError(args)
        self.model.runner = command
        self.model.trusted = lambda *args, **kwargs: None
        self.model.extract_member = lambda filename: POLICY
        result, origin = module.IsolationInstaller.distribution_profile(self.model)
        self.assertEqual(result, POLICY)
        self.assertEqual(origin["packageSHA256"], module.digest(content))
        self.assertTrue(any("download" in row for row in self.model.calls))
        self.assertFalse(any("install" in row for row in self.model.calls))
        original_read = self.model.read
        def corrupted(filename, *args, **options):
            data = original_read(filename, *args, **options)
            return data + b"corruption" if pathlib.Path(filename).suffix == ".deb" else data
        self.model.read = corrupted
        with self.assertRaises(module.Unavailable):
            module.IsolationInstaller.distribution_profile(self.model)

    def test_production_trust_rejects_nonroot_writable_linked_and_wrong_mode_metadata(self):
        target = self.root / "trusted-file"
        installer = module.IsolationInstaller(self.root)
        def metadata(mode=stat.S_IFREG | 0o600, uid=0, links=1):
            def observe(filename):
                return SimpleNamespace(st_mode=mode if filename == target else stat.S_IFDIR | 0o755, st_uid=uid if filename == target else 0, st_nlink=links if filename == target else 1)
            return observe
        with mock.patch.object(pathlib.Path, "resolve", lambda value, **_options: value):
            with mock.patch.object(pathlib.Path, "lstat", metadata()):
                installer.trusted(target, private=True)
            for options in ({"uid": 1234}, {"mode": stat.S_IFREG | 0o666}, {"links": 2}, {"mode": stat.S_IFLNK | 0o777}, {"mode": stat.S_IFREG | 0o644}):
                with mock.patch.object(pathlib.Path, "lstat", metadata(**options)):
                    with self.assertRaises(module.Unavailable):
                        installer.trusted(target, private=True)

    def test_symlink_and_unreceipted_owned_path_never_replace_foreign_bytes(self):
        self.model.profile.write_bytes(b"foreign file under the expected owned basename")
        with self.assertRaises((module.Unavailable, FileNotFoundError)):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(self.model.profile.read_bytes(), b"foreign file under the expected owned basename")
        self.assertFalse(self.model.calls)
        target = self.root / "foreign-target"
        target.write_bytes(b"preserve")
        self.model.profile.unlink()
        try:
            self.model.profile.symlink_to(target)
        except OSError:
            # Some Windows accounts cannot create links; the production trust
            # metadata test still exercises explicit symlink rejection.
            return
        with self.assertRaises((module.Unavailable, FileNotFoundError)):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(target.read_bytes(), b"preserve")


    def test_opaque_defaults_require_two_unconfined_exec_proofs_and_keep_foreign_hashes(self):
        foreign = {"mode": "enforce", "attach": "<unknown>", "sha256": "c" * 64}
        self.model.profiles["default-service"] = foreign.copy()
        result = self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(self.model.probe_calls, ["unconfined", "unconfined"])
        self.assertEqual(result["opaqueAttachmentProof"]["profile"], "unconfined")
        self.assertEqual(result["foreignProfileCount"], 1)
        self.assertEqual(self.model.profiles["default-service"], foreign)
        self.model.probe_profile = "vortex-bwrap (enforce)"
        self.model.prepare(module.OWNERS[1], self.model.transaction(2))
        self.assertEqual(self.model.probe_calls[-1], "vortex-bwrap (enforce)")
        self.model.rollback(module.OWNERS[1], self.model.transaction(2))
        self.model.rollback(module.OWNERS[0], self.model.transaction())
        self.assertEqual(self.model.profiles, {"default-service": foreign})

    def test_snap_read_rule_and_bwrap_comments_are_not_executable_attachments(self):
        source = b'''# bwrap is discussed in this comment, not declared.
profile snap-confine /{,usr/}lib/snapd/snap-confine {
 # nvidia handling, glob needs /usr/** and the launcher must be
 /usr/** r,
 /usr/bin/bwrap r,
}
'''
        filename = self.root / 'etc/apparmor.d/usr.lib.snapd.snap-confine.real'
        filename.write_bytes(source)
        self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(filename.read_bytes(), source)
        self.model.rollback(module.OWNERS[0], self.model.transaction())
        self.assertEqual(filename.read_bytes(), source)

    def test_named_quoted_multiline_and_implicit_unloaded_bwrap_policies_still_refuse(self):
        for source in (b'profile "vendor-bwrap" { /usr/** r, }', b'profile vendor\n "/usr/bin/bwrap" flags=(enforce)\n { }', b'"/usr/bin/bwrap" { }', b'/usr/bin/* { }', b'profile vendor /** { }', b'profile vendor /usr/bin/bwr\\ap { }', b'profile vendor /usr/{bin,sbin}/* { }'):
            with self.subTest(source=source):
                with self.assertRaisesRegex(module.Unavailable, 'foreign-bwrap-profile-file'):
                    module.check_profile_file(source)

    def test_ambiguous_unloaded_attachments_fail_closed_and_benign_named_policy_stays_allowed(self):
        for source in (b'profile vendor @{EXECUTABLE} { }', b'profile vendor\n', b'profile "unterminated'):
            with self.subTest(source=source):
                with self.assertRaisesRegex(module.Unavailable, 'ambiguous'):
                    module.check_profile_file(source)
        module.check_profile_file(b'profile vendor { /usr/bin/bwrap r, }\nprofile other /usr/bin/other flags=(enforce) { }')

    def test_actual_ubuntu_variable_and_nested_brace_headers_prove_nonmatching_without_name_allowlist(self):
        attachments = ('/usr/lib/@{multiarch}/qt{5,6}/libexec/QtWebEngineProcess', '/usr/bin/epiphany{,-browser}', '/{usr/lib/firefox{,-esr,-beta,-devedition,-nightly},opt/firefox}/firefox{,-esr,-bin}', '/usr/libexec/@{multiarch}/bazel/linux-sandbox', '/{{usr/bin,etc/alternatives}/notepadqq,usr/lib/notepadqq/notepadqq.sh}', '/usr/lib/@{multiarch}/opera/opera', '/usr/{lib/steam/bin_steam.sh,games/steam}')
        for attachment in attachments:
            with self.subTest(attachment=attachment):
                self.assertFalse(module.attachment_could_match_bwrap(attachment)[0])
                module.check_profile_file(('profile arbitrary ' + attachment + ' flags=(unconfined) { }').encode())

    def test_unknown_variables_are_path_supersets_and_only_allow_when_literals_exclude_bwrap(self):
        for attachment in ('@{ANY}', '@{ANY}/bin/bwrap', '/usr/@{ANY}/bwrap', '/usr/@{ANY}', '/usr/bin/@{ANY}', '/usr/@{ANY}/b[wr]rap'):
            self.assertTrue(module.attachment_could_match_bwrap(attachment)[0])
            with self.assertRaisesRegex(module.Unavailable, 'ambiguous'):
                module.check_profile_file(('profile vendor ' + attachment + ' { }').encode())
        for attachment in ('/usr/lib/@{ANY}/service', '/usr/bin/not-bwrap', '/opt/@{ANY}/bwrap'):
            self.assertFalse(module.attachment_could_match_bwrap(attachment)[0])

    def test_nested_literal_alternatives_detect_real_match_and_bound_unknown_syntax(self):
        for attachment in ('/{opt,{bin,usr/bin}}/{bwrap,other}', '/usr/{lib,bin}/{no,{bwrap,other}}', '/usr//bin/bwrap'):
            self.assertTrue(module.attachment_could_match_bwrap(attachment)[0])
            with self.assertRaisesRegex(module.Unavailable, 'foreign-bwrap-profile-file'):
                module.check_profile_file(('profile vendor ' + attachment + ' { }').encode())
        for attachment in ('/usr/{bin,lib', '/usr/bin/other}', '/usr/bin/[abc', '/usr/bin/[[:alpha:]]rap', '/usr/bin/@{bad-name}', '/' + '{a,b}' * 9):
            with self.assertRaises(module.Unavailable):
                module.attachment_could_match_bwrap(attachment)

    def test_opaque_matching_exec_profile_is_refused_before_policy_or_transaction(self):
        self.model.profiles["default-service"] = {"mode": "enforce", "attach": "<unknown>", "sha256": "c" * 64}
        self.model.probe_profile = "foreign-restrictive-profile (enforce)"
        with self.assertRaisesRegex(module.Unavailable, "foreign-bwrap-exec-profile"):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertFalse(self.model.profile.exists())
        self.assertFalse(self.model.transaction().exists())
        self.assertFalse(any("--add" in row for row in self.model.calls))

    def test_foreign_kernel_change_between_probes_aborts_add_without_reverting_foreign_state(self):
        self.model.profiles["default-service"] = {"mode": "enforce", "attach": "<unknown>", "sha256": "c" * 64}
        def acquire():
            self.model.profiles["default-service"]["sha256"] = "d" * 64
            return POLICY, {"source": "inert-test-fixture"}
        self.model.distribution_profile = acquire
        with self.assertRaisesRegex(module.Unavailable, "foreign-kernel-policy-changed-before-add"):
            self.model.prepare(module.OWNERS[0], self.model.transaction())
        self.assertEqual(self.model.profiles["default-service"]["sha256"], "d" * 64)
        self.assertFalse(self.model.profile.exists())
        self.assertFalse(self.model.receipt.exists())
        self.assertFalse(any("--add" in row or "--remove" in row for row in self.model.calls))

    def test_actual_exec_validator_rejects_wrong_binary_privileges_namespace_and_profile(self):
        value = {"executable": "/usr/bin/bwrap", "identity": [1, 2], "argv": ["/usr/bin/bwrap", "--args", "0"], "uids": [65534] * 4, "gids": [65534] * 4, "groups": [], "noNewPrivileges": "1", "capabilities": {key: "0000000000000000" for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")}, "namespaces": {"user": "user:[1]", "mnt": "mnt:[2]"}, "profile": "unconfined"}
        expected = {"uid": 65534, "gid": 65534, "executable": "/usr/bin/bwrap", "identity": [1, 2], "namespaces": value["namespaces"], "label": "unconfined"}
        self.assertEqual(module.validate_exec_observation(value, **expected)["profile"], "unconfined")
        for change in ({"executable": "/usr/bin/other"}, {"identity": [1, 3]}, {"argv": ["/usr/bin/bwrap", "--unshare-user"]}, {"uids": [0] * 4}, {"gids": [0] * 4}, {"groups": [0]}, {"noNewPrivileges": "0"}, {"capabilities": {"CapEff": "ff"}}, {"namespaces": {"user": "user:[different]", "mnt": "mnt:[2]"}}, {"profile": "other (enforce)"}):
            with self.assertRaises(module.Unavailable):
                module.validate_exec_observation({**value, **change}, **expected)

    def test_controlled_probe_uses_empty_held_pipe_and_terminates_only_direct_child_on_success_and_failure(self):
        model = self.model
        executable = str(model.p("/usr/bin/bwrap"))
        identity = SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFREG | 0o755)
        observation = {"executable": executable, "identity": [1, 2], "argv": [executable, "--args", "0"], "uids": [65534] * 4, "gids": [65534] * 4, "groups": [], "noNewPrivileges": "1", "capabilities": {key: "0" * 16 for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")}, "namespaces": {"user": "user:[1]", "mnt": "mnt:[2]"}, "profile": "unconfined"}
        model.trusted = lambda *_args, **_options: identity
        model.runner = lambda *_args, **_options: "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n"
        model.observe_bwrap = lambda _pid: observation
        events = []
        class Input:
            def close(self):
                events.append("close-input")
            def write(self, _value):
                raise AssertionError("Never feed arguments or code to the held parser")
        class Child:
            pid = 12345
            stdin = Input()
            stopped = False
            def poll(self):
                return 0 if self.stopped else None
            def terminate(self):
                events.append("terminate-direct")
                self.stopped = True
            def kill(self):
                raise AssertionError("Gracefully terminated fixture did not need force")
            def wait(self, **_options):
                events.append("wait-direct")
                return 0
        spawned = []
        def spawn(arguments, **options):
            spawned.append((arguments, options))
            return Child()
        with mock.patch.object(module.subprocess, "Popen", spawn), mock.patch.object(pathlib.Path, "lstat", lambda _path: identity), mock.patch.object(module.os, "readlink", lambda filename: "user:[1]" if pathlib.Path(filename).name == "user" else "mnt:[2]"):
            proof = module.IsolationInstaller.probe_bwrap_exec(model)
            self.assertEqual(proof["profile"], "unconfined")
            observation["profile"] = "foreign (enforce)"
            with self.assertRaises(module.Unavailable):
                module.IsolationInstaller.probe_bwrap_exec(model)
        self.assertEqual(events, ["terminate-direct", "wait-direct", "close-input"] * 2)
        for arguments, options in spawned:
            self.assertEqual(arguments[-3:], [executable, "--args", "0"])
            self.assertIn("--clear-groups", arguments)
            self.assertIn("--bounding-set=-all", arguments)
            self.assertEqual(options["stdin"], module.subprocess.PIPE)
            self.assertEqual(set(options["env"]), {"PATH", "LC_ALL", "LANG"})


if __name__ == "__main__":
    result = unittest.TextTestRunner(stream=io.StringIO()).run(unittest.defaultTestLoader.loadTestsFromTestCase(Checks))
    print(json.dumps({"passed": result.testsRun - len(result.failures) - len(result.errors), "failed": len(result.failures) + len(result.errors), "hostPolicyMutations": 0}))
    if result.failures or result.errors:
        for _, text in result.failures + result.errors:
            print(text, file=sys.stderr)
        raise SystemExit(1)
