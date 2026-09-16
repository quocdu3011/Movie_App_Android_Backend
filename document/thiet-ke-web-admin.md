# Thiết kế Web Admin — Hệ thống xem phim

Tài liệu thiết kế hoàn chỉnh cho web quản trị: hệ thống thiết kế giao diện, toàn bộ module chức năng, luồng thao tác, và đặc tả API.

---

## 1. Định vị sản phẩm

**Người dùng:** đội vận hành nội dung (biên tập viên, quản lý nội dung) và đội vận hành hệ thống (admin, hỗ trợ khách hàng). Làm việc trên máy tính, màn hình rộng, nhiều giờ liên tục, xử lý khối lượng lớn bản ghi mỗi ngày.

**Nguyên tắc thiết kế cốt lõi:** công cụ này được đo bằng *số thao tác hoàn thành mỗi giờ*, không phải bằng ấn tượng thị giác. Mọi quyết định giao diện phục vụ ba mục tiêu theo thứ tự ưu tiên:

1. **Không gây sai sót** — thao tác nguy hiểm phải khó bấm nhầm, trạng thái dữ liệu phải hiển thị rõ ràng không mơ hồ.
2. **Tốc độ** — giảm số cú click, số lần tải trang, số lần phải nhớ thông tin giữa các màn hình.
3. **Dễ chịu khi dùng lâu** — mật độ cao nhưng không chật chội, tương phản đủ nhưng không chói.

Đây là lý do giao diện admin cố tình **khác hẳn** app xem phim của người dùng cuối: app người dùng bán cảm xúc, admin bán sự chính xác.

---

## 2. Hệ thống thiết kế

### 2.1. Màu sắc

| Vai trò | Sáng | Tối | Dùng cho |
|---|---|---|---|
| Nền trang | `#F7F8FA` | `#0F1115` | Canvas ngoài cùng |
| Bề mặt thẻ/bảng | `#FFFFFF` | `#181B21` | Card, bảng, panel |
| Viền | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.10)` | Đường phân cách, luôn mảnh 1px |
| Chữ chính | `#16181D` | `#E9EAEE` | Nội dung |
| Chữ phụ | `#6B7280` | `#9AA0AA` | Nhãn cột, metadata |
| Hành động chính | `#2563EB` | `#3B82F6` | Nút chính, link, tab đang chọn |
| Thành công | `#16A34A` | `#22C55E` | Trạng thái published, active |
| Cảnh báo | `#D97706` | `#F59E0B` | Trạng thái partial, suspended |
| Nguy hiểm | `#DC2626` | `#EF4444` | Xóa, khóa, thu hồi |

**Hai quy tắc màu bắt buộc:**

- **Đỏ chỉ dành cho hành động phá hủy.** Không dùng đỏ cho cảnh báo nhẹ, không dùng đỏ trang trí. Khi người vận hành thấy đỏ, họ phải hiểu ngay "việc này khó hoặc không hoàn tác được".
- **Một nút xanh dương chính trên mỗi màn hình.** Các nút còn lại dùng kiểu viền (outline) hoặc nền trong suốt. Nếu một màn hình có ba nút xanh, không nút nào còn là "chính".

Bắt buộc hỗ trợ **dark mode** — đội vận hành thường làm ca tối, và đây là kỳ vọng mặc định của công cụ nội bộ hiện đại.

### 2.2. Typography

Một họ chữ duy nhất: **Inter** (hoặc font hệ thống). Không dùng font hiển thị riêng như app người dùng — admin không cần cá tính thị giác.

| Cấp | Cỡ | Đậm | Dùng cho |
|---|---|---|---|
| Tiêu đề trang | 20px | 500 | Tên màn hình |
| Tiêu đề mục | 15px | 500 | Tiêu đề card, tab |
| Nội dung | 13px | 400 | Ô bảng, form |
| Nhãn phụ | 12px | 400 | Nhãn cột, metadata |
| Số liệu lớn | 24px | 500 | Thẻ metric |

Cỡ 13px cho nội dung bảng là lựa chọn có chủ đích — nhỏ hơn web thông thường (16px) để hiển thị nhiều hàng hơn trên một màn hình, nhưng vẫn đủ lớn để đọc thoải mái nhiều giờ. Không dùng dưới 12px cho bất kỳ text nào người dùng cần đọc.

