CREATE TABLE IF NOT EXISTS power_observations (
  id BIGSERIAL PRIMARY KEY,
  timestamp_utc TIMESTAMPTZ NOT NULL,
  signal TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL DEFAULT 'MWh',
  source TEXT NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'actual',
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (timestamp_utc, signal, source, data_type)
);

CREATE INDEX IF NOT EXISTS idx_power_observations_signal_time
  ON power_observations (signal, timestamp_utc DESC);

CREATE TABLE IF NOT EXISTS weather_observations (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  hdd DOUBLE PRECISION,
  cdd DOUBLE PRECISION,
  tdd DOUBLE PRECISION,
  source TEXT NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'actual',
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, source, data_type)
);

CREATE INDEX IF NOT EXISTS idx_weather_observations_date
  ON weather_observations (date DESC);

CREATE TABLE IF NOT EXISTS data_fetch_log (
  id BIGSERIAL PRIMARY KEY,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  dataset TEXT,
  status TEXT NOT NULL,
  rows_fetched INTEGER DEFAULT 0,
  error TEXT
);
