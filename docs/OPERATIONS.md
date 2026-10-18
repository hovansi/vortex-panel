# Vận hành Vortex Panel 0.15.5

Worlds, xác minh SHA-256/CRC, legacy baseline, protection khỏi retention và nhật ký theo ID được hướng dẫn trong [WORLDS](WORLDS.md). Full world/backup download yêu cầu quyền quản lý, gồm HEAD. Update/clone/backup giữ empty directory; cảnh báo dọn rollback sau khi đã commit không được báo như một activation thất bại.

Từ 0.5.0, giao diện mặc định English; người dùng chọn English/Tiếng Việt ở màn hình đăng nhập hoặc toolbar/Settings. Lựa chọn chỉ nằm trong browser và không đổi ngôn ngữ của dữ liệu server hay process Minecraft. Ngôn ngữ response được chọn riêng cho mỗi request/WebSocket; các client có thể dùng hai ngôn ngữ đồng thời. Đọc [I18N](I18N.md) trước khi bổ sung chuỗi mới.

## Cập nhật panel

Giải nén source mới vào một thư mục riêng, sau đó chạy `sudo bash deploy/install.sh`. Installer chuẩn bị dependency trước khi dừng dịch vụ, giữ các release cũ và chuyển symlink `current` sau khi cài xong. Readiness yêu cầu unit đang hoạt động và `processId` từ `/healthz` khớp `systemctl MainPID`, rồi kiểm tra lại PID/trạng thái sau phản hồi. Một panel khác trả đúng tên service trên cổng đó không đủ để chấp nhận release. Khi thất bại, installer khôi phục symlink, environment, unit và quyền sở hữu dữ liệu theo service trước đó. Dữ liệu world không được hoàn nguyên cùng source: muốn khôi phục dữ liệu phải dùng snapshot riêng.

Ownership được áp thẳng theo tài khoản của chế độ đích, chỉ đổi những entry có UID/GID khác. GNU `find -P` thu UID/GID và đường dẫn bằng record NUL, hoàn tất traversal trước khi thay đổi. Các entry được gom theo owner đã quan sát, tối đa 256 đường dẫn hoặc 32 KiB tên đường dẫn mỗi batch; `chown -h --from` kiểm tra lại owner trước khi đổi và một lượt traversal cuối xác minh toàn cây. Nếu owner đã đổi khiến `--from` bỏ qua entry, bước xác minh báo lỗi thay vì chấp nhận kết quả thiếu. Traversal không đi qua symlink, `chown -h` chỉ thay inode của link và không tạo process `stat` cho từng file. File immutable đã đúng owner được bỏ qua. File immutable cần đổi owner vẫn làm installer thất bại rõ ràng; installer không tự gỡ cờ bảo vệ. Rollback dùng cùng helper để khôi phục các entry đã đổi và bỏ qua file còn đúng owner cũ. Nếu khôi phục ownership hoặc restart cũng thất bại, giữ recovery path được báo và kiểm tra journal trước khi xử lý thủ công; không coi source rollback là bảo đảm service đã khởi động thành công.

Trên VPS thật, nâng root mode với marker immutable đúng owner đã thành công; chuyển sang service user với marker đó bị EPERM và tự rollback về dịch vụ root hoạt động, giữ cờ bảo vệ. Helper batching được kiểm tra riêng trên Linux với immutable, symlink, newline, group-only và thay owner trong lúc xử lý. Benchmark fixture 10.000 file/10.001 entry đo đổi owner **757,838 ms với 40 process chown**, khôi phục **742,224 ms với 40**, và no-op **67,094 ms với 0**. Các số này đo helper trên dữ liệu riêng, không gồm install dependency, stop/start service hoặc readiness và không phải lời hứa downtime của mọi deployment.

Các đường dẫn `bedrock-panel` của bản đầu được giữ lại để nâng cấp không tạo một thư mục dữ liệu hoặc dịch vụ thứ hai. Tên sản phẩm và gói source là Vortex Panel. Chạy installer không có cờ giữ chế độ root của một dịch vụ đã dùng root. `--root-mode` bật root rõ ràng; `--service-user` chuyển về tài khoản dịch vụ riêng và tắt terminal. Giữ một snapshot dữ liệu trước các lần nâng cấp quan trọng.