**Số liệu và ID dùng font mono** (`ui-monospace`) — userId, transaction id, checksum, số tiền. Chữ số đều cột giúp so sánh và phát hiện sai lệch nhanh hơn.

### 2.3. Khung bố cục

```
┌──────────┬────────────────────────────────────────┐
│          │  Topbar: breadcrumb · tìm kiếm · user  │
│ Sidebar  ├────────────────────────────────────────┤
│  240px   │                                        │
│  cố định │  Vùng nội dung (max-width 1440px)      │
│  gom     │                                        │
│  nhóm    │                                        │
└──────────┴────────────────────────────────────────┘
```

- **Sidebar 240px cố định**, gom mục theo nhóm chức năng có tiêu đề nhóm nhỏ. Thu gọn được thành 64px (chỉ icon) cho màn hình hẹp.
- **Topbar 56px**: breadcrumb bên trái (cho biết đang ở đâu trong cây điều hướng), ô tìm kiếm toàn cục ở giữa, avatar + menu tài khoản bên phải.
- **Vùng nội dung** giới hạn 1440px, căn trái (không căn giữa) — bảng dữ liệu đọc tự nhiên từ trái sang.

### 2.4. Thành phần

**Bảng dữ liệu** là thành phần quan trọng nhất của toàn hệ thống:
- Hàng cao 44px, viền ngang mảnh giữa các hàng, không viền dọc.
- Header bảng dính (sticky) khi cuộn — luôn biết đang xem cột nào.
- Không bo góc từng hàng, không đổ bóng, không sọc ngựa vằn (zebra) — viền mảnh là đủ để tách hàng, sọc vằn gây nhiễu khi bảng nhiều cột.
- Hover đổi nền rất nhẹ để định vị con trỏ.
- Cột số căn phải, cột chữ căn trái, cột trạng thái căn trái.

**Badge trạng thái**: nền tint nhạt + chữ cùng họ màu đậm, bo góc nhẹ, cỡ 11-12px. Bảng màu trạng thái cố định toàn hệ thống:

| Trạng thái | Màu |
|---|---|
| `active`, `published`, `completed`, `ready` | Xanh lá |
| `draft`, `queued`, `unknown` | Xám |
| `running`, `processing` | Xanh dương |
| `suspended`, `partial`, `pending` | Vàng cam |
| `failed`, `error`, `unavailable` | Đỏ |
| `archived`, `deleted` | Xám đậm |

Cùng một trạng thái phải luôn cùng một màu ở mọi màn hình — đây là điều người vận hành học một lần rồi dùng mãi.

**Thẻ metric**: nhãn 12px xám ở trên, số 24px đậm 500 ở dưới, nền `surface-1`, không viền. Xếp hàng 4 thẻ đầu trang danh sách.

**Trạng thái rỗng**: một dòng chữ + một nút hành động. Không minh họa trang trí — khác app người dùng cuối.

**Skeleton khi tải**: dùng skeleton hàng bảng thay vì spinner toàn trang, giữ layout ổn định, không nhảy nội dung.

### 2.5. Chuyển động

Chỉ dùng cho phản hồi thao tác, không trang trí: toast trượt vào 150ms, dropdown mở 120ms, nút nhấn scale nhẹ. **Không** có hiệu ứng xuất hiện dần cho nội dung trang khi tải xong — thứ đó làm chậm cảm giác thao tác.

---

## 3. Bản đồ chức năng

```
Web Admin
│
├── Tổng quan                          [tất cả role]
│
├── NỘI DUNG
│   ├── Phim
│   │   ├── Danh sách
│   │   ├── Tạo mới
│   │   └── Chi tiết → Thông tin | Mùa & tập | Nguồn phát | Lịch sử
│   ├── Thể loại & quốc gia
│   ├── Nhập từ nguồn ngoài
│   │   ├── Tìm & nhập theo slug
│   │   ├── Đồng bộ hàng loạt
│   │   └── Lịch sử đồng bộ
│   └── Thư viện video
│       ├── Tải lên
│       └── Danh sách asset
│
├── VẬN HÀNH
│   ├── Người dùng
│   │   ├── Danh sách
│   │   └── Chi tiết → Tổng quan | Hồ sơ | Phiên đăng nhập | Gói cước | Nhật ký
│   ├── Gói cước & thanh toán
│   │   ├── Cấu hình gói
│   │   └── Giao dịch
│   ├── Phiên phát trực tiếp
│   └── Nhật ký quản trị
│
└── HỆ THỐNG                           [chỉ admin]
    ├── Tài khoản quản trị
    └── Cấu hình
```

