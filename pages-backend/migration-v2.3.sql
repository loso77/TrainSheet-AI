CREATE TABLE IF NOT EXISTS correction_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track INTEGER NOT NULL CHECK(track BETWEEN 31 AND 61),
  field TEXT NOT NULL CHECK(field IN ('time','train_number')),
  predicted TEXT NOT NULL,
  corrected TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(track, field, predicted, corrected)
);

CREATE INDEX IF NOT EXISTS idx_correction_memory_rank
ON correction_memory(field, occurrences DESC, updated_at DESC);
