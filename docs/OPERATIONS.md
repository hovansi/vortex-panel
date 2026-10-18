# Operating Vortex Panel

[Install and update](INSTALL.md) · [Applications](applications.md) · [Nodes](NODES.md) · [Resources and storage](OPERATIONS-090.md)

Vortex Panel manages Bedrock, Node.js and Python workloads on their assigned Ubuntu VPS. English is the default interface language. The interface language and each Minecraft server’s announcement language are separate settings. Restrict host administration and node enrollment to trusted administrators.

## Updates and service maintenance

Take an off-host snapshot before an important update. Run the [release installer](INSTALL.md) again for the latest stable panel version. For a reviewed source checkout, run `sudo bash deploy/install.sh`. Existing service mode and access configuration are preserved unless explicitly changed.

The installer prepares dependencies before stopping the service, activates a separate release directory and verifies `/healthz` against the systemd MainPID. A failed activation attempts to restore the previous source link, environment, unit and ownership. Preserve any reported recovery path or rollback error. Source rollback does not undo changes to worlds, applications or databases.

The managed service and data directory use the canonical `vortex-panel` name. The installer migrates verified legacy layouts before starting the new service:

```bash
sudo systemctl status vortex-panel
sudo journalctl -u vortex-panel -n 100 --no-pager
curl --fail http://127.0.0.1:3000/healthz
```

A fresh automatic installation enables root host administration. `--root-mode` selects this explicitly; `--service-user` uses the dedicated service account and disables the host terminal. Ownership changes can fail on protected files. The installer does not remove immutable flags; investigate the reported path.

A clean shutdown records workloads that should resume. Intentionally stopped workloads stay stopped unless auto-start was enabled. Finish long operations before maintenance and verify server state afterward. Restarting the controller interrupts its connections to workers; remote processes and schedules run on their own VPS.

## HTTPS bằng domain hoặc IP

Automatic public-IP setup uses a self-signed IP certificate valid for 365 days, without automatic renewal. Compare the printed SHA-256 fingerprint before accepting browser trust. Monitor expiry and replace the certificate before it expires; updates preserve existing access configuration.

For a domain or publicly trusted IP certificate, keep the panel bound to `127.0.0.1` behind NGINX. Adapt `deploy/nginx.conf.example` to the actual certificate, hostname and local port. Set `PUBLIC_URL=https://YOUR_DOMAIN` or `https://YOUR_IP` and `TRUST_PROXY=1` in `/etc/vortex-panel.env`, then restart the panel. Backend upload limits still apply.

Let’s Encrypt provides IP certificates through its short-lived profile. Follow its [Certbot instructions for IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html) and [certificate lifetime policy](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability). Issuance requires a compatible ACME client and a reachable challenge path. CA terms, certificate issuance and renewal are administrator-managed; the Vortex installer does not perform them.

Validate configuration with `nginx -t` before reload. Configure renewal and a deployment hook that validates/reloads NGINX, monitor expiry and verify the certificate served externally. A renewal dry-run does not prove which certificate clients currently receive. Keep private keys accessible only to their required service identity.

Allow the panel web ports at the host and provider firewall. NGINX does not forward Minecraft UDP, NetherNet signaling or application ports; those use separate per-server policy.

## Whole-panel snapshots

Per-server backups protect one workload. For whole-panel recovery, run the helper from the installed source:

```bash
sudo bash deploy/backup-panel.sh /var/backups/vortex-panel
```

Use an absolute private destination outside `DATA_DIR`, not one of its ancestors. Existing destinations must already belong to root with private permissions. The helper stops the service, obtains the data lock, unmounts owned fixed volumes, creates a private archive, then restores previous mounts and running state. This interrupts workloads managed by that service. Failed mount recovery retains a receipt; understand its storage state before removing a lock or restarting workloads.

Copy snapshots off the VPS. Preserve `panel.json`, `.mfa-key` and `.node-key` together: missing keys can make TOTP or enrolled-node credentials unrecoverable. Back up `/etc/vortex-panel.env`, proxy configuration, certificates and other host configuration separately. Controller snapshots do not contain remote workers’ worlds; each node needs its own backup.

