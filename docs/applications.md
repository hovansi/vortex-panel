# Node.js and Python applications

Vortex Panel manages Minecraft Bedrock, Node.js and Python on the same nodes. Applications share the existing console, files, resources, backups, schedules and activity workspace. Minecraft worlds, players, add-ons and Bedrock updates stay specific to Bedrock servers.

## Create and run

1. Choose **Create → Node.js / Python**, then choose the VPS. New applications resolve the latest final stable version directly from nodejs.org or python.org at creation time. The selected exact version is persisted with the server, separately from the interpreter that runs the panel.
2. Set a name, CPU/RAM policy and storage quota. The selected VPS assigns a random available TCP port by default; advanced custom ports remain available. Vortex supplies the assigned port through `PORT`. The starter application listens on `0.0.0.0`; replace its source files with your project while stopped.
3. Choose an entry file (`src/server.js`, `app.py`), a declared `package.json` script, or an importable Python module. Script/module modes are offered when the selected node supports them. Add arguments as separate fields: one field is one argument, including its spaces. The launcher uses a validated executable and argument array. An npm script may execute the project's own shell commands inside the non-root application sandbox.
4. Choose **TCP port accepts connections** for a web service, or **Process is running** for a bot/background script. TCP readiness does not prove that an HTTP endpoint behaves correctly. Process readiness does not check a web endpoint.
5. Start the application and inspect its console. Console input is a line written to the application's standard input; an application must implement a corresponding input handler to use it.

Node.js and Python applications support native x86-64 and ARM64 (`aarch64`) Ubuntu nodes. The selected VPS must report working runtime isolation and the required resource/storage controls. New applications require managed-runtime support on that node. Catalog, artifact or verification failures do not silently select an older release or the host interpreter. Windows is a development/UI preview environment; application execution requires Ubuntu/Linux.

## Exact runtime lifecycle

Node.js selects the newest stable Current release, including newer stable releases beyond LTS. It downloads the official Linux architecture archive and verifies the official SHA-256. Python selects the newest final release from python.org and verifies its official source archive. Previews, alpha/beta/RC builds and alternative download hosts are excluded. If the newest final release has no artifact for this architecture, creation fails rather than selecting an older release.

Python's official Linux source is built under the application's dedicated non-root identity, in its own temporary 3 GiB volume and a capped build cgroup (0.5 CPU, 1 GiB RAM). This first build can take considerably longer than downloading Node.js. The admission check accounts for temporary build, archive and promotion disk space. Concurrent applications requesting the same exact artifact share the verified immutable runtime cache. Build output is available in the installation task. A failed or interrupted cleanup remains a recovery condition; it is not an instruction to replay the installation.

Managed runtime executables are verified as ELF64 binaries for the node's architecture before promotion into the immutable cache and whenever that cache is reused. A foreign-architecture executable is rejected before application execution.

The installer prepares the Ubuntu development tools required for Python. Existing installations can review the node's missing-prerequisites report before creating Python applications. These packages are compiler/header dependencies; the managed runtime does not replace the host Python or Node.js executable.

Servers created before this feature retain their existing host runtime/virtual environment and startup configuration. Starting, editing or installing dependencies for an existing server does not resolve the latest version. A managed server keeps its exact saved pin after a later upstream release. This release does not provide an automatic in-place runtime upgrade or downgrade. Runtime pins also bind the CPU architecture. To move a project from x86-64 to ARM64 or back, create an application on the target node, restore its project files and reinstall dependencies there. Do not copy the managed interpreter cache or an existing `.venv` between architectures. Node.js/Python never use the Bedrock Box64 compatibility runtime and Vortex does not rewrite old application pins.

## Project management

Application settings show project manifests, declared scripts, dependency counts, installed package names/versions, runtime origin and the last dependency-install result. Use the manifest controls to open an existing manifest in the revision-protected file editor or explicitly create a missing one. Inspect project files while the application is stopped; a running application shows a clearly marked cached summary rather than walking a mutating filesystem. File edits, dependency installation and startup remain separate operations.

## Dependencies and environment

Choose **Install during creation** to install project dependencies as part of setup, or **Manual installation**. Subsequent starts do not hide a dependency installation. After uploading or changing manifests, stop the application and use **Install dependencies**. It creates a separate task with a result and console output; an accepted task is not a completed installation.

- Node.js uses `npm ci` when `npm-shrinkwrap.json` or `package-lock.json` exists, otherwise `npm install` from `package.json`. The pinned runtime supplies its bundled npm.
- Python uses a private `.venv` and installs `requirements.txt` into it. The environment is built at its final path.
- Dependency commands use the same restricted application identity, sandbox and resource controls. They do not inherit the panel's environment or run as the panel's root user.
- Environment names use uppercase letters, digits and underscores. Launcher variables such as `PORT`, `HOME`, `PATH` and runtime injection variables are reserved.
- Mark sensitive values **Secret**. Saved values are masked in API responses and the UI. Leaving a masked value unchanged preserves it; renaming its key requires a new value. **Clear value** explicitly replaces it with an empty string. The running application can still read its own environment.

## Isolation, resources and networking

Applications run under a dedicated non-root Linux account through `setpriv` and Bubblewrap. The sandbox exposes the application's workspace and the required read-only runtime files, with separate user, mount, PID, IPC and UTS namespaces. Custom environment variables are applied only after entering the sandbox; they are not passed through the privileged launcher. Required sandbox checks must pass before application code or install scripts run. There is no fallback to an unrestricted root launch.

