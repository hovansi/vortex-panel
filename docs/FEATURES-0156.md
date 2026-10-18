# Task evidence, world controls and managed application runtimes

## Tasks

The task result dialog shows the full opaque task ID with a copy control, operation, server/node identity and separate created/started/finished times when reported. Older task records may have no actual start time. One progress surface follows the accepted job; acceptance is not completion. Terminal, interrupted and uncertain outcomes remain distinct.

New jobs retain at most 16 phase changes and 200 output lines / 64 KiB of output. Application secret values are redacted before retention. The native output is not translated. Installation results identify the installed version and assigned port; dependency tasks report their concrete result. Existing activity/job retention policies still apply to these records.

## Minecraft world controls

World settings are reachable from the console and configuration workspace. The 33-rule catalog is organized into display, survival, environment, mobs, building and advanced groups in English and Vietnamese. Coordinates and Keep inventory are easy to find. The native Bedrock process is the authority: query a group to read actual values, change explicit drafts, then check each command's response and readback.

The documented gamerule command does not require cheats. Panel controls do not require turning on `allow-cheats`; native per-rule failures or unsupported rules still disable those controls. The catalog does not assume that every historical Bedrock engine supports all 33 rules. Unknown values are not invented from documented defaults. Native world saves own these settings; the panel does not write fabricated gamerule keys into `server.properties` or replay settings across a different world/runtime revision.

Batches are sequential and may be partly applied. Applied, rejected, unconfirmed and not-sent entries remain separate; unsent drafts remain available for inspection. Refresh the world after a restart before applying new changes.

## Node.js and Python

See [the application operating guide](applications.md) for exact version selection, isolated Python compilation, immutable cache behavior, project/package inspection, startup modes, dependencies and legacy preservation. Runtime catalog failures cannot silently pick an older or host interpreter. A saved exact pin remains stable after a new upstream release.

## Hostnames

Linux has static, transient and pretty hostnames. The input accepts ASCII case for a DNS name and previews its normalized lowercase form. An optional separate friendly-hostname setting preserves case, spaces and Unicode; leaving this option off preserves the current friendly hostname. An explicit empty friendly value clears it. Renaming the VPS display label is a separate control.

The backend uses fixed `hostnamectl` arguments, checks the expected revision and independently reads back DNS names before applying an optional friendly-name change. If only part of a change is verified, the result says so instead of reporting generic success or automatically replaying it.

## Validation evidence

Local tests, Linux checks, native-runtime acceptance and browser acceptance have separate scopes. The final release report in `output/features0156-acceptance.json` records completed checks and remaining limits; this document alone is not evidence that a native build, client join or deployment succeeded.

## Primary references

- [systemd hostnamectl](https://www.freedesktop.org/software/systemd/man/latest/hostnamectl.html): distinct static, transient and pretty names.
- [Microsoft Bedrock gamerule command](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/gamerule?view=minecraft-bedrock-stable): native command semantics and cheat requirements.
- [Microsoft GameRules API](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server/gamerules?view=minecraft-bedrock-stable): the documented rule catalog, with native capability checks retained for older engines.
- [Official Node.js release index](https://nodejs.org/dist/index.json) and [Python downloads](https://www.python.org/downloads/): dynamic stable release discovery.
- [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/) and [Python venv](https://docs.python.org/3/library/venv.html): project dependency and isolated environment behavior.
