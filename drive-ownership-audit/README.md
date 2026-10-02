# Rà soát quyền sở hữu file trên Google Drive

Script Google Apps Script, chạy bằng chính tài khoản của Giang:

| Bước | Script làm gì |
|---|---|
| 1. Tìm thư mục | Lấy mọi thư mục Giang sở hữu + **toàn bộ thư mục con** (kể cả thư mục con do người khác tạo) |
| 2. Tìm file lạ | File/thư mục trong đó mà Giang **không** sở hữu → ghi vào sheet `Danh sách` (tên, link, chủ sở hữu, email, thư mục chứa) |
| 3. Nhắc | Gom file theo từng chủ sở hữu → **1 email/người**, tối đa 1 lần/7 ngày, tối đa 4 lần/file. File đã chuyển quyền tự chuyển trạng thái `Đã xử lý` và không bị nhắc nữa |

## Cài đặt (khoảng 10 phút)

1. Tạo một **Google Sheet mới** (ví dụ: `Rà soát quyền sở hữu Drive`), đăng nhập bằng tài khoản Giang.
2. Trong Sheet: **Tiện ích mở rộng → Apps Script**.
3. Xoá code mẫu, dán toàn bộ nội dung `Code.gs` vào.
4. Bật Drive API: bên trái bấm **Dịch vụ (+)** → chọn **Drive API** → phiên bản **v3** → **Thêm**.
5. (Tuỳ chọn) Sửa phần `CONFIG` ở đầu file: tên người gửi, số ngày giữa 2 lần nhắc, email không muốn nhắc.
6. Bấm **Lưu**, quay lại Sheet và **tải lại trang** → xuất hiện menu **Rà soát Drive**.

## Chạy

1. **Rà soát Drive → 1. Quét cấu trúc thư mục**. Script chỉ đọc danh sách thư mục bạn sở hữu (rất nhanh) và ghi ra tab `Chọn thư mục`, có thụt lề theo cấp và cột đường dẫn. Lần đầu Google sẽ hỏi cấp quyền → chọn tài khoản → *Nâng cao* → *Đi tới (không an toàn)* → *Cho phép*.
2. Ở tab `Chọn thư mục`, **tick ô "Chọn"** ở thư mục muốn rà soát. Tick thư mục cha là đủ, thư mục con tự được tính theo.
3. **Rà soát Drive → 2. Quét file trong thư mục đã chọn**. Kết quả ra tab `Danh sách`. Nếu không muốn nhắc file nào, đổi cột **Trạng thái** thành `Bỏ qua`.
4. **Chạy thử trước khi gửi thật:** đặt `DRY_RUN: true` → chạy **3. Gửi email nhắc ngay** → xem tab `Nhật ký` xem sẽ gửi cho ai. Ổn thì đổi lại `DRY_RUN: false`.
5. **Rà soát Drive → Bật chạy tự động hằng ngày**. Mỗi sáng ~7h script tự cập nhật cây thư mục (giữ nguyên ô đã tick), quét các thư mục đã chọn, rồi nhắc.

Muốn đổi phạm vi: chỉ cần tick/bỏ tick ở tab `Chọn thư mục`. File thuộc thư mục bị bỏ tick sẽ chuyển `Đã xử lý` ở lần quét sau và không bị nhắc nữa.

## Trạng thái trong sheet

- `Chưa chuyển`: đang chờ chủ file chuyển quyền, sẽ được nhắc.
- `Đã xử lý`: lần quét sau không còn thấy (đã chuyển quyền cho Giang, bị xoá, bị chuyển ra ngoài, hoặc thư mục chứa nó đã bị bỏ tick).
- `Bỏ qua`: Giang tự đặt; script không nhắc nữa.

## Lưu ý quan trọng

- **Người nhận phải chấp nhận:** với tài khoản Gmail cá nhân, chủ file chỉ gửi *lời mời* chuyển quyền; Giang cần mở email/Drive và bấm **Chấp nhận** thì quyền mới thực sự chuyển.
- **Khác tổ chức thì không chuyển được:** file của tài khoản công ty (Google Workspace) không chuyển được sang Gmail cá nhân (và ngược lại). Trường hợp này cách thực tế là **tạo bản sao** (bản sao thuộc về Giang) rồi xoá bản gốc, hoặc đặt các file đó thành `Bỏ qua`.
- **Shared drive** (Bộ nhớ dùng chung) không có chủ sở hữu cá nhân nên script không quét.
- **Hạn mức email:** Gmail cá nhân gửi được ~100 email/ngày qua Apps Script. Vượt thì script ghi nhật ký và gửi tiếp vào hôm sau.

## Drive lớn

Script tự chia nhiều lượt: mỗi lượt chạy khoảng 4 phút, ghi kết quả vào tab ẩn, rồi hẹn 1 phút sau tự chạy tiếp cho tới khi xong. Theo dõi tiến độ ở tab `Nhật ký` (dòng "Đang quét: x/y thư mục..."). Khi thấy dòng **"Quét xong"** thì tab `Danh sách` đã có đủ dữ liệu. Hai tab `_Hàng đợi` và `_Kết quả quét` là tab ẩn dùng tạm, không cần đụng vào.
