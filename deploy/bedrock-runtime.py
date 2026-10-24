#!/usr/bin/env python3
"""Prepare the private, pinned ARM64 compatibility runtime for Bedrock.

This is an installer operation, never a request-time download. Nothing is
registered with binfmt, ldconfig, dpkg multiarch, or the host's Box64 config.
"""
import argparse
import contextlib
import ctypes
import datetime
import fcntl
import hashlib
import json
import lzma
import os
from pathlib import Path, PurePosixPath
import platform
import re
import signal
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid

VERSION = '0.4.4'
COMMIT = '2f130fab1d6e1a4ee8a71dc60cfdfcc839ad192a'
SOURCE_SHA256 = 'ce844041092de3f44316bd1c033a3cc10024e5f798c1a8e8a58f046c6d967981'
SOURCE_BYTES = 19678563
SOURCE_URL = 'https://codeload.github.com/ptitSeb/box64/tar.gz/' + COMMIT
RECEIPT = '.vortex-bedrock-runtime.json'
LIBRARIES = {'libstdc++.so.6': '5b8ad47cced79a8d88d3df7ee78d952d1d688369690591d6ada7fab3e18af888',
             'libgcc_s.so.1': 'caf944063eb6261bc1c1a6a9f0c7b40d3842843044f3bce58824358f425be254'}
GCC_SOURCE = 'https://raw.githubusercontent.com/gcc-mirror/gcc/5115c7e447fc07457443df874bf57840e8316d5f/'
GCC_LICENSES = {'COPYING3': (35147, '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'),
                'COPYING.RUNTIME': (3324, '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74')}
ROOTS = {'panel': Path('/opt/vortex-panel'), 'worker': Path('/opt/vortex-node')}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'HOME': '/nonexistent'}
WORK_BYTES = 1536 * 1024 ** 2
BUILD_MEMORY_BYTES = 2 * 1024 ** 3
BUNDLE_ARCHIVE = 'bedrock-box64-arm64.tar.xz'
BUNDLE_METADATA = 'bedrock-box64-arm64.json'
BOX64_LICENSE_SHA256 = '18731c3637a3dfc5859be67db7d315d438c531396a4ed15a9c88421b520e7883'
BUNDLE_BASELINE = {'os': 'ubuntu', 'version': '22.04', 'glibc': '2.35'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def valid_sha(value):
    return isinstance(value, str) and bool(re.fullmatch('[a-f0-9]{64}', value))


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def stable_bytes(path, limit):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= limit
            and (sys.platform == 'win32' or not before.st_mode & 0o022), 'Unsafe or oversized bundled runtime input: ' + str(path))
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        opened = os.fstat(descriptor)
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), 'Bundled runtime input changed while opening.')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            value = stream.read(min(limit, opened.st_size) + 1)
        after, current = os.fstat(descriptor), path.lstat()
        def stamp(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                    info.st_ctime_ns if sys.platform != 'win32' else None, info.st_mode, info.st_nlink)
        require(len(value) == before.st_size and stamp(before) == stamp(after) == stamp(current), 'Bundled runtime input changed while reading.')
        return value
    finally:
        os.close(descriptor)