```bash
sudo systemctl status bedrock-panel
sudo journalctl -u bedrock-panel -n 100 --no-pager
curl --fail http://127.0.0.1:3000/healthz
```

## HTTPS bằng domain hoặc IP

Panel nên listen `127.0.0.1` phía sau NGINX. Với domain, thay hostname và đường dẫn chứng chỉ trong `deploy/nginx.conf.example`. Đặt `PUBLIC_URL=https://YOUR_DOMAIN` hoặc `https://YOUR_IP` và `TRUST_PROXY=1` trong environment của service; mở riêng TCP80/443 cho proxy. Template có `client_max_body_size 1025m` để gói phiên bản 1 GiB vẫn có chỗ cho multipart envelope; backend vẫn kiểm tra giới hạn file.

Let's Encrypt đã hỗ trợ IP công khai với profile short-lived, thời hạn 160 giờ. Webroot cho IP cần Certbot 5.4 trở lên. Lượt VPS này dùng Certbot 5.8, đã cấp và gia hạn chứng chỉ production tin cậy; staging/dry-run chỉ kiểm tra quy trình. [Chính sách chứng chỉ IP](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), [hướng dẫn Certbot](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

Trước lần cấp đầu, NGINX cần phục vụ HTTP80 cho `/.well-known/acme-challenge/` từ webroot đã chọn, không chuyển đường dẫn challenge sang một endpoint chưa hoạt động. Ví dụ dùng webroot `/var/www/letsencrypt`, rồi cấp chứng chỉ sau khi đã cài Certbot phù hợp:

```bash
sudo certbot certonly --preferred-profile shortlived \
  --webroot --webroot-path /var/www/letsencrypt \
  --ip-address YOUR_IP --cert-name vortex-ip
```

Cấu hình TLS đọc `/etc/letsencrypt/live/vortex-ip/fullchain.pem` và `privkey.pem`, chạy `nginx -t` trước khi reload. Tạo deploy hook để kiểm tra/reload NGINX sau renewal, xác nhận timer hoặc cron Certbot thực sự được bật, rồi thử:

```bash
sudo certbot renew --cert-name vortex-ip --dry-run
sudo systemctl list-timers --all
```

Đường dẫn binary phụ thuộc cách cài Certbot; nếu dùng virtualenv riêng, dùng chính binary đó trong lệnh và timer. Theo dõi lần chạy renewal, `notAfter` và HTTPS từ bên ngoài; lifetime ngắn cần cơ chế tự động hoạt động liên tục. Giữ private key trong vùng chỉ root đọc. NGINX HTTP/HTTPS không chuyển tiếp game UDP hoặc NetherNet signaling của từng server.

## Snapshot toàn bộ panel

Backup trong UI phục vụ một instance Bedrock. Để khôi phục cả panel, dùng snapshot dữ liệu bao gồm tài khoản, lịch, kho phiên bản, backup và world:

```bash
sudo bash deploy/backup-panel.sh /var/backups/vortex-mc
```

Script dừng dịch vụ đang chạy, đợi shutdown sạch, tạo archive với quyền `0600`, rồi bật lại nếu trước đó đang chạy. Đích phải là đường dẫn tuyệt đối đến thư mục riêng, không chứa hoặc nằm trong `DATA_DIR`. Nếu thư mục đã tồn tại, owner phải là root và quyền phải riêng tư, ví dụ `0700`; script không đổi quyền thư mục có sẵn. Các thư mục hệ thống bị từ chối. Nếu phát hiện khóa dữ liệu từ một tiến trình panel khác, script dừng để tránh snapshot khi dữ liệu đang thay đổi. Một khóa riêng giữ độc quyền dữ liệu trong lúc tạo archive. Lần chạy này tạo gián đoạn cho những server thuộc panel.

