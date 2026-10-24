# Vortex Panel API

JSON errors use `{ "error": "message" }`. Downloads return attachments. API responses have `Cache-Control: no-store`. Mutations require same-origin requests and `X-CSRF-Token` from authentication. Sessions use an HttpOnly, SameSite=Strict cookie. Admin alone can access host and privileged administration.

Panel messages default to **English**. Send `Accept-Language: en` or `vi` for localized notices; supported regional tags and quality preferences are negotiated, with English fallback. API responses include `Content-Language` and `Vary: Accept-Language`. File downloads can use explicit `?lang=en` / `vi`; WebSocket clients select their own language with `/ws?lang=en` / `vi`. Language selection does not alter authentication, permissions, machine enums or resource identifiers.

Known panel-owned message fields may include corresponding `*I18n` metadata `{id,params,en,vi}` so clients can change language without losing an unsaved form. Stored messages remain canonical; names, file contents, paths, credentials, native Bedrock logs and terminal stdout/stderr stay unchanged. Logs marked `source: "panel"` can be localized; `native`, `command` and unmarked historical logs remain opaque. See [localization](I18N.md).

## Authentication

| Method / path | Body | Response |
| --- | --- | --- |
| GET `/api/auth/status` | — | `{setupRequired,authenticated,user?,csrfToken?}` |
| POST `/api/auth/setup` | `{token,username,password}` | Auth response; initial account only |
| POST `/api/auth/login` | `{username,password}` | Auth response or MFA challenge |
| POST `/api/auth/mfa/verify` | `{challengeToken,code}` | Auth response after valid TOTP/recovery |
| POST `/api/auth/logout` | — | `{ok:true}` |
| POST `/api/auth/password` | `{currentPassword,password}` | `{ok:true}`, revokes other sessions |
| GET `/api/auth/mfa` | — | `{enabled,recoveryCodesRemaining}` |
| POST `/api/auth/mfa/setup` | `{password}` | `{secret,otpauthUrl,qrDataUrl,expiresIn:600}` |
| POST `/api/auth/mfa/enable` | `{code}` | `{enabled:true,recoveryCodes:[...]}` |
| POST `/api/auth/mfa/disable` | `{password,code}` | `{ok:true}` |
| POST `/api/auth/mfa/recovery` | `{password,code}` | `{recoveryCodes:[...]}` |

Login challenge: `{authenticated:false,mfaRequired:true,challengeToken,expiresIn:300}`. It grants no authenticated cookie. Maximum five factor attempts per challenge plus IP/account limits. TOTP uses SHA1, six digits, a 30-second counter, one-step clock drift and replay protection. Recovery codes are hashed and consumed once. Setup is bound to the current session/version. Changes commit before sessions/permissions become effective.

Changing your own password requires the current password. Current-password verification is limited to five attempts per account in a 15-minute window, shared across its sessions; further attempts return HTTP 429 with `Retry-After`. A successful change clears this action's counter and preserves the current session while revoking other sessions. This limit does not disable the account or block login.

Public user: `{id,username,role,allServers,serverIds,disabled,mfaEnabled,createdAt,updatedAt}`. Password hashes, encrypted factors and recovery hashes are never returned.

## Users and permissions

| Method / path | Body | Permission |
| --- | --- | --- |
| GET `/api/auth/users` | — | Admin |
| POST `/api/auth/users` | `{username,password,role,allServers,serverIds,disabled?}` | Admin |
| PATCH `/api/auth/users/:id` | `{role?,allServers?,serverIds?,disabled?,password?,resetMfa?}` | Admin |
| DELETE `/api/auth/users/:id` | — | Admin |

Admin manages the host/accounts/all servers. Operator reads/writes assigned servers. Viewer reads assigned metadata/files subject to guards; complete world exports and backup downloads require manage, including HEAD. `allServers:true` explicitly includes all servers. Server responses have `permissions:{read,manage,delete,clone}`. Lists, schedules, jobs, dashboard and WebSocket are scoped. Account changes revoke sessions. Self-removal/self-demotion of the active Admin and removing the last active Admin are blocked. Own MFA disable requires password+factor.

Individual identity reads/downloads also require manage: exact case-insensitive path segments `keys` or `server_identity_key.pem` after path normalization. GET/HEAD file and attachment routes enforce the same rule; Viewer listings expose names with read/download capabilities disabled and a localized protection reason. Ordinary allowed file reads retain their existing server scope. This is a guard for known server identity paths, not a scanner for secrets in arbitrary user-created files.

## Servers

These paths start with `/api`. Assigned Operator may manage; assigned Viewer may read. Creation, deletion and clone require Admin.

| Method / path | Body / query | Response |
| --- | --- | --- |
| GET `/dashboard` | — | `{host,servers,jobs,activity,versions,capabilities,history}` |
| GET `/servers` | — | `{servers:[...]}` |
| POST `/servers` | `{name,version,channel,portAllocation:"auto",maxPlayers,eula:true}` | `{server,job}` |
| GET `/servers/:id` | — | `{server}` including panel appearance metadata |
| PATCH `/servers/:id` | `{name?,autoRestart?,autoStart?,backupRetention?,messageLanguage?,worldVoiceEnabled?}` | `{server}` |
| DELETE `/servers/:id` | — | `{ok:true,warnings?,cleanupPending?}`, stopped only |
| POST `/servers/:id/clone` | `{name,portAllocation:"auto",eula:true}` | `{server,job}`, stopped source; inherits source maxPlayers |
| POST `/servers/:id/start` | — | `{server}` |
| POST `/servers/:id/stop` | — | `{server}` |
| POST `/servers/:id/restart` | — | `{server}` |
| POST `/servers/:id/kill` | — | `{server}` |
| POST `/servers/:id/command` | `{command}` | `{ok:true,acceptedToConsole,auditRecorded,warnings?}` |
| POST `/servers/:id/announcement` | `{templateId,values?,expectedLanguage?,method?:"say"\|"tellraw"}` | Same console acknowledgement plus `{announcement}`, running only |
| GET `/servers/:id/logs` | — | `{logs:[{time,level,message,runId}],runId}` |
| GET `/servers/:id/activity` | — | `{activity}`, assigned read, exact server ID filtered before latest-100 limit |
| GET `/servers/:id/metrics` | — | `{history,sampleIntervalMs:5000,retentionSeconds:600}` |
| GET `/servers/:id/properties` | — | `{properties:{key:value}}` |
| PUT `/servers/:id/properties` | `{properties:{key:value}}` | `{ok:true}` |
| GET `/servers/:id/configuration` | — | `{server,properties,network}` |
| PATCH `/servers/:id/configuration` | `{settings?,properties?,udpMode?:"auto"\|"custom"}` | `{server,properties,network}` |
| GET `/servers/:id/players` | — | `{allowlist,permissions,online,revision}` |
| PUT `/servers/:id/players` | `{allowlist,permissions,revision?}` | `{ok:true,revision}` |
| POST `/servers/:id/update` | `{version,channel}` | `{job}`, stopped only |

