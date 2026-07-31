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
  npm run scruffy:release -- owner/repository candidate-sha previous-deployed-sha
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

This seam is not yet publication authority: artifact/environment binding,
hosted report retrieval, approval persistence, and pre-deployment revalidation
remain required.

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
lab uses the fake model backend and ephemeral Postgres, performs no real
deployment, and currently binds artifact/environment in the workflow envelope
rather than in Scruffy's report identity. GitHub's native environment deployment
record is bound to the workflow ref; the uploaded approval attestation is what
binds the reviewed candidate artifact. The lab environment also retains GitHub's
default administrator-bypass option. Those gaps must be closed before promotion.
