# VPS acceptance — Vortex MC 0.7.0

Release 0.7.0 bổ sung giới hạn CPU/RAM thật, runtime gamerules, hành động theo phiên người chơi, log retention và tiến trình/chuyển động mới. Windows full suite **276/276**, không fail/skip/cancelled; syntax đạt. Linux chạy lại đúng source archive được xác minh bằng inventory SHA trước khi triển khai. Không cộng số lượt chạy lặp vào tổng. Log I/O refinement có 5 test file thật mới: 401 lần append tuần tự tạo 2 compactions với file2MiB hoặc4 với1MiB; 20 lần maintenance yên lặng không ghi lại; trường hợp expired nằm trước2000 dòng mới vẫn được dọn. Ring/tail có giới hạn1500 dòng; file vật lý được giới hạn tuổi/dung lượng. Bằng chứng: `output/operations070-log-hysteresis-report.json`.

Kiểm thử độc lập trên Ubuntu dùng unit/data/world/ports riêng, không sửa Survival của người dùng. **14/14 nhóm Bedrock thật 1.26.52.3** kiểm tra đọc 15 luật, đổi Keep inventory/PvP/random tick, restart lưu luật, stale world/value/player guards, role/CSRF, native fixed limits và OOM được ghi lại. **5/5 nhóm kernel thật** xác nhận CPU0.2core đo0.2012core, RAM256MiB gây SIGKILL/OOM nhưng supervisor còn sống, chặn exec khi attach thất bại, giữ PID/stdin/stdout và dọn cgroup. Các bằng chứng đầy đủ ngoài source: `output/operations070-native-run-*.json`, `output/operations070-resource-linux-proof.json`.

Browser QA dùng auth/API/file thật và byte-stream ZIP inert; gameplay/cgroup trong fixture được mô phỏng rõ ràng. Các kiểm tra này xác minh UI/request/draft/progress/accessibility, không thay bằng chứng kernel/native. Báo cáo browser và ảnh ở `output/playwright/operations070-qa`. Kiểm tra EN/VI, desktop/mobile, dark/Reduce motion, draft/save races, stale navigation/player, permission, log clear/export và phần trăm thực. Một lỗi popup player mở sau khi chuyển trang đã được sửa bằng kiểm tra cả route và DOM origin, có failure/retest evidence riêng.

Không có client Xbox thật kết nối trong đợt0.7.0; hiệu ứng Give/Kill/Kick trên một người chơi đăng nhập chưa được xác nhận trong game. Các quan sát client của bản0.6.0 bên dưới là lịch sử riêng, không được tính thành xác nhận client mới.

Production hiện chỉ còn server **Survival** do người dùng đã xóa các server trước. Không khôi phục chúng. Trước nâng cấp: dừng an toàn, giữ khóa DATA_DIR độc quyền, snapshot đầy đủ và đối chiếu mọi member/hash, private0600 ngay lúc tạo. Sau nâng cấp: TLS health phải khớp MainPID/version/source SHA, chạy lại đúng tập server trước đó, giữ users/vault/env/properties/permissions/identity/backups/lịch và các setting người dùng. Cache phiên bản tự phát hiện và chính sách log mặc định là các trường dẫn xuất/thay đổi dự kiến. Driver có rollback/resume nếu snapshot/install/acceptance thất bại. Final snapshot/release proof ở `output/vps/operations070-*`.

Lịch sử kiểm chứng trước0.7.0:

## Nghiệm thu VPS · Vortex MC 0.6.1

Delta mới: World voice nhiều màu, EN mặc định theo từng server, composer preview và kiểm tra ngôn ngữ cũ; tự chào sau Spawned và báo trước graceful pause; chỉnh sửa người chơi giữ XUID. Nội dung announcement là dữ liệu nguyên nghĩa, không dịch theo UI locale. Console acceptance không chứng minh client đã nhận. Xem [SERVER-MESSAGES](SERVER-MESSAGES.md), [API](API.md) và [VERIFICATION](VERIFICATION.md).

