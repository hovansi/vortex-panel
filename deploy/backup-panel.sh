#!/usr/bin/env bash
set -Eeuo pipefail
# A consistent full Vortex Panel data snapshot, including users, MFA key and worlds.
# sudo bash deploy/backup-panel.sh [/absolute/backup/directory]
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ $# -le 1 ]] || { echo 'Usage: sudo bash deploy/backup-panel.sh [/absolute/backup/directory]' >&2; exit 1; }
SOURCE_PATH=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
STORAGE_CLI=$SOURCE_PATH/server/storage-cli.js
[[ -f $STORAGE_CLI && ! -L $STORAGE_CLI ]] || { echo 'The matching storage maintenance helper is required.' >&2; exit 1; }
NODE_BIN=$(command -v node)
DATA_PATH=/var/lib/bedrock-panel
if [[ -f /etc/bedrock-panel.env ]]; then
  CONFIGURED_DATA=$(sed -n 's/^DATA_DIR=//p' /etc/bedrock-panel.env | tail -n 1 | tr -d '\r' | sed 's/^"//;s/"$//')
  [[ -z $CONFIGURED_DATA ]] || DATA_PATH=$CONFIGURED_DATA
fi
[[ $DATA_PATH == /* && -d $DATA_PATH ]] || { echo 'DATA_DIR must be an existing absolute directory.' >&2; exit 1; }
DATA_PATH=$(realpath -e -- "$DATA_PATH")
BACKUP_ARGUMENT=${1:-/var/backups/vortex-mc}
[[ $BACKUP_ARGUMENT == /* ]] || { echo 'Backup directory must be an absolute path.' >&2; exit 1; }
BACKUP_PATH=$(realpath -m -- "$BACKUP_ARGUMENT")
[[ $DATA_PATH != / && $BACKUP_PATH != "$DATA_PATH" && $BACKUP_PATH != "$DATA_PATH/"* && $DATA_PATH != "$BACKUP_PATH/"* ]] || { echo 'Backup destination and DATA_DIR must not overlap.' >&2; exit 1; }
case "$BACKUP_PATH" in
  /|/etc|/etc/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|/boot|/boot/*|/dev|/dev/*|/proc|/proc/*|/sys|/sys/*|/run|/run/*|/var|/var/lib|/var/backups|/opt|/home|/root|/tmp|/var/tmp)
    echo 'Use a dedicated private backup directory, outside operating-system directories.' >&2
    exit 1;;
esac
if [[ -e $BACKUP_PATH ]]; then
  [[ -d $BACKUP_PATH && $(stat -c %u -- "$BACKUP_PATH") == 0 ]] || { echo 'Existing backup directory must be owned by root.' >&2; exit 1; }
  BACKUP_MODE=$(stat -c %a -- "$BACKUP_PATH")
  (( (8#$BACKUP_MODE & 0077) == 0 )) || { echo 'Existing backup directory must be private (for example mode 0700). Its permissions will not be changed automatically.' >&2; exit 1; }
else
  install -d -m 0700 -- "$BACKUP_PATH"
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$
PARTIAL=$BACKUP_PATH/.vortex-data-$STAMP.partial
DESTINATION=$BACKUP_PATH/vortex-data-$STAMP.tar.gz
MOUNT_RECEIPT=$BACKUP_PATH/.vortex-mounts-$STAMP.json
RESUME=false
LOCK_ACQUIRED=false
LOCK_ID=backup-$STAMP
finish() {
  local code=$?
  trap - EXIT
  local mounts_restored=true
  if [[ $LOCK_ACQUIRED == true && -f $MOUNT_RECEIPT ]]; then
    if ! "$NODE_BIN" "$STORAGE_CLI" mount-all --data-dir "$DATA_PATH" --receipt "$MOUNT_RECEIPT" --lock-owner-pid "$$"; then
      echo "Storage recovery needs attention; preserving the backup lock and private receipt: $MOUNT_RECEIPT" >&2
      mounts_restored=false; RESUME=false; code=1
    fi
  fi
  if [[ $mounts_restored == true && $LOCK_ACQUIRED == true && -f $DATA_PATH/panel.lock ]] && grep -Fq "\"identity\":\"$LOCK_ID\"" "$DATA_PATH/panel.lock"; then rm -f -- "$DATA_PATH/panel.lock"; fi
  if [[ $RESUME == true ]]; then
    if ! systemctl start bedrock-panel; then echo 'Snapshot finished, but the panel service could not restart. Check its journal.' >&2; code=1; fi
  fi
  [[ ! -f $PARTIAL ]] || rm -f -- "$PARTIAL"
  exit "$code"
}
trap finish EXIT
if systemctl is-active --quiet bedrock-panel; then RESUME=true; systemctl stop bedrock-panel; fi
[[ ! -e $DATA_PATH/panel.lock ]] || { echo 'Another panel process owns DATA_DIR. Stop it before taking a consistent snapshot.' >&2; exit 1; }
umask 0077
if (set -o noclobber; printf '{"pid":%s,"identity":"%s"}\n' "$$" "$LOCK_ID" > "$DATA_PATH/panel.lock") 2>/dev/null; then
  LOCK_ACQUIRED=true
else echo 'Another process acquired DATA_DIR before snapshot. Retry after it stops.' >&2; exit 1; fi
# Archive each unmounted, owned filesystem image exactly once. Archiving both a
# live image and its mounted files would produce an inconsistent duplicate.
"$NODE_BIN" "$STORAGE_CLI" unmount-all --data-dir "$DATA_PATH" --receipt "$MOUNT_RECEIPT" --lock-owner-pid "$$"
tar --create --gzip --file "$PARTIAL" --directory "$DATA_PATH" --exclude=./panel.lock --exclude=./panel.lock.recovery .
chmod 0600 -- "$PARTIAL"
mv -- "$PARTIAL" "$DESTINATION"
echo "Vortex Panel private data snapshot: $DESTINATION"
echo 'Includes metadata, keys, packages, legacy worlds and unmounted storage images. Original mounts and the running service are restored.'
