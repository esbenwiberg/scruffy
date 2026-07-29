-- Gate 2 (nightly) first-class report / work graph.
--
-- WHY. `nightly_decisions` records dispositions, findings, and a summary, but it
-- dropped `NightlyDecision.coverage` entirely — so a night where an analyzer was
-- blind persisted identically to a night that was genuinely clean, and the review
-- watermark advanced over both. This migration makes the report the durable unit:
-- coverage is stored, surviving findings become addressable work items with stable
-- ids, and the watermark distinguishes "completely reviewed through here" from
-- "an attempt was committed here".
--
-- Append-only: migrations 0001..0007 are untouched.

-- 1. Coverage on the existing decision row. NULLABLE ON PURPOSE: rows written
-- before this migration have no coverage, and back-filling them with
-- COMPLETE_COVERAGE would invent a claim we never made. NULL reads as "coverage
-- unknown for this legacy row" — which is explicitly NOT complete.
alter table nightly_decisions add column coverage jsonb;

comment on column nightly_decisions.coverage is
  'AnalysisCoverage for the run. NULL only for rows written before migration 0008: unknown coverage, never to be read as complete.';

-- 2. The complete-review watermark gains an ATTEMPTED head.
--
-- `last_reviewed_head` now means "completely reviewed through this head" and
-- becomes nullable: a branch can have attempts on record with no complete review
-- yet. `last_attempted_head` is the audit trail of the last terminal attempt and
-- is deliberately NOT a review claim — nothing derives a range from it.
alter table review_watermarks
  alter column last_reviewed_head drop not null;

alter table review_watermarks
  add column last_attempted_head text check (last_attempted_head ~ '^[0-9a-f]{40}$'),
  add column attempted_at        timestamptz;

comment on column review_watermarks.last_reviewed_head is
  'Last head COMPLETELY reviewed (no required coverage gaps). NULL = never completely reviewed. Ranges start here.';
comment on column review_watermarks.last_attempted_head is
  'Last head a terminal nightly attempt was committed for. Audit only: an attempt is not a review.';

-- 3. The report: one immutable identity per (repository, branch, base, head,
-- policy version, report schema version).
create table nightly_reports (
  report_id                 text primary key,
  run_id                    text not null references evaluation_runs(id),
  repository                text not null,
  branch                    text not null,
  base_sha                  text check (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha                  text not null check (head_sha ~ '^[0-9a-f]{40}$'),
  policy_version            text not null,
  schema_version            text not null,
  coverage                  jsonb not null,
  -- Derived from coverage, stored because it is the fact the watermark and the
  -- check both hang off. The domain schema re-derives it on read, so a row that
  -- disagrees with its own coverage fails loudly instead of rendering clean.
  required_coverage_complete boolean not null,
  summary                   jsonb not null,
  created_at                timestamptz not null,
  updated_at                timestamptz not null
);

create index nightly_reports_run_idx on nightly_reports (run_id);
create index nightly_reports_branch_idx on nightly_reports (repository, branch, created_at desc);

-- 4. Finding occurrences. Every deduplicated finding is here — including
-- suppressed and refuted ones, which is the audit record. Only SURFACED ones get
-- a work item (table 5).
create table nightly_report_findings (
  occurrence_id     text primary key,
  report_id         text not null references nightly_reports(report_id) on delete cascade,
  finding_key       text not null,
  rule_id           text not null,
  defect_class      text not null,
  path              text not null,
  start_line        integer not null,
  end_line          integer not null,
  validation        text not null,
  deterministic_support boolean not null,
  visibility        text not null check (visibility in ('suppressed', 'surfaced')),
  visibility_reason text not null,
  resolution        text not null check (resolution in ('open', 'awaiting_verification', 'resolved', 'dismissed')),
  -- Null exactly when no remediation is owed (a suppressed finding).
  remediation       jsonb,
  -- The full evidence payload, unbounded jsonb — never truncate analyzer output at
  -- the column (heritage scar).
  finding           jsonb not null,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  unique (report_id, finding_key)
);

-- 5. Work items: the durable intent to publish something for a human. Kind is
-- provider-neutral; brief 02 maps a parent to a GitHub issue and children to
-- native sub-issues.
create table nightly_work_items (
  work_item_id        text primary key,
  report_id           text not null references nightly_reports(report_id) on delete cascade,
  kind                text not null check (kind in ('nightly_run', 'finding', 'coverage_gap')),
  parent_work_item_id text references nightly_work_items(work_item_id),
  occurrence_id       text references nightly_report_findings(occurrence_id),
  coverage_analyzer_id text,
  coverage_gap_code   text,
  title               text not null,
  body                text not null,
  resolution          text not null check (resolution in ('open', 'awaiting_verification', 'resolved', 'dismissed')),
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  -- Structural guards so an illegal work item cannot be stored at all.
  check (kind <> 'nightly_run' or (parent_work_item_id is null and occurrence_id is null and coverage_gap_code is null)),
  check (kind <> 'finding' or (parent_work_item_id is not null and occurrence_id is not null)),
  check (kind <> 'coverage_gap' or (parent_work_item_id is not null and coverage_analyzer_id is not null and coverage_gap_code is not null))
);

-- Exactly one parent per report. A second parent would mean a second nightly
-- issue for the same immutable review — the duplicate this whole identity scheme
-- exists to prevent.
create unique index nightly_work_items_one_parent_per_report
  on nightly_work_items (report_id)
  where kind = 'nightly_run';

create index nightly_work_items_parent_idx on nightly_work_items (parent_work_item_id);

-- 6. Lifecycle history for a work item. `from_state` is null for the record
-- written when the item is created. (work_item_id, seq) is unique so re-committing
-- the same report re-inserts nothing.
create table nightly_work_item_transitions (
  id           bigserial primary key,
  work_item_id text not null references nightly_work_items(work_item_id) on delete cascade,
  seq          integer not null,
  axis         text not null,
  from_state   text,
  to_state     text not null,
  reason       text not null,
  at           timestamptz not null,
  unique (work_item_id, seq)
);

-- 7. Fix proposals. Identity = finding occurrence + fixer/model/prompt/proposal
-- schema versions, so the same rule at the same line on a LATER candidate is a new
-- proposal and can never be matched against an older closed PR.
create table nightly_fix_proposals (
  proposal_id   text primary key,
  occurrence_id text not null references nightly_report_findings(occurrence_id) on delete cascade,
  provenance    jsonb not null,
  branch        text not null,
  edits         jsonb not null,
  delivery      text not null check (delivery in ('queued', 'draft_open', 'ready_open', 'delivery_failed')),
  ci            text not null check (ci in ('unknown', 'pending', 'passed', 'failed')),
  merge_state   text not null check (merge_state in ('open', 'closed_unmerged', 'merged')),
  created_at    timestamptz not null,
  updated_at    timestamptz not null
);

create index nightly_fix_proposals_occurrence_idx on nightly_fix_proposals (occurrence_id);
