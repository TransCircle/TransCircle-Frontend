-- Migration: Change contributions.authorUserId FK from SET NULL to RESTRICT
-- and create an anonymous reference user for GDPR-deleted content.
--
-- Per api.md §15.11: contributions.authorUserId must be ON DELETE RESTRICT.
-- When a user is fully deleted (GDPR), their contributions are reassigned to
-- a shared anonymous user rather than set to NULL.

-- 1. Create anonymous reference user for orphaned content per api.md §2.4
INSERT IGNORE INTO users (id, username, email, displayName, passwordHash, status, createdAt, updatedAt)
VALUES ('usr_00000000000000000000000000', 'anonymous', NULL, 'Deleted User', NULL, 'deleted', 0, 0);

-- 2. Reassign any existing orphaned contributions to the anonymous user
UPDATE contributions SET authorUserId = 'usr_00000000000000000000000000'
WHERE authorUserId IS NULL;

-- 3. Change FK constraint (requires dropping and recreating)
ALTER TABLE contributions DROP FOREIGN KEY contributions_ibfk_1;
ALTER TABLE contributions MODIFY authorUserId VARCHAR(64) NOT NULL DEFAULT 'usr_00000000000000000000000000';
ALTER TABLE contributions ADD CONSTRAINT contributions_author_fk
  FOREIGN KEY (authorUserId) REFERENCES users (id) ON DELETE RESTRICT;
