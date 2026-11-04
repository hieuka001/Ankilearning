# AnkiLearning Desktop & iOS (Tauri)

Bản AnkiLearning "như phần mềm thật" cho laptop/máy tính: file cài Windows
`.exe`/`.msi`, macOS `.dmg`, Linux `.deb`/`.AppImage`. Cùng một vỏ Tauri nay
cũng build được bản iPhone dạng IPA chưa ký — xem mục iOS bên dưới.

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

## Thay đổi ở bản vỏ 1.0.3

- **Thông báo nhắc ôn tập cục bộ:** bản web đồng bộ lịch nhắc học qua deep
  link `ankilearning://reminders`, vỏ chuyển thành **thông báo hẹn giờ của
  hệ điều hành** (plugin notification chính thức của Tauri) — tới giờ ôn
  tập máy tự báo kể cả khi app đang đóng, điều mà thông báo web bên trong
  vỏ không làm được. Mỗi lần đồng bộ, các nhắc cũ của tính năng này (id
  2000–2099) được huỷ và đặt lại toàn bộ theo lịch mới, tối đa 20 mục.
- **Lần đồng bộ đầu tiên, iOS/Windows sẽ hỏi quyền thông báo** — chọn
  **Cho phép** thì nhắc mới hiện được; nếu lỡ từ chối, vào cài đặt thông
  báo của hệ điều hành bật lại cho AnkiLearning.
- Khác biệt nền tảng theo giới hạn của plugin: **bản iPhone hẹn đúng giờ
  hẹn**; bản máy tính (Windows/macOS) chưa được plugin hỗ trợ hẹn giờ nên
  nhắc hiện ngay tại thời điểm đồng bộ thay vì đúng giờ hẹn, và cũng không
  có cơ chế huỷ nhắc cũ. Nội dung nhắc vẫn đến tay người dùng như nhau.

## Thay đổi ở bản vỏ 1.0.2

- **Đăng nhập Google qua trình duyệt hệ thống + deep link:** cả popup lẫn
  chuyển hướng đăng nhập bên trong WebView2 đều không đáng tin trên máy
  người dùng (popup mở ra, xoay một vòng rồi văng về màn hình đăng nhập).
  Luồng mới: bấm đăng nhập trong app → app mở trang đăng nhập bằng **trình
  duyệt mặc định của Windows** → đăng nhập xong trình duyệt gọi deep link
  `ankilearning://auth` → app nhận kết quả, tự đưa cửa sổ lên trước và vào
  thẳng trạng thái đã đăng nhập. Trang chờ nội bộ cũng gắn thêm dấu
  `?shell=tauri` khi chuyển tới bản web để phía web nhận diện vỏ chắc chắn.
- **Chống mở trùng app:** thêm cơ chế single-instance — mở lại app (hoặc bấm
  deep link) khi app đang chạy chỉ đưa cửa sổ hiện có lên trước, không chạy
  hai bản song song.

## Thay đổi ở bản vỏ 1.0.1

- **Sửa popup đăng nhập Google không mở:** WebView2 mặc định từ chối cửa sổ
  mới do trang web yêu cầu nên nút "Đăng nhập với Google" bấm không hiện gì.
  Cửa sổ chính nay được dựng trong mã Rust (từ đúng cấu hình trong
  `tauri.conf.json`, đặt `"create": false`) để gắn bộ xử lý cho phép mở cửa
  sổ con — popup OAuth và các link mở cửa sổ mới hoạt động bình thường.
- **Mở app là toàn màn hình:** cửa sổ chính khởi động ở trạng thái phóng to
  tối đa (`maximized`) thay vì khổ 1280×820 như trước.
- **User-Agent riêng:** vỏ gắn UA Chrome/Edge chuẩn kèm hậu tố
  `AnkiLearningDesktop/1.0.1` để phía web nhận diện được bản máy tính.

## Bản iOS — IPA chưa ký (unsigned)

Workflow riêng `.github/workflows/ios-build.yml` build bản iPhone trên máy
macOS của GitHub Actions. Project Xcode (`desktop/src-tauri/gen/apple`) được
lệnh `npx tauri ios init --ci` sinh ngay trong CI mỗi lần chạy — không commit
vào repo. Sau đó workflow chạy
`npx tauri ios build --ci --no-sign --target aarch64` để tạo IPA cho máy thật
(arm64) mà **không cần bất kỳ secret Apple nào**: không tài khoản Apple
Developer, không chứng chỉ, không provisioning profile, không development
team.

Cách chạy:

1. Vào GitHub → Actions → **iOS Build (Unsigned IPA)** → **Run workflow**
   (chạy từ nhánh `main`), hoặc push tag dạng `ios-v<version>`, ví dụ
   `ios-v1.0.2`.
2. Tải file `AnkiLearning-iOS-unsigned.ipa` ở mục Artifacts của lần chạy.
   Nếu chạy bằng tag hoặc chạy tay từ `main`, file cũng được đính kèm vào
   GitHub Release tên `ios-v<version>`.

Lưu ý quan trọng về file IPA:

- Đây là bản **chưa ký** nên iPhone không cài trực tiếp được. Cài bằng
  **AltStore** hoặc **SideStore**: các công cụ này tự ký lại file bằng Apple
  ID cá nhân của chính người cài ngay lúc cài đặt.
- Ký bằng Apple ID miễn phí thường chỉ có hiệu lực **7 ngày**; hết hạn phải
  gia hạn/ký lại (AltStore/SideStore có cơ chế tự làm mới khi đủ điều kiện).
