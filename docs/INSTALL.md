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
5. Verify `/healthz` against the service's actual MainPID. Prepare NGINX, a self-signed certificate containing the selected IP and a localhost reverse proxy. HTTP redirects to HTTPS.
6. Print access/setup guidance and remove temporary bootstrap files.

The panel binds to `127.0.0.1:3000`; NGINX terminates HTTPS on port 443. Public setup sets `PUBLIC_URL` and `TRUST_PROXY` appropriately. When UFW is already active, the helper adds only its missing web-port allowances. It does not enable/reset UFW or manage the VPS provider's firewall. Minecraft and application ports are configured separately in the panel's network tools.

The bootstrap's checksum detects a source archive that differs from its published release. The HTTPS repository/publisher is the trust source; checksums do not independently authenticate the bootstrap script you have already chosen to run.

## HTTPS and first login

Automatic IP setup uses a **self-signed TLS certificate**. Your browser will display a certificate trust warning on first access. Compare the certificate fingerprint printed by the installer before trusting it. This provides encryption once the intended certificate is trusted; it is not a publicly trusted certificate issued by a certificate authority.

The generated certificate expires after **365 days**. Automatic renewal is not configured, and panel updates preserve the existing certificate. Replace it before expiry, update any explicit trust decision when the certificate changes, and verify the new endpoint. The [HTTPS operations guide](OPERATIONS.md#https-bằng-domain-hoặc-ip) covers configuring a publicly trusted certificate and checking its renewal.

Open the printed HTTPS URL, enter the private setup token and create the first Admin. Existing accounts are retained during updates. The setup token is used only while no administrator exists; the administrator password must be at least 12 characters.

For a domain or a publicly trusted IP certificate, use the documented [HTTPS configuration](OPERATIONS.md#https-bằng-domain-hoặc-ip). The automatic installer does not create an ACME account or accept a certificate authority's terms for you. Renewal and public reachability must be verified for your deployment.

If you need the initial token again, inspect the service journal on the host:

```bash
sudo journalctl -u bedrock-panel -n 60 --no-pager
```

Treat journal output containing a setup token as private.

## Installation options

Pass options after `bash -s --`. They are optional for the standard command.

| Option | Purpose |
| --- | --- |
| `--version X.Y.Z` | Install one exact stable Vortex release instead of latest stable |
| `--public-ip IPV4` | Supply the globally routable IPv4 to use for a fresh public setup when automatic discovery is unsuitable |
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

Run the same one-command installer to update to the latest stable release. It preserves existing accounts, application data, runtime pins, service mode and external-access settings. Updates can restart the panel and local workloads; plan a maintenance window. Remote node workloads are managed by their own service and require their own compatible agent update when a release changes agent behavior.

Before an update, take an off-host backup of panel data, service environment, proxy configuration and TLS keys/certificates. For the panel's data snapshot helper:

```bash
sudo bash /opt/bedrock-panel/current/deploy/backup-panel.sh /var/backups/vortex-panel
```

The snapshot helper stops the service to obtain exclusive data access and restores its prior running state afterward. Its archive includes sensitive account/encryption material. Store it privately, copy it off the VPS and back up the host configuration separately. See [snapshot and recovery details](OPERATIONS.md).

The installer retains source releases and can roll source/service configuration back after a failed health check. That rollback does **not** undo world or application data changes. Do not treat it as a data backup.

## Paths and service commands

The original service/path names remain stable for upgrades:

| Item | Path/name |
| --- | --- |
| Service | `bedrock-panel.service` |
| Source releases | `/opt/bedrock-panel/releases/` |
| Active source | `/opt/bedrock-panel/current` |
| Panel and local-server data | `/var/lib/bedrock-panel` |
| Service environment | `/etc/bedrock-panel.env` |

```bash
sudo systemctl status bedrock-panel
sudo journalctl -u bedrock-panel -n 100 --no-pager
sudo systemctl restart bedrock-panel
```

If setup stops, keep the reported recovery information and inspect the specific failure before repeating a state-changing operation. Unknown web services, port conflicts, public-IP detection failures or a failed health check should be resolved explicitly.

## Release contents

Each stable release contains `vortex-panel-X.Y.Z.zip`, `install.sh`, `release-manifest.json` and `SHA256SUMS`. The ZIP contains public source and its required installation helpers. Server data, credentials, local output, installed dependencies and backup files are excluded. See the [release process](publication.md) for verification and publication boundaries.
