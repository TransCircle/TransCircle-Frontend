-- Migration 001: Idempotency cache table
-- api.md §12 幂等性: stores (userId, key) → (fingerprint, responseSnapshot) for 24h

CREATE TABLE IF NOT EXISTS idempotency_cache (
    id             VARCHAR(64)   NOT NULL PRIMARY KEY,
    cacheKey       VARCHAR(255)  NOT NULL,
    fingerprint    VARCHAR(128)  NOT NULL,
    responseBody   JSON          NULL,
    expiresAt      BIGINT        NOT NULL,
    createdAt      BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (cacheKey),
    INDEX idx_idempotency_expires (expiresAt)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;
