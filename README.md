# MathDoc – Chuyển đề Toán PDF/ảnh sang Word

Ứng dụng một trang (chạy hoàn toàn trên trình duyệt):
Gemini đọc PDF/ảnh → Markdown + LaTeX → xem trước, sửa → xuất .docx có công thức Word Equation (OMML) và hình vẽ đã cắt.

## Dùng ngay
Mở `dist/index.html` bằng Chrome/Edge (bấm đúp là được), dán Gemini API key, kéo thả file.

## Đưa lên web (Vercel/Netlify)
- Netlify: vào app.netlify.com/drop, kéo thư mục `dist` vào là có link.
- Vercel: tạo repo GitHub chứa thư mục `dist` (đổi tên thành `public` hoặc đặt Output Directory = `dist`), Import vào Vercel.

## Sửa mã nguồn
```
npm install
node build.mjs      # tạo lại dist/index.html
```
- `src/main.js`   giao diện, quy trình, câu lệnh (prompt) gửi Gemini
- `src/gemini.js` gọi API Gemini (stream, đổi key khi hết lượt)
- `src/pages.js`  đọc PDF (pdf.js), cắt hình
- `src/md.js`     phân tích Markdown
- `src/docx.js`   dựng file Word: LaTeX → MathML (temml) → OMML (mathml2omml)

## Khoá chung của tổ (tuỳ chọn)
Trong Vercel → Project mathdoc → Settings → Environment Variables, thêm:
- `GEMINI_API_KEY`: khoá Gemini của tổ (nhiều khoá thì ngăn cách bằng dấu phẩy, tự đổi khi hết lượt)
- `MATHDOC_ACCESS_CODE`: mã truy cập phát cho giáo viên trong tổ
Sau đó Redeploy. Thiếu một trong hai biến thì chế độ khoá chung tự khoá lại.
Giới hạn của Vercel: mỗi lần gửi tối đa ~4,5 MB.

## Tự dò khoá dùng được
Nút “🔍 Tự dò khoá dùng được”: dán nhiều khoá, app gọi thử từng khoá (đúng/sai, đã bật Gemini API chưa, còn lượt trong ngày/phút không), rồi “Dùng các khoá tốt” để đặt khoá nhanh nhất làm khoá chính, các khoá còn lại làm dự phòng.
Ở chế độ khoá chung, máy chủ kiểm tra các khoá trong GEMINI_API_KEY và chỉ trả về khoá đã che bớt (`/api/keycheck`).