---

## 4. Phân quyền

| Quyền | `content_editor` | `content_manager` | `support` | `admin` |
|---|---|---|---|---|
| Xem/sửa phim, tập | ✓ | ✓ | | |
| Xuất bản / lưu trữ phim | | ✓ | | |
| Nhập & đồng bộ nguồn ngoài | ✓ | ✓ | | |
| Upload video | ✓ | ✓ | | |
| Xem người dùng | | | ✓ | ✓ |
| Khóa / mở khóa tài khoản | | | ✓ | ✓ |
| Thu hồi phiên đăng nhập | | | ✓ | ✓ |
| Điều chỉnh gói cước thủ công | | | | ✓ |
| Xóa tài khoản | | | | ✓ |
| Cấu hình gói cước | | | | ✓ |
| Quản lý tài khoản admin | | | | ✓ |
| Xem nhật ký quản trị | | ✓ | ✓ | ✓ |

Nguyên tắc: **hành động càng khó hoàn tác, càng ít role được phép**. Tách `content_editor` khỏi `content_manager` để người mới vào có thể soạn nội dung mà chưa được quyền đẩy lên production.

Khi vào hệ thống, gọi endpoint phiên admin để lấy role, rồi **ẩn hẳn** mục sidebar ngoài quyền — không hiển thị dạng khóa, tránh để người dùng thấy chức năng họ không bao giờ dùng được.

---

## 5. Chi tiết các module

### 5.1. Tổng quan

Trang mặc định sau đăng nhập. Nội dung thay đổi theo role:

- **Với vai trò nội dung**: số phim theo trạng thái, phim vừa chỉnh sửa gần đây, job đồng bộ đang chạy, video đang chờ xử lý.
- **Với vai trò vận hành**: tài khoản mới hôm nay, tài khoản bị khóa, giao dịch thất bại cần xử lý, số phiên phát đang hoạt động.

Mỗi khối là lối tắt dẫn thẳng tới danh sách đã lọc sẵn — ví dụ bấm "12 job thất bại" mở màn Lịch sử đồng bộ với bộ lọc `status=failed` áp dụng sẵn.

Trang này chỉ hiển thị số liệu **có API thật trả về**. Không dựng biểu đồ doanh thu hay retention nếu backend chưa cung cấp — số liệu tự tính phía client từ nhiều lần gọi API rời rạc sẽ sai và không ai tin được sau vài lần lệch.

### 5.2. Danh sách phim

**Cột:** thumbnail 32×48, tên phim (kèm tên gốc nhỏ bên dưới), loại, trạng thái, nguồn, số tập, cập nhật lúc.

**Bộ lọc:** trạng thái, loại (phim lẻ/bộ), nguồn (tự sản xuất/nhập ngoài), thể loại, năm, tìm theo tên.

**Thao tác hàng loạt:** chọn nhiều bằng checkbox → thanh hành động nổi lên ở đáy màn hình hiển thị số lượng đã chọn + các nút (xuất bản, lưu trữ, gán thể loại). Thanh này che khuất nội dung nên phải có nút đóng rõ ràng.

Thao tác hàng loạt **phải hiển thị kết quả từng bản ghi** sau khi chạy (thành công bao nhiêu, lỗi bao nhiêu, lỗi ở phim nào) — không chỉ hiện toast "đã xử lý 20 mục", vì trong thực tế một vài mục sẽ thất bại và người vận hành cần biết chính xác mục nào.

### 5.3. Chi tiết phim

**Tab Thông tin** — form metadata: tên, tên gốc, mô tả, poster, backdrop, năm, thể loại (multi-select), quốc gia, phân loại nội dung, hạng truy cập, phù hợp trẻ em.

Header trang cố định (sticky) chứa: tên phim, badge trạng thái, và các nút hành động trạng thái. Nút "Xuất bản" **disable kèm tooltip giải thích** nếu chưa đủ điều kiện (chưa có nguồn phát khả dụng) — kiểm tra phía client trước, để người vận hành không phải bấm rồi mới nhận lỗi.