Archive chứa thông tin đăng nhập và khóa MFA; giữ archive ở vị trí chỉ quản trị viên được đọc, đồng thời sao chép ra host/storage khác. Script không áp dụng giới hạn backup world 2 GiB của UI. Theo dõi dung lượng trống và thời gian dừng đối với world lớn. Environment `/etc/bedrock-panel.env`, cấu hình HTTPS và chứng chỉ cần được lưu riêng theo cơ chế quản lý host của bạn.

## Khôi phục sau sự cố

1. Cài đúng release source trên Ubuntu bằng installer và dừng `bedrock-panel`.
2. Giữ nguyên thư mục dữ liệu hỏng dưới một tên khác để có thể quay lại; tạo thư mục `DATA_DIR` trống với quyền `0700`.
3. Khôi phục archive do chính script trên tạo vào thư mục dữ liệu mới. Không trộn với những world hoặc metadata hiện có. Khôi phục **`panel.json` và `.mfa-key` từ cùng snapshot**: khóa khác sẽ không giải mã được TOTP.
4. Đặt owner dữ liệu là `bedrock-panel:bedrock-panel` nếu chạy service user. Root mode vẫn đọc được thư mục này. Khôi phục environment, proxy và cổng game theo cấu hình host.
5. Khởi động dịch vụ, kiểm tra `/healthz`, đăng nhập, kiểm tra quyền tài khoản và các world trước khi mở truy cập cho người chơi.

Phiên đăng nhập và challenge MFA chỉ ở bộ nhớ, vì vậy cần đăng nhập lại sau restart hoặc restore. Mã TOTP yêu cầu đồng hồ hệ thống được đồng bộ; dùng mã khôi phục khi không còn thiết bị xác thực. Admin khác có thể reset MFA cho tài khoản cần trợ giúp, thao tác này được audit và thu hồi phiên của tài khoản đó.

Shutdown sạch ghi marker cho những instance trước đó đang chạy. Lần startup sau khởi động lại chúng, ngoài những instance có `autoStart=true`; instance cố ý dừng với `autoStart=false` vẫn dừng. Cơ chế này đã được kiểm tra qua restart/snapshot/reboot với trạng thái và identity riêng. Dừng các job dài trước bảo trì để tránh vượt deadline shutdown; chỉ lấy snapshot khi script đã giữ được khóa dữ liệu.

## Xóa server, backup và quarantine

Xóa instance yêu cầu đã dừng; xóa backup yêu cầu không có thao tác xung đột. Backend đổi tên dữ liệu vào vùng riêng cùng filesystem, lưu việc xóa metadata và audit trong một lần ghi, rồi mới dọn bytes. Nếu lưu thất bại trong process, backend đưa bytes về đường dẫn cũ và khôi phục bản ghi, lịch và ACL. Retention dùng cùng workflow cho từng archive cũ. Archive mới chỉ được đưa vào catalog qua audit `backup.create` sau khi ZIP hoàn tất; lỗi lưu sẽ giữ catalog cũ và dọn riêng file mới chưa được commit.

HTTP200 có `ok:true` kèm `warnings`/`cleanupPending` nghĩa là việc xóa đã được commit nhưng còn dữ liệu cách ly cần dọn. UI hiển thị cảnh báo này; activity ghi đường dẫn tương đối. Cảnh báo retention còn xuất hiện trong server log và job hoàn tất. Giữ các đường dẫn được báo để quản trị viên kiểm tra; retry delete không làm metadata đã xóa xuất hiện lại. Một bản ghi backup mất ZIP cũng có thể được xóa khỏi catalog mà không tác động dữ liệu khác.

Sau khi một backup mới đã commit, lỗi rotation không đổi kết quả tạo backup thành thất bại. Panel dừng dọn các bản tiếp theo, giữ bản mới/cũ, ghi cảnh báo và `retentionComplete:false`; số bản không khóa có thể vượt retention cho tới khi nguyên nhân được xử lý. Nếu chỉ việc ghi audit/trạng thái cuối lỗi sau một thao tác thành công, job vẫn completed với cảnh báo và flags lưu trạng thái. Cảnh báo cuối có thể chỉ ở RAM nếu filesystem tiếp tục không ghi được; đọc job/log và kiểm tra bytes/catalog trước khi lặp thao tác. Đây không phải cam kết journal/fsync qua mất điện.

