# Vortex Panel 0.15.3 audit

This release follows independent source review of the backend, frontend, deployment tools, operational documentation, translation catalogs and test assertions. Reviewers exchanged reproductions before agreeing on changes. Review and passing tests reduce known risks; they do not establish that a project is free of all defects.

## Data consistency and recovery

Player-list responses include a revision of the allowlist and permissions pair. Browser add, edit and delete operations submit the revision captured when their form opened. A stale submission receives `409 PLAYER_LIST_CONFLICT`; its draft remains visible for explicit review and reload. Invalid revisions receive `400 PLAYER_LIST_REVISION`. Legacy API calls that omit the revision retain their explicit whole-pair replacement behavior.

History cleanup retains the exact audit/job records that identify world deletion quarantines and incomplete backup snapshot cleanup while their owned recovery paths still exist. The detector reads path metadata without following symbolic links. Protection ends after the recovery path disappears; it does not automatically delete quarantined data or scan arbitrary paths from logs.

Deletion quarantine names remain within a 255-byte filename component budget. Long source names use a SHA-256 component with a fresh UUID while the audit keeps the original world name. Failed metadata commits continue to restore the original source path.

Offline storage maintenance also checks validated application-account ownership receipts and every real/effective/saved/filesystem UID in the host process inventory. A Node.js or Python sandbox cannot be overlooked merely because its executable or working directory is visible through a private mount namespace. Unknown receipts, account mismatches and unreadable process identities fail closed. This is a maintenance guard, not an instruction to terminate a process.

## Runtime and transport

Application TCP readiness rechecks the active runtime generation after asynchronous probes. An old probe cannot publish a stopped or replacement runtime as running. Memory-limit exit messages identify Node.js, Python or Bedrock correctly.

Resource cleanup verifies the owned cgroup and parent identities after optional statistics collection and before destructive operations. An identity failure cannot be reduced to an optional statistics warning. Failed preparation preserves a replaced scope for inspection. Ordinary statistics I/O failures may remain warnings when ownership is still verified. These path checks do not promise atomic protection against an administrator deliberately replacing kernel objects between individual system calls.

Federated JSON `HEAD` requests no longer parse an empty body as JSON. Headers tied to the upstream JSON representation are omitted when the central panel would rewrite that representation. Binary responses keep their applicable metadata. The behavior follows [HTTP semantics for HEAD](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2).

Host terminal output uses independent streaming UTF-8 decoders for stdout and stderr with one shared byte budget. Split Vietnamese characters and emoji survive pipe chunk boundaries. Terminal access remains subject to its existing administrator and deployment settings.

Authenticated password changes allow five current-password proofs per account in a 15-minute window, shared across sessions and reserved before expensive verification starts. The response supplies `Retry-After`. This action limit does not lock login; a successful password change clears its proof bucket and preserves the existing session-revocation behavior. A stolen session could consume this action bucket, temporarily delaying a legitimate password change.

## Interface behavior

Ordinary live Bedrock files can use Copy and Cut consistently with the backend file policy. Application files still require the application to stop. Busy states, recovery state, protected paths and role restrictions remain enforced.

Discarding multiple settings drafts uses one decision. Cancel preserves every draft guard. Reverting application general settings restores that form's saved values and synchronized controls while retaining an independent startup draft. The keyboard skip link focuses the current content without routing to Overview. Delayed announcement configuration responses cannot open a dialog after their originating view or dialog context has changed.

Resource errors translate explicitly generated nested causes in EN/VI. File paths, user names and unrecognized native system errors remain opaque.

## Validation boundaries

The audit evidence ledger separates complete source reads, structural checks, model-based tests, actual local browser interactions and native Ubuntu verification. Synthetic LevelDB fixtures establish metadata and directory-layout handling, not a playable Minecraft world. Injected process/cgroup fixtures establish application control flow, not kernel enforcement. A successful console enqueue is not proof that a game client received a message.

Deployment preserves Main and Worker roles, node identities, secrets, existing server settings and worlds. Source rollback does not restore an old copy of a world. Shared OS helpers are not overwritten when their installed ownership/content cannot be verified; upgrading a differing shared zram helper still requires coordinated maintenance.

Exact source hashes, test counts, deployment results and cleanup checks belong to the release evidence under `output/`; those local reports and private deployment data are excluded from the source ZIP.