Form dùng **auto-save theo từng field** khi rời khỏi ô nhập, hiển thị chỉ báo "Đã lưu" nhỏ — nhanh hơn nhiều so với bấm nút Lưu sau mỗi lần sửa, và tránh mất dữ liệu khi đóng nhầm tab. Ngoại lệ: các trường ảnh hưởng tới người dùng cuối ngay lập tức (trạng thái xuất bản) vẫn cần xác nhận rõ ràng.

**Tab Mùa & tập** (chỉ phim bộ) — cây mùa → tập, kéo thả để đổi thứ tự, thêm/sửa/xóa tập. Mỗi tập hiển thị badge cho biết đã có nguồn phát hay chưa, vì đây là thông tin quyết định tập đó có xem được không.

**Tab Nguồn phát** — hai khối:
- Khối trên: danh sách content source gắn với phim (tự sản xuất / nguồn ngoài + provider), toggle khóa đồng bộ cho nguồn ngoài kèm mô tả rõ hệ quả.
- Khối dưới: bảng mapping từng tập ↔ từng server phát, gồm trạng thái nguồn và chế độ phát. Đây là nơi hay sai nhất khi vận hành, nên bảng cần hiển thị đủ để phát hiện lỗi mapping bằng mắt: tập nào chưa có server, server nào trỏ nhầm tập.

**Tab Lịch sử** — ai sửa gì, lúc nào, giá trị trước/sau.

### 5.4. Nhập từ nguồn ngoài

**Tìm & nhập:** ô tìm keyword → danh sách kết quả từ provider (poster, tên, năm) → nút Nhập cho từng kết quả. Cho phép chọn nhập thành phim mới, hoặc gắn thêm nguồn vào phim đã có (trường hợp một tựa phim có cả bản tự sản xuất lẫn bản từ nguồn ngoài).

**Đồng bộ hàng loạt:** hai chế độ — khám phá phim mới, hoặc làm mới phim đã có. Có ô giới hạn số trang quét mỗi lần để tránh vô tình chạy job quá lớn.

**Lịch sử đồng bộ:** bảng các lần chạy với trạng thái, số tạo mới/cập nhật/lỗi, số lần thử. Job đang chạy được **poll tự động mỗi 3-5 giây**, dừng poll ngay khi đạt trạng thái kết thúc. Hàng mở rộng được để xem mã lỗi mà không cần vào log server.

Đây là màn hình duy nhất có polling trong toàn hệ thống — cần chỉ báo trực quan (spinner nhỏ cạnh badge) để người dùng biết trang đang tự cập nhật, tránh họ bấm refresh liên tục.

### 5.5. Thư viện video

**Tải lên** theo stepper 3 bước, vì file đi thẳng lên storage chứ không qua backend:
1. Chọn file → tính checksum phía client (hiện chỉ báo "đang tính", với file lớn mất vài giây) → xin URL upload.
2. Upload trực tiếp lên storage với thanh tiến độ thật theo sự kiện upload. Cảnh báo nếu URL sắp hết hạn.
3. Xác nhận hoàn tất.

Hỗ trợ **hàng đợi nhiều file** — chọn nhiều video cùng lúc, upload tuần tự, mỗi file một dòng tiến độ riêng, tiếp tục được khi một file lỗi.

**Danh sách asset:** trạng thái xử lý, độ phân giải khả dụng, dung lượng, liên kết tới phim/tập tương ứng.

Nếu backend chưa có API theo dõi tiến trình xử lý video sau upload, **nói rõ điều đó trên giao diện** ("đã đưa vào hàng đợi xử lý, kiểm tra lại sau vài phút") thay vì vẽ thanh tiến độ giả. Thanh tiến độ không dựa trên dữ liệu thật sẽ khiến người vận hành đưa ra quyết định sai.

### 5.6. Người dùng — danh sách

**Thẻ metric đầu trang:** đang hoạt động, có gói cước, bị khóa, mới trong 7 ngày.

**Cột:** email, trạng thái, gói cước, số hồ sơ, số phiên đang hoạt động, ngày tạo.

**Bộ lọc:** tìm theo email (chính xác hoặc theo tiền tố), trạng thái, gói cước.

