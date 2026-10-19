# Quản lý world và phục hồi trong Vortex Panel

Tab **Worlds** nằm trong workspace từng server. Tên trên thẻ có thể lấy từ metadata của Minecraft; tên thư mục được hiển thị riêng và là định danh dùng để chọn, xuất hoặc xóa. Panel không đổi tên world do người dùng đặt khi chuyển English/Tiếng Việt.

## Chọn và tạo

Dừng server trước khi đổi world. **Use world** cập nhật `level-name` qua cùng giao dịch cấu hình, giữ cổng và identity. World hiện tại vẫn còn trên đĩa. **New world** nhận tên thư mục mới và seed dạng chuỗi, chỉ lưu cấu hình; trạng thái **Pending generation** nghĩa là chưa có database. Bedrock tạo database ở lần khởi động tiếp theo. Tên trùng bị từ chối và seed không được dùng để viết lại database hiện có.

**Ready** nghĩa là metadata và bố cục thư mục đã qua kiểm tra cấu trúc; không chứng nhận mọi bảng LevelDB khỏe hoặc world chơi được. Khi Bedrock đang ghi dữ liệu, panel có thể báo **Data is changing** và cho tải lại; trạng thái này khác lỗi định dạng. Khởi động bằng đúng BDS rồi đọc log native là bước kiểm chứng tiếp theo. Xác nhận người chơi đăng nhập và gameplay cần client Minecraft hợp lệ.

## Nhập và xuất

**Import world** nhận một `.mcworld` hoặc ZIP chứa một world Bedrock ở gốc, hoặc trong một thư mục bọc duy nhất. Chọn tên thư mục mới. Upload được chuyển thành tệp do job sở hữu trước khi request kết thúc; panel giải nén vào staging, kiểm tra rồi rename. Import không tự chọn hoặc khởi động world, không trộn dữ liệu và không ghi đè tên có sẵn.

Giới hạn: archive nén 1 GiB, tổng giải nén 2 GiB, 50.000 entry và tối đa 100 world mỗi server. Panel kiểm CRC, đường dẫn, loại entry, symlink, một root world duy nhất, header/body NBT và bố cục LevelDB. Gzip `level.dat` của Java, archive có nhiều world, identity/server configuration và tệp không hỗ trợ bị từ chối. Không sử dụng thông báo kiểm cấu trúc thay cho kiểm chứng native.

