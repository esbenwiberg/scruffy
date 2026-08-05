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
   mandatory rationale and responsibility acceptance. GitHub established the
   reviewer but supplied no review timestamp; ordering is proven by the durable
   report-request observation recorded by the pre-approval job, and the
   attestation carries a service-owned approval-verification time, not a provider
   one. The durable workflow artifacts bind the report, candidate, artifact
   digest
   `sha256:784dedee47b3d216febc0e289d71d4a8f9f856a3a3c1bf515fbaeafcf36d7789`,
   target `shadow-production`, rationale, responsibility accepter, reviewer,
   the same-attempt request observation, service-owned verification time, and
   workflow run. The terminal shadow-deploy job revalidated the complete
   envelope, the request-observation ordering, and equality of responsibility
   accepter and reviewer.
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
`ACTIONS_ID_TOKEN_REQUEST_URL` is the runner-provided **request** endpoint — a
regional Actions service host under `*.actions.githubusercontent.com` (e.g.
`pipelines.actions.githubusercontent.com`) — and is deliberately **not** the JWT
issuer. The issuer stays fixed at `https://token.actions.githubusercontent.com`
and is verified independently by the hosted OIDC verifier. Client and workflow
therefore bound the request URL to an HTTPS subdomain of the Actions zone (no
credentials, no explicit port) before the request token is sent, rather than
pinning it to the issuer host.
The attestation job supplies rationale through `SCRUFFY_RELEASE_RATIONALE` and
requires `SCRUFFY_RELEASE_RESPONSIBILITY_ACCEPTED=true` rather than hardcoding or
passing acceptance on the command line. Authorization reads optional
`SCRUFFY_PREVIOUS_RELEASE_SHA` / `SCRUFFY_RELEASE_ATTESTATION_ID`. `stop` and
`indeterminate` never authorize. This protocol emits no publication or deployment
effect.

## Reusable shadow release-authority workflow

A service-controlled reusable workflow now ships at
`.github/workflows/release-authority-shadow.yml`. It is exposed **only** through
`workflow_call`, so a disposable caller repository invokes it pinned to an
immutable full commit SHA:

```yaml
jobs:
  release-authority-shadow:
    permissions:
      contents: read
      id-token: write # the caller MUST grant this; a called workflow cannot elevate it
    uses: esbenwiberg/scruffy/.github/workflows/release-authority-shadow.yml@<full-sha>
    with:
      candidate_sha: ${{ needs.build.outputs.candidate_sha }}
      previous_release_sha: "" # empty only for a first release
      artifact_digest: ${{ needs.build.outputs.artifact_digest }} # sha256:<64 hex>
      target_environment: shadow-production
      exception_rationale: "" # required and non-empty only for a sign-off
      responsibility_accepted: false # must be true for a sign-off
```

The Scruffy HTTPS endpoint and the `scruffy-release` OIDC audience are **fixed
service-controlled literals inside the pinned workflow**. They are deliberately
not caller inputs and must never become a caller input — an endpoint input would
allow the short-lived OIDC token to be exfiltrated to an attacker-chosen host.
The workflow contains exactly two jobs:

1. `review-and-ship-authorize` runs in **no** GitHub Environment, validates the
   complete envelope before requesting any OIDC token, drives the hosted report,
   automatically authorizes a `ship` outcome, routes `sign-off-required` to the
   protected job, and fails closed on `stop`, `indeterminate`, unknown,
   malformed, or mismatched responses.
2. `attest-and-authorize-exception` declares the protected
   `scruffy-production-signoff` Environment, `needs` the review job, and runs
   only for `sign-off-required`. Attestation and terminal authorization run in
   that one Environment job so they share a single OIDC workflow identity; the
   runner-supplied actor login and stable ID are the responsibility accepter and
   no caller-supplied reviewer identity is accepted.

Permissions are the exact least-privilege set (`contents: read`,
`id-token: write`) with no workflow, SCM, package, deployment, checks, issues, or
pull-request write authority. Every authorization is `shadowOnly: true`; the
workflow performs no application, infrastructure, package, image, or release
deployment or publication, issues no explicit deployment/status/SCM write
command, and so creates no release, package, image, check, issue, or pull
request. The one unavoidable platform effect is that the sign-off path declares a
protected GitHub Environment, so GitHub itself automatically records
protected-Environment deployment/status audit metadata for that job (a deployment
record plus waiting/queued/in_progress/success statuses). That GitHub-generated
audit trail is the platform's own bookkeeping — it is not a product deployment or
publication and confers no deployment authority. The workflow exposes only
bounded evidence outputs (`report_id`, `outcome`, `authorization_id`,
`signoff_used`) and never a JWT or a full report.

## Repository-owned workflow prerequisites

A repository declares its existing required GitHub Actions workflows in one narrow,
repository-owned file at `.github/scruffy-release.yml`. Scruffy reads and parses it
**at the exact candidate SHA** and resolves every provider fact (workflow identity,
runs, attempts, status, conclusion, URLs) itself through the GitHub App — none of
those facts, and none of the workflow paths, come from a caller input. The reusable
workflow above passes only the release envelope; the required-workflow paths are
whatever the candidate configuration names.

### The configuration file