Người chơi Windows Bedrock 1.26.52 đã xác nhận gameplay/quyền/thông báo/Kick trên bản 0.6.0. Từ lúc người chơi bận, ma trận tự động **16 workflow** dùng API HTTPS và executable Mojang 1.26.52.3 đã kiểm world/backup/restore, pack function, mạng, lịch và crash recovery. World thực người chơi, quyền Member, ports và identity được phục hồi; server chính giữ nguyên trong QA. Evidence mới supersede giới hạn “chưa có client” trong các bản lịch sử dưới đây, nhưng không supersede các mục client chưa xác nhận sau Kick hoặc lỗi Door chưa rõ nguyên nhân.

Windows full suite **203/203**, syntax đạt; UI catalog1045/backend583. Fixture UI mới dùng auth/API/files thật với runtime inert và ack mô phỏng rõ ràng; không tính fixture là native/gameplay. Full platform Linux, browser/layout và live new-source acknowledgement được ghi theo source hash riêng. Giới hạn native/peer UDP/resource rendering và concurrency freshness ở tài liệu kiểm chứng vẫn áp dụng.

Trước nâng release, tạo snapshot đầy đủ khi panel/BDS đã dừng, đối chiếu manifest mọi file/directory data với từng tar member, bao gồm cả hai world, protected backups, vault, users, runtime packages và identity. Snapshot riêng root0600. Installer root mode tạo immutable release và readiness rollback; kiểm toàn bộ source inventory, TLS health PID với systemd MainPID, cả hai native runtime, environment/vault/users/cấu hình/quyền/key và lịch production trước/sau. Snapshot/release SHA cùng proof cuối lưu ngoài source tại `output/vps/client061-*` để tránh SHA tự tham chiếu.

Browser fixture mới:42 tiêu chí và96 layouts đạt,0 pageerror/native alert. Composer và config controls44px. Windows final203/203; nguồn Linux/release/live acknowledgement được đối chiếu riêng. Sau snapshot, catalog tự cập nhật historyCheckedAt, versionsCheckedAt và checkedAt của hai nguồn lịch sử; desired settings hash chỉ bỏ qua bốn timestamp này. Báo cáo failure đầu giữ nguyên và proof confirmed ghi rõ exception. Không bỏ qua bất kỳ field cấu hình/quyền/identity/user/vault hay lịch production nào.

Lab người chơi được giữ để sử dụng tiếp. Test không chứng nhận server mạnh nhất, năng lực nhiều client, mọi bản Bedrock từng phát hành hoặc kiến trúc multi-node/S3/container đã triển khai. Những báo cáo cũ phía dưới giữ nguyên phạm vi tại thời điểm thực hiện.

---
# Lịch sử nghiệm thu VPS · Vortex MC 0.6.0

Delta vận hành ngày **14/10/2026**: Worlds import/export/create/select/delete theo server; backup SHA-256/CRC, Verify và Protect; activity gắn immutable server ID; quyền tải world/backup/identity chặt hơn. Completion đã commit có warning rõ ràng nếu ghi audit/status cuối lỗi; restore và rollback cùng lỗi giữ cả dữ liệu gốc/candidate và marker chặn start để quản trị phục hồi. Quy trình và giới hạn tại [WORLDS](WORLDS.md), [OPERATIONS](OPERATIONS.md), [API](API.md).

Source cuối đạt **179/179 trên Windows** và **179/179 trên Ubuntu**, syntax JavaScript/Bash đạt. Native run **`ops060-20261014T083340Z-82016a`** đạt **11 nhóm** bằng API thật và executable Mojang Linux **1.26.52.3**, trên data directory và process QA riêng. Seed 64-bit giữ chính xác; BDS sinh world/LevelDB, export/import đối chiếu từng byte, backup corrupt bị từ chối trước thay dữ liệu, verify sau sửa xóa đúng cảnh báo, restore đọc lại gold block qua stdout native mới sau negative control air. Viewer/Operator GET/HEAD, server scope và activity sau rename đều được thử. Production PID, properties và identity không đổi trong lượt QA; hai server/tài khoản QA, process và data fixture đã dọn. Không xem fixture UI hoặc command echo là bằng chứng native.

Browser fixture đạt **20/20 nhóm**, **56 layout checks**; regression Verify/banner mới nhất đạt riêng trên backend cuối. Provenance và giới hạn từng lượt được giữ ở [VERIFICATION](VERIFICATION.md). EN/VI mặc định EN, 1031 khóa UI và 543 template backend; không thay tên world/seed/hash theo ngôn ngữ.

