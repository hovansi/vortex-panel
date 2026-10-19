# VPS and panel timezone

Administrators can change a VPS timezone from **System → VPS timezone** or the
linked VPS details. Search for an installed IANA timezone, such as
`Asia/Ho_Chi_Minh`, review the selected value and confirm the change.

The main VPS timezone controls the panel's displayed times. A linked VPS can
have a different operating-system timezone without changing the main panel's
clock. The browser caches the last confirmed main timezone to avoid briefly
displaying dates in its own local timezone during page reloads. A fresh main VPS
observation remains authoritative.

The operation uses `timedatectl set-timezone` on Linux with systemd, running as
root. Only timezone names returned by that VPS's installed `timedatectl
list-timezones` are accepted. The current timezone alias is also preserved as a
selectable value. There is no arbitrary shell command, file path, clock-setting,
RTC or NTP input in this API.

Changing the timezone does not change the system clock, saved UTC timestamps or
existing interval schedules. A schedule set to run every 360 minutes still runs
at that interval; its next-run label is displayed in the new main timezone.
Vortex does not restart game or application servers for a timezone change.
Processes that already run can keep their previous timezone until their next
normal restart. Native output already written by a game or application is
preserved verbatim; only the panel's own timestamp labels are formatted.

Each confirmed change records an intent in the panel activity history and a
private `timezone-operations.json` journal before calling the operating system.
The journal retains the original timezone, requested value, operation ID and
verified result. Repeating the same operation ID never repeats the system
command. A stale form must be reopened before it can change a newer OS state.
The journal is bounded: at most 128 requests per panel process generation, plus
32 older records. If that generation reaches its limit, restart the Vortex
service before requesting another timezone change.

If a command times out or verification fails, Vortex reports an unknown result
and does not retry the change automatically. Reopen the timezone dialog to check
the actual state. An interrupted request is reconciled as complete only when
the requested OS timezone is independently observed. If it cannot be verified,
review the managed service journal before further changes. A damaged private
journal blocks additional timezone changes rather than discarding its history.

References: [systemd timedatectl](https://www.freedesktop.org/software/systemd/man/latest/timedatectl.html)
and [Node.js TZ environment variable](https://nodejs.org/api/cli.html#tz).