Server fields include `id,name,version,channel,port,portV6,transport,udpPorts,maxPlayers,players,status,createdAt,autoRestart,autoStart,backupRetention,messageLanguage,worldVoiceEnabled,memoryMB,cpuPercent,uptime,pid,error,busy,permissions,consoleRunId`. Metrics retain ten minutes in memory and reset on panel restart. Non-admin dashboard has `host:null`, `history:[]`, `activity:[]`.

### Server appearance

| Method / path | Body / response | Permission |
| --- | --- | --- |
| GET `/api/servers/:id/appearance` | `{appearance,limits,server}` | Assigned read |
| PATCH `/api/servers/:id/appearance` | `{revision,description?,accent?}` → `{appearance,server}` | Assigned manage |
| GET `/api/servers/:id/appearance/media/:slot` | Authenticated PNG/JPEG/WebP bytes; `slot` is `icon` or `cover` | Assigned read |
| POST `/api/servers/:id/appearance/media/:slot` | Multipart one `file` plus `revision` → `{appearance,server,warnings?}` | Assigned manage |
| DELETE `/api/servers/:id/appearance/media/:slot` | `{revision}` → `{appearance,server,warnings?}` | Assigned manage |

`appearance` contains `{schema:1,description,accent,icon,cover,revision}`. Media metadata contains `{sha256,extension,mimeType,bytes,width,height}`; absent media is `null`. Description is one plain-text line, at most 320 JavaScript string code units; accent is six-digit hexadecimal `#RRGGBB`. All writes require the current appearance revision and share a per-server lock. A stale revision returns 409/`APPEARANCE_CONFLICT`. Metadata/audit are committed before the old owned image is removed; cleanup warnings preserve the successful new appearance and identify review needs.

Only non-animated PNG/JPEG/WebP uploads are accepted after structural inspection. Icons are at most 2 MiB / 2048 px per side; covers at most 6 MiB / 4096 px per side; the total pixel bound is 16,777,216 pixels. Remote image URLs/SVG/HTML are not accepted. Media routes retain normal server ACLs and return `Cache-Control: private, no-cache`, `nosniff` and a content-hash ETag. Remote node IDs use the normal proxy mapping. See [appearance behavior and Bedrock listing limits](SERVER-APPEARANCE.md).

Creation/clone persist the new instance, actor audit, queued job and clone source lock together before accepting work. A failed initial write restores the prior registration and reservations; a failure after accepted queueing remains a visible failed job/error instance. Clone releases its source lock when the job finishes, including failure before copying starts.

Allowlist entries use `{name,xuid?,ignoresPlayerLimit?}`; permission entries use `{xuid,permission}` with visitor/member/operator. XUID must be an exact positive unsigned 64-bit integer; strings are recommended because Xbox identifiers exceed JavaScript's safe numeric range. Unsafe numbers, control characters, duplicate names/XUIDs and non-boolean flags are rejected. Player writes prepare both JSON files before activation, then commit one actor audit; observed file/metadata errors restore both prior files, including the raw JSON editor route. This rollback does not provide power-loss atomicity across files.

The player-list `revision` is a lowercase 64-character SHA-256 value covering the allowlist and permissions together; online-player changes do not alter it. PUT checks a supplied revision under the instance write lock before changing either file. An invalid revision returns HTTP 400 with `code:"PLAYER_LIST_REVISION"`; a stale revision returns HTTP 409 with `code:"PLAYER_LIST_CONFLICT"`. Omitting `revision` preserves the legacy API's explicit whole-list replacement behavior, without a concurrency precondition.

Transport is detected from the official package. NetherNet uses TCP signaling and a UDP range; legacy RakNet uses UDP ports. Ranges are reserved and checked across instances. Selecting the loaded world, creating its next-start configuration, changing experiments or its active pack stack requires stopped state. Read-only inspection, online exports and managing inactive worlds remain available while running. Lifecycle/data writes are serialized per instance.

Configuration `settings` accepts `name,autoStart,autoRestart,backupRetention,messageLanguage,worldVoiceEnabled`; properties merge with current keys, preserving unknown advanced properties. Known booleans/enums/ranges are validated. Settings-only edits may be saved while running; any properties/network edit requires stopped state. `network` exposes `udpMode,recommendedUdpPorts,udpPortCount,allowedTransports,debugPort,requiresStopped,warnings`. Auto mode recalculates NetherNet UDP range with port/player-limit changes; custom mode retains validated NAT mappings. Original and candidate ports stay reserved until durable commit. TCP/UDP sockets are probed for external occupancy; this does not allocate firewall rules or guarantee a future bind against external races. Properties, metadata and actor audit roll back on observed write failure; this is not a multi-file power-loss transaction. Raw properties/file-editor routes share this validator.

New creation and Bedrock clone requests accept `portAllocation:"auto"` with no numeric port fields. Omitting all port fields also selects automatic allocation. The executing node selects the ports; read the accepted `server.port`, `server.portV6` and `server.udpPorts` from the response. Explicit ports remain compatible with manual allocation (`portAllocation:"manual"` is optional for legacy clients). Automatic allocation plus explicit port fields is rejected. Node.js/Python creation uses the same mode with one TCP port. See [allocation policy and concurrency limits](PORTS-0155.md).

## Server announcements

`messageLanguage` is server metadata (`en` default, `vi` optional) and is independent of `Accept-Language` or the browser UI. `worldVoiceEnabled` defaults to true and controls only automatic welcome/interruption notices. Metadata-only edits are allowed while running. Clones inherit these effective settings.

Announcements require manage permission on the exact server and a running owned runtime. Top-level keys are strict; the body cannot override the server language or supply a raw command. A stale `expectedLanguage` returns HTTP409 before writing. Templates: `welcome,restart,backup,restore,maintenance,custom`; field definitions/limits follow [server messages](SERVER-MESSAGES.md). Response `announcement:{templateId,language,method,minecraftMessage,preview,plainText,normalizedValues,changedFields}` is opaque to localization.

`acceptedToConsole:true` means the native stdin line was enqueued, not that a player received it. A subsequent log/audit failure returns warnings with the accepted result to avoid inviting duplicate sends. Announcing an operation does not execute it. Automatic welcome waits for a correlated native Player Spawned event; graceful interruptions announce an accurate three seconds when enabled and players are online. Optional notice failure never blocks safe shutdown.

