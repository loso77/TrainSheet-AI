-- V2.5.3 动态配置学习表：不再限制表号31—61。
CREATE TABLE IF NOT EXISTS correction_memory_dynamic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_no INTEGER NOT NULL,
  field_type TEXT NOT NULL CHECK(field_type IN ('train_number','track_name')),
  original_value TEXT NOT NULL DEFAULT '',
  corrected_value TEXT NOT NULL DEFAULT '',
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(table_no,field_type,original_value,corrected_value)
);
CREATE INDEX IF NOT EXISTS idx_correction_memory_dynamic_rank ON correction_memory_dynamic(field_type,hit_count DESC,updated_at DESC);

CREATE TABLE IF NOT EXISTS recognition_feedback_dynamic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_no INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_recognition_feedback_dynamic_recent ON recognition_feedback_dynamic(field_type,modified,ambiguity,created_at DESC);
