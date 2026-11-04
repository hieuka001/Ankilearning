# AnkiLearning Desktop (Tauri)

Bản AnkiLearning "như phần mềm thật" cho laptop/máy tính: file cài Windows
`.exe`/`.msi`, macOS `.dmg`, Linux `.deb`/`.AppImage`.

## Cách hoạt động

- Vỏ desktop mở một trang chờ nội bộ rồi chuyển tới **bản web trực tuyến**
  (`learning-with-trunghieu.vercel.app`). Vì vậy:
  - Mọi cập nhật **nội dung/tính năng** của web tự đến với bản máy tính ngay
    lần mở sau — không cần phát hành lại bản desktop.
  - **Dữ liệu đồng bộ liên tục** qua chính tài khoản Firebase của app: học trên
    máy tính, điện thoại hay trình duyệt đều thấy nhau, kể cả học offline rồi
    đồng bộ sau (hàng đợi ngoại tuyến của bản web).
- Vỏ desktop có **bộ tự cập nhật riêng** (Tauri Updater): khi khởi động, app
  kiểm tra `latest.json` trên GitHub Releases; có vỏ mới thì hiện hộp thoại
  "Cập nhật ngay / Để sau", tải, cài và tự khởi động lại.

## Phát hành bản desktop mới

Chỉ cần khi thay đổi vỏ (icon, cấu hình cửa sổ, plugin...):

1. Tăng `version` trong `src-tauri/tauri.conf.json`.
2. Vào GitHub → Actions → **Desktop Release** → Run workflow (hoặc push tag
   `desktop-v*`).
3. Workflow build trên Windows/macOS/Linux runners và tạo **Release nháp**
   kèm file cài + `latest.json`. Kiểm tra rồi bấm Publish để người dùng nhận
   thông báo cập nhật.

Khoá ký bản cập nhật nằm ở GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (khoá công khai nằm trong
`tauri.conf.json`). Mất khoá riêng = không ký được bản cập nhật nữa — bản sao
lưu giữ ngoài repo bởi chủ dự án.

## Lưu ý tải file

Repo đang ở chế độ **private** nên file trong GitHub Releases chỉ tải được khi
đăng nhập GitHub có quyền truy cập repo. Muốn mọi người tải tự do: chuyển repo
sang public, hoặc đăng file cài lên một nơi công khai (ví dụ một project Vercel
tĩnh riêng) và cập nhật đường dẫn trong ghi chú phát hành.
