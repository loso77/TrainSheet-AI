CREATE TABLE IF NOT EXISTS rate_limits(bucket TEXT NOT NULL,key_value TEXT NOT NULL,window_start INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(bucket,key_value,window_start));
CREATE TABLE IF NOT EXISTS daily_usage(day TEXT NOT NULL,subject TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,subject));
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
CREATE INDEX IF NOT EXISTS idx_daily_usage_day ON daily_usage(day);
