CREATE TABLE users
(
    id                VARCHAR(64)  NOT NULL PRIMARY KEY,
    username          VARCHAR(32)  NOT NULL UNIQUE,
    email             VARCHAR(254) NULL UNIQUE,
    emailVerified     BOOLEAN      NOT NULL DEFAULT FALSE,
    displayName       VARCHAR(50)  NOT NULL,
    avatarUrl         VARCHAR(512) NULL,
    passwordHash      VARCHAR(255) NULL,
    passwordUpdatedAt BIGINT       NULL,
    passwordHistory   JSON         NOT NULL DEFAULT ('[]'),
    tokenVersion      BIGINT       NOT NULL DEFAULT 0,
    status            VARCHAR(32)  NOT NULL DEFAULT 'pending_verification' CHECK (status IN
                                                                                  ('active',
                                                                                   'banned',
                                                                                   'merged',
                                                                                   'pending_verification',
                                                                                   'pending_deletion',
                                                                                   'deleted')),
    mergedIntoUserId     VARCHAR(64)  NULL,
    deletedAt            BIGINT       NULL,
    emailVerifiedSource  VARCHAR(64)  NULL COMMENT '记录来源: oauth:github / oauth:x / platform',
    createdAt            BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    updatedAt         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    lastLoginAt       BIGINT       NULL,

    INDEX idx_status (status),
    INDEX idx_createdAt (createdAt),

    FOREIGN KEY (mergedIntoUserId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE oauth_accounts
(
    id                  VARCHAR(64)  NOT NULL PRIMARY KEY,
    userId              VARCHAR(64)  NOT NULL,
    provider            VARCHAR(16)  NOT NULL CHECK (provider IN ('github', 'x')),
    providerUserId      VARCHAR(64)  NOT NULL,
    providerUsername    VARCHAR(64)  NULL,
    providerDisplayName VARCHAR(100) NULL,
    providerAvatarUrl   VARCHAR(512) NULL,
    providerEmail       VARCHAR(254) NULL,
    createdAt           BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    updatedAt           BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (provider, providerUserId),
    UNIQUE (userId, provider),
    INDEX idx_oauth_userId (userId),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE auth_tokens
(
    id             VARCHAR(64)  NOT NULL PRIMARY KEY,
    userId         VARCHAR(64)  NULL,
    type           VARCHAR(32)  NOT NULL CHECK (type IN ('email_verify',
                                                         'password_reset',
                                                         'merge',
                                                         'mfa_challenge',
                                                         'passkey_register',
                                                         'passkey_login',
                                                         'totp_setup',
                                                         'oauth_state',
                                                         'oauth_login_code',
                                                         'oauth_pending_registration',
                                                         'account_delete_cancel',
                                                         'step_up_challenge')),
    tokenHash      VARCHAR(128) NOT NULL,
    metadata       JSON         NOT NULL DEFAULT ('{}'),
    failedAttempts INT          NOT NULL DEFAULT 0,
    expiresAt      BIGINT       NOT NULL,
    usedAt         BIGINT       NULL,
    createdAt      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (tokenHash),
    INDEX idx_auth_user_type (userId, type),
    INDEX idx_auth_expiresAt (expiresAt),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE sessions
(
    id               VARCHAR(64) NOT NULL PRIMARY KEY,
    userId           VARCHAR(64) NOT NULL,
    createdAt        BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    lastUsedAt       BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    expiresAt        BIGINT      NOT NULL,
    revokedAt        BIGINT      NULL,
    revokedReason    VARCHAR(32) NULL CHECK (revokedReason IS NULL OR
                                             revokedReason IN
                                             ('logout', 'logout_all',
                                              'password_changed',
                                              'refresh_reuse_detected',
                                              'account_banned',
                                              'account_merged',
                                              'account_pending_deletion',
                                              'role_changed', 'manual_revoke',
                                              'user_revoked', 'oauth_unbound')),
    ipHash           VARCHAR(64) NOT NULL,
    ipPrefix         VARCHAR(64) NOT NULL,
    userAgentHash    VARCHAR(64) NOT NULL,
    deviceSummary    JSON        NOT NULL DEFAULT ('{}'),
    lastStepUpAt     BIGINT      NULL,
    lastStepUpMethod VARCHAR(16) NULL CHECK (lastStepUpMethod IS NULL OR
                                             lastStepUpMethod IN
                                             ('password', 'passkey', 'totp',
                                              'recovery_code')),
    loginMethod      VARCHAR(32) NOT NULL DEFAULT 'password' CHECK (loginMethod IN
                                                                    ('password',
                                                                     'passkey',
                                                                     'oauth:github',
                                                                     'oauth:x')),

    INDEX idx_sessions_user_revoked (userId, revokedAt),
    INDEX idx_sessions_expiresAt (expiresAt),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE refresh_token_events
(
    id            VARCHAR(64)  NOT NULL PRIMARY KEY,
    sessionId     VARCHAR(64)  NOT NULL,
    tokenHash     VARCHAR(128) NOT NULL,
    tokenPrefix   VARCHAR(16)  NOT NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'active' CHECK (status IN
                                                                ('active',
                                                                 'rotated',
                                                                 'reused',
                                                                 'revoked')),
    rotatedToHash VARCHAR(128) NULL,
    createdAt     BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    expiresAt     BIGINT       NOT NULL,
    usedAt        BIGINT       NULL,

    UNIQUE (tokenHash),
    INDEX idx_rt_events_session (sessionId, createdAt),
    INDEX idx_rt_expiresAt (expiresAt),

    FOREIGN KEY (sessionId) REFERENCES sessions (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE mfa_totp_credentials
(
    id               VARCHAR(64)    NOT NULL PRIMARY KEY,
    userId           VARCHAR(64)    NOT NULL,
    secretEncrypted  VARBINARY(256) NOT NULL,
    status           VARCHAR(16)    NOT NULL DEFAULT 'pending' CHECK (status IN
                                                                      ('pending',
                                                                       'active',
                                                                       'frozen',
                                                                       'disabled')),
    algorithm        VARCHAR(16)    NOT NULL DEFAULT 'SHA1',
    digits           TINYINT        NOT NULL DEFAULT 6,
    `period`         SMALLINT       NOT NULL DEFAULT 30,
    lastUsedTimeStep BIGINT         NULL,
    createdAt        BIGINT         NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    enabledAt        BIGINT         NULL,
    lastUsedAt       BIGINT         NULL,

    INDEX idx_mfa_totp_user (userId),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

DELIMITER //
CREATE TRIGGER trg_mfa_totp_unique_active_insert
    BEFORE INSERT
    ON mfa_totp_credentials
    FOR EACH ROW
BEGIN
    IF NEW.status = 'active' AND EXISTS (SELECT 1
                                         FROM mfa_totp_credentials
                                         WHERE userId = NEW.userId
                                           AND status = 'active') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '每个用户只能有一个 active 的 TOTP 凭据';
    END IF;
END//
DELIMITER ;

CREATE TABLE mfa_recovery_codes
(
    id        VARCHAR(64)  NOT NULL PRIMARY KEY,
    userId    VARCHAR(64)  NOT NULL,
    codeHash  VARCHAR(255) NOT NULL,
    usedAt    BIGINT       NULL,
    createdAt BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (codeHash),
    INDEX idx_mfa_recovery_user_used (userId, usedAt),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE passkeys
(
    id                 VARCHAR(64)     NOT NULL PRIMARY KEY,
    userId             VARCHAR(64)     NOT NULL,
    name               VARCHAR(50)     NOT NULL,
    credentialId       VARBINARY(1024) NOT NULL,
    credentialIdB64    VARCHAR(1024)   NOT NULL,
    publicKey          VARBINARY(1024) NOT NULL,
    signCount          BIGINT          NOT NULL DEFAULT 0,
    transports         JSON            NOT NULL DEFAULT ('[]'),
    aaguid             VARCHAR(36)     NULL,
    attestationFormat  VARCHAR(32)     NULL,
    backupEligible     BOOLEAN         NOT NULL DEFAULT FALSE,
    backupState        BOOLEAN         NOT NULL DEFAULT FALSE,
    signCountSupported BOOLEAN         NOT NULL DEFAULT TRUE,
    status             VARCHAR(16)     NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
    frozenReason       VARCHAR(64)     NULL,
    createdAt          BIGINT          NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    lastUsedAt         BIGINT          NULL,

    UNIQUE (credentialIdB64(191)),
    UNIQUE (credentialId),
    INDEX idx_passkeys_user_status (userId, status),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE roles
(
    id          VARCHAR(64)  NOT NULL PRIMARY KEY,
    name        VARCHAR(32)  NOT NULL CHECK (name IN ('admin', 'editor', 'reviewer')),
    description VARCHAR(200) NULL,
    createdAt   BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (name)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE user_roles
(
    id        VARCHAR(64) NOT NULL PRIMARY KEY,
    userId    VARCHAR(64) NOT NULL,
    roleId    VARCHAR(64) NOT NULL,
    grantedBy VARCHAR(64) NOT NULL,
    createdAt BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    expiresAt BIGINT      NULL,

    UNIQUE (userId, roleId),
    INDEX idx_user_roles_user (userId),

    FOREIGN KEY (userId) REFERENCES users (id) ON DELETE CASCADE,
    FOREIGN KEY (roleId) REFERENCES roles (id) ON DELETE RESTRICT,
    FOREIGN KEY (grantedBy) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE contributions
(
    id                     VARCHAR(64)  NOT NULL PRIMARY KEY,
    authorUserId           VARCHAR(64)  NOT NULL,
    title                  VARCHAR(120) NOT NULL,
    summary                VARCHAR(300) NULL,
    contentRaw             TEXT         NOT NULL,
    contentFormat          VARCHAR(16)  NOT NULL CHECK (contentFormat IN ('markdown', 'plain_text')),
    contentHtml            TEXT         NOT NULL,
    rendererVersion        VARCHAR(64)  NOT NULL,
    status                 VARCHAR(16)  NOT NULL DEFAULT 'draft' CHECK (status IN
                                                                        ('draft',
                                                                         'pending',
                                                                         'in_review',
                                                                         'approved',
                                                                         'rejected',
                                                                         'published',
                                                                         'hidden',
                                                                         'withdrawn',
                                                                         'deleted')),
    version                INT          NOT NULL DEFAULT 1,
    language               VARCHAR(16)  NOT NULL DEFAULT 'zh-CN' CHECK (language IN
                                                                        ('zh-CN',
                                                                         'zh-TW',
                                                                         'en',
                                                                         'ja',
                                                                         'other')),
    tags                   JSON         NOT NULL DEFAULT ('[]'),
    idempotencyKey         VARCHAR(64)  NULL,
    createdAt              BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    updatedAt              BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    submittedAt            BIGINT       NULL,
    publishedAt            BIGINT       NULL,
    deletedAt              BIGINT       NULL,
    submitterIpHash        VARCHAR(64)  NOT NULL,
    submitterUserAgentHash VARCHAR(64)  NOT NULL,

    INDEX idx_contrib_author_created (authorUserId, createdAt),
    INDEX idx_contrib_status_created (status, createdAt),
    INDEX idx_contrib_publishedAt (publishedAt),
    UNIQUE (authorUserId, idempotencyKey),

    FOREIGN KEY (authorUserId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE contribution_review_events
(
    id             VARCHAR(64)   NOT NULL PRIMARY KEY,
    contributionId VARCHAR(64)   NOT NULL,
    reviewerUserId VARCHAR(64)   NOT NULL,
    action         VARCHAR(32)   NOT NULL CHECK (action IN
                                                 ('review', 'publish', 'hide',
                                                  'restore', 'delete',
                                                  'edit_request_resolve')),
    fromStatus     VARCHAR(16)   NOT NULL,
    toStatus       VARCHAR(16)   NOT NULL,
    publicNote     VARCHAR(500)  NULL,
    internalNote   VARCHAR(1000) NULL,
    createdAt      BIGINT        NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    requestId      VARCHAR(64)   NOT NULL,

    INDEX idx_rev_events_contribution (contributionId, createdAt),
    INDEX idx_rev_events_reviewer (reviewerUserId, createdAt),

    FOREIGN KEY (contributionId) REFERENCES contributions (id) ON DELETE CASCADE,
    FOREIGN KEY (reviewerUserId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE audit_logs
(
    id            VARCHAR(64) NOT NULL PRIMARY KEY,
    actorUserId   VARCHAR(64) NULL,
    action        VARCHAR(64) NOT NULL,
    resourceType  VARCHAR(32) NOT NULL,
    resourceId    VARCHAR(64) NULL,
    `before`      JSON        NULL,
    after         JSON        NULL,
    metadata      JSON        NOT NULL DEFAULT ('{}'),
    createdAt     BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    requestId     VARCHAR(64) NOT NULL,
    ipHash        VARCHAR(64) NOT NULL,
    userAgentHash VARCHAR(64) NOT NULL,
    prevHash      VARCHAR(64) NULL,
    entryHash     VARCHAR(64) NOT NULL,

    UNIQUE (entryHash),
    INDEX idx_audit_actor (actorUserId, createdAt),
    INDEX idx_audit_resource (resourceType, resourceId, createdAt),
    INDEX idx_audit_action (action, createdAt),

    FOREIGN KEY (actorUserId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

DELIMITER //
CREATE TRIGGER trg_audit_no_update
    BEFORE UPDATE
    ON audit_logs
    FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'audit_logs is append-only: UPDATE not allowed';
END//

CREATE TRIGGER trg_audit_no_delete
    BEFORE DELETE
    ON audit_logs
    FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT =
            'audit_logs is append-only: DELETE not allowed';
END//
DELIMITER ;

CREATE TABLE contribution_edit_requests
(
    id                    VARCHAR(64)  NOT NULL PRIMARY KEY,
    contributionId        VARCHAR(64)  NOT NULL,
    requesterId           VARCHAR(64)  NOT NULL,
    reason                VARCHAR(500) NOT NULL,
    proposedTitle         VARCHAR(120) NULL,
    proposedContent       TEXT         NULL,
    proposedContentFormat VARCHAR(16)  NULL CHECK (proposedContentFormat IS NULL OR
                                                   proposedContentFormat IN
                                                   ('markdown', 'plain_text')),
    proposedSummary       VARCHAR(300) NULL,
    proposedTags          JSON         NULL,
    status                VARCHAR(16)  NOT NULL DEFAULT 'pending' CHECK (status IN
                                                                         ('pending',
                                                                          'in_review',
                                                                          'approved',
                                                                          'rejected',
                                                                          'withdrawn')),
    version               INT          NOT NULL DEFAULT 1,
    createdAt             BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),
    updatedAt             BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    INDEX idx_edit_req_contribution (contributionId, createdAt),
    INDEX idx_edit_req_requester (requesterId, createdAt),
    INDEX idx_edit_req_status (status, createdAt),

    FOREIGN KEY (contributionId) REFERENCES contributions (id) ON DELETE RESTRICT,
    FOREIGN KEY (requesterId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE edit_request_votes
(
    id             VARCHAR(64)  NOT NULL PRIMARY KEY,
    editRequestId  VARCHAR(64)  NOT NULL,
    reviewerUserId VARCHAR(64)  NOT NULL,
    vote           VARCHAR(16)  NOT NULL CHECK (vote IN ('approve', 'reject')),
    note           VARCHAR(500) NULL,
    createdAt      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (editRequestId, reviewerUserId),
    INDEX idx_vote_edit_request (editRequestId, createdAt),

    FOREIGN KEY (editRequestId) REFERENCES contribution_edit_requests (id) ON DELETE CASCADE,
    FOREIGN KEY (reviewerUserId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE images
(
    id               VARCHAR(64)  NOT NULL PRIMARY KEY,
    uploaderId       VARCHAR(64)  NOT NULL,
    originalFilename VARCHAR(255) NULL,
    mimeType         VARCHAR(32)  NOT NULL CHECK (mimeType IN
                                                  ('image/jpeg', 'image/png',
                                                   'image/gif', 'image/webp')),
    size             BIGINT       NOT NULL,
    width            INT          NOT NULL,
    height           INT          NOT NULL,
    sha256           VARCHAR(64)  NOT NULL,
    storageKey       VARCHAR(255) NOT NULL,
    status           VARCHAR(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    deletedAt        BIGINT       NULL,
    createdAt        BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP(NOW()) * 1000),

    UNIQUE (sha256),
    INDEX idx_images_uploader (uploaderId, createdAt),

  FOREIGN KEY (uploaderId) REFERENCES users (id) ON DELETE RESTRICT
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

CREATE TABLE rate_limits
(
    id             VARCHAR(64)  NOT NULL PRIMARY KEY,
    bucketKey      VARCHAR(128) NOT NULL,
    windowStart    BIGINT       NOT NULL,
    count          INT          NOT NULL DEFAULT 1,
    createdAt      BIGINT       NOT NULL,

    INDEX idx_bucket (bucketKey, windowStart)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;