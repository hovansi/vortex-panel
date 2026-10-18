# Vortex Panel 0.11.0 — vận hành dịch vụ

Ngày: 16/10/2026 (Asia/Bangkok).

## Thay đổi

- Sao lưu thủ công và theo lịch khi Bedrock đang chạy: `save hold` → `save query` → sao chép chính xác danh sách/số byte Bedrock xác nhận → `save resume` → nén và kiểm SHA-256/CRC. Không tự dừng hoặc khởi động lại server. Lỗi chuẩn bị/copy vẫn cố tiếp tục lưu thế giới; nếu không nhận được xác nhận sẽ báo quản trị viên. Khôi phục, thay phiên bản, chỉnh dữ liệu đang mở vẫn cần dừng.
- File thường có thể tạo, sửa, tải lên, đổi tên, di chuyển, xóa và nén khi server chạy. Các file thế giới đang được dùng không được copy/nén bằng file manager để tránh tạo bản sao không nhất quán; sử dụng Sao lưu. Xem/tải từng file vẫn được phép.
- Checkbox **Can thiệp mạnh / Advanced file access** chỉ dành cho Admin: nhập lại mật khẩu hiện tại và tick xác nhận rủi ro. Quyền có hiệu lực tối đa 10 phút, gắn với phiên đăng nhập và server; có thể tắt ngay. Không vượt chặn đường dẫn, symlink, phân quyền hay khóa thế giới đang chạy. Các thao tác vẫn có nhật ký và giữ kiểm tra revision/không ghi đè đích có sẵn.
- Giao diện EN/VI dùng Tài nguyên/Lưu trữ/VPS; thông báo giới hạn lưu trữ tách dòng, có khoảng cách.
- VPS chạy panel chính giữ lại 10% ngân sách CPU/RAM. VPS liên kết cấp 100% ngân sách hiệu dụng cho server, đồng thời vẫn kiểm tra áp lực RAM và khoảng trống thực tế trước khi khởi động.
- Gói VPS liên kết chỉ chứa dịch vụ xử lý server và phụ thuộc; không chứa ứng dụng panel, trang web hoặc API đăng nhập. Installer tự kiểm tra/cài công cụ hệ thống, lưu trữ và mạng cần thiết, giữ cấu hình hiện hữu và có rollback. Không thay sysctl toàn hệ thống hoặc bật tường lửa hàng loạt.

## Khắc phục kết nối Survival trên VPS thật

Kiểm tra cấu hình đã lưu xác nhận NetherNet TCP 19132 và UDP 19134–19237. UFW đang bật nhưng thiếu cả bốn quy tắc IPv4/IPv6 tương ứng. Đã dùng API xem trước theo revision rồi áp dụng đúng phạm vi server: cả bốn quy tắc có hiệu lực, audit lưu thành công, TCP kiểm tra từ bên ngoài truy cập được. Native PID giữ nguyên 188934 và trạng thái running trước/sau, không restart.

Bằng chứng: `output/service0110-live-network.json` và `output/service0110-live-firewall-fix.json` (không đóng gói cùng release). Chưa xác nhận lại việc tham gia bằng client Minecraft. Mở được TCP chưa chứng minh kết nối UDP/client thành công hoặc loại trừ tường lửa của nhà cung cấp.

Cơ chế NetherNet đối chiếu [tài liệu chính thức Mojang](https://github.com/Mojang/bedrock-protocol-docs/blob/main/additional_docs/NetherNetOnboardingGuide.md): báo hiệu và luồng game trực tiếp là các bước riêng, cần đường mạng UDP đến server.

## Cập nhật

Cần cập nhật cả panel chính và dịch vụ trên VPS liên kết để các tính năng sao lưu mới và ngân sách 100% được áp dụng. Thay mã controller riêng không thay giới hạn hoặc thuật toán của agent cũ. Khởi động lại dịch vụ agent để nạp mã mới có thể làm các server trên VPS đó gián đoạn ngắn; installer giữ trạng thái khởi chạy lại. Mỗi lần sao lưu sau cập nhật không cần restart.

Trước khi thay dịch vụ, giữ bản release và cấu hình cũ, sao lưu metadata và dữ liệu, kiểm thử gói trên Linux rồi kiểm tra sức khỏe, tài nguyên và server sau cập nhật. Mã nguồn/gói đã chuẩn bị tại workspace; trạng thái triển khai thực tế được báo riêng, không suy ra từ kiểm thử cục bộ.
