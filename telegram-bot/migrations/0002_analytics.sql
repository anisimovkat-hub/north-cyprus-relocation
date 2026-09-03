-- Additive migration: never rewrites guide activations, deliveries, or other bots' data.
CREATE TABLE IF NOT EXISTS traffic_sources (
  source_key TEXT PRIMARY KEY, title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO traffic_sources(source_key,title) VALUES
 ('unknown_history','История: источник не определён'),
 ('untagged','Без метки / прямой запуск'),
 ('channel','Кнопка поста в канале'),
 ('landing_team','Лендинг: релокация команды'),
 ('landing_company','Лендинг: открытие компании');
CREATE TABLE IF NOT EXISTS bot_starts (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id),
  source_key TEXT NOT NULL REFERENCES traffic_sources(source_key),
  first_started_at TEXT NOT NULL,
  historical INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bot_start_events (
  event_key TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),
  guide_key TEXT REFERENCES guides(guide_key),
  source_key TEXT NOT NULL REFERENCES traffic_sources(source_key),
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guide_attribution (
  guide_key TEXT NOT NULL REFERENCES guides(guide_key),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  source_key TEXT NOT NULL REFERENCES traffic_sources(source_key),
  activated_at TEXT NOT NULL,
  PRIMARY KEY(guide_key,user_id)
);
-- Guide activation proves a bot start; retained private /start messages additionally
-- recover starts without a guide. Do not equate arbitrary users with bot activations.
INSERT OR IGNORE INTO bot_starts(user_id,source_key,first_started_at,historical)
SELECT user_id,'unknown_history',MIN(at),1 FROM (
 SELECT user_id,activated_at at FROM activations
 UNION ALL
 SELECT CAST(json_extract(i.payload_json,'$.message.from.id') AS TEXT),
        datetime(json_extract(i.payload_json,'$.message.date'),'unixepoch')
 FROM incoming_updates i
 JOIN users u ON u.user_id=CAST(json_extract(i.payload_json,'$.message.from.id') AS TEXT)
 WHERE json_extract(i.payload_json,'$.message.chat.type')='private'
 AND (json_extract(i.payload_json,'$.message.text')='/start'
   OR json_extract(i.payload_json,'$.message.text') LIKE '/start %'
   OR json_extract(i.payload_json,'$.message.text')='/start@zapasnoy_aerodrom_bot'
   OR json_extract(i.payload_json,'$.message.text') LIKE '/start@zapasnoy_aerodrom_bot %')
) WHERE at IS NOT NULL GROUP BY user_id;
INSERT OR IGNORE INTO guide_attribution(guide_key,user_id,source_key,activated_at)
SELECT guide_key,user_id,'unknown_history',activated_at FROM activations;
CREATE INDEX IF NOT EXISTS idx_bot_starts_time ON bot_starts(first_started_at,source_key);
CREATE INDEX IF NOT EXISTS idx_start_events_time ON bot_start_events(started_at,user_id);
CREATE INDEX IF NOT EXISTS idx_attribution_source ON guide_attribution(source_key,guide_key,user_id);
CREATE INDEX IF NOT EXISTS idx_activations_time ON activations(activated_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_time ON deliveries(delivered_at,status);
INSERT OR IGNORE INTO settings(setting_key,setting_value)
VALUES ('analytics_started_at',CURRENT_TIMESTAMP);