Tên vùng cách ly giữ ID nguồn, ví dụ `servers/.vortex-delete-server-<serverId>-<nonce>` hoặc `servers/<serverId>/backups/.vortex-delete-backup-<backupId>.zip-<nonce>`. Đường dẫn, symlink và inode được kiểm tra trước rollback/dọn. Nếu cần xử lý thủ công, dừng service, giữ snapshot của dữ liệu hiện có rồi đối chiếu `panel.json`, audit và đường dẫn gốc:

- Bản ghi vẫn tồn tại, đường dẫn gốc mất và quarantine thuộc đúng ID: giữ quarantine để phục hồi bằng rename vào vị trí gốc còn trống.
- Bản ghi đã xóa cùng audit commit tương ứng: xác nhận đúng vùng dữ liệu trước khi dọn phần bytes còn lại.
- Job tạo backup báo một ZIP chưa được ghi vào catalog: giữ file và đường dẫn lỗi để kiểm tra/khôi phục; việc tạo backup chưa được chấp nhận vào catalog.

Đây là rollback cho lỗi quan sát được khi process còn chạy, chưa có journal để tự khôi phục sau mất điện giữa rename và commit. Khi nguồn/đích đều có dữ liệu hoặc chưa xác định được trạng thái commit, giữ cả hai để đối chiếu. Không chạy thao tác host khác lên cùng đường dẫn trong lúc panel đang xử lý.

## Kiểm tra một lỗi server

### Restore lỗi và rollback cũng không thành công

Nếu thay thư mục hoặc lưu metadata thất bại, panel thử đưa dữ liệu gốc về `run`. Nếu bước rollback cũng thất bại, panel giữ cả dữ liệu gốc và bản restore, ghi **hai nguyên nhân lỗi** và hai đường dẫn tương đối trong job/server error. Metadata có `restoreRecoveryRequired:{original,candidate,primaryError,rollbackError,backupId,createdAt}`; API server có `recoveryRequired:true`. Panel không tự khởi động instance đó, kể cả autoStart/resume, và chặn thao tác ghi world/file/clone/xóa để không làm mất bản phục hồi. Đọc log/metadata hoặc xác minh backup vẫn có thể thực hiện.

Quản trị viên cần phục hồi thủ công khi gặp trạng thái này:

1. Lấy snapshot toàn bộ dữ liệu bằng `deploy/backup-panel.sh`, giữ nguyên các thư mục được báo; dừng `bedrock-panel` trước khi thao tác. Đối chiếu ID server, record trong `panel.json` và đường dẫn dưới `DATA_DIR/servers/<id>/`; không đoán từ tên hiển thị.
2. Kiểm tra cả `original` và `candidate`. Để hủy lần restore lỗi, giữ candidate ở một thư mục recovery riêng và rename **original** về `run` đang trống, trên cùng filesystem. Không trộn hai cây, không ghi đè bản còn lại; giữ properties, identity và runtime của đúng instance.
3. Chỉ khi đã khôi phục và kiểm tra đúng `run`, sửa riêng record server đó trong `panel.json` khi service đang dừng: bỏ `restoreRecoveryRequired`, đặt `status:"stopped"`, `error:null`, tạm tắt autoStart và bỏ `resumeOnPanelStart`. Không đổi user/MFA/version/port/ID. Ghi JSON theo cơ chế atomic và giữ owner/mode hiện có.
4. Khởi động panel, kiểm tra cấu hình, rồi start instance có chủ đích và đọc log native. Chỉ dọn candidate/bản gốc dự phòng sau khi đã xác nhận dữ liệu và có snapshot ngoài VPS; có thể bật lại autoStart sau đó.

Recovery marker được lưu cùng trạng thái job khi filesystem cho phép. Nếu cả việc lưu trạng thái tiếp tục lỗi, phải giữ báo lỗi/job log và xử lý dung lượng/quyền trước; đây chưa phải journal chịu mất điện. Không xóa marker chỉ để làm nút Start hoạt động.

