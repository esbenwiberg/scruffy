-- Gate 2 (nightly deep review) durable state.
--
-- A nightly run reviews a range (base_sha, head] on a branch. Poison runs leave
-- base_sha/branch null: the run is still the gate-neutral durable unit, these two
-- nullable columns just make a nightly run self-contained so the reconciler can
-- re-drive a crashed run against its FROZEN range instead of a moving watermark.

alter table evaluation_runs
  add column base_sha text check (base_sha ~ '^[0-9a-f]{40}$'),
  add column branch   text;

-- Nightly produces per-finding dispositions (suppress | report | propose_fix),
-- not a single block/allow. Text output is unbounded jsonb — never truncate
-- analyzer/model output at the column (heritage scar).
create table nightly_decisions (
  run_id       text primary key references evaluation_runs(id),
  dispositions jsonb not null,
  findings     jsonb not null,
  summary      jsonb not null,
  decided_at   timestamptz not null
);

-- The durable review watermark: per (repository, branch), the last head whose
-- nightly review reached a decision. Advanced ONLY in the same transaction as
-- that decision, and guarded on the base we actually reviewed (see
-- RunStore.commitNightlyDecision) so it never regresses and an out-of-order
-- head cannot clobber a newer watermark.
create table review_watermarks (
  repository         text not null,
  branch             text not null,
  last_reviewed_head text not null check (last_reviewed_head ~ '^[0-9a-f]{40}$'),
  updated_at         timestamptz not null,
  primary key (repository, branch)
);