To restore, stop the service, retain the damaged tree separately and restore into an empty private directory. Do not merge snapshots with current metadata or mounted images. Match ownership to the selected service mode, restore host configuration and verify health, accounts, nodes and workloads before reopening access. Sessions and MFA challenges require a new login after restart.

## Server backup and recovery

Bedrock supports [online snapshots](ONLINE-BACKUPS.md) through native `save hold/query/resume`. Snapshot preparation failure reports an error; it does not silently stop/restart the server. Restore and runtime replacement require a stopped server. Node.js/Python backup creation, restoration and file access require a stopped application.

Keep important backups outside the workload’s VPS. ZIP integrity does not guarantee application behavior or world compatibility. Review native logs and data after recovery. See [world formats and limits](WORLDS.md).

### Restore lỗi và rollback cũng không thành công

When activation and rollback both fail, retain the reported original and candidate trees. `restoreRecoveryRequired` records both causes and relative paths; the public server reports `recoveryRequired:true`. Start, resume and conflicting data mutations are blocked to preserve recovery material.

1. Preserve an off-host snapshot and exact errors. Stop the service before touching metadata or paths.
2. Match the server UUID, `panel.json` record and paths under `DATA_DIR/servers/<id>/`. Inspect both trees; do not infer identity from display names.
3. To abandon the failed restore, preserve the candidate separately and rename the verified original into an empty `run` path on the same filesystem. Do not merge or overwrite trees.
4. After verifying `run`, update only that server record atomically: remove `restoreRecoveryRequired`, set `status:"stopped"` and `error:null`, temporarily disable auto-start and remove `resumeOnPanelStart`. Keep account, key, port, version and server identities.
5. Start the panel, inspect configuration/native logs and deliberately start the workload. Retain recovery copies until data is verified and backed up elsewhere.

Do not clear the marker merely to enable Start. If state cannot be saved, preserve job output and repair storage/permissions first. Recovery handles observed process errors; there is no multi-file transaction journal guaranteeing automatic repair after power loss.

## Deletion, retention and cleanup warnings

Deletion requires a stopped server and no conflicting task. Owned data moves to quarantine; metadata/audit commit precedes byte cleanup. A failed commit attempts to restore prior paths and records. `ok:true` with `warnings` or `cleanupPending` means the metadata change succeeded but some bytes remain. Compare the reported paths, record and audit before cleaning. Keep both copies whenever commit state is uncertain.

Retention runs after a new backup commits. Pruning failure retains the new backup, stops further cleanup and reports `retentionComplete:false`; the unlocked count may exceed policy temporarily. Locked backups do not consume rolling retention. Activity and completed-job history have age/count/byte budgets; active work and unresolved recovery references are protected. Inspect or export history in **Settings → Log storage & retention**.

## Files and advanced access

Each server has its own workspace. Ordinary Bedrock file operations can run without a conflicting task, while active-world and protected-runtime restrictions remain. Use online backup for consistent running-world copies. Stop Node.js/Python applications before accessing their files.

Copy, move, rename and upload refuse existing destinations. ZIP extraction creates a new directory. The UTF-8 editor accepts up to 2 MiB and checks revisions; conflicts preserve drafts. File operations allow up to 1,000 sources, 2 GiB expanded content and 50,000 entries; each upload is at most 100 MiB. Include temporary staging in free-space planning.

**Advanced access** requires the current Admin password and expires after ten minutes. It does not override path/symlink validation, a running world’s locks or maintenance. Do not edit the same path with external tools during a panel operation. Preserve staging/recovery paths after rollback failures.

## Ports and connection troubleshooting

Stop a workload before changing its ports. The selected VPS allocates non-overlapping random ports by default; existing addresses stay stable. Deliberate custom mappings remain available. See [allocation policy](PORTS-0155.md).