The player add/edit/delete UI sends the revision captured when its form opened. An intervening change to either list rejects the save, keeps the draft open and offers an explicit reload before review and retry. Editing keeps the target XUID immutable. The browser does not silently merge concurrent list changes.

## Files and backups

| Method / path | Body / query | Response |
| --- | --- | --- |
| GET `/servers/:id/files` | `?path=` | `{path,files:[...],limits}` |
| GET `/servers/:id/file` | `?path=` | `{path,content,revision,editable,protection}` |
| PUT `/servers/:id/file` | `{path,content,revision}` | `{ok:true,path,revision,content?}`, existing text file only |
| POST `/servers/:id/files/create` | `{path,content}` | 201 `{ok:true,path,revision}`, new text file only |
| POST `/servers/:id/files/mkdir` | `{path}` | `{ok:true}` |
| POST `/servers/:id/files/rename` | `{source,destination}` | `{ok:true,source,destination}`, full new relative path |
| POST `/servers/:id/files/move` | `{sources:[...],destination}` or legacy `{source,destination}` | Batch `{ok:true,operation,paths}`; single `{ok:true,source,destination}` |
| POST `/servers/:id/files/copy` | `{sources:[...],destination}` | `{ok:true,operation,paths}` |
| POST `/servers/:id/files/compress` | `{sources:[...],destination:"new.zip"}` | `{ok:true,operation,paths}` |
| POST `/servers/:id/files/extract` | `{source:"existing.zip",destination:"new-folder"}` | `{ok:true,operation,paths}` |
| POST `/servers/:id/files/upload` | Multipart `file`, `?path=` | `{ok:true}` |
| DELETE `/servers/:id/file` | `?path=` | `{ok:true}` |
| GET `/servers/:id/files/download` | `?path=` | Attachment |
| GET `/servers/:id/backups` | — | `{backups:[{id,name,size,createdAt,...}]}` |
| POST `/servers/:id/backups` | — | `{job}`, stopped or running with an owned Bedrock snapshot |
| POST `/servers/:id/backups/:backupId/restore` | — | `{job}`, stopped/matching runtime version |
| GET `/servers/:id/backups/:backupId/download` | — | Attachment |
| DELETE `/servers/:id/backups/:backupId` | — | `{ok:true,warnings?,cleanupPending?}` |

All file writes require scoped manage rights and an exclusive instance operation lock. Ordinary user files can be changed while the server is running; active world data and live configuration still require a stopped server. Protected runtime/identity changes require an Admin advanced-file grant with password and risk confirmation; grants are bound to this session/server and expire after ten minutes. Viewer only reads/downloads; response capability hints are masked for the actor, and HTTP still enforces ACLs. These file operations return after the synchronous workflow completes; they do not return a background job ID. Entries expose `protected,protection,capabilities:{read,edit,download,copy,move,rename,delete,compress,extract}` beside name/path/type/size/mtime. Folder descendant checks may still reject an operation whose top-level row looked eligible.

GET files returns the full immediate-directory metadata collection. Pagination is currently client-side: 100 rows per page, search/sort across that collection, selection retained across pages with at most 1,000 selected sources. Select-all applies to the current page. The response has no cursor/offset and should not be interpreted as server-side pagination. Runtime protection compiles exact paths and ancestor prefixes once per operation/list; guarded writes still validate the complete selected tree.

Paths are server-relative; empty destination means the instance root for batch copy/move only. Batch destinations are existing directories and preserve each source basename; single rename/legacy move destinations are full new paths. Sources cannot overlap, repeat or collide by basename. New file, upload, directory, copy, move and ZIP outputs never intentionally overwrite existing targets; conflicts return 409. Copy/move/compress accept 1–1,000 selected paths and traverse at most 50,000 entries/2 GiB. Portable operation paths are limited to 1,024 UTF-8 bytes, 255 bytes per component; traversal, absolute paths, symlinks and special files are rejected. File uploads are limited to 100 MiB each.

The editor reads well-formed UTF-8 text up to 2 MiB and returns SHA-256 of actual bytes as revision. PUT file and POST files/create have a 13 MiB JSON transport allowance for escaped characters; decoded text is still capped at 2 MiB, and other JSON routes retain 2 MiB. Missing revision on an existing HTTP edit returns 428, stale revision 409, and a file deleted since loading returns 404 without recreating it. New text files use POST create. Invalid UTF-8/NUL data stays downloadable but cannot be edited. Identity/runtime/pack paths are protected; properties and player JSON use their dedicated validated transactions. Managed writes additionally return the actual normalized `content` and its `revision` from the same locked read. Properties merge with current keys, so omitting a key does not remove it; player JSON normalizes names, exact XUID strings and formatting. Selected-world root/ancestors cannot be moved or deleted. Stage/activate/audit workflows restore prior data on observed activation or metadata failure; rollback failure is reported with recovery details. This is not a journaled transaction across power loss, and it does not serialize unrelated host processes.

Compression preserves full instance-relative entries and empty directories. For example, selecting `notes/a.txt` creates `notes/a.txt` inside the ZIP; extracting to `imports` creates `imports/notes/a.txt`. Extraction supports ZIP only, requires a new destination folder and never merges into an existing folder. Input ZIP size and cumulative expanded data are each limited to 2 GiB, with at most 50,000 file/directory paths including implicit parents. CRC32/size checks, file-directory conflicts, symlinks and protected target descendants are verified before live activation. CRC checks integrity, not archive publisher identity. Operations stage on the same filesystem and need temporary space for copied data and ZIP output.

Backup/restore limit remains 2 GiB uncompressed/50,000 entries. `backupRetention` is 1–50, default 10; pruning follows a successful backup. Update backs up before replacing runtime. Clone copies an independent stopped world with distinct ports and NetherNet identity.

Backup creation commits the new catalog array and `backup.create` actor audit after the archive completes. An observed metadata failure restores the old catalog and removes only the uncommitted new archive; cleanup failure reports its unlisted recovery path in the failed job. Server/backup deletion and retention rename owned bytes into same-parent private quarantine, then commit metadata and the actor audit together. A failed commit restores prior arrays, ACLs/schedules and bytes. A missing backup ZIP may have its damaged catalog record removed safely.