```yaml
# .github/scruffy-release.yml
version: 1

requiredWorkflows:
  - .github/workflows/ci.yml
  - .github/workflows/integration.yml
```

The v1 schema is intentionally minimal — a `version` and a non-empty
`requiredWorkflows` list of existing workflow files under `.github/workflows/`
ending in `.yml`/`.yaml`. A repository can name **any** existing workflow paths
without adopting Scruffy-specific job names. The file cannot configure branch,
event, result mapping, approval behaviour, freshness, endpoint, audience, or waiver
semantics; Scruffy owns all of those. Unknown keys, unknown versions, duplicate or
non-string entries, YAML aliases, and custom tags are rejected. The configuration is
integration routing, not release policy — it selects which repository-owned
workflows provide evidence, and nothing more.

### First-adoption baseline sign-off

The first release, the first Scruffy adoption, or any release with no readable
previous configuration requires a sign-off to establish a **baseline**. This is not
a failure — it is the deliberate act of a responsible human anchoring the comparison
point. After that approved release, its exact candidate becomes the comparison
baseline for the next release.

### Incremental workflow adoption

A team adopts Scruffy one workflow at a time:

1. add one existing workflow to `.github/scruffy-release.yml`;
2. approve the first release to establish the baseline;
3. let subsequent clean, green releases follow the normal automatic `ship` path;
4. add further workflows over time.

Every change to the repository release configuration **or** to GitHub workflow
authority forces a sign-off, even when all current required workflow runs are green.
Across `(previous release, candidate]` Scruffy detects changes to
`.github/scruffy-release.yml`, `.github/workflows/**`, and `.github/actions/**` — the
broad path rule deliberately catches local reusable workflows and composite actions
that a directly-configured file could otherwise hide. The sign-off summary shows the
changed paths and the old/new required-workflow sets.

### Failure exception versus pending/missing refusal

Each configured workflow resolves to exactly one service-owned state for the exact
candidate:

| State             | Meaning                                                   | Effect                                                          |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `passed`          | current attempt completed with conclusion `success`       | satisfied                                                       |
| `terminal-failed` | current attempt completed with any non-success conclusion | **exception-eligible** — routes to protected sign-off           |
| `pending`         | requested, queued, waiting, or in progress                | **not a result** — retried, then fails closed; never approvable |
| `absent`          | no matching run for the exact workflow/candidate          | fail closed; not exception-eligible                             |
| `unverifiable`    | API/schema/pagination/identity fault or ambiguous run     | fail closed; not exception-eligible                             |

Only an exact `success` is green. A **completed** workflow failure is an explicit
observed result a responsible human may accept through the protected sign-off path.
A **pending** workflow is evidence that is not a result yet: the reusable workflow
retries the report request under a bounded backoff and then fails closed with a rerun
instruction — it never enters the protected Environment, so no one can approve a
workflow before it finishes. A **missing** (`absent`) or **unverifiable** workflow,
and a **missing/malformed** configuration, are not results either: they fail closed
and cannot be converted into an approval merely by asking early. Removing or emptying
the configuration is invalid, not a sign-off route.

A confirmed deterministic Scruffy `stop` dominates every prerequisite state and
stays non-overridable even when CI failed or authority changed.

### Rerun invalidation

Release-run identity binds a canonical prerequisite-evidence digest over the
configuration authority and the exact workflow run attempts, so changed CI evidence
produces a **successor** report rather than silently reusing a stale one:

- an exact retry with unchanged evidence returns the same report;
- a failed workflow rerun creates a new attempt and invalidates the prior evidence
  snapshot while it is pending;
- a rerun that succeeds produces a successor report eligible for the normal path
  when no other reason requires sign-off;
- a previously green workflow rerun makes its old report stale immediately — it
  cannot authorize while the current attempt is pending or failed.

Terminal authorization re-reads the current workflow state immediately before
persisting and refuses if any evidence changed (a newer attempt, a changed
status/conclusion, a changed identity/branch/event, a changed authority file, or a
newer report for the envelope). A mismatch instructs the caller to request a fresh
report; an old approval is never carried forward.

### Recommended repository controls and administrator opt-out

Protect `.github/scruffy-release.yml`, `.github/workflows/**`, and
`.github/actions/**` with `CODEOWNERS` and branch protection so a release-authority
change cannot merge without the right review — those repository controls complement,
but never replace, Scruffy's service-owned sign-off. Disabling Scruffy is an explicit
repository-**administrator opt-out** (uninstalling the App or removing the release
workflow and protected Environment) taken outside the release protocol; it is not
achieved by deleting or emptying the configuration file.

### Immediate proof is fake/no-model and partial

The reusable workflow proves the hosted OIDC protocol **mechanics** only. The
immediate live proof runs against the hosted service's **fake / no-model
backend** and therefore **cannot satisfy the real-model campaign exit
criterion**. A real-model backend depends on a Foundry resource that does not yet
exist; Foundry remains **deferred until a separately provisioned resource is
available** — it is not abandoned or silently replaced.

Updating the disposable caller workflow, adding the caller repository/ref to the
Azure OIDC allowlist, changing the protected Environment's administrator-bypass
setting, deploying a new Azure revision, and performing any live GitHub Actions
run remain **separate human gates that this code change does not execute**.
