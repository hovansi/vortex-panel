# Vortex Panel 0.14.1

Ngày: 16/10/2026.

## Lỗi đã quan sát

Sau khi triển khai 0.14.0, nhật ký trên VPS liên kết ghi nhận một yêu cầu bật hỗ trợ bộ nhớ của Admin thất bại. Kiểm tra chỉ đọc xác nhận chưa có thiết bị zram được tạo: VPS thiếu module zram cho kernel 6.8.0-134-generic, trong khi công cụ modprobe có sẵn. VPS chính cũng thiếu module tương ứng cho kernel 6.8.0-147-generic. Kho Ubuntu cung cấp gói linux-modules-extra phù hợp. Việc chỉ kiểm tra công cụ chưa đủ để kết luận tính năng sẵn sàng.

## Sửa lỗi

Khả năng thực thi nay cần kiểm tra thêm lệnh modprobe dry-run với đường dẫn và tham số cố định. Bước này không nạp module, không chạy install hook và không bật swap. Thiếu module thì tính năng báo rõ thành phần hệ thống còn thiếu, thay vì cho bật rồi trả lỗi chung.

Installer chuẩn bị module phù hợp với đúng kernel đang chạy khi có gói tương ứng trong kho Ubuntu. Không tự chuyển kernel hay reboot. Nếu kernel riêng không có gói phù hợp, panel vẫn có thể chạy và phần hỗ trợ bộ nhớ được báo chưa khả dụng. Các gói hệ điều hành là công cụ dùng chung, được giữ lại khi gỡ Vortex.

Nâng cấp giữ nguyên trạng thái hỗ trợ bộ nhớ người quản trị đã chọn. Không tự thử lại yêu cầu bật đã thất bại. Thành phần thụ động đã có cùng nội dung và quyền truy cập được giữ nguyên inode để bảo toàn biên nhận gỡ; thành phần chưa rõ nguồn gốc vẫn được bảo vệ.

Ngân sách tạo server tiếp tục dựa vào RAM vật lý. Zram không được cộng vào dung lượng cấp phát. Các tính năng, giao diện và giới hạn gỡ VPS vẫn như [0.14.0](SERVICE-0140.md).

## Kiểm chứng

Gói 0.14.1 được kiểm tra theo phạm vi thay đổi và chạy bộ hồi quy trên Windows/Linux. Giao diện 41 tệp giữ nguyên byte của 0.14.0; kiểm tra website thật ghi đúng phiên bản mới và trạng thái hiện tại, kể cả khi người quản trị thay đổi zram trong lúc nghiệm thu. Kết quả nằm trong output/service0141-release-summary.json.

Nguồn: [Linux zram](https://docs.kernel.org/admin-guide/blockdev/zram.html) và kết quả modprobe/modinfo, apt-cache policy trên các VPS được cấu hình. Các giá trị dry-run và gói module được đối chiếu trực tiếp với hệ điều hành đang chạy.
