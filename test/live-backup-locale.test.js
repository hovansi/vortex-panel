import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeApiResponse, translatePanelMessage } from '../server/locale.js';

test('online backup progress, runtime errors and resume recovery translate through jobs/API without changing native commands or names', () => {
  const progress = 'Đang chuẩn bị bản sao lưu; người chơi vẫn có thể kết nối';
  const base = 'Tệp thế giới thay đổi hoặc ngắn hơn dữ liệu server đã xác nhận.';
  const recovery = 'Không xác nhận được server đã tiếp tục lưu dữ liệu. Quản trị viên cần kiểm tra Console và gửi save resume: Server chưa xác nhận lệnh sao lưu trong thời gian chờ.';
  const message = base + '; ' + recovery;
  const original = { jobs: [{ id: 'owned', type: 'backup', serverId: 'scope', message: progress }, { id: 'failed', type: 'backup', message, warnings: [recovery] }] };
  const en = localizeApiResponse('/api/jobs', original, 'en');
  assert.equal(en.jobs[0].message, 'Preparing the backup; players can stay connected');
  assert.equal(en.jobs[0].messageI18n.vi, progress);
  assert.equal(en.jobs[1].message, 'A world file changed or is shorter than the data confirmed by the server.; The server has not confirmed that world saving resumed. An administrator must check Console and send save resume: The server did not confirm the backup command within the time limit.');
  assert.equal(en.jobs[1].warnings[0], translatePanelMessage(recovery, 'en'));
  assert.equal(localizeApiResponse('/api/jobs', original, 'vi').jobs[1].message, message);
  assert.equal(original.jobs[0].message, progress);
  const backups = { backups: [{ id: 'opaque', name: progress, consistency: 'native-online', sha256: 'a'.repeat(64) }] };
  assert.equal(localizeApiResponse('/api/servers/scope/backups', backups, 'en').backups[0].name, progress);
  assert.equal(translatePanelMessage('Đợi server sẵn sàng rồi tạo bản sao lưu.', 'en'), 'Wait until the server is ready before creating a backup.');
});
