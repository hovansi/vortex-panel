#!/usr/bin/env bash
set -Eeuo pipefail

# The public release builder replaces this line in the standalone asset only.
DEFAULT_REPOSITORY='@VORTEX_REPOSITORY@'

bootstrap_fail() { printf 'Vortex bootstrap: %s\n' "$*" >&2; return 1; }

bootstrap_ipv4_shape() {
  local value=$1 part
  local -a octets=()
  [[ $value =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a octets <<< "$value"
  for part in "${octets[@]}"; do
    [[ $part == 0 || $part != 0* ]] && ((10#$part <= 255)) || return 1
  done
}

bootstrap_parse_args() {
  REPOSITORY=$DEFAULT_REPOSITORY
  BOOTSTRAP_VERSION=
  INSTALL_MODE=
  ACCESS_MODE=
  PUBLIC_IP=
  PUBLIC_PORT=
  SELF_SIGNED=
  SKIP_NETWORK=
  while [[ $# -gt 0 ]]; do
    case $1 in
      --repository)
        [[ $# -ge 2 && -n $2 ]] || { bootstrap_fail '--repository requires OWNER/REPO.'; return 1; }
        REPOSITORY=$2; shift 2;;
      --version)
        [[ $# -ge 2 && -n $2 ]] || { bootstrap_fail '--version requires X.Y.Z.'; return 1; }
        BOOTSTRAP_VERSION=$2; shift 2;;
      --root-mode|--service-user)
        [[ -z $INSTALL_MODE ]] || { bootstrap_fail 'Choose only one service mode.'; return 1; }
        INSTALL_MODE=$1; shift;;
      --local-only)
        [[ -z $ACCESS_MODE && -z $PUBLIC_IP && -z $PUBLIC_PORT ]] || { bootstrap_fail 'Choose one access mode.'; return 1; }
        ACCESS_MODE=local; shift;;
      --public-ip)
        [[ $# -ge 2 && -z $ACCESS_MODE && -z $PUBLIC_IP ]] && bootstrap_ipv4_shape "$2" || { bootstrap_fail '--public-ip requires one canonical IPv4 address.'; return 1; }
        PUBLIC_IP=$2; shift 2;;
      --public-port)
        [[ -z $ACCESS_MODE && -z $PUBLIC_PORT && $# -ge 2 && $2 =~ ^[1-9][0-9]{0,4}$ ]] && ((10#$2 <= 65535 && 10#$2 != 80)) || { bootstrap_fail '--public-port requires one TCP port from 1 to 65535 except 80 and cannot be combined with --local-only.'; return 1; }
        PUBLIC_PORT=$2; shift 2;;
      --self-signed)
        [[ -z $SELF_SIGNED ]] || { bootstrap_fail 'Duplicate --self-signed option.'; return 1; }
        SELF_SIGNED=--self-signed; shift;;
      --no-network-tuning)
        [[ -z $SKIP_NETWORK ]] || { bootstrap_fail 'Duplicate --no-network-tuning option.'; return 1; }
        SKIP_NETWORK=--no-network-tuning; shift;;
      --help|-h)
        printf '%s\n' 'Usage: sudo bash install.sh [--repository OWNER/REPO] [--version X.Y.Z] [--root-mode|--service-user] [--local-only|--public-ip IPv4] [--public-port PORT] [--self-signed] [--no-network-tuning]' \
          'Default: latest stable; fresh root service and public-IP HTTPS on TCP 19191; preserve existing access unless --public-port is supplied.'
        return 2;;
      *) bootstrap_fail "Unknown option: $1"; return 1;;
    esac
  done
  [[ $REPOSITORY != '@VORTEX_REPOSITORY@' ]] || { bootstrap_fail 'This source copy is unbound; pass --repository OWNER/REPO.'; return 1; }
  [[ $REPOSITORY =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$ && ${REPOSITORY#*/} != . && ${REPOSITORY#*/} != .. ]] || {
    bootstrap_fail 'Invalid GitHub repository; use OWNER/REPO without a URL.'; return 1;
  }
  [[ -z $BOOTSTRAP_VERSION || $BOOTSTRAP_VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
    bootstrap_fail '--version must be a stable X.Y.Z version without a v prefix.'; return 1;
  }
}

bootstrap_architecture() {
  local machine native_arch
  [[ $(uname -s) == Linux ]] || { echo 'Ubuntu Linux is required.' >&2; return 1; }
  machine=$(uname -m)
  case $machine in
    x86_64|amd64) VORTEX_NODE_ARCH=x64; VORTEX_DPKG_ARCH=amd64;;
    aarch64|arm64) VORTEX_NODE_ARCH=arm64; VORTEX_DPKG_ARCH=arm64;;
    *) echo 'A 64-bit x86_64/amd64 or aarch64/arm64 host is required.' >&2; return 1;;
  esac
  native_arch=$(dpkg --print-architecture) || return 1
  [[ $native_arch == "$VORTEX_DPKG_ARCH" ]] || {
    echo 'The Ubuntu userspace architecture must match the supported 64-bit host architecture.' >&2; return 1;
  }
}

# BEGIN fixed source parent
# Native runtimes must never descend from a shared-writable system directory.
# Inspect the existing parents before creating locks, receipts or source files.
vortex_source_parent_preflight() {
  local source_parent source_parent_info source_parent_owner source_parent_mode
  for source_parent in / /opt; do
    if [[ $source_parent == /opt && ! -e $source_parent && ! -L $source_parent ]]; then continue; fi
    [[ -d $source_parent && ! -L $source_parent ]] || {
      printf 'Source parent %s must already exist as a real directory without symlinks.\n' "$source_parent" >&2; return 1;
    }
    source_parent_info=$(LC_ALL=C stat -c '%u:%a' -- "$source_parent") || {
      printf 'Unable to inspect source parent %s; no installation changes were made.\n' "$source_parent" >&2; return 1;
    }
    IFS=: read -r source_parent_owner source_parent_mode <<< "$source_parent_info"
    [[ $source_parent_owner == 0 && $source_parent_mode =~ ^[0-7]{3,4}$ ]] && (( (8#$source_parent_mode & 0022) == 0 )) || {
      printf 'Source parent %s must be root-owned without group or other write access. Review its existing ownership and permissions before installing.\n' "$source_parent" >&2; return 1;
    }
  done
}
# END fixed source parent

bootstrap_preflight() {
  [[ $(id -u) == 0 ]] || { bootstrap_fail 'Run this bootstrap with sudo bash (or as root).'; return 1; }
  bootstrap_architecture || return 1
  vortex_source_parent_preflight || return 1
  [[ -r /etc/os-release ]] || { bootstrap_fail 'Unable to identify Ubuntu.'; return 1; }
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ ${ID:-} == ubuntu ]] && dpkg --compare-versions "${VERSION_ID:-0}" ge 22.04 || {
    bootstrap_fail 'Ubuntu 22.04 LTS or newer is required.'; return 1;
  }
  command -v apt-get >/dev/null && command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] || {
    bootstrap_fail 'A running Ubuntu systemd host with apt-get is required.'; return 1;
  }
}

bootstrap_dependencies() {
  # Capture the package baseline before even bootstrap prerequisites are added.
  # Raw dpkg/apt output works when python3 itself is missing on the fresh host.
  VORTEX_BOOTSTRAP_CAPTURE=$(mktemp -d /run/vortex-bootstrap-baseline.XXXXXXXX)
  trap '[[ -z ${VORTEX_BOOTSTRAP_CAPTURE:-} ]] || rm -rf -- "$VORTEX_BOOTSTRAP_CAPTURE"' EXIT
  chmod 0700 "$VORTEX_BOOTSTRAP_CAPTURE"
  dpkg-query -W '-f=${binary:Package}\t${Version}\t${Status}\n' > "$VORTEX_BOOTSTRAP_CAPTURE/packages.tsv"
  apt-mark showmanual > "$VORTEX_BOOTSTRAP_CAPTURE/manual.txt"
  cat /etc/machine-id > "$VORTEX_BOOTSTRAP_CAPTURE/machine-id"
  date -u +%Y-%m-%dT%H:%M:%SZ > "$VORTEX_BOOTSTRAP_CAPTURE/captured-at"
  local -a missing=()
  command -v curl >/dev/null || missing+=(curl)
  [[ -x /usr/bin/python3 ]] || missing+=(python3)
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  command -v ss >/dev/null || missing+=(iproute2)
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf '%s\n' 'Preparing download prerequisites from Ubuntu repositories...'
    apt-get update
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get install -y --no-install-recommends --no-remove "${missing[@]}"
  fi
  /usr/bin/python3 -I -B - "$VORTEX_BOOTSTRAP_CAPTURE" <<'VORTEX_BASELINE_PYTHON'
import json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
manual = set((root / 'manual.txt').read_text().splitlines())
packages = []
for line in (root / 'packages.tsv').read_text().splitlines():
    name, version, status = line.split('\t', 2)
    if status == 'install ok installed':
        packages.append({'name': name, 'version': version, 'manual': name in manual or name.split(':')[0] in manual})
value = {'schemaVersion': 1, 'machineId': (root / 'machine-id').read_text().strip(),
         'capturedAt': (root / 'captured-at').read_text().strip(), 'packages': packages}
with (root / 'baseline.json').open('x') as stream:
    os.chmod(root / 'baseline.json', 0o600)
    json.dump(value, stream)
VORTEX_BASELINE_PYTHON
  export VORTEX_BOOTSTRAP_BASELINE=$VORTEX_BOOTSTRAP_CAPTURE/baseline.json
  [[ -x /usr/bin/python3 && -s /etc/ssl/certs/ca-certificates.crt ]] && command -v curl >/dev/null && command -v ss >/dev/null || {
    bootstrap_fail 'curl, Ubuntu python3, iproute2 and the CA certificate bundle are required.'; return 1;
  }
}

bootstrap_main() {
  local parsed=0
  bootstrap_parse_args "$@" || parsed=$?
  [[ $parsed != 2 ]] || return 0
  [[ $parsed == 0 ]] || return "$parsed"
  bootstrap_preflight
  bootstrap_dependencies
  /usr/bin/python3 -I -B - "$REPOSITORY" "$BOOTSTRAP_VERSION" "$INSTALL_MODE" "$ACCESS_MODE" "$PUBLIC_IP" "$SELF_SIGNED" "$SKIP_NETWORK" "$PUBLIC_PORT" <<'VORTEX_BOOTSTRAP_PYTHON'
import hashlib
import io
import json
import os
import pathlib
import re
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

MIB = 1024 ** 2
MAX_ZIP = 32 * MIB
MAX_EXPANDED = 64 * MIB
MAX_MEMBER = 4 * MIB
BEDROCK_MEMBERS = {'deploy/bedrock-box64-arm64.tar.xz': 16 * MIB,
                   'deploy/bedrock-box64-arm64.json': 64 * 1024}
MAX_MEMBERS = 4096
ROOT_FILES = {'package.json', 'package-lock.json', 'README.md', '.gitignore', '.gitattributes', '.env.example', 'LICENSE', 'LICENSE.md', 'NOTICE'}
ROOT_DIRS = {'server', 'public', 'deploy', 'scripts', 'docs'}
PRIVATE_PARTS = {'output', 'data', 'node_modules', '.playwright-cli', 'coverage', '.git', '__pycache__',
                 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.ds_store', 'thumbs.db',
                 'vortex-access.json', 'live-client-api.py'}
PRIVATE_SUFFIX = re.compile(r'(?:\.bk[^/]*|\.bak|\.backup|\.orig|~|\.tmp|\.log|\.pyc|\.pem|\.key|\.p12|\.pfx)$', re.I)
REQUIRED = {'package.json', 'package-lock.json', 'README.md', 'server/index.js', 'server/host-zram.py', 'public/index.html', 'deploy/install.sh', 'deploy/application-isolation.py', 'deploy/configure-access.py', 'deploy/install-ledger.py', 'deploy/panel-layout-migrate.py'}
HOSTS = {'api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'}
SEMVER = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'


class BootstrapError(Exception):
    pass


def need(condition, message):
    if not condition:
        raise BootstrapError(message)


def approved_url(url):
    value = urllib.parse.urlsplit(url)
    need(value.scheme == 'https' and value.hostname in HOSTS and value.port in (None, 443)
         and value.username is None and value.password is None and not value.fragment,
         'Release download redirected outside the approved HTTPS GitHub hosts.')


class GitHubRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, request, fp, code, message, headers, newurl):
        approved_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def normal_opener():
    context = ssl.create_default_context()
    need(context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED, 'Verified TLS is required.')
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), GitHubRedirect(),
                                      urllib.request.HTTPSHandler(context=context))


def download(opener, url, maximum, expected_size=None):
    approved_url(url)
    request = urllib.request.Request(url, headers={'User-Agent': 'Vortex-Panel-bootstrap',
                                                  'Accept': 'application/vnd.github+json' if url.startswith('https://api.github.com/') else 'application/octet-stream'})
    deadline = time.monotonic() + 180
    try:
        with opener.open(request, timeout=30) as response:
            need(response.status == 200, 'GitHub did not return a successful release response.')
            length = response.headers.get('Content-Length')
            if length is not None:
                need(length.isdigit() and 0 < int(length) <= maximum, 'Release download exceeds its size limit.')
            result = bytearray()
            while True:
                need(time.monotonic() < deadline, 'Release download exceeded its time limit.')
                part = response.read(min(65536, maximum + 1 - len(result)))
                if not part:
                    break
                result.extend(part)
                need(len(result) <= maximum, 'Release download exceeds its size limit.')
            need(result and (expected_size is None or len(result) == expected_size), 'Release download size differs from GitHub metadata.')
            return bytes(result)
    except urllib.error.HTTPError as error:
        if error.code in (403, 429):
            raise BootstrapError('GitHub denied the release request (HTTP %s; a public API rate limit may apply). Wait for the limit to reset and verify the repository is public.' % error.code) from None
        if error.code == 404:
            raise BootstrapError('The public repository, release or required release asset was not found (HTTP404).') from None
        raise BootstrapError('GitHub release download failed (HTTP%s).' % error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise BootstrapError('Release download failed (%s); the installer was not executed.' % type(error).__name__) from None


def resolve_release(opener, repository, requested):
    suffix = 'tags/v' + requested if requested else 'latest'
    raw = download(opener, 'https://api.github.com/repos/' + repository + '/releases/' + suffix, MIB)
    try:
        release = json.loads(raw)
    except (ValueError, UnicodeError):
        raise BootstrapError('GitHub returned invalid release metadata.') from None
    need(isinstance(release, dict) and release.get('draft') is False and release.get('prerelease') is False,
         'A published stable release is required; draft/prerelease releases are not installed.')
    tag = release.get('tag_name')
    need(isinstance(tag, str) and re.fullmatch('v' + SEMVER, tag), 'The release tag must be vX.Y.Z.')
    version = tag[1:]
    need(not requested or requested == version, 'GitHub returned a different release version.')
    assets = release.get('assets')
    need(isinstance(assets, list) and len(assets) <= 100, 'GitHub release asset metadata is invalid.')
    selected = {}
    for name, maximum in [('vortex-panel-' + version + '.zip', MAX_ZIP), ('SHA256SUMS', 128 * 1024)]:
        matches = [asset for asset in assets if isinstance(asset, dict) and asset.get('name') == name]
        need(len(matches) == 1, 'Release must contain exactly one ' + name + ' asset.')
        asset = matches[0]
        need(asset.get('state') == 'uploaded' and type(asset.get('size')) is int and 0 < asset['size'] <= maximum,
             'Release asset is incomplete or exceeds its size limit: ' + name)
        url = 'https://github.com/' + repository + '/releases/download/' + tag + '/' + name
        need(isinstance(asset.get('browser_download_url'), str) and asset['browser_download_url'].casefold() == url.casefold(),
             'Release asset URL does not match the requested repository and version.')
        selected[name] = (url, asset['size'])
    return version, selected


def verified_archive(opener, version, assets):
    checksum_url, checksum_size = assets['SHA256SUMS']
    raw = download(opener, checksum_url, 128 * 1024, checksum_size)
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeError:
        raise BootstrapError('SHA256SUMS must contain ASCII checksum lines.') from None
    sums = {}
    for line in lines:
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
        need(match is not None and match[2] not in sums, 'SHA256SUMS has an invalid or duplicate checksum line.')
        sums[match[2]] = match[1]
    name = 'vortex-panel-' + version + '.zip'
    need(name in sums, 'SHA256SUMS does not identify the versioned source ZIP.')
    url, size = assets[name]
    archive = download(opener, url, MAX_ZIP, size)
    need(hashlib.sha256(archive).hexdigest() == sums[name], 'Source ZIP SHA-256 verification failed; nothing was extracted or executed.')
    return archive


def archive_members(bundle, version):
    entries = bundle.infolist()
    need(0 < len(entries) <= MAX_MEMBERS, 'Source ZIP contains too many entries.')
    names = set()
    files = set()
    total = 0
    for entry in entries:
        name = entry.filename
        need(name and entry.orig_filename == name and len(name.encode('utf-8')) <= 512 and not any(ord(c) < 32 or ord(c) == 127 for c in name)
             and '\\' not in name and ':' not in name, 'Source ZIP contains an unsafe path.')
        normalized = name[:-1] if entry.is_dir() else name
        parts = pathlib.PurePosixPath(normalized).parts
        need(parts and not name.startswith('/') and '/'.join(parts) == normalized and not any(part in ('.', '..') for part in parts),
             'Source ZIP contains a path traversal or ambiguous path.')
        need(not any(part.lower() in PRIVATE_PARTS or PRIVATE_SUFFIX.search(part)
                     or (part.lower() == '.env' or part.lower().startswith('.env.')) and normalized != '.env.example'
                     for part in parts), 'Source ZIP contains private, backup or temporary paths.')
        need(normalized not in names, 'Source ZIP contains a duplicate file or directory.')
        names.add(normalized)
        workflow = parts[0] == '.github' and (entry.is_dir() and parts in (('.github',), ('.github', 'workflows'))
                     or len(parts) == 3 and parts[1] == 'workflows' and parts[2].endswith(('.yml', '.yaml')) and not entry.is_dir())
        need(not any(part.startswith('.') and not (len(parts) == 1 and normalized in ROOT_FILES)
                     and not (index == 0 and part == '.github' and workflow) for index, part in enumerate(parts)),
             'Source ZIP contains an unexpected hidden path.')
        need((len(parts) == 1 and normalized in ROOT_FILES and not entry.is_dir())
             or parts[0] in ROOT_DIRS and (entry.is_dir() or len(parts) >= 2) or workflow,
             'Source ZIP contains an unexpected root or workflow path.')
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        need(kind in ((0, stat.S_IFDIR) if entry.is_dir() else (0, stat.S_IFREG)) and not mode & 0o7000,
             'Source ZIP contains a link, special file or privileged mode.')
        need(not entry.flag_bits & 1 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
             'Encrypted or unsupported source ZIP entries are not accepted.')
        member_limit = BEDROCK_MEMBERS.get(normalized, MAX_MEMBER)
        need(0 <= entry.file_size <= member_limit and (not entry.is_dir() or entry.file_size == 0), 'Source ZIP member exceeds its size limit.')
        total += entry.file_size
        need(total <= MAX_EXPANDED, 'Expanded source ZIP exceeds its size limit.')
        if not entry.is_dir():
            files.add(normalized)
    need(not files.intersection(BEDROCK_MEMBERS) or set(BEDROCK_MEMBERS) <= files,
         'The release ZIP contains an incomplete Bedrock runtime bundle.')
    need(REQUIRED <= files, 'The release ZIP is missing required installer/source files.')
    need(not any('/'.join(pathlib.PurePosixPath(name).parts[:index]) in files
                 for name in names for index in range(1, len(pathlib.PurePosixPath(name).parts))),
         'Source ZIP contains a file/directory collision.')
    need(bundle.testzip() is None, 'Source ZIP CRC validation failed.')
    try:
        package = json.loads(bundle.read('package.json'))
        lock = json.loads(bundle.read('package-lock.json'))
    except (ValueError, UnicodeError):
        raise BootstrapError('Release package metadata is invalid.') from None
    need(isinstance(package, dict) and isinstance(lock, dict) and isinstance(lock.get('packages'), dict)
         and isinstance(lock['packages'].get(''), dict) and package.get('name') == 'vortex-panel'
         and package.get('version') == version and lock.get('version') == version
         and lock['packages'][''].get('version') == version, 'Release package versions do not match the verified tag.')
    return entries


def install_release(opener, repository, requested, mode, access_mode='', public_ip='', self_signed='', skip_network='', public_port=''):
    if public_port:
        need(isinstance(public_port, str) and re.fullmatch(r'[1-9][0-9]{0,4}', public_port) and int(public_port) <= 65535 and int(public_port) != 80 and access_mode != 'local', 'Invalid public HTTPS port.')
    version, assets = resolve_release(opener, repository, requested)
    print('Downloading Vortex Panel ' + version + ' from ' + repository + '...', flush=True)
    archive = verified_archive(opener, version, assets)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        entries = archive_members(bundle, version)
        print('Verified source ZIP SHA-256, paths and archive bounds.', flush=True)
        with tempfile.TemporaryDirectory(prefix='vortex-bootstrap-') as directory:
            workspace = pathlib.Path(directory)
            for entry in entries:
                target = workspace.joinpath(*pathlib.PurePosixPath(entry.filename).parts)
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                    with os.fdopen(descriptor, 'wb') as stream:
                        stream.write(bundle.read(entry))
            command = ['/bin/bash', str(workspace / 'deploy/install.sh')]
            if mode:
                command.append(mode)
            if access_mode == 'local':
                command.append('--local-only')
            if public_ip:
                command.extend(['--public-ip', public_ip])
            if self_signed:
                need(self_signed == '--self-signed', 'Invalid TLS mode.')
                command.append('--self-signed')
            if skip_network:
                need(skip_network == '--no-network-tuning', 'Invalid network mode.')
                command.append('--no-network-tuning')
            if public_port:
                command.extend(['--public-port', public_port])
            print('Starting the existing Ubuntu installer...', flush=True)
            result = subprocess.run(command, cwd=workspace, check=False)
            need(result.returncode == 0, 'The Ubuntu installer failed (exit%s); review its output.' % result.returncode)
    print('Vortex installation finished. Use the panel URL and setup instructions printed above.\n'
          'Fresh installs use public-IP HTTPS on TCP 19191 unless --local-only is selected; updates retain existing access unless --public-port is supplied.', flush=True)


def main():
    try:
        values = sys.argv[1:]
        need(len(values) in (5, 7, 8), 'Invalid installer argument count.')
        repository, requested, mode, access_mode, public_ip = values[:5]
        install_release(normal_opener(), repository, requested, mode, access_mode, public_ip, *(values[5:] or ['', '']))
    except (BootstrapError, zipfile.BadZipFile, OSError, ValueError) as error:
        print('Vortex bootstrap: ' + (str(error) if isinstance(error, BootstrapError) else type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
VORTEX_BOOTSTRAP_PYTHON
}

bootstrap_main "$@"
