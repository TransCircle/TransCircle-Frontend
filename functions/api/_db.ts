// Shared D1 schema initialization
// Called by all API handlers that need the submissions table

let schemaReady = false

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS submissions (
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
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC)'),
  ])
  schemaReady = true
}