def bundled_runtime(directory=None):
    directory = directory or Path(__file__).absolute().parent
    require(directory.resolve(strict=True) == directory, 'Bundled runtime directory must not be linked.')
    archive, metadata = directory / BUNDLE_ARCHIVE, directory / BUNDLE_METADATA
    present = [os.path.lexists(path) for path in (archive, metadata)]
    if not any(present):
        return None
    require(all(present), 'The ARM64 runtime bundle is incomplete; both fixed archive and metadata files are required.')
    value = json.loads(stable_bytes(metadata, 64 * 1024).decode('utf-8'))
    expected = {'schema': 1, 'engine': 'box64', 'version': VERSION, 'hostArch': 'arm64', 'guestArch': 'x64',
                'pageSize': 4096, 'profile': 'generic-arm64-v1'}
    require(isinstance(value, dict) and all(value.get(key) == item for key, item in expected.items()), 'Bundled runtime metadata identity is invalid.')
    require(value.get('source') == {'commit': COMMIT, 'sha256': SOURCE_SHA256} and value.get('baseline') == BUNDLE_BASELINE,
            'Bundled runtime source pin or native build baseline is invalid.')
    require(value.get('license') == {'path': 'licenses/Box64-LICENSE', 'sha256': BOX64_LICENSE_SHA256}, 'Bundled Box64 license inventory is invalid.')
    compressed, executable = value.get('archive'), value.get('executable')
    require(isinstance(compressed, dict) and compressed.get('name') == BUNDLE_ARCHIVE and type(compressed.get('bytes')) is int
            and 0 < compressed['bytes'] <= 16 * 1024 ** 2 and valid_sha(compressed.get('sha256')),
            'Bundled runtime archive identity is invalid.')
    require(isinstance(executable, dict) and executable.get('path') == 'bin/box64' and valid_sha(executable.get('sha256')),
            'Bundled runtime executable identity is invalid.')
    data = stable_bytes(archive, 16 * 1024 ** 2)
    require(len(data) == compressed['bytes'] and hashlib.sha256(data).hexdigest() == compressed['sha256'], 'Bundled runtime archive failed size/SHA-256 verification.')
    payloads = {}
    expected_files = {'bin/box64': (64 * 1024 ** 2, 0o755, executable['sha256']),
                      'licenses/Box64-LICENSE': (1064, 0o644, BOX64_LICENSE_SHA256)}
    decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=128 * 1024 ** 2)
    unpacked = decoder.decompress(data, max_length=64 * 1024 ** 2 + 64 * 1024 + 1)
    require(decoder.eof and not decoder.unused_data and len(unpacked) <= 64 * 1024 ** 2 + 64 * 1024,
            'Bundled runtime exceeds its decompressed archive bound or contains trailing streams.')
    offset = 0
    while offset + 512 <= len(unpacked) and any(unpacked[offset:offset + 512]):
        # Parse each physical header: extended/sparse headers and hidden
        # concatenated tar payloads are outside the exact two-file contract.
        member = tarfile.TarInfo.frombuf(unpacked[offset:offset + 512], encoding='utf-8', errors='strict')
        require(member.name in expected_files and member.name not in payloads and member.type in (tarfile.REGTYPE, tarfile.AREGTYPE)
                and not member.linkname and not member.sparse, 'The bundled runtime archive contains an unexpected entry or link.')
        limit, mode, sha256 = expected_files[member.name]
        require(0 < member.size <= limit and member.mode == mode, 'Bundled runtime file exceeds its size bound or has unexpected permissions.')
        start, end = offset + 512, offset + 512 + member.size
        contents = unpacked[start:end]
        require(len(contents) == member.size and hashlib.sha256(contents).hexdigest() == sha256, 'Bundled runtime file failed SHA-256 verification.')
        payloads[member.name] = contents
        offset = start + ((member.size + 511) // 512) * 512
    require(len(unpacked) - offset >= 1024 and not any(unpacked[offset:]), 'Bundled runtime tar archive has missing end markers or unexpected trailing data.')
    require(set(payloads) == set(expected_files), 'Bundled runtime archive inventory is incomplete.')
    header = payloads['bin/box64'][:64]
    require(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', header, 18)[0] == 183,
            'Bundled Box64 executable must be native little-endian ARM64 ELF.')
    return {'metadata': value, 'files': payloads}


def trusted(path, directory=False):
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'Bedrock runtime paths must be root-owned, without symlinks or shared write access: ' + str(item))
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            'Unexpected Bedrock runtime file type: ' + str(path))
    return info


