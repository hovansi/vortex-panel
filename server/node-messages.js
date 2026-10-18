const messages = [
  ['Node was not found.', 'Không tìm thấy node.'],
  ['Invalid node resource identity.', 'Định danh tài nguyên của node không hợp lệ.'],
  ['Invalid node settings.', 'Thiết lập node không hợp lệ.'],
  ['Node maintenance must be true or false.', 'Trạng thái bảo trì node phải là bật hoặc tắt.'],
  ['Use a hostname or IP address without a URL or port.', 'Dùng tên miền hoặc địa chỉ IP, không kèm URL hay cổng.'],
  ['A node configuration operation is already pending.', 'Node đang có thao tác cấu hình; hãy đợi hoàn tất.'],
  ['Wait for active node operations before changing connection credentials.', 'Hãy đợi thao tác đang chạy trên node hoàn tất trước khi đổi thông tin kết nối.'],
  ['Wait for active node operations before unlinking this node.', 'Hãy đợi thao tác đang chạy trên node hoàn tất trước khi bỏ liên kết.'],
  ['Node returned an invalid server inventory or network reservation.', 'Node trả về danh sách server hoặc thông tin cổng không hợp lệ.'],
  ['Remote nodes are unavailable in demo mode.', 'Chế độ demo không kết nối hoặc điều khiển VPS từ xa.'],
  ['The node limit has been reached.', 'Đã đạt giới hạn số node.'],
  ['This node agent or endpoint is already linked.', 'Agent hoặc địa chỉ này đã được liên kết.'],
  ['This endpoint is already linked.', 'Địa chỉ này đã được liên kết.'],
  ['This endpoint is not a compatible Vortex Node agent.', 'Địa chỉ này không phải agent Vortex Node tương thích.'],
  ['This endpoint is not the enrolled Vortex Node agent.', 'Địa chỉ này không thuộc agent đã được liên kết.'],
  ['The node identity does not match this link. Re-enroll the correct agent.', 'Định danh node không khớp liên kết. Hãy kết nối lại đúng agent.'],
  ['Node identity or inventory is incompatible.', 'Định danh hoặc danh sách server trên node không tương thích.'],
  ['Node authentication failed. Check the agent token.', 'Xác thực node thất bại. Kiểm tra token của agent.'],
  ['Node authentication failed. Check or replace the agent token.', 'Xác thực node thất bại. Kiểm tra hoặc thay token của agent.'],
  ['Node credentials cannot be decrypted. Restore .node-key or replace this node token.', 'Không giải mã được thông tin xác thực node. Khôi phục .node-key hoặc thay token của node này.'],
  ['Node is offline. Its servers may still be running; no command was queued.', 'Node đang mất kết nối. Server trên VPS vẫn có thể đang chạy; lệnh chưa được đưa vào hàng đợi.'],
  ['This node is in maintenance and is not accepting new servers.', 'Node đang bảo trì và không nhận server mới.'],
  ['This node still has servers. Remove them before unlinking the node.', 'Node vẫn còn server. Hãy xóa các server trước khi bỏ liên kết node.'],
  ['Reconnect the node before removing its link so its inventory can be checked.', 'Kết nối lại node để kiểm tra danh sách server trước khi bỏ liên kết.'],
  ['The server inventory limit for this node has been reached.', 'Đã đạt giới hạn số server được quản lý trên node này.'],
  ['Node certificate fingerprint does not match. No credentials were sent.', 'Dấu vân tay chứng chỉ node không khớp. Thông tin xác thực chưa được gửi.'],
  ['Pinned node certificate is not currently valid.', 'Chứng chỉ đã ghim của node chưa hoặc không còn hiệu lực.'],
  ['Node certificate could not be verified.', 'Không xác minh được chứng chỉ của node.'],
  ['Unable to establish a trusted node connection.', 'Không thiết lập được kết nối tin cậy tới node.'],
  ['Node connection timed out.', 'Kết nối tới node quá thời gian chờ.'],
  ['Node request timed out.', 'Yêu cầu tới node quá thời gian chờ.'],
  ['Node request failed.', 'Yêu cầu tới node thất bại.'],
  ['Node response exceeds the configured byte limit.', 'Phản hồi của node vượt giới hạn dung lượng.'],
  ['The node did not return valid JSON.', 'Node trả về dữ liệu JSON không hợp lệ.'],
  ['Use the exact SHA-256 certificate fingerprint (64 hexadecimal digits).', 'Nhập đúng dấu vân tay chứng chỉ SHA-256 gồm 64 ký tự thập lục phân.'],
  ['Node endpoint must be an HTTPS origin without credentials, path, query or fragment.', 'Địa chỉ node phải là HTTPS gốc, không kèm tài khoản, đường dẫn, truy vấn hoặc fragment.'],
  ['HTTP nodes are restricted to literal 127.0.0.1 or [::1].', 'HTTP chỉ dành cho node loopback tại địa chỉ 127.0.0.1 hoặc [::1].'],
  ['The node request outcome is unknown. No automatic retry was made; reconnect and inspect the server/job state before trying again.', 'Chưa xác định được kết quả thao tác trên node. Panel không tự gửi lại; hãy kết nối lại và kiểm tra server/tác vụ trước khi thử lại.'],
  ['The node request outcome is unknown. No automatic retry was made; reconnect and check server/job history before trying again.', 'Chưa xác định được kết quả thao tác trên node. Panel không tự gửi lại; hãy kết nối lại và kiểm tra lịch sử server/tác vụ trước khi thử lại.'],
];
export function nodeErrorPayload(message, language = 'en') {
  const index = messages.findIndex(([en]) => en === message);
  if (index < 0) {
    const field = /^Invalid node (name|location|public address)\.$/.exec(message);
    if (field) return { error: language === 'vi' ? 'Tên, vị trí hoặc địa chỉ game của node không hợp lệ.' : message, errorI18n: { id: 'panel.nodes.invalid-field', params: [], en: message, vi: 'Tên, vị trí hoặc địa chỉ game của node không hợp lệ.' } };
    return null;
  }
  const [en, vi] = messages[index];
  return { error: language === 'vi' ? vi : en, errorI18n: { id: `panel.nodes.error.${index}`, params: [], en, vi } };
}
