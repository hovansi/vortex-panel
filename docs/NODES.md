# Vortex Panel Nodes

Nodes let one Vortex control panel manage Minecraft Bedrock servers and Node.js/Python applications on several Ubuntu VPS machines. The panel's own machine remains **Local**. Existing local server IDs, files, settings and ports are not migrated when Nodes is enabled.

## Connect a VPS

Open **Nodes → Connect a VPS** as an administrator. Enter the VPS address, SSH port, root username and either a password or private key. Check the displayed SSH fingerprint against a trusted record, then choose **Trust key & check SSH**. The first discovery request sends no SSH authentication. A changed key is rejected before credentials are sent.

The authenticated check reports Ubuntu version, architecture, memory, free space and any existing agent. Choose the node name, location, public game address and agent TCP port, then install. The panel uploads its source over SFTP, verifies SHA-256, runs the Ubuntu installer and verifies the agent's HTTPS identity before linking it. Upload percentage comes from transferred bytes; the overall setup percentage represents workflow stages. A job reaches 100% only after a healthy link is stored. Close and reopen the progress dialog from Notifications while setup continues.

SSH secrets stay in the active operation's memory and are cleared after it finishes; they are not saved in job history or browser storage. The resulting agent token is encrypted separately as described below. An active UFW firewall receives a rule limited to the controller's observed SSH source IP and the selected agent TCP port. Cloud firewall policies and game ports may still need configuration. No firewall is disabled.

An existing healthy agent can be linked again without reinstalling it or changing its identity. An unhealthy existing installation is preserved for review. Up to two setup jobs may run together; history retains the last 20 finished jobs. Restarting the controller interrupts its setup tracking; a detached installer may continue on the VPS. Check the host again before retrying. Failed setup records a private recovery-log path rather than exposing installer output or credentials.

### Manual installation

1. Open **Nodes → Install node agent** as an administrator and download the authenticated agent source bundle. Copy and extract it on the target Ubuntu 22.04+ x86-64 or ARM64 (`aarch64`) VPS with matching 64-bit userspace.
2. Run `sudo bash deploy/install-node.sh --endpoint https://YOUR_VPS_IP:8443` there. The installer creates a separate `vortex-node.service`, private configuration, TLS key/certificate and data directory. It leaves the control panel service/data separate.
3. The target VPS terminal intentionally prints a private connection record: endpoint, token, certificate SHA-256 fingerprint and agent identity. Keep the token private. Allow the central panel to reach TCP 8443; game ports must also be allowed for players. Prefer restricting agent traffic to the panel's IP or a private VPN.
4. Back in **Nodes → Add node**, enter its name, endpoint, game/public address, optional location, token and exact fingerprint. The panel verifies the TLS connection, credential and agent identity before storing the link.
5. Choose this node in **Create server**. Its own version catalog, resource capabilities and occupied ports determine the available choices. Players connect to the selected node's game address and server port.

The panel, agent and Node.js/Python applications run natively on both architectures. ARM64 agents with 4 KiB kernel pages also run the official x86-64 Linux Bedrock server through a private Box64 runtime prepared automatically by the full agent installer. Older ARM64 agents need that installer once before creating Bedrock servers; source-only updates preserve host runtime installation. The main panel uses the capability reported and verified by each worker.

The default agent uses a self-signed certificate pinned explicitly by SHA-256, so a domain is optional. A certificate trusted by the operating system can instead use normal CA validation without a pin. The certificate's validity period is checked in both cases. Certificate replacement requires intentionally updating the pin. See [agent configuration and renewal](NODE-AGENT.md).

HTTP is refused for external nodes; literal loopback HTTP exists for local development. Browsers send all management requests to the panel, which forwards only permitted API routes. They do not need direct HTTPS access to the node or possession of its token.

## Server management

Console, lifecycle, configuration, CPU/RAM caps, gamerules, players, file editing/transfers/archives, packs, worlds, backups and schedules use the same per-server workspaces for remote servers. Their files, Bedrock processes, downloaded packages and backup archives remain on the assigned node. Uploads and downloads stream through the panel with backpressure and cancellation.

As an Admin, open **Configuration → Network access** after saving port changes. Preview the derived game ports, then explicitly apply rules when UFW is active. Vortex keeps scoped rules for this server and reconciles its obsolete rules; it preserves foreign rules and never enables/reset UFW or changes SSH/web policy. **Remove Vortex rules** removes only these scoped rules, which can be useful before deleting a server. Provider firewalls and NAT remain separate. See [network access API](API.md) and the UFW notes in [NODE-AGENT](NODE-AGENT.md).