RakNet uses UDP; NetherNet uses TCP signaling and its configured UDP range. **Configuration → Network access** previews scoped UFW rules and requires explicit apply. It does not enable UFW, modify provider firewalls or configure NAT. Check socket ownership, transport, public address and provider policy when a client cannot connect. Allocation and local health do not prove external reachability.

## Worker maintenance

Node display names and operating-system hostnames are separate settings. Automatic location is approximate egress-IP metadata and can describe a provider gateway; manual location takes precedence. Offline nodes retain labeled last-known inventory. Their processes are not confirmed stopped.

Worker uninstall requires a verified empty inventory, exact node name, Admin re-authentication and fresh pinned SSH credentials. It never silently deletes servers. Unknown/partial results keep the recovery state until verification; observe the existing request instead of repeating destruction. Shared packages, unproven legacy files, recovery data and separate panel stores are retained. See [nodes](NODES.md) and [SSH provisioning](NODE-PROVISIONING.md).

## System administration and resource boundaries

Service restart, reboot and zram require explicit confirmation and current Admin authentication. Reads do not change the system. After a write times out, refresh its observed state instead of submitting it again. Zram assists system memory through compression; it does not increase server allocation capacity.

Bedrock runs natively without a separate customer container. Node.js/Python uses a non-root identity and verified Bubblewrap/filesystem/cgroup controls, sharing the host network namespace. Resource ceilings are usage limits, not dedicated hardware reservations. The main VPS keeps a ten-percent accounting budget; workers use effective capacity subject to physical disk/RAM and ancestor limits. Legacy directories have no hard quota. See [resource control](RESOURCE-CONTROL.md), [telemetry/storage](OPERATIONS-090.md) and [application isolation](applications.md).

Report reproducible problems with panel/Ubuntu versions and redacted logs. Never publish passwords, tokens, cookies, encryption keys or private project files.


## Verified fleet uninstall

Settings → Uninstall Vortex Panel permanently removes all managed server files, worlds,
backups and runtime caches from each listed installation. Review the native path inventory
returned by the authenticated SSH check for every machine before confirming. Linked workers
are processed one at a time and independently checked through a new pinned SSH connection.
The main panel is scheduled last, only after every linked worker has a complete removal proof.
An unreachable, mismatched or unverified worker keeps the main panel in place.

Use the current administrator password, type the exact current main-node display name, and
explicitly acknowledge permanent erasure. Supply root SSH access for every machine and
verify its observed SSH host-key fingerprint. Credentials stay in memory for this request;
they are not saved in panel history, browser storage or downloaded receipts. This workflow
requires the managed root-mode Linux installation. Service-user installations show an
unavailable state rather than claiming they can remove system files without root privileges.

Keep the downloadable receipt before continuing. Main removal uses a detached systemd timer,
so the panel disconnects while cleanup continues. A disconnect is not a successful verification.
Each receipt contains the request UUID, native result path and the exact SSH verification command.
Run that command on the corresponding VPS before rebooting; the recovery workspace is under
`/run/vortex-fleet-removal/<request-id>` and is intentionally temporary. An interrupted or
ambiguous request is not replayed automatically. If a removal stops after making changes,
keep its receipt and inspect the existing native result through SSH before further action.

Fresh installations record their package, apt manual-mark, service and file baseline before
installer changes. Uninstall removes only components proven to belong to that installation,
restores recorded state where possible and retains OS, SSH, networking and foreign software.
A legacy installation without its original baseline cannot reconstruct the VPS's historic
package state: unproven shared components are listed as retained, and `baselineRestored` is
false. This is reported explicitly rather than deleting unrelated packages by guesswork.
Custom files that replaced managed shared configuration block removal until reviewed.
The standard migration backup is erased only when its machine-bound committed transaction,
file identities and content hashes all match; unproven external backups are retained.

Legacy upgrades migrate `bedrock-panel.service`, `/opt/bedrock-panel`,
`/var/lib/bedrock-panel` and `/etc/bedrock-panel.env` to the `vortex-panel` layout.
The installer stops the old service, records a private recovery transaction, handles owned
application accounts and server volumes, and rolls back on an uncommitted failure. Keep
normal off-host backups when upgrading any production service.
