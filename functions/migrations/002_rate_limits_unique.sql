ALTER TABLE rate_limits ADD UNIQUE INDEX idx_rate_limits_bucketKey (bucketKey);