Server IDs are globally stable: local IDs keep their UUID; remote IDs use `nodeUUID:serverUUID`. Job, schedule and activity identities are also namespaced. An identical raw UUID on two nodes therefore refers to two distinct resources. Player connection IDs, world revisions, pack UUIDs and server-scoped backup IDs retain their native meanings.

Viewer/Operator/Admin grants apply to these global IDs at the panel and to the corresponding raw IDs at the agent. An operator cannot create/delete/clone servers or administer node links. Viewer identity-key and private world/backup export restrictions remain enforced. Agent credentials are not returned by Nodes APIs or dashboard responses.

CPU/RAM controls are usage ceilings applied by the selected VPS. They do not reserve dedicated hardware. Only the main VPS running the panel retains a ten-percent capacity budget. Linked resource VPS machines use their full effective capacity without that percentage deduction; physical free-space checks and critical-memory checks still apply. Shared resources remain optional. Ports are checked within a VPS, allowing the same game port number on different machines. Cloning remains on the source VPS; moving an existing world to another machine is a separate data migration, not an effect of editing VPS metadata.

The automatic installer enrolls a resource worker with an authenticated control API. Its release excludes the panel entry point, account setup and browser interface. It installs and verifies the Bedrock, archive, storage, process and network tools before activating the candidate service. Existing VPS firewall policy is preserved; installation does not enable/reset UFW or change global kernel settings. New enrollment firewall allowances carry an exact worker ownership receipt; pre-existing allowances are not relabeled. New private Node runtimes and release files receive installer ownership records; older shared runtimes are retained.

“Uninstall Vortex from VPS” opens an inspection and confirmation workflow. It requires an empty worker inventory, administrative re-authentication, the exact VPS name and fresh pinned SSH root credentials. Move or remove game servers first; the workflow never silently deletes worlds. The VPS remains linked during cleanup and after uncertain/partial results. It is removed only after independent SSH verification. Shared or unproven legacy files/tools and separate panel installations are explicitly retained; this is verified worker removal, not an OS reinstall. See [worker maintenance](OPERATIONS.md#worker-maintenance).

## Connection status and maintenance

Nodes show their host CPU, memory, storage, agent version, latest observation, connection status and server count. Samples from an offline node are labeled stale/last known. The panel retains its last inventory, reports server runtime as unknown and does not claim those processes stopped.

Maintenance prevents new creation/cloning on a node. Existing servers can still be managed. Disconnecting a node link requires a reachable empty inventory and never deletes data or stops a remote service implicitly.

The agent owns native processes and schedules. Closing/restarting the central panel stops only its connections to other nodes. Remote Bedrock instances and schedules continue. Restarting the agent itself follows the existing Bedrock manager's graceful-stop/resume behavior.

Mutating requests are never automatically retried after an ambiguous network failure. If a connection is lost after submission, the action may have completed. Reconnect, refresh server/job state, then decide whether to retry. This also applies to create, restore and import operations.

## Data and recovery

The control panel stores linked-node metadata and a compact offline server inventory in `panel.json`. Tokens are encrypted with AES-256-GCM and per-node authenticated context; their separate 32-byte `.node-key` must be backed up with panel data. Losing that key requires reconnecting nodes with their tokens. Existing TOTP encryption and `.mfa-key` are independent.

Live histories, samples and event connections are bounded; polling does not append an audit event each time. The compact inventory is persisted after structural changes and at most once per minute for heartbeat timestamps. Each agent applies the panel's managed log-retention policy to its own data. Node data and `.node-key` are excluded from source ZIPs.

## Design references

- [Pterodactyl's panel/node/daemon separation](https://docs.pterodactyl.io/v2/project/how-it-works): a node runs its own game servers and clients connect to assigned game ports. Vortex retains its native Bedrock runtime rather than adopting Wings or Docker.
- [Node 22 TLS](https://nodejs.org/docs/latest-v22.x/api/tls.html): validate the peer before sending the agent credential; use normal CA trust or an explicitly pinned certificate.
- [ssh2](https://github.com/mscdex/ssh2): verify SSH host keys before authentication, use SFTP for source transfer, and keep remote commands separate from credentials.
- [Node stream backpressure](https://nodejs.org/docs/latest-v22.x/api/stream.html): transfers are streamed and canceled when their destination disconnects.
- [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html): delegation and actual process quotas belong to each node's service.
