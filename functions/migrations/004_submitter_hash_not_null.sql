-- Migration 004: Make submitterIpHash and submitterUserAgentHash NOT NULL
-- Per api.md §15.11, these columns should be NOT NULL.
-- Backfill any existing NULL rows before applying the constraint.

UPDATE contributions SET submitterIpHash = '' WHERE submitterIpHash IS NULL;
UPDATE contributions SET submitterUserAgentHash = '' WHERE submitterUserAgentHash IS NULL;

ALTER TABLE contributions
  MODIFY COLUMN submitterIpHash VARCHAR(64) NOT NULL,
  MODIFY COLUMN submitterUserAgentHash VARCHAR(64) NOT NULL;
