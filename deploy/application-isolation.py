#!/usr/bin/env python3
"""Optional Ubuntu AppArmor setup. No sysctl, package install or foreign policy writes.

Use only the distribution's bwrap-userns-restrict policy. The two profile names
are namespaced for ownership; its attachment and capability-denying child stack
are preserved. A missing extra profile is obtained as one SHA-verified .deb
member, never by installing or extracting the whole apparmor-profiles package.
"""
import argparse
import contextlib
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import shlex
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None

PROFILE_NAMES = ("vortex-bwrap", "vortex-unpriv-bwrap")
MEMBER = "usr/share/apparmor/extra-profiles/bwrap-userns-restrict"
MAX_PROFILE = 65536
MAX_PACKAGE = 32 * 1024 ** 2
OWNERS = ("vortex-panel.service", "bedrock-panel.service", "vortex-node.service")
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class Unavailable(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def attachment_could_match_bwrap(attachment):
    """Bounded AARE overapproximation: unresolved values can match any path.

    Python fnmatch's stars may include slashes, and character classes become '?'.
    These are intentional supersets: a negative result proves no bwrap match;
    a positive unresolved result must be refused, never assumed safe.
    """
    if len(attachment) > 4096 or '\\' in attachment:
        raise Unavailable('foreign-profile-attachment-ambiguous')
    unresolved = '@{' in attachment or '[' in attachment
    pattern = re.sub(r'@\{[A-Za-z0-9_]+\}', '*', attachment)
    if '@{' in pattern:
        raise Unavailable('foreign-profile-attachment-ambiguous')
    masked = []
    index = 0
    while index < len(pattern):
        if pattern[index] == '[':
            end = pattern.find(']', index + 1)
            if end == -1 or end == index + 1 or '[' in pattern[index + 1:end]:
                raise Unavailable('foreign-profile-attachment-ambiguous')
            masked.append('?')
            index = end + 1
        else:
            masked.append(pattern[index])
            index += 1
    values = []
    def expand(value, depth=0):
        if depth > 8 or len(values) >= 128:
            raise Unavailable('foreign-profile-attachment-expansion-bound')
        start = value.find('{')
        if start == -1:
            if '}' in value:
                raise Unavailable('foreign-profile-attachment-ambiguous')
            # The distro parser normalizes repeated path slashes. Normalizing
            # even leading/trailing slashes here is a conservative superset.
            values.append(re.sub(r'/+', '/', value).rstrip('/') or '/')
            if sum(map(len, values)) > 65536:
                raise Unavailable('foreign-profile-attachment-expansion-bound')
            return
        if '}' in value[:start]:
            raise Unavailable('foreign-profile-attachment-ambiguous')
        nesting = 1
        alternatives = []
        previous = start + 1
        for cursor in range(start + 1, len(value)):
            if value[cursor] == '{':
                nesting += 1
            elif value[cursor] == '}':
                nesting -= 1
                if nesting == 0:
                    alternatives.append(value[previous:cursor])
                    for alternative in alternatives:
                        expand(value[:start] + alternative + value[cursor + 1:], depth + 1)
                    return
            elif value[cursor] == ',' and nesting == 1:
                alternatives.append(value[previous:cursor])
                previous = cursor + 1
        raise Unavailable('foreign-profile-attachment-ambiguous')
    expand(''.join(masked))
    return any(fnmatch.fnmatchcase('/usr/bin/bwrap', value) for value in values), unresolved


def check_profile_file(data):
    """Check declarations, never permission rules/comments containing paths.

    This is a conservative header recognizer, not an AppArmor compiler. An
    unresolved attachment fails closed; it never licenses replacing that policy.
    shlex retains quoted/multiline words and ignores comments without mistaking
    an ordinary `/usr/** r,` permission for an executable attachment.
    """
    text = data.decode('utf-8', errors='strict')
    for match in re.finditer(r'(?m)^[ \t]*(?:profile(?=\s)|/|"/|@\{|"@\{)', text):
        lexer = shlex.shlex(text[match.start():match.start() + 4096], posix=True)
        lexer.whitespace_split = True
        lexer.commenters = '#'
        words = []
        opened = False
        try:
            for word in lexer:
                if word.startswith('{'):
                    opened = True
                    break
                words.append(word)
                if len(words) == 1 and words[0].startswith('@{') and '=' in words[0]:
                    break
                if words[0] != 'profile' and (word.endswith(',') or word == '='):
                    break  # File permission or variable definition, no body.
                if len(words) >= 64:
                    raise Unavailable('foreign-profile-header-ambiguous')
        except ValueError as error:
            raise Unavailable('foreign-profile-header-ambiguous') from error
        if not words:
            continue
        if words[0] == 'profile':
            if len(words) < 2 or not opened:
                raise Unavailable('foreign-profile-header-ambiguous')
            name = words[1]
            if 'bwrap' in name:
                raise Unavailable('foreign-bwrap-profile-file')
            attachment = words[2] if len(words) > 2 and not re.match(r'^(?:flags|xattrs)(?:=|$)', words[2]) else (name if name.startswith(('/', '@{')) else None)
        else:
            if not opened:
                continue
            attachment = words[0]
        if attachment is None:
            continue
        if not attachment.startswith(('/', '@{')):
            raise Unavailable('foreign-profile-attachment-ambiguous')
        matches, unresolved = attachment_could_match_bwrap(attachment)
        if matches:
            raise Unavailable('foreign-profile-attachment-ambiguous' if unresolved else 'foreign-bwrap-profile-file')


def validate_exec_observation(value, *, uid, gid, executable, identity, namespaces, label):
    if value.get("executable") != executable or value.get("identity") != identity or value.get("argv") != [executable, "--args", "0"]:
        raise Unavailable("bwrap-exec-identity")
    if value.get("uids") != [uid] * 4 or value.get("gids") != [gid] * 4 or value.get("groups") != [] or value.get("noNewPrivileges") != "1":
        raise Unavailable("bwrap-exec-privileges")
    if set(value.get("capabilities", {})) != {"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"} or any(not re.fullmatch(r"0+", item) for item in value["capabilities"].values()):
        raise Unavailable("bwrap-exec-capabilities")
    if value.get("namespaces") != namespaces or value.get("profile") != label:
        raise Unavailable("foreign-bwrap-exec-profile")
    return {"profile": label, "uid": uid, "gid": gid, "noNewPrivileges": True, "capabilitiesZero": True, "namespacesUnchanged": True, "argumentPipeHeldOpen": True}


def select_profile_member(stream):
    result = None
    total = count = 0
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            count += 1
            total += member.size
            if count > 10000 or total > 256 * 1024 ** 2:
                raise Unavailable("profile-package-tar-bounds")
            if member.name.removeprefix("./") != MEMBER:
                continue
            if result is not None or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or member.size > MAX_PROFILE or member.mode & 0o022:
                raise Unavailable("profile-package-member")
            source = archive.extractfile(member)
            result = source.read(member.size + 1)
            if len(result) != member.size:
                raise Unavailable("profile-package-short-member")
    if result is None:
        raise Unavailable("profile-package-member-missing")
    return result


def policy_bytes(source):
    if len(source) > MAX_PROFILE:
        raise Unavailable("profile-too-large")
    text = source.decode("utf-8", errors="strict")
    if not re.search(r"(?m)^\s*abi\s+<abi/4\.0>\s*,", text):
        raise Unavailable("distribution-profile-abi")
    if re.search(r"flags\s*=\s*\([^)]*(?:unconfined|complain)", text):
        raise Unavailable("profile-mode")
    headers = list(re.finditer(r"(?m)^\s*profile\s+(\S+)([^\n{]*)\{", text))
    declarations = [(value.group(1), value.group(2)) for value in headers]
    if [value[0] for value in declarations] != ["bwrap", "unpriv_bwrap"] or "/usr/bin/bwrap" not in declarations[0][1] or "/" in declarations[1][1]:
        raise Unavailable("distribution-profile-shape")
    parent = text[headers[0].end():headers[1].start()]
    child = text[headers[1].end():]
    if not re.search(r"(?m)^[ \t]*audit\s+deny\s+capability\s*,", child) or not re.search(r"(?m)^[ \t]*allow\s+pix\s+/\*\*\s*->\s*&unpriv_bwrap\s*,", child):
        raise Unavailable("profile-child-capability-boundary")
    # Ubuntu Noble's ABI4 distro profile uses px and the non-leading-& target.
    # Preserve that exact NNP stacking topology; ABI5 master has different rules.
    if not re.search(r"(?m)^[ \t]*allow\s+px\s+/\*\*\s*->\s*bwrap//&unpriv_bwrap\s*,", parent):
        raise Unavailable("profile-stacking-boundary")
    # Change identities only, not paths, modes, capabilities, ABI or rules.
    text = re.sub(r"(?m)^(\s*profile\s+)bwrap(?=\s)", r"\1vortex-bwrap", text)
    text = re.sub(r"(?m)^(\s*profile\s+)unpriv_bwrap(?=\s)", r"\1vortex-unpriv-bwrap", text)
    text = text.replace("bwrap//&unpriv_bwrap", "vortex-bwrap//&vortex-unpriv-bwrap").replace("&unpriv_bwrap", "&vortex-unpriv-bwrap")
    return text.encode("utf-8")


class IsolationInstaller:
    def __init__(self, root="/", runner=None):
        self.root = pathlib.Path(root)
        self.runner = runner or self.run
        self.state = self.p("/var/lib/vortex-application-isolation")
        self.receipt = self.state / "apparmor.json"
        self.profile = self.p("/etc/apparmor.d/vortex-application-bwrap")
        self.parser = self.p("/usr/sbin/apparmor_parser")

    def p(self, absolute):
        return self.root / absolute.lstrip("/")

    def trusted(self, filename, *, directory=False, private=False, allow_tmp=False):
        filename = pathlib.Path(filename)
        if not filename.is_absolute() or filename.resolve(strict=True) != filename:
            raise Unavailable("unsafe-path")
        for current in [*reversed(filename.parents), filename]:
            info = current.lstat()
            sticky_tmp = allow_tmp and current == self.p("/tmp") and stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 and not sticky_tmp:
                raise Unavailable("unsafe-ownership")
            if current != filename and not stat.S_ISDIR(info.st_mode):
                raise Unavailable("unsafe-parent")
        info = filename.lstat()
        if directory:
            if not stat.S_ISDIR(info.st_mode):
                raise Unavailable("unsafe-directory")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise Unavailable("unsafe-file")
        if private and stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600):
            raise Unavailable("unsafe-private-mode")
        return info

    def read(self, filename, limit=MAX_PROFILE, *, private=False, allow_tmp=False):
        self.trusted(filename, private=private, allow_tmp=allow_tmp)
        descriptor = os.open(filename, os.O_RDONLY | NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if info.st_size > limit:
                raise Unavailable("file-too-large")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                result = source.read(min(limit, info.st_size) + 1)
            if len(result) > limit:
                raise Unavailable("file-too-large")
            if len(result) != info.st_size or os.fstat(descriptor).st_size != info.st_size:
                raise Unavailable("file-changed-during-read")
            return result
        finally:
            os.close(descriptor)

    def atomic(self, filename, data, *, exclusive=False):
        filename = pathlib.Path(filename)
        allow_tmp = self.p("/tmp") in filename.parents
        self.trusted(filename.parent, directory=True, private=allow_tmp, allow_tmp=allow_tmp)
        temporary = filename.parent / (".vortex-" + uuid.uuid4().hex)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            if exclusive:
                os.link(temporary, filename, follow_symlinks=False)
            else:
                if filename.exists() or filename.is_symlink():
                    self.trusted(filename, private=True, allow_tmp=allow_tmp)
                os.replace(temporary, filename)
        finally:
            temporary.unlink(missing_ok=True)

    def run(self, args, *, cwd=None, timeout=60, limit=1024 ** 2):
        # A private bounded output file avoids exposing proxy credentials and
        # prevents command diagnostics becoming a large in-memory buffer.
        with tempfile.TemporaryFile() as output:
            child = subprocess.Popen([str(value) for value in args], cwd=cwd, stdout=output, stderr=subprocess.STDOUT,
                                     env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"}, start_new_session=True)
            deadline = time.monotonic() + timeout
            while child.poll() is None:
                if time.monotonic() >= deadline or os.fstat(output.fileno()).st_size > limit:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                    raise Unavailable("command-timeout-or-output-bound")
                try:
                    child.wait(timeout=min(0.1, max(0.01, deadline - time.monotonic())))
                except subprocess.TimeoutExpired:
                    pass
            if child.returncode or output.tell() > limit:
                raise Unavailable("command-failed")
            output.seek(0)
            return output.read(min(limit, os.fstat(output.fileno()).st_size) + 1).decode("utf-8", errors="strict")

    @contextlib.contextmanager
    def locked(self):
        if not self.state.exists():
            self.trusted(self.state.parent, directory=True)
            self.state.mkdir(mode=0o700)
        self.trusted(self.state, directory=True, private=True)
        lock = self.state / ".lock"
        descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
        try:
            self.trusted(lock, private=True)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            os.close(descriptor)

    def prerequisites(self):
        if sys.platform != "linux" or os.geteuid() != 0 or fcntl is None:
            raise Unavailable("linux-root-required")
        release = self.read(self.p("/etc/os-release").resolve(strict=True)).decode()
        if not re.search(r'(?m)^ID=["\']?ubuntu["\']?$', release):
            raise Unavailable("ubuntu-required")
        restriction = self.p("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        if not restriction.exists() or restriction.read_text().strip() != "1":
            return False
        if self.p("/sys/module/apparmor/parameters/enabled").read_text().strip().lower() not in ("y", "yes", "1"):
            raise Unavailable("apparmor-not-enabled")
        self.trusted(self.p("/etc/apparmor.d"), directory=True)
        self.trusted(self.p("/etc/apparmor.d/abi/4.0"))
        self.trusted(self.parser)
        self.trusted(self.p("/usr/bin/bwrap"))
        if self.p("/usr/bin/bwrap").lstat().st_mode & (stat.S_ISUID | stat.S_ISGID):
            raise Unavailable("setuid-bwrap-refused")
        version = self.runner([self.parser, "--version"], limit=4096)
        if not re.search(r"\bversion\s+[4-9]\.\d", version, re.I):
            raise Unavailable("apparmor-parser-version")
        return True

    def loaded(self):
        data = self.p("/sys/kernel/security/apparmor/profiles").read_text()
        if len(data) > 1024 ** 2:
            raise Unavailable("profile-inventory-too-large")
        return {name: mode for name, mode in re.findall(r"(?m)^(.+) \(([^)]+)\)$", data)}

    def policy_inventory(self):
        base = self.p("/sys/kernel/security/apparmor/policy/profiles")
        result = {}
        if not base.is_dir():
            raise Unavailable("profile-attachments-unavailable")
        for index, folder in enumerate(base.iterdir()):
            if index >= 2048 or folder.is_symlink() or not folder.is_dir():
                raise Unavailable("profile-inventory-unsafe")
            item = {}
            for key in ("name", "attach", "mode", "sha256", "sha1"):
                filename = folder / key
                if filename.exists():
                    value = filename.read_text()
                    if len(value) > 4096:
                        raise Unavailable("profile-metadata-too-large")
                    item[key] = value.strip()
            if not item.get("name"):
                raise Unavailable("profile-metadata-missing")
            result[item["name"]] = item
        return result

    def kernel_snapshot(self, inventory, owned=False):
        result = {}
        for name, item in inventory.items():
            if owned and name in PROFILE_NAMES:
                continue
            checksum = item.get("sha256") or item.get("sha1")
            if not isinstance(checksum, str) or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", checksum):
                raise Unavailable("foreign-kernel-policy-hash-unavailable")
            result[name] = {"hash": checksum, "attach": item.get("attach"), "mode": item.get("mode")}
        return result

    def observe_bwrap(self, pid):
        base = self.p("/proc/" + str(pid))
        def text(filename, limit=65536):
            with filename.open("rb") as source:
                data = source.read(limit + 1)
            if len(data) > limit:
                raise Unavailable("bwrap-exec-observation-bound")
            return data.decode("utf-8", errors="strict")
        fields = dict(line.split(":", 1) for line in text(base / "status").splitlines() if ":" in line)
        info = (base / "exe").stat()
        return {"executable": os.readlink(base / "exe"), "identity": [info.st_dev, info.st_ino],
                "argv": text(base / "cmdline").rstrip("\0").split("\0"),
                "uids": [int(value) for value in fields.get("Uid", "").split()], "gids": [int(value) for value in fields.get("Gid", "").split()],
                "groups": [int(value) for value in fields.get("Groups", "").split()], "noNewPrivileges": fields.get("NoNewPrivs", "").strip(),
                "capabilities": {key: fields[key].strip() for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb") if key in fields},
                "namespaces": {key: os.readlink(base / "ns" / key) for key in ("user", "mnt")}, "profile": text(base / "attr/current").strip()}

    def probe_bwrap_exec(self, label="unconfined"):
        setpriv = self.p("/usr/bin/setpriv")
        getent = self.p("/usr/bin/getent")
        bwrap = self.p("/usr/bin/bwrap")
        for tool in (setpriv, getent, bwrap):
            self.trusted(tool)
        identity = bwrap.lstat()
        if not identity.st_mode & 0o111 or identity.st_mode & (stat.S_ISUID | stat.S_ISGID):
            raise Unavailable("bwrap-exec-file-mode")
        account = self.runner([getent, "passwd", "nobody"], limit=4096).strip().split(":")
        if len(account) != 7 or account[0] != "nobody" or not account[2].isdigit() or not account[3].isdigit() or int(account[2]) <= 0 or int(account[3]) <= 0:
            raise Unavailable("bwrap-probe-account")
        uid, gid = int(account[2]), int(account[3])
        namespaces = {key: os.readlink(self.p("/proc/self/ns") / key) for key in ("user", "mnt")}
        arguments = [str(setpriv), "--reuid=" + str(uid), "--regid=" + str(gid), "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", str(bwrap), "--args", "0"]
        child = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 cwd=self.root, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"}, start_new_session=True)
        try:
            deadline = time.monotonic() + 2
            while child.poll() is None and time.monotonic() < deadline:
                try:
                    value = self.observe_bwrap(child.pid)
                except (FileNotFoundError, ProcessLookupError):
                    time.sleep(0.01)
                    continue
                if value["executable"] == str(setpriv):
                    time.sleep(0.01)
                    continue
                result = validate_exec_observation(value, uid=uid, gid=gid, executable=str(bwrap), identity=[identity.st_dev, identity.st_ino], namespaces=namespaces, label=label)
                current = bwrap.lstat()
                if child.poll() is not None or (current.st_dev, current.st_ino, current.st_mode) != (identity.st_dev, identity.st_ino, identity.st_mode):
                    raise Unavailable("bwrap-exec-changed")
                return result
            raise Unavailable("bwrap-exec-probe-unavailable")
        finally:
            # Keep FD0 held empty until terminating this direct child: no EOF or
            # namespace/command arguments can advance its argument parser.
            try:
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=1)
            finally:
                child.stdin.close()

    def foreign_policy(self, owned=False, profile_staged=False):
        for name in self.loaded():
            if name in PROFILE_NAMES and owned:
                continue
            if "bwrap" in name:
                raise Unavailable("foreign-bwrap-profile")
        inventory = self.policy_inventory()
        unknown = []
        for name, item in inventory.items():
            if name in PROFILE_NAMES and owned:
                continue
            attachment = item.get("attach", "")
            if attachment == "<unknown>":
                unknown.append(name)
            elif "bwrap" in attachment or fnmatch.fnmatchcase("/usr/bin/bwrap", attachment):
                raise Unavailable("foreign-bwrap-attachment")
        count = total = 0
        for filename in self.p("/etc/apparmor.d").iterdir():
            if filename == self.profile and (owned or profile_staged) or filename.name.startswith(".") or filename.is_dir():
                continue
            count += 1
            if count > 2048:
                raise Unavailable("profile-files-too-many")
            data = self.read(filename, limit=256 * 1024)
            total += len(data)
            if total > 16 * 1024 ** 2:
                raise Unavailable("profile-files-too-large")
            check_profile_file(data)
        baseline = self.kernel_snapshot(inventory, owned=owned)
        evidence = self.probe_bwrap_exec("vortex-bwrap (enforce)" if owned else "unconfined") if unknown else None
        if self.kernel_snapshot(self.policy_inventory(), owned=owned) != baseline:
            raise Unavailable("foreign-kernel-policy-changed-during-probe")
        return {"kernel": baseline, "execProof": evidence, "opaqueAttachments": len(unknown)}

    def distribution_profile(self):
        source = self.p("/" + MEMBER)
        if source.exists() or source.is_symlink():
            return self.read(source), {"source": "installed-distribution-extra"}
        self.trusted(self.p("/usr/bin/apt-cache"))
        self.trusted(self.p("/usr/bin/apt-get"))
        self.trusted(self.p("/usr/bin/dpkg-deb"))
        policy = self.runner([self.p("/usr/bin/apt-cache"), "policy", "apparmor-profiles"])
        match = re.search(r"(?m)^\s*Candidate:\s*(\S+)\s*$", policy)
        version = match.group(1) if match else ""
        if not re.fullmatch(r"[0-9A-Za-z.+:~_-]{1,160}", version):
            raise Unavailable("profile-package-candidate-unavailable")
        metadata = self.runner([self.p("/usr/bin/apt-cache"), "show", "apparmor-profiles=" + version])
        candidates = []
        for paragraph in metadata.split("\n\n"):
            fields = dict(re.findall(r"(?m)^([A-Za-z0-9-]+): ([^\n]+)$", paragraph))
            if fields.get("Package") == "apparmor-profiles" and fields.get("Version") == version:
                candidates.append(fields)
        if not candidates or len({value.get("SHA256") for value in candidates}) != 1:
            raise Unavailable("profile-package-metadata")
        meta = candidates[0]
        if not re.fullmatch(r"[a-fA-F0-9]{64}", meta.get("SHA256", "")) or not meta.get("Size", "").isdigit() or not 1 <= int(meta["Size"]) <= MAX_PACKAGE:
            raise Unavailable("profile-package-bounds")
        with tempfile.TemporaryDirectory(prefix=".acquire-", dir=self.state) as temporary:
            os.chmod(temporary, 0o700)
            self.runner([self.p("/usr/bin/apt-get"), "-o", "APT::Get::AllowUnauthenticated=false", "download", "apparmor-profiles=" + version], cwd=temporary, timeout=120)
            files = list(pathlib.Path(temporary).iterdir())
            if len(files) != 1 or files[0].suffix != ".deb":
                raise Unavailable("profile-package-artifact")
            package = self.read(files[0], MAX_PACKAGE)
            if len(package) != int(meta["Size"]) or digest(package) != meta["SHA256"].lower():
                raise Unavailable("profile-package-checksum")
            result = self.extract_member(files[0])
        return result, {"source": "verified-distribution-package-member", "package": "apparmor-profiles", "version": version, "packageSHA256": meta["SHA256"].lower()}

    def extract_member(self, package):
        child = subprocess.Popen([str(self.p("/usr/bin/dpkg-deb")), "--fsys-tarfile", str(package)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}, start_new_session=True)
        def terminate():
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        timer = threading.Timer(30, terminate)
        timer.start()
        try:
            result = select_profile_member(child.stdout)
            child.wait(timeout=5)
            if child.returncode or result is None:
                raise Unavailable("profile-package-member-missing")
            return result
        finally:
            timer.cancel()
            if child.poll() is None:
                terminate()
            child.wait()
            child.stdout.close()

    def json_write(self, filename, value, **options):
        self.atomic(filename, (json.dumps(value, sort_keys=True) + "\n").encode(), **options)

    def owned_receipt(self):
        value = json.loads(self.read(self.receipt, private=True))
        if value.get("schema") != 1 or not re.fullmatch(r"[a-f0-9]{32}", value.get("nonce", "")) or not isinstance(value.get("owners"), dict) or any(owner not in OWNERS or not re.fullmatch(r"[a-f0-9]{32}", token) for owner, token in value["owners"].items()):
            raise Unavailable("ownership-receipt-invalid")
        if value.get("profileSHA256") != digest(self.read(self.profile)) or value.get("state") != "active":
            raise Unavailable("ownership-receipt-mismatch")
        return value

    def profile_modes(self):
        values = self.loaded()
        if any(values.get(name) != "enforce" for name in PROFILE_NAMES):
            raise Unavailable("profile-not-enforced")

    def prepare(self, owner, transaction):
        if owner not in OWNERS:
            raise Unavailable("invalid-owner")
        self.trusted(pathlib.Path(transaction).parent, directory=True, private=True, allow_tmp=True)
        if pathlib.Path(transaction).exists() or pathlib.Path(transaction).is_symlink():
            raise Unavailable("transaction-already-exists")
        if not self.prerequisites():
            return {"status": "not-required", "globalSecuritySettingsChanged": False}
        with self.locked():
            if self.profile.exists() or self.profile.is_symlink() or self.receipt.exists() or self.receipt.is_symlink():
                receipt = self.owned_receipt()
                observed = self.policy_inventory()
                for name in PROFILE_NAMES:
                    expected = receipt.get("kernelHashes", {}).get(name)
                    if not expected or (observed.get(name, {}).get("sha256") or observed.get(name, {}).get("sha1")) != expected:
                        raise Unavailable("owned-kernel-policy-changed")
                self.foreign_policy(owned=True)
                self.profile_modes()
                if owner in receipt["owners"]:
                    return {"status": "ready", "reused": True, "addedOwner": False, "profileSHA256": receipt["profileSHA256"], "globalSecuritySettingsChanged": False}
                token = uuid.uuid4().hex
                self.json_write(transaction, {"schema": 1, "nonce": receipt["nonce"], "owner": owner, "token": token}, exclusive=True)
                receipt["owners"][owner] = token
                self.json_write(self.receipt, receipt)
                return {"status": "ready", "reused": True, "addedOwner": True, "profileSHA256": receipt["profileSHA256"], "globalSecuritySettingsChanged": False}
            baseline = self.foreign_policy()
            source, origin = self.distribution_profile()
            data = policy_bytes(source)
            nonce = uuid.uuid4().hex
            token = uuid.uuid4().hex
            temporary = self.state / (".policy-" + nonce)
            self.atomic(temporary, data, exclusive=True)
            try:
                self.runner([self.parser, "--skip-cache", "--skip-kernel-load", "--abort-on-error", temporary])
                names = self.runner([self.parser, "--names", temporary]).splitlines()
                if set(names) != set(PROFILE_NAMES):
                    raise Unavailable("compiled-profile-identities")
                receipt = {"schema": 1, "nonce": nonce, "state": "preparing", "profileSHA256": digest(data), "distributionProfileSHA256": digest(source), "origin": origin, "owners": {owner: token}}
                self.json_write(transaction, {"schema": 1, "nonce": nonce, "owner": owner, "token": token}, exclusive=True)
                profile_identity = None
                try:
                    self.atomic(self.profile, data, exclusive=True)
                    info = self.profile.lstat()
                    profile_identity = (info.st_dev, info.st_ino)
                    self.json_write(self.receipt, receipt, exclusive=True)
                except Exception:
                    # Only this call's exclusively created unchanged file is
                    # eligible for cleanup if the receipt commit itself failed.
                    if profile_identity and (self.profile.lstat().st_dev, self.profile.lstat().st_ino) == profile_identity and digest(self.read(self.profile)) == digest(data):
                        self.profile.unlink()
                    pathlib.Path(transaction).unlink(missing_ok=True)
                    raise
                try:
                    trusted_loaded_hashes = None
                    fresh = self.foreign_policy(profile_staged=True)
                    if fresh["kernel"] != baseline["kernel"]:
                        raise Unavailable("foreign-kernel-policy-changed-before-add")
                    self.runner([self.parser, "--add", "--skip-cache", "--abort-on-error", self.profile])
                    trusted_loaded_hashes = {name: item.get("sha256") or item.get("sha1") for name, item in self.policy_inventory().items() if name in PROFILE_NAMES}
                    self.profile_modes()
                    receipt["state"] = "active"
                    receipt["kernelHashes"] = trusted_loaded_hashes
                    receipt["foreignKernelDigest"] = digest(json.dumps(baseline["kernel"], sort_keys=True).encode())
                    receipt["foreignProfileCount"] = len(baseline["kernel"])
                    receipt["opaqueAttachmentProof"] = fresh["execProof"]
                    if self.kernel_snapshot(self.policy_inventory(), owned=True) != baseline["kernel"]:
                        raise Unavailable("foreign-kernel-policy-changed-after-add")
                    self.json_write(self.receipt, receipt)
                except Exception:
                    self.rollback_locked(owner, transaction, allow_preparing=True, trusted_loaded_hashes=trusted_loaded_hashes)
                    raise
                return {"status": "ready", "reused": False, "addedOwner": True, "profileSHA256": receipt["profileSHA256"], "origin": origin, "foreignProfileCount": receipt["foreignProfileCount"], "foreignKernelDigest": receipt["foreignKernelDigest"], "opaqueAttachmentProof": fresh["execProof"], "globalSecuritySettingsChanged": False}
            finally:
                temporary.unlink(missing_ok=True)

    def rollback_locked(self, owner, transaction, allow_preparing=False, trusted_loaded_hashes=None):
        transaction = pathlib.Path(transaction)
        item = json.loads(self.read(transaction, private=True, allow_tmp=True))
        receipt = json.loads(self.read(self.receipt, private=True))
        if item.get("schema") != 1 or item.get("owner") != owner or receipt.get("nonce") != item.get("nonce") or receipt.get("owners", {}).get(owner) != item.get("token") or receipt.get("state") not in (["active", "preparing"] if allow_preparing else ["active"]) or receipt.get("profileSHA256") != digest(self.read(self.profile)):
            raise Unavailable("rollback-ownership-mismatch")
        remaining = {key: value for key, value in receipt["owners"].items() if key != owner}
        if remaining:
            receipt["owners"] = remaining
            self.json_write(self.receipt, receipt)
            transaction.unlink()
            return {"status": "retained-for-other-owner"}
        actual = self.policy_inventory()
        loaded_names = [name for name in PROFILE_NAMES if name in self.loaded()]
        expected_hashes = trusted_loaded_hashes if trusted_loaded_hashes is not None else receipt.get("kernelHashes", {})
        for name in loaded_names:
            expected = expected_hashes.get(name)
            if not expected:
                # A failed --add may have met a concurrently installed foreign
                # definition, or may have loaded only part of our file. Names
                # alone cannot establish ownership; preserve recovery anchors.
                raise Unavailable("rollback-kernel-ownership-unknown")
            if (actual.get(name, {}).get("sha256") or actual.get(name, {}).get("sha1")) != expected:
                raise Unavailable("rollback-kernel-policy-changed")
        if loaded_names:
            try:
                self.runner([self.parser, "--remove", "--skip-cache", self.profile])
            except Unavailable:
                if any(name in self.loaded() for name in PROFILE_NAMES):
                    raise
        if any(name in self.loaded() for name in PROFILE_NAMES):
            raise Unavailable("rollback-profile-still-loaded")
        if receipt["profileSHA256"] != digest(self.read(self.profile)):
            raise Unavailable("rollback-profile-changed")
        self.profile.unlink()
        self.receipt.unlink()
        transaction.unlink()
        return {"status": "removed-owned-profile", "globalSecuritySettingsChanged": False}

    def rollback(self, owner, transaction):
        if owner not in OWNERS:
            raise Unavailable("invalid-owner")
        if not pathlib.Path(transaction).exists() and not pathlib.Path(transaction).is_symlink():
            return {"status": "no-owned-change"}
        with self.locked():
            return self.rollback_locked(owner, transaction, allow_preparing=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("prepare", "rollback"))
    parser.add_argument("--owner", required=True, choices=OWNERS)
    parser.add_argument("--transaction", required=True)
    arguments = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        print(json.dumps({"status": "unavailable", "reason": "linux-root-required"}))
        return 1
    try:
        installer = IsolationInstaller()
        result = getattr(installer, arguments.operation)(arguments.owner, pathlib.Path(arguments.transaction))
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        # Never print raw APT/parser paths, environment or command diagnostics.
        reason = str(error) if isinstance(error, Unavailable) else "isolation-setup-failed"
        print(json.dumps({"status": "unavailable", "reason": reason, "globalSecuritySettingsChanged": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
