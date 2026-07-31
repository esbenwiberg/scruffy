-- Hosted release-envelope authority.
--
-- Release work is no longer identified by candidate SHA alone. One candidate can
-- be built into multiple artifacts and target multiple environments, and those
-- are distinct authorization subjects. Historical release rows remain readable:
-- their new envelope columns are null and they can never satisfy the v2 contract.

alter table evaluation_runs
  add column release_artifact_digest text,
  add column release_target_environment text;

-- A pre-v2 release attempt that was still pending at migration time cannot be
-- safely resumed because its artifact/environment subject never existed. Close
-- it honestly instead of letting reconciliation fabricate an envelope.
insert into run_transitions (run_id, from_state, to_state, reason, at)
select id, state, 'indeterminate', 'v1 release run lacks complete deployment envelope', updated_at
  from evaluation_runs
 where kind = 'release' and state in ('pending', 'analyzing');
update evaluation_runs
   set state = 'indeterminate', lease_owner = null, lease_expires_at = null, lease_id = null
 where kind = 'release' and state in ('pending', 'analyzing');

alter table evaluation_runs
  add constraint evaluation_runs_release_artifact_digest_format
    check (release_artifact_digest is null or release_artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  add constraint evaluation_runs_release_target_environment_format
    check (release_target_environment is null or release_target_environment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');

-- Preserve the original identity for poison/nightly. Release receives its own
-- complete-envelope key (including range and policy so a successor policy is a
-- distinct auditable analysis rather than a silent overwrite).
drop index evaluation_runs_subject_kind;
create unique index evaluation_runs_non_release_subject_kind
  on evaluation_runs (repository, commit_sha, kind)
  where kind <> 'release';
create unique index evaluation_runs_release_envelope
  on evaluation_runs (
    repository,
    commit_sha,
    coalesce(base_sha, ''),
    release_artifact_digest,
    release_target_environment,
    policy_version
  )
  where kind = 'release' and release_artifact_digest is not null and release_target_environment is not null;

alter table release_reports
  add column artifact_digest text,
  add column target_environment text,
  add column authority_seq bigint generated always as identity;

alter table release_reports
  add constraint release_reports_artifact_digest_format
    check (artifact_digest is null or artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  add constraint release_reports_target_environment_format
    check (target_environment is null or target_environment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');

create unique index release_reports_report_id_unique on release_reports (report_id);
create index release_reports_envelope_lookup on release_reports
  (repository, candidate_sha, artifact_digest, target_environment, authority_seq desc);

create table release_approval_attestations (
  attestation_id       text primary key,
  report_id            text not null references release_reports(report_id),
  repository           text not null,
  candidate_sha        text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  artifact_digest      text not null check (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_environment   text not null check (target_environment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  workflow_run_id      text not null,
  workflow_run_attempt integer not null check (workflow_run_attempt > 0),
  attestation          jsonb not null,
  created_at           timestamptz not null
);

create unique index release_approval_attestations_exact
  on release_approval_attestations
  (report_id, workflow_run_id, workflow_run_attempt, artifact_digest, target_environment);

create table release_shadow_authorizations (
  authorization_id     text primary key,
  report_id             text not null references release_reports(report_id),
  attestation_id        text references release_approval_attestations(attestation_id),
  repository            text not null,
  candidate_sha         text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  artifact_digest       text not null check (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_environment    text not null check (target_environment ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  workflow_run_id       text not null,
  workflow_run_attempt  integer not null check (workflow_run_attempt > 0),
  authorization_record  jsonb not null,
  created_at            timestamptz not null
);

create unique index release_shadow_authorizations_exact
  on release_shadow_authorizations
  (report_id, workflow_run_id, workflow_run_attempt, artifact_digest, target_environment);
