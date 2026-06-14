-- Add expiresAt index to refresh_token_events for efficient cleanup (api.md §15.5)
CREATE INDEX idx_rt_expiresAt ON refresh_token_events (expiresAt);