- Muốn đưa app lên **TestFlight** hoặc App Store thì bắt buộc có tài khoản
  **Apple Developer (99 USD/năm)** và phải build một bản riêng có ký số bằng
  chứng chỉ + provisioning profile của tài khoản đó. Workflow IPA chưa ký ở
  trên không thay thế được bước này.

## Bản Android — APK đã ký + tự cập nhật trong app

Workflow riêng `.github/workflows/android-build.yml` build bản Android trên
máy Ubuntu của GitHub Actions (JDK 17, Android SDK platform/build-tools 37,
NDK r27, Rust targets Android). Project Gradle (`desktop/src-tauri/gen/android`)
được lệnh `npx tauri android init --ci` sinh ngay trong CI mỗi lần chạy —
không commit vào repo. Sau khi init, workflow vá cấu hình ký release và hai
đảm bảo trong AndroidManifest sinh ra (quyền `REQUEST_INSTALL_PACKAGES` và
intent-filter deep link `ankilearning://`) kèm bước kiểm tra cứng — nếu vá
không trúng thì build dừng ngay chứ không ra APK thiếu ký/thiếu deep link.

Kết quả là **một file `AnkiLearning-Android.apk` duy nhất** chứa cả hai kiến
trúc **arm64-v8a + armeabi-v7a** (hầu hết điện thoại Android vật lý đều chạy
được), và APK **đã ký bằng keystore riêng của dự án**.

Cách chạy:

1. Vào GitHub → Actions → **Android Build (Signed APK)** → **Run workflow**
   (chạy từ nhánh `main`), hoặc push tag dạng `android-v<version>`, ví dụ
   `android-v1.0.4`.
2. Tải file `AnkiLearning-Android.apk` ở mục Artifacts của lần chạy. Nếu chạy
   bằng tag hoặc chạy tay từ `main`, file cũng được đính kèm vào GitHub
   Release tên `android-v<version>`, đồng thời workflow cập nhật manifest
   `android-latest.json` trong release cố định `android-latest` (xem cơ chế
   tự cập nhật bên dưới).

### Cài lần đầu trên điện thoại

Tải file APK về điện thoại, mở file và **cho phép "cài ứng dụng từ nguồn
này"** khi Android hỏi. Đây là bước bắt buộc một lần với mọi app cài ngoài
Google Play (sideload), không phải lỗi của app.

### Cơ chế tự cập nhật — giống bản PC, không qua Play Store

1. Mỗi lần phát hành, workflow ghi đè `android-latest.json` trong release cố
   định **`android-latest`**, dạng:
   `{"version": "1.0.4", "apkUrl": "https://github.com/hieuka001/Ankilearning/releases/download/android-v1.0.4/AnkiLearning-Android.apk", "notes": "..."}`.
2. Vài giây sau khi mở app, **chỉ bản Android** (mã `cfg(target_os =
   "android")` trong `src-tauri/src/lib.rs`) tải manifest này về và so sánh
   phiên bản với bản đang chạy. Mới hơn thì hiện hộp thoại native "Có bản
   AnkiLearning mới — **Cập nhật ngay / Để sau**". Mọi lỗi mạng/tải đều im
   lặng như luồng kiểm tra của bản PC.
3. Chọn **Cập nhật ngay**: app tự tải APK về thư mục cache của chính nó rồi
   mở **trình cài đặt hệ thống của Android** cho file đó, thông qua plugin
   nội bộ `desktop/plugins/tauri-plugin-apk-installer/` — plugin này dùng
   FileProvider mà project sinh ra đã khai sẵn để tạo content URI, kèm đúng
   loại file APK và quyền đọc tạm (plugin opener thường không làm được việc
   này vì nó chỉ bắn intent xem file trần, không MIME, không quyền đọc).
   Người dùng chỉ phải **chạm "Cài đặt" một lần** trên màn hình của Android.
   Lần cập nhật đầu tiên, Android có thể hỏi thêm quyền cho phép AnkiLearning
   tự cài bản cập nhật — đây là quy định của Android cho app sideload, app
   không bỏ qua được. Nếu khâu tải/mở trình cài đặt lỗi, app dự phòng bằng
   cách mở `apkUrl` trong trình duyệt hệ thống để tải và chạm cài thủ công.
4. `versionCode` của APK do Tauri CLI tự suy từ phiên bản vỏ (1.0.4 →
   1000004) nên chỉ cần tăng `version` là Android nhận bản mới là bản nâng
   cấp hợp lệ.

### Keystore là bí mật sống còn của việc cập nhật

Android chỉ cho cài đè bản mới lên bản cũ khi **cùng chữ ký** và versionCode
cao hơn. Keystore tải lên (upload keystore) được giải mã trong CI từ secret
`ANDROID_KEYSTORE_BASE64`; file `keystore.properties` sinh ra trong CI (không
commit) trỏ cấu hình ký release của Gradle tới nó. **Mất keystore hoặc mất
mật khẩu = không bản APK nào cập nhật đè được nữa** — mọi người dùng sẽ phải
gỡ app cài lại từ đầu và mất trạng thái cục bộ. Hãy giữ một bản sao lưu
keystore + mật khẩu ở nơi an toàn ngoài GitHub. Bốn secret workflow cần:

| Secret | Nội dung |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Chuỗi base64 của file keystore (`.jks`) |
| `ANDROID_KEYSTORE_PASSWORD` | Mật khẩu keystore (store password) |
| `ANDROID_KEY_ALIAS` | Tên alias của khoá trong keystore |
| `ANDROID_KEY_PASSWORD` | Mật khẩu của khoá (có thể trùng mật khẩu keystore) |

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

Repo đã ở chế độ **public** — file trong GitHub Releases tải tự do không cần
đăng nhập, và `latest.json` công khai để các bản đã cài tự kiểm tra cập nhật.
