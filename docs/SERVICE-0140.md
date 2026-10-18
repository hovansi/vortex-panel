# Vortex Panel 0.14.0

Ngày cập nhật: 16/10/2026.

## Kết luận rà soát

Ngắt liên kết cũ chỉ xóa cấu hình trên panel và để dịch vụ xử lý tiếp tục tồn tại. Bản này thay bằng **Gỡ Vortex khỏi VPS**: xem trước danh sách, nhập đúng tên VPS, mật khẩu quản trị panel và kết nối SSH root với khóa máy đã đối chiếu. Panel chỉ xóa liên kết sau khi độc lập kiểm tra dịch vụ đã dừng, thành phần đã gỡ và không còn tiến trình hay mount của worker. Không dùng phản hồi 202 hoặc mất kết nối làm bằng chứng hoàn tất.

VPS chính không được gỡ qua chức năng này. VPS liên kết phải không còn server, dữ liệu lưu trữ hay tác vụ phục hồi chưa xử lý; hãy di chuyển hoặc xóa server bằng chức năng quản lý server trước. Thao tác gỡ không tự xóa thế giới.

Installer mới lưu biên nhận các thành phần riêng đã tạo. Với bản cũ không có thông tin trước khi cài, panel không hứa phục hồi toàn bộ VPS về trạng thái ban đầu: các gói hệ điều hành, Node dùng chung, luật firewall không có nhãn, bản panel độc lập và tệp chưa rõ nguồn gốc được giữ và liệt kê trong kết quả. Bản nâng cấp chỉ ghi quyền sở hữu cho release/helper mới thực sự tạo; không nhận quyền sở hữu ngược cho tệp cũ.

## Hỗ trợ bộ nhớ hệ thống

Zram là bộ nhớ nén hỗ trợ hệ điều hành trong lúc áp lực RAM, không phải dung lượng bổ sung cho máy chủ game. Ngân sách cấp phát vẫn dựa trên RAM vật lý; worker giữ 0%, VPS chạy panel giữ 10%; giới hạn swap của tiến trình game vẫn bằng 0. Không cam kết mọi tình huống thiếu RAM đều được giải quyết.

Chỉ dịch vụ Linux root được quản lý với đủ công cụ, helper đúng bản và thời hạn dừng phù hợp mới có chức năng. Mở hộp thoại chỉ đọc trạng thái. Bật/tắt phải xác nhận và nhập lại mật khẩu Admin. Cấu hình tự động dùng dung lượng logic tối đa min(RAM/2, 2 GiB), giới hạn RAM thực tế min(RAM/4, 1 GiB), ưu tiên 100, thuật toán nén khả dụng; đây là chính sách sản phẩm thận trọng. Không đổi sysctl toàn cục, không dùng writeback hoặc thay disk swap.

Chỉ thiết bị có chứng cứ do Vortex tạo được thay đổi. Tắt cần đủ RAM vật lý để rút dữ liệu cùng khoảng dự phòng; thiếu RAM hoặc chưa xác định được kết quả phải giữ thiết bị và chặn yêu cầu lặp. Không resize thiết bị đang chạy. Cấu hình bật có dịch vụ khởi tạo lúc boot độc lập với panel; restart panel không tháo zram. Gỡ worker phải tắt an toàn phần zram thuộc worker trước.

Thay đổi zram, khởi động lại và gỡ dùng cơ chế loại trừ chung; server đang chạy vẫn được đọc trạng thái. Yêu cầu có ID duy nhất và nhật ký bền vững; sau mất kết nối chỉ đọc/kiểm chứng thao tác cũ, không tự gửi lại tác vụ hệ thống.

## Giao diện

Start dùng xanh lá, Stop/Kill/Xóa/Gỡ dùng đỏ, Restart/Reboot dùng hổ phách, Lưu/Tạo dùng tím. Màu đi kèm nhãn và biểu tượng, trạng thái focus/pending/disabled riêng; nút xác nhận cuối cùng giữ đúng mức độ của thao tác. Cả theme sáng và tối được đối chiếu tương phản.

## Nguồn tham khảo

- [Linux zram](https://docs.kernel.org/admin-guide/blockdev/zram.html): thiết bị nén, giới hạn bộ nhớ, reset và quản lý swap.
- [systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html): thời hạn dừng và quản lý dịch vụ.
- [WCAG: contrast minimum](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum) và [use of color](https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html): tương phản, tránh dùng riêng màu để truyền đạt ý nghĩa.

## Kiểm chứng

Các kiểm thử tập trung đã chạy HTTP thật với session/Origin/CSRF, phân quyền, mật khẩu hiện tại, Agent loopback và ánh xạ danh tính VPS; bộ thực thi hệ điều hành trong các trường hợp tác động được thay bằng mô hình kiểm soát. Bộ test đầy đủ Windows/Linux chạy lại trên chính gói phát hành, kết quả lưu tại output/service0140-release-summary.json.

Trình duyệt dùng Chromium desktop/Android mô phỏng và engine WebKit với viewport iPhone; EN/VI, sáng/tối,320–1440px. Đây không phải kiểm thử điện thoại vật lý. Các luồng mới kiểm tra GET khi mở, gửi một lần, pending, thiếu RAM, chưa xác định kết quả, kiểm chứng lại tác vụ cũ, hết phiên và dọn thông tin SSH khi đóng popup.

Không reboot hay gỡ VPS đang phục vụ để làm QA. Khả năng thực thi native, phiên bản và thành phần được đối chiếu trên VPS; enable/drain/boot zram và uninstall thật cần VM/VPS thử nghiệm dùng riêng. Không coi mô hình lệnh hoặc giao diện xác nhận là bằng chứng các thao tác đó đã chạy thật. Không tái sử dụng số lượt của bản cũ làm lượt kiểm thử mới.