**Quy tắc bảo vệ dữ liệu:**
- Không hiển thị mật khẩu hay hash dưới bất kỳ hình thức nào, kể cả dạng che dấu.
- Không hiển thị IP hay vị trí ở màn danh sách — chỉ ở tab Phiên đăng nhập khi thực sự cần điều tra.
- Không có cột "phim đã xem" — nhân viên hỗ trợ không cần biết người dùng xem gì để xử lý sự cố kỹ thuật, và đây là dữ liệu riêng tư nhạy cảm.
- Tìm kiếm giới hạn theo tiền tố, có rate limit phía server, tránh biến công cụ hỗ trợ thành công cụ trích xuất danh sách email.

**Không đặt nút Khóa/Xóa trực tiếp trên hàng bảng.** Mọi hành động thay đổi trạng thái đều nằm trong màn chi tiết — tránh bấm nhầm sai hàng khi đang cuộn nhanh qua hàng nghìn bản ghi.

### 5.7. Người dùng — chi tiết

**Tab Tổng quan:** thông tin tài khoản chỉ đọc (id, email, trạng thái, phương thức đăng nhập, ngày tạo). Khối "Hành động quản trị" tách riêng ở cuối trang, nền khác biệt:

- **Khóa tài khoản** — dialog bắt buộc nhập lý do (tối thiểu 10 ký tự), cảnh báo rõ: người dùng sẽ bị đăng xuất khỏi mọi thiết bị và không đăng nhập lại được.
- **Mở khóa** — vẫn ghi lý do.
- **Xóa tài khoản** (chỉ admin) — xác nhận hai bước: bước một giải thích hệ quả, bước hai yêu cầu gõ chính xác email để xác nhận. Đây là chuẩn cho hành động không hoàn tác, và xóa nhầm tài khoản người dùng là lỗi không sửa được.

**Tab Hồ sơ:** danh sách profile, **chỉ đọc**. Admin không sửa/xóa profile người dùng — đây là dữ liệu cá nhân thuộc quyền kiểm soát của họ, và không có tình huống hỗ trợ nào thực sự cần can thiệp trực tiếp. Nếu sau này phát sinh nhu cầu thật (profile có tên vi phạm chính sách), nên làm bằng luồng riêng có ghi lý do và nhật ký.

**Tab Phiên đăng nhập:** bảng thiết bị đang đăng nhập (tên thiết bị, đăng nhập lúc, hoạt động gần nhất). Hai hành động: thu hồi một phiên, thu hồi tất cả. "Thu hồi tất cả" là công cụ hỗ trợ dùng nhiều nhất khi người dùng báo bị chiếm tài khoản, nên đặt nổi bật.

**Tab Gói cước:** gói hiện tại + lịch sử. Hành động điều chỉnh thủ công (chỉ admin) **chỉ cho phép cộng thêm số ngày**, không cho sửa tự do ngày kết thúc — giới hạn biên độ sai sót và khiến mọi thay đổi truy vết được thành "ai cộng bao nhiêu ngày, vì lý do gì". Không có chức năng hoàn tiền trong admin; việc đó thuộc cổng thanh toán.

**Tab Nhật ký:** mọi thao tác admin đã thực hiện lên chính tài khoản này.

### 5.8. Gói cước & thanh toán

**Cấu hình gói** (chỉ admin): CRUD gói cước — tên, giá, thời hạn, số luồng đồng thời, độ phân giải tối đa. Sửa giá gói **không** ảnh hưởng thuê bao đang chạy, cần nói rõ điều này trên form để tránh hiểu nhầm.

**Giao dịch:** bảng lịch sử giao dịch, lọc theo trạng thái/khoảng thời gian/phương thức. Giao dịch thất bại hiển thị mã lỗi từ cổng thanh toán. Chỉ đọc — không cho phép sửa trạng thái giao dịch thủ công từ admin, vì đó là nguồn sự thật của cổng thanh toán, sửa tay sẽ tạo lệch số liệu đối soát.

### 5.9. Phiên phát trực tiếp

Bảng các phiên phát đang hoạt động: người dùng, phim, thiết bị, bắt đầu lúc, hoạt động gần nhất, trạng thái lease.

