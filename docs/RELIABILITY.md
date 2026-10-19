# Process recovery

Vortex tracks the owned Bedrock, Node.js and Python process separately from the
panel service. A running label requires Bedrock's startup confirmation or the
application's configured readiness check. Bedrock has a 90-second readiness
deadline; applications have a 30-second deadline. A process that does not become
ready is terminated and reported as a startup failure.

## Automatic recovery

With **Restart after crash** enabled, an unexpected process exit schedules a
replacement after 2, 4, 8, 16 and 32 seconds. Failed replacement launches also
spend this budget. After five retries within ten minutes, recovery pauses until
an administrator fixes the reported failure and starts the server manually.
The console and server recovery status show the retry deadline or paused state.

Recent failures and a pending retry survive a panel restart. A paused budget
cannot be bypassed by restarting the panel or enabling automatic startup.
A manual Start or Restart resets the recovery budget. Manual Stop and Kill
cancel pending recovery. Disabling **Restart after crash** also cancels a
pending retry. System maintenance holds recovery without spending another
attempt; an uninstall or update does not launch workloads during maintenance.

On panel startup, a server whose last saved state was running or starting is
resumed after the old managed processes have been cleaned up. A saved manual
stopping/stopped state does not request recovery. **Start with panel** remains a
separate setting for intentionally starting an otherwise stopped server.

## Diagnostics and limits

An enforced memory-limit exit retains the verified cgroup OOM counters and the
configured memory limit. Recovery uses the same configuration and runtime pin;
it does not increase resource limits or change application versions. Fix an
underlying memory shortage, invalid configuration, port conflict or broken
add-on before repeatedly starting the workload.

`Content logging to console is disabled` is a Bedrock diagnostics notice. It
means content/add-on loading messages are hidden from the console; it does not
mean the world has failed to start. New installs enable
`content-log-console-output-enabled` when the official package provides that
property. Existing servers and upgrades keep the administrator's chosen value.

The panel service uses systemd's process supervision. Its restart policy and
control-group cleanup are separate from workload recovery. See the official
[systemd service documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [process termination documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).

Recovery handles process exits and readiness failures. It cannot guarantee
continuous availability during host failure, disk corruption, an upstream
network outage or a process that remains alive while its game/application
logic is unresponsive. Keep independent backups and monitor the host as well
as the panel.
