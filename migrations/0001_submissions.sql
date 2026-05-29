-- Migration 0001: Create submissions table

CREATE TABLE IF NOT EXISTS submissions (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT NOT NULL,
  author_name   TEXT,
  author_type   TEXT NOT NULL DEFAULT 'anonymous',
  contact       TEXT,
  submitter_gh  TEXT,
  submitter_x   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  reviewer_gh   TEXT,
  review_notes  TEXT,
  created_at    TEXT NOT NULL,
  reviewed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC);
