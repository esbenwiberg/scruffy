-- Durable report-request ordering for hosted sign-off authority.
--
-- The GitHub App review-history contract does not expose a review timestamp, so the
-- previous "approval postdates report generation" chronology check was unfounded.
-- This migration replaces that assumption with a service-owned ordering proof: the
-- allowlisted pinned workflow's report-request job durably records that it requested
-- an exact report/envelope for an exact workflow ref, run, and attempt BEFORE the
-- protected-Environment job can attest. Attestation is bound to that observation, and
-- terminal authorization re-reads it.
--
-- Additive only. Historical migration 0012 is untouched; historical attestation rows
-- are versioned to '1' and remain audit-readable while being ineligible for new
-- terminal authorization.

create table release_report_requests (
  request_id            text primary key,
  report_id             text not null references release_reports(report_id),
  repository            text not null,
  candidate_sha         text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  artifact_digest       text not null check (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_environment    text not null check (target_environment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  workflow_ref          text not null,
  workflow_run_id       text not null,
  workflow_run_attempt  integer not null check (workflow_run_attempt > 0),
  observation           jsonb not null,
  observed_at           timestamptz not null
);

-- Exact-identity uniqueness: an exact retry converges on one row (idempotent), while
-- a divergent observation for the same natural key surfaces a conflict rather than
-- silently returning an unrelated row. request_id is a content digest of exactly
-- these identity fields, so the natural key and the primary key never disagree in
-- normal operation; a disagreement can only come from a bug and fails closed here.
create unique index release_report_requests_exact
  on release_report_requests
  (report_id, workflow_ref, workflow_run_id, workflow_run_attempt, artifact_digest, target_environment);

create index release_report_requests_report_lookup
  on release_report_requests (report_id, workflow_run_id, workflow_run_attempt);

-- Version existing attestation rows so historical v1 data is distinguishable and
-- ineligible for new terminal authorization. Existing rows backfill to '1'.
--
-- The binding from a v2 attestation to its ordering observation lives in the
-- attestation's own jsonb (`requestObservationId`); terminal authorization re-reads
-- the observation from release_report_requests by that id and refuses on removal or
-- mismatch. That runtime revalidation — not a foreign key — is the authority, so the
-- observation can be independently absent and the terminal transaction still fails
-- closed without committing a partial authorization.
alter table release_approval_attestations
  add column attestation_version text not null default '1';

-- New inserts must state their version explicitly; the default only backfills history.
alter table release_approval_attestations
  alter column attestation_version drop default;
