# Vortex Panel · Node agent

Node là dịch vụ điều khiển Minecraft Bedrock, ứng dụng Node.js và Python trên một VPS riêng. Panel trung tâm giữ tài khoản, quyền và danh sách kết nối; mỗi node giữ runtime, world, backup, lịch và tiến trình của chính nó. Mất kết nối hoặc dừng panel trung tâm không gửi lệnh dừng node. Dừng/restart `vortex-node.service` mới thực hiện shutdown sạch các instance tại node, theo cơ chế resume/autostart hiện có.

VPS liên kết chỉ cung cấp tài nguyên chạy server. Gói tự cài từ panel và bản cài thủ công chỉ chép các tệp trong `server/node-runtime.js`: có API điều khiển được xác thực và thư viện Bedrock, không có trang panel, mã đăng nhập, thiết lập tài khoản hay chương trình khởi chạy panel. Chỉ VPS chạy panel chính giữ lại 10% ngân sách CPU/RAM/ổ đĩa. VPS liên kết không giữ lại tỷ lệ 10%; vẫn kiểm tra tài nguyên thực tế, dung lượng đang dùng và ngăn khởi chạy khi RAM trống thấp nghiêm trọng. Giới hạn của nhà cung cấp VPS vẫn được tôn trọng.

## Cài riêng trên Ubuntu

Yêu cầu Ubuntu 22.04 trở lên, x86-64 hoặc ARM64 (`aarch64`), userspace 64-bit đúng kiến trúc, Node.js 22 trở lên và quyền sudo. Installer cài Node 22 từ nodejs.org nếu cần, đối chiếu SHA-256 archive, chuẩn bị dependency trước khi đổi dịch vụ.

Agent và ứng dụng Node.js/Python chạy trực tiếp trên cả hai kiến trúc. Trên ARM64 dùng trang bộ nhớ 4 KiB, bộ cài agent tự chuẩn bị Box64 riêng để chạy Bedrock Linux x86-64 chính thức. Cần tối thiểu 1 GiB RAM đang khả dụng và 2 GiB đĩa trống khi chuẩn bị. Agent ARM64 cũ cần chạy lại bộ cài đầy đủ một lần; cập nhật source không tự cài dependency hệ thống. Từ source đã giải nén:

Installer chuẩn bị các thư viện chạy Bedrock, công cụ tải/giải nén, mạng và theo dõi tiến trình, quản lý lưu trữ, UFW và bộ đếm mạng. Mọi công cụ bắt buộc được kiểm tra trước khi chuyển sang bản dịch vụ mới; chờ khóa trình cài gói tối đa 120 giây khi hệ điều hành đang cập nhật. Dịch vụ có tự khởi động lại khi lỗi, giới hạn tệp mở 65.536 và thống kê CPU/RAM/I/O. Việc cài đặt không tự bật hay đặt lại firewall và không thay đổi thông số nhân toàn hệ thống trên VPS đang sử dụng.

```bash
sudo bash deploy/install-node.sh --endpoint https://YOUR_VPS_IP:8443
```

Node dùng `/opt/vortex-node`, `/var/lib/vortex-node`, `/etc/vortex-node.json`, `/etc/vortex-node/tls.key`, `/etc/vortex-node/tls.crt` và unit `vortex-node.service`. Các đường dẫn/unit/data của panel được giữ riêng. Cài lại giữ config, token, node UUID và dữ liệu; source cũ được giữ trong `releases`. Lỗi readiness khôi phục symlink/unit trước đó rồi khởi động lại nếu node cũ đang hoạt động. Source rollback không hoàn nguyên thay đổi world hay format metadata; cần snapshot dữ liệu riêng trước nâng cấp quan trọng.

Installer chạy node dưới **root**, `UMask=0077`, `Delegate=cpu memory`, cổng HTTPS mặc định **8443** trên `0.0.0.0`. Root cho phép quản lý runtime/cgroup trên VPS; đây không phải cô lập process Minecraft/pack bằng container. Agent không cung cấp host terminal, đăng nhập browser hoặc trang UI. Không mở API node cho browser người dùng; giới hạn firewall TCP8443 tới địa chỉ panel trung tâm. Cổng game TCP/UDP của từng instance vẫn phải mở riêng.

