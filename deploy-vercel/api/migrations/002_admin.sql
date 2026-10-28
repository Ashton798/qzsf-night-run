-- Additive migration only. Existing registrations and GPS samples are retained.
ALTER TABLE qz_events ADD COLUMN IF NOT EXISTS review_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE qz_run_sessions ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE qz_run_sessions ADD COLUMN IF NOT EXISTS review_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS qz_run_reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES qz_run_sessions(id),
  administrator TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT NOT NULL,
  evidence_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qz_reviews_session_idx ON qz_run_reviews(session_id,created_at DESC);
CREATE INDEX IF NOT EXISTS qz_runs_event_student_idx ON qz_run_sessions(event_id,student_id,created_at DESC);
CREATE TABLE IF NOT EXISTS qz_admin_login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '15 minutes'
);
