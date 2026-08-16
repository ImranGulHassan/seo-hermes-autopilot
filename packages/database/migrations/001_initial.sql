CREATE TABLE IF NOT EXISTS sites (
  id text PRIMARY KEY,
  url text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  data_state text NOT NULL CHECK (data_state IN ('technical-only', 'search-performance')),
  artifact jsonb NOT NULL
);

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_data_state_check;
ALTER TABLE runs ADD CONSTRAINT runs_data_state_check
  CHECK (data_state IN ('technical-only', 'search-performance', 'analytics-enriched'));

CREATE TABLE IF NOT EXISTS opportunities (
  id text PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  type text NOT NULL,
  estimated_value double precision NOT NULL,
  payload jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS changes (
  id text PRIMARY KEY,
  opportunity_id text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL,
  github_owner text,
  github_repository text,
  github_pr_number integer,
  github_head_branch text,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (github_owner, github_repository, github_pr_number)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opportunities_site_value_idx ON opportunities(site_id, estimated_value DESC);
CREATE INDEX IF NOT EXISTS changes_state_idx ON changes(state);
