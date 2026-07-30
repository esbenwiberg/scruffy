-- Gate 2 (nightly) central schedule state.
--
-- WHY. Nightly review had no trigger of its own: a human ran the manual command
-- with a repository and a branch. The hosted process now schedules every
-- repository visible to the configured GitHub App installation at its RESOLVED
-- default branch, so it needs exactly two durable facts per (repository, branch):
--
--   * when the last scheduled attempt STARTED — the cadence gate. Without it a
--     restart re-reviews everything immediately and a crash loop becomes a
--     hot loop of GitHub reads.
--   * who currently owns the attempt — the overlap gate. Two timer ticks, or two
--     processes, must never drive the same branch at once; they would fight over
--     the run lease and duplicate provider reads for no benefit.
--
-- Deliberately NOT an enrollment table. Rows are created lazily as a side effect
-- of scheduling, never as a source of truth about which repositories are opted
-- in: App installation is the enrollment (docs/product/opt-in-repository-
-- integration.md), and a stale row here must not schedule a repository the
-- installation no longer contains.
--
-- Append-only: migrations 0001..0010 are untouched.

create table nightly_schedule_state (
  repository          text not null,
  branch              text not null,
  -- Lease: owner + fencing id + expiry, same shape as the run lease in 0002/0006.
  -- All three are null exactly when nothing owns this branch.
  lease_owner         text,
  lease_id            text,
  lease_expires_at    timestamptz,
  -- The cadence gate. Set when a claim is GRANTED (not when it succeeds), so a
  -- failing branch waits for the next window instead of spinning.
  last_started_at     timestamptz,
  last_finished_at    timestamptz,
  -- The immutable head the last attempt was scheduled at, and how it ended.
  -- Audit only: the review range still starts at the COMPLETE watermark in
  -- review_watermarks, never at anything recorded here.
  last_scheduled_head text check (last_scheduled_head ~ '^[0-9a-f]{40}$'),
  last_outcome        text,
  last_error          text,
  attempts            bigint not null default 0,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  primary key (repository, branch),
  -- A lease is all-or-nothing: a half-written lease could be neither honoured
  -- nor released.
  check ((lease_owner is null) = (lease_id is null)),
  check ((lease_id is null) = (lease_expires_at is null))
);

comment on table nightly_schedule_state is
  'Per (repository, branch) nightly scheduling state: cadence gate + attempt lease. Not an enrollment list — App installation is enrollment.';
comment on column nightly_schedule_state.last_started_at is
  'When the last scheduled attempt was CLAIMED. The cadence window is measured from here, so a failed attempt still waits its turn.';
comment on column nightly_schedule_state.last_scheduled_head is
  'Immutable default-branch head the last attempt was scheduled at. Audit only: ranges start at review_watermarks.last_reviewed_head.';

-- Due-work scan: order by the oldest start, nulls (never scheduled) first.
create index nightly_schedule_state_due_idx
  on nightly_schedule_state (last_started_at asc nulls first);
