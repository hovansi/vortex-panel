export const BACKUP_MESSAGES = [
  ['response_limit', 'Phản hồi sao lưu vượt giới hạn; chưa tạo bản sao lưu.', 'The backup response exceeds the supported limit; no backup was created.'],
  ['process_exit', 'Server đã dừng trong lúc sao lưu; chưa tạo bản sao lưu.', 'The server stopped during backup; no backup was created.'],
  ['connection_unavailable', 'Kết nối sao lưu chưa sẵn sàng.', 'The backup connection is not ready.'],
  ['response_timeout', 'Server chưa xác nhận lệnh sao lưu trong thời gian chờ.', 'The server did not confirm the backup command within the time limit.'],
  ['send_failed', 'Không gửi được lệnh sao lưu đến server.', 'The backup command could not be sent to the server.'],
  ['connection_closed', 'Kết nối sao lưu đã đóng.', 'The backup connection closed.'],
  ['world_name', 'Tên thế giới đang chạy không hợp lệ.', 'The running world name is invalid.'],
  ['not_ready', 'Server chưa xác nhận dữ liệu sẵn sàng sao lưu.', 'The server has not confirmed that its data is ready to back up.'],
  ['manifest_invalid', 'Danh sách tệp sao lưu của server không hợp lệ.', 'The server returned an invalid backup file list.'],
  ['manifest_path', 'Đường dẫn tệp sao lưu không thuộc thế giới đang chạy.', 'A backup file path is outside the running world.'],
  ['manifest_size', 'Kích thước hoặc tệp trùng trong danh sách sao lưu không hợp lệ.', 'The backup file list contains an invalid size or duplicate file.'],
  ['manifest_limit', 'Dữ liệu sao lưu vượt giới hạn 2 GiB hoặc 50.000 mục.', 'The backup exceeds 2 GiB or 50,000 entries.'],
  ['manifest_incomplete', 'Danh sách sao lưu thiếu dữ liệu thế giới; chưa tạo bản sao lưu.', 'The backup file list is missing world data; no backup was created.'],
  ['source_short', 'Tệp thế giới thay đổi hoặc ngắn hơn dữ liệu server đã xác nhận.', 'A world file changed or is shorter than the data confirmed by the server.'],
  ['source_truncated', 'Tệp thế giới bị rút ngắn trong lúc sao lưu.', 'A world file became shorter during backup.'],
  ['write_failed', 'Không ghi được dữ liệu sao lưu.', 'Backup data could not be written.'],
  ['already_held', 'Server đang chuẩn bị một bản sao lưu khác. Hãy chờ hoàn tất rồi thử lại.', 'The server is preparing another backup. Wait for it to finish and try again.'],
  ['hold_unconfirmed', 'Server chưa xác nhận bắt đầu sao lưu trực tuyến.', 'The server has not confirmed that the online backup started.'],
  ['prepare_progress', 'Đang chuẩn bị bản sao lưu; người chơi vẫn có thể kết nối', 'Preparing the backup; players can stay connected'],
  ['prepare_rejected', 'Server từ chối chuẩn bị dữ liệu sao lưu.', 'The server refused to prepare backup data.'],
  ['prepare_unknown', 'Không đọc được trạng thái chuẩn bị sao lưu của server.', 'The server backup preparation status could not be read.'],
  ['prepare_timeout', 'Server chưa chuẩn bị xong dữ liệu sao lưu trong thời gian chờ.', 'The server did not finish preparing backup data within the time limit.'],
  ['depth_limit', 'Dữ liệu sao lưu có quá nhiều thư mục lồng nhau.', 'The backup contains too many nested folders.'],
  ['entry_limit', 'Dữ liệu sao lưu vượt giới hạn 50.000 mục.', 'The backup exceeds 50,000 entries.'],
  ['special_file', 'Dữ liệu sao lưu chứa liên kết hoặc tệp đặc biệt.', 'The backup contains a link or a special file.'],
  ['size_limit', 'Dữ liệu sao lưu vượt giới hạn 2 GiB.', 'The backup exceeds 2 GiB.'],
  ['copy_progress', 'Đang sao chép dữ liệu thế giới', 'Copying world data'],
  ['resume_unconfirmed', 'Chưa nhận được xác nhận tiếp tục lưu thế giới.', 'The server has not confirmed that world saving resumed.'],
  ['runtime_changed', 'Server chưa sẵn sàng hoặc đã đổi phiên trong lúc sao lưu.', 'The server is not ready or its running session changed during backup.'],
  ['wait_ready', 'Đợi server sẵn sàng rồi tạo bản sao lưu.', 'Wait until the server is ready before creating a backup.'],
  ['volume_space', 'Không đủ dung lượng trống trong gói máy chủ để tạo bản sao lưu tạm và ZIP.', 'The server storage plan does not have enough free space for the temporary snapshot and ZIP.']
].map(([id, vi, en]) => ({ id: `panel.backup.${id}`, vi, en }));

const resumeVi = 'Không xác nhận được server đã tiếp tục lưu dữ liệu. Quản trị viên cần kiểm tra Console và gửi save resume: {0}';
const resumeEn = 'The server has not confirmed that world saving resumed. An administrator must check Console and send save resume: {0}';
BACKUP_MESSAGES.push({ id: 'panel.backup.resume_required', vi: resumeVi, en: resumeEn, nested: [0] });
BACKUP_MESSAGES.push({ id: 'panel.backup.resume_required_suffix', vi: '; ' + resumeVi, en: '; ' + resumeEn, nested: [0], fragment: true });
BACKUP_MESSAGES.push({ id: 'panel.backup.cleanup_warning', vi: 'Chưa dọn được dữ liệu sao lưu tạm tại {0}: {1}', en: 'Temporary backup data could not be removed at {0}: {1}', nested: [1] });
