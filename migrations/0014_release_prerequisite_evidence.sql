-- Repository-owned release prerequisites: evidence-digested release-run identity.
--
-- Until now a release run was unique per (repository, candidate, prev-release,
-- artifact, environment, policy). That collapses one deployment envelope + policy
-- onto ONE run even when the required-workflow evidence later changes (a rerun, a
-- newly green attempt, a changed configuration or `.github` authority path). The
-- fix: bind the canonical prerequisite-evidence digest into release-run identity, so
-- a changed current attempt for the SAME envelope produces a SUCCESSOR run — and
-- therefore a successor report — while an exact-unchanged retry still dedupes onto
-- the original run.
--
-- Additive only. Historical migration 0012 (which created
-- `evaluation_runs_release_envelope`) is untouched; this migration drops and
-- recreates that partial unique index with the extra digest column. Historical
-- release rows have a null digest and, via `coalesce(..., '')`, continue to dedupe
-- exactly as they did before — they are unaffected.

alter table evaluation_runs
  add column release_prereq_evidence_digest text;

-- The prerequisite-evidence digest is a content hash (`pe_<64 hex>`) or null. A null
-- means no repository-owned prerequisites were resolved for this run (the local /
-- corpus context-based candidate-CI path preserved until it is separately retired).
alter table evaluation_runs
  add constraint evaluation_runs_release_prereq_evidence_digest_format
    check (release_prereq_evidence_digest is null or release_prereq_evidence_digest ~ '^pe_[0-9a-f]{64}$');

drop index evaluation_runs_release_envelope;
create unique index evaluation_runs_release_envelope
  on evaluation_runs (
    repository,
    commit_sha,
    coalesce(base_sha, ''),
    release_artifact_digest,
    release_target_environment,
    policy_version,
    coalesce(release_prereq_evidence_digest, '')
  )
  where kind = 'release' and release_artifact_digest is not null and release_target_environment is not null;
