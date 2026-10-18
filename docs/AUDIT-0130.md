# Audit 0.13.0 — console, lịch sử và tương tác

Ngày đối chiếu: 16/10/2026. Đây là danh mục công việc và phạm vi kiểm chứng của bản 0.13.0; kết quả cuối cùng nằm trong output/audit0130-release-summary.json và báo cáo trình duyệt trong output/playwright/audit0130. Không dùng kết quả lịch sử của phiên bản cũ làm lượt kiểm thử mới.

## Sửa theo phản hồi và kết quả rà soát

- Console hiện tại gắn với từng lần chạy. Start/restart tạo runId mới; GET và WebSocket phải cùng runId. Phản hồi cũ về muộn không được thêm lại log của phiên trước. Stop có chủ đích dọn console; lỗi/crash giữ đầu ra cuối để xem trước khi start lại. Lịch sử chẩn đoán trên đĩa vẫn có giới hạn riêng và không được tự nạp vào console hiện tại.
- Mặc định giữ 100 hoạt động gần nhất và 50 tác vụ đã hoàn tất, kèm giới hạn ngày/dung lượng. Bảo vệ tác vụ đang chạy, dữ liệu phục hồi và tham chiếu còn cần thiết. Bản nâng cấp tự động giữ cấu hình retention người quản trị đã chỉnh; lần triển khai này đặt giới hạn số lượng về 100/50 theo yêu cầu mới và giữ các ngưỡng tùy chỉnh còn lại.
- Vai trò VPS chạy panel được chuyển khỏi dòng vị trí sang nhãn/biểu tượng có tên dễ tiếp cận cạnh trạng thái kết nối.
- Rà soát bất đồng bộ: một yêu cầu cũ không được thay nội dung popup khác vừa mở; thao tác chờ phải giữ đúng ngữ cảnh server/VPS, không tự gửi lại lệnh có tác dụng phụ.
- Khi đổi phiên, kết quả và lỗi HTTP/upload đều bị loại nếu thuộc phiên cũ; khi đăng xuất/hết phiên phải đóng và dọn nội dung popup, thông báo, console, clipboard file và dữ liệu quản trị phía client.
- Theo dõi cài VPS chịu được lỗi GET tạm thời bằng retry có giới hạn và kiểm tra đúng ID tác vụ; không gửi lại yêu cầu cài đặt.
- Đăng nhập lại sau khi hết phiên phải khởi tạo lại trạng thái điều hướng và chỉ cập nhật workspace server khi DOM của workspace còn tồn tại; thử lại Admin → Viewer → Admin không tải lại trang.
- Lệnh console không gửi trùng trong lúc chờ; bản nháp mới không bị phản hồi của lệnh cũ xóa mất.
- Lịch chạy từ xa có bộ nhớ xác nhận tạo/sửa/xóa; snapshot đang truyền không được xóa lịch vừa tạo hoặc làm sống lại lịch đã xóa.
- Start thất bại khi lưu trạng thái phải phục hồi trạng thái trước khi spawn, cho phép thử lại sau khi lỗi lưu được xử lý.
- Chuyển từ wizard SSH sang tiến trình dùng ngữ cảnh của đúng form vừa xác nhận; kết quả kiểm tra VPS trả muộn không được mở lại popup đã đóng.
- Link server chấp nhận mã hóa URL hợp lệ của ID ghép, vẫn kiểm tra đúng danh sách được cấp quyền và từ chối thành phần sai.
- Tài liệu API được cập nhật cho sao lưu đang chạy, thao tác file thường đang chạy, quyền can thiệp mạnh, console runId và điều khiển restart/reboot.

## Ma trận cần đối chiếu

| Nhóm | Các luồng và trạng thái |
| --- | --- |
| Đăng nhập và tài khoản | đăng nhập/sai mật khẩu, setup, MFA, đăng xuất, đổi mật khẩu, Admin/Operator/Viewer, phạm vi server |
| Điều hướng | tổng quan, danh sách server, tạo server, VPS, phiên bản, lịch chạy, hoạt động, host, cài đặt, thông báo, tìm kiếm nhanh |
| Vòng đời server | start/stop/restart/kill, đang chuyển trạng thái, busy, crash, reconnect, lệnh console, chạy mới và phản hồi cũ |
| Dữ liệu | danh sách/tìm kiếm/sắp xếp/chọn nhiều file, editor/revision, mkdir/create/upload/rename/copy/move/delete, ZIP, bảo vệ runtime, can thiệp mạnh |
| Thế giới và add-on | tạo/chuyển/nhập/xuất/xóa world, pack phụ thuộc/kích hoạt/gỡ, dữ liệu không hợp lệ, bảo vệ world đang dùng |
| Sao lưu | tạo, theo dõi tác vụ, xác minh/khóa/tải/xóa/phục hồi, lịch chạy, sai phiên bản và busy |
| Người chơi và luật | allowlist/quyền, người chơi trực tuyến, gamerules, thông báo, trạng thái cheat, revision/phiên người chơi cũ |
| Cấu hình và tài nguyên | lưu/không lưu draft, cổng/trùng cổng, CPU/RAM/đĩa, thiếu tài nguyên, tăng dung lượng, telemetry và mẫu cũ |
| VPS và panel | VPS chính/liên kết, trạng thái thật/offline/bảo trì, tên hiển thị/hostname, firewall, restart/reboot, quyền quản trị, gửi lặp và chưa rõ kết quả |
| Giao diện | desktop, Android Chromium, iPhone WebKit mô phỏng; EN/VI; sáng/tối; 320–412 px; bàn phím/focus/ESC, popup, chạm, scroll/overflow, loading/error/empty/disabled |

