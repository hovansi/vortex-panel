# World voice và kiểm thử Minecraft 26.52

Vortex MC 0.6.1 có công cụ **Announce / Thông báo** trong Console. Chọn một trong sáu mẫu, sửa nội dung, kiểm tra màu chữ rồi gửi. Mẫu chào mừng, restart, backup, restore, maintenance và custom dùng nhiều màu dễ đọc; không chèn thêm `[Vortex]` trước lời kể.

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

## Phạm vi kiểm chứng client

Trên Bedrock Windows **1.26.52**, người dùng đã xác nhận vào world, đặt/phá block, nhận thông báo console/UI, Creative và bay sau Operator, lệnh Creative bị từ chối sau Member, Visitor đi lại nhưng không đặt/phá, Member hoạt động lại và block cũ còn sau restart. Thông báo EN nhiều màu và lý do Kick đã được người dùng xác nhận. Các lượt này chạy trên panel **0.6.0**, trước khi tích hợp composer tự động 0.6.1; không được tính như bằng chứng nhận welcome mới.

Lần Join đầu đôi khi gặp **Door / InitialConnection-83**, rejoin thành công. Nguyên nhân chưa xác định. Capture của một lần kết nối thành công có signaling HTTP, candidate public nằm trong dải UDP đã cấu hình và traffic hai chiều. TLS-first handshake failure trong lượt thành công không tự chứng minh nguyên nhân của lần thất bại. Không sửa proxy hoặc bỏ Xbox authentication dựa trên suy đoán.

Sau lượt Kick cuối, người dùng bận và cho phép tiếp tục tự động. Kiểm thử API, process native, bytes world/backup, file tools, quyền, MFA và scheduler được ghi riêng. Rejoin chính thức sau Kick, inventory sau restore, hình ảnh resource pack trên client, nhiều client đồng thời và điều kiện mạng di động chưa có xác nhận. Không gọi runtime fixture, command echo hoặc parser log là client Minecraft đã đăng nhập Xbox.

Chẩn đoán giao thức tham khảo [Mojang NetherNet](https://mojang.github.io/bedrock-protocol-docs/guides/nether-net-onboarding-guide/) và [MiNET signaling TLS](https://github.com/NiclasOlofsson/MiNET/wiki/Signaling-TLS). MiNET là nguồn maintainer độc lập; mô tả fallback không phải cam kết Mojang rằng lỗi Door đã được sửa. Báo cáo theo môi trường nằm tại [VERIFICATION](VERIFICATION.md) và [VPS acceptance](VPS-ACCEPTANCE.md).