If deletion committed but quarantine cleanup fails, HTTP 200 returns `warnings:[string,...]` and `cleanupPending:"servers/.../.vortex-delete-..."` beside `ok:true`. This is a completed deletion with pending maintenance, not a rejected/rolled-back operation. Clients must display the warning and must not retry deletion as if metadata still existed. The durable activity detail includes the quarantine relative path. This optional response applies to server and backup deletion, not generic DELETE file. Retention cleanup warnings are also emitted as server WARN logs and completed backup job `warnings`; its message reports pending cleanup. Quarantine names retain the source ID. There is no power-loss journal: a crash between rename and commit requires careful manual recovery against `panel.json` before cleanup.

Use the Version and Add-ons tools for Bedrock packages and pack registration, and Backup restore for replacing an existing world. Generic extraction is a staged data-folder workflow, not a substitute for those validated operations.

## Worlds

All paths below start with `/api/servers/:id`. GET metadata requires assigned read; every mutation and export requires assigned manage. World mutations and exports require an idle instance; metadata can instead report changing bytes. Selecting or creating the selected world requires a stopped server. Importing a new, unselected world, deleting an unselected world and exporting can run while an owned Bedrock process is ready. The selected/running world cannot be deleted. Import owns the upload before returning its asynchronous job.

| Method / suffix | Body | Response |
| --- | --- | --- |
| GET `/worlds` | — | `{worlds,current,pending,limits,validationMode,warnings}` |
| POST `/worlds/import` | Multipart `file` (`.mcworld`/`.zip`), `name` | 202 `{job}`; completed `job.result:{world,selected:false}` |
| POST `/worlds/select` | `{name}` | `{world,configuration}` |
| POST `/worlds/create` | `{name,seed?:string}` | 201 `{world,configuration}`; `state:"pending-generation"` |
| HEAD `/worlds/:name/export` | — | Checks permission/state; format where quiescent, no archive or native save commands |
| GET `/worlds/:name/export` | — | `.mcworld` root attachment; temporary artifact cleaned after response/abort |
| DELETE `/worlds/:name` | `{name}` exact confirmation | `{ok:true,warnings?,cleanupPending?}`, inactive only |

World records include `name,displayName,active,exists,state,valid,validationMode,size,modified,metadata,warnings,error`; changing data may return `state:"changing",retryable:true`. Metadata is structural validation, not a gameplay/database guarantee. Limits: one compressed GiB, two expanded GiB, 50,000 entries, 100 worlds. New names never overwrite; import does not select. Create stores exact string seed, writes no placeholder database. Supported embedded packs are preserved and validated; unsupported content is rejected. See [Worlds](WORLDS.md).

Exporting the running world uses native `save hold/query/resume`, copies the confirmed byte boundaries into a private snapshot and resumes saves before ZIP compression. An unselected/quiescent world uses a verified disk copy. Exports include referenced supported global resource/behavior packs as embedded packs, preserve registration order and revalidate without access to host-global packs. `.mcworld` contains no server identity, unrelated world or server configuration. Snapshot failure does not silently stop/restart the process. Request aborts cancel preparation and release native saving; artifacts are cleaned after response/abort. See [online snapshot limits](ONLINE-BACKUPS.md).

## Recovery integrity and protection

GET `/api/servers/:id/backups` returns `{backups,limits}`. Records additionally expose `locked,sha256,checksumOrigin,integrity,restoreCompatible`; `integrity` includes `status,checkedAt,entries,files,unpackedBytes,error?`. `checksumOrigin:"created"` records the creation checksum; `"established"` records a later baseline for legacy bytes. Unverified legacy records keep a null hash and require explicit verify before restore. These enums are never translated.

POST `/api/servers/:id/backups/:backupId/verify` returns 202 `{job}` and completed `job.result.backup`. PATCH the backup with `{locked:boolean}` to protect/unprotect; it returns `{backup}`. Both require manage and idle but can operate while BDS runs. Maximum 50 protected snapshots; protected backups do not consume rolling retention and cannot be deleted. Download GET/HEAD requires manage and verifies known SHA-256 and archive CRC/path/size; it does not silently mutate legacy metadata. Restore checks again before live activation. Existing creation/restore/delete routes retain their stopped/busy rules. A hash mismatch keeps the artifact and reports failed integrity.

New server-scoped activity records include immutable `serverId`. Server workspace must filter exact ID, not names/detail substrings. Historical unscoped records remain global Admin history; no automatic name-based reassignment.

