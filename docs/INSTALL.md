# Install and update Vortex Panel

[Overview](../README.md) · [Tiếng Việt](README.vi.md) · [Operations and recovery](OPERATIONS.md)

The public installer downloads a complete, versioned Vortex Panel release and installs it as a systemd service. On a fresh VPS it also prepares public-IP HTTPS, so the normal installation needs one command and no manual source upload.

## Requirements

- Ubuntu 22.04 or later, x86_64, with a running systemd and root/sudo access.
- Working HTTPS access to GitHub, Ubuntu repositories and the official runtime providers. The initial command requires `curl` and a working HTTPS CA trust store.
- For automatic public setup: a globally routable IPv4 address and available TCP 80/443. Provider firewall/NAT access must allow the intended traffic.
- Sufficient CPU, memory and storage for the intended workloads. Creating Python runtimes additionally requires a capped 1 GiB RAM build and temporary 3 GiB build volume, plus admission overhead. The panel reports missing sandbox/resource capabilities rather than silently dropping enforcement.

Windows and macOS are development/UI preview environments; this installer targets the supported Ubuntu host.

## One command

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh | sudo bash
```

For a **fresh installation**, this command selects full root host management and public-IP HTTPS. Application code for Node.js/Python still runs under dedicated non-root identities and their sandbox. On an **existing installation**, the installer retains the current service mode and external-access configuration.

The final output includes the panel URL and first-Admin setup instructions. No shared `admin` password is installed. Keep the setup token private and create your own administrator account in the browser.

## What is automatic

1. Validate platform, arguments and privileges; resolve the latest stable release once.
2. Download that release's source ZIP and checksums through verified HTTPS. Check the archive's SHA-256, paths, file types and size before extraction.
3. On fresh public setup, detect a public IPv4 through agreeing HTTPS lookup services, or validate your explicit `--public-ip` override. Preflight rejects unknown existing web configurations and occupied public web ports before taking them over.
4. Prepare system dependencies and the panel's Node.js runtime; install npm dependencies from the lockfile; configure and start systemd.
5. Verify `/healthz` against the service’s actual MainPID. Prepare NGINX, initial IP TLS and the loopback reverse proxy. Attempt a trusted IP certificate and install its renewal timer; keep working access if the CA request fails. Apply only supported, conservative owned network settings.
6. Print access/setup guidance and remove temporary bootstrap files.

The panel binds to `127.0.0.1:3000`; NGINX terminates HTTPS on port 443. Public setup sets `PUBLIC_URL` and `TRUST_PROXY` appropriately. When UFW is already active, the helper adds only its missing web-port allowances. It does not enable/reset UFW or manage the VPS provider's firewall. Minecraft and application ports are configured separately in the panel's network tools.

The bootstrap's checksum detects a source archive that differs from its published release. The HTTPS repository/publisher is the trust source; checksums do not independently authenticate the bootstrap script you have already chosen to run.

## HTTPS and first login

Automatic IP setup attempts a **publicly trusted Let’s Encrypt IP certificate**. IP certificates last six days; the owned timer checks renewal every six hours. Inbound TCP 80 and 443 must remain reachable. See [HTTPS lifecycle and verification](HTTPS.md). The installer creates a private ACME account without a contact email and accepts the CA subscriber agreement as part of this automatic setup; use `--self-signed` to opt out before installation.

If public issuance fails, the initial self-signed certificate remains available and the installer prints a warning. A self-signed fallback lasts 365 days and remains untrusted until the administrator explicitly trusts it; it is not a substitute for verified public issuance. Existing custom proxies/certificates are preserved. Inspect the actual HTTPS status in **Settings → Panel administration**.

Open the printed HTTPS URL, enter the private setup token and create the first Admin. Existing accounts are retained during updates. The setup token is used only while no administrator exists; the administrator password must be at least 12 characters.

Custom domains and proxies can still be configured manually using the [HTTPS operations guide](OPERATIONS.md#https-bằng-domain-hoặc-ip). Automatic IP certificate management applies only to the exact Vortex-owned IP proxy. A source-only panel update preserves host access configuration; enabling a new host feature remains an explicit administrator action.

If you need the initial token again, inspect the service journal on the host:

```bash
sudo journalctl -u vortex-panel -n 60 --no-pager
```

Treat journal output containing a setup token as private.

## Installation options

Pass options after `bash -s --`. They are optional for the standard command.

| Option | Purpose |
| --- | --- |
| `--version X.Y.Z` | Install one exact stable Vortex release instead of latest stable |
| `--public-ip IPV4` | Supply the globally routable IPv4 to use for a fresh public setup when automatic discovery is unsuitable |
| `--self-signed` | Retain self-signed IP access; do not request a public CA certificate |
| `--no-network-tuning` | Skip automatic host network profile changes |
| `--local-only` | Keep a fresh installation local-only; do not prepare public NGINX/HTTPS access |
| `--root-mode` | Explicitly select root service mode for host terminal and local storage administration |
| `--service-user` | Select the dedicated service account and disable the host terminal |

An existing installation's public access is preserved; these access options are not an implicit migration of a configured proxy. Read the installer's `--help` for accepted combinations.

For a local-only installation:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh | sudo bash -s -- --local-only
```

