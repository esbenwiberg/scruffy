-- Gate 3 (release) durable decision state.
--
-- A release run reviews a RANGE (prev_release, candidate] and produces ONE
-- aggregate outcome: ship | sign-off-required | stop | indeterminate. It reuses
-- the gate-neutral base_sha column (added in 0003) as the prev-release lower
-- bound and leaves branch null — release is triggered per candidate with an
-- explicit previous release, not advanced along a per-branch watermark like
-- nightly. So no change to evaluation_runs is needed here.
--
-- Only a new decisions table is added. Each gate owns its own decisions table
-- (poison_decisions / nightly_decisions) with typed columns rather than sharing
-- one generalized jsonb blob: the shapes genuinely differ and the typed CHECK
-- constraint on `outcome` guards integrity. Generalizing is a later refactor with
-- its own risk budget, not a side effect of adding the third gate.
--
-- Text output (reasons/dispositions/findings) is unbounded jsonb — never truncate
-- analyzer/model output at the column (heritage scar).
create table release_decisions (
  run_id       text primary key references evaluation_runs(id),
  outcome      text not null check (outcome in ('ship', 'sign-off-required', 'stop', 'indeterminate')),
  reasons      jsonb not null,
  dispositions jsonb not null,
  findings     jsonb not null,
  summary      jsonb not null,
  decided_at   timestamptz not null
);
