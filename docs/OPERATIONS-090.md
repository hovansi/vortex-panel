# Vortex Panel 0.9.0: telemetry, admission and bounded storage

## What the measurements mean

The dashboard and node snapshots sample approximately every five seconds. A slow observation is coalesced rather than overlapped; this is monitoring, not a hard real-time guarantee. Host sampling also keeps a short 500 ms cache so simultaneous requests do not destroy the CPU/network delta interval.

| Reading | Source and scope |
| --- | --- |
| Host CPU | Linux `/proc/stat`, all logical CPUs visible to the host. `usedCores` is busy percentage multiplied by logical CPU count. Guest time is not added twice. |
| Host RAM | `/proc/meminfo`: used = `MemTotal - MemAvailable`. Available includes the kernel's estimate of reclaimable memory; free RAM is reported separately. |
| Host storage | `statfs(DATA_DIR)`: used excludes free filesystem blocks; available excludes reserved blocks. Both free and available are exposed. This is the filesystem containing the data directory. |
| Host network | `/proc/net/dev` for default-route interfaces; physical-device fallback if no default route is visible. Loopback and duplicate virtual layers are excluded. Counts include other applications on the VPS. |
| Server CPU/RAM | Cgroup CPU deltas and charged memory, including file cache, when the kernel controller is available; otherwise native process CPU and resident memory. Admission credits anonymous memory separately because MemAvailable already accounts for reclaimable cache. |
| Server network | Optional Linux nftables counters matching the reserved game ports. These are layer-three ingress/egress bytes, including protocol overhead and other traffic using those ports. They are **not** application payload bytes or strict process attribution. |
| Fixed server storage | Verified owned ext4 loop mount, sampled about every five seconds. The filesystem's own metadata consumes part of the configured image size. |
| Legacy server storage | Real directory usage (`du --one-file-system`), cached for up to five seconds. It has no hard quota. |

The first CPU/network rate is `null` until there are two valid observations. Counter resets, interface changes, unavailable tools and permission failures must not become fabricated zero rates. Offline node usage is explicitly unavailable; the last observation time remains visible. Per-server network samples older than ten seconds are marked stale.

The nftables meter owns one UUID-named `inet` table, with a private identity file in the data directory. It uses input/output counter rules and pass-through chain policies; it does not open ports, change UFW, or add accept/drop verdict rules. Port changes reset only the affected server's counters and expose `resetAt`. Cleanup verifies the exact table owner, selectors and counter references before deletion. Missing nftables or kernel permission makes accounting unavailable. Ordinary unit-test workers suppress the default real nft runner; explicit injected fixtures and separately authorized Linux acceptance do not claim that simulated counters are kernel proof.

## Allocation is separate from live consumption

Admission leaves a ten-percent CPU, RAM and physical-disk budget only on the main host running the control panel. Linked worker hosts set `reserveRatio: 0` consistently for admission, start headroom, dashboard reporting and the aggregate runtime resource pool. Workers therefore expose their full effective capacity, while physical free-space checks, critical observed RAM headroom and narrower provider/ancestor limits still apply. The managed resource pool caps the aggregate server subtree; the management service stays outside that pool. These controls do not guarantee the VPS cannot run out of resources: unrelated applications and privileged administrators remain outside the panel's allocation accounting.

Fixed CPU/RAM ceilings count against admission even while a server is stopped. Shared servers carry a minimum accounting credit of **0.1 core and 512 MiB**. That credit is not an exclusive reservation or an individual shared-server ceiling; shared instances can use the managed pool subject to its aggregate limits.

Create, clone, resource changes and storage growth pass through a serialized admission gate. Each assessment refreshes physical disk availability and available memory. Pending volume/package/upload workspaces also count, so parallel requests cannot spend the same remaining budget. Rejected requests do not activate configuration files. Failed durable configuration commits restore the prior metadata and properties.

Existing configured limits are preserved during upgrades. An older fixed server configured above the new pool budget can still launch inside the narrower parent cgroup; configured and effective limits differ explicitly. Its unchanged policy and data remain intact. Overcommitted allocation blocks new requests until capacity is available or the administrator lowers the policy. Ordinary name/message edits remain possible.

Uncached official packages reserve up to **3 GiB** of workspace for a bounded download and unpack operation. Cached versions need only their new server volume budget. Multipart uploads reserve their bounded host workspace before parsing when staged outside a fixed volume, and release it on errors, completion or caller abort. Fixed-server uploads stage inside that server's own mounted storage.

## Fixed ext4 volumes

New native servers use fully preallocated ext4 images. The whole server root is mounted, keeping runtime files, worlds, backups, logs and transaction staging on one bounded filesystem. This lets normal root-run Bedrock and panel writers encounter a real filesystem boundary; the panel does not rely on root-bypassable project-quota promises. Mounts use `nodev,nosuid,noinit_itable,nodiscard`, and ownership/loop backing image/filesystem identity are checked before use.