def elf(path, machine):
    trusted(path)
    with path.open('rb') as stream:
        header = stream.read(64)
    require(len(header) == 64 and header[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', header, 18)[0] == machine,
            'Bedrock compatibility runtime has an unexpected ELF architecture: ' + str(path))


def prefix(role):
    return ROOTS[role] / 'runtime' / ('box64-v' + VERSION + '-arm64')


def inspect(role):
    target = prefix(role)
    trusted(target, directory=True)
    receipt = target / RECEIPT
    require(trusted(receipt).st_size <= 32768, 'Bedrock runtime receipt is too large.')
    value = json.loads(receipt.read_text(encoding='utf-8'))
    expected = {'schema': 1, 'engine': 'box64', 'version': VERSION, 'hostArch': 'arm64', 'guestArch': 'x64',
                'pageSize': 4096, 'profile': 'generic-arm64-v1'}
    require(all(value.get(key) == item for key, item in expected.items()), 'Bedrock runtime receipt identity is invalid.')
    require(value.get('source') == {'commit': COMMIT, 'sha256': SOURCE_SHA256}, 'Bedrock runtime source pin is invalid.')
    records = [value.get('executable'), *(value.get('libraries') or [])]
    names = ['bin/box64', *['lib/x86_64/' + item for item in LIBRARIES]]
    require(len(records) == len(names), 'Bedrock runtime library inventory is incomplete.')
    for record, name in zip(records, names):
        require(isinstance(record, dict) and record.get('path') == name and re.fullmatch('[a-f0-9]{64}', record.get('sha256', '')),
                'Bedrock runtime file receipt is invalid.')
        path = target / name
        elf(path, 183 if name == 'bin/box64' else 62)
        require(digest(path) == record['sha256'], 'Bedrock runtime file differs from its installation receipt: ' + name)
        if name != 'bin/box64':
            require(record['sha256'] == LIBRARIES[Path(name).name], 'Bedrock runtime library differs from the reviewed upstream pin.')
    require(os.access(target / 'bin/box64', os.X_OK), 'The private Box64 executable cannot be run.')
    return {'ok': True, 'prefix': str(target), **value}


def run(arguments, timeout=120, capture=False):
    result = subprocess.run(arguments, check=False, env=ENV, timeout=timeout,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.STDOUT if capture else None, text=True)
    require(result.returncode == 0, 'Bedrock runtime command failed: ' + arguments[0] +
            (': ' + (result.stdout or '')[-4000:] if capture else ''))
    return result.stdout or ''


def download(path, url=SOURCE_URL, size=SOURCE_BYTES, sha256=SOURCE_SHA256):
    request = urllib.request.Request(url, headers={'User-Agent': 'Vortex-Panel-Bedrock-Runtime/' + VERSION})
    total = 0
    deadline = time.monotonic() + 300
    hasher = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=90) as response, path.open('xb') as output:
        require(response.url == url, 'Unexpected pinned Box64 dependency download redirect.')
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            require(total <= size and time.monotonic() < deadline, 'Box64 dependency exceeds the pinned download size or deadline.')
            output.write(chunk)
            hasher.update(chunk)
    require(total == size and hasher.hexdigest() == sha256, 'Box64 dependency failed pinned size/SHA-256 verification.')


def extract(archive, destination):
    total = 0
    count = 0
    root_name = 'box64-' + COMMIT
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            parts = PurePosixPath(member.name).parts
            require(parts and parts[0] == root_name and not any(item in ('..', '') for item in parts)
                    and not member.name.startswith('/'), 'Unsafe path in pinned Box64 source.')
            if len(parts) == 1:
                require(member.isdir(), 'Unexpected Box64 archive root.')
                continue
            target = destination.joinpath(*parts[1:])
            count += 1
            total += member.size
            require(count <= 16000 and 0 <= member.size <= 64 * 1024 ** 2 and total <= 256 * 1024 ** 2,
                    'Box64 source exceeds extraction limits.')
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with source.extractfile(member) as input_file, target.open('xb') as output:
                    shutil.copyfileobj(input_file, output, 1024 * 1024)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            else:
                # Source links are unnecessary for the native target and must
                # never redirect extraction outside this private build tree.
                require(member.issym() or member.islnk(), 'Unsupported Box64 archive entry.')


