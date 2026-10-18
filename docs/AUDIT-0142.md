# Vortex Panel 0.14.2

Ngày: 17/10/2026.

## Phản hồi thao tác người chơi

Nhật ký người dùng cung cấp có cả `No targets matched selector` và phản hồi thành công của Bedrock. Lệnh bị từ chối trước đây vẫn được giao diện gom vào thông báo chưa xác nhận; phản hồi `De-opped: ExamplePlayer` có dấu hai chấm chưa được nhận dạng. Lệnh dịch chuyển tọa độ nguyên X/Z được Bedrock trả ở tâm khối, nên `1 1 1` cho kết quả `1.50, 1.00, 1.50` theo chính bản ghi người dùng.

Giao diện nay có ba kết quả riêng: thành công được Bedrock xác nhận, Bedrock từ chối, và chưa xác nhận kết quả. Mỗi kết quả giữ nguyên phản hồi native, không dịch log gốc, cùng giải thích EN/VI. Không suy đoán nguyên nhân của lỗi không tìm thấy mục tiêu và không tự gửi lại lệnh.

Backend đối chiếu đúng hành động, tên mục tiêu và các giá trị mà phản hồi native phân biệt được, trong khoảng phản hồi có mốc console trước/sau. Input echo, chat, thông báo Server và lỗi mốc nội bộ không tạo xác nhận thành công. Thiếu mốc kết thúc, phản hồi mâu thuẫn, tiến trình đóng hoặc phản hồi chưa nhận dạng vẫn là chưa xác nhận. Lịch sử tương quan có giới hạn trong từng runtime; phản hồi giống một thao tác trước đã gửi nhưng chưa xác nhận không được dùng để báo chắc chắn cho lần sau. Hết khả năng theo dõi thì giữ trạng thái chưa xác nhận, không âm thầm bỏ lịch sử để báo thành công.

Xác nhận ở đây là phản hồi trực tiếp của máy chủ Bedrock. Không có biên nhận từ ứng dụng Minecraft để chứng minh vật phẩm đã xuất hiện trên màn hình người chơi. Các kiểm tra parser dùng bản ghi người dùng và tình huống cô lập; không tự tác động kill/kick/give lên tài khoản thật trong đợt rà soát này.

## CPU và biểu đồ

CPU host lấy chênh lệch bộ đếm `/proc/stat`. Thời gian thực thi gồm user, nice, system, IRQ và softIRQ; guest đã nằm trong user/nice nên không cộng lần hai. I/O wait và thời gian vCPU bị hypervisor giữ lại (steal) được tách khỏi CPU thực thi. Mẫu bộ đếm giảm hoặc không hợp lệ bị bỏ, không biến thành số 0. API giữ độ chính xác trước khi giao diện định dạng.

Ô CPU hiển thị cả core đã dùng/tổng và phần trăm: `0,09 / 1 core` tương đương 9% một vCPU. Với từng server, mẫu số là hạn mức CPU hiệu dụng của server/pool, khác với tổng CPU của host. Tooltip giải thích nguồn, phạm vi và thời điểm mẫu. Bộ nhớ vẫn là MemTotal trừ MemAvailable; lưu trữ vẫn là filesystem chứa dữ liệu; lưu lượng host bao gồm tiến trình khác.

Giá trị hiện tại và biểu đồ đều xét thời gian riêng cho từng chỉ số. Snapshot CPU cũ về muộn không thay thế CPU mới, nhưng dữ liệu lưu trữ mới cùng snapshot vẫn có thể cập nhật. Bộ đếm RX/TX được kiểm tra từng interface; reset một interface không bị mức tăng của interface khác che đi. Không bổ sung mẫu giả hoặc làm mượt bằng dữ liệu dựng.

Đối chiếu chỉ đọc 10 giây trên hai VPS trước cập nhật cho thấy Node một vCPU thực dùng khoảng 5,94–9,71%; steal và I/O wait của Node bằng 0 trong khoảng đo. Tiến trình Bedrock không có người chơi dùng khoảng 0,015–0,020 core. Đây là quan sát khi nhàn rỗi, không phải kiểm chứng tải nhiều người. Số CPU thấp trong ảnh có thể hoàn toàn hợp lý; các sửa đổi không làm tăng số liệu giả tạo.

## Zram

Tách số liệu từ `/sys/block/zramN/mm_stat`: dữ liệu trước nén, phần dữ liệu đã nén và RAM cấp phát thực tế gồm metadata/phân mảnh. Dung lượng thiết bị logic và swap đã chiếm lấy riêng từ sysfs và `/proc/swaps`; chúng không đồng nghĩa RAM vật lý. Giới hạn RAM bằng 0 nghĩa là không đặt giới hạn, không phải chỉ được dùng 0 byte.

Ví dụ đọc thật trên Node trước cập nhật: 983.040 byte trước nén (960 KiB), 40.178 byte dữ liệu nén (khoảng 39,2 KiB), 516.096 byte RAM cấp phát (504 KiB), 1 MiB swap logic đã chiếm và khoảng 959 MiB dung lượng thiết bị. Những số khác nhau này không tự chứng minh có lỗi kernel. Giao diện hiển thị thời điểm đo và nút tải lại; không mô tả trạng thái tĩnh là cập nhật liên tục.

Tổng swap được phân loại bằng danh tính thiết bị, kể cả zram do bên ngoài quản lý. Swap ngoài zram không được gọi mặc định là I/O ổ đĩa. Bộ đếm thay đổi theo thời gian không làm mất revision cấu hình. Zram tiếp tục không tăng ngân sách RAM vật lý dành cho server. Cập nhật phần đọc thống kê không thay đổi lựa chọn bật/tắt hiện có.

## Kiểm chứng và giới hạn

Bằng chứng theo phạm vi nằm ở `output/audit0142`, `output/service0142` và báo cáo phát hành `output/service0142-release-summary.json`. Kiểm thử trình duyệt với số liệu cô lập được phân biệt với phép đo kernel/API thật. Nâng cấp giữ riêng vai trò panel chính và worker; worker không cài frontend. Không reboot VPS, thay đổi swap hoặc gỡ dịch vụ để kiểm thử đợt này.

Nguồn chính thức: [Linux proc](https://docs.kernel.org/filesystems/proc.html), [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html), [network statistics](https://docs.kernel.org/networking/statistics.html), [zram](https://docs.kernel.org/admin-guide/blockdev/zram.html), [Minecraft give](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/give?view=minecraft-bedrock-stable). Quy tắc tọa độ trong bản vá được đối chiếu với phản hồi native do người dùng cung cấp; không coi tài liệu cú pháp là bằng chứng thay cho lần thử có người chơi.
