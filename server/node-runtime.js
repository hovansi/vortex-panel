// Worker releases contain managed server runtimes and authenticated control API.
// The panel entry point, browser assets, account setup and enrollment code are
// intentionally absent. Keep this explicit list in sync with runtime imports.
export const NODE_RUNTIME_FILES = Object.freeze([
  'package.json', 'package-lock.json',
  'server/application-runtime.js', 'server/application-schema.js', 'server/application-runtime-catalog.js', 'server/application-managed-runtime.js', 'server/application-runtime-artifact.js',
  'server/access.js', 'server/archives.js', 'server/backup-messages.js', 'server/bedrock-log.js',
  'server/bedrock-world-format.js', 'server/capacity.js',
  'server/configuration.js', 'server/diagnostics.js',
  'server/file-operations.js', 'server/file-privacy.js',
  'server/gameplay-messages.js', 'server/gameplay.js',
  'server/panel-removal.js', 'server/panel-layout.js', 'server/fleet-removal.py',
  'server/host-location.js', 'server/host-telemetry.js', 'server/host.js',
  'server/hostname.js', 'server/host-zram.js', 'server/host-zram.py', 'server/job-progress.js', 'server/locale-catalog.js',
  'server/locale.js', 'server/live-backup.js', 'server/lock.js', 'server/log-retention.js',
  'server/manager.js', 'server/mount-safety.js', 'server/network-metrics.js',
  'server/node-agent.js', 'server/node-cli.js', 'server/node-messages.js',
  'server/node-runtime.js', 'server/node-transport.js', 'server/node-removal.js', 'server/node-removal.py',
  'server/packs.js', 'server/player-lists.js', 'server/port-allocation.js',
  'server/resource-control-messages.js', 'server/resource-control.js',
  'server/resource-exit.js', 'server/routes.js', 'server/safety.js',
  'server/server-firewall.js', 'server/server-voice.js',
  'server/storage-cli.js', 'server/storage-policy.js',
  'server/storage-volumes.js', 'server/store.js', 'server/system-power.js',
  'server/version-catalog.js', 'server/versions.js', 'server/worlds.js',
  'public/world-voice.js',
]);

export const NODE_INSTALLER_FILES = Object.freeze([
  ...NODE_RUNTIME_FILES, 'deploy/install-node.sh', 'deploy/application-isolation.py', 'deploy/install-ledger.py',
]);