def extract_runtime_files(archive, destination):
    """Copy only the two pinned GCC libraries and MIT notice for binary installs."""
    root = 'box64-' + COMMIT + '/'
    wanted = {root + 'x64lib/libstdc++.so.6': ('x64lib/libstdc++.so.6', 2559240, LIBRARIES['libstdc++.so.6']),
              root + 'x64lib/libgcc_s.so.1': ('x64lib/libgcc_s.so.1', 178760, LIBRARIES['libgcc_s.so.1']),
              root + 'LICENSE': ('LICENSE', 1064, BOX64_LICENSE_SHA256)}
    found = set()
    with tarfile.open(archive, 'r:gz') as source:
        for member in source:
            if member.name not in wanted:
                continue
            require(member.name not in found and member.isfile() and not member.issym() and not member.islnk(),
                    'Pinned runtime source contains a duplicate or linked required file.')
            relative, size, sha256 = wanted[member.name]
            require(member.size == size, 'Pinned runtime source file has an unexpected size.')
            with source.extractfile(member) as stream:
                data = stream.read(size + 1)
            require(len(data) == size and hashlib.sha256(data).hexdigest() == sha256, 'Pinned runtime library or license failed SHA-256 verification.')
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            with target.open('xb') as output:
                output.write(data)
            target.chmod(0o644)
            found.add(member.name)
    require(found == set(wanted), 'Pinned source is missing a required runtime library or license.')


@contextlib.contextmanager
def source_workspace(runtime):
    """Binary installation has only bounded downloads and no build processes."""
    base = Path(tempfile.mkdtemp(prefix='.box64-source-', dir=runtime))
    base.chmod(0o700)
    try:
        yield base
    finally:
        original = sys.exc_info()[1]
        try:
            require(base.parent == runtime and base.name.startswith('.box64-source-') and base.resolve() == base,
                    'Refusing to clean an unexpected runtime source workspace.')
            shutil.rmtree(base)
        except (OSError, ValueError) as cleanup:
            print('Bedrock ARM64 cleanup warning: ' + str(cleanup) + '. Private source tree preserved at ' + str(base), file=sys.stderr, flush=True)
            if original is None:
                raise


