-- Initial schema for the walking skeleton.
-- One migration authority (ADR 0003 production scar): migrations are the only
-- way schema changes, and they are tested against real Postgres, never SQLite.

create table evaluation_runs (
  id             text primary key,
  kind           text not null check (kind in ('poison', 'nightly', 'release')),
  repository     text not null,
  commit_sha     text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  merge_group_sha text check (merge_group_sha ~ '^[0-9a-f]{40}$'),
  policy_version text not null,
  state          text not null check (state in ('pending', 'analyzing', 'decided', 'superseded', 'indeterminate')),
  attempt        integer not null default 0 check (attempt >= 0),
  created_at     timestamptz not null,
  updated_at     timestamptz not null
);

-- A repository has at most one live run per commit; re-delivery reconciles the
-- existing run rather than creating a duplicate.
create unique index evaluation_runs_subject_kind
  on evaluation_runs (repository, commit_sha, kind);

create table run_transitions (
  id         bigint generated always as identity primary key,
  run_id     text not null references evaluation_runs(id),
  from_state text not null,
  to_state   text not null,
  reason     text not null,
  at         timestamptz not null
);

create index run_transitions_run_id on run_transitions (run_id, id);

-- Poison decisions. Text output (reasons/dispositions) is unbounded jsonb — a
-- heritage scar: never truncate model/analyzer output at the column.
create table poison_decisions (
  run_id       text primary key references evaluation_runs(id),
  outcome      text not null check (outcome in ('block', 'allow', 'indeterminate')),
  reasons      jsonb not null,
  dispositions jsonb not null,
  findings     jsonb not null,
  decided_at   timestamptz not null
);

-- Transactional outbox. External effects are committed here in the SAME
-- transaction as the state transition, then dispatched idempotently by the
-- effects component. external_id is the idempotency key handed to the SCM.
create table outbox (
  id          text primary key,
  run_id      text not null references evaluation_runs(id),
  effect_type text not null,
  external_id text not null,
  payload     jsonb not null,
  status      text not null default 'pending' check (status in ('pending', 'sent')),
  attempts    integer not null default 0 check (attempts >= 0),
  created_at  timestamptz not null,
  sent_at     timestamptz,
  unique (run_id, external_id)
);

create index outbox_pending on outbox (created_at) where status = 'pending';
