-- =============================================================================
-- SWES — Seed data for a TEST database (FE-07 Users & Access)
-- Apply AFTER schema.sql:   psql -d <db> -f database/seed.sql
--
-- Mọi tài khoản dùng chung mật khẩu:  Wes@1234
-- Hash bcrypt được sinh trực tiếp bằng pgcrypto crypt()/gen_salt('bf') — tương
-- thích với bcrypt.compare ở backend. Idempotent: chạy lại không tạo trùng.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Users ───────────────────────────────────────────────────────────────────
INSERT INTO users
  (username, email, password_hash, full_name, phone, shift,
   is_active, is_locked, is_invited, lock_reason, last_login_at, created_at)
VALUES
  ('quan.tran',  'quan.tran@wes.vn',  crypt('Wes@1234', gen_salt('bf', 10)), 'Trần Minh Quân', '0901 234 567', 'Hành chính',          TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '2 minutes',  NOW() - INTERVAL '420 days'),
  ('ha.nguyen',  'ha.nguyen@wes.vn',  crypt('Wes@1234', gen_salt('bf', 10)), 'Nguyễn Thị Hà',  '0902 345 678', 'Hành chính',          TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '28 minutes', NOW() - INTERVAL '390 days'),
  ('nhu.duong',  'nhu.duong@wes.vn',  crypt('Wes@1234', gen_salt('bf', 10)), 'Dương Tố Như',   '0910 123 456', 'Hành chính',          TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '73 minutes', NOW() - INTERVAL '360 days'),
  ('dung.le',    'dung.le@wes.vn',    crypt('Wes@1234', gen_salt('bf', 10)), 'Lê Văn Dũng',    '0903 456 789', 'Ca A (06–14h)',       TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '6 minutes',  NOW() - INTERVAL '210 days'),
  ('trang.pham', 'trang.pham@wes.vn', crypt('Wes@1234', gen_salt('bf', 10)), 'Phạm Thu Trang', '0904 567 890', 'Ca A (06–14h)',       TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '41 minutes', NOW() - INTERVAL '205 days'),
  ('linh.vu',    'linh.vu@wes.vn',    crypt('Wes@1234', gen_salt('bf', 10)), 'Vũ Khánh Linh',  '0906 789 012', 'Ca B (14–22h)',       TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '120 minutes',NOW() - INTERVAL '165 days'),
  ('mai.bui',    'mai.bui@wes.vn',    crypt('Wes@1234', gen_salt('bf', 10)), 'Bùi Thị Mai',    '0908 901 234', 'Ca C (22–06h)',       TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '15 minutes', NOW() - INTERVAL '150 days'),
  ('nam.do',     'nam.do@wes.vn',     crypt('Wes@1234', gen_salt('bf', 10)), 'Đỗ Nhật Nam',    '0913 456 789', 'Ca A (06–14h)',       TRUE,  FALSE, FALSE, NULL, NOW() - INTERVAL '52 minutes', NOW() - INTERVAL '60 days'),
  ('tuan.hoang', 'tuan.hoang@wes.vn', crypt('Wes@1234', gen_salt('bf', 10)), 'Hoàng Anh Tuấn', '0905 678 901', 'Ca B (14–22h)',       TRUE,  TRUE,  FALSE, 'Tạm ngưng theo yêu cầu giám sát ca', NOW() - INTERVAL '3 days', NOW() - INTERVAL '180 days'),
  ('hang.cao',   'hang.cao@wes.vn',   crypt('Wes@1234', gen_salt('bf', 10)), 'Cao Thanh Hằng', '0912 345 678', 'Ca C (22–06h)',       TRUE,  TRUE,  FALSE, 'Quá nhiều lần đăng nhập sai',        NOW() - INTERVAL '8 days', NOW() - INTERVAL '95 days'),
  ('bao.dang',   'bao.dang@wes.vn',   crypt('Wes@1234', gen_salt('bf', 10)), 'Đặng Quốc Bảo',  '0907 890 123', 'Ca C (22–06h)',       FALSE, FALSE, TRUE,  NULL, NULL,                          NOW() - INTERVAL '2 days'),
  ('dang.ngo',   'dang.ngo@wes.vn',   crypt('Wes@1234', gen_salt('bf', 10)), 'Ngô Hải Đăng',   '0909 012 345', 'Ca A (06–14h)',       FALSE, FALSE, FALSE, NULL, NOW() - INTERVAL '46 days',    NOW() - INTERVAL '300 days')
ON CONFLICT (username) DO NOTHING;

-- ── Roles (idempotent — real grants are seeded by `npm run seed`) ───────────
INSERT INTO roles (name, key, description, is_system) VALUES
  ('Quản trị viên', 'admin',    'Toàn quyền hệ thống',              TRUE),
  ('Điều hành viên','operator', 'Điều hành kho vận',                TRUE),
  ('Người xem',     'viewer',   'Chỉ xem, không thao tác vận hành', TRUE)
ON CONFLICT (key) DO NOTHING;

-- ── Role assignment (one role per user) ──────────────────────────────────────
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u CROSS JOIN roles r
WHERE r.key = 'admin'
  AND u.username IN ('quan.tran', 'ha.nguyen', 'nhu.duong')
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u CROSS JOIN roles r
WHERE r.key = 'operator'
  AND u.username IN ('dung.le', 'trang.pham', 'linh.vu', 'mai.bui', 'nam.do',
                     'tuan.hoang', 'hang.cao', 'bao.dang', 'dang.ngo')
ON CONFLICT (user_id, role_id) DO NOTHING;

-- ── Default preferences ──────────────────────────────────────────────────────
INSERT INTO user_preferences (user_id, language, notifications_enabled, sound_enabled)
SELECT id, 'vi', TRUE, FALSE FROM users
ON CONFLICT (user_id) DO NOTHING;
