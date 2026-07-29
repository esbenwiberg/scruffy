-- Gate 3 (release) first-class report boundary.
--
-- The versioned, schema-validated ReleaseRiskReport is the inspectable, SHA-bound
-- record of ONE terminal release analysis. It is persisted ADDITIVELY alongside the
-- existing release_decisions row (0004) — the typed decision remains available for
-- operational queries, while the report is the authoritative object the advisory
-- check is rendered from. New state only; nothing in 0004 (or poison/nightly) changes.
--
-- Keyed by run_id: exactly one report per idempotent release run. Re-triggering a
-- terminal run reuses this row (insert ... on conflict (run_id) do nothing), so a
-- retry never produces a second report — the mirror of the outbox's dedupe.
--
-- The full report is stored as unbounded jsonb (never truncate model/analyzer text —
-- heritage scar) and re-parsed through the Zod schema at every read boundary. The
-- extra columns are denormalized identity/subject facts for operator queries and to
-- make the SHA binding and identity inspectable without opening the blob.
create table release_reports (
  run_id               text primary key references evaluation_runs(id),
  report_id            text not null,
  report_version       text not null,
  repository           text not null,
  previous_release_sha text,
  candidate_sha        text not null,
  policy_version       text not null,
  report               jsonb not null,
  generated_at         timestamptz not null,
  created_at           timestamptz not null
);

-- Report identity is content-bound; index it for provenance/audit lookups.
create index release_reports_report_id_idx on release_reports (report_id);