Mở workspace của đúng server, xem trạng thái và log lỗi, rồi kiểm tra Chẩn đoán host. Kiểm tra phiên bản Linux x86_64, thư viện Bedrock, dung lượng, RAM và các socket đang listen. Kiểm tra firewall/NAT theo transport: RakNet dùng UDP; NetherNet có TCP signaling và dải UDP. Mở cổng HTTP panel không tự mở cổng game.

Không sửa dữ liệu world đang được sử dụng hoặc restore khi server đang chạy. Backup Bedrock thủ công và theo lịch dùng `save hold/query/resume` khi tiến trình đã sẵn sàng, giữ nguyên PID và kết nối người chơi; server đã dừng dùng snapshot ZIP thông thường. Lỗi chuẩn bị snapshot không tự chuyển thành stop/start. Update vẫn cần dừng và tạo backup trước khi thay runtime; clone Bedrock tạo cổng và identity riêng, giữ world độc lập. Ứng dụng Node.js/Python cần dừng trước khi tạo/khôi phục backup và chưa hỗ trợ clone. Lần chuyển trạng thái hoặc tác vụ đang chạy có khóa để tránh hai thao tác ghi chồng nhau. Xem [sao lưu trực tuyến](ONLINE-BACKUPS.md) và [ứng dụng](applications.md).

## Đổi cổng và cấu hình

Dừng server rồi mở tab **Cấu hình**, nhóm **Mạng & kết nối**. RakNet dùng cổng UDP chính và IPv6; NetherNet dùng TCP signaling cùng dải UDP. Chế độ UDP tự động tính lại dải theo cổng chính và giới hạn người chơi; chế độ tùy chỉnh giữ ánh xạ NAT đã nhập. Nếu tệp được chỉnh ngoài panel có dải không hợp lệ, GET cấu hình vẫn trả cảnh báo để có thể sửa bằng chế độ tự động. Giao diện chỉ báo lưu thành công sau khi properties, metadata và audit được ghi; lỗi kiểm tra hoặc ghi sẽ giữ lại bản cũ và bản nháp trên màn hình.

Panel kiểm tra xung đột với instance khác và socket host trước khi đổi cổng. Sau khi lưu, sửa firewall/NAT bên ngoài panel, khởi động lại server và thử kết nối bằng client. Host khác có thể chiếm cổng sau thời điểm kiểm tra; nếu khởi động lỗi, xem log. Tắt LAN visibility là yêu cầu của chế độ nhiều server. Tên, tự chạy/tự phục hồi và retention trong panel có thể lưu khi server đang chạy; thuộc tính Bedrock yêu cầu dừng.

## Quản lý file

Mở tab **Tệp tin** của đúng server. Với Bedrock, file thường có thể xem/tải, tạo, sửa, upload, copy/move, đổi tên, xóa và xử lý ZIP khi server đang chạy và không có tác vụ xung đột. Dữ liệu world đang được sử dụng và tệp hệ thống được bảo vệ vẫn có giới hạn riêng; dùng Backup để sao chép nhất quán world đang chạy. Quyền Can thiệp mạnh dành cho Admin có xác thực lại, hết hạn sau 10 phút và không vượt khóa world đang chạy, kiểm tra đường dẫn hoặc symlink. Với ứng dụng Node.js/Python, phải dừng trước khi duyệt, đọc, tải hoặc sửa workspace. Viewer chỉ xem/tải theo scope đã cấp; badge bảo vệ và menu thao tác cho biết lý do một mục không được sửa. Một thư mục có thể chứa file con được bảo vệ, nên backend kiểm tra toàn bộ cây trước khi thực hiện.

