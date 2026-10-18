<p align="center"><img src="assets/vortex-banner.svg" alt="Vortex Panel — quản lý Minecraft Bedrock, Node.js và Python" width="1200"></p>

# Vortex Panel

[English](../README.md) · [Cài đặt](INSTALL.md) · [Node.js/Python](applications.md) · [Kết nối VPS](NODES.md)

Vortex Panel quản lý **Minecraft Bedrock, ứng dụng Node.js và Python** trên Ubuntu qua một workspace chung. Giao diện có sáng/tối, hỗ trợ máy tính/điện thoại và hai ngôn ngữ **EN/VI**, mặc định English. Tác giả: **@CallMeHak**.

## Cài bằng một lệnh

Trên VPS **Ubuntu 22.04+ x86_64**, có systemd và quyền sudo/root:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/hovansi/vortex-panel/releases/latest/download/install.sh | sudo bash
```

Installer tải release ổn định mới nhất, kiểm tra checksum/archive, cài dependency và dịch vụ. Bản cài mới tự chuẩn bị HTTPS theo IP công khai; kết thúc sẽ in URL và hướng dẫn tạo Admin bằng setup token riêng. Không có mật khẩu `admin` dùng chung.

HTTPS ban đầu dùng chứng chỉ tự ký: trình duyệt sẽ yêu cầu tin cậy chứng chỉ. Đối chiếu fingerprint được in khi cài trước khi chấp nhận. Muốn chứng chỉ được trình duyệt tin cậy sẵn, cấu hình CA/domain/IP theo [hướng dẫn vận hành](OPERATIONS.md). Installer không tự chấp nhận điều khoản ACME thay bạn.

Chứng chỉ tự ký có hạn **365 ngày**, chưa tự gia hạn; cập nhật panel giữ nguyên chứng chỉ hiện có. Thay chứng chỉ trước khi hết hạn, xác minh lại fingerprint/endpoint và cập nhật tin cậy trên trình duyệt nếu chứng chỉ đổi. Với chứng chỉ từ CA, làm theo hướng dẫn vận hành và kiểm tra cơ chế gia hạn thực tế.

Lệnh mặc định bật quyền quản trị host root cho bản cài mới. Ứng dụng Node.js/Python vẫn chạy bằng tài khoản riêng không có quyền root, trong sandbox. Bản nâng cấp giữ chế độ dịch vụ và cấu hình truy cập đã có. Installer dừng khi gặp dịch vụ web không thuộc quyền quản lý hoặc cổng xung đột; firewall nhà cung cấp/NAT cần cho phép truy cập phù hợp. Xem [chi tiết cài đặt, tùy chọn và cập nhật](INSTALL.md).

## Các công cụ chính

| Nhóm | Khả năng |
| --- | --- |
| Minecraft Bedrock | Catalog Stable/Preview và bản cũ có tìm kiếm; console; world/gamerule gồm tọa độ; người chơi, quyền, allowlist; add-on; nhập/xuất world |
| Node.js/Python | Tự tra bản ổn định mới nhất khi tạo rồi ghim phiên bản; entry file/npm script/module; cài thư viện; xem project; biến môi trường bí mật |
| Tệp và sao lưu | Upload/download, editor chống ghi đè xung đột, copy/move/rename, nén/giải nén, backup, retention và restore |
| Tài nguyên | CPU/RAM dùng chung hoặc giới hạn riêng; volume lưu trữ; số liệu CPU/RAM/đĩa/RX-TX; cấp cổng trống tự động theo VPS |
| Nhiều VPS | Nhập SSH trong panel để cài worker, xác minh agent, chọn VPS khi tạo server, theo dõi kết nối và bảo trì |
| Vận hành | Lịch, hoạt động/tác vụ có giới hạn lịch sử, popup tiến trình và ID, firewall theo server, quyền Admin/Operator/Viewer, TOTP và mã khôi phục |

Runtime của server cũ giữ nguyên; tạo ứng dụng mới không tự nâng cấp ứng dụng đang có. CPU/RAM là mức trần sử dụng, không phải cam kết tài nguyên vật lý. VPS chạy panel giữ lại 10% ngân sách; worker dùng dung lượng hiệu dụng, vẫn phải qua kiểm tra RAM/đĩa và năng lực thực tế.

## Dữ liệu và nâng cấp

Chạy lại lệnh cài để cập nhật release ổn định mới nhất. Cập nhật có thể khởi động lại panel và workload cục bộ, nên chọn thời gian bảo trì. Sao lưu dữ liệu, khóa mã hóa, environment và chứng chỉ ra ngoài VPS trước khi nâng cấp. Rollback source không khôi phục thay đổi world/dữ liệu ứng dụng.

Thao tác tệp và backup của Node.js/Python yêu cầu dừng ứng dụng. Bedrock có quy trình snapshot online riêng. Giới hạn dung lượng/định dạng nằm trong từng tài liệu; không nên dùng source ZIP thay cho bản sao lưu dữ liệu.

- [Cài đặt và cập nhật](INSTALL.md)
- [Quản lý ứng dụng](applications.md)
- [Nodes và SSH tự cài](NODE-PROVISIONING.md)
- [World và khôi phục](WORLDS.md)
- [Vận hành và snapshot toàn panel](OPERATIONS.md)
- [API](API.md)
- [Nguồn và giấy phép bên thứ ba](THIRD_PARTY.md)

## Phát triển trên máy cá nhân

Node.js 22+:

```bash
npm ci
npm run check
npm test
npm run demo
```

Mở `http://127.0.0.1:3001`. Demo có nhãn rõ và mô phỏng thao tác server. Windows dùng để phát triển/preview UI; workload và điều khiển host thực cần môi trường Linux được hỗ trợ.

Báo lỗi tại [GitHub Issues](https://github.com/hovansi/vortex-panel/issues), kèm phiên bản panel/Ubuntu và log đã che thông tin riêng. Không đăng mật khẩu, token, cookie hoặc tệp bí mật vào issue công khai.
