-- Hotels waiting to be written about
CREATE TABLE IF NOT EXISTS topics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_name    TEXT NOT NULL,
  area          TEXT,                         -- optional hint, e.g. "Seminyak"
  priority      INTEGER NOT NULL DEFAULT 0,   -- higher runs first
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | skipped | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  post_id       TEXT,
  post_url      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name ON topics (lower(hotel_name));
CREATE INDEX IF NOT EXISTS idx_topics_status ON topics (status, priority DESC, id);

-- Everything already on the blog (synced from Blogger + new posts). Used for dedupe + internal links.
CREATE TABLE IF NOT EXISTS posts (
  post_id     TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  norm_title  TEXT NOT NULL,
  url         TEXT,
  labels      TEXT,          -- comma-separated
  status      TEXT,          -- LIVE | DRAFT | SCHEDULED
  published   TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_norm ON posts (norm_title);

-- One row per workflow run
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  topic_id      INTEGER,
  status        TEXT NOT NULL,   -- running | published | drafted | skipped | failed | empty
  post_id       TEXT,
  post_url      TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  web_searches  INTEGER,
  sources       TEXT,            -- JSON array of URLs the agent used
  agent_notes   TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT
);

-- Key/value settings (stores the Blogger refresh token after the OAuth flow)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
