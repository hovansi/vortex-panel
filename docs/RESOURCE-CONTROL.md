# Per-server CPU and memory limits

`server/resource-control.js` implements optional kernel limits for managed Bedrock processes. `resourcePolicy` belongs to panel metadata, not `server.properties`.

```json
{ "mode": "shared", "cpuCores": null, "memoryMiB": null }
```

Shared mode keeps native process and console behavior without a separately configured fixed allocation. On a delegated host, shared instances belong to the managed resource pool and share its aggregate ceiling. Host and ancestor limits still apply; shared mode does not promise exclusive hardware capacity.

```json
{ "mode": "fixed", "cpuCores": 0.75, "memoryMiB": 1024 }
```

Fixed mode sets a CPU-time ceiling and a memory ceiling. It does not reserve capacity, pin CPU affinity, or guarantee that the host has that much free memory. Admission is assessed separately against the selected VPS capacity; a configured ceiling is not an exclusive reservation. CPU values are measured in logical cores: `1` permits up to one core of CPU time; `0.75` permits up to 75% of one core. The kernel applies a 100,000 microsecond period, so this example writes `75000 100000` to `cpu.max`.

Memory is expressed in MiB (1,048,576 bytes). The example writes `1073741824` to `memory.max`, sets `memory.swap.max=0`, and enables `memory.oom.group=1`. The memory controller accounts for the group's memory, including applicable filesystem cache; it is not merely the native process RSS. Under memory pressure the kernel can kill the server, and the existing automatic restart policy may restart it. Memory/OOM counters provide evidence; a ceiling is not a stability promise.

Validation accepts CPU values from 0.10 to the host CPU count in steps of 0.01, and integer memory values from 256 MiB to the host's total memory in MiB. Unknown fields, strings in numeric fields, out-of-range values and fixed values in shared mode are rejected. More restrictive ancestor limits may apply.

## Linux and systemd setup

Fixed limits require a writable unified cgroup v2 mount, CPU and memory controllers, and a delegated systemd service whose MainPID is the panel process. Ubuntu 22.04 and later with the normal systemd service are the primary target. Unsupported platforms or configurations expose an explicit unavailable reason and keep shared mode usable; fixed mode never silently becomes shared mode.

The installer writes the required delegation directive directly into the managed service unit. For an existing manual installation, `deploy/resource-control.conf` may instead be copied to `/etc/systemd/system/vortex-panel.service.d/resource-control.conf`, followed by a service reload/restart. The required directive is:

```ini
[Service]
Delegate=cpu memory
```

Controller initialization must run before any native Bedrock or host-terminal child is started. It identifies the owning service through systemd's D-Bus API, verifies MainPID and the delegated subtree, moves only the panel into an unlimited `vortex-panel` leaf, then enables the CPU and memory controllers. Unexpected existing direct processes cause a safe refusal; the module does not migrate foreign processes.

Each managed launch gets an owned UUID-named group within the managed pool when available. The pool's effective CPU/RAM ceiling is derived from host/ancestor limits and the selected node's reserve policy. The panel stays in its separate manager leaf. Existing configured server ceilings can exceed a reduced pool ceiling; the API distinguishes configured and effective limits, and admission blocks new over-allocation.

## Launch and lifecycle contract

1. `initialize()` returns support metadata even when fixed mode is unavailable.
2. `capabilities()` exposes supported modes, validated UI bounds, an unavailable reason, and `limitsAreReservations=false`.
3. `prepare(serverId, policy)` writes and reads back all four kernel controls before any child is spawned.
4. `handle.spawn(executable, options)` returns `{ child, ready }` immediately. The manager must register native stdout/stderr and close handlers before awaiting `ready`.
5. The fixed launcher starts a small Bash wrapper with positional arguments. The wrapper attaches its own PID, checks its kernel membership and all limits, acknowledges on a separate fourth pipe, closes that pipe, then `exec`s the native executable. No Bedrock code executes before successful attachment. `exec` preserves PID, stdin and native output pipes.
6. `ready` resolves with effective enforcement only after the acknowledgement matches the owned PID. Attach failure, invalid acknowledgement, premature exit or timeout rejects readiness; there is no unbounded fallback launch.
7. `stats()` reads kernel CPU throttling, memory usage/peak where available, memory limit events and OOM counters. After cleanup, its last sample is historical, not live usage.
8. `cleanup()` refuses while the direct child is alive. After it closes, only the inode-verified group belonging to that launch can be killed to remove remaining descendants, then removed with `rmdir`. Replacement groups and failed cleanup remain explicit. There is no recursive deletion of arbitrary cgroups. The live effective handle becomes unapplied after removal.

Policy changes must require the server to be stopped; clone must inherit the normalized configured policy. Stop, backup and restore must preserve the policy and server identity. The manager owns persistent validation/audit rollback, lifecycle status, crash limits and HTTP permissions; this module owns kernel setup and process gating.

Resource-control notices support English and Vietnamese. Machine fields, UUIDs, quota numbers, cgroup paths and counters remain unchanged.

Primary references: [Linux cgroup v2 interfaces](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html), [systemd delegation and ownership rules](https://systemd.io/CGROUP_DELEGATION/), [systemd resource-control documentation source](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml).
