# Sao lưu khi server đang chạy

Backup thủ công và backup theo lịch có thể thực hiện khi server Bedrock đang chạy và đã sẵn sàng. Người chơi tiếp tục kết nối bằng cùng tiến trình; panel không gửi lệnh dừng hoặc khởi động lại. Server đang khởi động, đang dừng hoặc có tác vụ quản lý khác cần hoàn tất trước khi sao lưu. Server đã dừng vẫn dùng quy trình sao lưu ZIP thông thường. Khôi phục bản sao lưu và cập nhật phiên bản vẫn yêu cầu dừng server.

## Mốc dữ liệu nhất quán

Panel dùng cơ chế được mô tả trong `bedrock_server_how_to.html` đi kèm gói Bedrock chính thức:

1. Gửi `save hold` để Bedrock chuẩn bị mốc dữ liệu.
2. Gửi `save query` cho đến khi Bedrock trả danh sách tệp cùng độ dài từng tệp.
3. Sao chép chính xác phần dữ liệu với độ dài đã xác nhận vào thư mục tạm riêng. Tệp ngắn hơn độ dài cam kết, đường dẫn không thuộc thế giới hiện tại hoặc danh sách không đầy đủ làm tác vụ thất bại.
4. Gửi `save resume` và nhận xác nhận trước khi sao chép các tài nguyên tĩnh còn lại và nén ZIP. Bảng dữ liệu không có trong danh sách không được đưa vào bản sao lưu.
5. Kiểm ZIP, CRC và SHA-256, rồi ghi bản sao lưu vào danh sách. Chính sách giữ lại bản cũ chỉ chạy sau khi bản mới được lưu thành công.

World assets, add-on, cấu hình và thư mục trống được giữ. Riêng database của thế giới đang chạy chỉ lấy các tệp thuộc mốc Bedrock đã xác nhận; phần ghi nối thêm sau độ dài cam kết không được đưa vào ZIP. Các thao tác quản lý qua panel bị khóa trong lúc sao lưu để tránh thay cấu hình hoặc dữ liệu đồng thời.

API chính thức mô tả cùng ba thao tác trong [LevelStorage](https://learn.microsoft.com/en-us/minecraft/creator/scriptapi/minecraft/server-admin/levelstorage?view=minecraft-bedrock-experimental). Cơ chế console của panel dùng lệnh native sẵn có, không cần cài script vào world và không tự bật cheats.

## Giới hạn và lỗi

Mỗi bản sao lưu tối đa 2 GiB dữ liệu chưa nén và 50.000 mục; phản hồi danh sách tệp native tối đa 8 MiB. Thời gian chờ chuẩn bị mốc là 60 giây. Panel tính dung lượng bản sao chép tạm và ZIP trước khi ghi: kiểm tra chỗ trống trong gói lưu trữ riêng, hoặc giữ chỗ trên máy chủ nếu chưa có gói riêng. Dữ liệu tạm được dọn khi tác vụ kết thúc; lỗi dọn được báo kèm đường dẫn cần kiểm tra. Sao lưu vẫn tiêu thụ ổ đĩa và CPU, nên tốc độ phụ thuộc tài nguyên máy chủ.

Sau khi đã gửi `save hold`, panel luôn cố gắng gửi `save resume` khi có lỗi hoặc khi dịch vụ đang tắt. Lệnh tiếp tục được thử lại nếu chưa nhận xác nhận; phản hồi đã bật lưu cũng được chấp nhận. Nếu vẫn không xác nhận được, tác vụ báo lỗi, không công bố một bản sao lưu mới và yêu cầu quản trị viên kiểm tra Console/gửi `save resume`. Panel không tự tiếp quản một mốc sao lưu đã được tạo bằng công cụ khác. Nếu tiến trình đã thoát, không gửi lệnh tiếp tục sang tiến trình khác.
