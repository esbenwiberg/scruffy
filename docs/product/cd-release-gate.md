# CD-native release gate

## Product boundary

Release-risk analysis is a deployment concern, not a pull-request concern.

Pull requests stay lean:

- repository CI;
- fast poison/security findings;
- small, actionable summaries.

They do not carry the release-range narrative, rollback analysis, blast-radius
assessment, or release-exception approval.

The release gate runs after merge and artifact creation. Its authoritative
subject will be:

- repository;
- exact source commit SHA;
- exact artifact digest;
- previous deployed SHA;
- target environment;
- policy and report identity.

## Current CD seam

`scripts/release-review.ts` now operates report-only:

```bash
SCRUFFY_MODEL_BACKEND=claude-cli \
  npm run scruffy:release -- owner/repository candidate-sha sha256:artifact-digest target-environment previous-deployed-sha
```

It:

1. reads repository evidence;
2. persists one SHA-bound report;
3. prints the full report;
4. appends the report to `GITHUB_STEP_SUMMARY` when GitHub Actions provides it;
5. writes `outcome`, `report_id`, `candidate_sha`, and `signoff_required` to
   `GITHUB_OUTPUT`;
6. emits no SCM effect, commit status, or check.

`ship` and `sign-off-required` exit successfully so the workflow can route to
the appropriate next job. `stop` and `indeterminate` fail the analysis job.

The local command remains a report-only compatibility seam. The codebase now
contains a v2 full-envelope identity, authenticated hosted report/attestation/
shadow-authorization protocol, and terminal durable-state revalidation. Those
paths are not yet deployed or live-verified and therefore remain non-authoritative.

## Target workflow

```yaml
jobs:
  release-risk:
    # Runs after build; exports outcome/report_id/candidate_sha.
    steps:
      - name: Scruffy release risk
        id: scruffy
        run: npm run scruffy:release -- "$REPOSITORY" "$CANDIDATE_SHA" "$PREVIOUS_DEPLOYED_SHA"

  approve-exception:
    needs: release-risk
    if: needs.release-risk.outputs.outcome == 'sign-off-required'
    environment: production-release-approval
    steps:
      - name: Verify and record approval
        # Future hosted Scruffy endpoint: verifies report + SHA + artifact,
        # requires rationale and responsibility acceptance, records reviewer.
        run: scruffy-signoff ...

  deploy-ship:
    needs: release-risk
    if: needs.release-risk.outputs.outcome == 'ship'
    # Revalidate SHA and artifact digest, then deploy.

  deploy-approved-exception:
    needs: [release-risk, approve-exception]
    if: needs.release-risk.outputs.outcome == 'sign-off-required'
    # Revalidate SHA, artifact digest, report, and approval, then deploy.
```

The two deployment jobs may call one reusable deployment workflow to avoid
duplication. They remain separate here because GitHub treats a conditionally
skipped approval job as a skipped dependency; the graph must not accidentally
skip a legitimate `ship` deployment or bypass sign-off.

## Sign-off contract

The approval input must include:

- exact report ID;
- exact candidate SHA;
- exact artifact digest;
- target environment;
- non-empty exception rationale;
- explicit responsibility acceptance.

The approval surface states:

> By approving this exception, you personally accept responsibility for
> deploying the exact candidate and artifact despite the unresolved risks and
> evidence gaps in the exact report. Scruffy has not certified this deployment
> as safe. The approval applies only to that candidate, artifact, environment,
> and report.

GitHub Environment comments are optional, so the native approval dialog alone
cannot enforce the rationale/acceptance contract. The controlled sign-off step
must collect and persist those fields separately, then record the actual
Environment reviewer identity. Any changed SHA, artifact digest, environment,
or successor report invalidates approval.

`stop` and `indeterminate` never enter this approval route.

## Work-item context

The deployment report may show:

- open issues carrying the exact `bug` label;
- unresolved Scruffy nightly issues/fix lifecycle;
- merged pull requests included in the release range;
- an optional collapsed count/link for unrelated open pull requests.

