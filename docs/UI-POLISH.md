# Vortex MC 0.5.1 · giao diện và tải màn đăng nhập

## Chọn ngôn ngữ

EN/VI dùng popover của panel thay cho menu `<select>` mặc định. Trigger và lựa chọn có cùng font, màu, radius, viền focus và dấu chọn ở light/dark. Toolbar nhỏ chỉ hiện EN hoặc VI; tên đầy đủ vẫn có trong accessible name và menu, không cắt chữ thành `EN · E`.

Menu hỗ trợ Enter/Space, phím mũi tên, Home/End, tìm bằng ký tự, Escape, Tab và click bên ngoài. Mũi tên chỉ chuyển focus; lựa chọn chỉ đổi khi xác nhận. Escape đóng menu và trả focus về trigger trước khi dialog cha xử lý Escape. Menu ở top layer nếu browser có Popover API, giữ bên trong dialog trong DOM để tương thích focus containment; browser thiếu API dùng vị trí fixed và z-index. Fallback ngoài dialog chuyển menu tạm sang body để tránh containing block từ backdrop-filter của auth card, rồi trả về chỗ cũ khi đóng. Vị trí được giới hạn theo visual viewport và cập nhật khi scroll/resize.

Chuyển ngôn ngữ tiếp tục cập nhật các text/attribute slot tại chỗ. Không tạo lại form, editor hay thao tác đang chạy; dữ liệu người dùng và raw Minecraft logs không dịch. Quy tắc đầy đủ ở [I18N](I18N.md).

## Tải nền và form cùng nhau

Panorama cũ là PNG **2.626.318 byte**. Bản WebP từ cùng artwork, giữ kích thước **2172 × 724**, có **312.138 byte**, giảm khoảng **88,1%** byte truyền. Ảnh được phục vụ trong project; không phụ thuộc CDN ảnh bên ngoài. Chi tiết nguồn ở [ASSETS](ASSETS.md).

HTML preload đúng cùng URL `/assets/vortex-world.webp` với priority cao. Module `auth-boot.js` bắt đầu decode sớm; trạng thái kết nối ban đầu là nền gradient/voxel grid và thương hiệu Vortex được vẽ bằng CSS. Form ẩn và inert trong lúc chờ để không thể focus hoặc submit controls vô hình.

Khi ảnh decode xong và auth status đã sẵn sàng, ảnh và form được đặt trong cùng scene rồi hiện cùng nhau. Nếu ảnh lỗi hoặc chờ quá **2400 ms** từ lúc module boot chạy, form hiện trên nền gradient có chủ đích. Trạng thái fallback được giữ cho lượt tải trang đó: ảnh hoàn tất muộn không đổi nền sau lưng form. API khởi tạo `/auth/status` và dashboard đầu tiên có timeout riêng **12 giây mỗi request**; lỗi dùng thông báo kết nối hiện có. Timeout này không áp dụng cho upload, cài server hoặc các job dài.

Khôi phục phiên đã đăng nhập mở workspace mà không đợi ảnh trang login. Loader được dọn khi workspace hoặc auth scene sẵn sàng; skip link chỉ có trong workspace. Chuyển động scene ngắn, có chế độ giảm chuyển động; ảnh decorative không tham gia accessibility tree.

## Mobile và tablet

Các nút toolbar, avatar, tab máy chủ và hành động power/version được nâng vùng chạm tối thiểu **44 px** trong bố cục dưới 900 px. Trên điện thoại nhỏ, header editor dành hàng đầu cho tên tệp và nút đóng; bộ chọn ngôn ngữ chuyển sang hàng riêng, tránh ép tên tệp vào cột nhỏ. Các dữ liệu dài vẫn wrap hoặc scroll ở vùng dành cho chúng.

Palette sáng tăng độ đậm của chữ phụ và placeholder; các token `--muted: #676b80` và `--soft: #686b7e` có tương phản trên 4,5:1 với nền field `#f5f5fa` và nền lựa chọn `#efedfc`. Palette dark giữ nguyên. Kiểm tra browser đối chiếu thêm nền thực tế sau compositing, thay vì chỉ nhìn token màu.

## Kiểm chứng

Kiểm UI bằng browser thật ở EN/VI, light/dark và các chiều rộng 320/390/768/1440 px. Các tình huống mạng gồm ảnh tải chậm, ảnh lỗi, vượt deadline rồi hoàn tất muộn, cache và khôi phục phiên. Kiểm thêm popover bằng bàn phím, giới hạn viewport, menu trong dialog, draft, reduced motion và bootstrap API bị treo. Các báo cáo dưới `output/playwright/ui-polish-review` và `output/vps` có provenance riêng; fixture UI không chứng minh gameplay.

## Tài liệu tham khảo

Behavior bàn phím và trạng thái selected dựa trên [WAI-ARIA Listbox Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/). Top layer tham khảo [MDN Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API). Cơ chế chờ ảnh decode tham khảo [MDN HTMLImageElement.decode](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode); phát hiện ảnh sớm tham khảo [web.dev image preload](https://web.dev/articles/preload-responsive-images). Màu, hình dạng và thời lượng là quyết định của Vortex, không phải thông số iOS bắt buộc.
