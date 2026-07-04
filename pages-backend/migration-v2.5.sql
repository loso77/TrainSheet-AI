CREATE TABLE IF NOT EXISTS recognition_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_no INTEGER NOT NULL CHECK(table_no BETWEEN 31 AND 61),
  field_type TEXT NOT NULL CHECK(field_type IN ('train_number','track_name')),
  model_value TEXT NOT NULL DEFAULT '',
  old_value TEXT NOT NULL DEFAULT '',
  corrected_value TEXT NOT NULL DEFAULT '',
  modified INTEGER NOT NULL DEFAULT 0,
  ambiguity INTEGER NOT NULL DEFAULT 0,
  model_note TEXT NOT NULL DEFAULT '',
  review_reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recognition_feedback_recent
ON recognition_feedback(field_type, modified, ambiguity, created_at DESC);
