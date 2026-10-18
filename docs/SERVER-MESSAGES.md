# Minecraft server announcements

Vortex Panel có công cụ **Announce / Thông báo** trong Console. Chọn một trong sáu mẫu, sửa nội dung, kiểm tra màu chữ rồi gửi. Mẫu chào mừng, restart, backup, restore, maintenance và custom dùng nhiều màu dễ đọc; không chèn thêm `[Vortex]` trước lời kể.

**Server configuration → Lifecycle → Server message language** mặc định **EN**. Chỉ đặt **VI** tại server cần thông báo tiếng Việt. Đổi ngôn ngữ giao diện panel không đổi thông báo Minecraft. Đây là metadata panel: có thể lưu khi BDS đang chạy, không đổi `server.properties`, cổng, identity hoặc restart process.

**Automatic world voice** bật mặc định. Lời chào chỉ gửi sau native `Player Spawned` đã tương ứng với người chơi online, một lần trong mỗi kết nối. Trước graceful stop/restart hoặc backup theo lịch, khi có người chơi, server báo trước ba giây. Không thêm thời gian chờ khi server rỗng, tắt tự động, force-kill hoặc crash. Lỗi thông báo tùy chọn không chặn dừng an toàn. Tắt tự động vẫn cho người vận hành gửi thông báo thủ công.

## Soạn và gửi

- **say** là mặc định, để Minecraft hiển thị tiền tố `[Server]`. Từ chối nội dung có selector `@` có thể bị mở rộng thành tên người chơi.
- **tellraw** dùng JSON literal để gửi văn bản nguyên nghĩa cho tất cả người chơi. Nội dung HTML, dấu nháy và đường dẫn là văn bản; preview dùng `textContent` cùng bảng màu cố định.
- Dòng mới, ký tự điều khiển và mã màu `§` người dùng dán được làm sạch; preview chỉ rõ nội dung sẽ gửi. Mẫu cung cấp màu. Giới hạn bị từ chối thay vì cắt mất dữ kiện.
- Announcement chỉ gửi lời nhắn. Countdown không tự tạo lịch restart. Chỉ chọn giai đoạn “Complete” sau khi kiểm tra thao tác thật đã thành công; UI yêu cầu xác nhận riêng.
- Ngôn ngữ server đổi trong lúc popup mở sẽ giữ draft, cập nhật preview và yêu cầu xem lại trước khi gửi. UI dùng `expectedLanguage`; backend trả 409 trước khi viết nếu preview cũ.
- Console acknowledgement xác nhận enqueue lệnh, không chứng minh người chơi đã nhận. Lỗi cập nhật log/audit sau enqueue là warning, không biến thành thông báo thất bại có thể khiến gửi lặp. Chỉnh sửa mới hơn trong lúc gửi được giữ lại.

Cú pháp `say`, `tellraw` và màu `§` dựa trên tài liệu Microsoft, cả hai lệnh không yêu cầu bật cheats. [say](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/say?view=minecraft-bedrock-stable), [tellraw](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/tellraw?view=minecraft-bedrock-stable), [Raw Message JSON](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/rawmessagejson?view=minecraft-bedrock-stable).