A fixed root setup first uses `unshare --mount --propagation private` to create a temporary workspace alias inside its own mount namespace. It verifies the inherited workspace identity, overlays `/mnt` with a tiny private tmpfs, binds that workspace as `/mnt/workspace`, then execs `setpriv` and Bubblewrap in the same process ID. This gives the non-root sandbox access without granting traversal through private panel DATA. The alias never mounts into the host namespace and disappears with its namespace; application code and dependency hooks still begin only after the UID drop. These semantics follow the [util-linux unshare manual](https://man7.org/linux/man-pages/man1/unshare.1.html) and [Linux mount API](https://man7.org/linux/man-pages/man2/mount.2.html).

The native probe verifies both UID/GID namespace maps and a newly created regular file's ownership as seen from the host. Bubblewrap's nested device namespace may map the application's inner ID to parent ID zero; this is accepted only when that fresh file still has the expected non-root host UID/GID, one link and the expected content. The probe also requires no supplementary kernel groups, no new privileges and zero capability sets.

CPU/RAM controls use the node's existing managed cgroup pool. Fixed limits are ceilings, not reserved free capacity. A process limit of 128 includes application children and dependency tools. Fixed storage uses the existing preallocated ext4 volume and quota checks.

The sandbox shares the host network; it is not a separate network namespace or a network access policy. Vortex reserves one TCP port and measures traffic for the configured ports. Use **Settings → Network access** to review and explicitly apply the application's tagged UFW rules. Vortex does not enable UFW, change unrelated SSH/web rules, or configure a provider firewall/NAT. Public reachability must be checked separately.

## Files and recovery

Stop an application before browsing, editing, uploading or downloading its workspace files. Live console and resource measurements remain available. Application backup creation and restore also require it to be stopped; existing backup metadata and archive downloads remain available according to permissions.

Application backups preserve project files, data and configuration files. Startup, entrypoint and environment settings stay in the panel and are not contained in source archives; restoring preserves the current application settings. Archives omit generated `node_modules/`, `.venv/` and `.home/` dependencies/caches. After restoring, use **Reinstall dependencies** before starting. Keep manifests and lockfiles in the project. Python virtual environments are not portable copies, so source recovery rebuilds them rather than restoring an old environment directory. Application cloning is not supported in this release.

## Tiếng Việt

Ứng dụng Node.js/Python hỗ trợ native trên Ubuntu x86-64 và ARM64. Chọn **Tạo → Node.js/Python**, VPS và tài nguyên. VPS tự cấp cổng TCP trống ngẫu nhiên; tùy chọn nâng cao cho phép nhập cổng riêng. Ứng dụng mới tự tra bản ổn định mới nhất từ Node.js/Python chính thức và ghim bản đó riêng cho server. Server cũ giữ nguyên runtime/cấu hình đang có; không tự nâng cấp. Python được biên dịch không có quyền root trong volume/cgroup tạm có giới hạn, nên lần cài đầu có thể lâu hơn. Màn hình dự án có manifest, script, danh sách gói và trạng thái cài thư viện; ứng dụng đang chạy chỉ hiển thị bản kiểm tra đã lưu có nhãn rõ. Ứng dụng web dùng `PORT` và lắng nghe trên `0.0.0.0`. Mỗi ô tham số là một phần tử riêng. Bot/tác vụ nền chọn kiểm tra tiến trình; ứng dụng web có thể kiểm tra cổng TCP.

Ứng dụng và công cụ cài thư viện chạy trong sandbox không có quyền root, cùng giới hạn CPU/RAM/đĩa và tối đa 128 tiến trình. Mạng vẫn dùng chung host. Dừng ứng dụng để thao tác tệp, sửa khởi chạy, cài thư viện hoặc tạo/khôi phục bản sao. Biến bí mật giữ nguyên khi không nhập lại; **Xóa giá trị** là thao tác xóa rõ ràng. Sao lưu chứa tệp dự án, dữ liệu và tệp cấu hình, không kèm `node_modules`, `.venv`, `.home`; cài lại thư viện sau khôi phục. Thiết lập khởi chạy và biến môi trường lưu tại panel, không nằm trong ZIP; khôi phục giữ nguyên thiết lập ứng dụng hiện tại. Chưa hỗ trợ nhân bản ứng dụng.

## Primary references

Architecture availability follows the [official Node.js platform list](https://github.com/nodejs/node/blob/main/BUILDING.md#platform-list) and [CPython build configuration](https://docs.python.org/3/using/configure.html). Runtime artifact URLs and checksums are resolved from those publishers at creation time.

The startup/variable separation was informed by [Pterodactyl egg variables](https://docs.pterodactyl.io/v1/guides/egg-creation/egg-variables). Vortex uses its own typed application settings and does not import arbitrary egg startup commands. Dependency behavior follows the official [npm ci documentation](https://docs.npmjs.com/cli/commands/npm-ci/) and [Python venv documentation](https://docs.python.org/3/library/venv.html). The filesystem/namespace implementation uses [Bubblewrap's documented primitives](https://github.com/containers/bubblewrap); Bubblewrap alone is not a complete security policy, so the actual bindings, identity, environment and cgroup checks remain part of Vortex's implementation.