Installer 0.14.1 chuẩn bị mô-đun hỗ trợ bộ nhớ cho đúng kernel đang chạy khi cần và khi kho Ubuntu có gói tương ứng. Nó kiểm tra trước bằng chế độ dry-run và ghim đúng phiên bản `linux-modules-extra-<kernel>`. Chỉ khi metadata của gói yêu cầu `wireless-regdb` và gói phụ thuộc này chưa được cài, installer mới ghim thêm phiên bản tương ứng. Giao dịch gói đang dang dở, nâng cấp/xóa gói đã có hoặc thay đổi gói khác đều bị từ chối. Thiếu gói hoặc lỗi chuẩn bị không làm hỏng cài đặt agent đang hoạt động; tính năng sẽ báo chưa khả dụng. Bước này không nạp mô-đun, đổi kernel, reboot hoặc tự bật hỗ trợ bộ nhớ.

Chứng chỉ self-signed RSA được tạo khi cài lần đầu, thời hạn 365 ngày. Không cần domain khi panel dùng fingerprint SHA-256 chính xác. Installer cố ý in connection record riêng tại terminal, gồm endpoint/token/fingerprint/agentId; không chia sẻ record đó, chụp màn hình hoặc đưa vào source. Nếu không truyền `--endpoint`, installer đề xuất địa chỉ IPv4 của interface: cần đối chiếu IP public/NAT trước khi thêm node.

```bash
sudo systemctl status vortex-node
sudo journalctl -u vortex-node -n 100 --no-pager
sudo node /opt/vortex-node/current/server/node-cli.js check
# Lệnh dưới cố ý hiển thị token; chỉ chạy tại terminal riêng của quản trị viên.
sudo node /opt/vortex-node/current/server/node-cli.js show-connection --endpoint https://YOUR_VPS_IP:8443
```

Readiness dùng token đọc từ config riêng, certificate pin, node UUID và PID thực rồi đối chiếu `systemctl MainPID` trước/sau request. Token không xuất hiện trong argv của request, HTTP response, log khởi động hay lệnh `check`.

## Config và thay token/chứng chỉ

Config JSON là file thường, không symlink/hardlink và có quyền `0600`; private key cũng cần quyền riêng. CLI từ chối config/private key cho phép group/other đọc trên POSIX. Không trỏ `dataDir` về, chứa hoặc nằm dưới `/var/lib/vortex-panel` (hoặc đường dẫn cũ `/var/lib/bedrock-panel`); agent từ chối ancestor symlink, thư mục không liên quan đã có dữ liệu, directory cho group/other ghi và store có tài khoản panel. File config chứa `schemaVersion:1`, `nodeId`, `token`, `dataDir`, `host`, `port` và `tls:{certFile,keyFile}`. Không chỉnh UUID sau khi panel đã bind identity.

```bash
sudo node /opt/vortex-node/current/server/node-cli.js rotate-token
sudo systemctl restart vortex-node
sudo node /opt/vortex-node/current/server/node-cli.js show-connection --endpoint https://YOUR_VPS_IP:8443
```

Rotation ghi config mới nguyên tử và giữ UUID/data. Tiến trình đang chạy dùng token cũ đến khi restart; cập nhật token tương ứng trong panel. Đổi certificate sẽ đổi fingerprint, cần đối chiếu tại terminal node rồi cập nhật pin tường minh. Không tự chấp nhận certificate mới từ lỗi kết nối.

Backup node phải bao gồm toàn bộ data, config và TLS key/certificate trong nơi riêng có quyền hạn chế. Snapshot filesystem khi Bedrock đang ghi không thay cho stop/wait/snapshot. CLI `initialize` tạo identity/token một lần, không ghi đè config có sẵn. `--http-loopback --host 127.0.0.1` chỉ dành local integration/SSH tunnel; public HTTP và alias `localhost` bị từ chối.

## Giao thức điều khiển

Mọi `/api` cần `Authorization: Bearer <token>`; so khớp digest bằng constant-time compare. Request chưa xác thực bị chặn trước JSON/multipart parsing. Response API đã xác thực, kể cả lỗi/download/SSE, có `X-Vortex-Node-Id`; panel phải kiểm tra UUID đã bind trước khi dùng dữ liệu. Không chuyển cookie, Authorization browser hay hop-by-hop headers sang node.