World có embedded resource/behavior packs được giữ cùng registration nếu thuộc subset được hỗ trợ: manifest v2, data/resources/script JavaScript, dependency UUID và version đúng, hoặc API `@minecraft/*` có version cụ thể. Script entry phải là tệp `.js` hợp lệ nằm trong pack; Bedrock quyết định API đó có chạy trên bản engine đang dùng hay không. Manifest v3, pack mã hóa, dependency chưa đủ hoặc pack yêu cầu engine mới hơn bị từ chối rõ ràng; panel không âm thầm bỏ pack. World metadata có version là thông tin đối chiếu, không chứng nhận downgrade database an toàn. Xem [Add-ons API](API.md#bedrock-add-ons).

**Export** dùng được khi server đã dừng hoặc Bedrock đang chạy, đã sẵn sàng và không có tác vụ khác. World đang chạy được chụp qua `save hold/query/resume`: chỉ sao chép danh sách tệp và số byte native xác nhận, cho phép lưu tiếp trước khi nén, giữ nguyên tiến trình và kết nối. Không có mốc hợp lệ thì xuất thất bại; panel không tự dừng hoặc khởi động lại để thay thế quy trình. World không được chọn dùng bản sao trên đĩa đã kiểm tra.

Nội dung world nằm ngay tại gốc `.mcworld`, gồm empty directory; không bọc thêm `worlds/<name>`. Các resource/behavior pack toàn instance mà world đang tham chiếu được nhúng vào bản xuất, giữ nguyên thứ tự registration và kiểm lại dependency độc lập với thư viện trên VPS. Tệp identity, cấu hình server và world khác không vào bản xuất. HEAD chỉ kiểm điều kiện, không tạo ZIP hoặc gửi lệnh lưu. GET tạo artifact tạm và dọn sau khi response hoàn tất hoặc hủy. Viewer xem metadata nhưng không xuất toàn bộ world; Admin hoặc Operator được cấp server mới được tải archive chứa database người chơi.

Nhập world mới không tự chọn, xuất world và xóa world không được chọn có thể làm khi Bedrock đang chạy, đã sẵn sàng. Đổi world được chọn và tạo world mới để chạy vẫn cần dừng server. Đọc [giới hạn snapshot online](ONLINE-BACKUPS.md).

## Luật, add-on và tính năng thử nghiệm

Luật như tọa độ và giữ đồ được Bedrock lưu trong world, không cần bật lại sau khi restart bình thường. Tab luật tự đọc trạng thái native khi server sẵn sàng; khi đã dừng, chỉ hiển thị giá trị NBT hợp lệ đã lưu và khóa chỉnh sửa. Chưa đọc được khác với OFF; panel không áp giá trị của world cũ sang world khác.

Tab Add-ons vẫn xem được pack, registration và cấu hình được ghi nhận ở lần khởi động khi server đang chạy. Có thể nhập pack mới vào thư viện; pack chưa tự được kích hoạt hoặc hot-load. Thứ tự ưu tiên tách riêng **Behavior** và **Resource**, trên cùng ưu tiên cao nhất. Kích hoạt, tắt và đổi thứ tự cần dừng server để thay registration an toàn. Chỉ xóa online pack tùy chỉnh chưa dùng khi xác minh UUID không có trong snapshot lúc khởi động của tiến trình sẵn sàng, mọi registration world hợp lệ và các pack phụ thuộc đang bật; không ghi lại registration JSON. Pack được bảo vệ, đang tải/đăng ký hoặc chưa xác minh được vẫn bị chặn. Thông tin cấu hình không bảo đảm pack/script tải thành công; xem content log native.

Mục tính năng thử nghiệm hiển thị flag có trong world/runtime đang cài. Chỉnh sửa cần dừng server, revision khớp và bản backup đã kiểm toàn vẹn được tạo trước khi ghi. Bật thử nghiệm cần xác nhận; panel không tự bật Beta APIs khi nhập pack yêu cầu API beta. Cờ không nhận diện và dấu vết từng dùng thử nghiệm được giữ nguyên. Tắt toggle không bảo đảm đảo ngược dữ liệu hoặc khả năng tương thích đã thay đổi.

## Xóa

Chỉ xóa world không đang được chọn hoặc đang được tiến trình sử dụng; có thể xóa world khác khi Bedrock đang chạy và sẵn sàng. Popup yêu cầu nhập đúng tên thư mục. Dữ liệu được rename vào quarantine cùng filesystem, audit được commit, rồi mới dọn bytes. Lỗi lưu metadata khôi phục đường dẫn cũ; lỗi dọn sau commit trả cảnh báo với recovery path. Đây là recovery cho lỗi quan sát được trong process, chưa có journal cho mất điện giữa rename và commit. Các thao tác filesystem ngoài panel không dùng lock của panel.

## Backup đáng tin hơn

Backup mới ghi SHA-256 sau khi ZIP hoàn tất và kiểm CRC/path/size trước khi đưa vào catalog. UI hiển thị version, lý do tạo, dung lượng, thời gian kiểm tra và nguồn checksum. **Verified** xác nhận archive khớp bytes khi panel tạo; không thay thế kiểm chứng database hoặc storage độc lập.

Backup cũ thiếu SHA-256 được giữ nguyên và ghi **Legacy**. Chạy **Verify** để thiết lập checksum hiện tại trước khi restore. **Baseline established** chỉ xác nhận bytes ở lần kiểm tra đó, không chứng minh archive chưa từng thay đổi trước khi có checksum. Nếu hash không khớp, verify/restore/download báo lỗi và giữ artifact để quản trị viên kiểm tra. Restore kiểm lại bytes trước khi thay live directory và giữ mạng/identity của instance.

**Protect** chặn xóa thủ công và loại snapshot khỏi retention. Mỗi server giữ tối đa 50 bản protected; retention 1–50 tính riêng các bản không protected. Khi vượt số được giữ, rotation chỉ xóa bản không protected sau khi backup mới đã commit. Protected tăng dung lượng lưu trữ thực; vẫn cần backup ra ngoài VPS. Tạo, verify và đổi protection có thể thực hiện khi server đang chạy và không có tác vụ khác. Backup thủ công và theo lịch giữ nguyên tiến trình và kết nối người chơi; restore vẫn cần dừng server để thay dữ liệu an toàn.

Khi sao lưu server đang chạy, panel yêu cầu Bedrock chuẩn bị một mốc dữ liệu, sao chép đúng danh sách tệp và số byte mà Bedrock xác nhận, rồi cho phép lưu tiếp trước khi nén ZIP. Bảng dữ liệu cũ không nằm trong danh sách được bỏ qua; cấu hình, add-on và thư mục trống vẫn được giữ. Nếu không nhận được mốc dữ liệu hợp lệ, panel báo lỗi và không tạo bản sao lưu trong danh sách. Xem [sao lưu trực tuyến](ONLINE-BACKUPS.md) để biết giới hạn và xử lý lỗi.

Viewer chỉ đọc thông tin backup. Tải, verify, protect, restore và delete cần quyền manage trên đúng server. ZIP backup có thể chứa identity riêng, nên quyền đọc console không cấp quyền tải backup.

Files vẫn cho Viewer đọc file thông thường theo scope; không gọi Viewer là metadata-only cho toàn panel. Các đường đọc/download identity `keys/` và `server_identity_key.pem` được chặn cả GET/HEAD, với capabilities và lý do EN/VI trên listing. Nội dung bí mật trong file tự tạo cần chính sách quyền phù hợp; panel không tự quét mọi file để phát hiện secret.

Nhật ký trong workspace dùng `serverId` bất biến. Rename hoặc hai server cùng tên không trộn lịch sử. Record cũ chưa có ID được giữ trong nhật ký toàn panel của Admin; panel không đoán ID từ tên hoặc command.

When importing a portable export back onto its original host, an embedded pack is reused from the global library only if its complete tree, manifest, files and empty directories match exactly. The import reports `reusedGlobalPacks` and preserves pack registration order. Conflicting or ambiguous UUIDs are rejected; installed packs are never overwritten.