Then forward its listener from your computer:

```bash
ssh -L 3000:127.0.0.1:3000 YOUR_SSH_USER@YOUR_VPS_IP
```

Open `http://127.0.0.1:3000` on that computer and complete setup with the token. The panel's service mode and network exposure are separate choices.

## Review the script before running

To inspect the same installer first:

```bash
curl --proto '=https' --tlsv1.2 -fL -o vortex-install.sh https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh
less vortex-install.sh
sudo bash vortex-install.sh
```

The release asset `install.sh` is the repository-bound downloader. In source, `deploy/bootstrap.sh` is its generic template, and `deploy/install.sh` is the full Ubuntu installer invoked after downloading the source. To run the generic source bootstrap, pass `--repository hovansi/vortex-panel` explicitly. A downloaded complete source tree can instead run `sudo bash deploy/install.sh` directly.

## Updates and backups

For routine updates on a compatible managed root installation, use **Settings → Panel administration → Check for updates**. The source updater verifies the official stable release, prepares isolated dependencies, updates and independently verifies linked workers first, then restarts the main panel. All servers must already be stopped and jobs idle; it never stops workloads automatically. It does not upgrade OS packages or Minecraft/Node.js/Python server runtimes, replace customer files, or rewrite service/TLS/access configuration. See [the full update and interrupted-request recovery guide](PANEL-UPDATES.md).

The one-command installer remains available for initial setup, host-level prerequisites, layout migration and planned maintenance upgrades. It preserves existing accounts, application data, runtime pins, service mode and external-access settings, but can restart the panel and local workloads. Stop workloads deliberately and back them up before this separate maintenance path. Running the main installer does not automatically upgrade every remote agent.

An older 0.19.x agent cannot acknowledge the new durable update admission freeze. The panel blocks its one-click activation rather than risking a scheduled workload starting during the update. Stop its workloads, review the matching release and run that release's worker installer on the existing VPS as described in [Node Agent](NODE-AGENT.md), retaining its configuration, token, TLS files and data directory. Verify its identity, health and server definitions before using fleet updates. A service-user/custom installation also needs deliberate administrator maintenance; the source updater does not silently switch it to root mode.

Before an update, take an off-host backup of panel data, service environment, proxy configuration and TLS keys/certificates. For the panel's data snapshot helper:

```bash
sudo bash /opt/vortex-panel/current/deploy/backup-panel.sh /var/backups/vortex-panel
```

The snapshot helper stops the service to obtain exclusive data access and restores its prior running state afterward. Its archive includes sensitive account/encryption material. Store it privately, copy it off the VPS and back up the host configuration separately. See [snapshot and recovery details](OPERATIONS.md).

