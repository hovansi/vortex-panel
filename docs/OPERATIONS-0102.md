# Vortex Panel 0.10.2

Khi API nhận yêu cầu tạo server, form chuyển ngay sang popup của đúng tác vụ đã trả về. Không đợi dashboard đồng bộ mới mở tiến trình. Một lỗi đọc trạng thái sau đó không được biến thành lỗi tạo server hoặc cho gửi lại form đã được nhận.

Popup đọc endpoint được xác thực `/api/jobs/:id`, cập nhật theo tiến trình thực, thử lại khi kết nối tạm lỗi và ngừng theo dõi khi đóng popup, đổi tài khoản hoặc tác vụ kết thúc. Kết quả cũ không được làm lùi tiến trình hay thay thế kết quả hoàn tất. Lịch sử dashboard vẫn phục vụ danh sách tổng quan; không quyết định sự tồn tại của tác vụ vừa nhận.

Node ghi nhận server/tác vụ trả về ngay sau yêu cầu thành công và bảo vệ chúng khỏi snapshot cũ đang bay. Endpoint đọc tác vụ giữ cùng phạm vi quyền với lịch sử hiện có; không tiết lộ ID của tác vụ ngoài quyền.

Vị trí tự động là ước tính từ IP kết nối ra Internet của chính VPS, không phải xác minh vị trí trung tâm dữ liệu. Tra cứu chạy nền, có giới hạn thời gian/dung lượng, chỉ gọi các endpoint HTTPS cố định và không gửi tài khoản hay token. Nếu lần đầu thất bại, thử lại sau 1, 5, 15 rồi 60 phút; nếu từng có kết quả tốt, giữ kết quả đó với nhãn cũ trong khi thử lại. Giá trị đặt thủ công vẫn được ưu tiên. Có thể tắt tra cứu bằng `VORTEX_GEOLOCATION=off`.

Tài liệu nguồn: [ipwho.is](https://ipwhois.io/documentation), [FreeIPAPI](https://freeipapi.com/docs/api-reference/get-ip-info).
