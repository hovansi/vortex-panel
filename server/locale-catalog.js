// Canonical panel messages only. Parameters are opaque unless explicitly marked as
// nested panel errors/phrases. Never apply this catalog to user content or native output.
import { RESOURCE_CONTROL_MESSAGES } from './resource-control-messages.js';
import { RESOURCE_EXIT_MESSAGES } from './resource-exit.js';
import { GAMEPLAY_MESSAGES } from './gameplay-messages.js';
import { CAPACITY_MESSAGES } from './capacity.js';
import { STORAGE_MESSAGES } from './storage-volumes.js';
import { HOSTNAME_MESSAGES } from './hostname.js';
import { BACKUP_MESSAGES } from './backup-messages.js';
import { POWER_MESSAGES } from './system-power.js';
import { ZRAM_MESSAGES } from './host-zram.js';
import { REMOVAL_MESSAGES } from './node-removal.js';
import { PANEL_REMOVAL_MESSAGES } from './panel-removal.js';
import { APPLICATION_MESSAGES } from './application-runtime.js';
import { PORT_ALLOCATION_MESSAGES } from './port-allocation.js';
import { WORLD_OPERATIONS_MESSAGES } from './world-experiments.js';
import { TIMEZONE_MESSAGES } from './host-timezone.js';
import { NETWORK_TUNING_MESSAGES } from './host-network-tuning.js';
import { TLS_MESSAGES } from './host-tls.js';
import { BEDROCK_PLATFORM_MESSAGE } from '../public/runtime-platform.js';
import { BEDROCK_RUNTIME_MESSAGES } from './bedrock-runtime.js';
import { BEDROCK_PORT_WAIT_MESSAGES } from './bedrock-port-wait.js';
export const PANEL_MESSAGES = Object.freeze([
  { id: 'panel.ports.panel-reserved', vi: 'Cổng TCP {0} được dành cho truy cập panel. Chọn cổng khác.', en: 'TCP port {0} is reserved for panel access. Choose another port.' },
  BEDROCK_PLATFORM_MESSAGE,
  ...BEDROCK_RUNTIME_MESSAGES,
  ...BEDROCK_PORT_WAIT_MESSAGES,
  { id: 'panel.host.maintenance', vi: 'Đang áp dụng thay đổi hệ thống. Hãy chờ hoàn tất.', en: 'System changes are being applied. Wait for completion.' },
  { id: 'panel.host.realadmin', vi: 'Thao tác hệ thống cần tài khoản quản trị thật.', en: 'System changes require a real administrator account.' },
  { id: 'panel.node.uninstallrequired', vi: 'Cần gỡ Vortex và xác minh kết quả trước khi ngắt quản lý VPS.', en: 'Uninstall Vortex and verify the result before disconnecting this VPS.' },
  { id: 'panel.power.maintenance', vi: 'Hệ thống đang chuẩn bị khởi động lại; vui lòng chờ kết nối trở lại.', en: 'The system is preparing to restart. Wait for it to reconnect.' },
  { id: 'panel.power.managerbusy', vi: 'Đang có tác vụ chưa hoàn tất. Chờ hoàn tất trước khi khởi động lại hệ thống.', en: 'An operation is still running. Wait for it to finish before restarting the system.' },
  { id: 'panel.power.managerinput', vi: 'Yêu cầu khởi động lại không hợp lệ.', en: 'Invalid restart request.' },
  { id: 'panel.fileaccess.real', vi: 'Chế độ can thiệp mạnh cần tài khoản quản trị thật.', en: 'Advanced file access requires a real administrator account.' },
  { id: 'panel.fileaccess.confirm', vi: 'Cần xác nhận cảnh báo trước khi bật can thiệp mạnh.', en: 'Confirm the risk warning before enabling advanced file access.' },
  { id: 'panel.fileaccess.server', vi: 'Máy chủ không hợp lệ.', en: 'Invalid server.' },
  { id: 'panel.files.liveworld', vi: 'Dữ liệu thế giới đang được sử dụng. Tạo bản sao lưu trực tiếp hoặc dừng máy chủ để chỉnh sửa.', en: 'The world is in use. Create an online backup or stop the server before changing its files.' },
  { id: 'panel.files.liveconfig', vi: 'Dừng máy chủ trước khi thay đổi tệp cấu hình đang được sử dụng.', en: 'Stop the server before changing configuration files that are in use.' },
  { id: 'panel.files.transition', vi: 'Chờ máy chủ hoàn tất khởi động hoặc dừng trước khi thao tác tệp.', en: 'Wait for the server to finish starting or stopping before changing files.' },
  ...POWER_MESSAGES,
  ...ZRAM_MESSAGES,
  ...TIMEZONE_MESSAGES,
  ...NETWORK_TUNING_MESSAGES,
  ...TLS_MESSAGES,
  ...REMOVAL_MESSAGES,
  ...PANEL_REMOVAL_MESSAGES,
  ...APPLICATION_MESSAGES,
  { id: 'panel.application.runtime.pinned', vi: 'Đã ghim runtime chính thức {0} {1}', en: 'Pinned official {0} {1}' },
  { id: 'panel.application.runtime.prepare', vi: 'Đang chuẩn bị runtime đã ghim', en: 'Preparing the exact managed runtime' },
  { id: 'panel.application.runtime.build', vi: 'Đang biên dịch mã nguồn Python chính thức; có thể mất vài phút', en: 'Building official Python source; this may take several minutes' },
  ...PORT_ALLOCATION_MESSAGES,
  ...WORLD_OPERATIONS_MESSAGES,
  ...RESOURCE_EXIT_MESSAGES,
  {"id": "panel.application.manager.native", "en": "Application servers require a native Linux node.", "vi": "Server ứng dụng cần node Linux thực."},
  {"id": "panel.application.manager.startup-kind", "en": "Application startup settings are available for Python and Node.js servers only.", "vi": "Thiết lập khởi chạy ứng dụng chỉ dành cho server Python và Node.js."},
  {"id": "panel.application.manager.settings", "en": "Invalid application server settings.", "vi": "Thiết lập server ứng dụng không hợp lệ."},
  {"id": "panel.application.manager.configuration", "en": "Invalid application configuration request.", "vi": "Yêu cầu cấu hình ứng dụng không hợp lệ."},
  {"id": "panel.application.manager.creation", "en": "Invalid application creation request.", "vi": "Yêu cầu tạo ứng dụng không hợp lệ."},
  {"id": "panel.application.manager.stale", "en": "Application settings changed. Reload before saving.", "vi": "Thiết lập ứng dụng đã thay đổi. Tải lại trước khi lưu."},
  {"id": "panel.application.manager.bedrock-only", "en": "This tool is available for Minecraft Bedrock servers only.", "vi": "Công cụ này chỉ dành cho server Minecraft Bedrock."},
  {"id": "panel.application.manager.clone", "en": "Application cloning is not available. Create a new application and restore its source files.", "vi": "Chưa hỗ trợ nhân bản ứng dụng. Tạo ứng dụng mới và khôi phục tệp mã nguồn."},
  {"id": "panel.application.manager.generated", "en": "Generated dependencies and caches are managed by the dependency installer.", "vi": "Thư viện và bộ nhớ đệm được quản lý bằng công cụ cài thư viện."},
  {"id": "panel.application.manager.backup-kind", "en": "Backup runtime type does not match this server.", "vi": "Loại runtime của bản sao lưu không khớp server này."},
  {"id": "panel.application.manager.download-type", "en": "Only regular application files can be downloaded.", "vi": "Chỉ tải xuống tệp ứng dụng thông thường."},
  {"id": "panel.application.manager.download-size", "en": "Application file downloads are limited to 100 MiB.", "vi": "Tệp ứng dụng tải xuống được giới hạn 100 MiB."},
  {"id": "panel.application.manager.download-changed", "en": "The application file changed during download.", "vi": "Tệp ứng dụng đã thay đổi trong khi tải xuống."},
  {"id": "panel.application.manager.storage", "en": "Preparing application storage", "vi": "Đang chuẩn bị lưu trữ ứng dụng"},
  {"id": "panel.application.manager.workspace", "en": "Creating isolated application workspace", "vi": "Đang tạo môi trường ứng dụng riêng"},
  {"id": "panel.application.manager.dependencies", "en": "Installing application dependencies", "vi": "Đang cài thư viện ứng dụng"},
  {"id": "panel.application.manager.complete", "en": "Application workspace is ready", "vi": "Môi trường ứng dụng đã sẵn sàng"},
  {"id": "panel.application.manager.prepare-dependencies", "en": "Preparing dependency installation", "vi": "Đang chuẩn bị cài thư viện"},
  {"id": "panel.application.manager.dependencies-complete", "en": "Dependency installation completed", "vi": "Cài đặt thư viện hoàn tất"},
  {"id": "panel.application.manager.timeout", "en": "Application did not become ready within 30 seconds.", "vi": "Ứng dụng chưa sẵn sàng sau 30 giây."},
  {"id": "panel.application.manager.ready-process", "en": "Application process is running; network readiness was not requested.", "vi": "Tiến trình ứng dụng đang chạy; không yêu cầu kiểm tra sẵn sàng qua mạng."},
  {"id": "panel.application.manager.ready-tcp", "en": "Application is listening on TCP {0}.", "vi": "Ứng dụng đang lắng nghe tại cổng TCP {0}."},
  {"id": "panel.application.manager.started", "en": "Started {0} PID {1}; checking readiness.", "vi": "Đã chạy {0} PID {1}; đang kiểm tra trạng thái sẵn sàng."},
  {"id": "panel.application.manager.signaled", "en": "Sent SIGTERM to the verified application process; waiting for shutdown.", "vi": "Đã gửi SIGTERM đến tiến trình ứng dụng đã xác minh; đang chờ dừng."},
  {"id": "panel.application.manager.stop-sandbox", "en": "Application process was not available for a verified graceful signal; stopping its sandbox.", "vi": "Không xác minh được tiến trình ứng dụng để dừng nhẹ nhàng; đang dừng sandbox."},
  {"id": "panel.application.manager.stop-timeout", "en": "Application did not stop within 30 seconds; sending SIGKILL.", "vi": "Ứng dụng chưa dừng sau 30 giây; đang gửi SIGKILL."},
  {"id": "panel.application.manager.metrics", "en": "Application cgroup usage is unavailable.", "vi": "Chưa lấy được mức sử dụng tài nguyên cgroup của ứng dụng."},
  { id: 'panel.application.bedrock-only', en: 'This operation is only available for Minecraft Bedrock servers.', vi: 'Thao tác này chỉ dành cho server Minecraft Bedrock.' },
  { id: 'panel.application.network-input', en: 'Application servers accept one TCP port and no Bedrock UDP, IPv6-port or debugger settings.', vi: 'Server ứng dụng chỉ nhận một cổng TCP, không nhận thiết lập UDP, cổng IPv6 riêng hoặc debugger Bedrock.' },
  { id: 'panel.application.kind-input', en: 'Unsupported server kind.', vi: 'Loại server không được hỗ trợ.' },
  ...BACKUP_MESSAGES,
  ...RESOURCE_CONTROL_MESSAGES,
  ...GAMEPLAY_MESSAGES,
  ...CAPACITY_MESSAGES,
  ...STORAGE_MESSAGES,
  ...HOSTNAME_MESSAGES,
  { id: 'panel.storage.allocate', vi: 'Đang cấp phát volume lưu trữ máy chủ', en: 'Allocating the server storage volume' },
  { id: 'panel.storage.grow', vi: 'Đang tăng volume lưu trữ máy chủ', en: 'Growing the server storage volume' },
  { id: 'panel.storage.ready', vi: 'Volume lưu trữ đã sẵn sàng', en: 'Storage volume is ready' },
  { id: 'panel.storage.pending', vi: 'Cần hoàn tất tăng dung lượng trước khi khởi động máy chủ này.', en: 'Storage growth must finish before this server can start.' },
  { id: 'panel.storage.native', vi: 'Tăng dung lượng cần máy chủ native.', en: 'Storage growth requires a native server.' },
  { id: 'panel.storage.legacy', vi: 'Máy chủ cũ này chưa có volume lưu trữ giới hạn riêng.', en: 'This legacy server has no fixed storage volume.' },
  { id: 'panel.storage.fields', vi: 'Yêu cầu tăng dung lượng chỉ chấp nhận diskGiB.', en: 'Storage growth requires only diskGiB.' },
  { id: 'panel.storage.shrink', vi: 'Volume lưu trữ chỉ có thể tăng dung lượng.', en: 'Storage volumes can only grow.' },
  {
    "id": "panel.9396475d5314",
    "vi": "Thao tác này cần quyền quản trị viên.",
    "en": "This action requires an administrator."
  },
  {
    "id": "panel.1d78c532e5a1",
    "vi": "Đường dẫn ZIP quá dài hoặc quá sâu.",
    "en": "The ZIP path is too long or too deeply nested."
  },
  {
    "id": "panel.e7e28ef9be69",
    "vi": "ZIP có tên không hợp lệ trên filesystem Windows.",
    "en": "The ZIP contains a name that is invalid on Windows filesystems."
  },
  {
    "id": "panel.e91cafd2f1c1",
    "vi": "ZIP chứa đường dẫn không an toàn; không cho phép traversal hoặc đường dẫn tuyệt đối.",
    "en": "The ZIP contains an unsafe path; traversal and absolute paths are not allowed."
  },
  {
    "id": "panel.762bbca20b3c",
    "vi": "ZIP không hợp lệ hoặc chưa được hỗ trợ: {0}",
    "en": "The ZIP is invalid or unsupported: {0}",
    "nested": []
  },
  {
    "id": "panel.e95e52b0744e",
    "vi": "Không giải nén vào liên kết tượng trưng.",
    "en": "Cannot extract into a symbolic link."
  },
  {
    "id": "panel.398cd5dc9016",
    "vi": "ZIP có quá nhiều tệp hoặc đường dẫn trùng lặp.",
    "en": "The ZIP contains too many files or duplicate paths."
  },
  {
    "id": "panel.880b2817de34",
    "vi": "ZIP có xung đột tệp và thư mục.",
    "en": "The ZIP contains a file and directory conflict."
  },
  {
    "id": "panel.fced529cb7bf",
    "vi": "ZIP vượt giới hạn số tệp và thư mục, kể cả thư mục cha ngầm định.",
    "en": "The ZIP exceeds the file and directory limit, including implicit parent directories."
  },
  {
    "id": "panel.2396df0ecc40",
    "vi": "ZIP chứa tệp mã hóa, liên kết hoặc tệp đặc biệt.",
    "en": "The ZIP contains encrypted files, links, or special files."
  },
  {
    "id": "panel.a4f1272ae02f",
    "vi": "ZIP có loại tệp/thư mục không khớp đường dẫn.",
    "en": "The ZIP entry type does not match its path."
  },
  {
    "id": "panel.1083164fbd04",
    "vi": "ZIP có dữ liệu thư mục không hợp lệ.",
    "en": "The ZIP contains invalid directory data."
  },
  {
    "id": "panel.bf51f1d50195",
    "vi": "ZIP vượt quá giới hạn giải nén {0} MiB.",
    "en": "The ZIP exceeds the extraction limit of {0} MiB."
  },
  {
    "id": "panel.f794e4f1ad51",
    "vi": "ZIP vượt giới hạn kích thước.",
    "en": "The ZIP exceeds the size limit."
  },
  {
    "id": "panel.3a8726e408b9",
    "vi": "ZIP hỏng: CRC-32 hoặc kích thước không khớp cho {0}.",
    "en": "The ZIP is corrupt: CRC-32 or size mismatch for {0}."
  },
  {
    "id": "panel.a13ab92f2442",
    "vi": "ZIP phải chứa bedrock_server Linux ở thư mục gốc.",
    "en": "The ZIP must contain the Linux bedrock_server executable at its root."
  },
  {
    "id": "panel.6d289d63dc92",
    "vi": "Gói Bedrock phải là bản Linux x86-64 (ELF).",
    "en": "The Bedrock package must be Linux x86-64 (ELF)."
  },
  {
    "id": "panel.349209bcb346",
    "vi": "ZIP thiếu server.properties hợp lệ (tối đa 256 KiB).",
    "en": "The ZIP is missing a valid server.properties file (maximum 256 KiB)."
  },
  {
    "id": "panel.eabee2499978",
    "vi": "Thư mục ZIP quá sâu.",
    "en": "The ZIP directory is too deeply nested."
  },
  {
    "id": "panel.3394204b2a39",
    "vi": "Server chứa liên kết tượng trưng; không thể nén an toàn.",
    "en": "The server contains symbolic links and cannot be safely compressed."
  },
  {
    "id": "panel.9c5f98813432",
    "vi": "Server chứa tệp đặc biệt; không thể nén an toàn.",
    "en": "The server contains special files and cannot be safely compressed."
  },
  {
    "id": "panel.f25ff93cb7dd",
    "vi": "Dữ liệu ZIP vượt giới hạn {0} mục; mặc định 50.000 mục.",
    "en": "The ZIP data exceeds the limit of {0} entries; the default is 50,000."
  },
  {
    "id": "panel.294a76842b3c",
    "vi": "Dữ liệu ZIP vượt giới hạn {0} byte.",
    "en": "The ZIP data exceeds the limit of {0} bytes."
  },
  {
    "id": "panel.4f922cc0fb46",
    "vi": "Mật khẩu cần từ 12 đến 128 ký tự.",
    "en": "The password must contain 12 to 128 characters."
  },
  {
    "id": "panel.cb02d8007024",
    "vi": "Tên tài khoản: 3–32 ký tự, chữ, số, dấu chấm hoặc gạch.",
    "en": "The username must contain 3–32 letters, numbers, dots, hyphens, or underscores."
  },
  {
    "id": "panel.61fffa3f4014",
    "vi": "Thử lại sau 15 phút.",
    "en": "Try again in 15 minutes."
  },
  {
    "id": "panel.4945eaab8ab0",
    "vi": "Origin không hợp lệ.",
    "en": "Invalid origin."
  },
  {
    "id": "panel.dd39c3673319",
    "vi": "Vui lòng đăng nhập.",
    "en": "Please sign in."
  },
  {
    "id": "panel.4a2438fb72b1",
    "vi": "Phiên bảo mật hết hạn. Tải lại trang.",
    "en": "Your security session has expired. Reload the page."
  },
  {
    "id": "panel.8312c8a04c03",
    "vi": "Kho mã hóa MFA chưa được cấu hình trên máy chủ.",
    "en": "The encrypted MFA vault has not been configured on this host."
  },
  {
    "id": "panel.93172c66f75b",
    "vi": "Xác thực hai bước tạm khóa; thử lại sau 15 phút.",
    "en": "Two-factor authentication is temporarily locked. Try again in 15 minutes."
  },
  {
    "id": "panel.ca3d5aa890e8",
    "vi": "Mật khẩu hiện tại chưa đúng.",
    "en": "The current password is incorrect."
  },
  {
    "id": "panel.9b9f873f9852",
    "vi": "Phiên đăng nhập đã bị thu hồi.",
    "en": "Your session has been revoked."
  },
  {
    "id": "panel.2f2ee0c47314",
    "vi": "Vai trò phải là admin, operator hoặc viewer.",
    "en": "The role must be admin, operator, or viewer."
  },
  {
    "id": "panel.9c852e1fada1",
    "vi": "{0} phải là boolean.",
    "en": "{0} must be a boolean."
  },
  {
    "id": "panel.104665dad623",
    "vi": "Danh sách server được phân quyền không hợp lệ.",
    "en": "The list of assigned servers is invalid."
  },
  {
    "id": "panel.d9008d15bf70",
    "vi": "Không thể hạ quyền hoặc vô hiệu hóa tài khoản quản trị đang đăng nhập.",
    "en": "You cannot demote or disable the administrator account you are signed in with."
  },
  {
    "id": "panel.862419ab080e",
    "vi": "Panel cần ít nhất một quản trị viên đang hoạt động.",
    "en": "The panel requires at least one active administrator."
  },
  {
    "id": "panel.f284acaa5760",
    "vi": "Không tìm thấy chức năng này.",
    "en": "This feature was not found."
  },
  {
    "id": "panel.0b04eead179f",
    "vi": "Panel đã được thiết lập.",
    "en": "The panel has already been set up."
  },
  {
    "id": "panel.f464b602314e",
    "vi": "Mã thiết lập không hợp lệ. Xem terminal chạy panel.",
    "en": "Invalid setup token. Check the terminal running the panel."
  },
  {
    "id": "panel.dc1fb0100ab5",
    "vi": "Tạo tài khoản quản trị",
    "en": "Created an administrator account"
  },
  {
    "id": "panel.cf0b4ee189bc",
    "vi": "Tên tài khoản hoặc mật khẩu chưa đúng.",
    "en": "The username or password is incorrect."
  },
  {
    "id": "panel.9a402bdfdea7",
    "vi": "Đăng nhập",
    "en": "Signed in"
  },
  {
    "id": "panel.d04186b17f73",
    "vi": "Thử thách xác thực đã hết hạn. Đăng nhập lại.",
    "en": "The authentication challenge has expired. Sign in again."
  },
  {
    "id": "panel.0bbff96216fc",
    "vi": "Mã hai bước chưa đúng, đã dùng hoặc hết hạn. Chờ mã mới hoặc dùng mã khôi phục.",
    "en": "The two-factor code is incorrect, already used, or expired. Wait for a new code or use a recovery code."
  },
  {
    "id": "panel.884c00dac07d",
    "vi": "Đăng nhập với xác thực hai bước",
    "en": "Signed in with two-factor authentication"
  },
  {
    "id": "panel.4598a6662fd1",
    "vi": "Đổi mật khẩu",
    "en": "Changed password"
  },
  {
    "id": "panel.6a4256978ed3",
    "vi": "Xác thực hai bước đã được bật.",
    "en": "Two-factor authentication is already enabled."
  },
  {
    "id": "panel.9395680f1125",
    "vi": "Mã thiết lập đã hết hạn. Tạo lại mã QR.",
    "en": "The setup code has expired. Generate a new QR code."
  },
  {
    "id": "panel.4062a2d4c7a1",
    "vi": "Mã xác thực chưa đúng.",
    "en": "The authentication code is incorrect."
  },
  {
    "id": "panel.add1dd0cbcb2",
    "vi": "Bật xác thực hai bước",
    "en": "Enabled two-factor authentication"
  },
  {
    "id": "panel.de7e3251aae1",
    "vi": "Xác thực hai bước chưa được bật.",
    "en": "Two-factor authentication is not enabled."
  },
  {
    "id": "panel.e278da24f9fb",
    "vi": "Mã xác thực hoặc khôi phục chưa đúng.",
    "en": "The authentication or recovery code is incorrect."
  },
  {
    "id": "panel.dbf46a156c7b",
    "vi": "Tắt xác thực hai bước",
    "en": "Disabled two-factor authentication"
  },
  {
    "id": "panel.6d4a033196af",
    "vi": "Tạo lại mã khôi phục",
    "en": "Regenerated recovery codes"
  },
  {
    "id": "panel.bd9e04f6a25a",
    "vi": "Phiên quản trị đã bị thu hồi.",
    "en": "Your administrator session has been revoked."
  },
  {
    "id": "panel.2aa450e4e07a",
    "vi": "Panel hỗ trợ tối đa 100 tài khoản.",
    "en": "The panel supports up to 100 accounts."
  },
  {
    "id": "panel.972c0652f280",
    "vi": "Tên tài khoản đã tồn tại.",
    "en": "The username already exists."
  },
  {
    "id": "panel.62afe96d9593",
    "vi": "Không tìm thấy tài khoản.",
    "en": "Account not found."
  },
  {
    "id": "panel.88999ed15911",
    "vi": "Tắt MFA của bạn bằng mật khẩu và mã xác thực trong phần bảo mật.",
    "en": "Disable your MFA in Security using your password and an authentication code."
  },
  {
    "id": "panel.ca2cccfc384c",
    "vi": "Không có thay đổi tài khoản.",
    "en": "There are no account changes."
  },
  {
    "id": "panel.29e4acfd8bdc",
    "vi": "Không thể xóa tài khoản đang đăng nhập.",
    "en": "You cannot delete the account you are signed in with."
  },
  {
    "id": "panel.283ca3a4ecf5",
    "vi": "Thiết lập panel phải là đối tượng.",
    "en": "Panel settings must be an object."
  },
  {
    "id": "panel.bf99f48ed36d",
    "vi": "Thiết lập panel không hỗ trợ: {0}.",
    "en": "Unsupported panel setting: {0}."
  },
  {
    "id": "panel.eff6dab8105b",
    "vi": "Tên server phải từ 1–80 ký tự, không chứa ký tự điều khiển.",
    "en": "The server name must contain 1–80 characters and no control characters."
  },
  {
    "id": "panel.6301adc76f52",
    "vi": "Số bản sao lưu giữ lại phải từ 1–50.",
    "en": "Backup retention must be between 1 and 50."
  },
  {
    "id": "panel.ad1fabffb500",
    "vi": "{0} phải là true hoặc false.",
    "en": "{0} must be true or false."
  },
  {
    "id": "panel.e910b0834877",
    "vi": "{0} phải là {1}.",
    "en": "{0} must be {1}."
  },
  {
    "id": "panel.715f1db09db6",
    "vi": "{0} phải là số nguyên từ {1}–{2}.",
    "en": "{0} must be an integer between {1} and {2}."
  },
  {
    "id": "panel.e013b21b43b4",
    "vi": "Tên thế giới không hợp lệ cho thư mục: tối đa 255 byte, không chứa ký tự điều khiển hoặc ký tự đặc biệt.",
    "en": "The world folder name is invalid: maximum 255 bytes, with no control or special characters."
  },
  {
    "id": "panel.9eeaeafa5b48",
    "vi": "server-name không được chứa dấu chấm phẩy.",
    "en": "server-name cannot contain a semicolon."
  },
  {
    "id": "panel.2c5ea5bcf1c2",
    "vi": "{0} vượt khoảng giá trị hợp lệ.",
    "en": "{0} is outside its valid range."
  },
  {
    "id": "panel.0e8856d8404d",
    "vi": "server-build-radius-ratio phải là Disabled hoặc số từ 0–1.",
    "en": "server-build-radius-ratio must be Disabled or a number between 0 and 1."
  },
  {
    "id": "panel.96b962205f1d",
    "vi": "Panel đa server cần enable-lan-visibility=false để giữ cổng riêng.",
    "en": "A panel with multiple servers requires enable-lan-visibility=false to keep ports separate."
  },
  {
    "id": "panel.e37f05478d95",
    "vi": "Allowlist cần online-mode=true để xác thực người chơi.",
    "en": "The allowlist requires online-mode=true to authenticate players."
  },
  {
    "id": "panel.d99dfb23cf1c",
    "vi": "Không có công cụ trên host.",
    "en": "The tool is unavailable on this host."
  },
  {
    "id": "panel.a69d6dee4ca9",
    "vi": "Không thể đọc thông tin trong thời gian cho phép.",
    "en": "Could not read the information within the time limit."
  },
  {
    "id": "panel.af602b03d469",
    "vi": "Không gian lưu trữ",
    "en": "Storage space"
  },
  {
    "id": "panel.b0903f929e63",
    "vi": "Thư viện Bedrock",
    "en": "Bedrock libraries"
  },
  {
    "id": "panel.982d1118521d",
    "vi": ". Runtime được hỗ trợ trên Ubuntu 22.04 trở lên.",
    "en": ". The runtime requires Ubuntu 22.04 or newer.",
    "fragment": true
  },
  {
    "id": "panel.3782bb64fda0",
    "vi": "Host hiện tại dùng Windows/macOS; chỉ preview panel, không chạy runtime Bedrock Linux.",
    "en": "This host runs Windows/macOS. You can preview the panel, but cannot run the Linux Bedrock runtime."
  },
  {
    "id": "panel.0079df5dee40",
    "vi": "{0} · yêu cầu Node.js 22 trở lên.",
    "en": "{0} · Node.js 22 or newer is required."
  },
  {
    "id": "panel.56f33f461bc1",
    "vi": "Thư mục dữ liệu",
    "en": "Data directory"
  },
  {
    "id": "panel.a26c08e09b5b",
    "vi": "Tài khoản dịch vụ có quyền ghi dữ liệu.",
    "en": "The service account can write to the data directory."
  },
  {
    "id": "panel.0c89cf3d5411",
    "vi": "Tài khoản dịch vụ không có quyền ghi thư mục dữ liệu.",
    "en": "The service account cannot write to the data directory."
  },
  {
    "id": "panel.1d163767356c",
    "vi": "Không đọc được thông tin filesystem.",
    "en": "Could not read filesystem information."
  },
  {
    "id": "panel.917381aa36a7",
    "vi": "{0} GiB còn trống; cần thêm dung lượng cho world, staging và backup.",
    "en": "{0} GiB free; allow additional space for worlds, staging, and backups."
  },
  {
    "id": "panel.b5114db5a66a",
    "vi": "Bộ nhớ khả dụng",
    "en": "Available memory"
  },
  {
    "id": "panel.f0de5293cac1",
    "vi": "{0} MiB RAM trống.",
    "en": "{0} MiB RAM free."
  },
  {
    "id": "panel.735804869cd6",
    "vi": "Terminal đã bật với quyền {0}. Chỉ Admin được truy cập, mọi lệnh có audit.",
    "en": "The terminal is enabled with {0} privileges. Access is restricted to administrators, and every command is audited."
  },
  {
    "id": "panel.565bba66daa2",
    "vi": "Terminal đang tắt. Có thể bật rõ ràng trong cấu hình dịch vụ khi cần.",
    "en": "The terminal is disabled. Enable it explicitly in the service configuration when needed."
  },
  {
    "id": "panel.239a36a3c0f5",
    "vi": "Truy cập panel",
    "en": "Panel access"
  },
  {
    "id": "panel.6c7ac6129e1c",
    "vi": "Đã khai báo PUBLIC_URL HTTPS; dùng reverse proxy có chứng chỉ hợp lệ.",
    "en": "PUBLIC_URL uses HTTPS. Use a reverse proxy with a valid certificate."
  },
  {
    "id": "panel.63a6c9b6f9be",
    "vi": "Panel bind localhost; dùng SSH tunnel hoặc reverse proxy HTTPS.",
    "en": "The panel is bound to localhost. Use an SSH tunnel or an HTTPS reverse proxy."
  },
  {
    "id": "panel.5d4384603d25",
    "vi": "Panel đang bind ra mạng. Cần reverse proxy HTTPS và PUBLIC_URL trước khi truy cập từ Internet.",
    "en": "The panel is bound to the network. Configure an HTTPS reverse proxy and PUBLIC_URL before accessing it over the Internet."
  },
  {
    "id": "panel.1d32fbe9e9bc",
    "vi": "libcurl và libstdc++ đã được ghi nhận trên host.",
    "en": "libcurl and libstdc++ were found on this host."
  },
  {
    "id": "panel.0197817a4aba",
    "vi": "Chưa xác nhận libcurl/libstdc++. Chạy installer Ubuntu để cài dependency.",
    "en": "libcurl/libstdc++ have not been confirmed. Run the Ubuntu installer to install dependencies."
  },
  {
    "id": "panel.b38a278c2961",
    "vi": "Đường dẫn phải là chuỗi không quá 1.024 byte.",
    "en": "The path must be a string of at most 1,024 bytes."
  },
  {
    "id": "panel.d47428c7afad",
    "vi": "Tên tệp không hợp lệ hoặc không tương thích hệ thống.",
    "en": "The filename is invalid or incompatible with the filesystem."
  },
  {
    "id": "panel.76e9299a85e7",
    "vi": "Chọn từ 1 đến 1.000 tệp hoặc thư mục.",
    "en": "Select between 1 and 1,000 files or folders."
  },
  {
    "id": "panel.53c6692ffde8",
    "vi": "Danh sách nguồn bị trùng hoặc chứa thư mục cùng tệp con của nó.",
    "en": "The source list contains duplicates or both a folder and its child entries."
  },
  {
    "id": "panel.0e51bf48c5f9",
    "vi": "Nội dung phải là văn bản UTF-8 nhỏ hơn 2 MiB.",
    "en": "Content must be UTF-8 text smaller than 2 MiB."
  },
  {
    "id": "panel.32596f7f654a",
    "vi": "Không tìm thấy tệp.",
    "en": "File not found."
  },
  {
    "id": "panel.300beaab1b26",
    "vi": "Chỉ đọc tệp văn bản nhỏ hơn 2 MiB.",
    "en": "Only text files smaller than 2 MiB can be opened."
  },
  {
    "id": "panel.e2a8a62a79df",
    "vi": "Tệp nhị phân hoặc quá lớn không hỗ trợ trình soạn thảo.",
    "en": "Binary or oversized files cannot be opened in the editor."
  },
  {
    "id": "panel.33e63835a73a",
    "vi": "Tệp không phải văn bản UTF-8 hợp lệ; hãy tải xuống để chỉnh sửa bằng công cụ phù hợp.",
    "en": "The file is not valid UTF-8 text. Download it to edit with a suitable tool."
  },
  {
    "id": "panel.bcdbe7e1faa7",
    "vi": "Đường dẫn đích đã tồn tại; không ghi đè.",
    "en": "The destination already exists; it will not be overwritten."
  },
  {
    "id": "panel.9ae1386347c9",
    "vi": "Đường dẫn cha của đích phải là thư mục.",
    "en": "The destination's parent path must be a folder."
  },
  {
    "id": "panel.7e194ace290f",
    "vi": "Thư mục đích chưa tồn tại. Hãy tạo thư mục trước.",
    "en": "The destination folder does not exist. Create it first."
  },
  {
    "id": "panel.76f20ff918ca",
    "vi": "Không tìm thấy tệp hoặc thư mục nguồn.",
    "en": "Source file or folder not found."
  },
  {
    "id": "panel.3897ab96c095",
    "vi": "Chỉ hỗ trợ tệp thông thường hoặc thư mục; không dùng liên kết.",
    "en": "Only regular files and folders are supported; links are not allowed."
  },
  {
    "id": "panel.8e476b92bba1",
    "vi": "Thao tác vượt giới hạn 2 GiB hoặc 50.000 mục.",
    "en": "The operation exceeds the limit of 2 GiB or 50,000 entries."
  },
  {
    "id": "panel.2385cb9d382a",
    "vi": "Yêu cầu sao chép hoặc di chuyển không hợp lệ.",
    "en": "Invalid copy or move request."
  },
  {
    "id": "panel.043cf2e86856",
    "vi": "Sao chép cần danh sách sources.",
    "en": "Copy requires a sources list."
  },
  {
    "id": "panel.a87f463a32d7",
    "vi": "Các nguồn có cùng tên tại đích.",
    "en": "Multiple sources have the same name at the destination."
  },
  {
    "id": "panel.5b4e98dc85c3",
    "vi": "Không thể chuyển hoặc sao chép thư mục vào chính nó; đường dẫn nguồn và đích phải khác nhau.",
    "en": "Cannot move or copy a folder into itself; the source and destination paths must be different."
  },
  {
    "id": "panel.8c505e1b1844",
    "vi": "; không thể hoàn tác {0}: {1}",
    "en": "; could not roll back {0}: {1}",
    "nested": [
      1
    ],
    "fragment": true
  },
  {
    "id": "panel.3d4b6cd2199e",
    "vi": "Thao tác chưa được ghi nhận.",
    "en": "The operation has not been committed."
  },
  {
    "id": "panel.2ec6227b8d2c",
    "vi": "Revision tệp không hợp lệ.",
    "en": "Invalid file revision."
  },
  {
    "id": "panel.d7f27cb023b1",
    "vi": "Tệp không còn tồn tại. Hãy tạo tệp mới bằng công cụ tạo tệp.",
    "en": "The file no longer exists. Create a new file using the file creation tool."
  },
  {
    "id": "panel.3d3754dee7c9",
    "vi": "Hãy tải lại nội dung tệp trước khi lưu.",
    "en": "Reload the file content before saving."
  },
  {
    "id": "panel.15a79d8878b2",
    "vi": "Tệp đã thay đổi. Hãy tải lại trước khi lưu để tránh mất dữ liệu.",
    "en": "The file has changed. Reload it before saving to avoid data loss."
  },
  {
    "id": "panel.61c293a95e04",
    "vi": "; rollback tại {0}: {1}",
    "en": "; rollback at {0}: {1}",
    "nested": [
      1
    ],
    "fragment": true
  },
  {
    "id": "panel.206deb9ddb3d",
    "vi": "Đường dẫn đã tồn tại.",
    "en": "The path already exists."
  },
  {
    "id": "panel.3c61f14dc695",
    "vi": "Đường dẫn cha phải là thư mục.",
    "en": "The parent path must be a folder."
  },
  {
    "id": "panel.4cac6d4df314",
    "vi": "Yêu cầu nén tệp không hợp lệ.",
    "en": "Invalid compression request."
  },
  {
    "id": "panel.b90b3c814186",
    "vi": "Tệp nén cần đuôi .zip.",
    "en": "The archive filename must end with .zip."
  },
  {
    "id": "panel.d039c3bca32c",
    "vi": "Không thể tạo ZIP bên trong nguồn được chọn.",
    "en": "Cannot create a ZIP inside a selected source."
  },
  {
    "id": "panel.401ce0c1b6f6",
    "vi": "Yêu cầu giải nén không hợp lệ.",
    "en": "Invalid extraction request."
  },
  {
    "id": "panel.a179e5312ed2",
    "vi": "Chọn tệp .zip để giải nén.",
    "en": "Select a .zip file to extract."
  },
  {
    "id": "panel.070fc187cbe5",
    "vi": "ZIP phải là tệp thông thường không quá 2 GiB.",
    "en": "The ZIP must be a regular file no larger than 2 GiB."
  },
  {
    "id": "panel.9542a01616ab",
    "vi": "Host terminal cần Ubuntu và ALLOW_HOST_TERMINAL=true. Lệnh chạy với quyền tài khoản của dịch vụ panel.",
    "en": "Host terminal requires Ubuntu and ALLOW_HOST_TERMINAL=true. Commands run with the panel service account's privileges."
  },
  {
    "id": "panel.50ac0dd7557c",
    "vi": "Một lệnh đang chạy. Chờ lệnh hoàn tất.",
    "en": "A command is running. Wait for it to finish."
  },
  {
    "id": "panel.8f4ac8022a6a",
    "vi": "Lệnh không hợp lệ.",
    "en": "Invalid command."
  },
  {
    "id": "panel.76f4ecbe0fb4",
    "vi": "Panel đang dừng. Vui lòng thử lại sau.",
    "en": "The panel is shutting down. Please try again later."
  },
  {
    "id": "panel.5a5b4479d717",
    "vi": "API không tồn tại.",
    "en": "API endpoint not found."
  },
  {
    "id": "panel.a46eb40b6412",
    "vi": "Thao tác thất bại. Xem nhật ký dịch vụ panel.",
    "en": "The operation failed. Check the panel service logs."
  },
  {
    "id": "panel.546055c34f12",
    "vi": "Không thể chạy panel: {0}",
    "en": "Could not start the panel: {0}"
  },
  {
    "id": "panel.58485a5be5ae",
    "vi": "Một tiến trình đang kiểm tra khóa dữ liệu {0}. Thử lại sau.",
    "en": "A process is checking the data lock {0}. Try again later."
  },
  {
    "id": "panel.f9bba5dbcea6",
    "vi": "Không thể đọc khóa dữ liệu: {0}. Kiểm tra tiến trình panel trước khi xóa khóa.",
    "en": "Could not read the data lock: {0}. Check the panel process before deleting the lock."
  },
  {
    "id": "panel.3d5789017bda",
    "vi": "Khóa dữ liệu không hợp lệ: {0}",
    "en": "Invalid data lock: {0}"
  },
  {
    "id": "panel.bcb741a82076",
    "vi": "Không xác định được tiến trình đang giữ khóa dữ liệu {0}.",
    "en": "Could not identify the process holding the data lock {0}."
  },
  {
    "id": "panel.98c41aa487bf",
    "vi": "Một panel khác (PID {0}) đang dùng {1}.",
    "en": "Another panel (PID {0}) is using {1}."
  },
  {
    "id": "panel.b23533e0bf06",
    "vi": "Không thể khóa thư mục dữ liệu.",
    "en": "Could not lock the data directory."
  },
  {
    "id": "panel.5961d168d23b",
    "vi": "Identity key phải là tệp PEM thông thường.",
    "en": "The identity key must be a regular PEM file."
  },
  {
    "id": "panel.b467119b5e1d",
    "vi": "Không tìm thấy server.",
    "en": "Server not found."
  },
  {
    "id": "panel.878241789549",
    "vi": "Không tìm thấy lịch.",
    "en": "Schedule not found."
  },
  {
    "id": "panel.583c07b0280c",
    "vi": "Panel đang tắt; không nhận thao tác mới.",
    "en": "The panel is shutting down and is not accepting new operations."
  },
  {
    "id": "panel.34eebc58a1fd",
    "vi": "Đối tượng xóa phải là thư mục server hoặc tệp backup thông thường.",
    "en": "The deletion target must be a server directory or a regular backup file."
  },
  {
    "id": "panel.82a3401e02cc",
    "vi": "Đường dẫn cách ly đã tồn tại.",
    "en": "The quarantine path already exists."
  },
  {
    "id": "panel.e061abd08f78",
    "vi": "Đối tượng cách ly đã thay đổi; cần kiểm tra dữ liệu thủ công.",
    "en": "The quarantined object has changed. Inspect the data manually."
  },
  {
    "id": "panel.bc4a0758be97",
    "vi": "Đường dẫn khôi phục đã thay đổi hoặc đã có dữ liệu.",
    "en": "The recovery path has changed or already contains data."
  },
  {
    "id": "panel.d5b513439d40",
    "vi": "; dữ liệu vẫn được cách ly tại {0}: {1}",
    "en": "; the data remains quarantined at {0}: {1}",
    "nested": [
      1
    ],
    "fragment": true
  },
  {
    "id": "panel.a19312924911",
    "vi": "Đã lưu thao tác xóa; còn dữ liệu cách ly tại {0}. Quản trị viên cần kiểm tra trước khi dọn: {1}",
    "en": "Deletion was committed, but quarantined data remains at {0}. An administrator must inspect it before cleanup: {1}",
    "nested": [
      1
    ]
  },
  {
    "id": "panel.8ebbde3d45e5",
    "vi": "Không thể lưu trạng thái tiến trình: {0}",
    "en": "Could not save the process state: {0}",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.e9c56465f54f",
    "vi": "Server đang thực hiện tác vụ. Vui lòng đợi hoàn tất.",
    "en": "The server is processing a task. Wait for it to finish."
  },
  {
    "id": "panel.4cad02a6786a",
    "vi": "Hãy dừng server trước khi thao tác để bảo vệ dữ liệu thế giới.",
    "en": "Stop the server before this operation to protect world data."
  },
  {
    "id": "panel.bb6ad0251eb2",
    "vi": "Kênh phiên bản không hợp lệ.",
    "en": "Invalid version channel."
  },
  {
    "id": "panel.47838102f304",
    "vi": "Chưa xác định được phiên bản mới nhất từ Mojang. Hãy kiểm tra mạng hoặc nhập ZIP chính thức.",
    "en": "The latest Mojang version could not be determined. Check the network or import an official ZIP."
  },
  {
    "id": "panel.28d4e60eff6c",
    "vi": "Phiên bản không có trong kho.",
    "en": "The version is not in the repository."
  },
  {
    "id": "panel.fc4925deccef",
    "vi": "Đã đưa vào hàng đợi",
    "en": "Queued"
  },
  {
    "id": "panel.e84898db736f",
    "vi": "Đang xử lý",
    "en": "Processing"
  },
  {
    "id": "panel.4b64cb2ef3a6",
    "vi": "Panel đang tắt.",
    "en": "The panel is shutting down."
  },
  {
    "id": "panel.7cef2bd09f3d",
    "vi": "Hoàn tất; còn dữ liệu cách ly cần quản trị viên kiểm tra.",
    "en": "Completed; quarantined data still requires an administrator's inspection."
  },
  {
    "id": "panel.b0484236b997",
    "vi": "Hoàn tất",
    "en": "Completed"
  },
  {
    "id": "panel.138c7a5b3c03",
    "vi": "Không thể lưu trạng thái panel: {0}",
    "en": "Could not save the panel state: {0}",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.5293d03c5908",
    "vi": "Cập nhật",
    "en": "update"
  },
  {
    "id": "panel.202e0e9b0b85",
    "vi": "Cài đặt",
    "en": "installation"
  },
  {
    "id": "panel.287bb10dca85",
    "vi": "Chuẩn bị gói Bedrock chính thức",
    "en": "Preparing the official Bedrock package"
  },
  {
    "id": "panel.f9f7081cc3f1",
    "vi": "Đang tải gói từ Mojang",
    "en": "Downloading the package from Mojang"
  },
  {
    "id": "panel.5b9b54519932",
    "vi": "Đang sao lưu dữ liệu trước cập nhật",
    "en": "Backing up data before the update"
  },
  {
    "id": "panel.8683432069e8",
    "vi": "Đang kích hoạt thư mục server",
    "en": "Activating the server directory"
  },
  {
    "id": "panel.c137a0e912ff",
    "vi": "đã cập nhật; dữ liệu thế giới và cấu hình được giữ lại",
    "en": "updated; world data and configuration were preserved"
  },
  {
    "id": "panel.80b725c40812",
    "vi": "đã cài đặt",
    "en": "installed"
  },
  {
    "id": "panel.15574d2a45c2",
    "vi": "Không thể mở cổng TCP {0}: {1}",
    "en": "Could not open TCP port {0}: {1}",
    "nested": [
      1
    ]
  },
  {
    "id": "panel.30430eb34f66",
    "vi": "Không thể mở cổng UDP {0}: {1}",
    "en": "Could not open UDP port {0}: {1}",
    "nested": [
      1
    ]
  },
  {
    "id": "panel.bb56257b1a7b",
    "vi": "Server đang chạy hoặc đang chuyển trạng thái.",
    "en": "The server is running or changing state."
  },
  {
    "id": "panel.15c1213f4592",
    "vi": "Server chưa cài đặt xong.",
    "en": "The server installation is not complete."
  },
  {
    "id": "panel.039a266fa10d",
    "vi": "Bedrock Linux yêu cầu Ubuntu 22.04+ x86-64. Hãy triển khai panel trên Ubuntu.",
    "en": "Bedrock Linux requires Ubuntu 22.04+ x86-64. Deploy the panel on Ubuntu."
  },
  {
    "id": "panel.de5038638abf",
    "vi": "Không tìm thấy tệp Bedrock server.",
    "en": "Bedrock server executable not found."
  },
  {
    "id": "panel.d9dfe586035f",
    "vi": "Cấu hình cổng hoặc transport không khớp. Hãy lưu lại cấu hình qua panel.",
    "en": "The configured ports or transport do not match. Save the configuration through the panel again."
  },
  {
    "id": "panel.9ee2ce4e6a3d",
    "vi": "Không thể chạy Bedrock: {0}",
    "en": "Could not start Bedrock: {0}",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.4c3a35901389",
    "vi": "Bedrock đã thoát (code {0}, signal {1}).",
    "en": "Bedrock exited (code {0}, signal {1})."
  },
  {
    "id": "panel.e8e24a1d262d",
    "vi": "Tiến trình dừng: code {0}, signal {1}.",
    "en": "Process stopped: code {0}, signal {1}."
  },
  {
    "id": "panel.d6f91e4d7abc",
    "vi": "Tự khởi động lại sau {0}s (lần {1}/5).",
    "en": "Automatically restarting in {0}s (attempt {1}/5)."
  },
  {
    "id": "panel.ea72d8758124",
    "vi": "Tạm ngừng tự khởi động lại: quá 5 lần lỗi trong 10 phút.",
    "en": "Automatic restart paused: more than 5 failures in 10 minutes."
  },
  {
    "id": "panel.6dbd8143f229",
    "vi": "Bedrock không báo sẵn sàng sau 90 giây.",
    "en": "Bedrock did not report readiness within 90 seconds."
  },
  {
    "id": "panel.f2c4507d1f99",
    "vi": "Đã chạy Bedrock PID {0}; đang đợi server sẵn sàng.",
    "en": "Started Bedrock PID {0}; waiting for the server to become ready."
  },
  {
    "id": "panel.8b9d2bfd81f7",
    "vi": "Buộc dừng",
    "en": "forced stop"
  },
  {
    "id": "panel.11554138c040",
    "vi": "Dừng",
    "en": "stop"
  },
  {
    "id": "panel.bbe2b2e97b52",
    "vi": "Đã gửi stop; chờ Bedrock lưu thế giới.",
    "en": "Sent stop; waiting for Bedrock to save the world."
  },
  {
    "id": "panel.863ddfddba32",
    "vi": "Bedrock chưa dừng sau 30 giây; gửi SIGKILL.",
    "en": "Bedrock did not stop within 30 seconds; sending SIGKILL."
  },
  {
    "id": "panel.1c89fa4237c9",
    "vi": "Không thể xác nhận tiến trình đã dừng.",
    "en": "Could not confirm that the process has stopped."
  },
  {
    "id": "panel.a7704dbe0139",
    "vi": "Yêu cầu cấu hình không hợp lệ.",
    "en": "Invalid configuration request."
  },
  {
    "id": "panel.ab89221e42af",
    "vi": "udpMode phải là auto hoặc custom.",
    "en": "udpMode must be auto or custom."
  },
  {
    "id": "panel.6e34683b16f6",
    "vi": "Phiên bản đã cài chỉ được cấu hình transport: {0}. Panel dùng NetherNet cho Preview từ 1.26.60; Mojang đã đánh dấu RakNet deprecated.",
    "en": "The installed version only supports these transport settings: {0}. The panel uses NetherNet for Preview 1.26.60 and newer; Mojang has deprecated RakNet."
  },
  {
    "id": "panel.0015fa168698",
    "vi": "; không thể khôi phục server.properties, bản cũ tại {0}: {1}",
    "en": "; could not restore server.properties; the previous file is at {0}: {1}",
    "nested": [
      1
    ],
    "fragment": true
  },
  {
    "id": "panel.c9c2539c0074",
    "vi": "Tệp runtime được bảo vệ; hãy dùng công cụ cập nhật phiên bản.",
    "en": "Runtime files are protected. Use the version update tool."
  },
  {
    "id": "panel.abc6e0f1e5c9",
    "vi": "Identity của server được bảo vệ khỏi chỉnh sửa, di chuyển hoặc xóa.",
    "en": "The server identity is protected from editing, moving, and deletion."
  },
  {
    "id": "panel.e1a0f21359d4",
    "vi": "Hãy dùng công cụ Add-ons để quản lý pack và đăng ký pack.",
    "en": "Use the Add-ons tool to manage packs and pack registrations."
  },
  {
    "id": "panel.3ee5a438c959",
    "vi": "Tệp cấu hình được bảo vệ; hãy dùng trình soạn thảo hoặc công cụ cấu hình.",
    "en": "Configuration files are protected. Use the editor or configuration tool."
  },
  {
    "id": "panel.e91dac24e2a8",
    "vi": "Không thể di chuyển hoặc xóa thư mục thế giới đang được chọn; hãy đổi level-name trước.",
    "en": "Cannot move or delete the selected world folder. Change level-name first."
  },
  {
    "id": "panel.e19303911a22",
    "vi": "JSON không hợp lệ.",
    "en": "Invalid JSON."
  },
  {
    "id": "panel.643db526ac27",
    "vi": "Đường dẫn không phải thư mục.",
    "en": "The path is not a folder."
  },
  {
    "id": "panel.9622a771cd8a",
    "vi": "Đang nén dữ liệu server",
    "en": "Compressing server data"
  },
  {
    "id": "panel.9dde494f274d",
    "vi": "; backup chưa được ghi vào catalog vẫn ở {0}: {1}",
    "en": "; the backup was not added to the catalog and remains at {0}: {1}",
    "nested": [
      1
    ],
    "fragment": true
  },
  {
    "id": "panel.7d2b4b501e8e",
    "vi": "Sao lưu hoàn tất: {0}.",
    "en": "Backup completed: {0}."
  },
  {
    "id": "panel.232cd82e3dea",
    "vi": "Không tìm thấy bản sao lưu.",
    "en": "Backup not found."
  },
  {
    "id": "panel.ea0148290dc3",
    "vi": "Bản sao lưu thuộc phiên bản khác. Hãy cài lại phiên bản tương ứng trước khi khôi phục để tránh hỏng thế giới.",
    "en": "This backup belongs to a different version. Install the matching version before restoring it to avoid world corruption."
  },
  {
    "id": "panel.8cd2b84ce8db",
    "vi": "Bản sao lưu cố thay thế tệp runtime được bảo vệ.",
    "en": "The backup attempts to replace a protected runtime file."
  },
  {
    "id": "panel.a3d1fd1d15f1",
    "vi": "Đang thay thế dữ liệu; giữ bản rollback",
    "en": "Replacing data and keeping a rollback copy"
  },
  {
    "id": "panel.f9d6607af654",
    "vi": "Đã khôi phục {0}.",
    "en": "Restored {0}."
  },
  {
    "id": "panel.238b09ec6e84",
    "vi": "Thiết lập lịch tác vụ không hợp lệ.",
    "en": "Invalid schedule settings."
  },
  {
    "id": "panel.607f1af4c72a",
    "vi": "Tác vụ lịch không hợp lệ.",
    "en": "Invalid scheduled action."
  },
  {
    "id": "panel.cd94eae4cf4e",
    "vi": "Chu kỳ phải từ 1 phút đến 1 năm.",
    "en": "The interval must be between 1 minute and 1 year."
  },
  {
    "id": "panel.df96554d1ecd",
    "vi": "Trạng thái lịch phải là boolean.",
    "en": "The schedule's enabled state must be a boolean."
  },
  {
    "id": "panel.60255c6e8b40",
    "vi": "Lệnh lịch không hợp lệ; dùng tác vụ restart để điều khiển vòng đời.",
    "en": "Invalid scheduled command. Use the restart action to control the server lifecycle."
  },
  {
    "id": "panel.0bf2efb42857",
    "vi": "Một lịch của server đang chạy. Vui lòng đợi hoàn tất.",
    "en": "A schedule is running for this server. Wait for it to finish."
  },
  {
    "id": "panel.8ea4a632bc6a",
    "vi": "Server đang chuyển trạng thái. Vui lòng đợi.",
    "en": "The server is changing state. Please wait."
  },
  {
    "id": "panel.cfd51f845904",
    "vi": "Đã đưa lịch vào hàng đợi",
    "en": "Schedule queued"
  },
  {
    "id": "panel.71efdc9cb8b0",
    "vi": "Đang chạy lịch {0}",
    "en": "Running scheduled action {0}"
  },
  {
    "id": "panel.3a888f859be8",
    "vi": "Đang dừng server trước sao lưu",
    "en": "Stopping the server before backup"
  },
  {
    "id": "panel.6d1d5dddab79",
    "vi": "Đang sao lưu dữ liệu",
    "en": "Backing up data"
  },
  {
    "id": "panel.a0efc3d45e8d",
    "vi": "Không xác định được kết quả sao lưu.",
    "en": "Could not determine the backup result."
  },
  {
    "id": "panel.83b0f51e39ed",
    "vi": "Đang khởi động lại server sau sao lưu",
    "en": "Restarting the server after backup"
  },
  {
    "id": "panel.13743a1b6b06",
    "vi": "Lịch đã hoàn tất",
    "en": "Schedule completed"
  },
  {
    "id": "panel.5c001adb7c5e",
    "vi": " (tự động)",
    "en": " (automatic)"
  },
  {
    "id": "panel.277c767b8619",
    "vi": " (thủ công)",
    "en": " (manual)"
  },
  {
    "id": "panel.593c09a7fb0a",
    "vi": "Không thể lưu kết quả lịch: {0}",
    "en": "Could not save the schedule result: {0}",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.f5d172ec69ec",
    "vi": "Server của lịch không còn tồn tại.",
    "en": "The schedule's server no longer exists."
  },
  {
    "id": "panel.da9a625410d0",
    "vi": "Panel khởi động lại khi tác vụ chưa hoàn tất.",
    "en": "The panel restarted before the task finished."
  },
  {
    "id": "panel.d8cbe2ac5402",
    "vi": "Panel khởi động lại khi lịch chưa hoàn tất.",
    "en": "The panel restarted before the schedule finished."
  },
  {
    "id": "panel.d5b53a84bf2f",
    "vi": "Bạn cần chấp nhận Minecraft EULA và Điều khoản trước khi cài đặt.",
    "en": "Accept the Minecraft EULA and Terms before installation."
  },
  {
    "id": "panel.9ed4e88ddc3a",
    "vi": "Tên server phải có 1–80 ký tự.",
    "en": "The server name must contain 1–80 characters."
  },
  {
    "id": "panel.ea131daa94bd",
    "vi": "Số người chơi tối đa phải từ 1–1000.",
    "en": "Maximum players must be between 1 and 1,000."
  },
  {
    "id": "panel.fa44a707caef",
    "vi": "ID server không hợp lệ.",
    "en": "Invalid server ID."
  },
  {
    "id": "panel.d4696180fc5e",
    "vi": "Bạn cần chấp nhận Minecraft EULA trước khi nhân bản.",
    "en": "Accept the Minecraft EULA before cloning."
  },
  {
    "id": "panel.72efdf03d55a",
    "vi": "Hãy tắt inbound script debugger trước khi clone để tránh trùng cổng debugger.",
    "en": "Disable the inbound script debugger before cloning to avoid a debugger port conflict."
  },
  {
    "id": "panel.486c1d2afbfd",
    "vi": "Nhân bản hỗ trợ tối đa 50.000 tệp.",
    "en": "Cloning supports up to 50,000 files."
  },
  {
    "id": "panel.9a8daa86567b",
    "vi": "Dữ liệu nhân bản vượt 2 GiB.",
    "en": "The clone data exceeds 2 GiB."
  },
  {
    "id": "panel.e88528b9da64",
    "vi": "Đang sao chép thế giới và cấu hình",
    "en": "Copying the world and configuration"
  },
  {
    "id": "panel.274f9aabaafe",
    "vi": "Đã nhân bản {0}; tạo identity riêng khi Bedrock khởi động.",
    "en": "Cloned {0}; Bedrock will create a separate identity on startup."
  },
  {
    "id": "panel.c3e5cd9554d4",
    "vi": "Thao tác không hợp lệ.",
    "en": "Invalid action."
  },
  {
    "id": "panel.ac468a9556ee",
    "vi": "Lệnh phải là một dòng không quá 2048 ký tự.",
    "en": "The command must be a single line of no more than 2048 characters."
  },
  {
    "id": "panel.2e935580d98b",
    "vi": "Hãy dùng nút dừng hoặc khởi động lại để panel theo dõi đúng tiến trình.",
    "en": "Use the stop or restart button so the panel can track the process correctly."
  },
  {
    "id": "panel.f3aa487d371f",
    "vi": "Server phải đang chạy để gửi lệnh.",
    "en": "The server must be running to send commands."
  },
  {
    "id": "panel.c7385784109f",
    "vi": "Đổi tên cần một source và destination.",
    "en": "Rename requires one source and destination."
  },
  {
    "id": "panel.1e59860e226d",
    "vi": "Yêu cầu tạo tệp không hợp lệ.",
    "en": "Invalid file creation request."
  },
  {
    "id": "panel.25d6d6f274ab",
    "vi": "Tên tệp tải lên không hợp lệ.",
    "en": "Invalid upload filename."
  },
  {
    "id": "panel.d0bef080d35e",
    "vi": "Tệp tải lên không quá 100 MiB.",
    "en": "Uploaded files cannot exceed 100 MiB."
  },
  {
    "id": "panel.b123135f90b4",
    "vi": "Chỉ tải xuống một tệp.",
    "en": "Only a single file can be downloaded."
  },
  {
    "id": "panel.cdc51e9e5fc9",
    "vi": "enabled phải là boolean.",
    "en": "enabled must be a boolean."
  },
  {
    "id": "panel.d64b48ee2560",
    "vi": "Không tìm thấy pack.",
    "en": "Pack not found."
  },
  {
    "id": "panel.0c9461a42e5d",
    "vi": "Lịch đang chạy; hãy đợi hoàn tất trước khi sửa.",
    "en": "The schedule is running. Wait for it to finish before editing."
  },
  {
    "id": "panel.f83369c6d5f7",
    "vi": "Không thể chuyển lịch sang máy chủ khác; hãy tạo lịch mới.",
    "en": "Cannot move a schedule to another server. Create a new schedule."
  },
  {
    "id": "panel.60a55056a7c3",
    "vi": "Lịch đang chạy; hãy đợi hoàn tất trước khi xóa.",
    "en": "The schedule is running. Wait for it to finish before deleting."
  },
  {
    "id": "panel.1aa353843d97",
    "vi": "Server đang thực hiện thao tác khác.",
    "en": "The server is performing another operation."
  },
  {
    "id": "panel.daf555ae5666",
    "vi": "Tên thế giới không hợp lệ.",
    "en": "Invalid world name."
  },
  {
    "id": "panel.1755e7998ad9",
    "vi": "manifest.json phải là một đối tượng JSON.",
    "en": "manifest.json must be a JSON object."
  },
  {
    "id": "panel.e5dcac0489f0",
    "vi": "Panel hiện hỗ trợ manifest format_version=2.",
    "en": "The panel currently supports manifest format_version=2."
  },
  {
    "id": "panel.287cf85518ac",
    "vi": "Header cần name dài 1–256 ký tự.",
    "en": "The header name must contain 1–256 characters."
  },
  {
    "id": "panel.6dd7f9b46c09",
    "vi": "Header cần description tối đa 4096 ký tự.",
    "en": "The header description cannot exceed 4096 characters."
  },
  {
    "id": "panel.e6455168b211",
    "vi": "Header UUID không hợp lệ.",
    "en": "Invalid header UUID."
  },
  {
    "id": "panel.95d57d1c3ddb",
    "vi": "Header version cần ba số nguyên không âm.",
    "en": "The header version must contain three non-negative integers."
  },
  {
    "id": "panel.5288db8b866f",
    "vi": "Header min_engine_version cần ba số nguyên không âm.",
    "en": "The header min_engine_version must contain three non-negative integers."
  },
  {
    "id": "panel.8e9221f4563a",
    "vi": "Pack yêu cầu Minecraft {0} trở lên.",
    "en": "The pack requires Minecraft {0} or newer."
  },
  {
    "id": "panel.d89a8631c23e",
    "vi": "Header pack_scope cần world, any hoặc global.",
    "en": "The header pack_scope must be world, any, or global."
  },
  {
    "id": "panel.980821f8c9a7",
    "vi": "Panel chỉ kích hoạt pack cho thế giới; pack_scope=global không thể gắn vào world.",
    "en": "The panel activates packs for worlds only; pack_scope=global cannot be attached to a world."
  },
  {
    "id": "panel.d278e77e6520",
    "vi": "Manifest cần 1–16 module.",
    "en": "The manifest must contain 1–16 modules."
  },
  {
    "id": "panel.245061e07880",
    "vi": "Module UUID phải hợp lệ và khác mọi header/module UUID trong pack.",
    "en": "Module UUIDs must be valid and different from all header and module UUIDs in the pack."
  },
  {
    "id": "panel.a09b018cb862",
    "vi": "Module version cần ba số nguyên không âm.",
    "en": "The module version must contain three non-negative integers."
  },
  {
    "id": "panel.a1aeda2efa35",
    "vi": "Module {0} chưa được hỗ trợ; chỉ hỗ trợ data/resources, không cài Script API.",
    "en": "Module {0} is unsupported. Only data/resources modules are supported; Script API is not installed.",
    "nested": []
  },
  {
    "id": "panel.08aabfba9b7b",
    "vi": "(thiếu type)",
    "en": "(missing type)"
  },
  {
    "id": "panel.c2243f13c503",
    "vi": "Mỗi pack phải chỉ chứa module data hoặc chỉ chứa module resources.",
    "en": "Each pack must contain only data modules or only resources modules."
  },
  {
    "id": "panel.c9b558abfcb9",
    "vi": "Dependencies phải là danh sách tối đa 64 pack.",
    "en": "Dependencies must be a list of no more than 64 packs."
  },
  {
    "id": "panel.250253dd6302",
    "vi": "Script API/module_name dependencies chưa được hỗ trợ.",
    "en": "Script API/module_name dependencies are not supported."
  },
  {
    "id": "panel.acef14f2f360",
    "vi": "Dependency cần header UUID và version gồm ba số nguyên.",
    "en": "Each dependency requires a header UUID and a version containing three integers."
  },
  {
    "id": "panel.112366fd720f",
    "vi": "Pack không được phụ thuộc chính nó.",
    "en": "A pack cannot depend on itself."
  },
  {
    "id": "panel.963063674fae",
    "vi": "(manifest không hợp lệ)",
    "en": "(invalid manifest)"
  },
  {
    "id": "panel.22ba8df5cc57",
    "vi": "{0}: JSON cần là tệp thường tối đa 256 KiB.",
    "en": "{0}: JSON must be a regular file no larger than 256 KiB."
  },
  {
    "id": "panel.8a1b2f1699f9",
    "vi": "{0}: JSON không hợp lệ.",
    "en": "{0}: invalid JSON."
  },
  {
    "id": "panel.8fe0e86de02e",
    "vi": "{0}: cần danh sách tối đa 2000 mục.",
    "en": "{0}: a list of no more than 2000 entries is required."
  },
  {
    "id": "panel.e368268ad901",
    "vi": "Công cụ pack hỗ trợ tối đa 100 thế giới trên một server.",
    "en": "The pack tool supports up to 100 worlds per server."
  },
  {
    "id": "panel.f7022683f6a8",
    "vi": "Thư mục worlds chứa liên kết; không thể quản lý pack an toàn.",
    "en": "The worlds directory contains links; packs cannot be safely managed."
  },
  {
    "id": "panel.1f6a33250fa5",
    "vi": "{0}/{1}: liên kết bị bỏ qua.",
    "en": "{0}/{1}: link skipped."
  },
  {
    "id": "panel.f1fdcc13761d",
    "vi": "Có quá nhiều pack; giới hạn kiểm tra là 500.",
    "en": "There are too many packs; the inspection limit is 500."
  },
  {
    "id": "panel.eac0e175d8ff",
    "vi": "Loại module không khớp thư mục cài đặt.",
    "en": "The module type does not match the installation folder."
  },
  {
    "id": "panel.4d7588bd97bc",
    "vi": "UUID trùng với {0}.",
    "en": "UUID conflicts with {0}."
  },
  {
    "id": "panel.9db66ddd80be",
    "vi": "; không thể khôi phục {0}: {1}",
    "en": "; could not restore {0}: {1}",
    "nested": [
      1
    ],
    "fragment": true
  },
  {
    "id": "panel.cc8c6aa0f1cc",
    "vi": "Pack UUID không hợp lệ.",
    "en": "Invalid pack UUID."
  },
  {
    "id": "panel.c689ea18b5ab",
    "vi": "UUID pack bị trùng; hãy sửa thủ công trước khi thao tác.",
    "en": "The pack UUID is duplicated. Fix it manually before continuing."
  },
  {
    "id": "panel.c34c44271524",
    "vi": "Panel hiện chưa tự kích hoạt các pack có vòng phụ thuộc.",
    "en": "The panel cannot automatically activate packs with circular dependencies."
  },
  {
    "id": "panel.91e18e7b0c1d",
    "vi": "{0} cần {1} phiên bản {2}.",
    "en": "{0} requires {1} version {2}."
  },
  {
    "id": "panel.df178b862c11",
    "vi": "Chưa có dependency hợp lệ {0}.",
    "en": "No valid dependency {0} was found."
  },
  {
    "id": "panel.125b888048c4",
    "vi": "Chỉ nhận tệp .mcpack hoặc .mcaddon.",
    "en": "Only .mcpack or .mcaddon files are accepted."
  },
  {
    "id": "panel.f57765ea6231",
    "vi": "Archive pack vượt 100 MiB.",
    "en": "The pack archive exceeds 100 MiB."
  },
  {
    "id": "panel.61cef003513c",
    "vi": "Công cụ chỉ cài pack; archive chứa .mcworld hoặc .mcaddon lồng chưa được hỗ trợ.",
    "en": "This tool installs packs only; archives containing .mcworld or nested .mcaddon files are unsupported."
  },
  {
    "id": "panel.9f3c9bf632d5",
    "vi": ".mcpack phải chứa một manifest trực tiếp, không chứa archive lồng.",
    "en": "A .mcpack must contain a manifest directly and cannot contain nested archives."
  },
  {
    "id": "panel.7b6d646c8da7",
    "vi": "Archive có quá nhiều pack lồng; giới hạn 20.",
    "en": "The archive contains too many nested packs; the limit is 20."
  },
  {
    "id": "panel.6326b85e0021",
    "vi": "Chỉ hỗ trợ một lớp .mcpack lồng trong .mcaddon.",
    "en": "Only one layer of .mcpack files nested inside a .mcaddon is supported."
  },
  {
    "id": "panel.ba13f04f0a40",
    "vi": "Archive cần 1–20 pack; .mcpack cần đúng một manifest.json.",
    "en": "The archive must contain 1–20 packs; a .mcpack must contain exactly one manifest.json."
  },
  {
    "id": "panel.60eb9d28d387",
    "vi": "Manifest vượt 256 KiB.",
    "en": "The manifest exceeds 256 KiB."
  },
  {
    "id": "panel.8161d2c1218f",
    "vi": "manifest.json không hợp lệ.",
    "en": "Invalid manifest.json."
  },
  {
    "id": "panel.d5bebf033b5b",
    "vi": "Không cho phép các thư mục pack chồng lồng nhau.",
    "en": "Nested overlapping pack folders are not allowed."
  },
  {
    "id": "panel.31dfdd825806",
    "vi": "UUID {0} đã tồn tại; không ghi đè pack bất biến.",
    "en": "UUID {0} already exists; immutable packs will not be overwritten."
  },
  {
    "id": "panel.72776519d520",
    "vi": "Thư mục pack đã tồn tại; không ghi đè.",
    "en": "The pack folder already exists and will not be overwritten."
  },
  {
    "id": "panel.6594aecb44c5",
    "vi": "Pack chưa được bật. Khả năng hoạt động và các experiment cần kiểm tra qua content log sau khi khởi động.",
    "en": "The pack is not enabled yet. Check functionality and required experiments in the content log after startup."
  },
  {
    "id": "panel.3d35a8f2547a",
    "vi": "; không thể dọn pack: {0}",
    "en": "; could not clean up the pack: {0}",
    "nested": [
      0
    ],
    "fragment": true
  },
  {
    "id": "panel.b3ecbda0bf14",
    "vi": "Thế giới chưa tồn tại; hãy khởi động Bedrock một lần để tạo thế giới.",
    "en": "The world does not exist yet. Start Bedrock once to create it."
  },
  {
    "id": "panel.4c2d8038d649",
    "vi": "{0} đang bật và cần pack này; hãy tắt pack phụ thuộc trước.",
    "en": "{0} is enabled and requires this pack. Disable the dependent pack first."
  },
  {
    "id": "panel.a5f291820735",
    "vi": "Pack runtime/Mojang được bảo vệ; hãy dùng cập nhật phiên bản.",
    "en": "Runtime/Mojang packs are protected. Use the version update tool."
  },
  {
    "id": "panel.c460ebf07cfb",
    "vi": "{0} trong thế giới {1} đang cần pack này. Tắt pack phụ thuộc trước.",
    "en": "{0} in world {1} requires this pack. Disable the dependent pack first."
  },
  {
    "id": "panel.6ecc85f7991e",
    "vi": "; không thể khôi phục thư mục pack: {0}",
    "en": "; could not restore the pack folder: {0}",
    "nested": [
      0
    ],
    "fragment": true
  },
  {
    "id": "panel.f6e261f50b53",
    "vi": "XUID phải là chuỗi số nguyên chính xác.",
    "en": "XUID must be an exact integer string."
  },
  {
    "id": "panel.3f8157e78137",
    "vi": "XUID phải là số nguyên dương 64 bit.",
    "en": "XUID must be a positive 64-bit integer."
  },
  {
    "id": "panel.4f1211de7967",
    "vi": "Danh sách người chơi không hợp lệ.",
    "en": "Invalid player list."
  },
  {
    "id": "panel.7ed210288905",
    "vi": "Tên người chơi allowlist phải từ 1–64 ký tự, không chứa ký tự điều khiển.",
    "en": "Allowlist player names must contain 1–64 characters and no control characters."
  },
  {
    "id": "panel.077cad2c9b71",
    "vi": "ignoresPlayerLimit phải là boolean.",
    "en": "ignoresPlayerLimit must be a boolean."
  },
  {
    "id": "panel.b7700d95bee5",
    "vi": "Allowlist có tên hoặc XUID bị trùng.",
    "en": "The allowlist contains a duplicate name or XUID."
  },
  {
    "id": "panel.d86f208361a5",
    "vi": "Quyền người chơi phải là visitor, member hoặc operator.",
    "en": "Player permission must be visitor, member, or operator."
  },
  {
    "id": "panel.51f9d2cd57b6",
    "vi": "Danh sách quyền có XUID bị trùng.",
    "en": "The permissions list contains a duplicate XUID."
  },
  {
    "id": "panel.d2acd9ec288f",
    "vi": "{0} phải là tệp thông thường.",
    "en": "{0} must be a regular file."
  },
  {
    "id": "panel.ad0e9a25dcfe",
    "vi": "; không thể hoàn tác {0}: {1}{2}",
    "en": "; could not roll back {0}: {1}{2}",
    "nested": [
      1,
      2
    ],
    "fragment": true
  },
  {
    "id": "panel.bd6d9d37e9a5",
    "vi": ", bản cũ tại {0}",
    "en": ", the previous file is at {0}",
    "fragment": true
  },
  {
    "id": "panel.95f022b0c597",
    "vi": "Tài khoản viewer chỉ được xem dữ liệu.",
    "en": "Viewer accounts can only read data."
  },
  {
    "id": "panel.0fe74d691985",
    "vi": "Bạn không có quyền truy cập server này.",
    "en": "You do not have access to this server."
  },
  {
    "id": "panel.91b270eb1856",
    "vi": "Hãy chọn tệp tải lên.",
    "en": "Select a file to upload."
  },
  {
    "id": "panel.da10a18ed9f9",
    "vi": "Hãy chọn .mcpack hoặc .mcaddon.",
    "en": "Select a .mcpack or .mcaddon file."
  },
  {
    "id": "panel.9f73a2deb9b3",
    "vi": "Hãy chọn ZIP Bedrock Linux chính thức.",
    "en": "Select an official Bedrock Linux ZIP."
  },
  {
    "id": "panel.76e25bd3f845",
    "vi": "Bạn không có quyền tạo lịch cho server này.",
    "en": "You do not have permission to create a schedule for this server."
  },
  {
    "id": "panel.073a265c7447",
    "vi": "Bạn không có quyền truy cập lịch của server này.",
    "en": "You do not have access to this server's schedule."
  },
  {
    "id": "panel.3a13223ccc83",
    "vi": "Đường dẫn không hợp lệ.",
    "en": "Invalid path."
  },
  {
    "id": "panel.06121f7d8750",
    "vi": "Không được thao tác thư mục gốc.",
    "en": "The root directory cannot be modified."
  },
  {
    "id": "panel.2a036ce4c634",
    "vi": "Không cho phép truy cập liên kết tượng trưng.",
    "en": "Access to symbolic links is not allowed."
  },
  {
    "id": "panel.3849e9e09b25",
    "vi": "Không tìm thấy tệp hoặc thư mục.",
    "en": "File or folder not found."
  },
  {
    "id": "panel.e8e760e37571",
    "vi": "Đường dẫn vượt ngoài server.",
    "en": "The path is outside the server directory."
  },
  {
    "id": "panel.933a65b3270b",
    "vi": "Server chứa liên kết tượng trưng; không thể sao lưu hoặc sao chép an toàn.",
    "en": "The server contains symbolic links and cannot be safely backed up or copied."
  },
  {
    "id": "panel.bf2d13ad0038",
    "vi": "Server chứa tệp thiết bị hoặc socket; thao tác bị từ chối.",
    "en": "The server contains device files or sockets; the operation was rejected."
  },
  {
    "id": "panel.1f3109a8203a",
    "vi": "Cấu hình không hợp lệ.",
    "en": "Invalid configuration."
  },
  {
    "id": "panel.73830de25a45",
    "vi": "Khóa hoặc giá trị cấu hình không hợp lệ.",
    "en": "Invalid configuration key or value."
  },
  {
    "id": "panel.c4569c566677",
    "vi": "Giá trị cấu hình chứa ký tự không hợp lệ.",
    "en": "The configuration value contains invalid characters."
  },
  {
    "id": "panel.bbec391d70f6",
    "vi": "Cổng phải nằm trong khoảng 1024–65535.",
    "en": "The port must be between 1024 and 65535."
  },
  {
    "id": "panel.e14ac86a06ea",
    "vi": "Cổng IPv4 và IPv6 phải khác nhau.",
    "en": "The IPv4 and IPv6 ports must be different."
  },
  {
    "id": "panel.a9bdb5983e3f",
    "vi": "Cổng đang được server “{0}” sử dụng.",
    "en": "The port is already used by server “{0}”."
  },
  {
    "id": "panel.954f18648cae",
    "vi": "NetherNet cần dải server-udp-ports riêng để kiểm soát cổng game.",
    "en": "NetherNet requires a separate server-udp-ports range to control game ports."
  },
  {
    "id": "panel.6b57251b14dd",
    "vi": "Dải UDP không hợp lệ.",
    "en": "Invalid UDP range."
  },
  {
    "id": "panel.f9ee9ce8ec49",
    "vi": "Dải UDP phải có dạng 19200 hoặc 19200-19231; hỗ trợ ánh xạ NAT IP:external:internal.",
    "en": "The UDP range must look like 19200 or 19200-19231; NAT mappings use IP:external:internal."
  },
  {
    "id": "panel.192acad2bb9c",
    "vi": "Dải UDP vượt giới hạn cổng cho phép.",
    "en": "The UDP range is outside the permitted port range."
  },
  {
    "id": "panel.6d4ce57b94e2",
    "vi": "Địa chỉ IPv6 NAT không hợp lệ.",
    "en": "Invalid IPv6 NAT address."
  },
  {
    "id": "panel.dd3f4856d886",
    "vi": "Địa chỉ IPv4 NAT không hợp lệ.",
    "en": "Invalid IPv4 NAT address."
  },
  {
    "id": "panel.98ba8fee06e6",
    "vi": "Dải cổng external/internal NAT phải có cùng độ dài.",
    "en": "The external and internal NAT port ranges must have the same length."
  },
  {
    "id": "panel.be11341d5770",
    "vi": "Dải UDP nội bộ bị trùng lặp.",
    "en": "The internal UDP ranges overlap."
  },
  {
    "id": "panel.d355dd46a5c4",
    "vi": "Tổng dải UDP vượt giới hạn 4096 cổng.",
    "en": "The combined UDP ranges exceed the limit of 4096 ports."
  },
  {
    "id": "panel.6b17494237c4",
    "vi": "Cổng quá cao để cấp dải UDP NetherNet. Chọn cổng signaling thấp hơn.",
    "en": "The port is too high to allocate a NetherNet UDP range. Choose a lower signaling port."
  },
  {
    "id": "panel.11984cdbea19",
    "vi": "Transport phải là raknet hoặc nethernet.",
    "en": "Transport must be raknet or nethernet."
  },
  {
    "id": "panel.87ac8eda9a89",
    "vi": "Cổng debugger phải từ 1024–65535.",
    "en": "The debugger port must be between 1024 and 65535."
  },
  {
    "id": "panel.b365023837ea",
    "vi": "Cổng debugger không được trùng với cổng game.",
    "en": "The debugger port cannot overlap a game port."
  },
  {
    "id": "panel.ac86a8201105",
    "vi": "Dải cổng trùng với server “{0}”. Chọn cổng hoặc dải UDP khác.",
    "en": "The port range overlaps server “{0}”. Choose another port or UDP range."
  },
  {
    "id": "panel.65b8d8f9b696",
    "vi": "Không đọc được chỉ mục phiên bản (HTTP {0}).",
    "en": "Could not read the version index (HTTP {0})."
  },
  {
    "id": "panel.cab4c29b174e",
    "vi": "Metadata phiên bản vượt giới hạn cho phép.",
    "en": "The version metadata exceeds the permitted size limit."
  },
  {
    "id": "panel.7bd260bf808e",
    "vi": "Metadata phiên bản không phải JSON hợp lệ.",
    "en": "The version metadata is not valid JSON."
  },
  {
    "id": "panel.d6edd4707b56",
    "vi": "Chỉ mục lịch sử đã thay đổi định dạng.",
    "en": "The history index format has changed."
  },
  {
    "id": "panel.375613232ece",
    "vi": "Chỉ mục lịch sử không có phiên bản Linux.",
    "en": "The history index contains no Linux versions."
  },
  {
    "id": "panel.64c7215a5778",
    "vi": "Metadata không khớp phiên bản được yêu cầu.",
    "en": "The metadata does not match the requested version."
  },
  {
    "id": "panel.035f60534063",
    "vi": "Metadata không khớp kênh Linux được yêu cầu.",
    "en": "The metadata does not match the requested Linux channel."
  },
  {
    "id": "panel.5f22ac6ba4b0",
    "vi": "Liên kết tải không khớp phiên bản trong chỉ mục.",
    "en": "The download link does not match the version in the index."
  },
  {
    "id": "panel.a45cb3eb2050",
    "vi": "Metadata thiếu SHA-256 hợp lệ.",
    "en": "The metadata is missing a valid SHA-256 hash."
  },
  {
    "id": "panel.c8d34f5fa3bc",
    "vi": "CDN lịch sử không phải Minecraft.net chính thức.",
    "en": "The historical CDN is not the official Minecraft.net CDN."
  },
  {
    "id": "panel.e003f66a1faa",
    "vi": "Chỉ mục BDS Linux đã thay đổi định dạng.",
    "en": "The BDS Linux index format has changed."
  },
  {
    "id": "panel.498b8b88cfdf",
    "vi": "Chỉ mục BDS không chứa phiên bản Linux.",
    "en": "The BDS index contains no Linux versions."
  },
  {
    "id": "panel.25a3683b6ec9",
    "vi": "Metadata không khớp phiên bản hoặc nền tảng Linux.",
    "en": "The metadata does not match the requested version or Linux platform."
  },
  {
    "id": "panel.e8c82cf05dee",
    "vi": "Kích thước BDS trong metadata không hợp lệ.",
    "en": "The BDS size in the metadata is invalid."
  },
  {
    "id": "panel.f6ee5f64b55c",
    "vi": "SHA-1 trong metadata không hợp lệ.",
    "en": "The SHA-1 hash in the metadata is invalid."
  },
  {
    "id": "panel.32c493fe6ed7",
    "vi": "Phiên bản phải có dạng 1.26.52.3.",
    "en": "The version must use the format 1.26.52.3."
  },
  {
    "id": "panel.9086ab10a9d4",
    "vi": "URL tải xuống không hợp lệ.",
    "en": "Invalid download URL."
  },
  {
    "id": "panel.45fba875d573",
    "vi": "Chỉ cho phép ZIP Bedrock Linux chính thức từ minecraft.net.",
    "en": "Only official Bedrock Linux ZIPs from minecraft.net are allowed."
  },
  {
    "id": "panel.d539a947c768",
    "vi": "Liên kết tải chuyển sang phiên bản khác.",
    "en": "The download link redirected to a different version."
  },
  {
    "id": "panel.1b29a90d83e5",
    "vi": "Liên kết tải chuyển sang kênh phiên bản khác.",
    "en": "The download link redirected to a different version channel."
  },
  {
    "id": "panel.8a8b53e988df",
    "vi": "Chuỗi chuyển hướng tải xuống không hợp lệ.",
    "en": "Invalid download redirect chain."
  },
  {
    "id": "panel.20395c445423",
    "vi": "Mojang trả về HTTP {0}.",
    "en": "Mojang returned HTTP {0}."
  },
  {
    "id": "panel.020da820f0a0",
    "vi": "Gói tải xuống vượt 1 GiB.",
    "en": "The downloaded package exceeds 1 GiB."
  },
  {
    "id": "panel.13bbc3ed778c",
    "vi": "Kích thước gói tải không khớp metadata cộng đồng. Gói chưa được cài.",
    "en": "The downloaded package size does not match the community metadata. The package was not installed."
  },
  {
    "id": "panel.460e87d43d97",
    "vi": "{0} gói tải không khớp metadata cộng đồng. Gói chưa được cài.",
    "en": "The downloaded package's {0} hash does not match the community metadata. The package was not installed."
  },
  {
    "id": "panel.3ed829d613a2",
    "vi": "Panel đang dừng.",
    "en": "The panel is shutting down."
  },
  {
    "id": "panel.18983476915b",
    "vi": "; không thể dọn gói chưa được lưu: {0}",
    "en": "; could not clean up the uncommitted package: {0}",
    "nested": [
      0
    ],
    "fragment": true
  },
  {
    "id": "panel.e164bcac46a4",
    "vi": "Không thể kiểm tra Mojang (HTTP {0}).",
    "en": "Could not check Mojang (HTTP {0})."
  },
  {
    "id": "panel.fd4e370521f5",
    "vi": "Phản hồi Mojang quá lớn.",
    "en": "The Mojang response is too large."
  },
  {
    "id": "panel.a9391a90d64c",
    "vi": "Mojang đã thay đổi định dạng API.",
    "en": "The Mojang API format has changed."
  },
  {
    "id": "panel.2212b3e14fff",
    "vi": "Mojang trả liên kết không khớp kênh Linux.",
    "en": "Mojang returned a link that does not match the Linux channel."
  },
  {
    "id": "panel.678223f78036",
    "vi": "Mojang chưa cung cấp liên kết Linux stable.",
    "en": "Mojang has not provided a Linux stable download link."
  },
  {
    "id": "panel.dc4c156fa50d",
    "vi": "Không thể xác thực bản mới: {0}. Các gói đã lưu vẫn sử dụng được.",
    "en": "Could not verify the new release: {0}. Cached packages are still available.",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.fc180f6fc3b1",
    "vi": "{0} mục metadata chưa đồng bộ; làm mới để thử lại.",
    "en": "{0} metadata entries have not synced. Refresh to try again."
  },
  {
    "id": "panel.fc320cf41e83",
    "vi": "Phiên bản không có trong chỉ mục.",
    "en": "The version is not in the index."
  },
  {
    "id": "panel.c2e183217068",
    "vi": "Bản này cần nhập ZIP Linux để sử dụng.",
    "en": "Import a Linux ZIP to use this version."
  },
  {
    "id": "panel.53646a520ce7",
    "vi": "Đang kiểm tra nhiều liên kết. Vui lòng thử lại sau.",
    "en": "Several links are being checked. Please try again later."
  },
  {
    "id": "panel.a771c5218eb4",
    "vi": "Chưa xác minh được metadata Linux: {0}",
    "en": "Could not verify the Linux metadata: {0}",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.c37132f73af2",
    "vi": "Kích thước ZIP Mojang không khớp metadata lịch sử; hãy kiểm tra lại nguồn hoặc nhập gói đã lưu.",
    "en": "The Mojang ZIP size does not match the historical metadata. Check the source or import a saved package."
  },
  {
    "id": "panel.819867e4ee63",
    "vi": "Mojang không còn cung cấp gói này. Bạn có thể nhập ZIP Linux đã lưu.",
    "en": "Mojang no longer provides this package. You can import a saved Linux ZIP."
  },
  {
    "id": "panel.36d84fa1b9f6",
    "vi": "Chưa xác minh được ZIP từ Mojang (HTTP {0}). Hãy thử lại hoặc nhập gói đã lưu.",
    "en": "Could not verify the Mojang ZIP (HTTP {0}). Try again or import a saved package."
  },
  {
    "id": "panel.333255736db8",
    "vi": "Không kiểm tra được liên kết: {0}",
    "en": "Could not check the link: {0}",
    "nested": [
      0
    ]
  },
  {
    "id": "panel.3e3559c25a2c",
    "vi": "Phiên bản đang được nhập. Vui lòng đợi hoàn tất.",
    "en": "The version is being imported. Wait for it to finish."
  },
  {
    "id": "panel.9dcf6288f482",
    "vi": "Phiên bản chưa được khám phá hoặc nhập vào kho. Hãy làm mới Mojang hoặc nhập ZIP.",
    "en": "The version has not been discovered or imported. Refresh Mojang or import a ZIP."
  },
  {
    "id": "panel.695f40b1cb68",
    "vi": "Phiên bản này không có URL tải xuống.",
    "en": "This version has no download URL."
  },
  {
    "id": "panel.69290cd6442c",
    "vi": "Phiên bản chưa có gói tải khả dụng.",
    "en": "No downloadable package is available for this version yet."
  },
  {
    "id": "panel.dc4b6def82d9",
    "vi": "Phiên bản đang được tải hoặc nhập. Vui lòng đợi hoàn tất.",
    "en": "The version is being downloaded or imported. Wait for it to finish."
  },
  {
    "id": "panel.fa5d64bce5cd",
    "vi": "Gói phiên bản đã được lưu; không thể thay thế gói bất biến.",
    "en": "The version package is already cached; immutable packages cannot be replaced."
  },
  {
    "id": "panel.bedrock.install.success",
    "vi": "Bedrock {0} {1}.",
    "en": "Bedrock {0} {1}.",
    "nested": [
      1
    ]
  },
  {
    "id": "panel.platform.support",
    "vi": "{0} · {1}. Runtime được hỗ trợ trên Ubuntu 22.04 trở lên.",
    "en": "{0} · {1}. The runtime requires Ubuntu 22.04 or newer."
  },
  {
    "id": "panel.audit.operation.failed",
    "vi": "{0}: {1}",
    "en": "{0}: {1}",
    "nested": [
      1
    ],
    "metadataOnly": true
  },
  {
    "id": "panel.audit.schedule.automatic",
    "vi": "{0}: {1} (tự động)",
    "en": "{0}: {1} (automatic)",
    "metadataOnly": true
  },
  {
    "id": "panel.audit.schedule.manual",
    "vi": "{0}: {1} (thủ công)",
    "en": "{0}: {1} (manual)",
    "metadataOnly": true
  },
  {
    "id": "panel.ws.session.revoked",
    "vi": "Phiên đăng nhập đã bị thu hồi.",
    "en": "Session revoked",
    "metadataOnly": true
  },
  {
    "id": "panel.ws.session.expired",
    "vi": "Phiên đăng nhập đã hết hạn.",
    "en": "Session expired",
    "metadataOnly": true
  },
  {
    "id": "panel.ws.client.slow",
    "vi": "Kết nối nhận dữ liệu quá chậm.",
    "en": "Client is too slow",
    "metadataOnly": true
  },
  {
    "id": "panel.pack.module.type.missing",
    "vi": "Module thiếu type; chỉ hỗ trợ data/resources, không cài Script API.",
    "en": "The module type is missing. Only data/resources modules are supported; Script API is not installed."
  },
  {
    "id": "panel.ops.ab170ead8fed",
    "vi": "level.dat chứa dữ liệu NBT không hợp lệ, bị cắt ngắn hoặc chưa được hỗ trợ.",
    "en": "level.dat contains invalid, truncated or unsupported NBT data."
  },
  {
    "id": "panel.ops.a5db5d1b2346",
    "vi": "Đây là dữ liệu thế giới Java; công cụ Worlds chỉ nhận thế giới Minecraft Bedrock.",
    "en": "This is Java world data. Worlds accepts Minecraft Bedrock worlds only."
  },
  {
    "id": "panel.ops.25003d6f1455",
    "vi": "level.dat không có header Bedrock hợp lệ hoặc vượt giới hạn 16 MiB.",
    "en": "level.dat has no valid Bedrock header or exceeds the 16 MiB limit."
  },
  {
    "id": "panel.ops.4520ce226457",
    "vi": "Header hoặc kích thước dữ liệu level.dat không khớp.",
    "en": "The level.dat header or declared data length does not match."
  },
  {
    "id": "panel.ops.b5fb3a482ab3",
    "vi": "level.dat vượt giới hạn độ sâu hoặc số lượng thẻ NBT.",
    "en": "level.dat exceeds the NBT nesting or tag count limit."
  },
  {
    "id": "panel.ops.4ba54e2ec08a",
    "vi": "level.dat chứa tên thẻ NBT trùng lặp.",
    "en": "level.dat contains duplicate NBT tag names."
  },
  {
    "id": "panel.ops.883dfadb6c46",
    "vi": "level.dat của Bedrock phải có thẻ NBT gốc dạng Compound.",
    "en": "Bedrock level.dat must have a Compound root NBT tag."
  },
  {
    "id": "panel.ops.c5da59e6f2ea",
    "vi": "level.dat có dữ liệu thừa sau thẻ NBT gốc.",
    "en": "level.dat contains extra data after the root NBT tag."
  },
  {
    "id": "panel.ops.7fbdae5b8c18",
    "vi": "Thế giới chứa liên kết tượng trưng, thư mục sai vị trí hoặc tệp đặc biệt.",
    "en": "The world contains a symbolic link, a directory where a file is required, or a special file."
  },
  {
    "id": "panel.ops.8d89504473d7",
    "vi": "Dữ liệu thế giới đã thay đổi trong lúc kiểm tra; hãy dừng server và thử lại.",
    "en": "World data changed during inspection. Stop the server and try again."
  },
  {
    "id": "panel.ops.974e62bbc006",
    "vi": "Thế giới vượt giới hạn 50.000 tệp và thư mục.",
    "en": "The world exceeds the limit of 50,000 files and folders."
  },
  {
    "id": "panel.ops.f9fdb2c5cc31",
    "vi": "Cây thư mục thế giới vượt giới hạn độ sâu.",
    "en": "The world folder tree exceeds the nesting limit."
  },
  {
    "id": "panel.ops.e45b8dc9e289",
    "vi": "Kích thước thế giới vượt giới hạn số nguyên an toàn.",
    "en": "The world size exceeds the safe integer limit."
  },
  {
    "id": "panel.ops.df29a41de37f",
    "vi": "Đường dẫn thế giới không hợp lệ.",
    "en": "The world path is invalid."
  },
  {
    "id": "panel.ops.781d0cd8e09e",
    "vi": "Không tìm thấy thư mục thế giới Bedrock.",
    "en": "The Bedrock world folder was not found."
  },
  {
    "id": "panel.ops.aa9fcc92525b",
    "vi": "Thư mục thế giới Bedrock không hợp lệ hoặc là liên kết tượng trưng.",
    "en": "The Bedrock world folder is invalid or is a symbolic link."
  },
  {
    "id": "panel.ops.9948f82023c1",
    "vi": "Thế giới thiếu level.dat của Minecraft Bedrock.",
    "en": "The world is missing Minecraft Bedrock level.dat."
  },
  {
    "id": "panel.ops.ee12dece1d42",
    "vi": "level.dat vượt giới hạn 16 MiB.",
    "en": "level.dat exceeds the 16 MiB limit."
  },
  {
    "id": "panel.ops.b03fdc8f0506",
    "vi": "Thế giới thiếu thư mục db của Minecraft Bedrock; thế giới Java không được hỗ trợ.",
    "en": "The world is missing the Minecraft Bedrock db folder. Java worlds are not supported."
  },
  {
    "id": "panel.ops.e8aa0856ee68",
    "vi": "Thư mục db của thế giới Bedrock không hợp lệ.",
    "en": "The Bedrock world db folder is invalid."
  },
  {
    "id": "panel.ops.570b5fe6c78a",
    "vi": "Database Bedrock thiếu tệp db/CURRENT.",
    "en": "The Bedrock database is missing db/CURRENT."
  },
  {
    "id": "panel.ops.cdc06c04428e",
    "vi": "Tệp db/CURRENT vượt giới hạn kích thước.",
    "en": "db/CURRENT exceeds the size limit."
  },
  {
    "id": "panel.ops.8dc698120c55",
    "vi": "Tệp db/CURRENT chứa tên MANIFEST không hợp lệ.",
    "en": "db/CURRENT contains an invalid MANIFEST filename."
  },
  {
    "id": "panel.ops.d81b8a98b72f",
    "vi": "Database Bedrock thiếu tệp MANIFEST được CURRENT tham chiếu.",
    "en": "The Bedrock database is missing the MANIFEST file referenced by CURRENT."
  },
  {
    "id": "panel.ops.1406d5f1bf56",
    "vi": "Tệp MANIFEST của database Bedrock không được rỗng.",
    "en": "The Bedrock database MANIFEST file must not be empty."
  },
  {
    "id": "panel.ops.7920a135b3e8",
    "vi": "Database Bedrock chứa thư mục, liên kết hoặc tệp đặc biệt chưa được hỗ trợ.",
    "en": "The Bedrock database contains an unsupported folder, symbolic link or special file."
  },
  {
    "id": "panel.ops.80123791de71",
    "vi": "Database Bedrock không có tệp dữ liệu .ldb, .sst hoặc .log hợp lệ.",
    "en": "The Bedrock database has no valid .ldb, .sst or .log data file."
  },
  {
    "id": "panel.ops.6f9d257ffc82",
    "vi": "Dữ liệu sao chép vượt giới hạn số mục hoặc độ sâu.",
    "en": "The copied data exceeds the entry or depth limit."
  },
  {
    "id": "panel.ops.74b6106365c9",
    "vi": "Dữ liệu sao chép chứa liên kết hoặc tệp đặc biệt.",
    "en": "The copied data contains links or special files."
  },
  {
    "id": "panel.ops.40082762b774",
    "vi": "Bản sao lưu đang được khóa; hãy mở khóa trước khi xóa.",
    "en": "This backup is locked. Unlock it before deleting it."
  },
  {
    "id": "panel.ops.0d974f92eb21",
    "vi": "Hoàn tất với cảnh báo; hãy kiểm tra chi tiết tác vụ.",
    "en": "Completed with warnings. Review the job details."
  },
  {
    "id": "panel.ops.8d38d778e5b2",
    "vi": "Đã cập nhật server; còn dữ liệu rollback tại {0} cần kiểm tra: {1}",
    "en": "The server was updated. Rollback data remains at {0} and needs review: {1}",
    "nested": []
  },
  {
    "id": "panel.ops.6437aea0bc20",
    "vi": "World đang thay đổi trong khi server chạy; hãy tải lại hoặc dừng server để kiểm tra.",
    "en": "The world is changing while the server is running. Refresh or stop the server to inspect it."
  },
  {
    "id": "panel.ops.748425c7d839",
    "vi": "Kiểm tra metadata và bố cục world không xác minh khả năng chơi; Bedrock sẽ đọc database khi khởi động.",
    "en": "Metadata and layout checks do not verify playability. Bedrock reads the database when the server starts."
  },
  {
    "id": "panel.ops.42a9772d32f7",
    "vi": "Yêu cầu nhập world không hợp lệ.",
    "en": "The world import request is invalid."
  },
  {
    "id": "panel.ops.e49b237d7128",
    "vi": "Tên world đang được chọn; hãy nhập bằng tên mới để không thay dữ liệu active.",
    "en": "This world name is currently selected. Import under a new name to preserve the active world's data."
  },
  {
    "id": "panel.ops.be2316cdf7ca",
    "vi": "Panel hỗ trợ tối đa 100 world trên một server.",
    "en": "The panel supports up to 100 worlds per server."
  },
  {
    "id": "panel.ops.8c1b1ecb1140",
    "vi": "Archive world phải là tệp thường không quá 1 GiB.",
    "en": "The world archive must be a regular file no larger than 1 GiB."
  },
  {
    "id": "panel.ops.3b34322d50eb",
    "vi": "Đang giải nén và kiểm tra world Bedrock",
    "en": "Extracting and inspecting the Bedrock world"
  },
  {
    "id": "panel.ops.ca5393bab37c",
    "vi": "Đang nhập world bằng tên mới; giữ world đang chọn",
    "en": "Importing under a new name while preserving the selected world"
  },
  {
    "id": "panel.ops.5b8ac980c07b",
    "vi": "Đã nhập world {0}; world đang chọn được giữ nguyên.",
    "en": "World {0} was imported. The selected world was preserved.",
    "nested": []
  },
  {
    "id": "panel.ops.2f82a55cc1f3",
    "vi": "; world nhập chưa commit còn tại worlds/{0}: {1}",
    "en": "; the uncommitted imported world remains at worlds/{0}: {1}",
    "nested": [],
    "fragment": true
  },
  {
    "id": "panel.ops.8d90060ccd48",
    "vi": "Yêu cầu chọn hoặc tạo world không hợp lệ.",
    "en": "The request to select or create a world is invalid."
  },
  {
    "id": "panel.ops.cdd66e7bbc5b",
    "vi": "Tên world đã tồn tại; hãy chọn tên mới, không ghi đè dữ liệu.",
    "en": "This world name already exists. Choose a new name to avoid overwriting data."
  },
  {
    "id": "panel.ops.f222682729e8",
    "vi": "Không tìm thấy thư mục world hợp lệ.",
    "en": "No valid world directory was found."
  },
  {
    "id": "panel.ops.a5408e4c3430",
    "vi": "Hãy nhập chính xác tên world để xác nhận xóa.",
    "en": "Enter the exact world name to confirm deletion."
  },
  {
    "id": "panel.ops.14e11b6c2a27",
    "vi": "Không được xóa world đang chọn; hãy chọn world khác trước.",
    "en": "The selected world cannot be deleted. Select another world first."
  },
  {
    "id": "panel.ops.84afee520f5d",
    "vi": "Archive sao lưu phải là tệp thường trong giới hạn kích thước hỗ trợ.",
    "en": "The backup archive must be a regular file within the supported size limit."
  },
  {
    "id": "panel.ops.f1735aa9433d",
    "vi": "Archive sao lưu đã thay đổi trong khi kiểm tra.",
    "en": "The backup archive changed during verification."
  },
  {
    "id": "panel.ops.610ea46eb330",
    "vi": "Đang kiểm tra SHA-256 của bản sao lưu",
    "en": "Verifying the backup's SHA-256"
  },
  {
    "id": "panel.ops.95d83d9001d3",
    "vi": "SHA-256 của bản sao lưu không khớp; không cho phép khôi phục hoặc tải bản hỏng.",
    "en": "The backup's SHA-256 does not match. Restoring or downloading the damaged archive is blocked."
  },
  {
    "id": "panel.ops.5820cc2b400d",
    "vi": "Đang kiểm tra đường dẫn, giới hạn và CRC-32 của archive",
    "en": "Checking archive paths, limits, and CRC-32"
  },
  {
    "id": "panel.ops.f81a9636022e",
    "vi": "; không thể lưu kết quả kiểm tra sao lưu: {0}",
    "en": "; could not save the backup verification result: {0}",
    "nested": [],
    "fragment": true
  },
  {
    "id": "panel.ops.0d4c3d57890c",
    "vi": "Bản sao lưu cũ chưa có SHA-256; hãy chạy kiểm tra để thiết lập mốc toàn vẹn trước khi khôi phục.",
    "en": "This legacy backup has no SHA-256. Run verification to establish an integrity baseline before restoring it."
  },
  {
    "id": "panel.ops.22bccf66268e",
    "vi": "Đã khôi phục server; còn dữ liệu rollback tại {0} cần kiểm tra: {1}",
    "en": "The server was restored. Rollback data remains at {0} and needs review: {1}",
    "nested": []
  },
  {
    "id": "panel.ops.48f2fb1c82e6",
    "vi": "Trạng thái khóa sao lưu phải là boolean.",
    "en": "The backup lock state must be a boolean."
  },
  {
    "id": "panel.ops.0d1545a3d560",
    "vi": "Mỗi server được khóa tối đa 50 bản sao lưu; hãy mở khóa bản không còn cần giữ.",
    "en": "Each server can lock up to 50 backups. Unlock a backup you no longer need to protect."
  },
  {
    "id": "panel.ops.ad2f9de2186f",
    "vi": "Hãy chọn tệp world Bedrock .mcworld hoặc .zip.",
    "en": "Select a Bedrock world .mcworld or .zip file."
  },
  {
    "id": "panel.ops.9ea8ff7c5e07",
    "vi": "Xuất world chứa dữ liệu người chơi cần quyền quản lý server.",
    "en": "Exporting a world containing player data requires server management permission."
  },
  {
    "id": "panel.ops.21875fb07df6",
    "vi": "Tải bản sao lưu chứa dữ liệu riêng tư cần quyền quản lý server.",
    "en": "Downloading a backup containing private data requires server management permission."
  },
  {
    "id": "panel.ops.33def66c0466",
    "vi": "Tên thế giới phải là tên thư mục hợp lệ, tối đa 255 byte và không có ký tự điều khiển.",
    "en": "The world name must be a valid directory name of up to 255 bytes without control characters."
  },
  {
    "id": "panel.ops.8213d7f6b75b",
    "vi": "Seed phải là chuỗi tối đa 2048 byte, không có khoảng trắng đầu/cuối hoặc ký tự điều khiển.",
    "en": "The seed must be a string of up to 2048 bytes without leading or trailing whitespace or control characters."
  },
  {
    "id": "panel.ops.9334cfe08406",
    "vi": "{0}: JSON của world phải là tệp thường không quá 256 KiB.",
    "en": "{0}: world JSON must be a regular file no larger than 256 KiB.",
    "nested": []
  },
  {
    "id": "panel.ops.7c2cda646dfd",
    "vi": "{0}: JSON của world không phải UTF-8 hợp lệ.",
    "en": "{0}: world JSON is not valid UTF-8.",
    "nested": []
  },
  {
    "id": "panel.ops.25a71caae6d1",
    "vi": "{0}: JSON của world không hợp lệ.",
    "en": "{0}: world JSON is invalid.",
    "nested": []
  },
  {
    "id": "panel.ops.6a33d3f95d0c",
    "vi": "{0}: thư mục pack của world không hợp lệ.",
    "en": "{0}: the world's pack directory is invalid.",
    "nested": []
  },
  {
    "id": "panel.ops.5f39451b190a",
    "vi": "{0}/{1}: mỗi pack của world phải là thư mục thông thường.",
    "en": "{0}/{1}: each world pack must be a regular directory.",
    "nested": []
  },
  {
    "id": "panel.ops.0718a5b591b0",
    "vi": "World chứa quá nhiều pack; giới hạn là 20 manifest.",
    "en": "The world contains too many packs. The limit is 20 manifests."
  },
  {
    "id": "panel.ops.a32bec9b7feb",
    "vi": "{0}: loại pack không khớp thư mục world.",
    "en": "{0}: the pack type does not match its world directory.",
    "nested": []
  },
  {
    "id": "panel.ops.f3e576e9cca3",
    "vi": "World có UUID pack hoặc module bị trùng.",
    "en": "The world contains duplicate pack or module UUIDs."
  },
  {
    "id": "panel.ops.491bcffad8bf",
    "vi": "{0}: UUID pack của world trùng với pack dùng chung; không tự ghi đè hoặc bỏ pack.",
    "en": "{0}: the world pack UUID conflicts with a shared pack. Neither pack is automatically overwritten or discarded.",
    "nested": []
  },
  {
    "id": "panel.ops.9f1fd8bfa10b",
    "vi": "World chứa pack có vòng phụ thuộc; panel chưa hỗ trợ.",
    "en": "The world contains packs with circular dependencies, which the panel does not support."
  },
  {
    "id": "panel.ops.33a6cc8a9dad",
    "vi": "{0}: world thiếu pack phụ thuộc đúng UUID và phiên bản.",
    "en": "{0}: the world is missing a dependency pack with the required UUID and version.",
    "nested": []
  },
  {
    "id": "panel.ops.e18446590422",
    "vi": "{0}: danh sách pack của world không hợp lệ.",
    "en": "{0}: the world's pack list is invalid.",
    "nested": []
  },
  {
    "id": "panel.ops.4545a23c08f4",
    "vi": "{0}: tham chiếu pack của world không hợp lệ.",
    "en": "{0}: the world's pack reference is invalid.",
    "nested": []
  },
  {
    "id": "panel.ops.0bacf29893e3",
    "vi": "{0}: tham chiếu pack của world bị trùng.",
    "en": "{0}: the world contains duplicate pack references.",
    "nested": []
  },
  {
    "id": "panel.ops.24cc114431bb",
    "vi": "{0}: world thiếu pack đã đăng ký đúng UUID và phiên bản.",
    "en": "{0}: the world is missing a registered pack with the required UUID and version.",
    "nested": []
  },
  {
    "id": "panel.ops.905f8402bb11",
    "vi": "World có đường dẫn quá sâu.",
    "en": "The world's paths are too deeply nested."
  },
  {
    "id": "panel.ops.bee721f85e31",
    "vi": "World vượt giới hạn 50.000 mục.",
    "en": "The world exceeds the limit of 50,000 entries."
  },
  {
    "id": "panel.ops.c489fe82c20a",
    "vi": "World chứa liên kết hoặc tệp đặc biệt; thao tác bị từ chối.",
    "en": "The world contains links or special files. The operation is blocked."
  },
  {
    "id": "panel.ops.7c05479cedbf",
    "vi": "Archive world chứa identity hoặc cấu hình server; hãy chỉ nhập dữ liệu world.",
    "en": "The world archive contains server identity or configuration files. Import only world data."
  },
  {
    "id": "panel.ops.b96f012ee864",
    "vi": "World chứa mã chạy hoặc pack mã hóa chưa được hỗ trợ: {0}.",
    "en": "The world contains unsupported executable code or encrypted packs: {0}.",
    "nested": []
  },
  {
    "id": "panel.ops.29b2e8e13a90",
    "vi": "Archive chứa nhiều world; hãy nhập từng world riêng.",
    "en": "The archive contains multiple worlds. Import each world separately."
  },
  {
    "id": "panel.ops.777857e117ad",
    "vi": "World vượt giới hạn dữ liệu 2 GiB.",
    "en": "The world exceeds the 2 GiB data limit."
  },
  {
    "id": "panel.ops.21cd916829f6",
    "vi": "World phải là thư mục thông thường.",
    "en": "The world must be a regular directory."
  },
  {
    "id": "panel.ops.68947d4b11af",
    "vi": "Chỉ nhận world Bedrock .mcworld hoặc .zip.",
    "en": "Only Bedrock world .mcworld or .zip files are accepted."
  },
  {
    "id": "panel.ops.af355a2e5844",
    "vi": "ZIP phải chứa đúng một world Bedrock ở gốc hoặc trong một thư mục bọc.",
    "en": "The ZIP must contain exactly one Bedrock world at the root or inside one enclosing directory."
  },
  {
    "id": "panel.ops.9d04ebf386a6",
    "vi": "{0}: pack của world không được hỗ trợ: {1}",
    "en": "{0}: the world pack is unsupported: {1}",
    "nested": [
      1
    ]
  },
  {
    "id": "panel.ops.be879bdf4f78",
    "vi": "{0}: UUID pack hoặc module của world trùng với pack dùng chung; không tự ghi đè hoặc bỏ pack.",
    "en": "{0}: the world's pack or module UUID conflicts with a shared pack. Neither pack is automatically overwritten or discarded.",
    "nested": []
  },
  {
    "id": "panel.ops.bcede8d31d06",
    "vi": "Đọc hoặc tải identity của server cần quyền quản lý server.",
    "en": "Reading or downloading the server identity requires server management permission."
  },
  {
    "id": "panel.ops.e895a9f8f0ca",
    "vi": "Server có dữ liệu restore chưa phục hồi; cần quản trị viên kiểm tra {0} và {1} trước khi khởi động hoặc thay đổi dữ liệu.",
    "en": "This server has an unfinished restore recovery. An administrator must inspect {0} and {1} before starting it or changing data."
  },
  {
    "id": "panel.ops.c564f6f6059c",
    "vi": "Khôi phục rollback thất bại; dữ liệu gốc tại {0}, dữ liệu bản sao tại {1}. Nguyên nhân ban đầu: {2}; lỗi rollback: {3}. Cần phục hồi thủ công trước khi khởi động hoặc thay đổi dữ liệu.",
    "en": "Restore rollback failed. Original data is at {0}; backup candidate data is at {1}. Initial cause: {2}; rollback error: {3}. Manual recovery is required before starting the server or changing data.",
    "nested": [
      2
    ]
  },
  {
    "id": "panel.ops.c6cbbc598195",
    "vi": "Thao tác đã hoàn tất, nhưng chưa ghi được nhật ký hoàn tất: {0}",
    "en": "The operation completed, but its completion audit could not be recorded: {0}",
    "nested": []
  },
  {
    "id": "panel.ops.38302ce9156d",
    "vi": "Thao tác đã hoàn tất, nhưng chưa lưu được trạng thái tác vụ: {0}. Trạng thái cuối có thể chưa được lưu; hãy kiểm tra dữ liệu trước khi thử lại.",
    "en": "The operation completed, but its job status could not be saved: {0}. The final state may not be persisted; inspect the data before retrying.",
    "nested": []
  },
  {
    "id": "panel.ops.0d300062ee8b",
    "vi": "Bản sao lưu mới đã được tạo, nhưng chưa dọn được bản cũ {0}: {1}. Đã dừng retention để giữ dữ liệu.",
    "en": "The new backup was created, but the older backup {0} could not be pruned: {1}. Retention stopped to preserve data.",
    "nested": []
  },
  {
    "id": "panel.voice.32beb9e281f5",
    "vi": "Ngôn ngữ thông báo server phải là en hoặc vi.",
    "en": "Server message language must be en or vi."
  },
  {
    "id": "panel.voice.dd506e7aaf0a",
    "vi": "Ngôn ngữ xem trước phải là en hoặc vi.",
    "en": "Preview language must be en or vi."
  },
  {
    "id": "panel.voice.3aab56c4fe49",
    "vi": "Yêu cầu thông báo server không hợp lệ.",
    "en": "The server announcement request is invalid."
  },
  {
    "id": "panel.voice.775c33660543",
    "vi": "Ngôn ngữ thông báo server đã thay đổi. Hãy xem lại bản xem trước rồi gửi lại.",
    "en": "The server message language changed. Review the preview before sending again."
  },
  {
    "id": "panel.voice.8ac4196b51ee",
    "vi": "Lệnh đã được nhận nhưng không thể cập nhật log console.",
    "en": "The command was accepted, but the console log could not be updated."
  },
  {
    "id": "panel.voice.f59878b3d1d7",
    "vi": "Lệnh đã được nhận nhưng không thể ghi nhật ký hoạt động.",
    "en": "The command was accepted, but its activity could not be recorded."
  },
  {
    "id": "panel.voice.83a4b64a0fd9",
    "vi": "Không thể gửi thông báo thế giới tùy chọn; thao tác quản lý vẫn tiếp tục.",
    "en": "The optional world announcement could not be sent; the management operation continues."
  },
  {
    "id": "panel.voice.c3c367b98b33",
    "vi": "Chọn một mẫu thông báo hợp lệ.",
    "en": "Choose a valid announcement template."
  },
  {
    "id": "panel.voice.b91191ec35d1",
    "vi": "Các trường thông báo phải là một đối tượng.",
    "en": "Announcement fields must be an object."
  },
  {
    "id": "panel.voice.f367d123a7c8",
    "vi": "Chọn phương thức gửi tellraw hoặc say.",
    "en": "Choose tellraw or say as the delivery method."
  },
  {
    "id": "panel.voice.52f5b771d347",
    "vi": "Thông điệp đã định dạng không được vượt quá 800 ký tự.",
    "en": "The formatted message must be at most 800 characters."
  },
  {
    "id": "panel.voice.ff2ebe43d727",
    "vi": "Lệnh được tạo không được vượt quá 1024 ký tự.",
    "en": "The generated command must be at most 1024 characters."
  },
  {
    "id": "panel.voice.9aadc6230493",
    "vi": "Lệnh say có thể mở rộng selector @. Dùng tellraw để giữ nguyên nội dung.",
    "en": "Classic say may expand @ selectors. Use tellraw to keep this message literal."
  },
  {
    "id": "panel.voice.8278a9dbe003",
    "vi": "Tên thế giới phải là văn bản.",
    "en": "World name must be text."
  },
  {
    "id": "panel.voice.d5f3579c6aa7",
    "vi": "Tên thế giới chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.",
    "en": "World name contains an incomplete Unicode character. Paste valid text again."
  },
  {
    "id": "panel.voice.6e73ef08ce15",
    "vi": "Vui lòng nhập tên thế giới.",
    "en": "World name is required."
  },
  {
    "id": "panel.voice.b467ebc54fbe",
    "vi": "Tên thế giới không được vượt quá 80 ký tự.",
    "en": "World name must be at most 80 characters."
  },
  {
    "id": "panel.voice.943d6b6bfcad",
    "vi": "Tên người chơi (không bắt buộc) phải là văn bản.",
    "en": "Player name (optional) must be text."
  },
  {
    "id": "panel.voice.9cce81f14086",
    "vi": "Tên người chơi (không bắt buộc) chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.",
    "en": "Player name (optional) contains an incomplete Unicode character. Paste valid text again."
  },
  {
    "id": "panel.voice.cceea04a73d7",
    "vi": "Vui lòng nhập tên người chơi (không bắt buộc).",
    "en": "Player name (optional) is required."
  },
  {
    "id": "panel.voice.180e0decee83",
    "vi": "Tên người chơi (không bắt buộc) không được vượt quá 80 ký tự.",
    "en": "Player name (optional) must be at most 80 characters."
  },
  {
    "id": "panel.voice.caa9055e742b",
    "vi": "Nhập số giây nguyên từ 1 đến 86400.",
    "en": "Enter a whole number of seconds from 1 to 86400."
  },
  {
    "id": "panel.voice.81bb7db19d54",
    "vi": "Địa chỉ kết nối lại (không bắt buộc) phải là văn bản.",
    "en": "Rejoin address (optional) must be text."
  },
  {
    "id": "panel.voice.75fe2a101da4",
    "vi": "Địa chỉ kết nối lại (không bắt buộc) chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.",
    "en": "Rejoin address (optional) contains an incomplete Unicode character. Paste valid text again."
  },
  {
    "id": "panel.voice.3708fc9453bb",
    "vi": "Vui lòng nhập địa chỉ kết nối lại (không bắt buộc).",
    "en": "Rejoin address (optional) is required."
  },
  {
    "id": "panel.voice.04ea9c1c585c",
    "vi": "Địa chỉ kết nối lại (không bắt buộc) không được vượt quá 96 ký tự.",
    "en": "Rejoin address (optional) must be at most 96 characters."
  },
  {
    "id": "panel.voice.f0413a69d7d9",
    "vi": "Chọn một giá trị hợp lệ cho giai đoạn thông báo.",
    "en": "Choose a valid value for announcement stage."
  },
  {
    "id": "panel.voice.914f313f02c3",
    "vi": "Tên bản sao lưu (không bắt buộc) phải là văn bản.",
    "en": "Backup name (optional) must be text."
  },
  {
    "id": "panel.voice.e07562f9d623",
    "vi": "Tên bản sao lưu (không bắt buộc) chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.",
    "en": "Backup name (optional) contains an incomplete Unicode character. Paste valid text again."
  },
  {
    "id": "panel.voice.8129c824bf83",
    "vi": "Vui lòng nhập tên bản sao lưu (không bắt buộc).",
    "en": "Backup name (optional) is required."
  },
  {
    "id": "panel.voice.18e0a81f0be8",
    "vi": "Tên bản sao lưu (không bắt buộc) không được vượt quá 80 ký tự.",
    "en": "Backup name (optional) must be at most 80 characters."
  },
  {
    "id": "panel.voice.adcb260fddc8",
    "vi": "Chi tiết hoặc thời điểm dự kiến trở lại (không bắt buộc) phải là văn bản.",
    "en": "Details or expected return (optional) must be text."
  },
  {
    "id": "panel.voice.87507a51d2a4",
    "vi": "Chi tiết hoặc thời điểm dự kiến trở lại (không bắt buộc) chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.",
    "en": "Details or expected return (optional) contains an incomplete Unicode character. Paste valid text again."
  },
  {
    "id": "panel.voice.86b8c522082a",
    "vi": "Vui lòng nhập chi tiết hoặc thời điểm dự kiến trở lại (không bắt buộc).",
    "en": "Details or expected return (optional) is required."
  },
  {
    "id": "panel.voice.f62f3fdea8ef",
    "vi": "Chi tiết hoặc thời điểm dự kiến trở lại (không bắt buộc) không được vượt quá 120 ký tự.",
    "en": "Details or expected return (optional) must be at most 120 characters."
  },
  {
    "id": "panel.voice.230886de2080",
    "vi": "Chọn một giá trị hợp lệ cho màu thông điệp.",
    "en": "Choose a valid value for color theme."
  },
  {
    "id": "panel.voice.c7eb1e23f275",
    "vi": "Thông điệp phải là văn bản.",
    "en": "Message must be text."
  },
  {
    "id": "panel.voice.618e457a8aa6",
    "vi": "Thông điệp chứa ký tự Unicode chưa hoàn chỉnh. Hãy dán lại văn bản hợp lệ.",
    "en": "Message contains an incomplete Unicode character. Paste valid text again."
  },
  {
    "id": "panel.voice.cde8457a90b4",
    "vi": "Vui lòng nhập thông điệp.",
    "en": "Message is required."
  },
  {
    "id": "panel.voice.0e0315e2f3bc",
    "vi": "Thông điệp không được vượt quá 320 ký tự.",
    "en": "Message must be at most 320 characters."
  },
  {
    "id": "panel.application.stopped_data_guard",
    "vi": "Hãy dừng ứng dụng trước khi thao tác để bảo vệ mã nguồn và dữ liệu.",
    "en": "Stop the application before this operation to protect its source files and data."
  }
]);