Existing ordinary directories remain legacy unlimited directories. Reading or changing unrelated settings does not migrate them or impose a new image. There is no automatic destructive conversion.

Growth is stopped-server-only and can only increase size. The desired larger policy is durably queued before in-place allocation/filesystem growth. Because growth cannot be reversed by shrinking, an interrupted job may leave desired and actual sizes different. The API reports actual size and growth state; start remains blocked while actual storage is too small. Retrying the same desired size is supported and reassesses the physical bytes still needed. Failed or uncertain images/records are retained for recovery.

The 0.9.1 growth correction addresses an observed delayed allocation failure: default resize2fs can defer inode-table initialization until after mount, and loop-device zeroing may then unmap backing-image blocks. Growth now forces synchronous table initialization, disables libext2fs zeroout optimization for that child process, explicitly checks without discard, and rechecks physical allocation after resizing. The owned mount disables deferred inode initialization and discard. Explicit same-size repair also unmounts before reserving missing blocks; ordinary reads and starts never silently allocate them. Regression acceptance must inspect allocation again after the background interval, not only when the resize command exits.

Growth and deletion exclude conflicting lifecycle/file operations. Console disk writes are paused and drained during unmount windows; usage reads must not claim a live mounted quota during maintenance. Recursive deletion refuses a directory containing the same or a descendant mount, and checks again before cleaning a quarantined tree. No forced or lazy unmount is used.

## Consistent backups with mounted volumes

`deploy/backup-panel.sh` stops the service, owns the private `panel.lock`, and invokes:

```sh
node server/storage-cli.js unmount-all --data-dir "$DATA_PATH" --receipt "$RECEIPT" --lock-owner-pid "$$"
# Archive the stopped data, including private image files and volume records.
node server/storage-cli.js mount-all --data-dir "$DATA_PATH" --receipt "$RECEIPT" --lock-owner-pid "$$"
```

Invoke these directly from the backup parent shell, not through command substitution. The CLI verifies that its direct parent owns the exact `backup-*` lock, checks the stopped inventory hash and rejects active native Bedrock processes under that data scope. It does not create a store, rewrite `panel.json`, remove the lock, or alter credentials.

Before the first unmount, an exclusive mode-0600 receipt outside the data tree records the original mounted IDs, data/lock identities and inventory hash. Only those original mounts are restored. A partial failure attempts recovery and retains a retryable receipt. The backup trap must remount before removing the lock and restarting the service, including after a failed unmount or archive. A failed restore must be reported and its receipt preserved. Fixed images are archived unmounted; copying the mounted tree as well would duplicate data and lose consistency.

## Names and approximate location

The controller is displayed as **Vortex Main**. Omitting a new node name allocates **Vortex Node 001**, then 002 and so on. The counter is atomically persisted before asynchronous enrollment and is never reduced when a node is unlinked. Failed enrollment can leave a gap. Existing custom labels are preserved; the exact previous generated label `Vortex Node 02` receives the approved migration to `Vortex Node 001` when that label is free.

Automatic location uses the fixed HTTPS `ipwho.is` endpoint for the host's own egress IP, with a 1.5-second timeout and 32 KiB response limit. Only country, region, city and timezone metadata are retained; no account, token or hostname is sent. Successful observations are cached for a day, failures retry after an hour, and dashboard requests never wait for lookup completion. Set **`VORTEX_GEOLOCATION=off`** to disable it. Provider failure produces unknown location, never a guessed country. IP location is approximate and may describe a provider gateway rather than the machine's physical site; an existing manual location takes precedence.

Version catalog availability is also evidence-based: historical entries can be listed without a verified reachable download. A successfully imported official package clears stale availability/verification errors for that selected node only. Seeing a version row is not a claim that Mojang still serves its archive.

## Primary references

- [Linux `/proc` CPU and memory interfaces](https://docs.kernel.org/filesystems/proc.html)
- [Linux interface statistics and byte-counter scope](https://docs.kernel.org/networking/statistics.html)
- [Linux cgroup v2 CPU and memory controllers](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [resize2fs inode-table initialization implementation](https://github.com/tytso/e2fsprogs/blob/v1.47.0/resize/resize2fs.c)
- [Linux loop-device zeroing and discard implementation](https://github.com/torvalds/linux/blob/v6.8/drivers/block/loop.c)
- [nftables counter semantics](https://wiki.nftables.org/wiki-nftables/index.php/Counters)
- [nftables hook ordering](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks)
- [nftables supported JSON schema](https://manpages.debian.org/testing/libnftables1/libnftables-json.5.en.html)
- [IPWhois provider API, fields, HTTPS and limits](https://ipwhois.io/documentation)
