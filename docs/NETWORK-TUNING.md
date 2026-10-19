# Host network profile

The installer applies a small capability-detected profile to the panel host and each newly provisioned worker. Unsupported or read-only kernel settings produce an explicit warning; they do not prevent the panel installation. Administrators can inspect the actual values, review proposed changes and restore the owned settings in panel administration. This feature does not restart a VPS or managed server.

The profile raises `net.core.rmem_max` and `net.core.wmem_max` to **4 MiB** only when the current ceilings are smaller. Larger ceilings and explicitly configured administrator settings are preserved. These are per-socket ceilings, not preallocated memory. Applications must request an appropriate socket buffer to benefit; increasing a ceiling does not prove a latency improvement. Default socket allocations and TCP/UDP global memory accounting are unchanged. The [Linux kernel socket buffer documentation](https://docs.kernel.org/admin-guide/sysctl/net.html) describes the distinction between default and maximum values.

For TCP, the helper chooses `bbr` only when the running kernel already advertises it and the existing algorithm is `cubic` or `reno`. It does not load modules, download kernel code or replace a custom congestion controller. A legacy `pfifo_fast` default queue may become `fq` when BBR is selected; existing `fq_codel`, custom queues and all live interface queues are preserved. A default queue setting affects newly created queues; virtual interfaces can ignore it. See the [kernel default queue documentation](https://docs.kernel.org/admin-guide/sysctl/net.html#default-qdisc) and [TCP congestion control documentation](https://docs.kernel.org/networking/ip-sysctl.html#tcp-variables).

Minecraft Bedrock gameplay uses UDP. TCP congestion control does not optimize UDP gameplay or remove the physical propagation delay between the US and Vietnam. A VPS near the players and an uncongested route generally matter more. Vortex does not report an estimated ping reduction as a measured result. MTU, routing, IPv6, firewall rules, busy polling and active interface queue configuration are deliberately outside this profile.

## Ownership and restoration

The panel owns `/etc/sysctl.d/70-vortex-panel-network.conf` and records original values in root-private `/etc/vortex-panel/network-tuning.json`. Workers use the corresponding `vortex-node` paths. The state is tied to `/etc/machine-id`. The original values are written durably before any sysctl change. Apply is idempotent, bounded to four allowlisted keys, protected by a host lock, and verifies each kernel write. A failed application rolls back values still equal to its own attempted settings. Interrupted or ambiguous operations remain visible for review.

Explicit values in `/etc/sysctl.conf`, `/etc/sysctl.d` or `/run/sysctl.d` are preserved. An existing foreign profile at the owned filename is never adopted or overwritten. Symlinks and untrusted ownership are rejected. An edited owned profile blocks automated restoration rather than deleting administrator content.

Restoration removes only the byte-identical owned persistent profile. An individual runtime value is restored only if it still equals the value applied by Vortex. Later administrator changes are retained and listed in the result. Uninstallation restores this profile before deleting the source and private state. A profile modified by an administrator requires review before full removal can claim success. No system-wide `sysctl --system` or `tc qdisc replace` is executed.

## Root maintenance commands

Use the source directory that belongs to the installed role. For the main panel:

```sh
sudo python3 /opt/vortex-panel/current/server/host-network-tuning.py inspect --role panel
sudo python3 /opt/vortex-panel/current/server/host-network-tuning.py apply-auto --role panel
sudo python3 /opt/vortex-panel/current/server/host-network-tuning.py restore-owned --role panel
```

Worker installations use `/opt/vortex-node/current/server/host-network-tuning.py` if their current-release layout provides it, or the installed agent source directory, and `--role worker`. `inspect` is read-only. `apply-auto` is intended for installer/root maintenance; browser changes require a freshly reviewed revision and explicit confirmation. No alternate filesystem root is accepted by the command line.