Nguồn API literal được kiểm kê tại output/audit0130-route-inventory.json. Bộ test tự động chứa các kiểm thử HTTP thật với controller/agent cục bộ, dữ liệu và bộ thực thi native giả lập hoặc cô lập. Ma trận trình duyệt phải ghi rõ số trường hợp thực chạy, engine và giới hạn; không diễn đạt viewport mô phỏng như kiểm thử điện thoại vật lý. Reboot, shell, SSH cài máy và thay đổi firewall sản xuất không được kích hoạt chỉ để chụp UI.

## Phạm vi trình duyệt đã chạy

Ma trận cơ sở có 96 lượt kiểm tra nội dung: 64 Chromium trên desktop/Android và 32 WebKit trên hai profile iPhone. Bổ sung 16 lượt desktop EN/tối với deep link ID mã hóa, tổng cộng 112 lượt hợp lệ. Các profile dùng EN/VI, sáng/tối và chiều rộng 320–1440 px. Đã bổ sung 48 lượt cuộn tới cuối nội dung trên ba profile cùng 54 hộp thoại và 12 lượt kiểm tra chân biểu mẫu dài; không có phần tràn ngang trang hoặc nút cuối bị thanh điều hướng che trong các lượt này. Báo cáo `output/playwright/audit0130/audit-report.json`, `coverage-matrix.json`, các bản `*-responsive-final.json` và báo cáo cuộn cuối trang là bằng chứng cuối; bản thử harness trước đó không được cộng vào số lượt.

Bộ kiểm kê 118 action và 9 vị trí form xác nhận có handler, không có nghĩa từng action đều được kích hoạt trên máy thật. Các tác vụ reboot, điều khiển firewall và cài qua SSH được kiểm tra bằng bộ thực thi cô lập hoặc phản hồi mạng giả lập, không thực hiện trên VPS sản xuất để nghiệm thu UI. Kiểm tra native Bedrock riêng chỉ dùng server QA do lượt kiểm tra tạo, có xác minh dọn dữ liệu và giữ metadata Survival.

## Nguồn chính thức và điều áp dụng

- [Pterodactyl Wings configuration](https://docs.pterodactyl.io/v2/wings/configuration): tách số dòng console gửi cho kết nối mới khỏi cơ chế quay vòng log. Áp dụng giới hạn và tách console phiên hiện tại khỏi lịch sử; không suy rằng mọi panel đều tự xóa log lúc stop.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html): quản lý thời hạn lưu, quyền xem, bí mật và lỗi hệ thống ghi log. Áp dụng chính sách lưu có giới hạn, không ghi thông tin xác thực và giữ dữ liệu cần phục hồi.
- [W3C Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow): kiểm tra nội dung dọc ở 320 CSS px, tránh cuộn ngang cả trang. Khu vực có nội dung hai chiều như console/editor được đánh giá riêng.
- [W3C Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): kích thước mục tiêu tối thiểu 24 CSS px hoặc khoảng cách theo ngoại lệ; ưu tiên vùng chạm lớn hơn cho nút chính.
- [WAI modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): focus nằm trong popup, có đóng bằng ESC và quay về nơi gọi phù hợp. Dùng làm cơ sở kiểm tra bàn phím và popup thay đổi bất đồng bộ.
- [MDN Viewport concepts](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/CSSOM_view/Viewport_concepts), [CSS env()](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env): kiểm tra vùng an toàn và chiều cao popup khi viewport thay đổi; không coi mô phỏng kích thước là bằng chứng của bàn phím ảo trên điện thoại thật.
- [Playwright Emulation](https://playwright.dev/docs/emulation), [Browsers](https://playwright.dev/docs/browsers): engine Chromium/WebKit và profile thiết bị dùng để kiểm tra viewport/touch/user agent. Đây là mô phỏng trình duyệt, không thay thế thử trên phần cứng iPhone/Android.

Kiểm tra npm audit --omit=dev ngày 16/10/2026: không có advisory được báo cho lockfile tại thời điểm kiểm tra (output/audit0130-dependencies.json). Kết quả này là đối chiếu cơ sở dữ liệu advisory, không chứng minh toàn bộ phần mềm không có lỗi bảo mật.

WebSocket được bổ sung guard theo kết nối/phiên và gỡ callback khi thay kết nối. Đây là phòng vệ bổ sung, không ghi nhận như lỗi rò rỉ trình duyệt đã tái hiện: [WHATWG WebSockets](https://websockets.spec.whatwg.org/#feedback-from-the-protocol) yêu cầu bỏ sự kiện message khi kết nối không OPEN.
