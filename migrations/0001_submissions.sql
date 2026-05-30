-- Migration 0001: Full TransCircle schema (matches apidocs.md §15)

CREATE TABLE IF NOT EXISTS contributions (
  id                TEXT PRIMARY KEY,
  author_user_id    TEXT,
  title             TEXT NOT NULL,
  summary           TEXT,
  content_raw       TEXT NOT NULL,
  content_html      TEXT,
  content_format    TEXT NOT NULL DEFAULT 'markdown',
  renderer_version  TEXT,
  category          TEXT,
  author_name       TEXT,
  author_type       TEXT NOT NULL DEFAULT 'anonymous',
  contact           TEXT,
  submitter_gh      TEXT,
  submitter_x       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  version           INTEGER NOT NULL DEFAULT 1,
  language          TEXT NOT NULL DEFAULT 'zh-CN',
  tags              TEXT NOT NULL DEFAULT '[]',
  reviewer_gh       TEXT,
  review_notes      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  reviewed_at       INTEGER,
  published_at      INTEGER,
  submitter_ip_hash TEXT,
  submitter_ua_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status);
CREATE INDEX IF NOT EXISTS idx_contributions_created ON contributions(created_at DESC);

CREATE TABLE IF NOT EXISTS contribution_review_events (
  id              TEXT PRIMARY KEY,
  contribution_id TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  action          TEXT NOT NULL,
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  public_note     TEXT,
  internal_note   TEXT,
  created_at      INTEGER NOT NULL,
  request_id      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_events_contrib ON contribution_review_events(contribution_id, created_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash       TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  username         TEXT NOT NULL,
  is_admin         INTEGER NOT NULL DEFAULT 0,
  token_version    INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  rotated_to_hash  TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  used_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

CREATE TABLE IF NOT EXISTS login_codes (
  code_hash   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  provider    TEXT NOT NULL,
  username    TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  token_hash           TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  provider_user_id     TEXT NOT NULL,
  provider_username    TEXT NOT NULL,
  provider_email       TEXT,
  provider_display_name TEXT,
  provider_avatar_url  TEXT,
  mode                 TEXT NOT NULL,
  user_id              TEXT,
  expires_at           INTEGER NOT NULL,
  used_at              INTEGER,
  created_at           INTEGER NOT NULL
);