If restore rollback itself fails, both original and candidate copies are retained. Server `recoveryRequired:true` blocks native start, automatic start and data mutations until manual recovery. The error identifies relative recovery paths and both failure causes; see [operations recovery](OPERATIONS.md#restore-lỗi-và-rollback-cũng-không-thành-công). A completed activation with cleanup warnings is a separate state and does not set this marker.

Operation jobs expose `operationCompleted`, `completionAuditRecorded`, `completionStatusPersisted` and, for backup pruning, `retentionComplete`. These flags describe resolved operation and acknowledged metadata writes, not fsync or power-loss guarantees. When data has committed but only completion audit/state saving fails, the job remains completed with warnings in memory; its last warning/details may not survive restart. Inspect actual data before repeating the operation. Pre-commit/operation errors remain failed with their original cause. A backup pruning exception stops further deletion, keeps the new snapshot and retained older snapshots, and reports `retentionComplete:false`; the catalog may temporarily exceed retention. `retentionComplete:true` can still accompany physical quarantine cleanup warnings.

## Bedrock add-ons

GET requires assigned read and works while Bedrock runs. Writes require assigned manage and the instance data lock. Import installs new pack files without activating them and can run while a ready server runs. Activation, deactivation and reordering require stopped Bedrock because they change world registration. Removal can run online only for a custom pack proven absent from the ready process’s startup snapshot, every world registration and enabled dependants. Protected, loaded, registered or unprovable packs remain blocked. Online removal rechecks state and changes no registration JSON.

| Method / path | Body | Response |
| --- | --- | --- |
| GET `/api/servers/:id/packs` | — | `{packs,stacks,revision,world,warnings,limits,runtime,registrationSource,observedAt,priorityOrder}` |
| POST `/api/servers/:id/packs/import` | Multipart `file` (`.mcpack`/`.mcaddon`) | 201 `{packs,warnings}` |
| PATCH `/api/servers/:id/packs/:uuid` | `{enabled:boolean}` | `{pack,activated,world}` |
| DELETE `/api/servers/:id/packs/:uuid` | — | `{ok:true,worldsUpdated}` |
| PATCH `/api/servers/:id/packs/order/:kind` | `{revision,packIds:[uuid,...]}` | Reordered metadata; `kind` is `behavior` or `resource` |
| GET `/api/servers/:id/experiments` | — | World experiment flags, metadata revision and installed-runtime availability; readable while running |
| PATCH `/api/servers/:id/experiments` | `{revision,flags:{id:boolean},acknowledgeExperimental?:boolean}` | 202 `{job}`; stopped only, verified backup before writing |

Pack records expose `uuid,name,description,version,minEngineVersion,packScope,kind,folder,scope,modules,dependencies,errors,protected,enabled,priority,scripting,requiresBetaApis`. `scope` is null for instance-level folders, or the owning world name. `stacks` preserve exact world registration order, highest priority first, including missing-pack warnings. Reorder is an optimistic exact permutation of every registered UUID; stale revisions, duplicates and omitted/invented UUIDs reject without writing. Unknown registration fields survive. Activation writes the world's behavior/resource reference lists and includes exact UUID/version dependencies; disabling a required pack is blocked while dependants remain active. A configured existing world is required. Stopped removal updates references across the instance's worlds; safe online removal changes no registrations. Mojang runtime packs are protected. Imported folders and reference lists are rolled back if durable metadata commit fails.

`registrationSource:"world-pack-json"` describes configured files. `runtime.stacks` is the configuration captured at process startup; `configuredMatchesStartup` compares that snapshot with the current registration. It is not proof that scripts/assets loaded successfully. Inspect Bedrock's native content log for actual loading errors. Importing a pack does not hot-load it into a running world.

The supported subset is manifest v2, data/resources/JavaScript script modules, exact `@minecraft/*` API-version dependencies and acyclic UUID dependencies. Script entry files must be present safe relative `.js` paths. API availability is checked by Bedrock, not guaranteed by manifest acceptance. Beta dependencies may require Beta APIs; activation does not enable experiments automatically. Manifest v3, global-only scope, encrypted archives and world bundles are rejected. Limits: 100 MiB compressed, cumulative 512 MiB unpacked/10,000 entries including nested `.mcpack`, 20 manifests. Duplicate UUIDs, unsafe paths and unsupported engine versions are rejected.

Experiments come from validated bounded `level.dat` and names detected in the current world/installed runtime. Unknown native flags stay visible and unchanged; unavailable flags cannot be invented. Changes require exact metadata revision, stopped state and a verified pre-change backup. Enabling requires `acknowledgeExperimental:true`; history flags indicating prior experimental use are retained. Completed jobs return the new experiment metadata and backup. Changes apply on next world load; disabling a toggle does not guarantee that experimental world changes or compatibility are reversed.

## Versions, schedules and activity

| Method / path | Body | Permission / response |
| --- | --- | --- |
| GET `/versions` | — | Authenticated; `{versions,latest,preview,checkedAt,error,history}` |
| POST `/versions/refresh` | — | Admin; version response |
| POST `/versions/:channel/:version/verify` | — | Admin; `{version}` with availability proof, no executable download |
| POST `/versions/import` | Multipart `file`, `version`, `channel` | Admin; `{version}`, 1 GiB upload limit |
| GET `/jobs` | — | Scoped `{jobs:[...]}` |
| GET `/schedules` | — | Scoped `{schedules:[...]}` |
| POST `/schedules` | `{serverId,action,intervalMinutes,command?,enabled}` | Operator/Admin; `{schedule}` |
| PATCH `/schedules/:id` | `{action?,intervalMinutes?,command?,enabled?}` | Operator/Admin; `{schedule}`, inactive job only |
| POST `/schedules/:id/run` | — | Operator/Admin; 202 `{schedule,job}` |
| DELETE `/schedules/:id` | — | Operator/Admin; `{ok:true}` |
| GET `/activity` | — | Admin; `{activity:[{id,time,action,detail,user}]}` |

Schedule action is `backup`, `restart` or `command`; interval is 1–525600 minutes. `command` is required for action `command` and optional for backup/restart, where it runs first. Missing PATCH `command` preserves its prior value; an explicit blank removes it. Commands must be one line, at most 2048 characters; embedded `stop`/`restart` lifecycle commands are rejected. Older releases that discarded an optional command cannot reconstruct it; enter it again once.

Editing an interval/action or re-enabling resets `nextRun`. Only editable fields are accepted; a schedule cannot be moved to another server. Create/update/delete commit state and actor audit in one durable write; an observed write failure restores prior arrays and record identities. Records expose `status,error,lastRun,lastFinishedAt,lastJobId,lastCommandResult`. Run-now and timer execution share a per-server lock. Scheduled backup follows the normal backup policy: Bedrock online snapshot when supported/ready; stopped-only Node.js/Python backup.

Schedule jobs add `commandResult`, `actionStatus`, `actionStartedAt?`, `actionFinishedAt?` and `backupJobId?`. Command results distinguish `confirmed`, `dispatched`, `rejected`, `unconfirmed` and `not-sent`, with `acceptedToConsole`, `confirmedApplied`, `clientReceiptConfirmed:false`, `reasonCode`, bounded native feedback and correlation metadata. Bedrock's matching `say` acknowledgement confirms native processing; silent generic commands can establish dispatch/order without proving gameplay effects. Application stdin only proves enqueueing. A rejected, unsent or unordered/unconfirmed pre-command prevents the following action, and the command is never automatically replayed. See [operational examples](OPERATIONS.md#schedules-and-command-results).

Jobs expose `id,type,serverId,status,progress,message,createdAt,finishedAt,warnings?`. Completed jobs may retain maintenance warnings across scoped GET jobs/dashboard and WebSocket-triggered refresh. Observed/imported version history persists. GET activity projects only the most recent 100 audit rows.

Historical versions additionally expose `historical,source,displayVersion,historyKey,catalogKeys,sha256,sha1,checksumSource,metadataStatus,metadataError,availability,availabilityCheckedAt,verificationError`; optional fields depend on source. Cached records remain installable offline. `history` includes per-source URLs/status/errors, indexed/loaded/remaining counts and stable/preview coverage. Ready history means the source registry was synchronized; it does not prove every package URL or runtime. BDS-Versions exact identifiers, including padded build numbers, appear from its bounded registry before optional metadata loads. Candidate URLs follow its declared official CDN root and known IDs; candidates remain unchecked until lazy exact-version Linux metadata and HEAD succeed. Endstone records add SHA-256; legacy BDS metadata can supply SHA-1 or no hash. Present hashes are checked during download before package activation, and absent hashes are not represented as checksum proof.

Community sources never set official `latest`/`preview`, and unavailable auxiliary metadata does not gate an authoritative Mojang URL. Historical uncached installs require a recent HEAD proof (24 hours). When legacy metadata supplies a size, an advertised HEAD length must match and streamed GET bytes must match before activation, including packages without hashes. HEAD/GET redirects must preserve selected version/channel and exact official host/path. Up to four concurrent HEAD checks, one in-flight check per key, 60-second debounce; no arbitrary user URL probe. The client filters/searches and renders ten records per page.

## Host and readiness

Admin-only routes:

- GET `/api/host/info`: `{host,capabilities}`.
- GET `/api/host/diagnostics`: capability checks, interface addresses/listeners, panel/Bedrock processes, systemd and storage. Cached ten seconds; no argv/environment exposure.
- POST `/api/host/terminal` with `{command}`: `{stdout,stderr,exitCode,timedOut,truncated}`. Linux opt-in, service-user permission, 15-second deadline, 1 MiB output limit, audited.

Public GET `/healthz`: `{ok,service:"vortex-panel",version,processId,instanceId,maintenance}`; 503 during shutdown. `maintenance` is `null` or `{active:true,action,requestId}`. It exposes the admission freeze, without credentials or account data. `processId` is the serving Node PID, used to bind readiness to systemd MainPID, rather than a Bedrock PID. A matching service label alone does not prove the intended release is serving a port.

### Fleet source updates

All paths require Admin. Mutations require normal Origin/CSRF checks; final start/recovery also reauthenticate the current Admin password.

| Method / path | Body / result |
| --- | --- |
| GET `/api/host/update?refresh=true` | `{update}`: current/latest version, verified release metadata, revision, ordered nodes, blockers, policy and last job ID; refreshing only checks metadata |
| POST `/api/host/update` | `{revision,version,requestId,confirmedUpdate:true,adminPassword,connections:[]}` → 202 `{job}` after durable admission; no VPS credentials |
| GET `/api/host/update/jobs` | `{jobs}`; bounded administrative history |
| GET `/api/host/update/jobs/:id` | `{job}`; reads/reconciles the existing request without activating it again |
| POST `/api/host/update/recover` | `{requestId,cancelPrepared:true,adminPassword,connections:[]}` → 202 `{job}`; inspect the existing UUID and safely cancel verified unactivated stages |

New jobs use `nodes[].updateTransport:"local"|"agent"` and reject nonempty SSH connections. The local native helper handles the main panel. Workers advertise top-level `panelUpdate:1` in identity/snapshot and expose only authenticated Admin POST `/api/node/update/{plan,prepare,launch,status,verify,verify-rollback,attest,abort}` controls. The server fixes the worker identity and helper paths; callers cannot supply commands or executable paths. The enrolled token, TLS trust, agent identity and durable request identity remain enforced. Older workers without this capability are reported as `updateTransport:"bootstrap"` and must receive a one-time worker-installer upgrade.

Only recovery of a legacy remote SSH job accepts `connections:[{nodeId,ssh}]`, bound to the original nonsecret `job.nodes[].sshTarget`. Here `ssh` accepts `host,port,username:"root",hostFingerprint` and exactly one of `password` or `privateKey` (optional `passphrase`). Local and agent-connected rows must be omitted. Ephemeral credentials never enter stored jobs or node records. Recovery never replays preparation or activation. The former `/api/host/update/check` route is no longer exposed.

Jobs use `type:"panel-update",scope:"host",adminOnly:true,serverId:null`, an idempotent UUID `id/requestId`, `version,release,status,phase,progress,nodes,verified,outcomeUnknown`. Per-node details include original identity, progress, proof and fixed recovery paths. Only `completed` with verified proofs for every member is success. Known partial updates can leave some workers on the new source while the main panel stays usable; a new reviewed update attests already-current workers rather than downgrading/reinstalling them. Unknown outcomes keep admission frozen until the existing request is verified. Read [source-update safety and receipts](PANEL-UPDATES.md) before implementing a client.

WebSocket `/ws` needs an authenticated cookie and valid Origin. Events: `{type:"log",serverId,runId,log}`, `{type:"console-reset",serverId,runId}` or `{type:"update"}`. Server metadata contains `consoleRunId`; a new admitted start retires the previous run. Console clients must reject events and late GET responses for retired runs. Explicit stops clear the current console; crash output remains until the next start. Managed disk history is retained separately and is never replayed into a new current console. Delivery revalidates session and server ACL. Revoked/expired sessions close with 1008; clients with over 1 MiB buffered output close with 1013. Frontend reconnects with polling fallback.

## Runtime controls (0.7.0)

Create and configuration settings accept `resourcePolicy`: `{mode:"shared"}` or `{mode:"fixed",cpuCores:<number>,memoryMiB:<integer>}`. Fixed limits require the capability exposed at `dashboard.capabilities.resourceControl` / configuration `resourceControl`. Server responses contain `resourcePolicy` and `resources:{configured,effective,usage,cleanupPending,lastExit}`. `effective.applied`/`kernelEnforced` describe the current run; `lastExit` is one bounded historical final-kernel sample, with `reason:"memory-limit"|"native-exit"`. Limits can change only while stopped; limits are not reservations.

- GET `/api/servers/:id/gameplay`: metadata, rule definitions/observations, current world revision, observed online connection identities and action/item catalogs. For an owned ready world it automatically issues serialized **read-only** native rule queries on first access, then reuses that runtime/world observation subject to a 60-second automatic refresh cooldown. Refresh is deferred during conflicting work, so the saved observation is not a constant live-state guarantee. Concurrent readers share one refresh; partial/failed scans are throttled too. It never applies a rule. `automaticRefresh:{status,lastAttemptAt,retryAt}` distinguishes idle, refreshing, current, partial and unconfirmed scans. With stopped Bedrock, exact typed whitelisted values from validated `level.dat` have `status:"saved"`, `source:"world-level.dat"` and `readOnly:true`; they are saved-disk observations, not live native confirmation. Missing/mistyped fields stay unknown. No old-runtime/world defaults are copied. Labels have `*I18n` metadata.
- POST `/api/servers/:id/gamerules/query`: `{worldRevision,keys?}`. Requires manage permission, sends fenced serialized native queries. Returns per-rule typed confirmed/unconfirmed results and current world identity.
- PATCH `/api/servers/:id/gamerules`: `{worldRevision,changes:{key:value},expected:{key:value}}`. Exact typed keys and expected values; stale world/expected values reject before writes. All expected values are checked before writes. A value already matching the request returns confirmed readback with `reasonCode:"already-current",changed:false,acceptedToConsole:false`, without a mutation command. Once any native command was accepted, a later failure returns per-rule partial/unconfirmed/not-sent results, rather than falsely asserting no effect. Bedrock saves rules in the world; they do not need reactivation after a normal restart. World rules do not require cheats.
- POST `/api/servers/:id/player-actions`: `{worldRevision,action,target:{name,xuid,connectionId},values}`. Requires manage permission and exact observed current online identity. Actions: `give`, `kill`, `kick`, `heal`, `gamemode`, `teleport`, `op`, `deop`. Give/Kill/Heal/Gamemode/Teleport require cheats; Vortex never enables them automatically. Returns command acceptance separately from native effect confirmation. Arbitrary selectors/command fragments are rejected.

Admin-only history routes:

- GET `/api/admin/log-retention`: `{policy,stats,console}`. Console stats include bounded queue, dropped entries, write failures, successful processed input, materialized new entries and known retention evictions; external native files/Linux journal are not managed.
- PATCH the same route: validated flat policy fields. Applies age/count/byte budgets. Active jobs and unresolved recovery anchors remain protected and can exceed budgets.
- POST `/api/admin/log-retention/clear`: `{activity:boolean,finishedJobs:boolean,confirmed:true}`, at least one selected. Returns removed counts and stats; protected records remain.
- GET `/api/admin/log-retention/export`: private JSON attachment with policy/activity/jobs. Reads require admin; writes require admin and CSRF.

Jobs include monotonic workflow `progress` (running <=99), `phase`, and optional download `transfer:{loadedBytes,totalBytes,percent}`. Unknown total size yields `percent:null`. Download100 does not imply completed installation. Terminal completion is persisted before reporting successful completion.

## Nodes and SSH provisioning (0.8.0)

All Nodes routes require Admin and the existing session/Origin checks; mutations also require CSRF. Endpoints below include the `/api` prefix.

| Method / path | Input / result |
| --- | --- |
| GET `/api/nodes` | `{nodes,limits}`; Local plus linked nodes, bounded host observations and per-node capabilities/ports |
| POST `/api/nodes/ssh/check` | `{host,port?}` discovers only the SSH key, without authentication. Repeat with `{host,port?,username,password XOR privateKey,passphrase?,hostFingerprint}` for authenticated host preflight |
| POST `/api/nodes/provision` | Confirmed SSH fields plus `{name,location?,publicAddress?,agentPort?}`; 202 `{job}` after durable queue commit |
| GET `/api/nodes/provision/jobs` | `{jobs}`; bounded Admin-only setup history, no SSH or agent secrets |
| GET `/api/nodes/provision/jobs/:id` | `{job}`; workflow stage and actual SFTP byte progress |
| GET `/api/nodes/agent-bundle` | Public-source ZIP attachment; authenticated download, no runtime/config/secret data |
| POST `/api/nodes` | `{name,endpoint,publicAddress?,location?,token,fingerprint?}`; 201 `{node}` after verified HTTPS identity |
| GET `/api/nodes/:id` | `{node}`; credentials omitted, `hasToken` only |
| PATCH `/api/nodes/:id` | Editable connection/metadata fields and `maintenance?`; preserves bound agent identity |
| POST `/api/nodes/:id/test` | Refresh actual connection observation; `{node}` can report offline without signing out the panel session |
| DELETE `/api/nodes/:id` | Refused with409; use verified uninstall so the worker is not left running after its link disappears |
| GET `/api/nodes/:id/uninstall` | Read-only `{nodeId,name,address,plan}`; empty/known inventory, owned components, retained components, blockers and revision |
| POST `/api/nodes/:id/uninstall` | `{nodeId,revision,requestId,confirmed:true,confirmationName,adminPassword,ssh}`;202 `{job}` after durable admission; SSH uses the checked host fingerprint and fresh root credentials |
| GET `/api/nodes/uninstall/jobs/:id` | Admin-only durable `{job}`; distinguish completion, partial cleanup and unknown outcome |
| POST `/api/nodes/uninstall/jobs/:id/verify` | `{nodeId,requestId,adminPassword,ssh}`;202 `{job}`; independently inspect the original operation through the same pinned SSH host, never dispatch uninstall again |
| GET `/api/nodes/:id/versions` | Catalog from that node, with its own cached packages and official latest |
| POST `/api/nodes/:id/versions/refresh` | Refresh that node's catalog |
| POST `/api/nodes/:id/versions/import` | Existing validated multipart package-import contract, stored on that node |
| POST `/api/nodes/:id/versions/:channel/:version/verify` | Verify the exact historical version on that node; `{version}`, no executable download |

Create-server accepts `nodeId` (omitted or `local` keeps the current host). Remote server IDs are opaque `centralNodeUUID:agentServerUUID` values; keep the whole ID in per-server routes and account grants. Remote job/schedule/activity IDs use the same namespace. Existing local IDs do not change. GET `/api/servers/:id/versions` returns the assigned server's catalog and follows normal server read permission. Existing per-server routes, file transfers and schedules are forwarded through an explicit allowlist with the actual human role/grants; node credentials never reach the browser. Direct agent APIs are described in [NODE-AGENT](NODE-AGENT.md).

Setup jobs have `type:"node-provision",scope:"nodes",adminOnly:true,serverId:null`, stage/progress, `transfer`, optional `nodeId`, `outcomeUnknown` and a private recovery-log path. Last 20 finished jobs are retained. Overall percentage represents workflow stages; only SFTP transfer percentage represents measured bytes. A controller restart marks in-flight tracking interrupted and does not retry or kill a detached installer. See [NODE-PROVISIONING](NODE-PROVISIONING.md).

Nodes retain last-known inventory while offline and label runtime/metrics unknown. Maintenance blocks new placement/clones. Ambiguous remote mutations are never retried automatically; inspect the node's actual server/jobs before submitting again. CPU/RAM ceilings are enforced by the assigned node. Browser requests stay on the controller origin; game clients connect to the assigned node's public address and game port.

Admin GET `/api/servers/:id/network-access` inspects native UFW support/status and the saved server's derived game-port rules. POST the same path with `{revision,confirmed:true}` explicitly reconciles those rules when UFW is already active. The revision binds the saved network settings and observed rules. Responses contain per-port `managed|covered|missing` state, scoped managed/obsolete rules, warnings, and on apply `{ok,partial,added,removed,errors}`. Known partial effects return their observed result instead of claiming rollback. No arbitrary ports, debugger ports, firewall enable/reset/default-policy changes or foreign-rule deletion are exposed. Agent and local panel rule ownership uses separate data-directory namespaces. Cloud firewall/router reachability remains separate from OS-rule observation.

DELETE that path with the same confirmed revision removes only this server's Vortex-owned rules. Existing foreign allowances can still permit access. Remove managed rules before deleting a server when they are no longer wanted; deleting game data does not implicitly edit firewall policy.

Worker uninstall is available only for a linked VPS with a verified empty server inventory. Move or explicitly remove game servers first; uninstall has no delete-worlds option. The main panel VPS cannot be selected. Administrative re-authentication, typed VPS name and current plan revision bind the final request. Passwords, private keys and passphrases are held only for that SSH operation and are excluded from jobs/audit/commands. A202 or lost Agent connection does not prove removal. The controller retains the VPS and its recovery lock until a private remote receipt and a separate pinned SSH inspection verify the stopped/disabled worker and absence of the planned active components. A controller restart or ambiguous transport failure keeps `unknown`; recovery verifies the existing requestId and never repeats destruction automatically.

Jobs use `type:"node-uninstall",scope:"nodes",adminOnly:true,serverId:null`, `nodeId,requestId,status,phase,verified,outcomeUnknown,retainedComponents`. Only `status:"completed"` with `verified:true` means the verified worker link was removed. `cleanupScope:"active-worker-components"` does not mean the VPS returned to its original OS state. Installer receipts cover only provably created paths. Pre-existing shared packages/Node, untagged firewall rules, unfamiliar source/data files, recovery backups and separate legacy panel stores remain listed; an empty worker inventory never authorizes removing a separate panel's worlds. See [worker maintenance](OPERATIONS.md#worker-maintenance).

## Current session and system administration

Admin GET/POST/DELETE `/api/auth/file-access` reads, enables or disables advanced access for one server. POST requires `{serverId,password,confirmed:true}`; DELETE requires the selected server identity. The server checks the actual password and does not accept a client capability hint as authorization. See [advanced file access](OPERATIONS.md#files-and-advanced-access).

Admin GET/POST `/api/host/power` and `/api/nodes/:id/power` inspect or request restart-service/reboot, bound to a generation revision and idempotent UUID. The local node ID is `local`; remote public IDs are mapped only to their enrolled agent identity. Confirmation and normal Origin/CSRF checks are required. Unknown outcomes are read-only observed, never automatically retried. See [system administration](OPERATIONS.md#system-administration-and-resource-boundaries).

History defaults are 100 recent activity entries and 50 completed jobs, subject also to age/byte budgets. Active jobs and unresolved recovery references are protected. Explicit custom retention remains effective; these counts describe defaults, not permission to remove recovery data. See [history retention](OPERATIONS.md#deletion-retention-and-cleanup-warnings).

## System memory assistance

Admin-only `GET /api/nodes/:id/zram` returns `{nodeId,zram}`; `local` identifies the main VPS. `GET /api/host/zram` is the local alias. Reading never enables, disables or resizes zram. The state reports capability/ownership, physical RAM, configured and effective state, recommended auto profile, revision, busy and last operation.

`zram.telemetry` independently reports active host zram swap, including devices managed outside Vortex: `{schemaVersion:1,available,status,logicalSizeBytes,swapUsedBytes,algorithms,complete,observedAt,scope:"host-zram-swap",source:"/proc/swaps + sysfs"}`. Capacity and used bytes both come from `/proc/swaps` (KiB converted to bytes), excluding ordinary disk swap. Algorithms come from the active kernel devices, verified by block identity rather than device filenames. Missing measurements are `null`; a measured usage of zero remains `0`. These observations do not grant control over external devices or change the owned `configured`/`effective` fields used to authorize system changes.

`POST` to the same path requires `{nodeId,enabled:boolean,profile:"auto",confirmed:true,revision,requestId,password}` with the current panel Admin password, valid session, Origin and CSRF. `requestId` is a UUID and `revision` is the exact current state hash. The controller rechecks current session/account/password after verification, removes the password and forwards only the fixed schema to `GET/POST /api/node/zram` on an enrolled Agent. The public node ID is translated to its fixed agent identity. Passwords are neither forwarded nor retained.

The request returns200 only after a terminal result is observed. A timeout/transport failure may return `outcomeUnknown:true` and safe observed `zram` metadata. Follow up with GET; never automatically repeat the POST. Duplicate UUIDs cannot execute the system operation twice. Changed payloads, stale revisions, foreign ownership, unresolved history or competing maintenance return a conflict. The first profile supports only enable/disable; it cannot resize an active device.

Zram never contributes to server allocation capacity. Game memory swap remains disabled; the main/worker reserve policy remains10%/0%. Native changes require the root managed Linux service, exact installed helper, fixed tools and >=180s effective stop allowance (installer sets240s).


## VPS timezone, network and HTTPS

All routes below require Admin, the authenticated session and CSRF protection for mutations. Timezone and network operations work on the local VPS or a linked agent. Older agents return an explicit upgrade requirement. These actions do not stop managed servers.

| Method / path | Body / response |
| --- | --- |
| GET `/api/host/timezone` or `/api/nodes/:id/timezone` | `{nodeId,timezone:{available,timezone,zones,revision,busy,lastOperation,observedAt,reasonI18n}}` |
| POST `/api/host/timezone` or `/api/nodes/:id/timezone` | `{nodeId,timezone,revision,requestId,confirmed:true}`; returns verified state and operation |
| GET `/api/host/network` or `/api/nodes/:id/network` | `{network}` with actual kernel values, reversible owned profile and revision |
| POST `/api/host/network` or `/api/nodes/:id/network` | `{action:"apply"\|"restore",revision,confirmed:true}`; returns verified kernel/profile state |
| GET `/api/host/tls` | `{tls}` with certificate, expiry, renewal timer, jobs, revision and recovery state |
| POST `/api/host/tls` | `{requestId,revision,confirmed:true,termsAccepted:true,adminPassword}`; HTTP 202 with `{job}` |
| GET `/api/host/tls/jobs/:id` | `{job}` with actual durable progress or an explicit unknown outcome |
| POST `/api/host/tls/recover` | `{requestId,revision,confirmed:true,adminPassword}`; HTTP 202 with verified `{tls,job}` |

`requestId` is a UUID; `revision` comes from the latest corresponding GET response. Recovery uses the original TLS request ID and a fresh revision. It reconciles an interrupted operation without issuing another certificate. The Admin password is verified and removed before dispatch; it is never a task field. Certificate private keys, saved proxy configurations and ACME account material are not exposed by these APIs.

The dashboard includes `panelTimezone` for every authenticated role, even when `host` is hidden. Panel timestamp labels use this main VPS timezone; saved timestamps remain UTC. Server metadata includes `restartRecovery:{attempt,maxAttempts,windowSeconds,paused,nextAttemptAt}`; `nextAttemptAt` is an ISO timestamp or null. See [timezone](TIMEZONE.md), [network profile](NETWORK-TUNING.md), [HTTPS](HTTPS.md) and [process recovery](RELIABILITY.md).
