# Kiểm chứng Vortex Panel 0.13.0

Đợt này kiểm tra console theo từng lần chạy và phản hồi HTTP/WebSocket cũ, stop/restart/crash/reconnect, lịch sử 100 hoạt động/50 tác vụ hoàn tất, badge VPS chính và các tương tác giao diện. Danh mục và nguồn tham khảo: [audit 0.13.0](AUDIT-0130.md). Bộ kiểm thử đầy đủ, ma trận Chromium/WebKit và native QA riêng phải có bằng chứng của đúng gói cuối tại output/audit0130-* và output/playwright/audit0130. Số liệu nghiệm thu cuối được ghi trong báo cáo release; phần dưới là lịch sử các phiên bản cũ.

# Kiểm chứng Vortex Panel 0.10.1

Đối chiếu ngân sách 90% tổng hiệu dụng với MemAvailable tức thời, các phân bổ đã cam kết và áp lực thiếu RAM nghiêm trọng. Kiểm tra create/config/start, cgroup cha/con, credit một lần và dữ liệu thiếu/cũ. Đổi tên local/remote phải giữ Node ID, hostname, IP, identity, TLS và các server. Hostname ASCII có chữ hoa được đưa về chữ thường và xác nhận tên thực thi trước PATCH.

Trình duyệt cần kiểm tra chữ More thật sự được vẽ trên 320/390 px (không chỉ aria-label), vòng xoay có thay đổi góc theo thời gian, reduced motion, màu kênh, form bốn mục gộp lưu trữ, EULA và footer liền mạch trên desktop/mobile. Đợt production dùng đúng gói nguồn cuối, giữ bản sao lưu, kiểm tra phiên bản Main/Agent, tạo server QA riêng rồi dọn đúng tài nguyên. Artifact riêng ở output/ui0101 và output/playwright/ui0101; không tính bằng chứng của mô-đun đã thay đổi thành lượt kiểm thử native mới.

# Kiểm chứng Vortex Panel 0.10.0

Lượt này kiểm tra các điểm UI do người dùng chỉ ra, tách riêng trình duyệt fixture và hệ thống VPS thật. Kiểm tra theme trước khi module chính tải xong, listbox VPS bằng bàn phím, catalog inline luôn mở, All theo ngân sách mới nhất và credit server sửa, radio/checkbox, icon chờ, biểu đồ chỉ từ mẫu thật và giới hạn bộ nhớ. Hostname cần unit/HTTP/RBAC/CSRF/unknown-outcome, rồi thay tên tạm và phục hồi hostname thật trên cả hai VPS bằng API panel; xác minh kernel/static/transient và giữ server native, IP, display name, TLS, identity.

Bản Main và Agent đều cần 0.10.0 để đổi hostname từ xa. Nguồn, test, snapshot, UI và bằng chứng hostname thực tế lưu riêng ngoài source tại output/ui0100 và output/playwright/ui0100; chỉ báo hoàn tất sau kiểm tra source triển khai và dọn tệp đăng nhập tạm. Các bằng chứng grow/file/backup cũ ghi đúng phiên bản và module thực hiện, không được tính thành lượt gameplay mới.

# Kiểm chứng Vortex Panel 0.9.2

Bản vá Main 0.9.2 sửa mất focus do danh sách phiên bản render lại khi dashboard polling truyền trạng thái disabled không đổi. Kiểm tra DOM thật giữ nguyên hàng đang focus sau hơn một chu kỳ polling, hỗ trợ Arrow/Enter và vẫn đóng/vô hiệu hóa khi node thực sự offline hoặc bảo trì. Nghiệm thu production phải chạy lại đúng tình huống polling trên source triển khai.