Trước activation, đã tạo **full data snapshot nhất quán 450.703.232 byte**, kiểm SHA-256 và các member users/vault/properties/identity; snapshot riêng quyền 0600, không nằm trong ZIP source. Deployment dùng installer tạo release mới và rollback nếu readiness lỗi. Acceptance artifact `output/vps/operations060-release-proof.json` đối chiếu **toàn bộ inventory source**, health PID với systemd MainPID, trạng thái BDS và hash environment/users/vault/properties/identity, cùng số server/user/schedule. Kiểm UI live là lượt chỉ đọc riêng qua HTTPS có TLS verification bình thường; kết quả/ảnh ở `output/playwright/operations060-live`. Tài liệu source không chứa credentials, địa chỉ production hoặc hash source ZIP tự tham chiếu.

Nghiệm thu 0.6.0 không thử lại mọi lịch sử phiên bản, reboot hoặc fault kernel của 0.4.1; các lượt cũ được giữ phía dưới theo đúng phạm vi. **Chưa có client/tài khoản Minecraft/Xbox chính thức để xác nhận authenticated NetherNet join, XUID thực hoặc gameplay/resource pack trên client.** Không khẳng định mô hình multi-node/container quota, S3, passkeys hoặc scheduler chaining đã triển khai; những đề xuất nằm tại [RESEARCH-2026-10-14](RESEARCH-2026-10-14.md).

---
# Lịch sử nghiệm thu VPS · Vortex MC 0.5.1

Bản 0.5.1 sửa UI/load login scene và bộ chọn EN/VI; không thay logic quản lý world, quyền, file, lịch backup hoặc network Bedrock. Source release, hashes, snapshot trước upgrade, full platform tests và kiểm UI live được lưu riêng dưới `output/vps/ui-polish-*` và `output/playwright/ui-polish-review`. Trước/sau triển khai đối chiếu environment, user store, MFA vault, production properties và identity key; fixture UI không được tính như gameplay.

Xem [UI-POLISH](UI-POLISH.md) và [VERIFICATION](VERIFICATION.md). Phạm vi Minecraft/Xbox và giới hạn kiến trúc đã ghi ở bản vận hành trước vẫn áp dụng.

---
# Lịch sử nghiệm thu VPS · Vortex MC 0.5.0

**0.5.0 bổ sung VI/EN, mặc định English.** Source candidate đạt **122/122** trên Windows và Ubuntu; browser fixture thật đạt **34 ca** với 20 mobile layouts, kiểm draft, UTF-8 bytes, MFA và async responses. Đây là delta bản địa hóa; không gộp số này vào tổng nhóm BDS của 0.4.1. Xem [VERIFICATION](VERIFICATION.md) và [I18N](I18N.md).

## Nền vận hành 0.4.1 đã xác nhận

Ngày nghiệm thu: **14/10/2026**. Tài liệu này ghi nhận những kiểm tra đã thực hiện trên VPS, cùng các điều kiện chưa đủ để kiểm chứng. Các nhóm dưới đây có phần phạm vi giao nhau; số nhóm không phải tổng số mọi request/assertion.

## Môi trường đã dùng

Ubuntu **24.04.5 x86_64**, kernel **6.8.0-147**, Node **22.23.3**, systemd, NGINX và chế độ root được bật rõ ràng. Installer mặc định vẫn dùng tài khoản dịch vụ riêng; root mode là lựa chọn quản trị. Cài dependency/ownership, nâng release qua symlink và khôi phục release/service/environment khi candidate lỗi đã được chạy thật.