Open PRs are future work, not part of the artifact. They are context only and
must not be highlighted as the release candidate or affect the outcome.

## Controlled TODO-repository evidence — 2026-07-31

The disposable TODO repository now has a manual shadow workflow at
`.github/workflows/release-shadow.yml` and a protected environment named
`scruffy-production-signoff` with `esbenwiberg` as required reviewer.

Two terminal paths were exercised end to end:

1. **Human exception:** hardened workflow run
   [`30649693420`](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/actions/runs/30649693420)
   built risky candidate `c39c314163509603a572124780daa4c8f47d6912`, produced
   `sign-off-required` report
   `rr_e1ae4b3cc27c835594385d2a6e2ce0863439516c52ad6d5f4a4eeb91f50aeac0`,
   paused at the protected environment, and continued only after an explicit
   human approval. The approval API recorded reviewer `esbenwiberg`; the
   workflow proved that reviewer was also the identity that supplied the
   mandatory rationale and responsibility acceptance. The durable workflow
   artifacts bind the report, candidate, artifact digest
   `sha256:784dedee47b3d216febc0e289d71d4a8f9f856a3a3c1bf515fbaeafcf36d7789`,
   target `shadow-production`, rationale, responsibility accepter, reviewer,
   timestamp, and workflow run. The terminal shadow-deploy job revalidated the
   complete envelope and equality of responsibility accepter and reviewer.
2. **Automatic ship:** workflow run
   [`30649251016`](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/actions/runs/30649251016)
   reviewed merged-main candidate `d60c6c0f959caf96f2d9f7e088bdc155693e2ab8`, produced
   `ship` report
   `rr_e96bf603c50270a2463e4c6855913caeed589ea501f99c6e0b1f4a68c7a21e06`,
   skipped human approval, and revalidated artifact digest
   `sha256:8fc417169c410666dc243b7f920fd71680b5ebd4f5857f5f48de9b63f5b8eb45`
   before automatic shadow authorization.

Both analyses emitted zero SCM effects. No release check was created or updated
on a PR. The old experimental PR-head check remains only as a concise superseded
notice; its intentionally risky PR was closed without merge and its branch was
deleted.

This proves the CD routing and approval mechanics, not production authority. The
lab used the fake model backend and ephemeral Postgres and performed no real
deployment. The subsequent local implementation now binds artifact/environment
inside report v2 and adds durable hosted attestation/authorization records, but
it has not been deployed against the hosted database, a real Foundry model, or a
GitHub Actions OIDC caller. The lab environment also retains GitHub's default
administrator-bypass option. Those live gaps must be closed before promotion.

## Hosted release protocol (implemented locally; not deployed)

Controlled jobs request a short-lived OIDC token with audience
`scruffy-release`. Scruffy independently allowlists the repository ID, immutable
reusable-workflow ref, and target environment before exposing four authenticated
operations:

- `POST /v1/release-reports` — drive one exact repository/range/artifact/environment report;
- `GET /v1/release-reports/{reportId}` — retrieve the persisted v2 report;
- `POST /v1/release-reports/{reportId}/attestations` — after the protected
  Environment gate, persist rationale and responsibility acceptance only when
  GitHub approval history establishes that the OIDC actor was the reviewer;
- `POST /v1/release-reports/{reportId}/authorizations` — re-read durable state
  and persist a `shadowOnly: true` terminal result.

The client is `npm run scruffy:release-client -- <review|attest|authorize> ...`.
It uses `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN`; no
long-lived workflow secret or Scruffy authority credential enters the repository.
The attestation job supplies rationale through `SCRUFFY_RELEASE_RATIONALE` and
requires `SCRUFFY_RELEASE_RESPONSIBILITY_ACCEPTED=true` rather than hardcoding or
passing acceptance on the command line. Authorization reads optional
`SCRUFFY_PREVIOUS_RELEASE_SHA` / `SCRUFFY_RELEASE_ATTESTATION_ID`. `stop` and
`indeterminate` never authorize. This protocol emits no publication or deployment
effect.