| Endpoint | Nội dung |
| --- | --- |
| GET `/api/node/identity` | `{service:'vortex-node',protocol:1,nodeId,version,processId}` |
| GET `/api/node/snapshot` | Dashboard bounded hiện có cùng schedules, nodeId/version/service/protocol; chỉ service/admin |
| GET `/api/node/events` | SSE `data: <JSON>`, initial update, raw server UUID; keepalive 15 giây, lease 5 phút để panel reconnect |
| `/api/servers`, `/api/versions`, `/api/jobs`, `/api/schedules` và routes liên quan | Dùng backend manager/router hiện có, runtime và data ở node |

SSE giới hạn mỗi event 64 KiB; event lớn chuyển thành update để refetch. Client có buffer trên 1 MiB bị ngắt. Kết nối panel ngắt chỉ đóng stream, không dừng server. Agent shutdown đóng stream/request và manager trước khi nhả data lock. Không có `/api/auth`, `/api/host`, UI hoặc WebSocket browser tại agent.

Gỡ worker0.14 dùng GET `/api/node/uninstall/plan`, POST `/api/node/uninstall/prepare` và `/abort`, đều chỉ dành cho Admin của control plane đã xác thực. Prepare nhận `{nodeId,revision,requestId,confirmed:true}`, kiểm tra lại inventory rỗng, khóa tác vụ mới và lưu ý định gỡ trước khi trả kết quả. Khởi động lại agent giữ khóa của ý định chưa giải quyết. Abort chỉ nhả khóa khi helper xác minh dịch vụ còn nguyên và chưa có lượt dọn đang giữ khóa hệ điều hành. Controller dùng SSH root có fingerprint đã xác nhận để chạy helper độc lập và kiểm chứng kết quả sau khi worker đã tắt. Không xem mất kết nối hoặc202 là bằng chứng gỡ xong; không xóa world hoặc dữ liệu của panel cũ riêng biệt.

Panel chuyển actor đã xác thực qua `X-Vortex-Actor`: base64url JSON `{id,username,role,allServers,serverIds}`. Node áp đúng role và raw server UUID của actor qua middleware hiện có, bao gồm Viewer read-only/private identity/export protection; audit dùng username gốc. Không có actor header nghĩa là credential control plane quản trị node, dùng cho inventory/event subscription. Người giữ token có thể tự gửi actor/admin hoặc bỏ header: token là quyền điều khiển node đầy đủ, không phải token dùng cho người chơi. Panel vẫn phải kiểm RBAC trước proxy và lọc event từng user.

Node giữ raw UUID. Panel trung tâm định danh tài nguyên remote bằng composite `<central-node-UUID>:<raw-agent-UUID>`, tránh trùng UUID giữa các node. Không đổi UUID trong store/world tại node.

## Transport và giới hạn kết nối

`requestNode` chỉ nhận origin HTTPS, hoặc literal HTTP `127.0.0.1`/`[::1]`; không credentials/path/query/fragment trong endpoint, không theo redirect. HTTPS không pin dùng CA và hostname chuẩn; có pin thì đối chiếu certificate DER SHA-256 cùng khoảng hiệu lực. TLS handshake/pin hoàn tất **trước khi tạo HTTP request có Bearer hoặc đọc stream upload**. Pin explicit là trust cho đúng certificate đó, không cần certificate public-CA hoặc domain. Mỗi request dùng một socket riêng, không dùng lại socket chưa xác minh.

JSON trả parsed body; lỗi HTTP không thành công giữ status/body. `stream:true` trả `{statusCode,status,headers,stream}`, kể cả status lỗi để proxy giữ phản hồi gốc. Caller cần abort/destroy khi browser ngắt và kiểm `X-Vortex-Node-Id` trước pipe. Mặc định JSON 8 MiB, stream 2 GiB +2 MiB và deadline 30 giây; caller có thể đặt cap/deadline phù hợp với upload/SSE, tối đa 4 GiB/15 phút. Timeout không chứng minh mutation chưa chạy: không tự retry thao tác ghi hoặc tạo server/job.