Tìm theo tên trong thư mục đang mở, sắp xếp theo tên/kích thước/thời gian/loại và chọn nhiều mục bằng checkbox. API trả toàn bộ metadata của thư mục; bảng hiển thị 100 mục/trang và tìm/sắp xếp trên toàn bộ collection. Chọn tất cả áp dụng cho trang hiện tại; selection được giữ qua các trang/bộ lọc và tối đa 1.000 nguồn. Thanh selection ghi các mục nằm ngoài trang hoặc bộ lọc hiện tại. Kiểm tra danh sách nguồn trước thao tác. Copy/Cut/Paste chỉ dùng trong cùng một instance; clipboard ghi máy chủ nguồn khi bạn chuyển workspace.

Đích copy/move theo batch là thư mục đã tồn tại, chọn bằng picker hoặc nhập đường dẫn tính từ Root; để trống là Root. Mỗi nguồn giữ basename tại đích. Đổi tên riêng dùng tên/path mới đầy đủ và yêu cầu thư mục cha tồn tại. Panel trả conflict thay vì ghi đè đích có sẵn. File mới và upload cũng không ghi đè; muốn thay nội dung văn bản, mở editor và Save với revision hiện hành. Upload nhiều tệp/drop được gửi tuần tự; tệp thành công vẫn được giữ khi một tệp khác lỗi, giao diện báo tổng thành công/thất bại. Không có folder upload trực tiếp.

Editor hỗ trợ UTF-8 tối đa 2 MiB, Ctrl/Cmd+S, trạng thái saved/dirty và số dòng/bytes. Nếu phiên khác sửa file, Save trả conflict và giữ bản nháp. Tải bản trên máy chủ sẽ hỏi xác nhận bỏ draft; nếu file đã bị xóa, Save không tạo lại file đó. File binary hoặc không phải UTF-8 chỉ tải xuống để xử lý bằng công cụ phù hợp. Những tệp thuộc Cấu hình/Người chơi đi qua validator và có thể được chuẩn hóa; editor nhận lại nội dung thực đã lưu. Properties được merge để giữ khóa hiện có: bỏ một dòng khỏi bản nháp không xóa khóa đó. Tệp identity/runtime/pack chỉ xem. Muốn chuyển/xóa root world hiện tại, chọn world khác bằng `level-name` trước và giữ backup.

Nén vùng chọn thành một ZIP mới. ZIP giữ đường dẫn từ Root: chọn `notes/a.txt` sẽ lưu entry `notes/a.txt`, cùng các thư mục rỗng được chọn. Giải nén luôn vào **thư mục mới**; ví dụ đích `imports/notes` tạo `imports/notes/notes/a.txt`, không bỏ prefix hoặc trộn vào dữ liệu hiện có. Parent `imports` cần có sẵn. Dùng công cụ Phiên bản cho BDS runtime, Add-ons cho pack và Backup restore khi thay world hiện có; generic ZIP extraction không thay các workflow này.

Giới hạn file operations: 1–1.000 nguồn được chọn, tổng 2 GiB/50.000 mục, ZIP đầu vào không quá 2 GiB và editor không quá 2 MiB; mỗi upload không quá 100 MiB. Khi giải nén, quota số mục tính cả thư mục cha ngầm định, kể cả archive không có entry riêng cho chúng. Path mutation tối đa 1.024 bytes UTF-8, mỗi thành phần tối đa 255 bytes, không dùng absolute/traversal/symlink/tệp đặc biệt hoặc tên không tương thích filesystem. CRC32/size được kiểm tra khi unzip, nhưng không xác nhận tác giả archive. Nén/copy tạo staging nên cần dung lượng trống cho bản sao và ZIP tạm ngoài dữ liệu gốc.

Thao tác có rollback cho lỗi activation/audit quan sát được trong process, chưa có journal để bảo đảm transaction nhiều file sau mất điện. Nếu rollback cũng lỗi, giữ các đường dẫn recovery được báo và đối chiếu nguồn/đích trước khi dọn staging; staging có thể chứa bản cũ cần khôi phục. Không chỉnh cùng file bằng công cụ host bên ngoài trong khi panel đang xử lý. ZIP do demo tạo là snapshot mô phỏng, không tải được như ZIP thật; demo chỉ giải nén snapshot được tạo bởi công cụ mô phỏng của nó.

## Cài add-on cho world

