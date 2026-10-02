# Tự động chấp nhận chuyển quyền sở hữu Google Drive

Mỗi sáng (khoảng 6h–7h), script chạy trên máy chủ Google (không cần mở máy): tìm file đang chờ Giang nhận quyền sở hữu và tự chấp nhận.

## Vì sao cách này nhanh và chắc

- **Không quét cả Drive:** chỉ xét file Giang *có quyền sửa nhưng chưa sở hữu*. Người chuyển quyền bắt buộc phải cấp quyền chỉnh sửa trước, nên không bỏ sót.
- **Không đọc Gmail:** trạng thái "đang chờ" lấy thẳng từ Drive, nên email thông báo bị lọc, xoá hay đổi mẫu cũng không ảnh hưởng. Không cần cấp quyền đọc hộp thư.
- **Mỗi lần gọi API kiểm tra 100 file**, không phải gọi riêng từng file.

## Cài đặt (5 phút)

1. Vào https://script.google.com bằng **tài khoản nhận quyền** → *Dự án mới*.
2. *Cài đặt dự án* (bánh răng) → tick **Hiển thị tệp kê khai "appsscript.json"**. Dán nội dung `appsscript.json` vào.
3. Mở `Code.gs`, xoá code mẫu, dán nội dung `Code.gs`. Bấm **Lưu**.
4. Chọn hàm `installTrigger` → **Chạy** → cấp quyền (Nâng cao → Đi tới… → Cho phép). Xong: script nhận ngay các file đang chờ và từ đó tự chạy mỗi sáng.

Muốn chạy thử trước (chỉ ghi nhật ký, chưa nhận): sửa `DRY_RUN: true`, chạy `acceptPendingOwnerships`, xem sheet nhật ký bằng `showLogLink`.

Tắt tự động: chạy `removeTrigger`. Muốn đổi giờ chạy: sửa `RUN_HOUR` rồi chạy lại `installTrigger`.

(Tuỳ chọn) Muốn biết mỗi ngày script phải kiểm tra bao nhiêu file: chạy `countCandidates`.

Cần nhận gấp một file trong ngày: chạy tay `acceptPendingOwnerships`, không cần chờ sáng hôm sau.

## Nên cài danh sách cho phép

Nhận tự động **mọi** yêu cầu nghĩa là ai cũng có thể đẩy file vào Drive của Giang (chiếm dung lượng, file rác). Nên điền `ALLOWED_EMAILS` / `ALLOWED_DOMAINS` trong `CONFIG`; yêu cầu từ người khác sẽ được ghi nhật ký để Giang tự xem.

## Lưu ý

- Chỉ hoạt động khi chuyển giữa các tài khoản **Gmail cá nhân** (hoặc cùng một tổ chức Workspace). Khác tổ chức thì Google không cho chuyển quyền.
- Drive lớn: mỗi lượt tối đa ~4,5 phút; quét chưa xong thì 1 phút sau tự chạy tiếp cho tới khi xong. Xem số liệu ở *Nhật ký thực thi* (dòng `đã quét hết` / `CHƯA quét hết`).