Dùng cho hai việc thực tế: điều tra khi người dùng báo lỗi "đã đạt giới hạn thiết bị" dù họ không xem ở đâu khác, và theo dõi tải hệ thống lúc cao điểm.

Có hành động **buộc kết thúc phiên** (chỉ admin, ghi lý do) — dùng khi phiên bị treo do client crash không gửi được tín hiệu kết thúc, khiến người dùng bị chặn oan.

### 5.10. Nhật ký quản trị

Bảng toàn cục mọi hành động admin: thời gian, người thực hiện, hành động, đối tượng, lý do. Lọc theo người thực hiện, loại hành động, khoảng thời gian, đối tượng.

**Chỉ đọc, không xóa được từ giao diện.** Nhật ký mà admin tự xóa được thì mất hoàn toàn giá trị kiểm toán.

### 5.11. Tài khoản quản trị

CRUD tài khoản admin, gán role. Chỉ `admin` truy cập được.

Ràng buộc: không tự hạ quyền chính mình (tránh khóa cứng hệ thống), không xóa admin cuối cùng, mọi thay đổi ghi nhật ký.

---

## 6. Đặc tả API

### 6.1. Nhóm đã có sẵn trong backend

Các module nội dung dùng API đã tồn tại: quản lý phim (`/admin/movies`, season, playable item), nguồn nội dung (`/admin/content-sources`, `/admin/source-items`), nhập/đồng bộ nguồn ngoài (`/admin/providers/{provider}/...`, `sync-runs`), upload video (`/admin/videos/uploads`, `upload-complete`), và phiên admin (`/admin/session`).

### 6.2. Nhóm cần backend bổ sung

Các module vận hành (người dùng, gói cước, phiên phát, nhật ký, tài khoản admin) **chưa có API**. Đặc tả đề xuất dưới đây cần backend team review và chốt trước khi frontend triển khai:

```
# Người dùng
GET    /admin/users?page=&pageSize=&status=&email=&planId=
GET    /admin/users/:userId
POST   /admin/users/:userId/suspend            { reason }
POST   /admin/users/:userId/unsuspend          { reason }
DELETE /admin/users/:userId                    { reason }        -> 202

GET    /admin/users/:userId/sessions
POST   /admin/users/:userId/sessions/:sessionId/revoke   { reason }
POST   /admin/users/:userId/sessions/revoke-all          { reason }

GET    /admin/users/:userId/subscriptions
POST   /admin/users/:userId/subscriptions/extend  { days, reason }

# Gói cước
GET    /admin/plans
POST   /admin/plans                            { name, price, durationDays, ... }
PATCH  /admin/plans/:planId
GET    /admin/transactions?page=&status=&from=&to=

# Phiên phát
GET    /admin/playback-sessions?page=&userId=&status=  # default status=active; status=all dùng để tra lịch sử
POST   /admin/playback-sessions/:sessionId/terminate  { reason }

# Nhật ký
GET    /admin/audit-logs?page=&actorId=&action=&targetUserId=&from=&to=

# Tài khoản quản trị
GET    /admin/staff
POST   /admin/staff                            { email, role }
PATCH  /admin/staff/:staffId                   { role }
DELETE /admin/staff/:staffId

# Tổng quan
GET    /admin/overview                         -- số liệu tổng hợp, backend tính sẵn
```

**Ràng buộc backend phải đảm bảo** (không phải việc frontend tự lo):

- Mọi endpoint ghi bắt buộc có `reason` không rỗng, backend validate, không tin client.
- Mọi endpoint ghi tự tạo bản ghi nhật ký trong cùng transaction — không phụ thuộc client gọi thêm API log riêng.
- `suspend` phải thu hồi refresh token ngay, tránh tình trạng tài khoản bị khóa nhưng token cũ vẫn dùng được tới khi hết hạn.
- Chặn admin thao tác lên tài khoản admin khác qua nhóm endpoint người dùng (tránh leo thang đặc quyền).
- Rate limit riêng cho endpoint tìm kiếm người dùng.
- `GET /admin/overview` trả số liệu backend tính sẵn — không để frontend tự cộng từ nhiều lần gọi API.

---

## 7. Cấu trúc dự án

