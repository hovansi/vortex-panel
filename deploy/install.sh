#!/usr/bin/env bash
set -Eeuo pipefail

# Vortex Panel. Stable legacy service/data paths preserve existing installations.
# Run from source: sudo bash deploy/install.sh [--root-mode|--service-user] [--local-only|--public-ip IPv4]
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
      *) echo 'Usage: sudo bash deploy/install.sh [--root-mode|--service-user] [--local-only|--public-ip IPv4]' >&2; return 1;;
    esac
  done
}
# END installer options
parse_installer_options "$@"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
source /etc/os-release
[[ $ID == ubuntu ]] && dpkg --compare-versions "$VERSION_ID" ge 22.04 || { echo 'Ubuntu 22.04 LTS or newer is required.' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'Official Bedrock Linux binaries require x86_64.' >&2; exit 1; }
# BEGIN installer transaction lock
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
  VORTEX_INSTALL_LOCK_FD=$candidate_fd
}
acquire_installer_lock /run/vortex-panel-install.lock
# END installer transaction lock
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
INSTALL_ROOT=/opt/bedrock-panel
INSTALL_DIR=$INSTALL_ROOT/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$
DATA_DIR=/var/lib/bedrock-panel
ZRAM_HELPER=/usr/local/libexec/vortex-host-zram.py
RECOVERY_DIR=$(mktemp -d /tmp/vortex-install.XXXXXXXX)
ISOLATION_TRANSACTION=$RECOVERY_DIR/application-isolation.json
ISOLATION_ROLLBACK_FAILED=false
rollback_isolation() {
  if [[ -f $ISOLATION_TRANSACTION ]]; then
    if ! python3 "$SOURCE_DIR/deploy/application-isolation.py" rollback --owner bedrock-panel.service --transaction "$ISOLATION_TRANSACTION"; then
      ISOLATION_ROLLBACK_FAILED=true
      echo "Owned sandbox policy recovery needs review: $ISOLATION_TRANSACTION" >&2
    fi
  fi
}
cleanup() {
  [[ -z ${NODE_TEMP:-} ]] || rm -rf -- "$NODE_TEMP"
  if [[ $ISOLATION_ROLLBACK_FAILED != true ]]; then [[ -z ${RECOVERY_DIR:-} ]] || rm -rf -- "$RECOVERY_DIR"; fi
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
systemctl is-active --quiet bedrock-panel && PREVIOUS_ACTIVE=true
systemctl is-enabled --quiet bedrock-panel && PREVIOUS_ENABLED=true
[[ ! -f /etc/bedrock-panel.env ]] || cp -a /etc/bedrock-panel.env "$RECOVERY_DIR/environment"
[[ ! -f /etc/systemd/system/bedrock-panel.service ]] || cp -a /etc/systemd/system/bedrock-panel.service "$RECOVERY_DIR/service"
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
if [[ $DATA_DIR != /var/lib/bedrock-panel && -d $DATA_DIR && -n $(ls -A -- "$DATA_DIR") && ! -f $DATA_DIR/panel.json ]]; then
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
# END ownership helper
rollback() {
  local code=$? line=$1
  trap - ERR
  set +e
  echo "Vortex Panel installation failed at line $line; preserving server data." >&2
  if [[ $CHANGED_SERVICE == true ]]; then
    if systemctl stop bedrock-panel; then rollback_isolation; else
      ISOLATION_ROLLBACK_FAILED=true
      echo "Service stop was not confirmed; sandbox policy retained for review: $ISOLATION_TRANSACTION" >&2
    fi
    if [[ -f $RECOVERY_DIR/environment ]]; then cp -a "$RECOVERY_DIR/environment" /etc/bedrock-panel.env; else rm -f /etc/bedrock-panel.env; fi
    if [[ -f $RECOVERY_DIR/service ]]; then cp -a "$RECOVERY_DIR/service" /etc/systemd/system/bedrock-panel.service; else rm -f /etc/systemd/system/bedrock-panel.service; fi
    if [[ $CURRENT_EXISTED == true ]]; then
      ln -sfn -- "$PREVIOUS_LINK" "$INSTALL_ROOT/current.next"
      mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
    else rm -f "$INSTALL_ROOT/current" "$INSTALL_ROOT/current.next"; fi
    # A candidate root-mode process may atomically replace 0600 data files.
    # Restore the prior service identity before restarting a non-root release.
    local previous_user=bedrock-panel previous_group=bedrock-panel
    if [[ -f $RECOVERY_DIR/service ]]; then
      previous_user=$(sed -n 's/^User=//p' "$RECOVERY_DIR/service" | tail -n 1)
      previous_user=${previous_user:-root}
      previous_group=$(sed -n 's/^Group=//p' "$RECOVERY_DIR/service" | tail -n 1)
      previous_group=${previous_group:-$(id -gn -- "$previous_user" 2>/dev/null)}
    fi
    if [[ -n $previous_group ]] && id -- "$previous_user" >/dev/null 2>&1; then
      if ! apply_tree_ownership "$previous_user" "$previous_group" "$DATA_DIR"; then
        echo "Unable to restore data ownership. Recovery files retained at $RECOVERY_DIR" >&2
        RECOVERY_DIR=
      fi
    else
      echo "Previous service identity is unavailable. Recovery files retained at $RECOVERY_DIR" >&2
      RECOVERY_DIR=
    fi
    systemctl daemon-reload
    if [[ $PREVIOUS_ENABLED == true ]]; then systemctl enable bedrock-panel; else systemctl disable bedrock-panel; fi
    if [[ $PREVIOUS_ACTIVE == true ]]; then
      if ! systemctl start bedrock-panel; then
        echo "Previous service could not restart. Recovery files retained at $RECOVERY_DIR" >&2
        RECOVERY_DIR=
      fi
    fi
    echo 'Previous source/service configuration restored. Review journalctl -u bedrock-panel.' >&2
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
DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 apt-get install -y ca-certificates curl unzip rsync xz-utils libcurl4 libstdc++6 nftables e2fsprogs util-linux bubblewrap python3 python3-venv kmod
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
  if ! python3 "$SOURCE_DIR/deploy/application-isolation.py" prepare --owner bedrock-panel.service --transaction "$ISOLATION_TRANSACTION"; then
    rollback_isolation
    echo 'Optional application sandbox setup is unavailable; Minecraft installation continues.' >&2
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
        if [[ $changed == "$package" || $changed == "$package:amd64" ]]; then
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
python3 - "$ZRAM_HELPER" "$SOURCE_DIR/server/host-zram.py" <<'PY'
import os, pathlib, stat, sys
helper, source = map(pathlib.Path, sys.argv[1:])
for parent in reversed(helper.parents):
    if not parent.exists():
        parent.mkdir(mode=0o755)
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise SystemExit('Memory helper parent must be a real root-owned directory without shared write access.')
if os.path.lexists(helper):
    info = helper.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or helper.read_bytes() != source.read_bytes():
        raise SystemExit('Existing memory helper is unfamiliar; preserving it. Review the component before upgrading.')
else:
    descriptor = os.open(helper, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(source.read_bytes())
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        # Only this invocation's exclusively created file is eligible for cleanup.
        helper.unlink()
        raise
PY

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [[ $NODE_MAJOR -lt 22 ]]; then
  NODE_TEMP=$(mktemp -d /tmp/bedrock-node.XXXXXXXX)
  curl --fail --location --proto '=https' --tlsv1.2 --output "$NODE_TEMP/SHASUMS256.txt" https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  NODE_FILE=$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2; exit}' "$NODE_TEMP/SHASUMS256.txt")
  [[ -n $NODE_FILE ]] || { echo 'Unable to resolve official Node 22 archive.' >&2; exit 1; }
  curl --fail --location --proto '=https' --tlsv1.2 --output "$NODE_TEMP/$NODE_FILE" "https://nodejs.org/dist/latest-v22.x/$NODE_FILE"
  (cd -- "$NODE_TEMP" && awk -v f="$NODE_FILE" '$2 == f' SHASUMS256.txt | sha256sum --check -)
  tar -xJf "$NODE_TEMP/$NODE_FILE" --strip-components=1 -C /usr/local
fi

id bedrock-panel >/dev/null 2>&1 || useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin bedrock-panel
SERVICE_USER=bedrock-panel
TERMINAL=false
if [[ $MODE == root ]] || { [[ $MODE == preserve ]] && [[ -f $RECOVERY_DIR/service ]] && grep -q '^User=root$' "$RECOVERY_DIR/service"; }; then SERVICE_USER=root; TERMINAL=true; fi
install -d -m 0755 "$INSTALL_DIR"
if [[ ! -d $DATA_DIR ]]; then install -d -m 0700 "$DATA_DIR"; elif [[ $(stat -c '%a' -- "$DATA_DIR") != 700 ]]; then chmod 0700 "$DATA_DIR"; fi
rsync -a --exclude node_modules --exclude data --exclude .env --exclude .git --exclude .playwright-cli --exclude output --exclude releases --exclude current "$SOURCE_DIR/" "$INSTALL_DIR/"
# rsync -a also copies the source root's mode (for example a private 0700 upload).
chmod 0755 "$INSTALL_DIR"
cd -- "$INSTALL_DIR"
npm ci --omit=dev --ignore-scripts
apply_tree_ownership root root "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"
chmod a+r "$INSTALL_DIR/package.json"
chmod -R a+rX "$INSTALL_DIR/server" "$INSTALL_DIR/public" "$INSTALL_DIR/node_modules"
CHANGED_SERVICE=true
if [[ $PREVIOUS_ACTIVE == true ]]; then systemctl stop bedrock-panel; fi
apply_tree_ownership "$SERVICE_USER" "$SERVICE_USER" "$DATA_DIR"
if [[ ! -f /etc/bedrock-panel.env ]]; then
  install -m 0600 /dev/null /etc/bedrock-panel.env
  cat > /etc/bedrock-panel.env <<EOF
HOST=127.0.0.1
PORT=3000
DATA_DIR=$DATA_DIR
ALLOW_HOST_TERMINAL=$TERMINAL
TRUST_PROXY=0
EOF
else
  if [[ $MODE == root ]]; then
    if grep -q '^ALLOW_HOST_TERMINAL=' /etc/bedrock-panel.env; then sed -i 's/^ALLOW_HOST_TERMINAL=.*/ALLOW_HOST_TERMINAL=true/' /etc/bedrock-panel.env; else echo 'ALLOW_HOST_TERMINAL=true' >> /etc/bedrock-panel.env; fi
  elif [[ $MODE == service ]]; then
    if grep -q '^ALLOW_HOST_TERMINAL=' /etc/bedrock-panel.env; then sed -i 's/^ALLOW_HOST_TERMINAL=.*/ALLOW_HOST_TERMINAL=false/' /etc/bedrock-panel.env; else echo 'ALLOW_HOST_TERMINAL=false' >> /etc/bedrock-panel.env; fi
  fi
fi
TERMINAL=$(sed -n 's/^ALLOW_HOST_TERMINAL=//p' /etc/bedrock-panel.env | tail -n 1 | tr -d '"\r')
[[ $TERMINAL == true ]] || TERMINAL=false
NODE_BIN=$(command -v node)
ln -sfn "$INSTALL_DIR" "$INSTALL_ROOT/current.next"
mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
cat > /etc/systemd/system/bedrock-panel.service <<EOF
[Unit]
Description=Vortex Panel and managed servers
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_ROOT/current
EnvironmentFile=/etc/bedrock-panel.env
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
systemctl enable bedrock-panel
systemctl restart bedrock-panel
PANEL_PORT=$(sed -n 's/^PORT=//p' /etc/bedrock-panel.env | tail -n 1 | tr -d '"\r')
[[ $PANEL_PORT =~ ^[0-9]+$ ]] && [[ $PANEL_PORT -ge 1 && $PANEL_PORT -le 65535 ]] || { echo 'Invalid PORT in /etc/bedrock-panel.env' >&2; false; }
PANEL_HOST=$(sed -n 's/^HOST=//p' /etc/bedrock-panel.env | tail -n 1 | tr -d '"\r')
[[ $PANEL_HOST =~ ^[A-Za-z0-9.:-]*$ ]] || { echo 'Unsupported HOST for readiness check.' >&2; false; }
if [[ $PANEL_HOST == :: || $PANEL_HOST == ::1 ]]; then PANEL_CHECK_HOST='[::1]'; elif [[ -z $PANEL_HOST || $PANEL_HOST == 0.0.0.0 || $PANEL_HOST == localhost ]]; then PANEL_CHECK_HOST=127.0.0.1; elif [[ $PANEL_HOST == *:* ]]; then PANEL_CHECK_HOST="[$PANEL_HOST]"; else PANEL_CHECK_HOST=$PANEL_HOST; fi
READY=false
for attempt in {1..30}; do
  PANEL_PID=$(systemctl show --property MainPID --value bedrock-panel 2>/dev/null || true)
  if [[ $PANEL_PID =~ ^[1-9][0-9]*$ ]] && systemctl is-active --quiet bedrock-panel && \
    curl --fail --silent --show-error --noproxy '*' --max-time 2 "http://$PANEL_CHECK_HOST:$PANEL_PORT/healthz" 2>/dev/null | \
    "$NODE_BIN" --input-type=module -e 'let input = ""; for await (const part of process.stdin) { input += part; if (input.length > 65536) process.exit(1); } try { const health = JSON.parse(input); process.exit(health?.ok === true && health?.service === "vortex-mc" && health?.processId === Number(process.argv[1]) ? 0 : 1); } catch { process.exit(1); }' "$PANEL_PID" 2>/dev/null && \
    [[ $(systemctl show --property MainPID --value bedrock-panel 2>/dev/null || true) == "$PANEL_PID" ]] && systemctl is-active --quiet bedrock-panel; then
    READY=true; break
  fi
  systemctl is-active --quiet bedrock-panel || break
  sleep 1
done
[[ $READY == true ]] || { echo 'Readiness check failed. Rolling back service and source.' >&2; false; }
if [[ $VORTEX_AUTO_ACCESS == true ]]; then
  python3 "$SOURCE_DIR/deploy/configure-access.py" apply --plan "$RECOVERY_DIR/public-access.json"
fi
CHANGED_SERVICE=false
echo 'Vortex Panel installed and healthy.'
if [[ $VORTEX_AUTO_ACCESS != true ]]; then
  PUBLIC_PANEL_URL=$(sed -n 's/^PUBLIC_URL=//p' /etc/bedrock-panel.env | tail -n 1 | tr -d '"\r')
  echo "Panel URL: ${PUBLIC_PANEL_URL:-http://$PANEL_CHECK_HOST:$PANEL_PORT}"
fi
# BEGIN first admin receipt
# A process ID may be reused. Bind setup output to the current systemd invocation.
PANEL_SETUP_TOKEN=
if [[ $FRESH_INSTALL == true ]]; then
  for attempt in {1..5}; do
    PANEL_PID=$(systemctl show --property MainPID --value bedrock-panel 2>/dev/null || true)
    PANEL_INVOCATION=$(systemctl show --property InvocationID --value bedrock-panel 2>/dev/null || true)
    if [[ $PANEL_PID =~ ^[1-9][0-9]*$ && $PANEL_INVOCATION =~ ^[a-f0-9]{32}$ ]]; then
      SETUP_CANDIDATE=$(journalctl -b -u bedrock-panel "_PID=$PANEL_PID" "_SYSTEMD_INVOCATION_ID=$PANEL_INVOCATION" -n 100 --no-pager -o cat 2>/dev/null | sed -n 's/^SETUP TOKEN: \([A-Za-z0-9_-]\{20,128\}\)$/\1/p' | tail -n 1 || true)
      if [[ $(systemctl show --property MainPID --value bedrock-panel 2>/dev/null || true) == "$PANEL_PID" && $(systemctl show --property InvocationID --value bedrock-panel 2>/dev/null || true) == "$PANEL_INVOCATION" ]] && systemctl is-active --quiet bedrock-panel; then
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
  echo 'Existing accounts are retained. If setup is pending, run: sudo journalctl -u bedrock-panel -n 30 --no-pager'
fi
# END first admin receipt
echo "Service user: $SERVICE_USER; host terminal: $TERMINAL"