Nguồn kỹ thuật: [Node.js TLS](https://nodejs.org/docs/latest-v22.x/api/tls.html), [HTTP agent/custom connection](https://nodejs.org/docs/latest-v22.x/api/http.html), [systemd resource delegation](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#Delegate=).

## Kiểm tra và áp dụng cổng game qua UFW

Admin có thể xem `GET /api/servers/:id/network-access`, rồi áp dụng bằng `POST` cùng đường dẫn với `{revision,confirmed:true}`. Có thể thực hiện khi game đang chạy vì đây là thay đổi UFW, không sửa cấu hình Bedrock. Revision gắn cả cấu hình mạng server lẫn rule UFW quan sát được; cấu hình hoặc rule đổi sau preview thì cần kiểm tra lại. Tiến trình không phải Linux root, UFW không có hoặc không đọc được an toàn không được thay đổi firewall. UFW inactive giữ nguyên inactive; panel không enable/reset/đổi default policy.

RakNet dùng UDP cổng chính ở IPv4 và UDP cổng v6 ở IPv6. NetherNet dùng TCP signaling cổng chính và UDP nội bộ từ `server-udp-ports` ở cả hai family; ánh xạ NAT dùng các cổng internal. Cổng `server-portv6` riêng không được mở cho NetherNet; debugger không được mở. Dải liên tiếp được gộp, không mở toàn bộ dải cổng khác hoặc cổng agent.

Rule của Vortex có comment gồm hash thư mục data cùng UUID server. Một agent/panel khác trên cùng host, kể cả trùng UUID server, không có cùng namespace để xóa rule của nhau. UFW rule tương đương do người quản trị/công cụ khác tạo được giữ nguyên và báo `covered`. Thêm rule dùng `prepend` để chọn vị trí đầu riêng trong đúng family và giữ hành vi bỏ qua tuple đã tồn tại; `insert 1` dùng số thứ tự gộp IPv4/IPv6 nên không hợp lệ cho IPv6 khi đã có rule IPv4. UFW có thể thay action/comment khi dùng lệnh `allow` thông thường cho tuple đã tồn tại. Xóa dùng đặc tả rule đầy đủ cùng comment owner không rỗng, không dùng số thứ tự rule. Các rule cần mới được xác nhận trước khi xóa rule Vortex đã lỗi thời, kể cả khi thu hẹp dải UDP.

`DELETE /api/servers/:id/network-access` với cùng confirmation/revision chỉ gỡ các rule Vortex thuộc server/scope đó, gồm rule cũ. Nó không cam kết đóng cổng: rule foreign có thể vẫn cho phép truy cập. Nên gỡ rule Vortex bằng công cụ này trước khi xóa server nếu không còn cần các cổng đó; không có tác vụ tự quét/xóa orphan rule toàn host.

Response chỉ gồm cổng mong muốn, managed/obsolete rule của server, trạng thái `managed|covered|missing`, warnings và revision; không xuất toàn bộ rule foreign. `ok:true` nghĩa là trạng thái UFW yêu cầu đã được quan sát, không phải xác minh client game từ Internet. Lỗi sau một lượt ghi trả `partial:true` cùng các thay đổi đã xác nhận; không tuyên bố rollback các thay đổi firewall. Các thao tác Vortex cùng tiến trình được tuần tự hóa; thay đổi đồng thời từ quản trị viên/công cụ khác được kiểm tra lại trước từng lệnh, nhưng không có transaction UFW nhiều lệnh hoặc bảo đảm sau mất điện. Rule deny/limit hoặc cú pháp liên quan chưa phân tích an toàn cần xử lý thủ công. IPv6 bị tắt hoặc rule không xác nhận được sẽ không được ghi thành thành công.

Mỗi lệnh UFW có deadline 10 giây, output tối đa 1 MiB, mỗi lượt reconcile tối đa khoảng hai phút cộng lệnh đang chạy. Nguồn: [Ubuntu UFW manual và prepend theo family](https://manpages.ubuntu.com/manpages/noble/man8/ufw.8.html), [UFW frontend xử lý vị trí IPv4/IPv6](https://sources.debian.org/src/ufw/0.36.2-9/src/frontend.py/), [UFW backend rule matching/insertion](https://sources.debian.org/src/ufw/0.36.2-9/src/backend_iptables.py/), [UFW exact comment matching](https://sources.debian.org/src/ufw/0.36.2-9/src/common.py/).
