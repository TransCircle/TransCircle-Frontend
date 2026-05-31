-- Migration 0002: Users and OAuth accounts for stable identity
-- Per apidocs.md §1.4, §1.6

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  email           TEXT,
  display_name    TEXT,
  avatar_url      TEXT,
  password_hash   TEXT,
  email_verified  INTEGER NOT NULL DEFAULT 0,
  is_admin        INTEGER NOT NULL DEFAULT 0,
  token_version   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  provider            TEXT NOT NULL,
  provider_user_id    TEXT NOT NULL,
  provider_username   TEXT NOT NULL,
  provider_email      TEXT,
  provider_avatar_url TEXT,
  created_at          INTEGER NOT NULL,
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_accounts_provider ON oauth_accounts(provider, provider_user_id);
