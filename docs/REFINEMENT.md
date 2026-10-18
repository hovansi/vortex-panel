# Vortex MC 0.4.1 — refinement vận hành, phiên bản và file

Nghiên cứu nền ngày **12/10/2026** về bộ chọn server, điều hướng và cấu hình mạng; bổ sung file manager **0.4.0** ngày **14/10/2026 tại Bangkok**. Những mục ghi “đề xuất” là thiết kế cần nghiệm thu theo code/API thực. Các delta đã triển khai và kiểm chứng được tách theo phiên bản bên dưới.

Hiện trạng **0.4.1 ngày 14/10/2026** và QA Ubuntu/BDS thật được ghi tại [VPS-ACCEPTANCE](VPS-ACCEPTANCE.md). Các section 0.3.x/0.4.0 dưới đây giữ đúng nguồn, số liệu và phạm vi lịch sử; không dùng chúng làm tổng nghiệm thu mới hoặc bằng chứng client đã được xác nhận.

## Luồng quản trị nên học từ nguồn chính thức

| Nguồn | Hành vi được tài liệu xác nhận | Áp dụng đề xuất cho Vortex |
| --- | --- | --- |
| [Aternos kết nối](https://support.aternos.org/hc/en-us/articles/360026805072-Connect-to-your-server) | Trang server có địa chỉ để sao chép; Bedrock phải nhập port riêng | Giữ địa chỉ và port người chơi trên header workspace. UDP pool quản trị nằm ở Network, tránh trình bày mọi port như địa chỉ người chơi |
| [Aternos options](https://support.aternos.org/hc/en-us/articles/360030513552-The-options-of-your-server-explained) | Option có mô tả, khác theo software; thay đổi cần restart. Gamemode cho người chơi mới khác lệnh đổi tạm thời | Nhóm cấu hình theo công việc; giải thích field tại chỗ, biểu thị restart và đối tượng bị ảnh hưởng. Chỉ hiện field phù hợp transport/runtime |
| [Aternos updates](https://support.aternos.org/hc/en-us/articles/11750051573277-Automatic-updates) | Ask/Always/Never là chính sách update riêng; Bedrock được hỗ trợ | Latest discovery và tự cập nhật phải là hai trạng thái riêng. Vortex hiện cập nhật theo thao tác có backup; không gọi việc kiểm tra latest là autoupdate |
| [Aternos backups](https://support.aternos.org/hc/en-us/articles/360044837012-Creating-and-restoring-backups) | Đặt tên backup, automatic retention, restore thay toàn bộ server files/world | Hiển thị snapshot/version/phạm vi dữ liệu; xác nhận restore đúng instance. Backup/offsite là luồng khác với quản trị tài khoản panel |
| [Aternos access](https://support.aternos.org/hc/en-us/articles/360026950952-Share-access) | Quyền được chia theo Console/Files/Worlds/Backups/Options… và chọn server được chia sẻ | Vortex giữ server scope xuyên UI/API; chức năng cần quyền cao có lý do rõ. Permission nhỏ theo chức năng là hướng sau coarse RBAC hiện tại |
| [Crafty tạo server](https://docs.craftycontrol.com/pages/user-guide/server-creation/minecraft/) | Chọn Java/Bedrock; create/import riêng, import chọn root directory; port phải khớp Docker mapping | Không sao chép RAM flag của Java sang Bedrock. Phân biệt port được cấu hình với port thật được publish/forward; tạo instance và import package có ngữ cảnh riêng |
| [Pterodactyl API stable](https://docs.pterodactyl.io/v1/api) | Client API phục vụ server được phép; file/schedule/network/backups là nhóm dưới server, Application API quản trị khác | Một selected-server workspace là nguồn ngữ cảnh; global quản trị host/users/catalog riêng. Không tạo lại Files/Console/Backups cùng chức năng ở nhiều trang |
| [AMP 2.8 changelog](https://discourse.cubecoders.com/t/amp-proteus-2-8-0-release-notes/40953) | Có cải tiến Bedrock/network và hiển thị địa chỉ kết nối riêng | Connection display cần độc lập với bind/UDP allocation; không suy thông tin bind thành IP public đã kiểm chứng |
| [Apple menus](https://developer.apple.com/design/human-interface-guidelines/menus), [WWDC navigation/selection](https://developer.apple.com/videos/play/wwdc2022/10009/) | Menu tác động current context; pop-up cho tập lựa chọn rõ, search theo nội dung hiện tại | Bộ chọn server tìm theo tên, có status/version và focus/keyboard đúng; giữ selection ổn định khi metrics cập nhật. Danh mục lớn dùng search/pagination thay menu quá dài |

Aternos là hosted service; policy queue, data retention hay giới hạn file của họ không phải yêu cầu cho panel Ubuntu tự host. Không chuyển option Java như `pvp`, Java resource-pack URL hay heap flags thành property BDS nếu runtime không có key đó.

## Cấu trúc workspace đề xuất

Global chỉ gồm Overview, Servers, Version catalog, Jobs/Schedules và Administration/Host theo quyền. Server picker nằm trên header và hiển thị tên, trạng thái, version. Khi đổi server giữ tab tương đương, xác nhận dữ liệu chưa lưu; log/file/config response cũ không được ghi vào server mới. Các shortcut Files/Console/Backups chỉ chuyển tới tab tương ứng của selected server.

Config nên có Network, World, Gameplay, Performance, Security và Custom. Network hiển thị transport thực: RakNet dùng IPv4/IPv6 UDP; NetherNet dùng TCP signaling và UDP range/NAT mapping. Connection address là thông tin copy cho người chơi, khác bind fields. Thay đổi tên/autostart/retention và properties nên có một commit rõ để không báo thành công một nửa. Custom keys cần giữ nguyên; schema thay theo phiên bản, không xóa key chưa biết.

[Microsoft properties](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/server-properties) quy định enum gamemode/difficulty/permission, view-distance ≥5, tick-distance 4–12, idle timeout ≥0, compression-threshold 0–65535. Trang có mâu thuẫn: `max-threads` prose cho phép 0 nhưng bảng nói positive; dùng 0 như chế độ tự chọn theo prose. Network hiện đại phải đối chiếu manual của package, vì trang properties còn mô tả RakNet cũ. Giới hạn panel như port ≥1024 hoặc players ≤1000 cần được ghi là policy của panel.

## Nguồn lịch sử BDS đã kiểm tra

Mojang API latest vẫn là nguồn authoritative cho stable/preview hiện tại. Nguồn cộng đồng bổ sung lịch sử cần được gắn nhãn và không được thay latest chính thức.

| Catalog | Dữ liệu thực | Cập nhật kiểm tra | Hạn chế |
| --- | --- | --- | --- |
| [Bedrock-OSS/BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions), [versions.json](https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json) | `linux.versions`, `linux.preview_versions`; file `linux/<exact four-part>.json` hoặc `linux_preview/<version>.json` có download_url, sha1, size, date | Commit 2026-10-06 19:04 UTC | GitHub không nhận diện license, root chưa có LICENSE khi kiểm tra; không vendor corpus với giả định MIT. Danh sách không tự chứng minh link còn tải được |
| [EndstoneMC/bedrock-server-data](https://github.com/EndstoneMC/bedrock-server-data), [MIT](https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2/LICENSE) | Branch `v2`; `versions.json` có release/preview; `release/<display-version>/metadata.json` chứa `binary.linux.url` và sha256 | Commit 2026-10-06 22:43 UTC | Display stable 3 phần, exact build 4 phần nằm trong URL. Lịch sử release bắt đầu 1.21.62 khi kiểm tra; không đầy đủ build variants, không coi hash cộng đồng là chữ ký Mojang |

[Ví dụ Endstone 1.26.51](https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2/release/1.26.51/metadata.json) trỏ chính xác tới CDN `www.minecraft.net`, không cần đoán build number. Catalog preview dùng nhãn như `1.26.60-preview.30`; phải lấy URL/channel từ metadata, không dựng URL bằng cách nối nhãn.

Probe **HEAD, không tải executable**, tại **13:54:13 UTC** xác nhận 10 stable cũ sau trả HTTP 200, MIME ZIP, kích thước 90–104 MB:

| Exact Linux build | HTTP |
| --- | --- |
| 1.26.51.1 | 200 |
| 1.26.45.1 | 200 |
| 1.26.44.3 | 200 |
| 1.26.43.1 | 200 |
| 1.26.42.1 | 200 |
| 1.26.40.8 | 200 |
| 1.26.36.1 | 200 |
| 1.26.34.3 | 200 |
| 1.26.33.1 | 200 |
| 1.26.32.2 | 200 |

HEAD chỉ chứng minh URL trả metadata ở thời điểm probe; không xác nhận SHA256 bytes, ELF dependencies, server startup hay client compatibility. SHA256 chỉ được so sánh khi package thật được tải theo thao tác cài. Link có thể biến mất; cache/import vẫn cần tồn tại.

Contract catalog của **0.3.0** giữ source/displayVersion/version/channel/url/SHA256 và nguồn checksum; metadata có bounded fetch, tối đa 8 request song song trong batch 30 giây. Whitelist HTTPS chính xác host/path/channel/version áp dụng cả redirect HEAD và GET. HEAD chỉ công nhận HTTP 200, MIME ZIP phù hợp và độ dài hợp lệ nếu được khai báo; tách rõ thiếu Content-Length khỏi 0. Tối đa 4 kiểm tra liên kết đồng thời, deduplicate theo version/channel. SHA256 cộng đồng được kiểm tra trong stream tải trước kích hoạt package; cache/import và catalog cũ được giữ khi refresh lỗi. Mojang API quyết định latest, lịch sử cộng đồng không thay quyền này.

API đã nối `POST /api/versions/:channel/:version/verify` cho admin; `POST /api/versions/refresh` làm mới latest và history. Catalog UI có search, filter Stable/Preview và 10 item mỗi trang, phân biệt chưa kiểm tra/đã kiểm tra/cache/unavailable. Đây là mô tả mã đã nối; kết quả tương tác và bố cục vẫn cần browser QA riêng. Attribution cho 23 identifiers demo ở [THIRD_PARTY.md](THIRD_PARTY.md); demo không tải hay chạy Minecraft.

## Lịch sử kiểm chứng 0.3.0

Nghiệm thu tích hợp sau refinement đạt **50/50 tests**. Browser QA xác nhận catalog thật 10 mục/trang, tìm và HEAD build cũ; popup bản nháp; đổi cổng không lưu một nửa; UDP tự động/NAT tùy chỉnh; upload/mkdir/move có no-overwrite và server scope. Chi tiết, ảnh và ranh giới kiểm chứng nằm trong [VERIFICATION.md](VERIFICATION.md).

Lượt độc lập toàn bộ suite trước refinement có **34/34 pass**. Sau bổ sung, đã chạy độc lập riêng **6/6 version tests**, **6/6 configuration tests** và **3/3 file move tests**. Test version kiểm tra identity/channel/SSRF, HEAD zero-length/cross-build redirect, retired/HTML links, rollback catalog giữ object identity và checksum mismatch trước package activation. Test config kiểm tra một commit metadata/properties/audit, rollback khi disk write lỗi, giữ custom NAT/unknown keys, chặn thay properties khi đang chạy, giữ cả cổng cũ và candidate trong transaction, cổng TCP/UDP đang bị chiếm, inbound debugger và probe RakNet IPv4/IPv6. Test move kiểm tra rename file/folder giữ nội dung, không ghi đè, chặn traversal/symlink/runtime/identity/pack/config/selected-world paths, guard stopped/busy/closed và khôi phục rename nếu audit không lưu được.

Probe service thực tại **14:04:23 UTC** đọc **145** metadata records (**57 stable, 88 preview**), history ready và không lỗi. HEAD 1.26.51.1 được xác minh available; latest/preview vẫn null trong store riêng chỉ refresh history, đúng yêu cầu không lấy latest từ cộng đồng. Không tải BDS executable. Các fault probe độc lập phát hiện và đội đã sửa hai lỗi proof HEAD (zero length và redirect sang build/channel khác), giải phóng cổng cũ trước commit, cùng UDP4 truyền nhầm IPv6-only flag.

Unified configuration đã có `GET/PATCH /api/servers/:id/configuration`: settings, properties và udpMode đi qua cùng transaction; known fields được validate, unknown keys giữ nguyên; sửa properties cần stopped server, còn panel name/autostart/retention có thể lưu khi đang chạy. Chỉ sau commit durable mới báo thành công; lỗi khôi phục properties cũ, metadata và audit. Scoped file move đã nối `POST /api/servers/:id/files/move` với source/destination theo instance, cùng ACL và exclusive stopped guard; một commit audit sau rename, lỗi commit hoàn tác rename. Đây là rollback cho lỗi quan sát được trong process, không phải lời hứa transaction đa file nguyên vẹn sau mất điện. Nghiệm thu UI bổ sung do browser QA thực hiện riêng. Không có Linux/systemd/BDS runtime smoke test trong nghiên cứu này.

## Refinement 0.3.1 — độ phủ catalog và tính nhất quán thao tác

Nguồn Endstone đã dùng chỉ bắt đầu ở 1.21.62 và bỏ một số exact build; vì vậy danh sách 145 item không đại diện toàn lịch sử BDS. Registry [BDS-Versions](https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json) được probe độc lập lúc **22:47:56 UTC ngày 12/10/2026** (ngày **13/10 Bangkok**), có 191 Linux stable/202 preview, bắt đầu từ 1.6.0.15 và preview 1.19.50.21. Giữ nguyên padded version như 1.16.1.02; SHA-1 là tùy chọn và hai metadata đời cũ đã đọc không có checksum. GitHub không nhận diện license và root không có LICENSE; không gọi corpus này là MIT. Attribution phân nguồn ở [THIRD_PARTY.md](THIRD_PARTY.md).

Service 0.3.1 hợp nhất registry này với Endstone, đưa identifier lên catalog trước bước metadata tùy chọn. Candidate URL chỉ được dựng từ exact identifier đã có trong registry và CDN root chính thức mà registry khai báo; candidate giữ unchecked và không được coi là tải được. Khi kiểm tra bản cũ, panel đọc metadata đúng Linux/version/channel rồi HEAD chính thức. SHA-256 Endstone được giữ khi trùng build; SHA-1 được kiểm tra nếu có, metadata không có hash giữ nhãn không có checksum. Kích thước khai báo được đối chiếu với HEAD và tổng bytes GET trước activation. Latest Mojang có provenance riêng và vẫn sử dụng được khi metadata bổ sung bị lỗi.

Metadata history có trạng thái và counts từng nguồn, coverage và lỗi còn lại; Endstone commit theo batch tám item để timeout không xóa phần đã tải thành công. Ready nghĩa là registry đã đồng bộ, không chứng minh mọi package/runtime. Probe service độc lập lúc **22:54:29 UTC** trả **395 record (191 stable/204 preview)**, source ready/errors null; latest/preview null trong store chỉ refresh history. Lazy metadata + HEAD ba mẫu 1.6.0.15, 1.16.1.02, 1.20.0.01 thành công, không tải executable. Demo có thể đọc metadata mạng nhưng mọi availability/package action vẫn là mô phỏng; offline giữ fallback và cache.

| Delta đã triển khai | Contract và phạm vi |
| --- | --- |
| Điều hướng | Bỏ sidebar shortcuts từng server; server picker và danh sách Máy chủ giữ vai trò chọn context. Root browser kiểm tra DOM không còn shortcuts, catalog có search exact padded version và phân trang mười item. |
| Danh sách người chơi | Boolean rõ, XUID unsigned 64 bit chính xác, chặn tên/XUID trùng và numeric mất precision; prepare hai JSON rồi commit một audit, lỗi file/metadata hoàn tác cả cặp. Raw editor dùng chung đường này. |
| Lịch tác vụ | Create/edit/delete commit state + audit một lần; thất bại giữ array/record identity và không để thay đổi chưa lưu rò sang lần save khác. Chặn field chỉ đọc và đổi serverId. |
| Tạo/clone | Registration, queued job, actor audit và clone source lock được lưu cùng nhau. Lỗi trước queue không để orphan/reservation; lỗi sau queue giữ failed job/error instance. Clone cleanup chạy cả khi lỗi xảy ra trước bước copy. |

Fault probe độc lập đã tái hiện và đội sửa: schedule CRUD lỗi ghi vẫn thay RAM; create thất bại để orphan installing không có job; clone lỗi ngay sau queue để source lock treo; auxiliary metadata lỗi chặn cả URL latest Mojang. Các kiểm tra target mới được chạy độc lập, còn kết quả full-suite và browser 0.3.1 cuối cùng ở [VERIFICATION.md](VERIFICATION.md). Các thay đổi này vẫn là rollback cho lỗi quan sát trong process; không mở rộng thành transaction nguyên vẹn sau mất điện, container isolation hoặc chứng minh tương thích Ubuntu/client của mọi build cũ.

## Refinement 0.4.0 — quản lý file và editor

Đợt này thêm copy/move vùng chọn, rename riêng, tạo văn bản, compress/extract ZIP, các thao tác CRUD có staging/audit rollback và editor revision. UI có current-folder search/sort, visible select-all và hidden-selection count, clipboard cùng server, folder picker, action dialog theo capabilities, queue upload/drop nhiều file và persistent editor. [RESEARCH.md](RESEARCH.md) ghi các nguồn chính thức Pterodactyl/Crafty/AMP, Node và ZIP; [API.md](API.md) ghi payload/limits cụ thể, [OPERATIONS.md](OPERATIONS.md) giải thích full Root-relative archive layout và khôi phục khi lỗi.

Baseline generic file writes/upload/delete trước đây có thể trả lỗi audit sau khi dữ liệu đã đổi, upload ghi đè cùng tên, mkdir existing trả thành công và editor UTF-8 thay byte không hợp lệ. Module mới chuẩn bị/stage/activate rồi commit audit, guard toàn bộ descendant và phục hồi lỗi được quan sát. Editor dùng SHA-256 revision, từ chối stale/missing revision và không tái tạo file đã bị xóa. Probe độc lập đã tái hiện missing-target resurrection trong implementation đầu, sau đó xác nhận regression sửa cả live/demo. Managed editor trả nội dung đã chuẩn hóa và revision từ cùng locked read; UI dùng kết quả này làm baseline đã lưu nhưng giữ draft mới hơn nếu người dùng tiếp tục nhập trong lúc request chạy. Bộ ZIP thêm CRC32, byte-count/type/prefix/Windows alias checks, chờ writer đóng, giữ empty directories và tính cả thư mục cha ngầm định vào quota số mục.

Review độc lập đã chạy riêng **6/6 archive tests** và **10/10 file operations/HTTP tests**, không gọi đây là một lượt full-suite. Probe corrupt-CRC ZIP qua manager trả 400, không có live destination, không còn private staging và không thêm audit. Probe hai entry ZIP tạo sáu mục filesystem với maxEntries=3 đã dẫn tới sửa quota bao gồm implicit parents; regression đạt và explicit directory không bị đếm lặp. Các tests dùng filesystem/ZIP thật cùng fixture trơ, không chạy/download Bedrock. Kết quả full-suite và browser cuối của 0.4.0 được ghi riêng trong [VERIFICATION.md](VERIFICATION.md).

Probe HTTP cuối xác nhận JSON parser 2 MiB từng từ chối cả văn bản 2 MiB đúng giới hạn và 1 MiB nhiều newline vì JSON escaping/envelope. Parser nay cho 13 MiB transport riêng ở PUT file/POST files/create, giữ decoded UTF-8 2 MiB và các route khác 2 MiB. Rerun HTTP độc lập đạt 1/1 với exact ASCII, worst-case escaping, over-limit không mutation và route lệnh vẫn trả 413.

Phạm vi giữ một host/một instance cho thao tác file; không copy giữa server, không SFTP/chmod/remote URL pull, không folder upload hoặc bulk delete. Generic extraction không ghi đè/merge, không thay Version/Add-ons/Backup restore. Quota 2 GiB/50.000 mục, 1.000 nguồn, 2 MiB editor, 100 MiB mỗi upload là policy của panel; staging cần thêm dung lượng. CRC/revision phục vụ integrity/concurrency, không là chữ ký tác giả. Rollback chưa bảo đảm transaction sau mất điện và không khóa mọi công cụ host bên ngoài.