```
admin-web/
├── src/
│   ├── app/
│   │   ├── login/
│   │   ├── overview/
│   │   ├── movies/
│   │   │   ├── page.tsx
│   │   │   ├── new/
│   │   │   └── [movieId]/          -- 4 tab
│   │   ├── taxonomies/
│   │   ├── import/
│   │   │   ├── search/
│   │   │   ├── bulk-sync/
│   │   │   └── sync-runs/
│   │   ├── videos/
│   │   ├── users/
│   │   │   ├── page.tsx
│   │   │   └── [userId]/           -- 5 tab
│   │   ├── billing/
│   │   ├── playback-sessions/
│   │   ├── audit-logs/
│   │   └── staff/
│   ├── api/                        -- một file mỗi nhóm endpoint
│   ├── components/
│   │   ├── DataTable/              -- sticky header, chọn nhiều, phân trang
│   │   ├── StatusBadge/            -- bảng màu trạng thái tập trung một chỗ
│   │   ├── ConfirmDialog/
│   │   ├── DestructiveDialog/      -- 2 bước + gõ xác nhận
│   │   ├── ReasonInput/            -- ô lý do bắt buộc
│   │   ├── BulkActionBar/
│   │   ├── UploadQueue/
│   │   └── MetricCard/
│   ├── hooks/
│   │   ├── useAdminSession.ts
│   │   ├── usePermission.ts
│   │   ├── useSyncRunPolling.ts
│   │   └── useAutoSave.ts
│   └── lib/
│       ├── apiClient.ts            -- đọc envelope chuẩn, map lỗi
│       ├── checksum.ts
│       └── statusColors.ts         -- nguồn duy nhất cho màu trạng thái
```

**Stack đề xuất:** React + TypeScript + Next.js (hoặc Vite + React Router), TanStack Query cho data-fetching (có sẵn polling, cache, invalidate), TanStack Table cho bảng dữ liệu, Tailwind + shadcn/ui hoặc Radix cho component nền.

Đặt `statusColors.ts` làm nguồn duy nhất định nghĩa màu trạng thái — nếu mỗi màn hình tự chọn màu, sau vài tháng cùng một trạng thái sẽ hiển thị ba màu khác nhau ở ba nơi.

---

## 8. Xử lý lỗi & phản hồi

| Tình huống | Cách hiển thị |
|---|---|
| Lỗi nghiệp vụ (400/422) | Toast đỏ với thông điệp từ server, kèm mã tham chiếu request copy được bằng một click |
| Xung đột (409) | Không tự thử lại. Hiển thị rõ nguyên nhân để người dùng tự quyết định |
| Không đủ quyền (403) | Trang lỗi riêng, không hiện toast — vì đây là lỗi điều hướng, không phải lỗi thao tác |
| Lỗi mạng/server (5xx) | Toast kèm nút "Thử lại" cho thao tác đọc; thao tác ghi không tự retry |
| Thao tác hàng loạt có lỗi một phần | Bảng kết quả từng bản ghi, không gộp thành một toast |

**Mã tham chiếu request** phải hiển thị ở mọi thông báo lỗi — đây là thứ đội vận hành gửi cho đội kỹ thuật khi báo sự cố, và nó tiết kiệm hàng giờ dò log.

---

## 9. Thứ tự triển khai

**Giai đoạn 1 — nền tảng:** khung layout, sidebar/topbar, hệ thống thiết kế, đăng nhập, phân quyền, component dùng chung (DataTable, StatusBadge, dialog).

**Giai đoạn 2 — nội dung:** danh sách/chi tiết phim, mùa & tập, nguồn phát. API đã sẵn sàng, dùng được ngay.

**Giai đoạn 3 — nhập nguồn & video:** tìm/nhập, đồng bộ hàng loạt, lịch sử đồng bộ, upload.

**Giai đoạn 4 — vận hành:** chờ backend chốt đặc tả mục 6.2, rồi làm theo thứ tự rủi ro tăng dần — danh sách người dùng → chi tiết (tổng quan + phiên) → nhật ký → gói cước → phiên phát → xóa tài khoản (làm cuối).

**Giai đoạn 5 — hoàn thiện:** trang tổng quan, tài khoản quản trị, dark mode, tối ưu bảng dữ liệu lớn (virtual scrolling nếu cần).

Chốt đặc tả API mục 6.2 với backend **trước khi bắt đầu giai đoạn 4** — đây là việc chặn, không nên code song song khi tên field còn có thể thay đổi.
