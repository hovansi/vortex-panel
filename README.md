<p align="center">
  <img src="docs/assets/vortex-banner.svg" alt="Vortex Panel — one workspace for Minecraft Bedrock, Node.js and Python" width="1200">
</p>

<p align="center">
  <a href="docs/INSTALL.md">Install</a> ·
  <a href="docs/README.vi.md">Tiếng Việt</a> ·
  <a href="docs/applications.md">Applications</a> ·
  <a href="docs/NODES.md">Nodes</a> ·
  <a href="https://github.com/hovansi/vortex-panel/releases">Releases</a>
</p>

# Vortex Panel

**Servers. Applications. Your own infrastructure.**

Vortex Panel is a Node.js control panel for **Minecraft Bedrock, Node.js and Python** on Ubuntu. Manage local servers and linked VPS nodes through one responsive workspace: live console, files, backups, resource limits and everyday administration. The interface uses a full-window workspace, compact server lists and grouped settings, with light/dark themes and **English / Tiếng Việt**. English is the default.

Created by **@hovansi** · Maintained at [hovansi/vortex-panel](https://github.com/hovansi/vortex-panel).

## Install with one command

On an **Ubuntu 22.04+ x86-64 or ARM64 VPS with systemd**, run:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh | sudo bash
```

The release installer resolves the latest stable Vortex release, verifies its source archive, installs dependencies and starts the systemd service. On a fresh installation it prepares IP HTTPS and attempts a publicly trusted Let’s Encrypt IP certificate with automatic renewal. Fresh installations use **`https://IP:19191`**. Inbound TCP 80 (certificate validation) and 19191 (panel HTTPS) must be reachable. A failed CA request preserves the serving certificate and reports its actual status; use `--self-signed` to opt out. Follow the printed URL and private first-Admin setup instructions. Existing accounts and server data are preserved during maintenance upgrades. See [HTTPS](docs/HTTPS.md) for terms, renewal and ownership.

The managed service is `vortex-panel.service`, with source in `/opt/vortex-panel` and default data in `/var/lib/vortex-panel`. Legacy managed installs migrate offline with a private backup. The one-command path enables root host administration on a fresh installation. Node.js/Python application code runs under its own non-root account and sandbox. Existing installations retain their configuration. Read the [installation guide](docs/INSTALL.md) for requirements, certificate trust, updates and the local-only alternative.

## A workspace that follows the workload

| Area | What you can manage |
| --- | --- |
| **Minecraft Bedrock** | Official stable/preview discovery, searchable version history, live gamerule readback, coordinates, player controls, add-on stacks/priority, world experiments with pre-change backups and native online world export |
| **Node.js & Python** | Latest official stable runtime pinned at creation, entry file/npm script/Python module startup, dependency tasks, project inspection and secret environment variables |
| **Files & recovery** | Upload, download, edit with conflict detection, copy, move, rename, ZIP/extract, per-server backups, retention and restore |
| **Server identity** | Private cover image, icon, description and accent color for cards/workspaces; separate Bedrock listing text with Minecraft color codes |
| **Resources & ports** | Live CPU, RAM, storage and RX/TX samples; shared or fixed CPU/RAM policy; fixed storage volumes; automatic available-port allocation |
| **Multiple VPS nodes** | SSH-based worker installation, verified agent enrollment, per-node capabilities and server placement, connection/maintenance state and remote workspaces |
| **Operations** | Schedules with optional commands before backup/restart, explicit command outcomes, bounded activity/task history, task progress, scoped firewall tools, power controls and Admin host terminal |
| **Recovery** | Durable crash retry with bounded backoff, cancellation and visible recovery state; see [reliability](docs/RELIABILITY.md) |
| **Host preferences** | Verified VPS timezones, panel clocks and conservative reversible network profiles |
| **Trusted HTTPS** | Automatic public-IP certificates, immutable activation and renewal |
| **Panel updates** | Verified official stable releases; linked workers first and main panel last; source-only activation, per-VPS verification and manual recovery of interrupted requests |
| **Access & interface** | Admin/Operator/Viewer roles, per-server grants, TOTP and recovery codes, EN/VI, responsive navigation, saved themes and keyboard controls |

New Node.js/Python applications resolve the latest final stable runtime directly from the official project, then keep that exact pin. Creating another application never upgrades existing ones. The Node.js interpreter running the panel is managed separately. See [application behavior and limits](docs/applications.md).

Bedrock rules remain stored in their world after a normal restart; the panel reads them automatically instead of reactivating them. Add-on inventory stays visible while running, with separate configured/startup stacks and native-log validation. Importing an unused pack and exporting a running world do not require a restart. A custom pack proven unused by the ready process and every world can also be removed online. Changing active pack registration/priority or experiments still requires stopped Bedrock; experiments receive a verified backup before writing. See [world operations](docs/WORLDS.md).

CPU/RAM limits are usage ceilings, rather than hardware reservations. The main VPS keeps a ten-percent capacity budget; linked resource nodes use their effective capacity. Free-space, critical-memory and capability checks still apply. Ports are allocated and checked **per VPS**. See [resource and storage behavior](docs/OPERATIONS-090.md) and [port allocation](docs/PORTS-0155.md).

## Before you deploy

Vortex Panel is open source under the [MIT License](LICENSE). Local management,
linked VPS nodes and remote deployment are available without an activation key,
subscription or licensing service. Create your first Admin after installation
and connect the VPS nodes you want to manage. Third-party components retain
their own licenses; see [third-party notices](docs/THIRD_PARTY.md).

| Requirement | Details |
| --- | --- |
| **Host** | Ubuntu 22.04 or later, x86-64 or ARM64 (`aarch64`), matching 64-bit userspace, systemd, root/sudo access |
| **Connectivity** | Working HTTPS access to GitHub, Ubuntu repositories and the official runtime providers; `curl` and trusted CA certificates for the initial command |
| **Public setup** | A routable public IPv4 address and available web ports; see the installer guide for ownership checks and firewall boundaries |
| **Application isolation** | Working cgroup v2, namespace, Bubblewrap and storage capabilities reported by the selected node |
| **Python creation** | Capacity for a capped 1 GiB RAM build and temporary 3 GiB build volume, plus panel/runtime storage and admission overhead |

| Workload | x86-64 VPS | ARM64 VPS |
| --- | --- | --- |
| Panel and node agent | Native | Native |
| Node.js and Python applications | Native | Native |
| Official Minecraft Bedrock server | Native | Managed Box64 compatibility runtime (4 KiB kernel pages) |

An ARM64 main panel can manage both ARM64 and x86-64 workers. On ARM64 with 4 KiB kernel pages, the full release installer automatically installs a private, pinned Box64 runtime to run Mojang's x86-64 Bedrock server. Releases contain a native ARM64 engine built on Ubuntu 22.04 and checked by checksum, architecture and version; guest libraries are fetched from immutable, verified upstream source. Ordinary release installation does not compile Box64 on the VPS. No system-wide emulator or multiarch registration is installed. Run the full installer once on older ARM64 installations to prepare this runtime; a source-only update cannot install host dependencies. Bedrock creation, console, resource limits and world storage use the same panel controls on both architectures. Node.js and Python continue to run natively, and existing application runtime pins remain unchanged.

Use a fresh VPS for the automatic public setup. An existing web server or occupied port requires deliberate configuration; the installer does not take over unrelated services. Provider firewalls and NAT remain under your control. Minecraft game ports and application ports are separate from the panel's HTTPS endpoint.

## Start here

| Guide | Purpose |
| --- | --- |
| [Install & update](docs/INSTALL.md) | One command, first login, HTTPS, service modes and recovery |
| [Node.js & Python](docs/applications.md) | Runtime pins, startup, dependencies, environment and sandbox boundaries |
| [Nodes](docs/NODES.md) · [SSH provisioning](docs/NODE-PROVISIONING.md) | Add VPS capacity from the panel |
| [Worlds & recovery](docs/WORLDS.md) · [Online backups](docs/ONLINE-BACKUPS.md) | Protect, transfer and restore Minecraft data |
| [Operations](docs/OPERATIONS.md) | Whole-panel snapshots, service maintenance and recovery |
| [Panel updates](docs/PANEL-UPDATES.md) | Prepare a safe fleet update, understand progress and recover the existing request |
| [Workspace design](docs/DESIGN.md) | Navigation, keyboard controls, saved appearance and browser installation |
| [Server appearance](docs/SERVER-APPEARANCE.md) | Covers, icons, descriptions, accents and actual Bedrock listing text |
| [API](docs/API.md) | Management endpoints and authorization |
| [Release process](docs/publication.md) | Public source inventory, checksums and GitHub Actions |
| [Third-party attribution](docs/THIRD_PARTY.md) | Artwork, dependencies and upstream projects |

## Run from reviewed source

The supported runtime host is Ubuntu 22.04+ x86-64 or ARM64. The panel and agent require Node.js 22.23.4+ in major 22, 24.22.1+ in major 24, or 26.12.1+ in major 26. The installer prepares a verified private Node.js runtime when necessary; application runtimes keep their own saved versions. For manual setup from a reviewed checkout:

```bash
npm ci
npm run check
npm start
```

Follow the private setup token printed in the terminal to create the first Admin. The application listens on `127.0.0.1:3000` by default; use the [installation guide](docs/INSTALL.md) for a managed systemd service and HTTPS.

There is no frontend build step. Express serves the browser assets, WebSocket supplies live events, and metadata is stored with atomic JSON writes. `npm run package` builds the production source archive. Public source and release ZIPs contain the runtime, installation helpers, build scripts and operating documentation; local test tools and private runtime data are excluded.

Maintainers can publish through **Actions → Release → Run workflow** on `main`, supplying its matching `vX.Y.Z` tag. The workflow validates production source before creating a missing tag and publishing verified assets. See the [release guide](docs/publication.md).

## Operating boundaries

CI validates production source and package integrity on Ubuntu 22.04 and 24.04. These checks do not replace verifying a fresh installation, an upgrade, network reachability and your actual workloads on their target VPS.

Back up panel data and encryption keys off the host. For routine updates use **Settings → Panel administration → Check for updates**. Every managed server must be stopped and conflicting jobs finished; the updater does not stop workloads for you. It updates panel/agent source and dependencies, verifies workers before restarting the main panel, and keeps runtime pins and customer data. A source rollback cannot undo world/application changes or repair an incompatible metadata migration. Legacy agents without the update admission protocol need a one-time maintenance upgrade through their installer. The full installer remains a separate maintenance operation and may restart local workloads. See the [update guide](docs/PANEL-UPDATES.md).

Application file operations/backups require a stopped application, while Bedrock supports its documented online snapshot workflow. Review each guide's size and format limits before importing large worlds or projects. Featured-server artwork in Minecraft's own partner list is separate from Vortex's private panel appearance; ordinary Bedrock listings expose the supported server text, not uploaded panel banners.

Report reproducible problems through [GitHub Issues](https://github.com/hovansi/vortex-panel/issues), including the panel version, Ubuntu version and redacted logs. Keep passwords, setup tokens, node credentials, session cookies and private files out of public reports.


Host operations: [process recovery](docs/RELIABILITY.md), [VPS timezone](docs/TIMEZONE.md), [reversible network tuning](docs/NETWORK-TUNING.md), and [trusted IP HTTPS / renewal](docs/HTTPS.md).
