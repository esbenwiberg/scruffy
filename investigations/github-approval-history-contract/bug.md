# GitHub approval-history contract mismatch blocks all sign-off attestations

## Status

Fixed.

## Symptom

Every hosted `sign-off-required` release attempt failed at the attestation step
with `503 GitHub approval history is unavailable`. Automatic `ship`, report
generation/retrieval, poison, and nightly were unaffected — the path failed
closed, so no unsafe authorization was ever produced, but the human-exception
lane could never succeed against a real GitHub response.

## Root cause

The GitHub App approval adapter encoded a review-history shape GitHub does not
return. GitHub documents
`GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals`
([REST reference](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run))
as returning review entries with `state`, `comment`, `environments`, and `user`.
Valid `state` values are `approved`, `rejected`, and `pending`. The response
exposes **no** `submitted_at` or other review timestamp.

The adapter instead:

- required `submitted_at` and narrowed `state` to `approved | rejected`
  (`src/providers/scm/github-app-approvals.ts`), so a documented live response —
  which omits `submitted_at` and may include `pending` — threw during Zod
  parsing;
- mapped the invented `submitted_at` to a normalized `reviewedAt`
  (`src/providers/scm/port.ts`, `WorkflowEnvironmentApproval.reviewedAt`);
- used that field in `src/app/release-authority.ts` to assert the approval
  postdated report generation.

The parse failure surfaced as a provider fault and was mapped to `503`,
preventing any attestation.

## Fix

Parse GitHub's documented review-history shape faithfully (`approved`,
`rejected`, `pending`; no timestamp) and replace the unfounded chronology check
with a durable, service-owned ordering proof:

- The allowlisted pinned workflow's non-Environment report-request job durably
  records a runtime-schema-valid **report-request observation** binding the exact
  report and envelope to the workflow ref, run id, and run attempt, before the
  report is returned. Exact retries are idempotent; conflicting observations fail
  closed.
- A protected-Environment attestation now requires a matching prior request
  observation for the exact report and same workflow ref/run/attempt, the actual
  sole `approved` reviewer from GitHub history, and equality of OIDC actor,
  responsibility accepter, and reviewer. The attestation schema is versioned to
  v2 and records an honest **service-owned** approval verification timestamp plus
  verification provenance — never a GitHub review time. Historical v1 rows remain
  audit-readable but are ineligible for new terminal authorization.
- Terminal sign-off authorization re-reads and revalidates the current report,
  the matching request observation, and the exact v2 attestation in one
  transaction; mutation, supersession, removal, wrong run/attempt, or an old
  attestation version refuses without partial state.

The change is additive (migration `0013_report_request_ordering.sql` after
`0012`), fail-closed, and shadow-only; no GitHub permission, Environment, or
workflow run was changed.