Dừng instance rồi mở tab **Add-ons** trong workspace. Nhập `.mcpack` hoặc `.mcaddon` có manifest v2 dùng module dữ liệu/resource, kiểm tra thông tin manifest và bật pack. Panel tự bật các phụ thuộc UUID đúng version; thiếu hoặc không tương thích sẽ báo lỗi. World được chọn trong `level-name` phải đã tồn tại; panel không tạo world giả chỉ để ghi pack references. Nếu chưa có world, cho Bedrock tạo world qua một lần khởi động bình thường rồi dừng lại trước khi bật pack.

Pack mới chưa được bật ngay sau import. Khởi động server sau khi cấu hình xong để Bedrock tải nội dung; kiểm tra log và client thực tế. Panel không tự bật experiments hoặc Script API. Nếu pack cần những khả năng chưa hỗ trợ, xem hướng dẫn của tác giả và manual Mojang thay vì ép manifest qua kiểm tra. Tắt pack phụ thuộc trước khi tắt pack mà nó yêu cầu. Xóa pack gỡ cả tham chiếu ở những world khác thuộc instance, nên tạo backup trước khi thay đổi một bộ pack đang sử dụng.

Gói nhập được lưu dưới thư mục riêng, không ghi đè pack có UUID đã tồn tại. Khi cần nâng cấp cùng UUID, giữ backup và kế hoạch thay thế; manager hiện chưa có workflow nâng version pack tự động. World backup gồm pack dữ liệu/resource của instance, vì vậy restore có thể thay cả cấu hình pack.

Các pack đi kèm gói Bedrock được nhóm riêng dưới **Pack có sẵn trong Bedrock**, có thể thu gọn. Chúng được bảo vệ khỏi xóa và thay theo runtime update; subset của panel không bao phủ mọi module/manifest Mojang sử dụng. Xem manifest chọn đúng thư mục ngay cả khi nhiều pack chia sẻ UUID. Nếu panel không cho bật một pack có sẵn, kiểm tra lý do và manual của gói; thông báo đó không kết luận nội dung vanilla không hợp lệ với Minecraft.

## Ranh giới triển khai hiện tại

Vortex Panel quản lý host chính và các VPS worker liên kết; runtime, world và backup nằm trên host được chọn. RBAC giới hạn API/HTTP/WebSocket. CPU/RAM cố định dùng cgroup v2 khi host có delegation và capability phù hợp; đây là trần sử dụng, không phải tài nguyên được đặt riêng. Chế độ dùng chung không có trần riêng cho từng instance và chịu giới hạn pool/tổ tiên; chế độ cố định không âm thầm chuyển sang dùng chung khi enforcement thất bại. Lưu trữ cố định dùng image ext4 cấp phát trước, còn thư mục legacy không có quota riêng.

Bedrock chạy native, không có container riêng để cô lập các khách hàng. Ứng dụng Node.js/Python dùng tài khoản non-root riêng và sandbox Bubblewrap với namespace đã kiểm chứng, nhưng vẫn chia sẻ mạng host; sandbox không phải chính sách cô lập mạng. Chỉ tạo/chạy ứng dụng khi host báo đủ capability, không có fallback chạy ứng dụng bằng root. Xem [tài nguyên](RESOURCE-CONTROL.md), [ứng dụng](applications.md), [Nodes](NODES.md) và [so sánh](COMPETITIVE.md).

Lượt nghiệm thu ngày 14/10/2026 đã chạy installer, service-user/root-mode và rollback, chứng chỉ HTTPS IP/renewal, snapshot/restore và reboot trên Ubuntu 24.04.5. BDS Stable/Preview, lệnh console, function add-on và world LevelDB được kiểm chứng bằng process/file/phản hồi native. Lỗi ENOSPC/EPERM được gây trên bản sao riêng để xác nhận rollback và cảnh báo cleanup. Phạm vi và phần còn cần tài khoản/client Minecraft hợp lệ nằm trong [nghiệm thu VPS](VPS-ACCEPTANCE.md); số unit/browser cuối ở [VERIFICATION](VERIFICATION.md).
