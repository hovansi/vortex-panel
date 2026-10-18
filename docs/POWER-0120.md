# Khởi động lại panel và VPS — 0.12.0

Quản trị viên mở **VPS → chọn VPS → Điều khiển khởi động lại** để khởi động lại dịch vụ trên máy đó hoặc khởi động lại toàn bộ VPS. **Cài đặt → Điều khiển panel** cũng có nút khởi động lại panel và đường dẫn tới VPS chính.

Khởi động lại dịch vụ trên VPS chính làm panel mất kết nối trong chốc lát; server trên VPS liên kết tiếp tục chạy. Khởi động lại dịch vụ xử lý trên VPS liên kết dừng rồi mở lại các server đang chạy trên máy đó. Reboot VPS ngắt mọi dịch vụ trên VPS; server Minecraft đang chạy được lưu và mở lại qua quy trình dừng/khởi động của dịch vụ. Không cam kết thời gian trở lại khi hệ điều hành hoặc mạng gặp lỗi.

Mỗi thao tác có cảnh báo và xác nhận; reboot yêu cầu nhập đúng tên VPS và đánh dấu đã hiểu ảnh hưởng. Chỉ Admin được gọi API; phiên đăng nhập, CSRF và quyền quản trị được kiểm tra. Phiên bản hiển thị ở thanh bên và Cài đặt đọc từ /healthz của dịch vụ đang chạy.

## API

- GET /api/host/power: trạng thái dịch vụ panel chính.
- GET /api/nodes/:id/power: trạng thái VPS chính (local) hoặc VPS liên kết.
- POST trên cùng đường dẫn: {nodeId, action, confirmed:true, revision, requestId} với action là restart-service hoặc reboot, requestId là UUID mới.

Form dùng revision gắn với đúng tiến trình, phiên khởi động và VPS. Không nhận lệnh shell hoặc tên dịch vụ tùy ý. API trả 202 sau khi ghi nhận bền vững ý định, rồi mới hẹn systemd thực hiện; dịch vụ cố định là bedrock-panel.service hoặc vortex-node.service. Yêu cầu trùng requestId không chạy lại. Form cũ bị từ chối sau khi tiến trình/VPS thay đổi.

Hệ thống từ chối khi có tác vụ cần hoàn tất như sao lưu, cài đặt hoặc chỉnh sửa dữ liệu. Sau khi chấp nhận, khóa nhận thay đổi mới để chuẩn bị dừng an toàn. Nếu kết quả hẹn khởi động lại chưa xác định được, giữ trạng thái chưa rõ và không tự gửi lại lệnh. Giao diện chỉ đọc trạng thái khi chờ kết nối trở lại. Nếu reboot chưa rõ kết quả, khởi động lại riêng dịch vụ cũng không mở khóa: quản trị hệ thống cần kiểm tra tác vụ systemd; trạng thái được đối chiếu lại khi VPS có phiên khởi động mới.

Nhật ký power-operations.json nằm trong thư mục dữ liệu riêng với quyền 0600; hoạt động cũng được ghi vào lịch sử quản trị. Khi dịch vụ trở lại, đối chiếu instanceId/bootId để cập nhật kết quả. Bản demo và môi trường không có systemd/quyền quản trị hiển thị lý do chưa hỗ trợ.

## Kiểm chứng

Kiểm thử tự động dùng bộ thực thi giả lập, không reboot máy chạy test. Kiểm tra trên VPS sau triển khai đọc năng lực systemd và phiên bản thực tế; kiểm thử reboot không được chạy tự động trên VPS đang phục vụ người dùng.
