#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Installs only vortex-node.service; panel source, unit, account and data stay separate.
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
ADVERTISE_ENDPOINT=
AGENT_PORT=8443
RESUME_LEDGER_SHA=
while [[ $# -gt 0 ]]; do
  case $1 in
    --endpoint) [[ $# -ge 2 ]] || exit 1; ADVERTISE_ENDPOINT=$2; shift 2;;
    --port) [[ $# -ge 2 ]] || exit 1; AGENT_PORT=$2; shift 2;;
    --resume-ledger) [[ $# -ge 2 && $2 =~ ^[a-f0-9]{64}$ && -z $RESUME_LEDGER_SHA ]] || exit 1; RESUME_LEDGER_SHA=$2; shift 2;;
    *) echo 'Usage: sudo bash deploy/install-node.sh [--endpoint https://YOUR_VPS_IP:8443] [--port 8443] [--resume-ledger REVIEWED_CAPTURE_SHA256]' >&2; exit 1;;
  esac
done
[[ $AGENT_PORT =~ ^[0-9]{4,5}$ && $AGENT_PORT -ge 1024 && $AGENT_PORT -le 65535 ]] || { echo 'Agent port must be an integer from 1024 to 65535.' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu ]] && dpkg --compare-versions "$VERSION_ID" ge 22.04 || { echo 'Ubuntu 22.04 LTS or newer is required.' >&2; exit 1; }
# BEGIN host architecture
vortex_host_architecture() {
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
vortex_host_architecture
# END host architecture
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
vortex_source_parent_preflight
# BEGIN installer transaction lock
# Serialize the complete installer with host memory and native erasure. Never
# replace or unlink this shared lock inode, including after failed installation.
acquire_installer_lock() {
  local lock_path=/run/vortex-os-maintenance.lock lock_info descriptor_info candidate_fd parent_info parent_owner parent_mode
  command -v flock >/dev/null 2>&1 || { echo 'The util-linux flock command is required before installation.' >&2; return 1; }
  [[ -d /run && ! -L /run ]] || return 1
  parent_info=$(LC_ALL=C stat -c '%u:%a' -- /run) || return 1
  IFS=: read -r parent_owner parent_mode <<< "$parent_info"
  [[ $parent_owner == 0 && $parent_mode =~ ^[0-7]{3,4}$ ]] && (( (8#$parent_mode & 0022) == 0 )) || return 1
  if [[ ! -e $lock_path && ! -L $lock_path ]]; then
    if ! (umask 077; set -o noclobber; : > "$lock_path") 2>/dev/null; then
      [[ -e $lock_path || -L $lock_path ]] || return 1
    fi
  fi
  [[ -f $lock_path && ! -L $lock_path ]] || return 1
  lock_info=$(LC_ALL=C stat -c '%u:%h:%a:%d:%i' -- "$lock_path") || return 1
  [[ $lock_info == 0:1:600:* ]] || return 1
  exec {candidate_fd}<>"$lock_path" || return 1
  descriptor_info=$(LC_ALL=C stat -Lc '%u:%h:%a:%d:%i' -- "/proc/$$/fd/$candidate_fd") || { exec {candidate_fd}>&-; return 1; }
  if [[ $descriptor_info != "$lock_info" || ! -f $lock_path || -L $lock_path ]] || [[ $(LC_ALL=C stat -c '%u:%h:%a:%d:%i' -- "$lock_path") != "$descriptor_info" ]]; then
    exec {candidate_fd}>&-
    return 1
  fi
  if ! flock -n "$candidate_fd"; then
    exec {candidate_fd}>&-
    echo 'Another Vortex operating-system operation is in progress. Retry after it finishes.' >&2
    return 1
  fi
  if [[ ! -f $lock_path || -L $lock_path ]] || [[ $(LC_ALL=C stat -c '%u:%h:%a:%d:%i' -- "$lock_path") != "$descriptor_info" ]]; then
    exec {candidate_fd}>&-
    return 1
  fi
  VORTEX_INSTALL_LOCK_FD=$candidate_fd
}
acquire_installer_lock || { echo 'The private Vortex transaction lock could not be safely acquired.' >&2; exit 1; }
# END installer transaction lock
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALL_ROOT=/opt/vortex-node
CONFIG_FILE=/etc/vortex-node.json
TLS_DIR=/etc/vortex-node
UNIT_FILE=/etc/systemd/system/vortex-node.service
ZRAM_HELPER=/usr/local/libexec/vortex-host-zram.py
PRIVATE_RUNTIME=
NEW_TLS=false
NEW_HELPER=false
UPGRADED_HELPER=false
NEW_ISOLATION_HELPER=false
INSTALL_COMPLETED=false
INSTALL_DIR=$INSTALL_ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$
RECOVERY_DIR=$(mktemp -d /tmp/vortex-node-install.XXXXXXXX)
ISOLATION_TRANSACTION=$RECOVERY_DIR/application-isolation.json
ISOLATION_ROLLBACK_FAILED=false
rollback_isolation() {
  if [[ -f $ISOLATION_TRANSACTION ]]; then
    if ! python3 "$SOURCE_DIR/deploy/application-isolation.py" rollback --owner vortex-node.service --transaction "$ISOLATION_TRANSACTION"; then
      ISOLATION_ROLLBACK_FAILED=true
      echo "Owned sandbox policy recovery needs review: $ISOLATION_TRANSACTION" >&2
    fi
  fi
}
NODE_TEMP=
CHANGED_SERVICE=false
PREVIOUS_ACTIVE=false
PREVIOUS_ENABLED=false
PREVIOUS_LINK=
systemctl is-active --quiet vortex-node && PREVIOUS_ACTIVE=true
systemctl is-enabled --quiet vortex-node && PREVIOUS_ENABLED=true
if [[ -L $INSTALL_ROOT/current ]]; then PREVIOUS_LINK=$(readlink -- "$INSTALL_ROOT/current"); elif [[ -e $INSTALL_ROOT/current ]]; then echo 'Node current path must be a symlink.' >&2; exit 1; fi
[[ ! -L $INSTALL_ROOT && ! -L $INSTALL_ROOT/releases && ! -L $TLS_DIR && ! -L $CONFIG_FILE && ! -L $UNIT_FILE ]] || { echo 'Node system paths must not be symlinks.' >&2; exit 1; }
assert_real_ancestors() { local current=$1; while [[ $current != / ]]; do [[ ! -L $current ]] || { echo 'Node system path ancestors must not be symlinks.' >&2; return 1; }; current=$(dirname -- "$current"); done; }
assert_real_ancestors "$INSTALL_DIR"
assert_real_ancestors "$CONFIG_FILE"
assert_real_ancestors "$TLS_DIR"
assert_real_ancestors "$UNIT_FILE"
assert_real_ancestors "$ZRAM_HELPER"
[[ ! -e $INSTALL_DIR && ! -L $INSTALL_DIR && ! -e $INSTALL_ROOT/current.next && ! -L $INSTALL_ROOT/current.next ]] || { echo 'Node staging paths already exist; review the previous operation before retrying.' >&2; exit 1; }
[[ ! -f $UNIT_FILE ]] || cp -a -- "$UNIT_FILE" "$RECOVERY_DIR/service"
cleanup() {
  if [[ $INSTALL_COMPLETED != true && $UPGRADED_HELPER == true && -n $RECOVERY_DIR && -f $RECOVERY_DIR/host-zram.py && ! -L $ZRAM_HELPER && -f $ZRAM_HELPER ]] && cmp -s -- "$SOURCE_DIR/server/host-zram.py" "$ZRAM_HELPER"; then
    install -m 0755 "$RECOVERY_DIR/host-zram.py" "$ZRAM_HELPER"
  fi
  if [[ $INSTALL_COMPLETED != true && $NEW_ISOLATION_HELPER == true && ! -L /usr/local/libexec/vortex-application-isolation.py && -f /usr/local/libexec/vortex-application-isolation.py ]] && cmp -s -- "$SOURCE_DIR/deploy/application-isolation.py" /usr/local/libexec/vortex-application-isolation.py; then
    rm -f -- /usr/local/libexec/vortex-application-isolation.py
  fi
  if [[ $INSTALL_COMPLETED != true && $NEW_HELPER == true && ! -L $ZRAM_HELPER && -f $ZRAM_HELPER ]] && cmp -s -- "$SOURCE_DIR/server/host-zram.py" "$ZRAM_HELPER"; then
    rm -f -- "$ZRAM_HELPER"
  fi
  if [[ $INSTALL_COMPLETED != true && -n $PRIVATE_RUNTIME ]]; then echo "Installer-created private runtime retained for recovery: $PRIVATE_RUNTIME" >&2; fi
  if [[ -n $NODE_TEMP && $NODE_TEMP == /tmp/vortex-node-runtime.* && -d $NODE_TEMP && ! -L $NODE_TEMP ]]; then rm -rf -- "$NODE_TEMP"; fi
  if [[ $ISOLATION_ROLLBACK_FAILED != true && -n $RECOVERY_DIR && $RECOVERY_DIR == /tmp/vortex-node-install.* && -d $RECOVERY_DIR && ! -L $RECOVERY_DIR ]]; then rm -rf -- "$RECOVERY_DIR"; fi
}
rollback() {
  local code=$? line=$1 failed=false
  trap - ERR
  set +e
  echo "Node installation failed at line $line. Existing node configuration/data are retained." >&2
  if [[ $CHANGED_SERVICE == true ]]; then
    if systemctl stop vortex-node; then rollback_isolation; else
      failed=true
      ISOLATION_ROLLBACK_FAILED=true
      echo "Service stop was not confirmed; sandbox policy retained for review: $ISOLATION_TRANSACTION" >&2
    fi
    if [[ -f $RECOVERY_DIR/service ]]; then cp -a -- "$RECOVERY_DIR/service" "$UNIT_FILE" || failed=true; else rm -f -- "$UNIT_FILE" || failed=true; fi
    if [[ -n $PREVIOUS_LINK ]]; then ln -sfn -- "$PREVIOUS_LINK" "$INSTALL_ROOT/current.next" && mv -Tf -- "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current" || failed=true; else rm -f -- "$INSTALL_ROOT/current" "$INSTALL_ROOT/current.next" || failed=true; fi
    systemctl daemon-reload || failed=true
    if [[ $PREVIOUS_ENABLED == true ]]; then systemctl enable vortex-node || failed=true; else systemctl disable vortex-node || failed=true; fi
    if [[ $PREVIOUS_ACTIVE == true ]]; then systemctl start vortex-node || failed=true; fi
    if [[ $failed == true ]]; then echo "Node recovery needs manual review: $RECOVERY_DIR" >&2; RECOVERY_DIR=; fi
  else rollback_isolation; fi
  exit "$code"
}
trap cleanup EXIT
trap 'rollback "$LINENO"' ERR
if [[ -n $RESUME_LEDGER_SHA ]]; then
  python3 "$SOURCE_DIR/deploy/install-ledger.py" validate-capture --role worker --capture-sha256 "$RESUME_LEDGER_SHA"
  python3 "$SOURCE_DIR/deploy/install-ledger.py" capture-resume --role worker --capture-sha256 "$RESUME_LEDGER_SHA"
else
  [[ ! -e /run/vortex-install-ledger-worker.json && ! -L /run/vortex-install-ledger-worker.json ]] || { echo 'A previous installer baseline exists. Review its private recovery state, then resume with its exact SHA-256; it will not be overwritten.' >&2; false; }
  python3 "$SOURCE_DIR/deploy/install-ledger.py" capture --role worker
fi
apt-get -o DPkg::Lock::Timeout=120 update
DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y ca-certificates curl openssl unzip zip rsync xz-utils tar iproute2 procps coreutils findutils libc6 libgcc-s1 libstdc++6 libatomic1 zlib1g libcurl4 nftables ufw e2fsprogs util-linux bubblewrap python3 python3-venv kmod
DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y --no-upgrade --no-remove gcc make pkg-config libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev liblzma-dev libncurses-dev libgdbm-dev uuid-dev libzstd-dev
if [[ $VORTEX_NODE_ARCH == arm64 ]]; then
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y --no-upgrade --no-remove g++ cmake libjemalloc2
fi
# BEGIN optional kernel module
prepare_memory_module() {
  local kernel package candidate metadata dependency_status dependency_query_code dependency_candidate='' audit simulation operation changed remainder expected
  local requested=false dependency_requested=false dependency_absent=false unsafe=false
  local -a targets=()
  if modprobe --dry-run --ignore-install zram num_devices=0 >/dev/null 2>&1; then return 0; fi
  if ! kernel=$(uname -r 2>/dev/null) || [[ ! $kernel =~ ^[0-9][A-Za-z0-9.+_-]{0,126}$ ]]; then
    echo 'Optional memory assistance is unavailable: the running kernel could not be identified safely.' >&2
    return 0
  fi
  package=linux-modules-extra-$kernel
  if ! candidate=$(LC_ALL=C apt-cache policy "$package" 2>/dev/null | awk '$1 == "Candidate:" { print $2; exit }') || [[ ! $candidate =~ ^[0-9][A-Za-z0-9.+:~_-]{0,127}$ ]]; then
    echo "Optional memory assistance is unavailable: no matching module package exists for $kernel. The current kernel is retained." >&2
    return 0
  fi
  if ! audit=$(LC_ALL=C dpkg --audit 2>&1) || [[ -n $audit ]]; then
    echo 'Optional memory module preparation was skipped: an existing package transaction needs administrator review.' >&2
    return 0
  fi
  targets+=("$package=$candidate")
  if ! metadata=$(LC_ALL=C apt-cache show "$package=$candidate" 2>/dev/null); then
    echo 'Optional memory module preparation was skipped: exact package metadata is unavailable.' >&2
    return 0
  fi
  if awk '/^Depends:/ { sub(/^Depends:[[:space:]]*/, ""); count=split($0, dependencies, /,[[:space:]]*/); for (i=1; i<=count; i++) if (dependencies[i] == "wireless-regdb") found=1 } END { exit !found }' <<< "$metadata"; then
    if dependency_status=$(LC_ALL=C dpkg-query -W '-f=${Status}' wireless-regdb 2>/dev/null); then
      if [[ $dependency_status == 'unknown ok not-installed' ]]; then
        dependency_absent=true
      elif [[ $dependency_status != 'install ok installed' ]]; then
        echo 'Optional memory module preparation was skipped: its dependency has an existing package state that needs review.' >&2
        return 0
      fi
    else
      dependency_query_code=$?
      if [[ $dependency_query_code != 1 || -n $dependency_status ]]; then
        echo 'Optional memory module preparation was skipped: its dependency state could not be established safely.' >&2
        return 0
      fi
      dependency_absent=true
    fi
    if [[ $dependency_absent == true ]]; then
      if ! dependency_candidate=$(LC_ALL=C apt-cache policy wireless-regdb 2>/dev/null | awk '$1 == "Candidate:" { print $2; exit }') || [[ ! $dependency_candidate =~ ^[0-9][A-Za-z0-9.+:~_-]{0,127}$ ]]; then
        echo 'Optional memory module preparation was skipped: its fresh dependency could not be pinned safely.' >&2
        return 0
      fi
      targets+=("wireless-regdb=$dependency_candidate")
    fi
  fi
  if ! simulation=$(LC_ALL=C apt-get -o DPkg::Lock::Timeout=120 --simulate --no-install-recommends --no-remove --no-upgrade install "${targets[@]}" 2>&1); then
    echo 'Optional memory module preparation was skipped because its exact-package plan could not be verified.' >&2
    return 0
  fi
  while read -r operation changed remainder; do
    case $operation in
      Inst|Conf)
        expected=''
        if [[ $changed == "$package" || $changed == "$package:$VORTEX_DPKG_ARCH" ]]; then
          expected=$candidate
          if [[ $operation == Inst ]]; then requested=true; elif [[ $requested != true ]]; then unsafe=true; fi
        elif [[ -n $dependency_candidate && ( $changed == wireless-regdb || $changed == wireless-regdb:all ) ]]; then
          expected=$dependency_candidate
          if [[ $operation == Inst ]]; then dependency_requested=true; elif [[ $dependency_requested != true ]]; then unsafe=true; fi
        else
          unsafe=true
        fi
        # A fresh action begins with (version; [old-version] would be an upgrade.
        if [[ -z $expected || $remainder != "($expected "* ]]; then unsafe=true; fi
        ;;
      Remv|Purg) unsafe=true;;
    esac
  done <<< "$simulation"
  if [[ $unsafe == true || $requested != true ]]; then
    echo 'Optional memory module preparation was skipped: it would change an unapproved package/version or has no matching fresh install action.' >&2
    return 0
  fi
  if ! DEBIAN_FRONTEND=noninteractive LC_ALL=C NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get -o DPkg::Lock::Timeout=120 --no-install-recommends --no-remove --no-upgrade install -y "${targets[@]}"; then
    echo 'Optional memory module preparation failed. Vortex installation continues without changing the running kernel.' >&2
    return 0
  fi
  if ! modprobe --dry-run --ignore-install zram num_devices=0 >/dev/null 2>&1; then
    echo 'Optional memory assistance is still unavailable after package preparation. No module was loaded or feature enabled.' >&2
  fi
  return 0
}
prepare_memory_module
# END optional kernel module
# Install the management/runtime tools once; never enable/reset a firewall or
# apply global kernel tuning to an existing customer's VPS.
for tool in curl openssl unzip zip rsync xz tar sha256sum nft ufw ip ss ps find findmnt losetup mount umount fallocate mkfs.ext4 e2fsck resize2fs systemctl busctl bwrap setpriv python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required worker tool is unavailable: $tool" >&2; false; }
done
if [[ -f $SOURCE_DIR/deploy/application-isolation.py ]]; then
  if ! python3 "$SOURCE_DIR/deploy/application-isolation.py" prepare --owner vortex-node.service --transaction "$ISOLATION_TRANSACTION"; then
    rollback_isolation
    echo 'Optional application sandbox setup is unavailable; Vortex Node installation continues.' >&2
  fi
fi
# Keep the exact ownership verifier independently of a release tree. Removal
# executes a trusted private copy, never an administrator-edited helper.
ISOLATION_HELPER=/usr/local/libexec/vortex-application-isolation.py
assert_real_ancestors "$ISOLATION_HELPER"
if [[ -e $ISOLATION_HELPER || -L $ISOLATION_HELPER ]]; then
  [[ ! -L $ISOLATION_HELPER && -f $ISOLATION_HELPER && $(stat -c '%u:%h' -- "$ISOLATION_HELPER") == 0:1 ]] && cmp -s -- "$SOURCE_DIR/deploy/application-isolation.py" "$ISOLATION_HELPER" || { echo 'Existing application-isolation verifier differs; it was preserved for review.' >&2; false; }
else
  install -d -m 0755 /usr/local/libexec
  install -m 0755 "$SOURCE_DIR/deploy/application-isolation.py" "$ISOLATION_HELPER"
  NEW_ISOLATION_HELPER=true
fi
# BEGIN previous worker interpreter
# Reuse only the native private interpreter already proven by this worker's
# fixed service and exclusive installer receipt. Never adopt a shared runtime.
if [[ -f $UNIT_FILE ]]; then
  PREVIOUS_NODE_BIN=$(python3 - "$UNIT_FILE" "$TLS_DIR/install-manifest.json" "$CONFIG_FILE" "$INSTALL_ROOT" "$VORTEX_NODE_ARCH" <<'PY'
import hashlib, json, os, pathlib, re, stat, sys
unit, manifest, config, root = map(pathlib.Path, sys.argv[1:5])
arch = sys.argv[5]
def trusted(path, private=False, maximum=256 * 1024 ** 2):
    for parent in reversed(path.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('Previous worker interpreter evidence has unsafe ancestors.')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_mode & (0o077 if private else 0o022) or info.st_size > maximum:
        raise SystemExit('Previous worker interpreter evidence is unsafe.')
    return info
trusted(unit, maximum=65536)
starts = [line[len('ExecStart='):] for line in unit.read_text().splitlines() if line.startswith('ExecStart=')]
if len(starts) != 1:
    raise SystemExit('Previous worker service start command is ambiguous.')
pattern = '(' + re.escape(str(root)) + r'/tools/runtime-[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*/node-v22\.[0-9]+\.[0-9]+-linux-' + re.escape(arch) + '/bin/node) ' + re.escape(str(root / 'current/server/node-cli.js')) + ' serve'
match = re.fullmatch(pattern, starts[0])
if not match or not manifest.exists() or not config.exists():
    raise SystemExit(0)
trusted(manifest, private=True, maximum=16 * 1024 ** 2)
trusted(config, private=True, maximum=65536)
receipt, settings = json.loads(manifest.read_text()), json.loads(config.read_text())
uuid_pattern = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
if receipt.get('schemaVersion') != 1 or receipt.get('product') != 'vortex-node' or receipt.get('role') != 'worker' or not re.fullmatch(uuid_pattern, str(receipt.get('installId', '')), re.I) or not re.fullmatch(uuid_pattern, str(settings.get('nodeId', '')), re.I) or receipt.get('nodeId') != settings.get('nodeId') or settings.get('schemaVersion') != 1 or not isinstance(receipt.get('components'), list) or len(receipt['components']) > 50000:
    raise SystemExit('Previous worker interpreter ownership receipt does not match this node.')
target = pathlib.Path(match[1])
info = trusted(target)
if not os.access(target, os.X_OK):
    raise SystemExit('Previous worker interpreter is not executable.')
hasher = hashlib.sha256()
with target.open('rb') as stream:
    for block in iter(lambda: stream.read(1024 ** 2), b''):
        hasher.update(block)
expected = {'path': str(target), 'kind': 'file', 'dev': info.st_dev, 'ino': info.st_ino, 'mode': stat.S_IMODE(info.st_mode), 'uid': 0, 'sha256': hasher.hexdigest(), 'existedBefore': False, 'createdByInstallId': receipt['installId']}
rows = [row for row in receipt['components'] if isinstance(row, dict) and row.get('path') == str(target)]
if len(rows) != 1 or any(rows[0].get(key) != value for key, value in expected.items()):
    raise SystemExit('Previous worker interpreter differs from its exclusive installer receipt.')
print(target)
PY
  )
  if [[ -n $PREVIOUS_NODE_BIN ]]; then export PATH="${PREVIOUS_NODE_BIN%/node}:$PATH"; fi
fi
# END previous worker interpreter
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
NODE_ARCH=$(node -p 'process.arch' 2>/dev/null || true)
if [[ ! $NODE_MAJOR =~ ^[0-9]{1,3}$ || $NODE_MAJOR -lt 22 || $NODE_ARCH != "$VORTEX_NODE_ARCH" ]]; then
  NODE_TEMP=$(mktemp -d /tmp/vortex-node-runtime.XXXXXXXX)
  curl --fail --location --proto '=https' --tlsv1.2 --output "$NODE_TEMP/SHASUMS256.txt" https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  NODE_FILE=$(awk -v arch="$VORTEX_NODE_ARCH" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2; exit}' "$NODE_TEMP/SHASUMS256.txt")
  [[ -n $NODE_FILE ]] || { echo 'Unable to resolve official Node 22 archive.' >&2; false; }
  curl --fail --location --proto '=https' --tlsv1.2 --output "$NODE_TEMP/$NODE_FILE" "https://nodejs.org/dist/latest-v22.x/$NODE_FILE"
  (cd -- "$NODE_TEMP" && awk -v f="$NODE_FILE" '$2 == f' SHASUMS256.txt | sha256sum --check -)
  PRIVATE_RUNTIME=$INSTALL_ROOT/tools/runtime-$(date -u +%Y%m%dT%H%M%SZ)-$$/${NODE_FILE%.tar.xz}
  assert_real_ancestors "$PRIVATE_RUNTIME"
  [[ ! -e $PRIVATE_RUNTIME && ! -L $PRIVATE_RUNTIME ]] || { echo 'The private runtime path already exists; review it before retrying.' >&2; false; }
  install -d -m 0755 "$PRIVATE_RUNTIME"
  tar --no-same-owner --no-same-permissions -xJf "$NODE_TEMP/$NODE_FILE" --strip-components=1 -C "$PRIVATE_RUNTIME"
  chown -hR -- root:root "$PRIVATE_RUNTIME"
  chmod -R a+rX,go-w -- "$PRIVATE_RUNTIME"
  export PATH=$PRIVATE_RUNTIME/bin:$PATH
fi
NODE_BIN=$(command -v node)
[[ ! -L $ZRAM_HELPER ]] || { echo 'The OS helper path must not be linked.' >&2; false; }
if [[ -e $ZRAM_HELPER ]]; then
  [[ -f $ZRAM_HELPER && $(stat -c '%u:%h' -- "$ZRAM_HELPER") == 0:1 ]] || { echo 'An existing OS helper is unsafe; it was preserved and requires review.' >&2; false; }
  if ! cmp -s -- "$SOURCE_DIR/server/host-zram.py" "$ZRAM_HELPER"; then
    python3 - "$INSTALL_ROOT" "$ZRAM_HELPER" <<'PY'
import os, pathlib, stat, sys
root, helper = map(pathlib.Path, sys.argv[1:])
release = (root / 'current').resolve(strict=True)
if release.parent != root / 'releases':
    raise SystemExit('Previous helper has no fixed active worker release proof.')
reference = release / 'server/host-zram.py'
for path in [helper, reference]:
    for parent in [*reversed(path.parents), path]:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise SystemExit('Previous helper source ownership is unsafe.')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 ** 2:
        raise SystemExit('Previous helper source is not an exclusive bounded file.')
if helper.read_bytes() != reference.read_bytes():
    raise SystemExit('Existing OS helper differs from the previous active release; it was preserved.')
PY
    cp -a -- "$ZRAM_HELPER" "$RECOVERY_DIR/host-zram.py"
    install -m 0755 "$SOURCE_DIR/server/host-zram.py" "$ZRAM_HELPER"
    UPGRADED_HELPER=true
  fi
else
  install -d -m 0755 "$(dirname -- "$ZRAM_HELPER")"
  install -m 0755 "$SOURCE_DIR/server/host-zram.py" "$ZRAM_HELPER"
  NEW_HELPER=true
fi
# Build the private engine before switching a working node or its source.
if [[ $VORTEX_NODE_ARCH == arm64 ]]; then
  python3 -I -B "$SOURCE_DIR/deploy/bedrock-runtime.py" install --role worker
fi
install -d -m 0755 "$INSTALL_DIR"
# Copy only the worker runtime. Even when invoked from a complete panel source
# tree, the worker gets no public panel, login/setup or controller entry point.
"$NODE_BIN" --input-type=module - "$SOURCE_DIR" "$INSTALL_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = fs.realpathSync(process.argv[2]), destination = fs.realpathSync(process.argv[3]);
const { NODE_RUNTIME_FILES } = await import(pathToFileURL(path.join(source, 'server/node-runtime.js')).href);
for (const relative of NODE_RUNTIME_FILES) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid worker source path.');
  const from = path.join(source, relative), to = path.join(destination, relative);
  let ancestor = path.dirname(from);
  while (ancestor !== source) {
    const info = fs.lstatSync(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Worker source directories must not be linked.');
    ancestor = path.dirname(ancestor);
  }
  const info = fs.lstatSync(from);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Worker sources must be regular files without links.');
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(to, 0o644);
}
NODE
cd -- "$INSTALL_DIR"
npm ci --cache "$RECOVERY_DIR/npm-cache" --omit=dev --ignore-scripts
chown -hR root:root "$INSTALL_DIR"
chmod 0755 "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"
if [[ ! -e $CONFIG_FILE ]]; then
  NEW_TLS=true
  if [[ ! -d $TLS_DIR ]]; then install -d -m 0700 "$TLS_DIR"; fi
  [[ $(stat -c '%u:%g' -- "$TLS_DIR") == 0:0 ]] || { echo 'The TLS directory must belong to root.' >&2; false; }
  if [[ $(stat -c '%a' -- "$TLS_DIR") != 700 ]]; then chmod 0700 "$TLS_DIR"; fi
  [[ ! -e $TLS_DIR/tls.key && ! -e $TLS_DIR/tls.crt ]] || { echo 'TLS files already exist without a node config. Review them before initializing.' >&2; false; }
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 365 -subj '/CN=Vortex Node' -keyout "$TLS_DIR/tls.key" -out "$TLS_DIR/tls.crt" 2>/dev/null
  chmod 0600 "$TLS_DIR/tls.key" "$TLS_DIR/tls.crt"
  "$NODE_BIN" server/node-cli.js initialize --config "$CONFIG_FILE" --data-dir /var/lib/vortex-node --host 0.0.0.0 --port "$AGENT_PORT" --cert "$TLS_DIR/tls.crt" --key "$TLS_DIR/tls.key"
fi
# Validate privately before stopping a working node; never print its token.
"$NODE_BIN" --input-type=module -e 'import {readNodeConfig} from "./server/node-cli.js"; const c=readNodeConfig(process.argv[1]); if(!c.tls)throw Error("Installer requires HTTPS");' "$CONFIG_FILE"
if [[ -n $ADVERTISE_ENDPOINT ]]; then "$NODE_BIN" --input-type=module -e 'import {validateNodeEndpoint} from "./server/node-transport.js"; if(!validateNodeEndpoint(process.argv[1]).startsWith("https:"))throw Error("HTTPS endpoint required");' "$ADVERTISE_ENDPOINT"; fi
CHANGED_SERVICE=true
if [[ $PREVIOUS_ACTIVE == true ]]; then systemctl stop vortex-node; fi
ln -sfn -- "$INSTALL_DIR" "$INSTALL_ROOT/current.next"
mv -Tf -- "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Vortex Minecraft Bedrock node agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$INSTALL_ROOT/current
Environment=VORTEX_NODE_CONFIG=$CONFIG_FILE
Environment=VORTEX_NODE_UNIT=vortex-node.service
Environment=ALLOW_HOST_TERMINAL=false
ExecStart=$NODE_BIN $INSTALL_ROOT/current/server/node-cli.js serve
Restart=on-failure
RestartSec=5
TimeoutStopSec=240
KillMode=mixed
Delegate=cpu memory pids
UMask=0077
LimitNOFILE=65536
CPUAccounting=yes
MemoryAccounting=yes
IOAccounting=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vortex-node
systemctl restart vortex-node
READY=false
for attempt in {1..30}; do
  NODE_PID=$(systemctl show --property MainPID --value vortex-node 2>/dev/null || true)
  if [[ $NODE_PID =~ ^[1-9][0-9]*$ ]] && systemctl is-active --quiet vortex-node && \
    "$NODE_BIN" server/node-cli.js check --config "$CONFIG_FILE" 2>/dev/null | \
    "$NODE_BIN" --input-type=module -e 'let s="";for await(const p of process.stdin){s+=p;if(s.length>65536)process.exit(1)}try{const r=JSON.parse(s);process.exit(r.ok===true&&r.processId===Number(process.argv[1])?0:1)}catch{process.exit(1)}' "$NODE_PID" && \
    [[ $(systemctl show --property MainPID --value vortex-node 2>/dev/null || true) == "$NODE_PID" ]] && systemctl is-active --quiet vortex-node; then READY=true; break; fi
  systemctl is-active --quiet vortex-node || break
  sleep 1
done
[[ $READY == true ]] || { echo 'Node readiness failed; restoring the previous node service.' >&2; false; }
# Record only files/directories created by this installer. An upgrade never
# invents ownership of an older release, shared Node binary or customer data.
"$NODE_BIN" --input-type=module - "$CONFIG_FILE" "$TLS_DIR" "$INSTALL_DIR" "$PRIVATE_RUNTIME" "$ZRAM_HELPER" "$NEW_TLS" "$NEW_HELPER" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const [configFile,tlsDir,release,runtime,helper,newTLS,newHelper]=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(configFile,'utf8')),filename=path.join(tlsDir,'install-manifest.json');
let previous=null;
if(fs.existsSync(filename)){const info=fs.lstatSync(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==0||(info.mode&0o077)||info.size>16*1024*1024)throw Error('Unsafe installer ownership receipt');previous=JSON.parse(fs.readFileSync(filename,'utf8'));if(previous.schemaVersion!==1||previous.product!=='vortex-node'||previous.nodeId!==config.nodeId||!Array.isArray(previous.components))throw Error('Installer identity changed');}
const installId=previous?.installId||randomUUID(),rows=new Map((previous?.components||[]).map(row=>[row.path,row]));
function record(filename){const info=fs.lstatSync(filename);if(info.uid!==0||(!info.isDirectory()&&!info.isSymbolicLink()&&(!info.isFile()||info.nlink!==1)))throw Error('Unsafe created installer file');const kind=info.isDirectory()?'directory':info.isSymbolicLink()?'symlink':'file';const row={path:filename,kind,dev:info.dev,ino:info.ino,mode:info.mode&0o7777,uid:info.uid,existedBefore:false,createdByInstallId:installId};if(kind==='file')row.sha256=createHash('sha256').update(fs.readFileSync(filename)).digest('hex');if(kind==='symlink')row.target=fs.readlinkSync(filename);rows.set(filename,row);if(kind==='directory')for(const name of fs.readdirSync(filename))record(path.join(filename,name));if(rows.size>50000)throw Error('Installer ownership inventory exceeds its bound');}
record(release);if(runtime)record(runtime);if(newTLS==='true'){record(path.join(tlsDir,'tls.crt'));record(path.join(tlsDir,'tls.key'));}if(newHelper==='true')record(helper);
const value={schemaVersion:1,product:'vortex-node',role:'worker',installId,nodeId:config.nodeId,createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),components:[...rows.values()],retainedShared:['operating-system-packages','pre-existing-node-runtime','untagged-firewall-rules','separate-legacy-panel']};
const temporary=filename+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);
NODE
python3 "$SOURCE_DIR/deploy/install-ledger.py" finalize --role worker --data-dir /var/lib/vortex-node --source-dir "$INSTALL_ROOT" --service-user root
INSTALL_COMPLETED=true
CHANGED_SERVICE=false
# Optional host tuning follows the committed service/source transaction.
if [[ -f $INSTALL_ROOT/current/server/host-network-tuning.py ]]; then
  if ! python3 -I -B "$INSTALL_ROOT/current/server/host-network-tuning.py" apply-auto --role worker; then
    echo 'Network profile was preserved. Review its status from the main panel.' >&2
  fi
fi
echo 'Vortex node installed. This agent runs as root; keep its credential private and restrict its configured TCP port to the central panel.'
if [[ -z $ADVERTISE_ENDPOINT ]]; then
  ADVERTISE_IP=$(hostname -I | awk '{for(i=1;i<=NF;i++)if($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/){print $i;exit}}')
  NODE_PORT=$("$NODE_BIN" --input-type=module -e 'import {readNodeConfig} from "./server/node-cli.js";console.log(readNodeConfig(process.argv[1]).port)' "$CONFIG_FILE")
  [[ -z $ADVERTISE_IP ]] || ADVERTISE_ENDPOINT="https://$ADVERTISE_IP:$NODE_PORT"
fi
if [[ -n $ADVERTISE_ENDPOINT ]]; then
  echo 'Private connection record (intentional terminal output; do not publish). Verify/replace the advertised IP when behind NAT:'
  "$NODE_BIN" server/node-cli.js show-connection --config "$CONFIG_FILE" --endpoint "$ADVERTISE_ENDPOINT"
else
  echo 'Read connection details intentionally: sudo node /opt/vortex-node/current/server/node-cli.js show-connection --endpoint https://YOUR_VPS_IP:8443'
fi