Panel truy cập qua HTTPS bằng IP với chứng chỉ Let's Encrypt được kiểm tra bằng TLS verification bình thường. Certbot **5.8** đã cấp/gia hạn production với serial mới, chạy renewal dry-run và reload NGINX. Chứng chỉ IP thuộc profile ngắn hạn 160 giờ, cần tiếp tục duy trì renewal tự động. [Chính sách Let's Encrypt](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), [Certbot webroot cho IP](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

Các phép thử ghi/xóa dùng instance, tài khoản hoặc bản sao được gắn nhãn QA. Chưa đưa địa chỉ IP thật, mật khẩu, seed/recovery, private key hoặc cookie vào tài liệu nguồn. Kết quả và ledger chi tiết lưu trong vùng `output/vps` riêng, không đóng gói cùng source; tệp chứa credentials không được công bố.

## Kết quả đã xác nhận

| Phạm vi | Kết quả thực tế | Giới hạn kết luận |
| --- | --- | --- |
| Core HTTP/WebSocket | **21 nhóm đạt**: catalog/download/import, tạo/cài, start/stop/restart/kill/auto-restart, cấu hình/cổng, file tools, player JSON, backup/update/clone, add-on, schedules, RBAC/thu hồi phiên/MFA và terminal/audit | Ghi nhận BDS PID, RSS, bytes filesystem và phản hồi mới từ native stdout; input echo không tính là bằng chứng command thực thi |
| Giới hạn dữ liệu | **5 nhóm đạt** trên bản sao Ubuntu: upload đúng 100 MiB và +1 byte; 1.000/1.001 nguồn; sparse 2 GiB +1 byte; ZIP 50.000/50.001 mục và expanded quota; multipart phiên bản đúng 1 GiB/+1 byte | Fixture 1 GiB cố ý không phải ZIP hợp lệ: đúng giới hạn tới validator ZIP, vượt giới hạn bị HTTP413; không kết luận đã cài runtime 1 GiB |
| Lỗi ghi trước đó | **13 điểm đạt** với kernel ENOSPC tại đường ghi metadata tạm qua `/dev/full`: file create/edit/delete/copy/move/rename/ZIP, cấu hình/cổng, player JSON, lịch/tài khoản và phục hồi ghi sau bỏ fault | Không làm đầy volume chính; đây là lỗi kernel thật trên bản sao, không phải mô phỏng mọi dạng hỏng ổ đĩa |
| Xóa/backup sau sửa | **5 điểm đạt**: xóa backup/server, tạo backup, retention dưới ENOSPC và EPERM với immutable file sau commit | Giữ bytes cũ, catalog/ACL/lịch/references khi commit thất bại; cleanup đã commit nhưng bị chặn có cảnh báo/quarantine |
| Full snapshot restore | **3 điểm đạt**: tài khoản và khóa MFA gốc, cổng TCP/UDP bị process bên ngoài chiếm, native BDS đọc gold block từ LevelDB đã restore | Restore vào dữ liệu riêng, không trộn hoặc ghi đè dữ liệu chính |
| Readiness installer | **3 tình huống thực tế đạt**: process/unit đúng, health của process khác, unit không hoạt động | Health PID phải khớp MainPID của unit hoạt động; có kiểm tra lại PID/trạng thái sau response |
| Ownership installer | Upgrade root mode với immutable marker đúng owner thành công; candidate service user gặp EPERM và tự rollback về root, giữ service hoạt động và đối chiếu hashes. Helper batching riêng đạt **5/5 tình huống Linux**: immutable/no-op/rollback, symlink/newline, mixed owner, group-only và owner đổi giữa snapshot/chown | Hai phép triển khai service dùng helper trước tối ưu batching; phép thử batching không chạy installer live hoặc restart service |
| Service/snapshot/reboot | Snapshot nhất quán, restart/reboot và đối chiếu trạng thái/identity đã thực hiện | Instance đang chạy trước shutdown sạch tiếp tục; clone autoStart bật; instance cố ý dừng vẫn dừng; cần đăng nhập lại |
| Thế giới và add-on | Function của behavior pack được BDS nạp/thực thi; gold block được backup, đổi thành air rồi restore lại gold với kiểm tra âm/dương native | Preload chunk cần warmup sau startup; không dùng marker chat khi không có người chơi để giả định console output |
| Bot và mạng | Hai bot RakNet offline phát sự kiện spawn của SDK/list/kick và count **2 → 1 → 0**; ping WAN UDP/RakNet và HTTP signaling NetherNet có bằng chứng reachability | Sự kiện SDK không chứng minh nhân vật hoàn tất tải world/gameplay; bot được thử độc lập với ping WAN và không thay cho Xbox authentication hoặc phiên WebRTC NetherNet có GameServerToken hợp lệ |

Core đã chạy ba build Linux thật: `1.26.51.1` download/import/start, `1.26.52.3` update/start và Preview `1.26.70.20` uncached install/start. Ngày QA, catalog có **396 identifier: 191 Stable, 205 Preview**, Mojang báo Stable `1.26.52.3` và Preview `1.26.70.20`. Chỉ mục/lazy metadata/HEAD là bằng chứng khác với việc chạy từng runtime; không khẳng định toàn bộ lịch sử đều tương thích Ubuntu hoặc client hiện tại.

Build Linux chính thức thứ tư **1.21.130.4** được tải/cài/chạy trên copy riêng; ZIP **75.241.415 byte**, SHA-256 **96f707749e0c98d7c861c5ef740f8deaa3de5db65e166db41ba221cf76b4fd01**, native pong protocol **898**. Giao diện sau đó import thành công HTTP201; toàn bộ **8.476 file** cache đã được so SHA-256/bytes từng entry với ZIP đã xác minh, không có file dư. Gói import không tự nhận checksum metadata của nhà phát hành: catalog giữ source `import`, checksum null đúng thiết kế.

## Các sửa lỗi từ bằng chứng thực tế

- Native player log có XUID rỗng ở bot offline: tracking đã dùng định danh có thể phân biệt người chơi, kiểm tra lại bằng hai bot và native `/list`.
- Severity của dòng native INFO chứa chữ `errorMessage=(null)` đã được sửa để không biến thành lỗi giả.
- Luồng đăng nhập đầu và nút modal Cancel/Keep Draft đã được sửa; những nút không lưu dùng `type=button`.
- NGINX cap tăng từ `1024m` lên `1025m` vì một file 1 GiB còn có multipart envelope. Probe HTTPS không gửi body ghi nhận HTTP413 trước sửa và 100-continue sau sửa; giới hạn backend không tăng theo proxy.
- Server/backup delete và retention cách ly bytes trước một lần commit metadata+audit; lỗi kernel giữ dữ liệu cũ. Tạo backup dùng audit `backup.create` và dọn riêng archive mới chưa commit khi lưu thất bại. Cleanup sau commit thất bại trả `warnings`/`cleanupPending`, giữ recovery path và hiện ở UI/job/log.
- Installer readiness ràng buộc processId/MainPID. File guard lập chỉ mục runtime và các ancestor; bảng file phân trang 100 hàng với selection tối đa 1.000 nguồn.
- Ownership bỏ qua entry đã đúng UID/GID, kể cả immutable. Helper batching lấy metadata/path NUL qua GNU `find -P`, gom theo owner đã quan sát, chạy `chown -h --from` theo batch và xác minh toàn cây cuối; không fork `stat` cho từng file hoặc tự gỡ immutable flag. Mismatch immutable vẫn thất bại rõ ràng để rollback.

Các retry của harness được giữ nguyên lịch sử và ghi lý do thay thế: dependency chưa có trả HTTP404 hợp lệ; function native trả số entry thành công thay cho no-player chat marker; activity chỉ trả 100 bản ghi mới nhất; fixture đã xóa không dùng lại làm nguồn ZIP; setblock cần đợi chunk được preload sau khởi động. Những lần đó không được đổi thành PASS khi chưa có phản hồi native/bytes tương ứng.

## Đo hiệu năng đúng phạm vi

Probe guard cục bộ trên Windows Node 24.8.0 dùng 50.000 record mô phỏng và 3.024 runtime path từ ZIP Mojang đã tải. Vòng kiểm tra capability giảm từ **152161 ms (khoảng 152,16 giây) xuống 688 ms** sau lập chỉ mục. Đây là thời gian của thuật toán cục bộ, không phải độ trễ Linux/WAN.

Trên VPS, một phản hồi HTTP JSON end-to-end cho 50.000 file thật được đo **6250 ms (6,25 giây)**, khoảng **15,95 MB**. API vẫn trả toàn bộ metadata thư mục; frontend hiển thị 100 hàng/trang và tìm/sắp xếp toàn collection. Độ trễ còn phụ thuộc filesystem, serialization và kết nối; không lấy hai số đo khác môi trường làm cùng một benchmark.

Ownership batching trên fixture Linux riêng gồm **10.000 file/10.001 entry**: đổi owner **757,838174 ms với 40 process `chown`**, khôi phục **742,224211 ms với 40**, no-op **67,094405 ms với 0**. Batch giới hạn 256 đường dẫn hoặc 32 KiB tên đường dẫn, giữ đúng tên có newline và chỉ đổi inode symlink. Đây là thời gian helper, không gồm install dependency, stop/start service hoặc readiness. Lượt candidate lỗi rồi rollback với helper cũ từng đo **169,6449 giây** trên khoảng 21.000 file; khác dữ liệu và phạm vi đo nên không dùng hai số làm cùng một tỷ lệ tăng tốc hoặc cam kết downtime.

## Điều kiện còn thiếu và việc chốt cuối

Không có tài khoản Xbox/Minecraft cùng client hợp lệ trong phiên QA. Join NetherNet có xác thực yêu cầu GameServerToken; thử SDP unsigned trả mã 37 IdentityNotAllowed. Vì vậy **authenticated NetherNet join, xác thực theo XUID thực và hiển thị/gameplay phía client chính thức/resource pack chưa được xác nhận**. Offline RakNet và console/LevelDB vẫn là các bằng chứng server thật độc lập. Các mục thiếu điều kiện được ghi rõ, không gắn nhãn đã đạt hoặc bỏ qua rồi tính vào tổng PASS.

Probe bot trên build 1.21.130.4 đã nhận handshake resource-pack stack, respawn ACK và Creative/Member ability từ server; positive control phá stone thành air vẫn thất bại. Vì vậy quyền Visitor bị chặn kiểm chứng cho đến khi Member positive control đạt. Đây là giới hạn client thử nghiệm chưa xác định nguyên nhân, không phải bằng chứng lỗi hoặc đạt gameplay của panel.

| Mục chốt release | Trạng thái tài liệu hiện tại |
| --- | --- |
| Unit suite cuối và cú pháp toàn dự án | Windows **117/117**, **24153,0948 ms**; Ubuntu Node 22.23.3 **117/117**, **11269,647034 ms**; fail/skip/cancelled đều 0. JavaScript check và Bash syntax đạt. Lần Linux 113 trước đó thiếu duy nhất `file-guard-index.test.js`; đã đối chiếu SHA và bổ sung đúng test, không đổi test để tăng số. Suite hiện có thêm ba regression ownership. Chi tiết chốt release ở [VERIFICATION](VERIFICATION.md) |
| Browser QA cuối, mobile/dialog/paging và regression sau deploy | **88 đạt / 89 tiêu chí**, 0 fail/pending, 1 blocked: không tìm thấy record CDN lịch sử unavailable tự nhiên (9 UI HEAD và 48 build lấy mẫu đều200); negative gate điều khiển ghi riêng. 26 layout mobile/a11y, 0 pageerror/native dialog. Cảnh báo cleanup normal/response muộn giữ draft; external crash tự restart và force-stop có chủ ý đã thử thật. Owner read-only smoke có 7 ảnh cuối |
| Dọn đúng đối tượng QA, giữ instance cuối cho người dùng | Ledger cleanup đạt: còn 1 Vortex Survival đang chạy, 1 owner, 1 lịch backup1440 phút; identity/cấu hình an toàn giữ nguyên. Cổng QA đóng; quarantine phục hồi đúng inode/bytes. Dọn 40 completed QA jobs khi service dừng, audit và các trường khác giữ nguyên. Full snapshot sạch450.698.389 byte, root/0600, đã tạo và service/world tiếp tục |
| ZIP release 0.4.1, file inventory và SHA-256 | Whitelist70 file nguồn ở root/server/public/deploy/scripts/docs/test; credentials/data/output QA/node_modules loại khỏi bundle. Inventory từng file và SHA-256 archive được tạo sau source freeze trong `vortex-mc-0.4.1.verify.json` và `.zip.sha256` đi kèm ZIP |

Vortex MC hiện quản lý một host; chưa có multi-node, billing, container/cgroup hard limits hoặc S3 backup. CPU/RAM là quan sát. Rename/commit rollback bảo vệ lỗi quan sát được trong process; mất điện giữa hai bước vẫn cần phục hồi quarantine thủ công theo [OPERATIONS](OPERATIONS.md#xóa-server-backup-và-quarantine). Không suy diễn kết quả một VPS thành bảo đảm mọi hệ điều hành, runtime lịch sử hoặc mức tải hosting thương mại.