def source_build_headroom():
    memory = {line.split(':', 1)[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
              if line.startswith(('MemAvailable:', 'MemTotal:'))}
    reserve = max(256 * 1024 ** 2, (memory.get('MemTotal', 0) + 9) // 10)
    require(memory.get('MemTotal', 0) > 0 and memory.get('MemAvailable', 0) >= BUILD_MEMORY_BYTES + reserve,
            'A source-only ARM64 Box64 build requires 2 GiB of available physical RAM plus a host reserve of 10% (at least 256 MiB). '
            'Use the official Vortex release installer with its prebuilt ARM64 runtime on smaller hosts.')


def unmount_owned(mount, image):
    deadline = time.monotonic() + 30
    def budget(limit):
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'Private build volume cleanup deadline expired.')
        return min(limit, remaining)
    for attempt in range(8):
        # Recheck the exact private loop backing before every unmount attempt.
        info = json.loads(run(['findmnt', '--json', '--mountpoint', str(mount), '--output', 'TARGET,SOURCE,FSTYPE'], timeout=budget(10), capture=True))
        rows = info.get('filesystems', [])
        require(len(rows) == 1 and rows[0]['target'] == str(mount) and rows[0]['fstype'] == 'ext4'
                and re.fullmatch('/dev/loop[0-9]+', rows[0]['source']), 'Private build mount identity changed; preserved for review.')
        backing = run(['losetup', '--noheadings', '--output', 'BACK-FILE', rows[0]['source']], timeout=budget(10), capture=True).strip()
        require(backing == str(image), 'Private build loop backing changed; preserved for review.')
        result = subprocess.run(['umount', '--', str(mount)], env=ENV, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, timeout=budget(15))
        if result.returncode == 0:
            return
        require('busy' in result.stdout.lower() and attempt < 7 and time.monotonic() < deadline,
                'Private build volume could not be unmounted: ' + result.stdout.strip()[-1000:])
        time.sleep(budget(0.5))
    raise ValueError('Private build volume remained busy.')


@contextlib.contextmanager
def build_volume(runtime):
    base = Path(tempfile.mkdtemp(prefix='.box64-build-', dir=runtime))
    base.chmod(0o700)
    image, mount = base / 'work.ext4', base / 'work'
    mounted = False
    try:
        mount.mkdir(mode=0o700)
        with image.open('xb') as stream:
            stream.truncate(WORK_BYTES)
        run(['mkfs.ext4', '-q', '-F', '-m', '0', str(image)])
        run(['mount', '-o', 'loop,nodev,nosuid,noatime', str(image), str(mount)])
        mounted = True
        mount.chmod(0o700)
        info = json.loads(run(['findmnt', '--json', '--mountpoint', str(mount), '--output', 'TARGET,SOURCE,FSTYPE'], capture=True))
        rows = info.get('filesystems', [])
        require(len(rows) == 1 and rows[0]['target'] == str(mount) and rows[0]['fstype'] == 'ext4'
                and re.fullmatch('/dev/loop[0-9]+', rows[0]['source']), 'Private Box64 build volume verification failed.')
        backing = run(['losetup', '--noheadings', '--output', 'BACK-FILE', rows[0]['source']], capture=True).strip()
        require(backing == str(image), 'Private Box64 build volume backing file differs.')
        yield mount
    finally:
        original = sys.exc_info()[1]
        try:
            if mounted:
                unmount_owned(mount, image)
            require(base.parent == runtime and base.name.startswith('.box64-build-') and base.resolve() == base,
                    'Refusing to clean an unexpected Box64 build location.')
            shutil.rmtree(base)
        except (OSError, ValueError, subprocess.SubprocessError) as cleanup:
            # Keep the failure that interrupted compilation. Never recurse
            # through a live mount, use lazy/forced unmount or hide its location.
            print('Bedrock ARM64 cleanup warning: ' + str(cleanup) + '. Private build tree preserved at ' + str(base),
                  file=sys.stderr, flush=True)
            if original is None:
                raise


def build(command, work):
    unit = 'vortex-box64-build-' + uuid.uuid4().hex
    arguments = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec', '--unit=' + unit,
                 '--property=WorkingDirectory=' + str(work), '--property=MemoryMax=2G', '--property=MemorySwapMax=0',
                 '--property=CPUQuota=90%', '--property=TasksMax=128', '--property=RuntimeMaxSec=3600',
                 '--property=OOMPolicy=kill', '--property=KillMode=control-group', '--property=TimeoutStopSec=30',
                 '--property=Nice=10', '--property=IOWeight=10', '--property=NoNewPrivileges=yes',
                 '--property=PrivateNetwork=yes', '--property=PrivateTmp=yes', '--property=PrivateDevices=yes',
                 '--property=ProtectHome=yes', '--property=ProtectSystem=strict', '--property=ReadWritePaths=' + str(work),
                 '--setenv=PATH=' + ENV['PATH'], '--setenv=HOME=/nonexistent', '--setenv=LC_ALL=C.UTF-8', *command]
    try:
        run(arguments, timeout=3660)
    finally:
        # RuntimeMaxSec is also enforced by PID1 if this installer is interrupted.
        original = sys.exc_info()[1]
        try:
            stopped = subprocess.run(['systemctl', 'stop', unit + '.service'], env=ENV, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True, timeout=40)
            # A completed transient unit may already have been collected.
            require(stopped.returncode in (0, 5), 'Unable to stop bounded build unit ' + unit + ': ' + stopped.stdout.strip()[-1000:])
        except (OSError, ValueError, subprocess.SubprocessError) as cleanup:
            print('Bedrock ARM64 cleanup warning: ' + str(cleanup), file=sys.stderr, flush=True)
            if original is None:
                raise


def publish(candidate, target):
    # An administrator may have created the destination during compilation.
    # Linux RENAME_NOREPLACE keeps even an empty foreign directory intact.
    library = ctypes.CDLL(None, use_errno=True)
    rename = library.renameat2
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    result = rename(-100, os.fsencode(candidate), -100, os.fsencode(target), 1)
    if result:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), str(target))


