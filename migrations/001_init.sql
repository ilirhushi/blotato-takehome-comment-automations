CREATE TABLE automations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         text NOT NULL,
  platform           text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automations_enabled_by_account ON automations (account_id, platform) WHERE enabled;

CREATE TABLE automation_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id),
  trigger       jsonb NOT NULL,
  steps         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE automations ADD CONSTRAINT automations_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES automation_versions(id);

CREATE FUNCTION reject_version_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'automation_versions are immutable';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER automation_versions_immutable
  BEFORE UPDATE ON automation_versions
  FOR EACH ROW EXECUTE FUNCTION reject_version_update();

-- processed_at means "routed"; consumed_by_run_id means "a run took this DM as
-- its reply". They differ when a DM arrives before its run reaches the wait step.
CREATE TABLE inbound_events (
  id                 bigserial PRIMARY KEY,
  platform           text NOT NULL,
  platform_event_id  text NOT NULL,
  account_id         text NOT NULL,
  contact_id         text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('comment', 'dm')),
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL,
  processed_at       timestamptz,
  consumed_by_run_id uuid,
  UNIQUE (platform, platform_event_id)
);
CREATE INDEX inbound_events_unprocessed ON inbound_events (id) WHERE processed_at IS NULL;
CREATE INDEX inbound_events_contact_dms
  ON inbound_events (account_id, platform, contact_id, received_at)
  WHERE kind = 'dm';

-- wake_at depends on status:
--   status = running: do not run before this time (retry backoff, rate limit)
--   status = waiting: the reply deadline; the scheduler expires the run after it
CREATE TABLE runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id         uuid NOT NULL REFERENCES automations(id),
  automation_version_id uuid NOT NULL REFERENCES automation_versions(id),
  account_id            text NOT NULL,
  platform              text NOT NULL,
  contact_id            text NOT NULL,
  trigger_event_id      bigint NOT NULL REFERENCES inbound_events(id),
  status                text NOT NULL CHECK (status IN
                          ('running', 'waiting', 'completed', 'failed', 'expired', 'skipped')),
  current_step          int NOT NULL DEFAULT 0,
  context               jsonb NOT NULL DEFAULT '{}',
  wake_at               timestamptz,
  waiting_since         timestamptz,
  lease_until           timestamptz,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, trigger_event_id)
);
CREATE UNIQUE INDEX runs_one_active_per_contact
  ON runs (account_id, platform, contact_id)
  WHERE status IN ('running', 'waiting');
CREATE INDEX runs_runnable ON runs (wake_at) WHERE status = 'running';
CREATE INDEX runs_wait_deadline ON runs (wake_at) WHERE status = 'waiting';

-- effect_key separates multiple sends from one step: 'main', 'reprompt:1', 'give_up'.
CREATE TABLE step_executions (
  id                  bigserial PRIMARY KEY,
  run_id              uuid NOT NULL REFERENCES runs(id),
  step_index          int NOT NULL,
  effect_key          text NOT NULL DEFAULT 'main',
  attempt             int NOT NULL DEFAULT 1,
  status              text NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  external_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index, effect_key)
);

CREATE TABLE rate_limit_buckets (
  account_id  text NOT NULL,
  platform    text NOT NULL,
  tokens      double precision NOT NULL,
  refilled_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, platform)
);