The installer retains source releases and can roll source/service configuration back after a failed health check. That rollback does **not** undo world or application data changes. Do not treat it as a data backup.

If an interrupted install leaves `/run/vortex-install-ledger-panel.json`, a normal retry refuses to overwrite that original private baseline. Inspect the reported recovery files and resolve the original failure first. From the same reviewed source release, review the root-only capture and obtain its exact SHA-256 with `sudo sha256sum /run/vortex-install-ledger-panel.json`, then run `sudo bash deploy/install.sh --resume-ledger REVIEWED_CAPTURE_SHA256` with the applicable original mode/access options. The source installer validates the preserved capture's owner, permissions, host identity and exact hash before reusing it; the release bootstrap does not accept this recovery option. A separate private resume snapshot records the current state before the retry, so packages or shared helpers added during the interruption are not automatically claimed. Resuming does not repair foreign or partial paths automatically. Successful completion consumes both captures into the permanent private manifest.

## Legacy layout migration

An update from the previous `bedrock-panel` layout performs an offline migration to `vortex-panel.service`, `/opt/vortex-panel`, `/var/lib/vortex-panel` and `/etc/vortex-panel.env`. It stops the old service, verifies owned storage mounts and application identities, unmounts owned volumes without force, and takes a complete private stopped-data snapshot before renaming the default roots. Application account names and their data-path scope change together while UID/GID ownership remains stable. Managed environment, unit drop-ins, application-isolation ownership and Vortex memory-assistance references follow the new service name. Existing explicit custom `DATA_DIR` values remain in place.

Migration backups and the durable transaction receipt remain under `/var/backups/vortex-panel/migration-*/` (root-only). The installer restores the old layout and service state if activation fails. It refuses mixed old/new installations, unknown mounts, incomplete application-account/build transactions, custom legacy service layouts and a default data directory that is itself a filesystem mountpoint. Resolve the reported condition before retrying; no forced unmount or overwrite is used. If the installer reports an interrupted transaction, use its exact printed recovery command with the matching release's `deploy/panel-layout-migrate.py rollback --transaction /var/backups/vortex-panel/migration-TIMESTAMP/transaction.json`. A completed migration cannot be reversed blindly after new writes; use the retained snapshot in a planned restore.

Fresh installations record the OS package/manual-mark baseline before installing prerequisites and retain a private ownership manifest. Shared or pre-existing packages, accounts, firewall rules and host configuration are not assumed to belong to Vortex. Older installations have an unknown pre-install baseline; upgrading them records that limitation rather than claiming their original VPS state can be fully restored. The panel's downloaded Node.js interpreter is installed under its owned `/opt/vortex-panel/runtime/` directory when a suitable host interpreter is unavailable.

## Paths and service commands

Managed installations use the Vortex Panel names below. The default main VPS display name is **Vortex Panel**:

| Item | Path/name |
| --- | --- |
| Service | `vortex-panel.service` |
| Source releases | `/opt/vortex-panel/releases/` |
| Active source | `/opt/vortex-panel/current` |
| Panel and local-server data | `/var/lib/vortex-panel` |
| Service environment | `/etc/vortex-panel.env` |
| Dedicated service account | `vortex-panel` |
| Private installation ownership/baseline receipt | `/etc/vortex-panel/install-manifest.json` |

```bash
sudo systemctl status vortex-panel
sudo journalctl -u vortex-panel -n 100 --no-pager
sudo systemctl restart vortex-panel
```

If setup stops, keep the reported recovery information and inspect the specific failure before repeating a state-changing operation. Unknown web services, port conflicts, public-IP detection failures or a failed health check should be resolved explicitly.

## Release contents

Each stable release contains `vortex-panel-X.Y.Z.zip`, `install.sh`, `release-manifest.json` and `SHA256SUMS`. The ZIP contains public source and its required installation helpers. Server data, credentials, local output, installed dependencies and backup files are excluded. See the [release process](publication.md) for verification and publication boundaries.
