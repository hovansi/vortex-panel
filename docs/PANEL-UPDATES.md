# Update Vortex Panel and linked workers

[Install](INSTALL.md) · [Operations](OPERATIONS.md) · [API](API.md#fleet-source-updates)

Use **Settings → Panel administration → Check for updates** for routine source updates on a compatible managed root installation. English and Vietnamese UI labels follow the selected interface language. Checking a release or opening a plan does not activate an update.

## Prepare the fleet

1. Back up important data and encryption keys off the VPS. Keep service environment, proxy configuration and TLS certificates separately.
2. Stop every Minecraft, Node.js and Python server on every listed VPS. Finish backups, installations, file changes, provisioning and other system operations.
3. Review the official stable version, release notes, ordered VPS list and blockers. Compare each SSH fingerprint with a trusted record, then verify root SSH for every listed VPS, including the main one.
4. Enter the current panel Admin password, confirm the reviewed update and submit once. Keep its request ID.

The updater does not stop workloads automatically. Current servers use console pipes and lifecycle ownership tied to their controller process, so replacing that process safely requires a maintenance window. Unknown/offline worker state does not prove its servers are stopped.

The supported path uses the canonical managed Linux root service and release layout. Custom/service-user installations require deliberate administrator maintenance instead of an implicit conversion to root. At least 512 MiB free space is required for isolated source/dependency staging and rollback material.

### First upgrade from older agents

Older 0.19.x installations do not implement the durable source-update admission protocol. The updater refuses to activate them because a worker's own scheduler could otherwise start a workload between preparation and restart.

Stop that VPS's workloads and finish its jobs, review the intended release, then perform a one-time maintenance upgrade with the matching main/worker installer. The [main installer](INSTALL.md) and [worker installer](NODE-AGENT.md) are separate entry points. Preserve the existing data directory, agent configuration/token and TLS identity; verify health, account/server definitions and the enrolled agent ID afterward. This installer path may change host prerequisites and restart its service, so it has a wider scope than the in-panel source updater. Once every member supports the admission protocol, subsequent routine updates can use the panel workflow.

## What the update changes

The updater prepares a separate versioned source directory and its locked production dependencies. Dependency installation disables lifecycle scripts and uses a private cache. It does not invoke the full installer, run APT upgrades, rewrite the service unit/environment/proxy/TLS settings or update the panel's Node interpreter.

Server definitions, user accounts, permissions, ports, resource policies and installed Minecraft/Node.js/Python runtime pins are preserved. Worlds, project files and backups are not extracted, restored or replaced. A changed source does not grant permission to upgrade customer runtimes.

The release is restricted to the public [hovansi/vortex-panel](https://github.com/hovansi/vortex-panel/releases) repository. The checks bind its stable tag, expected asset names/sizes, GitHub publisher SHA-256 digests, manifest, `SHA256SUMS` and every archived public source file. Extraction rejects unsafe paths, links, unexpected files and inventory/mode/hash mismatches. Workers receive the release's explicit agent source list. Downloads use validated official HTTPS origins; checksum verification does not replace trust in the repository's publisher. See [GitHub's release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## Activation and progress

Source/dependencies are prepared on the listed VPS before activation. A root-private durable intent then freezes new mutations and schedules. Immediately before stopping a service, its running API must acknowledge that exact update UUID; stale/legacy code cannot silently bypass the freeze.

Linked workers activate sequentially before the main panel. Each worker must pass source, authenticated service, configuration and data-identity checks through a fresh pinned SSH connection. An already-current worker is attested against the approved official source and kept on that version. A newer worker is never downgraded.

Only after every worker is verified does a detached native task restart the main panel. Browser/API connections can briefly disappear, and the in-memory login session may require signing in again. Reopen the task from Settings or Notifications. Read-only checks inspect the original UUID; losing a response never causes automatic replay. A progress percentage or closed connection alone is not completion proof.

| Outcome | Meaning |
| --- | --- |
| Completed / verified | Every listed VPS passed the required proof for the target release |
| Failed with verified rollback | Activation failed and the previous source/service was independently verified |
| Known partial | Some workers were verified on the new source; later roles were safely left unchanged or rolled back. The main panel remains usable |
| Unknown | A dispatch, process interruption or verification result is unresolved. Admission remains frozen until the existing request is checked |

Source rollback switches back to the previous release and checks its service and protected definitions. It cannot undo world/project changes, restore arbitrary host changes or safely reverse an incompatible metadata migration. The updater never blindly overwrites `panel.json`: an incompatible definition change keeps an unknown outcome and private recovery evidence for administrator review.

## Recover an interrupted request

Open the existing task and choose **Verify an interrupted update** when offered. Re-enter fresh root SSH credentials for its original host/port/fingerprint targets and the current panel Admin password. Confirm verification/cancellation of the existing request.

Recovery inspects native receipts and verifies completed/rolled-back roles. It can cancel an undispatched prepared stage after verifying the original installation. A scheduled dispatch can be cancelled only after the native helper proves its timer/service are inactive, no matching job remains queued and the original service is healthy; a short delay is required before that cancellation is eligible. Active or ambiguous activation remains unknown. Recovery never installs or replays a release; current-source attestation may fetch official release metadata.

After a known partial result, review a new update plan. Already-current workers are independently attested; they are not downgraded or installed again. Do not create another request to hide an unknown one, remove the durable intent by hand, or clear history merely to unblock mutations.

## Private per-VPS receipts

The request UUID is shared across the fleet, but each VPS keeps its own root-private directory:

| Role | Request directory |
| --- | --- |
| Main panel | `/opt/vortex-panel/updates/REQUEST_UUID/` |
| Linked worker | `/opt/vortex-node/updates/REQUEST_UUID/` |

`request.json` records identity, approved hashes, phase and proof. `manifest.json` binds the publisher inventory; `helper.py` is the fixed helper copied for that request. `source.zip` and `panel.before.json` are recovery material when present. The stopped metadata snapshot contains private account/encryption references: do not publish it or attach it to an issue. The source release itself remains under the role's `releases/` directory.

For an actual worker request, substitute its exact agent UUID and request UUID from the task:

```bash
sudo /usr/bin/python3 -I -B /opt/vortex-node/updates/REQUEST_UUID/helper.py status --role worker --node-id AGENT_UUID --request-id REQUEST_UUID
sudo /usr/bin/python3 -I -B /opt/vortex-node/updates/REQUEST_UUID/helper.py verify --role worker --node-id AGENT_UUID --request-id REQUEST_UUID
```

For the main panel use its directory, `--role panel` and `--node-id local`. A known rollback has a separate `verify-rollback` action. These inspection commands do not activate a release. An already-current attested worker has no new native update workspace; its proof is in the central task instead.

Private npm staging caches are cleaned after dependency preparation when their ownership/mount checks permit it. Successful independently verified updates retain the three newest full metadata/archive recovery snapshots; older verified requests keep their compact receipts. Unknown and unsuccessful recovery material is preserved for review. Source releases are retained for rollback. Investigate any retention warning rather than removing unfamiliar paths or deleting snapshots still needed for recovery.
