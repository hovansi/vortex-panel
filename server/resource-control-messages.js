const nestedCauseSlots = { apply_failed: [0], prepare_cleanup: [1], stats_cleanup: [0], cleanup_failed: [1] };
export const RESOURCE_CONTROL_MESSAGES = [
  ['policy_fields', 'Chính sách tài nguyên chỉ được chứa mode, cpuCores và memoryMiB.', 'Resource policy must contain only mode, cpuCores and memoryMiB.'],
  ['policy_mode', 'Chế độ tài nguyên phải là shared hoặc fixed.', 'Resource mode must be shared or fixed.'],
  ['shared_fields', 'Chế độ chia sẻ không được chứa giới hạn CPU hoặc RAM cố định.', 'Shared mode must not include fixed CPU or memory limits.'],
  ['cpu_limit', 'Giới hạn CPU phải từ 0,10 đến {0} lõi, với bước 0,01.', 'CPU limit must be from 0.10 to {0} cores, in steps of 0.01.'],
  ['memory_limit', 'Giới hạn RAM phải là số nguyên từ 256 đến {0} MiB.', 'Memory limit must be an integer from 256 to {0} MiB.'],
  ['hierarchy', 'VPS này chưa hỗ trợ giới hạn CPU và RAM. Hãy liên hệ quản trị viên.', 'This VPS is not ready to apply CPU and RAM limits. Contact your administrator.'],
  ['process_path', 'Không xác minh được phạm vi tài nguyên của dịch vụ.', 'The service resource scope could not be verified.'],
  ['linked_directory', 'Phạm vi tài nguyên đã thay đổi hoặc nằm ngoài vùng quản lý.', 'The resource scope changed or is outside the managed area.'],
  ['real_directory', 'Không xác minh được vùng quản lý tài nguyên.', 'The managed resource area could not be verified.'],
  ['not_initialized', 'Chức năng giới hạn CPU và RAM chưa sẵn sàng.', 'CPU and RAM limits are not ready.'],
  ['root_changed', 'Thiết lập tài nguyên đã thay đổi. Hãy khởi động lại dịch vụ quản lý trên VPS.', 'Resource settings changed. Restart the management service on this VPS.'],
  ['linux_required', 'VPS cần Linux để áp dụng giới hạn CPU và RAM. Nền tảng này chỉ hỗ trợ dùng chung tài nguyên.', 'This VPS requires Linux to apply CPU and RAM limits. Shared resources are available on this platform.'],
  ['filesystem', 'VPS này chưa sẵn sàng áp dụng giới hạn tài nguyên. Hãy liên hệ quản trị viên.', 'This VPS is not ready to apply resource limits. Contact your administrator.'],
  ['unit_identify', 'Không xác định được dịch vụ quản lý trên VPS.', 'The management service on this VPS could not be identified.'],
  ['unit_identity', 'Không đọc được thông tin dịch vụ quản lý.', 'The management service information could not be read.'],
  ['unit_service', 'Dịch vụ quản lý chưa được cấp quyền áp dụng giới hạn tài nguyên.', 'The management service does not have permission to apply resource limits.'],
  ['enable_delegate', 'VPS chưa được cấp quyền giới hạn CPU và RAM. Hãy liên hệ quản trị viên để hoàn tất thiết lập.', 'CPU and RAM limit permissions are not configured on this VPS. Contact your administrator to complete setup.'],
  ['main_pid', 'Chỉ dịch vụ quản lý chính được phép thiết lập giới hạn tài nguyên.', 'Only the primary management service may configure resource limits.'],
  ['unit_group', 'Thiết lập tài nguyên của dịch vụ không hợp lệ.', 'The service resource settings are invalid.'],
  ['outside_group', 'Dịch vụ đang chạy ngoài phạm vi quản lý tài nguyên dự kiến.', 'The service is running outside its expected resource scope.'],
  ['controllers', 'VPS chưa cung cấp đầy đủ chức năng giới hạn CPU và RAM.', 'CPU and RAM limit support is incomplete on this VPS.'],
  ['delegate_controllers', 'Dịch vụ chưa được cấp quyền giới hạn cả CPU và RAM.', 'The service does not have permission to limit both CPU and RAM.'],
  ['early_initialize', 'Thiết lập giới hạn tài nguyên cần được hoàn tất trước khi chạy server. Hãy khởi động lại dịch vụ quản lý.', 'Resource limits must be set up before servers start. Restart the management service.'],
  ['unexpected_manager', 'Dịch vụ có tiến trình ngoài dự kiến. Hãy khởi động lại dịch vụ quản lý trước khi bật giới hạn.', 'The service contains unexpected processes. Restart the management service before enabling limits.'],
  ['move_manager', 'Không tách được tài nguyên quản lý khỏi tài nguyên server.', 'Management resources could not be separated from server resources.'],
  ['parent_not_empty', 'Còn tiến trình đang dùng vùng tài nguyên cần thiết lập.', 'Processes are still using the resource area that needs setup.'],
  ['enable_failed', 'Không bật được giới hạn CPU và RAM.', 'CPU and RAM limits could not be enabled.'],
  ['manager_limited', 'Tài nguyên của dịch vụ quản lý đang bị giới hạn như server.', 'Management service resources are currently limited like server resources.'],
  ['unavailable', 'Chức năng giới hạn tài nguyên chưa khả dụng trên VPS.', 'Resource limits are currently unavailable on this VPS.'],
  ['startup_initialize', 'Bộ điều khiển tài nguyên cố định chưa khởi tạo cho dịch vụ này.', 'Fixed resource control has not been initialized for this service.'],
  ['uuid', 'Định danh server không hợp lệ để áp dụng giới hạn tài nguyên.', 'The server identifier is invalid for applying resource limits.'],
  ['fixed_unavailable', 'Không áp dụng được giới hạn CPU và RAM đã chọn. Hãy kiểm tra thiết lập VPS trước khi chạy server.', 'The selected CPU and RAM limits cannot be applied. Check the VPS setup before starting the server.'],
  ['generated_id', 'Định danh vùng tài nguyên được tạo không hợp lệ.', 'The generated resource scope identifier is invalid.'],
  ['kernel_ack', 'Không xác minh được giới hạn {0}. Server chưa được khởi chạy.', 'The {0} limit could not be verified. The server has not been started.'],
  ['apply_failed', 'Không áp dụng được giới hạn cố định trước khi chạy server: {0}', 'Cannot apply fixed resource limits before server execution: {0}'],
  ['prepare_cleanup', 'Không dọn được vùng tài nguyên rỗng tại {0}: {1}', 'The empty resource area at {0} could not be cleaned up: {1}'],
  ['executable', 'Tệp thực thi native cần đường dẫn tuyệt đối.', 'The native executable must have an absolute path.'],
  ['direct_execution', 'Tiến trình quản lý cần chạy trực tiếp và không tách khỏi panel.', 'The managed process must use direct, attached execution.'],
  ['streams', 'Console quản lý cần giữ ba luồng pipe/pipe/pipe.', 'Managed console streams must remain pipe/pipe/pipe.'],
  ['handle_once', 'Một handle khởi chạy tài nguyên chỉ được dùng một lần.', 'A resource launch handle may only be used once.'],
  ['scope_replaced', 'Vùng tài nguyên của server đã thay đổi. Thao tác được dừng để bảo vệ dữ liệu.', 'The server resource area changed. The operation was stopped to protect your data.'],
  ['ack_identity', 'Định danh xác nhận tài nguyên không hợp lệ.', 'The resource acknowledgement identity is invalid.'],
  ['attach_timeout', 'Hết thời gian áp dụng giới hạn tài nguyên trước khi chạy server.', 'Applying resource limits timed out before the server started.'],
  ['launcher_start', 'Không khởi chạy được bộ giới hạn tài nguyên: {0}', 'Resource launcher could not start: {0}'],
  ['launcher_exit', 'Bộ giới hạn tài nguyên thoát trước khi xác nhận giới hạn (code {0}, signal {1}).', 'Resource launcher exited before limit acknowledgement (code {0}, signal {1}).'],
  ['ack_channel', 'Kênh xác nhận gắn tài nguyên không khả dụng.', 'The resource attachment acknowledgement channel is unavailable.'],
  ['ack_invalid', 'Xác nhận gắn tài nguyên không hợp lệ.', 'Invalid resource attachment acknowledgement.'],
  ['ack_pid', 'Xác nhận gắn tài nguyên không khớp PID được quản lý.', 'The resource attachment acknowledgement does not match the owned PID.'],
  ['ack_failed', 'Xác nhận gắn tài nguyên thất bại.', 'Resource attachment acknowledgement failed.'],
  ['ack_closed', 'Bộ giới hạn đóng kênh xác nhận trước khi gắn tài nguyên.', 'Resource launcher closed its acknowledgement channel before attachment.'],
  ['active_cleanup', 'Không được xóa nhóm tài nguyên khi tiến trình quản lý còn hoạt động.', 'Cannot remove the resource group while the managed process is still active.'],
  ['stats_cleanup', 'Không ghi nhận được thống kê tài nguyên trước khi dọn: {0}', 'Resource statistics could not be captured before cleanup: {0}'],
  ['descendants', 'Một số tiến trình của server chưa thoát sau yêu cầu dừng.', 'Some server processes have not exited after the stop request.'],
  ['cleanup_failed', 'Không dọn được nhóm tài nguyên tại {0}: {1}', 'Resource group cleanup failed at {0}: {1}'],
].map(([key, vi, en]) => ({ id: `panel.resource.${key}`, vi, en,
  // These slots carry generated panel causes as well as native system errors.
  // Paths and every other parameter remain opaque to the locale renderer.
  ...(nestedCauseSlots[key] ? { nested: nestedCauseSlots[key] } : {})
}));

// The preparation error can append this known suffix to a generated primary
// error. Its fixed boundary lets the locale renderer translate both messages.
const prepareCleanup = RESOURCE_CONTROL_MESSAGES.find(row => row.id === 'panel.resource.prepare_cleanup');
RESOURCE_CONTROL_MESSAGES.push({ ...prepareCleanup, id: 'panel.resource.prepare_cleanup_suffix', vi: '; ' + prepareCleanup.vi, en: '; ' + prepareCleanup.en, fragment: true });

const byKey = new Map(RESOURCE_CONTROL_MESSAGES.map(row => [row.id.slice('panel.resource.'.length), row]));
export function resourceControlMessage(key, ...params) {
  const row = byKey.get(key);
  if (!row) throw new Error(`Unknown resource-control message: ${key}`);
  return row.vi.replace(/\{(\d+)\}/g, (_match, index) => String(params[Number(index)]));
}