def prepare_candidate_directories(candidate):
    """Normalize each newly owned directory before any trust or ELF checks."""
    candidate.chmod(0o755)
    trusted(candidate, directory=True)
    # Path.mkdir(parents=True) applies mode only to the final component. Make
    # every component explicitly and chmod it independently of caller umask.
    for relative in ('bin', 'lib', 'lib/x86_64', 'licenses'):
        directory = candidate / relative
        directory.mkdir(mode=0o755)
        directory.chmod(0o755)
        trusted(directory, directory=True)


def install(role):
    require(os.geteuid() == 0, 'Run the Bedrock runtime installer as root.')
    require(sys.platform == 'linux' and platform.machine().lower() in ('aarch64', 'arm64') and struct.calcsize('P') == 8,
            'The private Box64 runtime requires native ARM64 Linux userspace.')
    require(os.sysconf('SC_PAGE_SIZE') == 4096, 'Bedrock on ARM64 currently requires a 4 KiB page-size kernel.')
    # Incomplete or altered release assets always fail closed, even when a
    # previous compatible engine is already installed. They never cause a build.
    bundle = bundled_runtime()
    runtime = ROOTS[role] / 'runtime'
    for path in (ROOTS[role], runtime):
        if not os.path.lexists(path):
            trusted(path.parent, directory=True)
            path.mkdir(mode=0o755)
        trusted(path, directory=True)
    target = prefix(role)
    if os.path.lexists(target):
        return inspect(role)
    if bundle is None:
        for tool in ('cmake', 'gcc', 'g++', 'make', 'systemd-run', 'mkfs.ext4', 'mount', 'umount', 'findmnt', 'losetup'):
            require(shutil.which(tool, path=ENV['PATH']), 'Missing ARM64 Bedrock build dependency (' + tool + '). Run the full Vortex installer to prepare this host.')
        require(Path('/run/systemd/system').is_dir(), 'The bounded Bedrock runtime build requires systemd.')
        source_build_headroom()
        require(shutil.disk_usage(runtime).free >= WORK_BYTES + 512 * 1024 ** 2,
                'At least 2 GiB of free installation storage is required to build Bedrock ARM64 safely.')
    else:
        require(shutil.disk_usage(runtime).free >= 64 * 1024 ** 2 + len(bundle['files']['bin/box64']),
                'Insufficient free installation storage for the verified prebuilt ARM64 runtime.')
    lock_path = runtime / '.box64-install.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600,
                'Unexpected private Bedrock runtime installation lock.')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if os.path.lexists(target):
            return inspect(role)
        candidate = Path(tempfile.mkdtemp(prefix='.box64-candidate-', dir=runtime))
        candidate.chmod(0o755)
        try:
            with (source_workspace(runtime) if bundle is not None else build_volume(runtime)) as work:
                archive, source, output = work / 'source.tar.gz', work / 'source', work / 'build'
                source.mkdir(mode=0o755)
                print('Preparing ' + ('verified prebuilt' if bundle is not None else 'pinned source') + ' Box64 ' + VERSION +
                      ' for Minecraft Bedrock on ARM64…', file=sys.stderr, flush=True)
                download(archive)
                prepare_candidate_directories(candidate)
                if bundle is not None:
                    extract_runtime_files(archive, source)
                    (candidate / 'bin/box64').write_bytes(bundle['files']['bin/box64'])
                    require((source / 'LICENSE').read_bytes() == bundle['files']['licenses/Box64-LICENSE'],
                            'Bundled Box64 MIT license differs from the pinned upstream source.')
                else:
                    extract(archive, source)
                    # Source checkouts keep O2 execution performance and use a
                    # 2 GiB bounded build. Official releases use native CI output.
                    build(['cmake', '-S', str(source), '-B', str(output), '-DARM_DYNAREC=ON', '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
                           '-DCMAKE_C_COMPILER=/usr/bin/gcc', '-DCMAKE_C_FLAGS_RELWITHDEBINFO=-O2 -g0 -DNDEBUG',
                           '-DCMAKE_CXX_FLAGS_RELWITHDEBINFO=-O2 -g0 -DNDEBUG', '-DNOGIT=1'], work)
                    build(['cmake', '--build', str(output), '--parallel', '1'], work)
                    shutil.copyfile(output / 'box64', candidate / 'bin/box64')
                (candidate / 'bin/box64').chmod(0o755)
                elf(candidate / 'bin/box64', 183)
                for name in LIBRARIES:
                    incoming = source / 'x64lib' / name
                    require(incoming.is_file() and not incoming.is_symlink(), 'Pinned Box64 source is missing required x64 library: ' + name)
                    require(digest(incoming) == LIBRARIES[name], 'Pinned Box64 x64 library differs from the reviewed source inventory: ' + name)
                    destination = candidate / 'lib/x86_64' / name
                    shutil.copyfile(incoming, destination)
                    destination.chmod(0o644)
                    elf(destination, 62)
                shutil.copyfile(source / 'LICENSE', candidate / 'licenses/Box64-LICENSE')
                for name, (size, sha256) in GCC_LICENSES.items():
                    download(candidate / 'licenses' / name, GCC_SOURCE + name, size, sha256)
                (candidate / 'licenses/NOTICE').write_text(
                    'Box64 ' + VERSION + ': https://github.com/ptitSeb/box64/tree/' + COMMIT + '\n'
                    'Box64 is distributed under its MIT license (Box64-LICENSE).\n'
                    'The separate x86_64 libgcc_s and libstdc++ files retain their GCC licenses:\n'
                    'GNU GPL version 3 with the GCC Runtime Library Exception 3.1.\n'
                    'The private library bytes are from the pinned Box64 source archive x64lib directory.\n'
                    'GCC license texts: ' + GCC_SOURCE + '\n', encoding='utf-8')
                # Nothing invokes CMake install: binfmt, global libraries and
                # host Box64 configuration remain outside this transaction.
                result = subprocess.run([str(candidate / 'bin/box64'), '--version'], env={**ENV, 'BOX64_NORCFILES': '1', 'BOX64_DYNACACHE': '0'},
                                        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
                require(result.returncode == 0 and VERSION in result.stdout, 'The prepared Box64 executable failed its native version check.')
                value = {'schema': 1, 'engine': 'box64', 'version': VERSION, 'hostArch': 'arm64', 'guestArch': 'x64',
                         'pageSize': 4096, 'profile': 'generic-arm64-v1', 'source': {'commit': COMMIT, 'sha256': SOURCE_SHA256},
                         'executable': {'path': 'bin/box64', 'sha256': digest(candidate / 'bin/box64')},
                         'libraries': [{'path': 'lib/x86_64/' + name, 'sha256': digest(candidate / 'lib/x86_64' / name)} for name in LIBRARIES],
                         'installedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
                receipt = candidate / RECEIPT
                receipt.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n', encoding='utf-8')
                for item in candidate.rglob('*'):
                    item.chmod(0o755 if item.is_dir() or item == candidate / 'bin/box64' else 0o644)
                publish(candidate, target)
            return inspect(role)
        finally:
            if candidate.exists():
                require(candidate.parent == runtime and candidate.name.startswith('.box64-candidate-') and candidate.resolve() == candidate,
                        'Refusing to clean an unexpected Box64 staging location.')
                shutil.rmtree(candidate)
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('install', 'inspect', 'bundle-mode'))
    parser.add_argument('--role', choices=tuple(ROOTS), required=True)
    args = parser.parse_args()
    os.umask(0o022)
    def interrupted(signum, frame):
        raise InterruptedError('Runtime installation interrupted; preserving the active panel and workloads.')
    for termination in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(termination, interrupted)
    try:
        if args.operation == 'bundle-mode':
            if bundled_runtime() is not None:
                print('prebuilt')
            elif os.path.lexists(prefix(args.role)):
                inspect(args.role)
                print('installed')
            else:
                print('source')
            return 0
        print(json.dumps(install(args.role) if args.operation == 'install' else inspect(args.role), separators=(',', ':')))
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError, lzma.LZMAError) as error:
        print('Bedrock ARM64 runtime: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
