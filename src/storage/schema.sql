-- 设计规范手册 PostgreSQL schema（幂等，可重复执行）

CREATE TABLE IF NOT EXISTS scopes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('base', 'brand', 'theme')),
  name        TEXT NOT NULL,
  parent      TEXT REFERENCES scopes(id),
  extends     TEXT REFERENCES scopes(id),
  reference   TEXT REFERENCES scopes(id),
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tokens (
  scope       TEXT NOT NULL REFERENCES scopes(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  value       TEXT NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, name)
);

CREATE TABLE IF NOT EXISTS components (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  usages      JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT NOT NULL DEFAULT '',
  supported_token_version INTEGER NOT NULL DEFAULT 1,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS design_versions (
  id          TEXT PRIMARY KEY,
  number      INTEGER NOT NULL UNIQUE,
  label       TEXT,
  tokens      JSONB NOT NULL,
  components  JSONB NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS screenshot_jobs (
  id            TEXT PRIMARY KEY,
  component_id  TEXT NOT NULL,
  theme         TEXT NOT NULL,
  token_version INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'interrupted')),
  frames_total  INTEGER NOT NULL DEFAULT 0,
  frames_done   INTEGER NOT NULL DEFAULT 0,
  image_url     TEXT,
  source        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS confirmations (
  component_id  TEXT NOT NULL,
  theme         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('confirmed', 'needs_review')),
  token_version INTEGER NOT NULL,
  shot_id       TEXT REFERENCES screenshot_jobs(id),
  confirmed_by  TEXT,
  confirmed_at  TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  reasons       JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (component_id, theme)
);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  summary     JSONB NOT NULL,
  findings    JSONB NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
