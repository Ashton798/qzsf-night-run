CREATE TABLE IF NOT EXISTS qz_students (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  college TEXT NOT NULL,
  class_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  password_hash TEXT,
  profile_verified_at TIMESTAMPTZ NOT NULL,
  privacy_consent_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE qz_students ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS qz_auth_failures (
  student_key TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS qz_student_sessions (
  token_hash TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES qz_students(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS qz_student_sessions_student_idx ON qz_student_sessions(student_id, expires_at);

CREATE TABLE IF NOT EXISTS qz_verification_codes (
  id BIGSERIAL PRIMARY KEY,
  student_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS qz_verification_codes_lookup_idx ON qz_verification_codes(student_id, phone, created_at DESC);

CREATE TABLE IF NOT EXISTS qz_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  registration_status TEXT NOT NULL DEFAULT 'open',
  event_status TEXT NOT NULL DEFAULT 'upcoming',
  colleges_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE qz_events ADD COLUMN IF NOT EXISTS colleges_json JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS qz_registrations (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES qz_students(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES qz_events(id) ON DELETE CASCADE,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'registered',
  UNIQUE(student_id, event_id)
);
CREATE INDEX IF NOT EXISTS qz_registrations_event_idx ON qz_registrations(event_id, registered_at);

CREATE TABLE IF NOT EXISTS qz_run_sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES qz_students(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES qz_events(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  distance_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  location_consent_at TIMESTAMPTZ NOT NULL,
  paused_at TIMESTAMPTZ,
  paused_seconds INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  gap_count INTEGER NOT NULL DEFAULT 0,
  quality_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qz_run_sessions_student_idx ON qz_run_sessions(student_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS qz_run_one_active_idx ON qz_run_sessions(student_id, event_id) WHERE status IN ('running', 'paused');

CREATE TABLE IF NOT EXISTS qz_location_points (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES qz_run_sessions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES qz_students(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  display_latitude DOUBLE PRECISION,
  display_longitude DOUBLE PRECISION,
  accuracy DOUBLE PRECISION,
  speed DOUBLE PRECISION,
  heading DOUBLE PRECISION,
  altitude DOUBLE PRECISION,
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  coordinate_system TEXT NOT NULL DEFAULT 'wgs84',
  validity_status TEXT NOT NULL DEFAULT 'accepted',
  validity_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_backfill BOOLEAN NOT NULL DEFAULT FALSE,
  segment_no INTEGER NOT NULL DEFAULT 0,
  distance_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS qz_location_points_session_idx ON qz_location_points(session_id, seq);

CREATE TABLE IF NOT EXISTS qz_run_interruptions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES qz_run_sessions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES qz_students(id) ON DELETE CASCADE,
  interruption_type TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO qz_events (id, title, start_time, end_time, registration_status, event_status)
VALUES ('qzsf-2025', '泉州师范学院第九届校园荧光夜跑', '2026-12-03 18:00:00+08', NULL, 'open', 'upcoming')
ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title;

-- Values reused from server/defaults.js; administrators can update this list in event settings.
UPDATE qz_events SET colleges_json='["数学与计算机科学学院","物理与信息工程学院","化学与材料学院","海洋与食品学院","资源与环境科学学院","陈守仁商学院","文学与传播学院","外国语学院","教育科学学院","音乐与舞蹈学院","美术与设计学院","体育学院","应用科技学院（航海学院）","马克思主义学院"]'::jsonb WHERE id='qzsf-2025' AND colleges_json='[]'::jsonb;
