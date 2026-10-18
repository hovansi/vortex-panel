# Vortex MC — thiết kế giao diện và trải nghiệm vận hành

Đối chiếu nguồn ngày **12/10/2026**. Đây là định hướng thiết kế cho web panel Node.js, lấy cảm hứng từ iOS và thế giới Minecraft. Các kích thước, màu và thời lượng dưới đây là quyết định của dự án, không phải thông số Apple yêu cầu cho web.

## Cơ sở thiết kế

Liquid Glass phù hợp với lớp điều hướng và điều khiển nổi; Apple khuyến nghị dùng vật liệu nội dung khác cho các vùng dữ liệu và sử dụng glass tiết chế. Vortex áp dụng glass cho rail, dock, toolbar và control chọn tab; console, biểu đồ, bảng tệp và biểu mẫu có nền đủ đục để đọc ổn định. [Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

Sidebar và tab bar nên thay đổi theo không gian cửa sổ; nội dung quan trọng cần được ưu tiên và các thiết lập ít dùng có thể mở dần. Vortex dùng rail ở desktop, dock ngắn ở mobile và menu thêm cho công cụ ít dùng. [Apple Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars?changes=_11), [Apple Layout](https://developer.apple.com/design/human-interface-guidelines/layout?changes=lat_3__1_2).

Chuyển động cần phản hồi thao tác, ngắn và có thể giảm; không buộc người dùng chờ animation. Dự án dùng phản hồi nhấn và chuyển tab nhẹ, không làm log console hoặc số liệu nhảy liên tục. [Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion?changes=l_9_3).

Màu thương hiệu nên có chủ đích; chữ hệ thống giúp nội dung nhỏ dễ đọc. Vortex dùng tím/indigo cho lựa chọn và hành động chính, emerald cho trạng thái đang chạy, block/voxel trong minh họa và icon nhận diện thế giới. [Apple Branding](https://developer.apple.com/design/human-interface-guidelines/branding), [Apple Fonts](https://developer.apple.com/documentation/technologyoverviews/fonts).

## Ngôn ngữ hình ảnh

| Thành phần | Định hướng Vortex |
| --- | --- |
| Nền ứng dụng | Ánh tím/indigo rất nhẹ, chiều sâu từ gradient và panorama voxel; không đặt texture sau chữ dài |
| Navigation | Rail kính nổi, viền sáng mảnh, bóng mềm; lựa chọn dạng capsule/lens |
| Nội dung | Card gần trắng hoặc dark slate, đường phân cách nhẹ, khoảng trống rõ |
| Minecraft | Panorama riêng, khối đất/cỏ/đá cách điệu, emerald nhỏ; giữ tên và logo Vortex riêng |
| Dữ liệu | CPU/RAM/disk hiển thị giá trị và đơn vị; màu trạng thái luôn đi cùng chữ/icon |
| Console | Nền slate sâu, monospace, vùng đọc tách input, mức log nhận diện bằng nhãn |
| Tính tương tác | Mỗi button có hover, focus, press, loading và disabled; không phụ thuộc hover trên mobile |

Không dùng screenshot/asset Minecraft tải lại làm thương hiệu Vortex. Minh họa voxel do dự án tạo giúp có nhận diện riêng. Khi phát hành hoặc thương mại hóa, đối chiếu [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines) cho cách dùng tên và tài sản Minecraft.

Tokens đề xuất: khoảng cách 4/8/12/16/24/32 px; radius card 24–28 px, input 12–16 px, capsule theo chiều cao; heading 28–34 px, body 15–17 px, metadata 12–14 px. Font stack dùng system UI trên nền tảng hiện tại; không đóng gói SF Pro/SF Mono tải từ Apple. Số tài nguyên dùng tabular numerals; đường dẫn và log dùng monospace. Main content giới hạn chiều rộng hợp lý nhưng console/files có thể chiếm toàn bộ vùng làm việc.

## Cấu trúc thông tin

1. **Tổng quan**: tài nguyên host đo thực tế, server đang chạy, tác vụ còn lại, sự kiện gần nhất. Panorama giữ nhỏ để thông tin vận hành xuất hiện ngay.
2. **Máy chủ**: danh sách, tìm theo tên/version, lọc trạng thái; mỗi card có tên, world, version/channel, tình trạng và hành động chính.
3. **Workspace máy chủ**: header ngữ cảnh cố định gồm tên server, trạng thái, địa chỉ, version và thao tác power; tabs Console, Files, Settings, Players, Backups, Activity tùy quyền.
4. **Thư viện phiên bản**: latest stable/preview, thời gian kiểm tra Mojang, catalog đã quan sát và import ZIP. Gói unavailable không có nút cài hoạt động.
5. **Lịch tác vụ**: trạng thái bật/tắt, loại việc, instance, lần chạy tiếp theo và kết quả cuối. Tránh tự hiểu “sao lưu” là không gây downtime.
6. **Hệ thống**: health checks, mạng, tài nguyên, terminal nếu có quyền và đã bật.
7. **Cài đặt panel**: tài khoản, quyền truy cập, giao diện, đăng xuất. Quản lý người dùng chỉ xuất hiện cho admin.

Palette **Ctrl/Cmd+K** là lối tắt bổ sung: tìm trang, chọn server, mở console hoặc tạo server khi được phép. Mỗi kết quả phải chỉ ra server đích. Drawer tác vụ/thông báo giữ trạng thái công việc dài khi người dùng chuyển trang; không chỉ hiện toast ngắn rồi mất thông tin.

## Luồng cài đặt và quản lý

**Tạo server:** thông tin → phiên bản → mạng/world → xem lại → cài đặt. Stable latest là mặc định sau khi Mojang trả dữ liệu; preview có nhãn thử nghiệm. Phần nâng cao chứa seed, transport và UDP/NAT. Nếu gói mới dùng NetherNet, hiển thị TCP signaling và dải UDP tách biệt; RakNet dùng UDP IPv4/IPv6. Không ghi mọi cổng thành “UDP 19132”. Thông báo lỗi trùng cổng nằm cạnh field cần sửa. Sau submit, trả job ngay, theo dõi progress từng bước và chỉ cung cấp Start khi runtime đã sẵn sàng.

**Power:** running cho Stop/Restart; stopped/crashed cho Start; installing/updating/restoring không cho thao tác xung đột. Stop và forced Kill phải dễ phân biệt. Lệnh power trả phản hồi đang thực hiện trước khi trạng thái cuối tới. Nếu thất bại, giữ nguyên log và hiển thị bước tiếp theo rõ như xem cổng đang bận hoặc kiểm tra thư viện hệ thống.

**Cấu hình:** nhóm Gameplay, World, Network, Performance, Advanced. Field có label, đơn vị, lỗi; advanced editor giữ các thuộc tính mới chưa biết. Hiển thị thay đổi cần restart. Không để người dùng lưu xong rồi tin rằng process đang chạy đã áp dụng toàn bộ cấu hình.

**Console:** kết nối trực tiếp có trạng thái online/reconnecting; có search, pause auto-scroll và trở về log mới. Duy trì selection và vị trí đọc khi log tiếp tục tới. History lệnh hữu ích cho admin; tránh echo mật khẩu/secret trong gợi ý. “Console Bedrock” và “Terminal host” có tên và vùng thao tác riêng vì quyền khác nhau.

**Files:** breadcrumb rõ instance, lọc thư mục hiện tại, editor có đường dẫn và dấu chưa lưu; cảnh báo đóng khi có sửa đổi. Download/upload/rename/delete có feedback. Runtime binary và thư viện được bảo vệ; trường hợp từ chối cần diễn giải thay vì lỗi chung. Xóa file/world/backup yêu cầu xác nhận đối tượng cụ thể.

**Backup/update:** ghi rõ stop → backup → restart và downtime. Khôi phục chỉ rõ tên snapshot, version và dữ liệu thay thế; bản đang chạy phải dừng. Update chỉ hoàn tất khi package mới đã được kích hoạt; log job và backup trước update cần mở lại được. Không hiển thị “rollback thành công” chỉ vì đã tồn tại ZIP.

**Tài khoản và quyền:** giao diện hiển thị vai trò hiện tại, phạm vi server và các nhóm quyền dễ hiểu. Người chỉ xem không có controls thực thi. API vẫn kiểm tra quyền; trạng thái disabled không thay thế phân quyền. Đổi/quên mật khẩu không được làm mất tài khoản admin cuối cùng; admin có thể vô hiệu hóa hoặc thu hồi phiên tài khoản khác.

## Khả năng truy cập và kiểm chứng

Apple khuyến nghị button có hit region ít nhất 44×44 pt và trạng thái nhấn; Vortex chọn vùng nhấn tối thiểu 44×44 CSS px cho controls trên mobile, kể cả icon nhỏ. [Apple Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons?changes=latest_1). Hỗ trợ phóng chữ 200%, không dùng màu làm phương tiện báo trạng thái duy nhất và kiểm tra tương phản là phần của thiết kế. [Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility?changes=____5_8_2).

Trong web implementation: `prefers-reduced-motion` tắt chuyển động lớn; `prefers-reduced-transparency` và tùy chọn giảm hiệu ứng đổi glass thành nền đục; `prefers-contrast: more` tăng viền/chữ. Tất cả chức năng có thể dùng bàn phím, focus nhìn thấy, dialog giữ focus và trả focus về trigger khi đóng. Notification/job updates dùng live region phù hợp; không đọc lại mọi dòng console liên tục. Không thay input đang gõ khi event WebSocket cập nhật dashboard.

| Kiểm tra | Kết quả mong đợi |
| --- | --- |
| Desktop 1440 px và mobile 390 px | Không tràn ngang page; table/console có vùng scroll riêng; dock không che submit |
| Keyboard và 200% zoom | Trang, form, dialog, palette thao tác được; label và nội dung không bị cắt |
| Light/dark/giảm hiệu ứng | Chữ và focus đọc rõ; trạng thái còn hiểu khi bỏ màu hoặc animation |
| Job chậm/lỗi mạng | Loading có ý nghĩa; quyền và trạng thái power đúng; retry không tạo tác vụ trùng |
| Chuyển server khi đang đọc/sửa | Không gửi lệnh/lưu file nhầm instance; state chưa lưu được xử lý rõ |
| Viewer/operator/admin | Controls, dữ liệu tải từ API và event stream phù hợp quyền hiện tại |

## Phạm vi phát triển

Bản nâng cấp hiện tại ưu tiên shell Vortex, workspace có ngữ cảnh, trạng thái vận hành rõ, command palette, jobs drawer và RBAC được backend kiểm tra. Backend TOTP/recovery đã có luồng thiết lập bằng QR, xác nhận factor, mã dùng một lần và thu hồi phiên; UI cần dùng trạng thái API thực, hướng dẫn lưu recovery codes và không hiện lại plaintext codes sau khi đóng. Cô lập runtime bằng container/per-user, nhiều node, backup remote, passkey và addon marketplace cần thiết kế/kiểm chứng riêng. Không dựng controls trông như đã hoạt động khi backend chưa hỗ trợ.

## Đã triển khai trong Vortex MC 0.2.0

Phần trên mô tả định hướng, gồm cả những luồng có thể mở rộng sau này. Bản hiện tại đã triển khai rail/dock kính, nội dung nền đục, panorama voxel riêng, giao diện sáng/tối, lens điều hướng, phản hồi nhấn, reduced motion/transparency và tăng tương phản. Command palette Ctrl/Cmd+K tìm trang, máy chủ và hành động; drawer hiển thị job, lỗi máy chủ và hoạt động từ API.

Workspace máy chủ có Console, Tệp tin, Cấu hình, Người chơi, Add-ons, Sao lưu và Hoạt động tùy quyền. Console hỗ trợ lọc chữ, tạm dừng/theo dõi cuộn, sao chép/tải log đã lọc và lịch sử lệnh trong phiên bằng phím lên/xuống. Cấu hình Bedrock, tệp, danh sách người chơi và Add-ons có giới hạn trạng thái dừng; thiết lập vòng đời của panel có thể lưu khi đang chạy. Thay đổi chưa lưu được bảo vệ khi chuyển workspace, đóng editor hoặc rời trang. Các phản hồi bất đồng bộ kiểm tra máy chủ, tab và thế hệ yêu cầu trước khi cập nhật ngữ cảnh đang xem.

Lịch tác vụ có tạo, chỉnh sửa chu kỳ, bật/tạm dừng, chạy ngay, xóa và kết quả chạy. Add-ons hỗ trợ thư viện, nhập `.mcpack`/`.mcaddon`, bật/tắt, xóa và xem manifest; phạm vi là manifest v2 resource pack và behavior pack dữ liệu, có thông báo từ chối script/v3, pack mã hóa hoặc gói thế giới. Bản demo ghi rõ thao tác mô phỏng và không nhận upload pack. Quản lý thành viên/RBAC, QR TOTP, bước xác thực đăng nhập và mã khôi phục một lần đã nối với API.

Không ghi nhận các mục chưa triển khai như marketplace, rename/filter tệp, bộ lọc trạng thái riêng cho danh sách server, wizard tạo server nhiều bước, remote backup hoặc passkey là tính năng của bản này. Tạo server hiện dùng một biểu mẫu có chọn phiên bản, cổng, số người chơi và chấp thuận EULA.

### Bằng chứng kiểm tra giao diện

- Đã kiểm tra hình ảnh desktop 1440 px, mobile 390×844 và 320×780 ở giao diện sáng/tối; mobile 320 px có chiều rộng document đúng 320 px, không tràn ngang. Mã khôi phục chuyển một cột dưới 500 px.
- Browser demo đã đi qua tạo lịch console, tạm dừng, chạy ngay khi tạm dừng, sửa chu kỳ và xóa lịch. Add-ons demo tải danh sách và metadata; kiểm tra upload/enable/delete thực do luồng nghiệm thu tích hợp thực hiện riêng.
- Giả lập phản hồi log chậm 2,5 giây khi chuyển Survival sang Creative: tiêu đề, console và log cuối vẫn thuộc Creative. Kiểm tra cú pháp JavaScript đạt; phiên browser mới không có lỗi console JavaScript trước các lần khởi động lại backend.
- Kiểm tra nhãn biểu mẫu xác nhận mỗi lần sinh field có ID riêng và `label for` tương ứng, kể cả khi hộp thoại cũ vẫn tồn tại trong DOM. Các mục 200% zoom và mọi tổ hợp nền tảng/quyền cần kiểm chứng bổ sung; không coi bảng tiêu chí định hướng ở trên là kết quả đã đạt hết.

Ảnh QA lưu trong `output/playwright/`: `vortex-overview-desktop.png`, `vortex-overview-mobile-dark.png`, `vortex-overview-mobile-320.png`, `vortex-console-mobile-dark.png`, `vortex-addons-desktop-dark.png` và `vortex-final-console-desktop.png`. Đây là ảnh minh họa dữ liệu demo, không phải bằng chứng chạy Bedrock thật trên Ubuntu.

## Đã nối trong Vortex MC 0.3.0

Điều hướng chính của admin còn sáu mục: Tổng quan, Máy chủ, Phiên bản, Lịch tác vụ, Hệ thống và Cài đặt; Hệ thống được ẩn với vai trò khác. Tổng quan tập trung tài nguyên, trạng thái máy chủ, tác vụ và hoạt động. Console, Tệp tin và Sao lưu có một vị trí làm việc trong workspace của máy chủ, thay vì lặp thành trang global. Shortcut và route mở đúng tab của instance được chọn.

Bộ chọn máy chủ dùng dialog riêng có tìm theo tên hoặc phiên bản, danh sách trạng thái và thao tác bàn phím lên/xuống/Enter/Escape. Đổi máy chủ giữ tab tương đương. Điều hướng kiểm tra thay đổi chưa lưu bằng dialog xác nhận trong ứng dụng; phản hồi tải cũ vẫn phải qua kiểm tra ngữ cảnh trước khi cập nhật workspace. Đây là các contract đã có trong mã, còn nghiệm thu tương tác của đợt 0.3.0 được ghi riêng trong [VERIFICATION.md](VERIFICATION.md).

Thư viện phiên bản có tìm kiếm, bộ lọc Stable/Preview và mười item mỗi trang. Mỗi build hiển thị nguồn metadata, tình trạng link và package cache; latest stable/preview vẫn đến từ Mojang. Lịch sử Endstone được gắn nguồn cộng đồng, kiểm tra HEAD và SHA256 theo contract trong [REFINEMENT.md](REFINEMENT.md); demo không tải executable.

Cấu hình dùng các nhóm Vòng đời, Mạng & kết nối, Thế giới, Lối chơi, Hiệu năng, Quyền truy cập và Nâng cao. Thanh lưu cố định trong vùng làm việc hiển thị thay đổi chưa lưu, Hoàn tác và Lưu; settings/properties được gửi bằng một PATCH configuration. Mạng phân biệt TCP signaling và UDP auto/custom của NetherNet với UDP IPv4/IPv6 của RakNet. Cấu hình Bedrock chỉ chỉnh khi server dừng; tên trong panel, autostart, autorestart và retention có thể lưu khi đang chạy. Các khóa bổ sung của package được giữ và vẫn có field chỉnh sửa.

Tệp tin có dialog đổi tên/di chuyển với đường dẫn tính từ root của instance, yêu cầu thư mục đích tồn tại và không ghi đè. API bảo vệ runtime, identity, file cấu hình có cấu trúc, thư viện/registration pack và root của thế giới đang được chọn. Kiểm tra độc lập dùng filesystem thật xác nhận ba test di chuyển đạt, gồm rollback rename khi commit audit lỗi. Rollback trong process không được mô tả là transaction nguyên vẹn sau mất điện.

Lượt kiểm tra độc lập của đợt này gồm 6/6 version tests, 6/6 configuration tests và 3/3 file move tests. Các kết quả này kiểm chứng contract backend, không thay thế browser QA mới, accessibility đầy đủ hoặc chạy Minecraft trên Ubuntu. Ảnh và kết quả tương tác 0.2.0 ở trên giữ nguyên phạm vi phiên bản đã kiểm tra.

## Refinement Vortex MC 0.3.1

Sidebar bỏ shortcuts từng máy chủ để tránh lặp các lối vào workspace. Điều hướng chính sáu mục, custom server picker, command palette và danh sách Máy chủ tiếp tục đảm nhiệm chọn context. Catalog hợp nhất BDS-Versions và Endstone, có độ phủ từng nguồn và trạng thái partial/loading; mười item mỗi trang và search exact padded build. Trạng thái mô phỏng trong demo được phân biệt với proof của package thật.

Draft cấu hình Bedrock được đọc độc lập với trạng thái disabled của input: khi máy chủ bị khởi động từ phiên khác, field chỉ đọc vẫn giữ nội dung và dirty state; Save báo lỗi nếu còn Bedrock edits chưa áp dụng, thay vì lưu panel settings rồi coi toàn biểu mẫu đã được lưu. Browser QA đã xác nhận sửa hard → external start → Save bị từ chối với giá trị durable vẫn normal; external stop → Save thành công, durable hard và dirty=false.

Root browser cũng xác nhận không còn sidebar shortcuts trong DOM, search 1.16 có 13 mục, Stable trang hai có mười hàng, search exact 1.16.1.02 có một hàng và layout 320 px không tràn ngang. Header vẫn cập nhật Đang chạy/Dừng hoặc Đã dừng/Khởi động trong khi giữ draft; nghiệm thu ảnh cuối sau scroll thực xác nhận nút hành động không bị dock che. Browser QA hoàn tất lúc 23:03 UTC, kết quả/ảnh và 73/73 tests ở [VERIFICATION.md](VERIFICATION.md); không suy các kết quả demo thành khả năng chạy tất cả build cũ trên Ubuntu.

## File workspace Vortex MC 0.4.0

File workspace bổ sung tìm theo tên trong thư mục hiện hành; sắp xếp thư mục trước rồi theo tên/số, modified, size hoặc type. Checkbox chọn nhiều và select-all chỉ áp dụng cho các hàng đang hiển thị; thanh selection cho biết số mục bị filter che để thao tác không bất ngờ tác động thêm file. Copy/Cut clipboard ghi server nguồn và chỉ Paste trong cùng server; destination có picker thư mục riêng. Rename, batch Move, ZIP, Extract và tạo file có dialog mô tả nguồn/đích và chính sách không ghi đè.

Menu ellipsis/right-click tập trung actions theo capabilities; badge bảo vệ giữ nhỏ trong danh sách, lý do đầy đủ nằm trong dialog. ZIP giữ đường dẫn từ Root và Extract yêu cầu folder mới, được giải thích trước submit. Multi-upload/drop dùng từng request tuần tự, báo rõ phần thành công/thất bại. Operation state khóa controls liên quan và không được mô tả là một job nền có progress bytes nếu backend chỉ trả khi request hoàn tất.

Editor dùng textarea UTF-8 có Ctrl/Cmd+S, saved/dirty, line/byte stats và revision. Conflict giữ draft, Reload hỏi xác nhận, trạng thái running/busy/protected chuyển sang chỉ xem. Managed file nhận nội dung đã chuẩn hóa làm baseline đã lưu; draft mới hơn trong lúc Save vẫn được giữ. Binary/UTF-8 không hợp lệ dẫn tới download fallback. Đây là editor văn bản gọn; không có Monaco, syntax validation cho mọi format, folder upload trực tiếp, bulk delete hoặc hỗ trợ archive khác ZIP. Các chức năng này đã nối contract; bằng chứng browser 0.4.0 được ghi riêng trong [VERIFICATION.md](VERIFICATION.md).

Browser QA filesystem thật của 0.4.0 xác nhận multi-copy/rename/move, ZIP download/extract, stale Ctrl+S giữ draft và Reload qua popup panel, canonical content của server.properties, clipboard chỉ dán cùng server và upload nhiều tệp với thông báo phần thành công. Mobile 320 px có document/body cùng chiều rộng; editor tên file 244 bytes giữ title hai dòng và nút đóng nhìn thấy sau autofocus, không tràn ngang modal. Header tên server 64 ký tự được thử riêng bằng DOM synthetic. Các luồng này không chạy Bedrock; kết quả 89/89 tests và ảnh QA có phạm vi riêng tại VERIFICATION.