Agent vẫn là 0.9.1. Bằng chứng grow 2 → 3 GiB với world SHA trước/sau thuộc runtime 0.9.1; chỉ được dùng cùng bản vá 0.9.2 khi manifest ZIP xác minh toàn bộ server/* giống byte. Không tính đây là grow mới chạy trên 0.9.2. Source/test/deployment/browser proof và so sánh backend lưu riêng trong output/operations092; báo cáo tổng hợp chỉ hoàn thành sau các kiểm tra thật và dọn artifact QA.

# Kiểm chứng Vortex Panel 0.9.1

Đợt 0.9 bổ sung telemetry, admission giữ 10% host, volume ext4 giới hạn và danh mục phiên bản đầy đủ. Nghiệm thu tách biệt test fixture với Linux/kernel/Bedrock thật, giữ SHA nguồn và archive, kiểm tra lại cả controller lẫn agent sau triển khai. Bằng chứng ngoài source ở `output/operations090`, `output/operations091`, `output/operations091-ui-proof.json` và các ảnh trong `output/playwright`.

Kiểm thử world thật phát hiện hai vấn đề được xử lý trong 0.9.1: khoảng trống của form tạo server và khởi tạo inode nền sau tăng image từ 2 lên 3 GiB. Kết quả lỗi ban đầu và lần sửa image QA được giữ riêng; sửa image bằng tay không được tính thành bằng chứng grow của source mới. Nghiệm thu cuối cần source mới qua full suite trên Windows/Ubuntu, kiểm tra allocation sau hơn 10 giây, grow qua API thật với world SHA trước/sau và identity, cùng backup toàn DATA có unmount/remount receipt. Không dùng native signaling TCP hoặc fixture để khẳng định có người chơi Xbox mới kết nối.

Lịch sử kiểm chứng trước 0.9:

# Kiểm chứng Vortex MC 0.8.3

Bản chỉnh giao diện mobile giữ trọn số cổng/dải UDP trong preview firewall trên EN/VI, không thay logic quản trị backend. Nghiệm thu phân biệt controller 0.8.3 với agent 0.8.2 và giữ bằng chứng kiểm thử native trước đó; kiểm tra lại UI responsive, SHA source, tài khoản và trạng thái server sau cập nhật.

# Kiểm chứng Vortex MC 0.8.2

Kiểm thử trên VPS thứ hai phát hiện UFW từ chối `insert 1` cho rule IPv6 khi đã có rule IPv4. Kết quả một phần được giữ lại trung thực; bản sửa dùng `prepend` theo từng họ địa chỉ. Nghiệm thu cần chạy lại trên UFW thật sau cập nhật cả controller và agent, giữ cùng UUID/TLS/data và đối chiếu rule SSH/web trước/sau.

# Kiểm chứng Vortex MC 0.8.1

Lượt cài thật trên VPS thứ hai phát hiện lỗi SFTP ReadStream phát error muộn sau khi đóng session, làm controller khởi động lại ở bước liên kết; agent đã cài vẫn hoạt động. Bản vá quản lý vòng đời đọc/đóng SFTP và giữ lỗi trong tác vụ. Notifications cũng được sắp theo thời gian giữa local/remote/setup để tác vụ mới không bị lịch sử local che khuất. Agent protocol 1 bản 0.8.0 tiếp tục tương thích và không cần cài lại chỉ vì controller nâng patch. Báo cáo cuối ghi riêng lỗi thật ban đầu, regression, recovery và nghiệm thu sau vá; không tính cài agent thành công thành liên kết thành công trước khi xác minh HTTPS.

# Kiểm chứng Vortex MC 0.8.0

Nodes thêm agent HTTPS riêng, ID theo node, quyền xuyên suốt, inventory offline, giới hạn tài nguyên theo VPS, thư viện phiên bản theo node và cài/liên kết VPS qua SSH ngay từ panel. Quy trình, giới hạn và phục hồi ở [NODES](NODES.md), [NODE-AGENT](NODE-AGENT.md) và [NODE-PROVISIONING](NODE-PROVISIONING.md).

Kiểm thử nguồn sử dụng HTTP/HTTPS/SSH/SFTP thật trên loopback để kiểm TLS/SSH pin trước authentication, RBAC/CSRF, truyền bytes, các UUID trùng nhau, cache offline, lịch độc lập, secrets và lỗi ghi/gián đoạn. Các trường hợp installer/systemd/Bedrock dùng fixture trơ hoặc demo phải được ghi rõ; chúng không chứng minh cài agent hay chạy Bedrock trên VPS thật. Browser fixtures cũng không thay bằng chứng native hoặc game client.

Nghiệm thu phát hành phải xác minh Windows full suite, đúng archive/inventory trên Ubuntu, snapshot dữ liệu dừng, TLS health khớp MainPID và source bất biến. Kiểm thử xuyên hai VPS phải đối chiếu riêng agent unit/PID/source, server/files/cgroup trên máy đích, tác vụ được gửi qua panel gốc và trạng thái Survival hiện hữu. Báo cáo thực thi cùng phạm vi/giới hạn được lưu ngoài source tại `output/VORTEX-080-ACCEPTANCE.md` và `output/vps/nodes080-*`; không cộng các lượt targeted/retest vào số test duy nhất của full suite.

Lịch sử kiểm chứng trước 0.8.0:

## Kiểm chứng Vortex MC 0.7.0

Release 0.7.0 bổ sung giới hạn CPU/RAM thật, runtime gamerules, hành động theo phiên người chơi, log retention và tiến trình/chuyển động mới. Windows full suite **276/276**, không fail/skip/cancelled; syntax đạt. Linux chạy lại đúng source archive được xác minh bằng inventory SHA trước khi triển khai. Không cộng số lượt chạy lặp vào tổng. Log I/O refinement có 5 test file thật mới: 401 lần append tuần tự tạo 2 compactions với file2MiB hoặc4 với1MiB; 20 lần maintenance yên lặng không ghi lại; trường hợp expired nằm trước2000 dòng mới vẫn được dọn. Ring/tail có giới hạn1500 dòng; file vật lý được giới hạn tuổi/dung lượng. Bằng chứng: `output/operations070-log-hysteresis-report.json`.

Kiểm thử độc lập trên Ubuntu dùng unit/data/world/ports riêng, không sửa Survival của người dùng. **14/14 nhóm Bedrock thật 1.26.52.3** kiểm tra đọc 15 luật, đổi Keep inventory/PvP/random tick, restart lưu luật, stale world/value/player guards, role/CSRF, native fixed limits và OOM được ghi lại. **5/5 nhóm kernel thật** xác nhận CPU0.2core đo0.2012core, RAM256MiB gây SIGKILL/OOM nhưng supervisor còn sống, chặn exec khi attach thất bại, giữ PID/stdin/stdout và dọn cgroup. Các bằng chứng đầy đủ ngoài source: `output/operations070-native-run-*.json`, `output/operations070-resource-linux-proof.json`.

Browser QA dùng auth/API/file thật và byte-stream ZIP inert; gameplay/cgroup trong fixture được mô phỏng rõ ràng. Các kiểm tra này xác minh UI/request/draft/progress/accessibility, không thay bằng chứng kernel/native. Báo cáo browser và ảnh ở `output/playwright/operations070-qa`. Kiểm tra EN/VI, desktop/mobile, dark/Reduce motion, draft/save races, stale navigation/player, permission, log clear/export và phần trăm thực. Một lỗi popup player mở sau khi chuyển trang đã được sửa bằng kiểm tra cả route và DOM origin, có failure/retest evidence riêng.

Không có client Xbox thật kết nối trong đợt0.7.0; hiệu ứng Give/Kill/Kick trên một người chơi đăng nhập chưa được xác nhận trong game. Các quan sát client của bản0.6.0 bên dưới là lịch sử riêng, không được tính thành xác nhận client mới.

Production hiện chỉ còn server **Survival** do người dùng đã xóa các server trước. Không khôi phục chúng. Trước nâng cấp: dừng an toàn, giữ khóa DATA_DIR độc quyền, snapshot đầy đủ và đối chiếu mọi member/hash, private0600 ngay lúc tạo. Sau nâng cấp: TLS health phải khớp MainPID/version/source SHA, chạy lại đúng tập server trước đó, giữ users/vault/env/properties/permissions/identity/backups/lịch và các setting người dùng. Cache phiên bản tự phát hiện và chính sách log mặc định là các trường dẫn xuất/thay đổi dự kiến. Driver có rollback/resume nếu snapshot/install/acceptance thất bại. Final snapshot/release proof ở `output/vps/operations070-*`.

Lịch sử kiểm chứng trước0.7.0:

## Kiểm chứng Vortex MC 0.6.1

Ngày 14/10/2026, 0.6.1 thêm World voice theo ngôn ngữ riêng từng server, EN mặc định, preview màu và announcement có phân quyền/conflict guard. Automatic welcome dựa trên native Player Spawned; graceful stop/restart/backup báo trước ba giây khi có người chơi. Chỉnh sửa quyền/allowlist giữ XUID và draft khi mục tiêu thay đổi. Quy trình và giới hạn tại [SERVER-MESSAGES](SERVER-MESSAGES.md) và [API](API.md).

Windows Node 24.8.0: **203/203**, fail/skip/cancelled=0, **34311.7927 ms**. JavaScript syntax đạt. Có 13 test backend mới và 11 test composer; không cộng targeted hoặc lượt cũ vào tổng. UI catalog **1045** khóa không thiếu; backend **583** template. Nhãn World voice dùng metadata EN/VI tại nguồn, tách khỏi nội dung Minecraft và giữ draft khi đổi UI locale.

Kiểm thử với người chơi thật trên Bedrock Windows 1.26.52 xác nhận **8 nhóm**: vào world/đặt-phá/console; Operator Creative và bay; Member bị từ chối creative; Visitor không đặt-phá; Member được phục hồi, block cũ tồn tại; thông báo EN màu và lý do Kick được nhận. Các lượt này thuộc source **0.6.0**, không được tính như nhận welcome tự động của source mới. Ghi nhận conversation cuối supersede trạng thái pending cũ, giữ các report gốc.

Sau khi người dùng rời game, VPS chính thức BDS 1.26.52.3 đạt **16 workflow API/native** với provenance nguồn 0.6.0: roundtrip world, gold→air→restore→gold, SHA/CRC/protection/retention, clone, pack function native, allowlist, network conflict/mapping, backup timer một phút, command/restart schedule, force-kill/start và SIGKILL→autoRestart. Giữ world/quyền/cấu hình/identity gốc, xóa đúng artifact thử; giữ backup được bảo vệ. Production PID/properties/identity không đổi trong ma trận này. Ngoài ra phase1/files/RBAC/MFA có **29 nhóm recorded** (12/7/4/6); các nhóm có phạm vi giao nhau, không cộng thành số tính năng độc lập.

NetherNet UDP peer được cấp khi signaling/client kết nối; đổi cổng tự động chỉ chứng minh mapping lưu và TCP listener thuộc đúng PID. Function behavior pack thực thi native đã xác nhận; resource pack trên client chưa quan sát. Những lần harness sai Unicode stdout/regex feedback hoặc giả định UDP bind sớm được giữ nguyên và sửa harness, không đổi thành test product pass.

Lỗi Join đầu **Door / InitialConnection-83** còn xảy ra rồi rejoin thành công; chưa xác định nguyên nhân. Sau Kick cuối người dùng bận, chưa có rejoin chính thức, inventory sau restore, client trên cổng mới, resource-pack rendering hoặc nhiều client đồng thời. Capture thành công/TLS fallback và parser fixture không chứng minh đã sửa Door hoặc có Xbox-authenticated client mới. Giới hạn power-loss journal/LevelDB health/multi-node/container quota/S3 ở lịch sử vẫn áp dụng.

Browser composer/config mới đạt **42 tiêu chí**, **96 layout checks** (84 ma trận sáu mẫu/cấu hình và 12 vùng chạm xác nhận completion), EN/VI light/dark tại 320/390/1440 px; 0 pageerror/native alert. Kiểm tra cả race GET/POST/refreshLogs, immutable POST snapshot, giữ draft mới, expectedLanguage409 không blind retry, Viewer403/stopped409 và metadata-only save. Auth/API/files thật, runtime inert không chạy native; positive composer acknowledgement được mô phỏng rõ `acceptedToConsole:false,simulated:true`. Bản này không tính như client receipt. Controls composer/config đạt tối thiểu44px và không overflow. Báo cáo gốc những lần sai harness selector vẫn được giữ.

Snapshot trước upgrade đối chiếu **24.008 file, 4.248 thư mục**, toàn bộ bytes/mode của data dừng với archive tar. Resume tự cập nhật đúng bốn timestamp kiểm tra danh mục phiên bản; chỉ những đường dẫn này được bỏ qua trong normalized global settings hash. Accounts/vault/env/schedules, cả hai world được chọn, server settings, props/keys/player lists/protected backup metadata giữ nguyên. Broad-comparison failure đầu được giữ, proof qualified ghi rõ exception thay vì khẳng định mọi byte settings không đổi.

Proof của lần này lưu riêng dưới `output/vps/client2652-*`, `client061-*` và `output/playwright/client2652-*`, không đóng gói cùng source. Linux full-source suite, browser matrix, snapshot nhất quán và release inventory/readiness được ghi tại acceptance artifact riêng khi hoàn tất; source ZIP không tự chứa SHA của chính nó.

---
# Lịch sử kiểm chứng Vortex MC 0.6.0

Ngày 14/10/2026, bản 0.6.0 bổ sung workspace **Worlds**, checksum/kiểm tra/bảo vệ backup, activity theo server ID và các guard quyền/khôi phục. Các workflow đã giao được mô tả tại [WORLDS](WORLDS.md); nguồn tham khảo và đề xuất chưa triển khai nằm riêng tại [RESEARCH-2026-10-14](RESEARCH-2026-10-14.md).

| Môi trường/phạm vi | Kết quả cuối |
| --- | --- |
| Windows, Node 24.8.0 | `npm test` **179/179**, fail/skip/cancelled=0, **45038.2939 ms**; JavaScript syntax đạt |
| Ubuntu, Node 22.23.3 | Full source staging: `npm test` **179/179**, fail/skip/cancelled=0, **21908.170435 ms**; JavaScript và Bash syntax đạt |
| Bản địa hóa | Runtime probe **9/9**; **1031** khóa UI không thiếu; backend **543** thông điệp. EN mặc định, metadata/tên/seed/checksum không dịch |
| Trình duyệt fixture | **20/20 nhóm**, 29 tiêu chí UI, 22 kiểm tra quyền HTTP và 1 quyền UI; **24 workspace + 32 dialog layouts**, EN/VI light/dark; 0 pageerror và 0 native alert/confirm/prompt |
| Regression banner riêng | Backup tampered → Verify failed → khôi phục bytes → Verify completed không reload; banner SHA cũ biến mất, `server.error=null`, Download tạo ZIP thật đúng SHA; cấu hình và identity giữ nguyên |
| BDS chính thức trên Ubuntu | **11 nhóm** API/native đạt, dữ liệu/process QA tách production; tạo, load, export/import, chọn world, backup/verify/protect/restore, quyền và activity ID |

Full platform suite cuối bao gồm transaction/rollback, lỗi ghi completion sau thao tác đã commit, retention một phần, restore và rollback cùng thất bại, recovery marker chặn start, quyền GET/HEAD tải dữ liệu và identity, world packs/ZIP/metadata bounds. Cảnh báo verify chỉ được xóa khi đúng backup sở hữu lỗi đã kiểm tra thành công và server đang dừng; các lỗi runtime/restore/backup khác được giữ. Không cộng lượt test cũ hoặc targeted vào 179.

Browser chính dùng `demo=false`, auth/filesystem/ZIP thật và runtime inert không thực thi. Snapshot backend của lượt 20 nhóm là `8bc850…`, trước hai sửa completion/verify; frontend cuối là app `b0a78f…`, style `95daab…`, catalog `6be987…`. Lượt regression banner dùng backend cuối **`c7f02dbfbc3190828808be002a3cc7067cc684a2ea93abec130c4d6c4ece85ec`** cùng frontend cuối, ghi riêng tại `output/playwright/operations060-banner`; finding cũ được đánh dấu resolved và provenance trước đó được giữ. Fixtures/browser đã đóng, logout đã được xác nhận. Những kiểm tra này không phải một lượt gameplay.

Native run cuối **`ops060-20261014T083340Z-82016a`** dùng gói Linux chính thức **1.26.52.3**, seed chuỗi `9223372036854775807`; BDS sinh metadata và LevelDB thật. Phản hồi native mới xác nhận gold block; export/import/reimport khi stopped đối chiếu SHA từng file và empty directory, không tự chọn world mới. Backup bị đổi một byte bị từ chối trước thay live data; explicit Verify lỗi rồi sửa bytes/Verify thành công xóa đúng lỗi cũ. Sau đó native xác nhận **gold → air → restore → gold**, có negative/positive control và không dùng input echo. Identity/network giữ nguyên, Viewer GET/HEAD export/backup/identity bị 403 và Operator bị giới hạn server. Trong lượt này production được đọc đối chiếu, PID/properties/identity không đổi. Hai server và hai user QA được xóa, process và data fixture được dọn.

Gói native staging có **26 file backend/dependency manifest**, được đối chiếu với source cuối; full Linux staging có **93 file source**, kiểm theo manifest/hash từng tệp. Chốt ZIP kiểm whitelist, bytes/SHA, source không thay trong lúc đóng gói và loại trừ dữ liệu/mật khẩu/private key. Các proof dưới `output/vps/operations060-*` và `output/playwright/operations060-*` không được đóng gói cùng source. Source SHA cuối, release đang chạy, TLS và kiểm UI live được ghi trong acceptance artifact riêng sau activation để tránh SHA tự tham chiếu trong ZIP.

Validator world chỉ xác nhận cấu trúc LE-NBT/LevelDB và pack trong phạm vi hỗ trợ, không chứng nhận toàn bộ database hoặc downgrade. Bản backup cũ được Verify thiết lập checksum hiện tại, không có bằng chứng checksum lúc tạo. Metadata dùng atomic rename, chưa có journal/fsync bảo đảm mất điện. **Chưa kiểm chứng client Minecraft/Xbox chính thức, authenticated NetherNet join hoặc gameplay/resource-pack phía client.** Phạm vi hệ thống một Ubuntu host, root mode tùy chọn và các giới hạn kiến trúc ở tài liệu vận hành vẫn áp dụng.

---
# Lịch sử kiểm chứng Vortex MC 0.5.1

Delta UI: popover EN/VI riêng, decode ảnh trước khi hiện login scene, fallback khi ảnh lỗi/chậm, WebP nhẹ hơn 88,1%, vùng chạm tablet và header editor mobile, độ tương phản chữ phụ light. Cơ chế và nguồn tham khảo ở [UI-POLISH](UI-POLISH.md).

Bản source 0.5.1 đạt `npm test` **122/122 trên Windows Node 24.8.0**, fail/skip/cancelled=0, **19835.233 ms**; JavaScript syntax đạt. Ubuntu Node 22.23.3 staging đạt `npm test` **122/122**, fail/skip/cancelled=0, **11877.128087 ms**, JavaScript/Bash syntax đạt. Localization runtime probe **9/9**, catalog **909** chuỗi không thiếu khóa. Kiểm thử browser hiện tại nằm ở `output/playwright/ui-polish-review`, platform Linux và nghiệm thu live ở `output/vps/ui-polish-*`; các artifact này không đóng gói cùng source và ghi riêng fixture UI với production BDS.

Phạm vi browser gồm EN/VI light/dark, 320/390/768/1440 px, menu bằng bàn phím, viewport/top layer/dialog, form/editor draft và các tình huống ảnh/API chậm/lỗi. Các lượt đầy đủ và kết quả hiện tại được ghi trong báo cáo của bản 0.5.1; số kiểm thử ngôn ngữ/BDS bên dưới là lịch sử.

---
# Lịch sử kiểm chứng Vortex MC 0.5.0

Delta **VI/EN**, ngày **14/10/2026 tại Bangkok**: mặc định English độc lập navigator, preference riêng trên browser, đổi nhãn/attribute tại chỗ để giữ draft và dữ liệu. Catalog có **909 chuỗi UI**, **23 nhóm số ít/số nhiều**, **443 thông điệp backend**. Canonical dữ liệu/log không bị đổi ngôn ngữ.

## Nghiệm thu VI/EN 0.5.0

| Môi trường | Kết quả | Thời gian/phạm vi |
| --- | --- | --- |
| Windows, Node 24.8.0 | `npm test` **122/122**, fail/skip/cancelled=0; JavaScript syntax đạt | **19042.822 ms** |
| Ubuntu, Node 22.23.3 | `npm test` **122/122**, fail/skip/cancelled=0; JavaScript/Bash syntax đạt | **12147.900769 ms**, bản source staging riêng, không thay dịch vụ production trong lượt suite |
| Runtime localization probe | **9/9** đạt | EN default, cached labels, opaque substitutions, HTML boundaries, late metadata, Intl, plural rules và 10.000 dynamic descriptors không tăng registry vô hạn |
| Trình duyệt thật | **34 ca đạt**, 0 fail/skip/pageerror/native alert-confirm-prompt | Sáu main views, bảy server tabs cả EN/VI; 20 tổ hợp mobile 320/390 px được nhóm riêng trong một criterion |

Browser dùng fixture metadata/runtime inert, `demo=false`, auth và filesystem thật; **không thực thi BDS hoặc chứng nhận gameplay**. Fresh navigator `vi-VN` vẫn mở English; saved VI/reload/logout, invalid preference và storage bị chặn đã kiểm. Đổi VI/EN giữ identity của form, password/MFA, editor/revision/cursor, dirty configuration, search/page, selection/clipboard và callback. GET/PUT/409 thật được giữ response có chủ ý để đổi ngôn ngữ giữa chừng, sau đó kiểm bytes và draft.

Tệp UTF-8 lưu thật **156 byte**, SHA-256 `7917df0b62bab096d069884b315245c0c39d59a683809217113556542866f003`; bản copy **84 byte**, SHA-256 `555d2f629c621f054c61983ecedc3cc8ca38edd71f0cd33cef1bf0b10be25c53`, khớp bản gốc fixture. Tên server/filename trùng chữ catalog và payload HTML/emoji vẫn nguyên; native-log literal của fixture không dịch. Mã MFA recovery được xác minh một lần trên tài khoản fixture riêng. Source-only marker/slot strategy không tìm-thay userdata toàn DOM; per-request/per-WebSocket locale giữ hai client độc lập.

Đã sửa overflow auth 320 px và control 42 → **44 px**, bổ sung hidden-label CSS, compact toolbar/dialog, số ít/số nhiều và bộ lọc panel log theo ngôn ngữ đang hiển thị. Slot dùng weak references/dedupe, dynamic descriptors tự chứa dữ liệu, không giữ registry tăng theo poll.

Chi tiết: `output/playwright/i18n-review/browser-report.json`, `output/i18n-core-probe.json`, `output/vps/i18n-windows-tests.txt`, `output/vps/i18n-linux-tests.txt`; quy tắc bảo toàn dữ liệu ở [I18N](I18N.md). Kết quả vận hành 0.4.1 phía dưới là lịch sử nền; số cũ không thay cho nghiệm thu ngôn ngữ 0.5.0.

## Lịch sử kiểm chứng Vortex MC 0.4.1

Nghiệm thu ngày **14/10/2026** trên máy phát triển Windows và VPS **Ubuntu 24.04.5 x86_64**, kernel **6.8.0-147**, Node **22.23.3**. Các kiểm tra VPS dùng BDS chính thức, process/PID, stdout native, filesystem và ZIP thật; `DEMO_MODE=false`. Xem [báo cáo nghiệm thu VPS](VPS-ACCEPTANCE.md) để phân biệt bằng chứng server, mạng và client.

## Kiểm tra tự động cuối 0.4.1

| Môi trường | Kết quả cuối | Thời gian |
| --- | --- | --- |
| Windows, Node 24.8.0 | `npm run check` đạt; `npm test` **117/117**, fail/skip/cancelled=0 | **24153.0948 ms** |
| Ubuntu, Node 22.23.3 | `npm run check` và Bash syntax đạt; `npm test` **117/117**, fail/skip/cancelled=0 | **11269.647034 ms** |

Linux ban đầu có 113 bài vì thiếu file `file-guard-index.test.js` trong bản copy QA. Sau khi upload đúng file còn thiếu và kiểm tra SHA-256 của toàn bộ 24 file test trùng local, full suite được chạy lại và đạt 114. Ba regression ownership installer được bổ sung sau lỗi immutable quan sát thật, đưa bộ cuối lên 117. Các lượt target hoặc bộ test của phiên bản cũ không được cộng vào số 117.

Delta 0.4.1 kiểm tra entrypoint symlink, readiness PID/systemd, ownership conditional batching, parsing native severity và player XUID rỗng, delete/backup/retention transaction, cảnh báo cleanup sau commit và runtime-file guard index, cùng nền auth/RBAC/MFA/lifecycle/configuration/version/files/ZIP/packs/schedules đã có.

## Kiểm tra thực tế trên VPS 0.4.1

- **21 nhóm core HTTP/WebSocket đạt**, bao gồm cài/chạy ba build chính thức `1.26.51.1`, `1.26.52.3`, Preview `1.26.70.20`; file bytes/CRC/editor conflict; port/configuration; backup/update/clone; pack dependency và function native; schedule chạy theo timer thực; quyền truy cập, MFA và root terminal có quota/timeout/audit. Năm kỳ vọng sai của harness được giữ lịch sử dưới nhãn superseded; không tính thành PASS độc lập.
- **5 nhóm giới hạn dữ liệu**, **13 điểm lỗi ghi ENOSPC trước đó**, **5 điểm delete/backup/retention sau sửa**, **3 điểm full snapshot restore** và **3 tình huống readiness process/unit** đạt với bằng chứng Linux thật. Bản sao QA tách dữ liệu chính; ENOSPC dùng device `/dev/full` tại file metadata tạm và EPERM dùng immutable file, không cố làm đầy ổ đĩa production.
- Installer đã chạy bằng service user và root; candidate readiness lỗi đã rollback. Restart dịch vụ, snapshot nhất quán và reboot VPS đã được thực hiện, đối chiếu running/stopped intent, identity và cấu hình. Backup/world restore xác nhận gold → air → gold bằng phản hồi native mới, không dùng command echo.
- Lỗi installer thực tế khi chown tệp immutable đã được sửa: upgrade root cùng owner bỏ qua chown dư thừa; candidate service user khác owner thất bại đúng EPERM và tự rollback về root đang chạy, hashes dữ liệu/cấu hình/vault không đổi. Helper batching mới đạt **5/5** tình huống Linux; 10.000 tệp apply **757.838174 ms / 40 process**, restore **742.224211 ms / 40 process**, no-op **67.094405 ms / 0 process**. Hai phép triển khai immutable live dùng helper đúng logic trước tối ưu batching; không gộp benchmark thành kết quả triển khai live.
- Hai bot offline phát sự kiện spawn của SDK/list/kick và tracking panel **2 → 1 → 0** đạt; chưa chứng minh nhân vật hoàn tất tải world hoặc thao tác gameplay. Ping RakNet UDP từ Windows ngoài VPS và signaling NetherNet HTTP đều có bằng chứng riêng; chúng không chứng minh một phiên game NetherNet có xác thực.
- Build chính thức thứ tư **1.21.130.4** được tải/kiểm SHA-256, cài/chạy trên copy riêng; native pong báo protocol **898**, version **1.21.130**. Các probe phá block bằng client SDK chưa đạt positive control, được giữ nhãn failed; quyền Visitor không được đánh dấu đạt khi Member chưa phá được block.
- Thư mục **50.000 file thật** được thử qua HTTPS và trình duyệt: **100 hàng/trang**, tìm/sắp xếp toàn collection, selection nhiều trang tối đa 1.000, layout 320/390 px. Đo phản hồi toàn metadata **6250 ms / 15.950.120 byte**; API chưa phân trang trên server. Probe thuật toán guard cục bộ **152161 ms → 688 ms** là phép đo khác môi trường.

Không có client Minecraft/Xbox hợp lệ trong phiên QA. **Authenticated NetherNet join, quyền theo XUID thực và hiển thị resource pack/gameplay trên client chính thức chưa được xác nhận**. Unsigned signaling nhận mã IdentityNotAllowed; không dùng token giả hoặc biến điều kiện thiếu thành PASS. Kết quả bot offline và LevelDB/console được ghi theo đúng phạm vi riêng.

## Chốt browser và release 0.4.1

Browser checklist thật trên VPS gồm **89 tiêu chí: 88 đạt, 0 fail, 0 pending, 1 blocked**. Mục bị chặn là kiểm chứng một record lịch sử thực sự không còn tải được: 9 HEAD qua UI và 48 build lấy mẫu từ registry đều trả HTTP200. Negative gate được thử bằng response điều khiển riêng, không gán thành một CDN404 tự nhiên. Không thay criterion để tăng số PASS. Ledger và bằng chứng ở `output/vps/frontend-qa/coverage.json` cùng `frontend-handoff-summary.json`.

Luồng giao diện đã thao tác thật với power/version/configuration/ports, file manager/editor/ZIP, backup/update/clone, add-on, players JSON, schedules, RBAC/password/MFA, root diagnostics/terminal, activity và chế độ offline. **26 layout** mobile/a11y đã kiểm tra; observer cuối ghi **0 pageerror, 0 native alert/confirm/prompt**. Các HTTP lỗi do conflict/quyền/fault hoặc restart có chủ ý được phân loại theo kỳ vọng, không che thành kết nối thành công.

Hai regression cleanup-warning dùng immutable child thật: cảnh báo normal mở popup và copy recovery path; response muộn **7099 ms** vẫn giữ draft editor không liên quan, bytes đã lưu không đổi. Đã phục hồi đúng hai quarantine theo inode/device/bytes rồi dọn. Auto-restart dùng external SIGKILL qua pidfd với PID/cwd/executable đã kiểm tra: **181578 → 181962**; UI force-stop có chủ ý không khởi động lại sau **6500 ms**, policy QA được trả về false.

Dữ liệu bàn giao chỉ còn **một Vortex Survival đang chạy, một owner admin, một lịch backup 1440 phút**; identity không đổi, online-mode bật, cheats tắt. Đã xóa đúng server/tài khoản/lịch QA theo ledger, đóng firewall QA, giữ nhật ký kiểm toán; 40 tác vụ QA đã hoàn tất được dọn khi service dừng, các trường dữ liệu khác và hai tác vụ production không đổi. Full snapshot sạch **450.698.389 byte**, root/mode0600, đã tạo và service/world tiếp tục. Owner read-only smoke cuối có 7 ảnh `output/playwright/vps-20261014-live-final-*.png`, gồm overview mobile 320/390 px.

Gói source **0.4.1** dùng whitelist **70 regular file** ở root, `server/public/deploy/scripts/docs/test`; không chứa dữ liệu, output QA, node_modules, cookies, mật khẩu hoặc private key. Script kiểm gói tạo `vortex-mc-0.4.1.verify.json` với inventory SHA-256 từng file và `vortex-mc-0.4.1.zip.sha256` sau khi nguồn/tài liệu đóng băng; các artifact này được giao cùng ZIP. Các số/ảnh 0.4.0 trở xuống dưới đây là lịch sử, không thay cho browser 0.4.1.

Vortex MC hiện quản lý một host, có root mode được bật rõ ràng. Chưa có cgroup/container hard limits, multi-node, billing, SFTP hoặc S3/offsite backup. Rollback trong process không thay cho journal khi mất điện giữa rename và commit; quy trình phục hồi quarantine được ghi trong [OPERATIONS](OPERATIONS.md#xóa-server-backup-và-quarantine).

## Lịch sử kiểm chứng Vortex MC 0.4.0

Đợt file manager **0.4.0**, ngày **14/10/2026 tại Bangkok** (**13/10 UTC**), được kiểm tra trên máy phát triển Windows/Node.js với filesystem và ZIP thật. Fixture chỉ phục vụ API/dữ liệu; không tải hoặc thực thi Bedrock.

## Kiểm chứng độc lập đã hoàn tất 0.4.0

- Archive target suite: **6/6 pass**, kiểm tra CRC32 native/fallback, writer đóng trước khi trả lỗi, file-directory conflicts, Windows aliases, symlink, empty directories/source quota và thư mục cha ngầm định.
- File operations + real HTTP target suites: **10/10 pass**, gồm batch copy/move/ZIP, no-overwrite, scoped Admin/Operator/Viewer, revision 428/409, deleted-target 404, strict UTF-8, protected descendants, stopped/exclusive locks, CRUD/audit rollback và normalized managed editor. Các lượt target được ghi riêng, không cộng thành một lượt full-suite.
- Probe corrupt-CRC qua manager trả 400, không có live destination, staging sạch và audit không tăng. Probe editor đã xác nhận lỗi tái tạo file đã xóa trong bản đầu; regression hiện từ chối cả live/demo. Managed editor trả content thực cùng revision, giữ omitted advanced properties và canonical player JSON.
- Probe quota ban đầu có hai entry ZIP tạo sáu mục filesystem dù maxEntries=3; regression đã sửa bộ đếm tính cả thư mục cha ngầm định, không đếm lặp directory được khai báo rõ.
- Probe HTTP cuối tái hiện valid 2 MiB ASCII hoặc 1 MiB newline bị parser trả 413. Sau sửa scoped 13 MiB envelope, HTTP suite độc lập rerun **1/1 pass**: exact 2 MiB ASCII, newline PUT và worst-case 12 MiB escaped JSON được nhận; decoded text vượt 2 MiB bị từ chối không mutation, route command khác vẫn giữ 413 cho body vượt 2 MiB.

## Nghiệm thu tích hợp 0.4.0

`npm run check` đạt kiểm tra cú pháp JavaScript. Lượt `npm test` cuối sau sửa JSON envelope và CSS đạt **89/89 pass**, fail/skip=0, thời gian **13141.8339 ms** (khoảng 13,14 giây). Bao gồm nền auth/RBAC/MFA/lifecycle/version/config/player/schedule/provisioning và delta file operations/editor/archive/HTTP. Lượt target tích hợp archive/packs/backend/files/HTTP sau sửa implicit-parent quota đạt **33/33 pass**; các lượt target không được cộng thành một lượt full-suite khác. Số **73/73** và ảnh **0.3.1** phía dưới thuộc lịch sử.

Đợt 0.4.0 không thay dependency hay script triển khai. Kết quả audit dependency/Bash của các đợt trước vẫn được giữ đúng nhãn lịch sử, không được trình bày là đã chạy lại trong lượt này.

Browser QA 0.4.0 dùng filesystem thật của instance fixture đã dừng, không chạy executable:

| Luồng 0.4.0 | Bằng chứng đã quan sát |
| --- | --- |
| Thao tác vùng chọn | Multi-copy, rename và explicit move thực hiện qua UI; kiểm tra dữ liệu ở nguồn/đích. |
| ZIP thật | Compress tạo ZIP 1.019 bytes; native download trả bytes ZIP và đọc lại xác nhận dữ liệu/empty directory. Extract đưa dữ liệu vào một thư mục mới. |
| Stale editor | Ctrl+S với revision cũ trả 409, giữ draft; tải bản server qua popup panel rồi Ctrl+S trả 200. |
| Managed editor | Sau khi bỏ port 32000 khỏi input server.properties, canonical response/UI vẫn hiển thị khóa được merge và nội dung thực đã lưu. |
| Clipboard scope | Chuyển sang Second · Isolation làm Dán disabled và hiển thị server nguồn. |
| Upload nhiều tệp | Hai tệp qua UI trả 200+200. Probe phần thành công: tệp đầu 200, tệp thứ hai collision 409; giao diện báo Đã tải 1/2 và giữ tệp đầu. |
| Upload bytes | GET ba tệp đã upload thành công trả 200 và giữ bytes gốc; collision không ghi đè. |
| Mobile thật 320 px | Viewport/document/body đều 320 px. Tệp tên dài 244 bytes được tạo qua POST 201 và mở editor; lượt cuối sau autofocus 350 ms ở 320×860 có modal client/scroll đều 284 px, nút đóng x=236–280/y=50,28125–94,28125 nhìn thấy trong viewport. Title hai dòng và nút đóng cố định; danh sách/vùng chọn file cũng được chụp sau scroll thực. |
| Header synthetic | DOM được tiêm tên server 64 ký tự để kiểm tra layout; document vẫn 320 px, nút refresh right=281 px. Đây là thử layout tổng hợp, không phải một tên được lưu qua API. |

Không ghi nhận pageerror hoặc JavaScript dialog ngoài dự kiến trong lượt QA. HTTP 409 của các probe conflict là kết quả được mong đợi. Đã xem ảnh `vortex-mc-0.4.0-files-desktop.png`, `vortex-mc-0.4.0-files-mobile-320.png`, `vortex-mc-0.4.0-files-actions-mobile.png`, `vortex-mc-0.4.0-editor.png`, `vortex-mc-0.4.0-editor-conflict.png` và `vortex-mc-0.4.0-editor-long-name-mobile.png` tại `output/playwright/`. Không đưa fixture/dữ liệu QA vào source ZIP.

## Phạm vi kiểm chứng và giới hạn 0.4.0

File mutations cần server dừng, trong một instance, tối đa 1.000 nguồn, 2 GiB/50.000 mục, 2 MiB UTF-8 editor và 100 MiB mỗi upload. ZIP giữ Root-relative paths, extraction vào folder mới; demo archive là snapshot mô phỏng, không phải ZIP thật để tải. Không có folder upload, copy giữa server, SFTP/chmod/remote URL pull, Monaco, bulk delete hoặc archive format ngoài ZIP.

Rollback xử lý lỗi được quan sát trong process, chưa có journal bảo đảm transaction nhiều file sau mất điện và không khóa công cụ host bên ngoài. Chưa chạy Bedrock/client, installer/systemd/firewall/rollback/snapshot trên Ubuntu thật. Những giới hạn triển khai của các bản trước vẫn áp dụng; test filesystem không chứng nhận gameplay hoặc hosting nhiều tenant.

## Lịch sử kiểm chứng Vortex MC 0.3.1

Nghiệm thu **Vortex MC 0.3.1**, ngày **13/10/2026 tại Bangkok** (**12/10, 22:59–23:00 UTC**), trên máy phát triển Windows với Node.js. Kết quả phân biệt kiểm chứng API/filesystem với vận hành Bedrock trên Ubuntu; bằng chứng trình duyệt các đợt trước được giữ dưới nhãn riêng.

### Kiểm tra tự động

- `npm run check`: toàn bộ JavaScript đạt kiểm tra cú pháp.
- `npm test`: **73/73 pass**, không skip, khoảng 13,83 giây trong lượt cuối. Bao gồm auth/CSRF/Origin, HTTP/WebSocket RBAC, thu hồi phiên, MFA/RFC 6238/replay/recovery/vault, rollback khi lưu thất bại, khóa dữ liệu nhiều tiến trình, lifecycle/schedules, archive/path, install/update/restore/clone/identity/retention và pack dependencies/transaction. Delta 0.3.1 thêm registry/history coverage, lazy legacy metadata, SHA-1 và hashless byte-count checks, latest Mojang không bị nguồn phụ chặn, paired player JSON rollback, schedule CRUD và create/clone queue rollback/lock cleanup.
- Review độc lập đã chạy riêng version 16/16, players 5/5, schedules 4/4 và provisioning 5/5; các lượt target này không được cộng thành một lượt full-suite riêng.
- `npm audit --omit=dev`: không báo lỗ hổng trong lượt nghiệm thu 0.2.0 trước đó; đợt này không thay dependency. Kết quả phụ thuộc cơ sở dữ liệu advisory tại thời điểm chạy, không phải bảo đảm dài hạn.
- `bash -n`: installer và script snapshot đạt kiểm tra cú pháp trong lượt trước. Harness riêng xác nhận guard đường dẫn và phạm vi data/backup/source; không chạy các thao tác cài dịch vụ hoặc đổi quyền host. Không sửa các script triển khai trong delta 0.3.1.

### Kiểm tra catalog và trình duyệt 0.3.1

Probe service history-only độc lập lúc **22:54:29 UTC** trả **395 record — 191 stable/204 preview**, hai nguồn ready, không lỗi; latest/preview vẫn null trong store này. Registry BDS-Versions riêng có 191 stable/202 preview, từ 1.6.0.15 và 1.19.50.21. Lazy metadata + HEAD các build 1.6.0.15, 1.16.1.02, 1.20.0.01 thành công; hai gói đầu không có checksum, gói thứ ba có SHA-1. Không tải executable. Ready chỉ nói về registry, không chứng minh mọi ZIP hoặc runtime.

| Luồng 0.3.1 | Bằng chứng |
| --- | --- |
| Catalog lịch sử | Browser demo hiển thị 395 mục; tìm `1.16` có 13 kết quả và mười hàng trang đầu; Stable trang hai có mười hàng; tìm exact `1.16.1.02` có một kết quả. |
| Sidebar | DOM không còn shortcuts từng server; chọn máy chủ qua picker/danh sách và workspace. |
| Draft cấu hình gặp external start | Đổi difficulty thành hard khi stopped; start qua API khác làm fields bị khóa nhưng dirty vẫn true. Save báo rõ lỗi, giá trị đã lưu vẫn normal. Sau external stop, Save giữ hard và dirty=false. |
| Header khi cấu hình có draft | Lượt cuối 23:03 UTC xác nhận running hiển thị Đang chạy/Dừng, stopped hiển thị Đã dừng/Khởi động mà không xóa draft hoặc dirty state. Save khi running báo lỗi; stop rồi Save xóa lỗi và dirty=false. |
| Mobile 320 px | Document rộng đúng 320 px, exact search 1.16.1.02 còn một hàng. Ảnh cuối chụp sau thao tác scroll thực: nút hành động right 276 px/bottom 667,625 px, phía trên dock bắt đầu tại 796 px; không tràn ngang hoặc bị dock che. |

Ảnh nghiệm thu cuối: `output/playwright/vortex-mc-0.3.1-versions.png`, `vortex-mc-0.3.1-configuration.png` và `vortex-mc-0.3.1-mobile.png` trong cùng thư mục. Browser QA hoàn tất lúc **23:03 UTC**; ảnh dùng dữ liệu demo, không phải Bedrock runtime thật.

### Cần kiểm chứng trên host triển khai

Chưa chạy installer/systemd, rollback source, snapshot toàn panel, binary Bedrock thật hoặc client kết nối trên Ubuntu trong phiên này. Trước vận hành, kiểm tra lần lượt cài service, HTTPS, khởi động BDS chính thức, firewall/NAT theo transport, client vào world, add-on thực tế, backup/restore và restart/snapshot có tiếp tục instance đúng ý định.

Vortex MC 0.3.1 quản lý một host; chưa có quota/cgroup/container, multi-node, billing, SFTP hoặc backup offsite. Catalog là hợp nhất các nguồn đã đọc, không phải lời hứa có mọi build Minecraft từng tồn tại hoặc mọi binary cũ chạy trên Ubuntu hiện tại. Các giới hạn này được mô tả trong README và COMPETITIVE; kết quả test không phải chứng nhận cho môi trường hosting nhiều tenant.

## Lịch sử kiểm chứng Vortex MC 0.3.0

Thực hiện ngày **12/10/2026** trên Windows với Node.js. Phần 0.3 ghi kết quả sau phản hồi UI/UX; phần nền 0.2 giữ lại chứng cứ của tính năng trước đó.

### Refinement 0.3: kiểm tra tự động

- `npm test`: **50/50 pass**, không skip, kết thúc khoảng 14:20 UTC. Coverage mới gồm lịch sử phiên bản/checksum/redirect, Preview bị rút khỏi API, transaction cấu hình, reservation cũ/mới, TCP/UDP IPv4/IPv6 và scoped file move.
- `npm run check`: JavaScript hợp lệ. Frontend cũng đã được kiểm tra cú pháp sau chỉnh popup/context binding và loại pattern HTML không tương thích Chromium.
- Fault tests xác nhận lỗi ghi catalog giữ object identity/settings; SHA-256 sai bị chặn trước kích hoạt package; lỗi ghi cấu hình/di chuyển khôi phục properties, metadata và actor audit.
- Socket tests dùng TCP/UDP thật của Node trên Windows, không thực thi BDS.

### Refinement 0.3: kiểm tra qua giao diện

Chromium qua Playwright, dữ liệu QA nằm ngoài source. Hai instance trong filesystem sử dụng **ZIP fixture ELF trơ**, luôn dừng; không khởi động executable.

| Luồng | Kết quả đã quan sát |
| --- | --- |
| Cấu trúc quản trị | Main nav có Tổng quan/Máy chủ/Phiên bản/Lịch tác vụ/Hệ thống/Cài đặt; Console/Tệp/Sao lưu nằm trong workspace server. Console aside hiển thị chính sách vận hành thay danh sách tab lặp lại. |
| Picker | Popup có search/listbox; lọc Creative và chọn bằng Enter mở đúng server, giữ tab. Đã xem ảnh dark render, không có native server dropdown. |
| Popup bản nháp | Chuyển tab khi cấu hình dirty mở dialog panel. Tiếp tục chỉnh sửa giữ bản nháp; Bỏ thay đổi mới chuyển tab. Không có alert/confirm/prompt của trình duyệt trong mã panel. Browser tab-close/reload có thể dùng beforeunload của trình duyệt. |
| Catalog thật | QA đọc 145 metadata cộng đồng + 1 fixture nhập. DOM có 10 record/trang, trang 2 khác trang 1; tìm 1.26.51 còn một record. Nút HEAD xác minh 1.26.51.1 available, source Endstone, cached=false; không tải binary. |
| Cấu hình thật | Đổi tên cùng cổng sang cổng server khác trả 409, backend giữ tên/cổng cũ. Sửa sang 30250/30251 + difficulty hard trả một PATCH 200; properties khớp metadata, savebar về đã lưu. |
| UDP demo | TCP signaling 19400 + maxPlayers 40 tạo dải 19402–19445. Custom NAT vẫn giữ nguyên sau khi đổi signaling sang 19500. Đây là kiểm tra UI/API mô phỏng. |
| File thật | Upload văn bản, mkdir notes qua popup. Move vào đích đã tồn tại trả 409; sửa đích notes/renamed.txt trả 200, giữ nội dung. Đường dẫn cũ và đường dẫn tương ứng ở instance khác trả 404. |
| Mobile | Màn hình 320 px: document width=320, 10 record DOM, danh sách dạng thẻ rộng 284 px; nút cài đặt nằm trong viewport. Đã xem render 390 px và bố cục sáng/tối trên desktop 1440×1080. |

Ảnh 0.3 và fixture QA lưu ở `output/playwright`, loại khỏi source ZIP. Demo có nhãn; test/mock/fixture không chứng minh gameplay hoặc addon hoạt động trong Minecraft.

### Giới hạn của nghiệm thu 0.3

Chưa chạy BDS chính thức, client game, installer/systemd/firewall hoặc snapshot trên Ubuntu trong lượt này. Transaction có rollback khi lỗi được quan sát trong process; không bảo đảm commit nhiều tệp nguyên vẹn khi mất điện giữa các bước. Vortex vẫn quản lý một host, chưa có multi-node/container/cgroup/quota/SFTP/S3/billing.

## Bằng chứng trình duyệt nền tảng từ 0.2.0

Đã sử dụng Chromium qua Playwright, thao tác giao diện thật và kiểm tra dữ liệu trả về:

| Luồng | Bằng chứng |
| --- | --- |
| Desktop/mobile/light/dark | Đã xem ảnh render; màn hình 320 và 390 px không tràn ngang. Desktop cuối 1440×1080; mobile cuối 390×844. |
| Command palette | Tìm và mở đúng workspace bằng bàn phím; giữ ngữ cảnh server. |
| Console | Input giữ nguyên qua polling; gửi lệnh demo; lịch sử và bộ lọc hoạt động. Response log chậm không ghi đè context sau khi chuyển server. |
| Cấu hình | Cảnh báo bỏ thay đổi; hủy giữ nội dung đang sửa. Lưu `level-name` qua API thật. |
| Lịch tác vụ | Tạo, tạm dừng, chạy thủ công khi đang tạm dừng, sửa interval và xóa. |
| MFA/tài khoản | Tạo tài khoản thật trong data QA riêng, setup QR/TOTP, bật MFA, từ chối factor sai và đăng nhập bằng mã khôi phục dùng một lần. Viewer không thấy điều khiển quản trị host/tài khoản. |
| Filesystem/install | Nhập ZIP runtime **fixture trơ**, tạo instance đã dừng và giải nén qua workflow thật. Không thực thi binary fixture. |
| Add-on | Nhập `.mcaddon` lồng hai pack, bật behavior tự bật resource dependency; từ chối tắt dependency đang được dùng; archive traversal bị chặn. |
| Backup | Tạo ZIP thật từ instance fixture và chạy restore qua giao diện, với server đã dừng. |

Fixture chỉ kiểm tra file/manifest/API. Nó không đại diện world chơi được, addon đã tương thích gameplay hoặc binary Bedrock có thể chạy. Chế độ demo và chỉ số mô phỏng đều có nhãn trong UI.

Ảnh bàn giao nằm ở `output/playwright/vortex-mc-desktop.png`, `vortex-mc-dark.png` và `vortex-mc-mobile.png` trong workspace phát triển, không nằm trong source ZIP. Dữ liệu/tài khoản/khóa của QA được tách khỏi dự án và loại khỏi gói phát hành.
