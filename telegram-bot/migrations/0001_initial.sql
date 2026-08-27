PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guides (
  guide_key TEXT PRIMARY KEY, title TEXT NOT NULL, document_file_id TEXT, document_url TEXT,
  delivery_text TEXT, post_text TEXT, post_image_file_id TEXT,
  post_parse_mode TEXT NOT NULL DEFAULT 'HTML', consultation_text TEXT,
  consultation_button_text TEXT, consultation_url TEXT, followup_text TEXT,
  followup_button_text TEXT, followup_url TEXT, followup_delay_minutes INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activations (
  guide_key TEXT NOT NULL, user_id TEXT NOT NULL, activated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (guide_key, user_id), FOREIGN KEY (guide_key) REFERENCES guides(guide_key),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  guide_key TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
  reserved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT, last_error TEXT, PRIMARY KEY (guide_key, user_id),
  FOREIGN KEY (guide_key) REFERENCES guides(guide_key), FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS published_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guide_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL, scheduled_post_id INTEGER, published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chat_id, message_id), FOREIGN KEY (guide_key) REFERENCES guides(guide_key)
);

CREATE TABLE IF NOT EXISTS user_topics (
  user_id TEXT PRIMARY KEY, support_chat_id TEXT NOT NULL, topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (support_chat_id, topic_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guide_key TEXT NOT NULL, publish_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', created_by TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, lease_until TEXT, last_error TEXT, published_chat_id TEXT,
  published_message_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (guide_key) REFERENCES guides(guide_key)
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, draft_key TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
  source_chat_id TEXT, source_message_id INTEGER, body_text TEXT, status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, confirmed_at TEXT, completed_at TEXT
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  broadcast_id INTEGER NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT, sent_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (broadcast_id, user_id),
  FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, guide_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'followup', body_text TEXT NOT NULL, button_text TEXT, button_url TEXT,
  send_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (user_id, guide_key, kind),
  FOREIGN KEY (guide_key) REFERENCES guides(guide_key), FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE IF NOT EXISTS pending_actions (
  chat_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+30 minutes')), PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS incoming_updates (
  update_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT, last_error TEXT,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_guides_active ON guides(active, guide_key);
CREATE INDEX IF NOT EXISTS idx_activations_guide ON activations(guide_key);
CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, next_attempt_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_guide_status ON deliveries(guide_key, status);
CREATE INDEX IF NOT EXISTS idx_published_posts_guide ON published_posts(guide_key);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_posts(status, publish_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_status ON broadcasts(status, id);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_due ON broadcast_recipients(broadcast_id, status, next_attempt_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(status, send_at, next_attempt_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_updates_due ON incoming_updates(status, next_attempt_at, received_at);

