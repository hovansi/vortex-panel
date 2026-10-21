#!/usr/bin/env bash
set -Eeuo pipefail

# Vortex Panel. The legacy managed layout is migrated offline with a private recovery receipt.
# Run from source: sudo bash deploy/install.sh [--root-mode|--service-user] [--local-only|--public-ip IPv4] [--self-signed] [--no-network-tuning] [--resume-ledger REVIEWED_CAPTURE_SHA256]
# BEGIN installer options
vortex_ipv4_shape() {
  local value=$1 part
  local -a octets=()
  [[ $value =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r -a octets <<< "$value"
  for part in "${octets[@]}"; do
    [[ $part == 0 || $part != 0* ]] && ((10#$part <= 255)) || return 1
  done
}
parse_installer_options() {
  MODE=preserve
  VORTEX_MODE_EXPLICIT=false
  VORTEX_ACCESS_MODE=auto
  VORTEX_PUBLIC_IP=
  VORTEX_MANAGED_TLS=true
  VORTEX_NETWORK_TUNING=true
  RESUME_LEDGER_SHA=
  while [[ $# -gt 0 ]]; do
    case $1 in
      --root-mode|--service-user)
        [[ $VORTEX_MODE_EXPLICIT == false ]] || { echo 'Choose one service mode.' >&2; return 1; }
        VORTEX_MODE_EXPLICIT=true
        if [[ $1 == --root-mode ]]; then MODE=root; else MODE=service; fi
        shift;;
      --local-only)
        [[ $VORTEX_ACCESS_MODE == auto && -z $VORTEX_PUBLIC_IP ]] || { echo 'Choose one access mode.' >&2; return 1; }
        VORTEX_ACCESS_MODE=local; shift;;
      --public-ip)
        [[ $VORTEX_ACCESS_MODE == auto && -z $VORTEX_PUBLIC_IP && $# -ge 2 ]] && vortex_ipv4_shape "$2" || { echo '--public-ip requires one canonical IPv4 address.' >&2; return 1; }
        VORTEX_PUBLIC_IP=$2; shift 2;;
      --resume-ledger)
        [[ $# -ge 2 && $2 =~ ^[a-f0-9]{64}$ && -z $RESUME_LEDGER_SHA ]] || { echo '--resume-ledger requires one reviewed SHA-256 of the private preserved capture.' >&2; return 1; }
        RESUME_LEDGER_SHA=$2; shift 2;;
      --self-signed)
        [[ $VORTEX_MANAGED_TLS == true ]] || { echo 'Duplicate --self-signed option.' >&2; return 1; }
        VORTEX_MANAGED_TLS=false; shift;;
      --no-network-tuning)
        [[ $VORTEX_NETWORK_TUNING == true ]] || { echo 'Duplicate --no-network-tuning option.' >&2; return 1; }
        VORTEX_NETWORK_TUNING=false; shift;;
      *) echo 'Usage: sudo bash deploy/install.sh [--root-mode|--service-user] [--local-only|--public-ip IPv4] [--self-signed] [--no-network-tuning] [--resume-ledger REVIEWED_CAPTURE_SHA256]' >&2; return 1;;
    esac
  done
}
# END installer options
parse_installer_options "$@"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
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
# BEGIN installer transaction lock
VORTEX_INSTALL_LOCK_FDS=()
acquire_installer_lock() {
  local lock_path=$1 lock_parent lock_info descriptor_info candidate_fd parent_info parent_owner parent_mode
  command -v flock >/dev/null 2>&1 || { echo 'The util-linux flock command is required before installation.' >&2; return 1; }
  lock_parent=${lock_path%/*}
  [[ -d $lock_parent && ! -L $lock_parent ]] || { echo 'Installer lock parent must be a real root-owned directory.' >&2; return 1; }
  parent_info=$(LC_ALL=C stat -c '%u:%a' -- "$lock_parent") || return 1
  IFS=: read -r parent_owner parent_mode <<< "$parent_info"
  [[ $parent_owner == 0 && $parent_mode =~ ^[0-7]{3,4}$ ]] && (( (8#$parent_mode & 0022) == 0 )) || {
    echo 'Installer lock parent must be root-owned without shared write access.' >&2; return 1;
  }
  if [[ ! -e $lock_path && ! -L $lock_path ]]; then
    # O_EXCL/noclobber creates one stable inode; a simultaneous creator is
    # inspected below. Never unlink this inode, including after a failed install.
    if ! (umask 077; set -o noclobber; : > "$lock_path") 2>/dev/null; then
      [[ -e $lock_path || -L $lock_path ]] || { echo 'Unable to create the installer transaction lock.' >&2; return 1; }
    fi
  fi
  [[ -f $lock_path && ! -L $lock_path ]] || { echo 'Installer lock must be a regular file, without symlinks.' >&2; return 1; }
  lock_info=$(LC_ALL=C stat -c '%u:%h:%a:%d:%i' -- "$lock_path") || return 1
  [[ $lock_info == 0:1:600:* ]] || { echo 'Installer lock must be root-owned, mode 0600, without hardlinks.' >&2; return 1; }
  exec {candidate_fd}<>"$lock_path" || return 1
  descriptor_info=$(LC_ALL=C stat -Lc '%u:%h:%a:%d:%i' -- "/proc/$$/fd/$candidate_fd") || { exec {candidate_fd}>&-; return 1; }
  if [[ $descriptor_info != "$lock_info" || ! -f $lock_path || -L $lock_path ]] ||
    [[ $(LC_ALL=C stat -c '%u:%h:%a:%d:%i' -- "$lock_path") != "$descriptor_info" ]]; then
    exec {candidate_fd}>&-
    echo 'Installer lock changed during acquisition; preserving it.' >&2
    return 1
  fi
  if ! flock -n "$candidate_fd"; then
    exec {candidate_fd}>&-
    echo 'Another Vortex Panel installation is in progress. Retry after it finishes.' >&2
    return 1
  fi
  if [[ ! -f $lock_path || -L $lock_path ]] || [[ $(LC_ALL=C stat -c '%u:%h:%a:%d:%i' -- "$lock_path") != "$descriptor_info" ]]; then
    exec {candidate_fd}>&-
    echo 'Installer lock inode changed; preserving it.' >&2
    return 1
  fi
  # Keep this descriptor open through snapshots, package work, readiness and
  # rollback. Process exit releases flock; the persistent inode is never removed.
  VORTEX_INSTALL_LOCK_FDS+=("$candidate_fd")
  VORTEX_INSTALL_LOCK_FD=$candidate_fd
}
acquire_installer_lock /run/vortex-panel-install.lock
# Serialize shared helper/package changes with worker installs, host memory
# changes and native uninstall. Both independently opened descriptors stay live.
acquire_installer_lock /run/vortex-os-maintenance.lock
# END installer transaction lock
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
command -v python3 >/dev/null || { echo 'Python3 is required before source installation; use the release bootstrap.' >&2; exit 1; }
LEDGER_CAPTURE_ARGS=(capture --role panel)
if [[ -n ${VORTEX_BOOTSTRAP_BASELINE:-} ]]; then LEDGER_CAPTURE_ARGS+=(--bootstrap-baseline "$VORTEX_BOOTSTRAP_BASELINE"); fi
if [[ -n $RESUME_LEDGER_SHA ]]; then
  python3 "$SOURCE_DIR/deploy/install-ledger.py" validate-capture --role panel --capture-sha256 "$RESUME_LEDGER_SHA"
  python3 "$SOURCE_DIR/deploy/install-ledger.py" capture-resume --role panel --capture-sha256 "$RESUME_LEDGER_SHA"
else
  [[ ! -e /run/vortex-install-ledger-panel.json && ! -L /run/vortex-install-ledger-panel.json ]] || {
    echo 'A previous installer baseline exists. Review its private recovery state, then resume the reviewed source installer with --resume-ledger and its exact SHA-256; it will not be overwritten.' >&2; exit 1;
  }
  python3 "$SOURCE_DIR/deploy/install-ledger.py" "${LEDGER_CAPTURE_ARGS[@]}"
fi
MIGRATION_TRANSACTION=/var/backups/vortex-panel/migration-$(date -u +%Y%m%dT%H%M%SZ)-$$/transaction.json
INSTALL_COMPLETED=false
migration_cleanup() {
  local code=$?
  if [[ $INSTALL_COMPLETED != true && -f $MIGRATION_TRANSACTION ]]; then
    if ! python3 "$SOURCE_DIR/deploy/panel-layout-migrate.py" rollback --transaction "$MIGRATION_TRANSACTION"; then
      echo "Legacy layout recovery requires review: $MIGRATION_TRANSACTION" >&2
      code=1
    fi
  fi
  return "$code"
}
trap migration_cleanup EXIT
python3 "$SOURCE_DIR/deploy/panel-layout-migrate.py" apply --transaction "$MIGRATION_TRANSACTION"
if [[ $SOURCE_DIR == /opt/bedrock-panel/* && -f $MIGRATION_TRANSACTION ]]; then
  SOURCE_DIR=/opt/vortex-panel/${SOURCE_DIR#/opt/bedrock-panel/}
fi
INSTALL_ROOT=/opt/vortex-panel
INSTALL_DIR=$INSTALL_ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$
DATA_DIR=/var/lib/vortex-panel
ZRAM_HELPER=/usr/local/libexec/vortex-host-zram.py
RECOVERY_DIR=$(mktemp -d /tmp/vortex-install.XXXXXXXX)
ISOLATION_TRANSACTION=$RECOVERY_DIR/application-isolation.json
ISOLATION_ROLLBACK_FAILED=false
rollback_isolation() {
  if [[ -f $ISOLATION_TRANSACTION ]]; then
    if ! python3 "$SOURCE_DIR/deploy/application-isolation.py" rollback --owner vortex-panel.service --transaction "$ISOLATION_TRANSACTION"; then
      ISOLATION_ROLLBACK_FAILED=true
      echo "Owned sandbox policy recovery needs review: $ISOLATION_TRANSACTION" >&2
    fi
  fi
}
cleanup() {
  local code=$?
  if [[ $INSTALL_COMPLETED != true && -f ${RECOVERY_DIR:-}/zram-helper-change.json ]]; then
    if ! python3 - "$ZRAM_HELPER" "$RECOVERY_DIR" <<'PY'
import hashlib, json, os, pathlib, stat, sys
helper, recovery = map(pathlib.Path, sys.argv[1:])
change = json.loads((recovery / 'zram-helper-change.json').read_text())
if not helper.exists() and not change['existedBefore']:
    raise SystemExit(0)
info = helper.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
    raise SystemExit('Memory helper changed after installation; retaining its private recovery files.')
current_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
if change['existedBefore'] and current_hash == change['previousSHA256']:
    raise SystemExit(0)
if current_hash != change['installedSHA256']:
    raise SystemExit('Memory helper changed after installation; retaining its private recovery files.')
if change['existedBefore']:
    previous = (recovery / 'zram-helper-before').read_bytes()
    if hashlib.sha256(previous).hexdigest() != change['previousSHA256']:
        raise SystemExit('Memory helper recovery snapshot changed.')
    temporary = helper.with_name('.vortex-helper-rollback-' + str(os.getpid()))
    with temporary.open('xb') as target:
        os.fchmod(target.fileno(), change['previousMode'])
        target.write(previous); target.flush(); os.fsync(target.fileno())
    os.replace(temporary, helper)
else:
    helper.unlink()
PY
    then ISOLATION_ROLLBACK_FAILED=true; code=1; fi
  fi
  if [[ $INSTALL_COMPLETED != true ]] && declare -F restore_layout_marker >/dev/null; then
    if ! restore_layout_marker; then ISOLATION_ROLLBACK_FAILED=true; code=1; fi
  fi
  migration_cleanup || code=1
  [[ -z ${NODE_TEMP:-} ]] || rm -rf -- "$NODE_TEMP"
  if [[ $ISOLATION_ROLLBACK_FAILED != true ]]; then [[ -z ${RECOVERY_DIR:-} ]] || rm -rf -- "$RECOVERY_DIR"; fi
  return "$code"
}
trap cleanup EXIT
CURRENT_EXISTED=false
PREVIOUS_LINK=
if [[ -L $INSTALL_ROOT/current ]]; then
  CURRENT_EXISTED=true
  PREVIOUS_LINK=$(readlink -- "$INSTALL_ROOT/current")
elif [[ -e $INSTALL_ROOT/current ]]; then
  echo 'Existing current path must be a symlink. Move custom installations explicitly before using this installer.' >&2
  rmdir -- "$RECOVERY_DIR"
  exit 1
fi
PREVIOUS_ACTIVE=false
PREVIOUS_ENABLED=false
CHANGED_SERVICE=false
systemctl is-active --quiet vortex-panel && PREVIOUS_ACTIVE=true
if [[ -f $MIGRATION_TRANSACTION ]]; then
  MIGRATED_ACTIVE=$(python3 -c 'import json,sys; print("true" if json.load(open(sys.argv[1])).get("active") else "false")' "$MIGRATION_TRANSACTION")
  [[ $MIGRATED_ACTIVE != true ]] || PREVIOUS_ACTIVE=true
fi
systemctl is-enabled --quiet vortex-panel && PREVIOUS_ENABLED=true
[[ ! -f /etc/vortex-panel.env ]] || cp -a /etc/vortex-panel.env "$RECOVERY_DIR/environment"
[[ ! -f /etc/systemd/system/vortex-panel.service ]] || cp -a /etc/systemd/system/vortex-panel.service "$RECOVERY_DIR/service"
if [[ -f $RECOVERY_DIR/environment ]]; then
  CONFIGURED_DATA=$(sed -n 's/^DATA_DIR=//p' "$RECOVERY_DIR/environment" | tail -n 1 | tr -d '\r' | sed 's/^"//;s/"$//')
  [[ -z $CONFIGURED_DATA ]] || DATA_DIR=$CONFIGURED_DATA
fi
[[ $DATA_DIR == /* ]] || { echo 'DATA_DIR must be an absolute path.' >&2; rmdir -- "$RECOVERY_DIR" 2>/dev/null || true; exit 1; }
DATA_DIR=$(realpath -m -- "$DATA_DIR")
[[ $DATA_DIR != "$INSTALL_ROOT" && $DATA_DIR != "$INSTALL_ROOT/"* && $INSTALL_ROOT != "$DATA_DIR/"* ]] || {
  echo 'DATA_DIR and the source installation directory must not overlap.' >&2
  exit 1
}
case "$DATA_DIR" in
  /|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/var|/var/lib|/var/backups|/opt|/home|/root|/tmp|/var/tmp)
    echo 'DATA_DIR must be a dedicated panel data directory, outside operating-system directories.' >&2
    exit 1;;
esac
if [[ $DATA_DIR != /var/lib/vortex-panel && -d $DATA_DIR && -n $(ls -A -- "$DATA_DIR") && ! -f $DATA_DIR/panel.json ]]; then
  echo 'Existing custom DATA_DIR must contain panel.json or be empty; ownership changes are limited to dedicated panel data.' >&2
  exit 1
fi
# BEGIN ownership helper
apply_ownership_batch() {
  local desired_owner=$1 observed_owner=$2
  local -n batch_paths=$3
  [[ ${#batch_paths[@]} -gt 0 ]] || return 0
  # --from performs the fresh lstat/owner check inside GNU chown, including
  # symlinks under -h. A concurrent owner change is never blindly overwritten.
  if ! chown -h --from="$observed_owner" -- "$desired_owner" "${batch_paths[@]}"; then
    printf 'Unable to change ownership batch from %s to %s.\n' "$observed_owner" "$desired_owner" >&2
    return 1
  fi
  batch_paths=()
}
apply_tree_ownership() {
  local target_user=$1 target_group=$2 directory=$3 target_uid target_gid ownership_list entry observed_owner desired_owner buffer_name
  local LC_ALL=C
  local -A ownership_groups=() ownership_bytes=()
  [[ -d $directory && ! -L $directory ]] || { echo 'Ownership target must be a real directory.' >&2; return 1; }
  target_uid=$(id -u -- "$target_user") || { echo 'Ownership user is unavailable.' >&2; return 1; }
  target_gid=$(getent group "$target_group" | cut -d: -f3) || { echo 'Ownership group is unavailable.' >&2; return 1; }
  [[ $target_uid =~ ^[0-9]+$ && $target_gid =~ ^[0-9]+$ ]] || { echo 'Unable to resolve numeric ownership.' >&2; return 1; }
  desired_owner=$target_uid:$target_gid
  ownership_list=$(mktemp) || return 1
  # Do not follow symlinks, or touch already-correct immutable files.
  # Capture the traversal status before changing any owner; process substitution
  # would hide a failed find from the caller and rollback.
  if ! find -P "$directory" \( ! -uid "$target_uid" -o ! -gid "$target_gid" \) -printf '%U:%G\0%p\0' > "$ownership_list"; then
    rm -f -- "$ownership_list"
    echo 'Unable to enumerate data ownership.' >&2
    return 1
  fi
  while IFS= read -r -d '' observed_owner; do
    if [[ ! $observed_owner =~ ^[0-9]+:[0-9]+$ ]] || ! IFS= read -r -d '' entry; then
      rm -f -- "$ownership_list"
      echo 'Invalid ownership traversal metadata.' >&2
      return 1
    fi
    [[ $observed_owner != "$desired_owner" ]] || continue
    if [[ ! ${ownership_groups[$observed_owner]+present} ]]; then
      buffer_name=ownership_paths_${observed_owner//:/_}
      local -a "$buffer_name=()"
      ownership_groups[$observed_owner]=$buffer_name
      ownership_bytes[$observed_owner]=0
    fi
    buffer_name=${ownership_groups[$observed_owner]}
    local -n pending_paths=$buffer_name
    if [[ ${#pending_paths[@]} -gt 0 && $((ownership_bytes[$observed_owner] + ${#entry} + 1)) -gt 32768 ]]; then
      if ! apply_ownership_batch "$desired_owner" "$observed_owner" "$buffer_name"; then rm -f -- "$ownership_list"; return 1; fi
      ownership_bytes[$observed_owner]=0
    fi
    pending_paths+=("$entry")
    ownership_bytes[$observed_owner]=$((ownership_bytes[$observed_owner] + ${#entry} + 1))
    if [[ ${#pending_paths[@]} -ge 256 ]]; then
      if ! apply_ownership_batch "$desired_owner" "$observed_owner" "$buffer_name"; then rm -f -- "$ownership_list"; return 1; fi
      ownership_bytes[$observed_owner]=0
    fi
  done < "$ownership_list"
  for observed_owner in "${!ownership_groups[@]}"; do
    if ! apply_ownership_batch "$desired_owner" "$observed_owner" "${ownership_groups[$observed_owner]}"; then rm -f -- "$ownership_list"; return 1; fi
  done
  # Detect --from skips, entries created/changed during batching, and traversal
  # failures. The final scan verifies the whole tree without one stat fork/path.
  if ! find -P "$directory" \( ! -uid "$target_uid" -o ! -gid "$target_gid" \) -print0 > "$ownership_list"; then
    rm -f -- "$ownership_list"
    echo 'Unable to verify data ownership.' >&2
    return 1
  fi
  if [[ -s $ownership_list ]]; then
      rm -f -- "$ownership_list"
      echo 'Ownership changed concurrently or could not be verified.' >&2
      return 1
  fi
  rm -f -- "$ownership_list"
}
restore_layout_marker() {
  [[ -f ${RECOVERY_DIR:-}/layout-marker.json ]] || return 0
  python3 - "$DATA_DIR/.vortex-layout.json" "$RECOVERY_DIR/layout-marker.json" <<'PY'
import hashlib, json, os, pathlib, stat, sys
marker, receipt = map(pathlib.Path, sys.argv[1:])
expected = json.loads(receipt.read_text())
info = marker.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_dev != expected['dev'] or info.st_ino != expected['ino'] or hashlib.sha256(marker.read_bytes()).hexdigest() != expected['sha256']:
    raise SystemExit('Layout marker changed while updating service ownership; preserving recovery files.')
os.chown(marker, 0, 0)
os.chmod(marker, 0o600)
PY
}
# END ownership helper
rollback() {
  local code=$? line=$1
  trap - ERR
  set +e
  echo "Vortex Panel installation failed at line $line; preserving server data." >&2
  if [[ $CHANGED_SERVICE == true ]]; then
    if systemctl stop vortex-panel; then rollback_isolation; else
      ISOLATION_ROLLBACK_FAILED=true
      echo "Service stop was not confirmed; sandbox policy retained for review: $ISOLATION_TRANSACTION" >&2
    fi
    if [[ -f $RECOVERY_DIR/environment ]]; then cp -a "$RECOVERY_DIR/environment" /etc/vortex-panel.env; else rm -f /etc/vortex-panel.env; fi
    if [[ -f $RECOVERY_DIR/service ]]; then cp -a "$RECOVERY_DIR/service" /etc/systemd/system/vortex-panel.service; else rm -f /etc/systemd/system/vortex-panel.service; fi
    if [[ $CURRENT_EXISTED == true ]]; then
      ln -sfn -- "$PREVIOUS_LINK" "$INSTALL_ROOT/current.next"
      mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
    else rm -f "$INSTALL_ROOT/current" "$INSTALL_ROOT/current.next"; fi
    # A candidate root-mode process may atomically replace 0600 data files.
    # Restore the prior service identity before restarting a non-root release.
    local previous_user=vortex-panel previous_group=vortex-panel
    if [[ -f $RECOVERY_DIR/service ]]; then
      previous_user=$(sed -n 's/^User=//p' "$RECOVERY_DIR/service" | tail -n 1)
      previous_user=${previous_user:-root}
      previous_group=$(sed -n 's/^Group=//p' "$RECOVERY_DIR/service" | tail -n 1)
      previous_group=${previous_group:-$(id -gn -- "$previous_user" 2>/dev/null)}
    fi
    if [[ -n $previous_group ]] && id -- "$previous_user" >/dev/null 2>&1; then
      if ! apply_tree_ownership "$previous_user" "$previous_group" "$DATA_DIR" || ! restore_layout_marker; then
        echo "Unable to restore data ownership. Recovery files retained at $RECOVERY_DIR" >&2
        RECOVERY_DIR=
      fi
    else
      echo "Previous service identity is unavailable. Recovery files retained at $RECOVERY_DIR" >&2
      RECOVERY_DIR=
    fi
    systemctl daemon-reload
    if [[ $PREVIOUS_ENABLED == true ]]; then systemctl enable vortex-panel; else systemctl disable vortex-panel; fi
    if [[ $PREVIOUS_ACTIVE == true ]]; then
      if ! systemctl start vortex-panel; then
        echo "Previous service could not restart. Recovery files retained at $RECOVERY_DIR" >&2
        RECOVERY_DIR=
      fi
    fi
    echo 'Previous source/service configuration restored. Review journalctl -u vortex-panel.' >&2
  else rollback_isolation; fi
  exit "$code"
}
trap cleanup EXIT
trap 'rollback "$LINENO"' ERR
# BEGIN automatic access plan
FRESH_INSTALL=true
if [[ $CURRENT_EXISTED == true || -f $RECOVERY_DIR/environment || -f $RECOVERY_DIR/service || -e $DATA_DIR/panel.json ]]; then FRESH_INSTALL=false; fi
VORTEX_AUTO_ACCESS=false
if [[ $FRESH_INSTALL == true ]]; then
  if [[ $VORTEX_MODE_EXPLICIT == false ]]; then MODE=root; fi
  if [[ $VORTEX_ACCESS_MODE == auto ]]; then
    VORTEX_AUTO_ACCESS=true
    command -v python3 >/dev/null || { echo 'Python3 is required for access preflight; use the release install.sh entry point.' >&2; false; }
    if ! command -v ss >/dev/null; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get install -y --no-install-recommends --no-remove iproute2
    fi
    ACCESS_ARGS=(preflight --plan "$RECOVERY_DIR/public-access.json")
    if [[ -n $VORTEX_PUBLIC_IP ]]; then ACCESS_ARGS+=(--public-ip "$VORTEX_PUBLIC_IP"); fi
    python3 "$SOURCE_DIR/deploy/configure-access.py" "${ACCESS_ARGS[@]}"
  fi
elif [[ $VORTEX_ACCESS_MODE != auto || -n $VORTEX_PUBLIC_IP ]]; then
  echo 'An existing installation keeps its access configuration. Access flags apply only to a fresh installation.' >&2
  false
fi
# END automatic access plan
apt-get update
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get install -y ca-certificates curl unzip rsync xz-utils libcurl4 libstdc++6 libatomic1 nftables e2fsprogs util-linux bubblewrap python3 python3-venv kmod
if [[ $VORTEX_AUTO_ACCESS == true ]]; then
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get install -y --no-remove nginx openssl iproute2
fi
# Trusted Ubuntu prerequisites for isolated side-by-side Python source builds.
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get install -y --no-upgrade --no-remove gcc make pkg-config libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev libffi-dev liblzma-dev libncurses-dev libgdbm-dev uuid-dev libzstd-dev
# Install prerequisites only. The application capability probe must still prove
# that this host permits the required namespaces; never disable AppArmor/userns
# protection or fall back to the management account for uploaded code.
for tool in bwrap setpriv python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Application prerequisite is unavailable: $tool" >&2; false; }
done
if [[ -f $SOURCE_DIR/deploy/application-isolation.py ]]; then
  if ! python3 "$SOURCE_DIR/deploy/application-isolation.py" prepare --owner vortex-panel.service --transaction "$ISOLATION_TRANSACTION"; then
    rollback_isolation
    echo 'Optional application sandbox setup is unavailable; Vortex Panel installation continues.' >&2
  fi
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

# The passive helper is installed without enabling memory assistance. Preserve
# unfamiliar files rather than replacing a system administrator's component.
python3 - "$ZRAM_HELPER" "$SOURCE_DIR/server/host-zram.py" "$INSTALL_ROOT/current/server/host-zram.py" "$RECOVERY_DIR" <<'PY'
import hashlib, json, os, pathlib, stat, sys
helper, source, previous_source, recovery = map(pathlib.Path, sys.argv[1:])
for parent in reversed(helper.parents):
    if not parent.exists():
        parent.mkdir(mode=0o755)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('Memory helper parent must be a real root-owned directory without shared write access.')
if os.path.lexists(helper):
    info = helper.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise SystemExit('Existing memory helper is unfamiliar; preserving it. Review the component before upgrading.')
    previous = helper.read_bytes()
    if previous == source.read_bytes():
        raise SystemExit(0)
    old = previous_source.resolve(strict=True)
    for item in [*reversed(old.parents), old]:
        item_info = item.lstat()
        if stat.S_ISLNK(item_info.st_mode) or item_info.st_uid != 0 or item_info.st_mode & 0o022:
            raise SystemExit('Previous memory helper source is not trusted.')
    if not old.is_file() or old.stat().st_nlink != 1 or old.read_bytes() != previous:
        raise SystemExit('Existing memory helper does not match the installed release; preserving it.')
    with (recovery / 'zram-helper-before').open('xb') as backup:
        backup.write(previous); backup.flush(); os.fsync(backup.fileno())
    change = {'existedBefore': True, 'previousSHA256': hashlib.sha256(previous).hexdigest(), 'previousMode': stat.S_IMODE(info.st_mode)}
else:
    change = {'existedBefore': False}
change['installedSHA256'] = hashlib.sha256(source.read_bytes()).hexdigest()
with (recovery / 'zram-helper-change.json').open('x') as receipt:
    json.dump(change, receipt); receipt.flush(); os.fsync(receipt.fileno())
temporary = helper.with_name('.vortex-helper-install-' + str(os.getpid()))
with temporary.open('xb') as target:
    os.fchmod(target.fileno(), 0o755)
    target.write(source.read_bytes()); target.flush(); os.fsync(target.fileno())
if change['existedBefore']:
    if helper.read_bytes() != previous:
        raise SystemExit('Memory helper changed concurrently; preserving it.')
    os.replace(temporary, helper)
else:
    # link() has no overwrite semantics; a simultaneous creator is preserved.
    os.link(temporary, helper)
    temporary.unlink()
PY

if [[ -f /etc/systemd/system/vortex-panel.service ]]; then
  PREVIOUS_NODE_BIN=$(sed -nE "s|^ExecStart=(/opt/vortex-panel/runtime/node-v22\\.[0-9]+\\.[0-9]+-linux-$VORTEX_NODE_ARCH/bin/node) .*|\\1|p" /etc/systemd/system/vortex-panel.service | head -n 1)
  if [[ -n $PREVIOUS_NODE_BIN ]]; then
    python3 - "$PREVIOUS_NODE_BIN" <<'PY'
import os, pathlib, stat, sys
target = pathlib.Path(sys.argv[1])
for item in [*reversed(target.parents), target]:
    info = item.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('Existing panel Node interpreter has unsafe ownership or symlinks.')
if not target.is_file() or not os.access(target, os.X_OK):
    raise SystemExit('Existing panel Node interpreter is unavailable.')
PY
    export PATH="${PREVIOUS_NODE_BIN%/node}:$PATH"
  fi
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
NODE_ARCH=$(node -p 'process.arch' 2>/dev/null || true)
if [[ ! $NODE_MAJOR =~ ^[0-9]{1,3}$ || $NODE_MAJOR -lt 22 || $NODE_ARCH != "$VORTEX_NODE_ARCH" ]]; then
  NODE_TEMP=$(mktemp -d /tmp/vortex-node-runtime.XXXXXXXX)
  curl --fail --location --proto '=https' --tlsv1.2 --output "$NODE_TEMP/SHASUMS256.txt" https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  NODE_FILE=$(awk -v arch="$VORTEX_NODE_ARCH" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2; exit}' "$NODE_TEMP/SHASUMS256.txt")
  [[ -n $NODE_FILE ]] || { echo 'Unable to resolve official Node 22 archive.' >&2; exit 1; }
  curl --fail --location --proto '=https' --tlsv1.2 --output "$NODE_TEMP/$NODE_FILE" "https://nodejs.org/dist/latest-v22.x/$NODE_FILE"
  (cd -- "$NODE_TEMP" && awk -v f="$NODE_FILE" '$2 == f' SHASUMS256.txt | sha256sum --check -)
  # Keep the panel interpreter inside its owned source root. Never overwrite
  # a pre-existing /usr/local Node/npm installation or OS package files.
  PANEL_NODE_DIR=$INSTALL_ROOT/runtime/${NODE_FILE%.tar.xz}
  [[ ! -L $INSTALL_ROOT && ! -L $INSTALL_ROOT/runtime && ! -e $PANEL_NODE_DIR && ! -L $PANEL_NODE_DIR ]] || {
    echo 'Panel runtime destination is already present or is a symlink; review it before installing.' >&2; false;
  }
  install -d -m 0755 -- "$PANEL_NODE_DIR"
  tar -xJf "$NODE_TEMP/$NODE_FILE" --no-same-owner --no-same-permissions --strip-components=1 -C "$PANEL_NODE_DIR"
  export PATH="$PANEL_NODE_DIR/bin:$PATH"
fi

id vortex-panel >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin vortex-panel
SERVICE_USER=vortex-panel
TERMINAL=false
if [[ $MODE == root ]] || { [[ $MODE == preserve ]] && [[ -f $RECOVERY_DIR/service ]] && grep -q '^User=root$' "$RECOVERY_DIR/service"; }; then SERVICE_USER=root; TERMINAL=true; fi
install -d -m 0755 "$INSTALL_DIR"
if [[ ! -d $DATA_DIR ]]; then install -d -m 0700 "$DATA_DIR"; elif [[ $(stat -c '%a' -- "$DATA_DIR") != 700 ]]; then chmod 0700 "$DATA_DIR"; fi
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .git --exclude .playwright-cli --exclude output --exclude releases --exclude current "$SOURCE_DIR/" "$INSTALL_DIR/"
# rsync -a also copies the source root's mode (for example a private 0700 upload).
chmod 0755 "$INSTALL_DIR"
cd -- "$INSTALL_DIR"
npm ci --cache "$INSTALL_ROOT/.npm-cache" --omit=dev --ignore-scripts
apply_tree_ownership root root "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"
chmod a+r "$INSTALL_DIR/package.json"
chmod -R a+rX "$INSTALL_DIR/server" "$INSTALL_DIR/public" "$INSTALL_DIR/node_modules"
CHANGED_SERVICE=true
if [[ $PREVIOUS_ACTIVE == true ]]; then systemctl stop vortex-panel; fi
if [[ -e $DATA_DIR/.vortex-layout.json || -L $DATA_DIR/.vortex-layout.json ]]; then
  python3 - "$DATA_DIR" "$RECOVERY_DIR/layout-marker.json" <<'PY'
import hashlib, json, os, pathlib, stat, sys
data, receipt = map(pathlib.Path, sys.argv[1:])
marker = data / '.vortex-layout.json'
info = marker.lstat()
if data != pathlib.Path('/var/lib/vortex-panel') or data.resolve() != data or not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096:
    raise SystemExit('Existing layout marker ownership is unsafe; preserving it for review.')
content = marker.read_bytes()
value = json.loads(content)
if value.get('schemaVersion') != 1 or value.get('dataDir') != str(data) or value.get('previousDataDir') != '/var/lib/bedrock-panel' or value.get('firewallScope') != '/var/lib/bedrock-panel' or value.get('machineId') != pathlib.Path('/etc/machine-id').read_text().strip():
    raise SystemExit('Existing layout marker belongs to another installation; preserving it.')
with receipt.open('x') as stream:
    os.fchmod(stream.fileno(), 0o600)
    json.dump({'dev':info.st_dev,'ino':info.st_ino,'sha256':hashlib.sha256(content).hexdigest()}, stream)
PY
fi
apply_tree_ownership "$SERVICE_USER" "$SERVICE_USER" "$DATA_DIR"
restore_layout_marker
if [[ ! -f /etc/vortex-panel.env ]]; then
  install -m 0600 /dev/null /etc/vortex-panel.env
  cat > /etc/vortex-panel.env <<EOF
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA_DIR
ALLOW_HOST_TERMINAL=$TERMINAL
TRUST_PROXY=0
EOF
else
  if [[ $MODE == root ]]; then
    if grep -q '^ALLOW_HOST_TERMINAL=' /etc/vortex-panel.env; then sed -i 's/^ALLOW_HOST_TERMINAL=.*/ALLOW_HOST_TERMINAL=true/' /etc/vortex-panel.env; else echo 'ALLOW_HOST_TERMINAL=true' >> /etc/vortex-panel.env; fi
  elif [[ $MODE == service ]]; then
    if grep -q '^ALLOW_HOST_TERMINAL=' /etc/vortex-panel.env; then sed -i 's/^ALLOW_HOST_TERMINAL=.*/ALLOW_HOST_TERMINAL=false/' /etc/vortex-panel.env; else echo 'ALLOW_HOST_TERMINAL=false' >> /etc/vortex-panel.env; fi
  fi
fi
TERMINAL=$(sed -n 's/^ALLOW_HOST_TERMINAL=//p' /etc/vortex-panel.env | tail -n 1 | tr -d '"\r')
[[ $TERMINAL == true ]] || TERMINAL=false
NODE_BIN=$(command -v node)
ln -sfn "$INSTALL_DIR" "$INSTALL_ROOT/current.next"
mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
cat > /etc/systemd/system/vortex-panel.service <<EOF
[Unit]
Description=Vortex Panel and managed servers
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_ROOT/current
EnvironmentFile=/etc/vortex-panel.env
Environment=PATH=${NODE_BIN%/node}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_BIN $INSTALL_ROOT/current/server/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=240
KillMode=mixed
Delegate=cpu memory pids
UMask=0077
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vortex-panel
systemctl restart vortex-panel
PANEL_PORT=$(sed -n 's/^PORT=//p' /etc/vortex-panel.env | tail -n 1 | tr -d '"\r')
[[ $PANEL_PORT =~ ^[0-9]+$ ]] && [[ $PANEL_PORT -ge 1 && $PANEL_PORT -le 65535 ]] || { echo 'Invalid PORT in /etc/vortex-panel.env' >&2; false; }
PANEL_HOST=$(sed -n 's/^HOST=//p' /etc/vortex-panel.env | tail -n 1 | tr -d '"\r')
[[ $PANEL_HOST =~ ^[A-Za-z0-9.:-]*$ ]] || { echo 'Unsupported HOST for readiness check.' >&2; false; }
if [[ $PANEL_HOST == :: || $PANEL_HOST == ::1 ]]; then PANEL_CHECK_HOST='[::1]'; elif [[ -z $PANEL_HOST || $PANEL_HOST == 0.0.0.0 || $PANEL_HOST == localhost ]]; then PANEL_CHECK_HOST=127.0.0.1; elif [[ $PANEL_HOST == *:* ]]; then PANEL_CHECK_HOST="[$PANEL_HOST]"; else PANEL_CHECK_HOST=$PANEL_HOST; fi
READY=false
for attempt in {1..30}; do
  PANEL_PID=$(systemctl show --property MainPID --value vortex-panel 2>/dev/null || true)
  if [[ $PANEL_PID =~ ^[1-9][0-9]*$ ]] && systemctl is-active --quiet vortex-panel && \
    curl --fail --silent --show-error --noproxy '*' --max-time 2 "http://$PANEL_CHECK_HOST:$PANEL_PORT/healthz" 2>/dev/null | \
    "$NODE_BIN" --input-type=module -e 'let input = ""; for await (const part of process.stdin) { input += part; if (input.length > 65536) process.exit(1); } try { const health = JSON.parse(input); process.exit(health?.ok === true && health?.service === "vortex-panel" && health?.processId === Number(process.argv[1]) ? 0 : 1); } catch { process.exit(1); }' "$PANEL_PID" 2>/dev/null && \
    [[ $(systemctl show --property MainPID --value vortex-panel 2>/dev/null || true) == "$PANEL_PID" ]] && systemctl is-active --quiet vortex-panel; then
    READY=true; break
  fi
  systemctl is-active --quiet vortex-panel || break
  sleep 1
done
[[ $READY == true ]] || { echo 'Readiness check failed. Rolling back service and source.' >&2; false; }
if [[ $VORTEX_AUTO_ACCESS == true ]]; then
  python3 "$SOURCE_DIR/deploy/configure-access.py" apply --plan "$RECOVERY_DIR/public-access.json"
fi
python3 "$SOURCE_DIR/deploy/install-ledger.py" finalize --role panel --data-dir "$DATA_DIR" --source-dir "$INSTALL_ROOT" --service-user "$SERVICE_USER"
if [[ -f $MIGRATION_TRANSACTION ]]; then
  python3 "$SOURCE_DIR/deploy/panel-layout-migrate.py" commit --transaction "$MIGRATION_TRANSACTION"
fi
INSTALL_COMPLETED=true
CHANGED_SERVICE=false
# Commit core installation before optional host changes. A later receipt or
# migration failure must not roll source back underneath a new renewal timer.
# CA/kernel refusals preserve the healthy panel and its existing access.
if [[ $VORTEX_NETWORK_TUNING == true && -f $INSTALL_ROOT/current/server/host-network-tuning.py ]]; then
  if ! python3 -I -B "$INSTALL_ROOT/current/server/host-network-tuning.py" apply-auto --role panel; then
    echo 'Network profile was preserved. Review its status in panel settings.' >&2
  fi
fi
if [[ $VORTEX_MANAGED_TLS == true && $VORTEX_ACCESS_MODE != local && -f $INSTALL_ROOT/current/server/host-tls.py ]]; then
  if ! python3 -I -B "$INSTALL_ROOT/current/server/host-tls.py" auto; then
    echo 'Public certificate setup was not verified. Existing HTTPS is retained; review HTTPS settings and inbound TCP 80.' >&2
  fi
fi
echo 'Vortex Panel installed and healthy.'
echo 'Reload any open panel browser tab to load the installed interface.'
echo 'Linked workers are separate installations. Review their versions in Settings > Panel administration > Check for updates.'
if [[ $VORTEX_AUTO_ACCESS != true ]]; then
  PUBLIC_PANEL_URL=$(sed -n 's/^PUBLIC_URL=//p' /etc/vortex-panel.env | tail -n 1 | tr -d '"\r')
  echo "Panel URL: ${PUBLIC_PANEL_URL:-http://$PANEL_CHECK_HOST:$PANEL_PORT}"
fi
# BEGIN first admin receipt
# A process ID may be reused. Bind setup output to the current systemd invocation.
PANEL_SETUP_TOKEN=
if [[ $FRESH_INSTALL == true ]]; then
  for attempt in {1..5}; do
    PANEL_PID=$(systemctl show --property MainPID --value vortex-panel 2>/dev/null || true)
    PANEL_INVOCATION=$(systemctl show --property InvocationID --value vortex-panel 2>/dev/null || true)
    if [[ $PANEL_PID =~ ^[1-9][0-9]*$ && $PANEL_INVOCATION =~ ^[a-f0-9]{32}$ ]]; then
      SETUP_CANDIDATE=$(journalctl -b -u vortex-panel "_PID=$PANEL_PID" "_SYSTEMD_INVOCATION_ID=$PANEL_INVOCATION" -n 100 --no-pager -o cat 2>/dev/null | sed -n 's/^SETUP TOKEN: \([A-Za-z0-9_-]\{20,128\}\)$/\1/p' | tail -n 1 || true)
      if [[ $(systemctl show --property MainPID --value vortex-panel 2>/dev/null || true) == "$PANEL_PID" && $(systemctl show --property InvocationID --value vortex-panel 2>/dev/null || true) == "$PANEL_INVOCATION" ]] && systemctl is-active --quiet vortex-panel; then
        PANEL_SETUP_TOKEN=$SETUP_CANDIDATE
      fi
    fi
    [[ -z $PANEL_SETUP_TOKEN ]] || break
    sleep 0.2
  done
fi
if [[ -n $PANEL_SETUP_TOKEN ]]; then
  printf '\nOne-time setup token: %s\nOpen the panel URL and create your first Admin account. Keep this token private.\n' "$PANEL_SETUP_TOKEN"
else
  echo 'Existing accounts are retained. If setup is pending, run: sudo journalctl -u vortex-panel -n 30 --no-pager'
fi
# END first admin receipt
echo "Service user: $SERVICE_USER; host terminal: $TERMINAL"
