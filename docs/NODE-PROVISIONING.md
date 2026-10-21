# Cài node từ panel qua SSH · Vortex Panel

Quản trị viên nhập host/IP, cổng SSH, username và password hoặc private key để panel cài agent trên VPS. Quyền SSH cần là root thực; bản này không dùng sudo tương tác. Host phải là Ubuntu 22.04 trở lên, CPU và userspace 64-bit cùng kiến trúc x86-64 (`x86_64`/`amd64`) hoặc ARM64 (`aarch64`/`arm64`), có systemd, ít nhất 2 GiB đĩa trống và 1 GiB RAM. Các mức tài nguyên là policy preflight của panel, không bảo đảm đủ cho mọi tải công việc.

Panel chính và agent có thể chạy trên cả hai kiến trúc. VPS ARM64 chạy ứng dụng Node.js/Python native; Bedrock Linux chính thức cần worker x86-64. Panel chính ARM64 vẫn quản lý được worker x86-64 để chạy Bedrock. Hệ thống không cài trình giả lập và không tự đổi các runtime đã ghim của ứng dụng cũ.

Installer kiểm tra mô-đun cần cho hỗ trợ bộ nhớ bằng lệnh chỉ kiểm tra, không nạp mô-đun. Nếu còn thiếu, installer chỉ xét gói `linux-modules-extra-<kernel đang chạy>` có Candidate hợp lệ và mô phỏng kế hoạch APT trước khi cài đúng phiên bản đó. Có thể cài mới thêm `wireless-regdb` với phiên bản được ghim khi metadata của gói mô-đun yêu cầu trực tiếp và gói phụ thuộc chưa có. Installer từ chối giao dịch gói đang dang dở, nâng cấp/xóa gói đã có và mọi thay đổi gói khác. Không có kế hoạch phù hợp thì bỏ qua bước này; panel/agent vẫn cài bình thường. Không đổi kernel, không reboot, không tự bật hoặc thử lại tính năng hỗ trợ bộ nhớ. VPS dùng kernel riêng hoặc bị nhà cung cấp giới hạn có thể tiếp tục báo tính năng chưa khả dụng. Cơ chế ghim phiên bản và mô phỏng dùng các tùy chọn được mô tả trong [tài liệu APT của Ubuntu](https://manpages.ubuntu.com/manpages/noble/man8/apt-get.8.html).

## Hai bước xác nhận host

Lượt kiểm tra đầu chỉ thực hiện SSH handshake để đọc fingerprint **`SHA256:<base64>`**, rồi từ chối host key trước user authentication. Nó chưa gửi password/private-key authentication và chưa đọc thông tin hệ điều hành. Đối chiếu fingerprint bằng kênh tin cậy của nhà cung cấp VPS trước khi xác nhận.

Sau khi quản trị viên xác nhận fingerprint, panel kiểm tra đăng nhập, Ubuntu/kiến trúc, UID root, systemd, đĩa/RAM và agent có sẵn. Cài đặt yêu cầu đúng fingerprint đó. Nếu khóa host đổi sau bước kiểm tra, kết nối bị chặn trước khi gửi thông tin đăng nhập. Fingerprint SSH khác với fingerprint certificate HTTPS của agent; không dùng một loại thay cho loại kia.

## Tác vụ tự động

Tác vụ được ghi nhận bền vững trước khi trả trạng thái đã xếp hàng. Chỉ Admin được chạy/xem tác vụ; tối đa hai tác vụ đồng thời và không nhận hai lượt cho cùng host/cổng. Lịch sử giữ 20 tác vụ kết thúc gần nhất, cùng các trạng thái cần bảo vệ. Job công khai có `type:node-provision`, `scope:nodes`, `adminOnly:true`, `serverId:null`, phase/progress và số bytes upload thực. Upload 100% chưa có nghĩa đã cài xong.

Với VPS chưa có agent, panel:

1. Giành lock cài đặt trên VPS, kiểm tra cổng TCP agent mặc định 8443 hoặc cổng tùy chọn 1024–65535.
2. Tạo ZIP từ source công khai theo whitelist. Không đưa `data`, `output`, `.env`, node config, keys hay backup vào gói.
3. Tạo thư mục staging UUID riêng dưới `/root`, quyền 0700; tải source qua SFTP và đối chiếu SHA-256 trên VPS.
4. Khởi động runner độc lập bằng `nohup`, với stdin đóng và log riêng quyền 0600. Runner chuẩn bị unzip nếu thiếu, chạy installer và ghi exit status nguyên tử. Panel không đưa nội dung installer log ra giao diện vì installer có thể in token agent ở cuối.
5. Nếu UFW đang active, thêm duy nhất rule TCP cổng agent từ IP panel quan sát qua `SSH_CONNECTION`. Không disable firewall, không mở cổng cho toàn Internet và không tự mở cổng Minecraft.
6. Đọc config và certificate công khai qua SFTP trong bộ nhớ, đối chiếu certificate pin/identity qua HTTPS từ chính panel rồi liên kết node. Chỉ lúc HTTPS identity được xác minh mới báo hoàn tất/kết nối thành công.

Firewall/security group của nhà cung cấp cloud cần cho phép cổng agent từ panel. Không có API credential của cloud nên panel không tự sửa được lớp đó. Nếu HTTPS bị chặn, job báo rõ đã cài agent nhưng chưa liên kết được; agent/service được giữ lại. Lượt kiểm tra/cài lại sau đó tái sử dụng agent hoạt động, không cài lại một cách mù quáng.

## Agent hiện có

Agent protocol 1 đang hoạt động được tái sử dụng, giữ config, TLS, data và cổng hiện tại. Nếu node đó đã liên kết với panel, thao tác cập nhật liên kết giữ nguyên central node ID và các grants composite. Không restart hoặc ghi đè agent khỏe chỉ để liên kết lại. Config/service có sẵn nhưng không hoạt động bị từ chối thay vì bị ghi đè tự động.

Tên/vị trí/địa chỉ game được gửi qua API node manager; SSH password/private key không đi vào shell command hoặc bundle. Cổng SSH chỉ dùng cho provisioning; hoạt động thường ngày dùng HTTPS agent và token riêng.

## Bí mật, hủy tác vụ và phục hồi

Password, private key và passphrase chỉ nằm trong closure tác vụ đang chạy rồi được giải phóng tham chiếu; không lưu trong `nodeProvisionJobs`, activity/job events, response hoặc log công khai. Token agent được đọc riêng qua SFTP rồi lưu bằng vault `.node-key` của panel sau khi liên kết. Không có cam kết xóa vật lý các chuỗi khỏi bộ nhớ JavaScript. Cần HTTPS và bảo vệ tài khoản Admin/MFA vì quyền provisioning tương đương quyền root VPS được cung cấp.

Dừng/restart panel không kill APT/installer đã chạy detached. Job active được đánh dấu interrupted/outcome unknown khi panel dừng hoặc khởi động lại, không tự chạy lại. Hãy kiểm tra VPS đó trước một yêu cầu mới; mất kết nối không chứng minh cài đặt chưa bắt đầu. Lỗi đã biết từ installer, lỗi chưa xác định do timeout và lỗi HTTPS sau cài là các trạng thái khác nhau.

Các lệnh và lượt đọc SFTP nhỏ có deadline 15 giây; lượt tải source có deadline tổng 10 phút, bước chờ installer tối đa một giờ. Kết nối SSH còn sống không làm gia hạn vô hạn các deadline này. Dừng panel hủy stream/session SFTP đang chờ nhưng không gửi lệnh kill installer detached.

Staging đã thành công được dọn theo đúng UUID, realpath và inode/device đã ghi nhận. Lỗi sau detached giữ lại đường dẫn installer log riêng để quản trị viên kiểm tra; không quét/xóa thư mục người dùng. Cài đặt không phải transaction sau mất điện: snapshot/backup trước nâng cấp quan trọng vẫn cần thiết. Lock/staging còn lại sau mất kết nối hoặc crash cứng cần đối chiếu owner/tác vụ trên VPS trước khi xử lý, không tự xóa để thử lại.

## Contract backend

- `discover({host,port?})`: chỉ đọc SSH host key; trả `hostFingerprint`, `requiresHostConfirmation:true`, `authenticated:false`.
- `check({host,port?,username,password XOR privateKey,passphrase?,hostFingerprint})`: fingerprint đã xác nhận; trả host capabilities, compatible và existingAgent đã khử bí mật. `check` không fingerprint cũng chỉ discovery.
- `start({...SSH fields,hostFingerprint,name,location?,publicAddress?,agentPort?},user)`: đồng bộ validate/commit job rồi chạy nền, trả public job. Không tự retry mutation khi mất kết nối.
- `jobs()/getJob(id)`: chỉ record whitelist công khai. Router trung tâm phải yêu cầu Admin và áp Origin/CSRF như các mutation khác.
- `close()`: dừng luồng điều khiển, đánh dấu kết quả gián đoạn và giải phóng kết nối, không gửi lệnh kill installer trên VPS.

Nguồn kỹ thuật: [ssh2 Client/hostVerifier](https://github.com/mscdex/ssh2#client-methods), [Node stream pipeline](https://nodejs.org/docs/latest-v22.x/api/stream.html#streampipelinesource-transforms-destination-callback).
