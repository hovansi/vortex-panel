import { createHash } from 'node:crypto';

export const APPLICATION_KINDS = Object.freeze(['bedrock', 'nodejs', 'python']);
export const APPLICATION_LIMITS = Object.freeze({ entrypoint: 240, component: 80, args: 32, argument: 1024, environment: 64, environmentValue: 4096, environmentBytes: 32768 });
const messages = Object.freeze({
  APPLICATION_INPUT: ['Application settings are invalid.', 'Thiết lập ứng dụng không hợp lệ.'],
  APPLICATION_ENTRYPOINT: ['Choose a relative JavaScript or Python entrypoint inside the application workspace.', 'Chọn tệp JavaScript hoặc Python tương đối bên trong thư mục ứng dụng.'],
  APPLICATION_ARGUMENTS: ['Application arguments exceed the supported limits or contain control characters.', 'Tham số ứng dụng vượt giới hạn hỗ trợ hoặc chứa ký tự điều khiển.'],
  APPLICATION_ENVIRONMENT: ['Application environment names or values are invalid, reserved, duplicated or too large.', 'Tên hoặc giá trị biến môi trường không hợp lệ, dành riêng, bị trùng hoặc quá lớn.'],
  APPLICATION_SECRET_MISSING: ['A new or renamed secret environment variable requires an explicit value.', 'Biến môi trường bí mật mới hoặc được đổi tên cần có giá trị rõ ràng.'],
  APPLICATION_UNSUPPORTED: ['Application isolation requires Linux root, trusted runtimes, setpriv and a working non-root bubblewrap sandbox. No application was launched.', 'Cách ly ứng dụng cần Linux root, runtime tin cậy, setpriv và sandbox bubblewrap không có quyền root hoạt động. Chưa chạy ứng dụng.'],
  APPLICATION_PATH: ['The application workspace, runtime or ownership path is unsafe or has changed.', 'Đường dẫn ứng dụng, runtime hoặc bản ghi sở hữu không an toàn hoặc đã thay đổi.'],
  APPLICATION_ACCOUNT: ['The dedicated application account could not be verified. Existing accounts were preserved.', 'Không xác minh được tài khoản riêng của ứng dụng. Các tài khoản hiện có được giữ lại.'],
  APPLICATION_BUSY: ['Stop the application and wait for its processes to exit before changing its workspace.', 'Dừng ứng dụng và chờ các tiến trình thoát trước khi thay đổi thư mục làm việc.'],
  APPLICATION_ENTRYPOINT_MISSING: ['The configured application entrypoint does not exist as a regular file.', 'Tệp khởi chạy đã cấu hình không tồn tại dưới dạng tệp thường.'],
  APPLICATION_STARTUP_SCRIPT: ['The selected npm script is missing from package.json. Declare that script in this project before starting it.', 'Script npm đã chọn không có trong package.json. Khai báo script trong dự án trước khi khởi chạy.'],
  APPLICATION_DEPENDENCIES: ['Dependency installation did not complete. Review the application log; it is not retried automatically.', 'Cài đặt thư viện chưa hoàn tất. Xem log ứng dụng; panel không tự thử lại.'],
  APPLICATION_SIGNAL: ['A graceful application signal could not be verified for this owned process. No unrelated process was signaled.', 'Không xác minh được tín hiệu dừng nhẹ cho tiến trình ứng dụng này. Không gửi tín hiệu tới tiến trình không liên quan.'],
  APPLICATION_CLOSED: ['The application runtime is shutting down.', 'Bộ quản lý ứng dụng đang tắt.'],
  APPLICATION_RUNTIME_CATALOG: ['The latest stable runtime could not be verified with the official publisher. No older runtime was selected.', 'Không xác minh được runtime ổn định mới nhất từ nhà phát hành chính thức. Không tự chọn bản cũ.'],
  APPLICATION_RUNTIME_PLATFORM: ['Managed application runtimes require Ubuntu/Linux x64 or arm64.', 'Runtime ứng dụng được quản lý cần Ubuntu/Linux x64 hoặc arm64.'],
  APPLICATION_RUNTIME_ARTIFACT_UNAVAILABLE: ['The newest stable release has no official Linux artifact for this VPS architecture. No older runtime was selected.', 'Bản ổn định mới nhất chưa có gói Linux chính thức cho kiến trúc VPS này. Không tự chọn runtime cũ.'],
  APPLICATION_RUNTIME_PIN: ['The exact application runtime pin is invalid or incompatible with this VPS.', 'Bản ghim runtime của ứng dụng không hợp lệ hoặc không tương thích với VPS này.'],
  APPLICATION_RUNTIME_DOWNLOAD: ['The official runtime download or SHA-256 verification failed. The runtime was not installed.', 'Tải runtime chính thức hoặc xác minh SHA-256 thất bại. Chưa cài runtime.'],
  APPLICATION_RUNTIME_BUILD: ['The managed runtime build did not complete. Review the task output and build prerequisites; no host interpreter was replaced.', 'Biên dịch runtime được quản lý chưa hoàn tất. Xem đầu ra tác vụ và công cụ cần thiết; không thay interpreter của hệ thống.'],
  APPLICATION_RUNTIME_TOOLS: ['Python source builds require trusted GCC, make, pkg-config and development headers for OpenSSL, zlib, SQLite, bz2, xz, readline and libffi. Install the documented Ubuntu build prerequisites first.', 'Biên dịch Python cần GCC, make, pkg-config tin cậy và header phát triển OpenSSL, zlib, SQLite, bz2, xz, readline, libffi. Cài công cụ biên dịch Ubuntu theo tài liệu trước.'],
  APPLICATION_RUNTIME_CLEANUP: ['A previous runtime build requires verified cleanup. New allocations are blocked until its owned processes and temporary volume are resolved.', 'Bản dựng runtime trước cần xác minh dọn dẹp. Chặn cấp phát mới cho tới khi xử lý các tiến trình sở hữu và volume tạm.'],
  APPLICATION_MANAGED_NODE_REQUIRED: ['Update this node and install the application build prerequisites before creating an application with a pinned latest runtime.', 'Cập nhật node này và cài công cụ biên dịch trước khi tạo ứng dụng với runtime mới nhất được ghim.'],
});
export const APPLICATION_MESSAGES = Object.freeze(Object.entries(messages).map(([code, [en, vi]]) => Object.freeze({ id: `panel.application.${code.toLowerCase()}`, en, vi })));
export function applicationIssue(code, status = 409, extra = {}) {
  const [en, vi] = messages[code];
  return Object.assign(new Error(en), { code, status, errorI18n: { id: `panel.application.${code.toLowerCase()}`, en, vi, params: [] }, ...extra });
}
export function applicationErrorPayload(error, language = 'en') {
  if (typeof error?.code !== 'string' || !Object.hasOwn(messages, error.code)) return null;
  const [en, vi] = messages[error.code];
  return { error: language === 'vi' ? vi : en, code: error.code, errorI18n: { id: `panel.application.${error.code.toLowerCase()}`, en, vi, params: [] }, ...(error.cleanupPending ? { cleanupPending: error.cleanupPending } : {}) };
}
const object = (value, keys, code) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw applicationIssue(code, 400); };
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const RESERVED = new Set(['PORT', 'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'TMP', 'TEMP', 'ENV', 'BASH_ENV', 'IFS', 'CDPATH', 'SHELLOPTS', 'GLOBIGNORE', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONINSPECT', 'PYTHONBREAKPOINT']);
export function applicationEnvironmentNameAllowed(name) { return typeof name === 'string' && /^[A-Z_][A-Z0-9_]{0,63}$/.test(name) && !RESERVED.has(name) && !/^(?:VORTEX_|BEDROCK_|LD_|DYLD_)/.test(name); }
export function applicationKind(value) {
  const kind = typeof value === 'object' && value !== null ? value.kind : value;
  if (kind === undefined || kind === null) return 'bedrock';
  if (!APPLICATION_KINDS.includes(kind)) throw applicationIssue('APPLICATION_INPUT', 400);
  return kind;
}
export const isApplication = value => ['nodejs', 'python'].includes(applicationKind(value));
export function applicationEntrypointAllowed(value, kind) {
  if (typeof value !== 'string' || !value || value.length > APPLICATION_LIMITS.entrypoint || !/^[A-Za-z0-9_./-]+$/.test(value)) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part.length > APPLICATION_LIMITS.component || part.startsWith('.')) || parts[0] === 'node_modules') return false;
  return kind === 'nodejs' ? /\.(?:js|mjs|cjs)$/.test(value) : kind === 'python' && /\.py$/.test(value);
}
export function normalizeApplication(input, { kind, previous } = {}) {
  kind = applicationKind(kind);
  if (kind === 'bedrock') { if (input !== undefined && input !== null) throw applicationIssue('APPLICATION_INPUT', 400); return null; }
  input ??= {};
  object(input, ['entrypoint', 'args', 'environment', 'dependencies', 'readiness', 'startup'], 'APPLICATION_INPUT');
  let startup;
  if (input.startup !== undefined) {
    object(input.startup, ['mode', 'script', 'module'], 'APPLICATION_INPUT');
    const { mode, script, module } = input.startup;
    if (mode === 'entrypoint' && script === undefined && module === undefined) startup = { mode };
    else if (kind === 'nodejs' && mode === 'npm-script' && typeof script === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(script) && module === undefined) startup = { mode, script };
    else if (kind === 'python' && mode === 'python-module' && typeof module === 'string' && module.length <= 200 && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module) && script === undefined) startup = { mode, module };
    else throw applicationIssue('APPLICATION_INPUT', 400);
  }
  const entrypoint = input.entrypoint ?? (kind === 'nodejs' ? 'server.js' : 'app.py');
  if (!applicationEntrypointAllowed(entrypoint, kind)) throw applicationIssue('APPLICATION_ENTRYPOINT', 400);
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.length > APPLICATION_LIMITS.args || args.some(value => typeof value !== 'string' || !value.isWellFormed() || value.length > APPLICATION_LIMITS.argument || controls.test(value))) throw applicationIssue('APPLICATION_ARGUMENTS', 400);
  const environment = input.environment ?? [], prior = new Map((previous?.environment || []).map(row => [row.name, row]));
  if (!Array.isArray(environment) || environment.length > APPLICATION_LIMITS.environment) throw applicationIssue('APPLICATION_ENVIRONMENT', 400);
  const names = new Set(); let bytes = 0;
  const normalized = environment.map(row => {
    object(row, ['name', 'value', 'secret'], 'APPLICATION_ENVIRONMENT');
    const secret = row.secret ?? false;
    if (!applicationEnvironmentNameAllowed(row.name) || typeof secret !== 'boolean' || names.has(row.name)) throw applicationIssue('APPLICATION_ENVIRONMENT', 400);
    names.add(row.name); let value = row.value;
    if (!Object.hasOwn(row, 'value')) {
      if (secret && prior.get(row.name)?.secret === true && typeof prior.get(row.name).value === 'string') value = prior.get(row.name).value;
      else throw applicationIssue('APPLICATION_SECRET_MISSING', 400);
    }
    if (typeof value !== 'string' || !value.isWellFormed() || value.length > APPLICATION_LIMITS.environmentValue || controls.test(value)) throw applicationIssue('APPLICATION_ENVIRONMENT', 400);
    bytes += Buffer.byteLength(row.name) + Buffer.byteLength(value);
    if (bytes > APPLICATION_LIMITS.environmentBytes) throw applicationIssue('APPLICATION_ENVIRONMENT', 400);
    return { name: row.name, value, secret };
  });
  const dependencies = input.dependencies ?? 'auto', readiness = input.readiness ?? 'tcp';
  if (!['none', 'auto'].includes(dependencies) || !['tcp', 'process'].includes(readiness)) throw applicationIssue('APPLICATION_INPUT', 400);
  return { entrypoint, args: [...args], environment: normalized, dependencies, readiness, ...(startup ? { startup } : {}) };
}
export function publicApplication(value) {
  if (!value) return null;
  return { entrypoint: value.entrypoint, args: [...value.args], dependencies: value.dependencies, readiness: value.readiness, ...(value.startup ? { startup: { ...value.startup } } : {}), environment: value.environment.map(({ name, value, secret }) => ({ name, value: secret ? null : value, secret, hasValue: value.length > 0 })) };
}
export function applicationRevision(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function redactApplicationOutput(value, application) {
  let result = String(value);
  const secrets = [...new Set((application?.environment || []).filter(row => row.secret && row.value).map(row => row.value))].sort((a, b) => b.length - a.length);
  // A bounded line may end in only a prefix of a secret. It cannot safely be
  // compared with complete values after truncation, so discard that line.
  if (secrets.length && result.endsWith(' … [truncated]')) return '[redacted truncated application output]';
  for (const secret of secrets) result = result.replaceAll(secret, '[redacted]');
  return result;
}
export function applicationEnvironment(application, { port, username, install = false, nodeDirectory = '/usr/bin' } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof username !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username)) throw applicationIssue('APPLICATION_INPUT', 400);
  const env = { PATH: `${nodeDirectory}:/usr/local/bin:/usr/bin:/bin`, HOME: '/workspace/.home', USER: username, LOGNAME: username, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: '/tmp', PORT: String(port), NODE_ENV: install ? 'development' : 'production', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', npm_config_cache: '/workspace/.home/.npm', PIP_CACHE_DIR: '/workspace/.home/.cache/pip' };
  if (!install) for (const row of application.environment) env[row.name] = row.value;
  return env;
}
export function applicationStarterSources(kind) {
  kind = applicationKind(kind);
  if (kind === 'nodejs') return { 'server.js': "const http = require('node:http');\nconst server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Vortex Node.js application is running.\\n'); });\nserver.listen(Number(process.env.PORT), '0.0.0.0', () => console.log('Application listening on PORT'));\nprocess.on('SIGTERM', () => server.close(() => process.exit(0)));\n", 'package.json': '{\n  "name": "vortex-application",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "start": "node server.js" }\n}\n' };
  if (kind === 'python') return { 'app.py': "import os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\n\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        body = b'Vortex Python application is running.\\n'\n        self.send_response(200)\n        self.send_header('Content-Type', 'text/plain; charset=utf-8')\n        self.send_header('Content-Length', str(len(body)))\n        self.end_headers()\n        self.wfile.write(body)\n\nHTTPServer(('0.0.0.0', int(os.environ['PORT'])), Handler).serve_forever()\n", 'requirements.txt': '# Add Python packages here, then install dependencies while stopped.\n' };
  throw applicationIssue('APPLICATION_INPUT', 400);
}
