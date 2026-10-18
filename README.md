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

**Minecraft worlds. Application runtimes. Your own infrastructure.**

Vortex Panel is a Node.js control panel for **Minecraft Bedrock, Node.js and Python** on Ubuntu. Manage local servers and linked VPS nodes through one responsive workspace: live console, files, backups, resource limits and everyday administration. The interface combines soft glass surfaces, voxel artwork and purposeful motion, with light/dark themes and **English / Tiếng Việt**. English is the default.

Created by **@hovansi** · Maintained at [hovansi/vortex-panel](https://github.com/hovansi/vortex-panel).

## Install with one command

On an **Ubuntu 22.04+ x86_64 VPS with systemd**, run:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh | sudo bash
```

The release installer resolves the latest stable Vortex release, checks its source archive, installs dependencies and starts the systemd service. A fresh installation also prepares HTTPS access on the VPS's public IP. Follow the URL and first-Admin setup instructions printed at completion. IP HTTPS initially uses a self-signed certificate, so the browser will require you to trust that certificate; no account or shared default password is created for you.

The one-command path enables root host administration on a fresh installation. Node.js/Python application code runs under its own non-root account and sandbox. Existing installations retain their configuration. Read the [installation guide](docs/INSTALL.md) for requirements, certificate trust, updates and the local-only alternative.

## A workspace that follows the workload

| Area | What you can manage |
| --- | --- |
| **Minecraft Bedrock** | Official stable/preview discovery, searchable version history, console, world settings and gamerules, coordinates, players, permissions, allowlist, add-ons and world import/export |
| **Node.js & Python** | Latest official stable runtime pinned at creation, entry file/npm script/Python module startup, dependency tasks, project inspection and secret environment variables |
| **Files & recovery** | Upload, download, edit with conflict detection, copy, move, rename, ZIP/extract, per-server backups, retention and restore |
| **Resources & ports** | Live CPU, RAM, storage and RX/TX samples; shared or fixed CPU/RAM policy; fixed storage volumes; automatic available-port allocation |
| **Multiple VPS nodes** | SSH-based worker installation, verified agent enrollment, per-node capabilities and server placement, connection/maintenance state and remote workspaces |
| **Operations** | Schedules, bounded activity/task history, progress dialogs with task IDs and output, scoped firewall tools, service power controls and Admin host terminal |
| **Access & interface** | Admin/Operator/Viewer roles, per-server grants, TOTP and recovery codes, EN/VI, responsive navigation, saved themes and keyboard controls |

New Node.js/Python applications resolve the latest final stable runtime directly from the official project, then keep that exact pin. Creating another application never upgrades existing ones. The Node.js interpreter running the panel is managed separately. See [application behavior and limits](docs/applications.md).

CPU/RAM limits are usage ceilings, rather than hardware reservations. The main VPS keeps a ten-percent capacity budget; linked resource nodes use their effective capacity. Free-space, critical-memory and capability checks still apply. Ports are allocated and checked **per VPS**. See [resource and storage behavior](docs/OPERATIONS-090.md) and [port allocation](docs/PORTS-0155.md).

## Before you deploy

| Requirement | Details |
| --- | --- |
| **Host** | Ubuntu 22.04 or later, x86_64, systemd, root/sudo access |
| **Connectivity** | Working HTTPS access to GitHub, Ubuntu repositories and the official runtime providers; `curl` and trusted CA certificates for the initial command |
| **Public setup** | A routable public IPv4 address and available web ports; see the installer guide for ownership checks and firewall boundaries |
| **Application isolation** | Working cgroup v2, namespace, Bubblewrap and storage capabilities reported by the selected node |
| **Python creation** | Capacity for a capped 1 GiB RAM build and temporary 3 GiB build volume, plus panel/runtime storage and admission overhead |

Use a fresh VPS for the automatic public setup. An existing web server or occupied port requires deliberate configuration; the installer does not take over unrelated services. Provider firewalls and NAT remain under your control. Minecraft game ports and application ports are separate from the panel's HTTPS endpoint.

## Start here

| Guide | Purpose |
| --- | --- |
| [Install & update](docs/INSTALL.md) | One command, first login, HTTPS, service modes and recovery |
| [Node.js & Python](docs/applications.md) | Runtime pins, startup, dependencies, environment and sandbox boundaries |
| [Nodes](docs/NODES.md) · [SSH provisioning](docs/NODE-PROVISIONING.md) | Add VPS capacity from the panel |
| [Worlds & recovery](docs/WORLDS.md) · [Online backups](docs/ONLINE-BACKUPS.md) | Protect, transfer and restore Minecraft data |
| [Operations](docs/OPERATIONS.md) | Whole-panel snapshots, service maintenance and recovery |
| [API](docs/API.md) | Management endpoints and authorization |
| [Release process](docs/publication.md) | Public source inventory, checksums and GitHub Actions |
| [Third-party attribution](docs/THIRD_PARTY.md) | Artwork, dependencies and upstream projects |

## Run from reviewed source

The supported runtime host is Ubuntu 22.04+ x86_64 with Node.js 22 or later. For manual setup from a reviewed checkout:

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

Back up panel data and encryption keys off the host. Source updates can restart the service and local workloads; a source rollback does not undo world or application data changes. Application file operations/backups require a stopped application, while Bedrock supports its documented online snapshot workflow. Review each guide's size and format limits before importing large worlds or projects.

Report reproducible problems through [GitHub Issues](https://github.com/hovansi/vortex-panel/issues), including the panel version, Ubuntu version and redacted logs. Keep passwords, setup tokens, node credentials, session cookies and private files out of public reports.
