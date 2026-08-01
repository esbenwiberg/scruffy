# C002: Hosted release-envelope authority

## Status

`not yet verified`

The OIDC architecture and local implementation were explicitly approved and
completed in this working tree. Deterministic, database-backed, and offline
infrastructure validation pass. A disposable-caller OIDC integration has now been
exercised end to end against the hosted service's **fake / no-model backend**
(hosted revision `scruffy-shadow--0000004`), proving the hosted OIDC mechanics
and the authorization boundary — including the protected-Environment sign-off
path with administrator bypass disabled — as **successful partial fake/no-model
evidence** (see
[Hosted disposable-OIDC shadow proof](#hosted-disposable-oidc-shadow-proof--2026-08-01)).

The campaign gain remains **not earned**. No real Foundry resource or model
deployment exists, so exit-evidence criterion 6 (at least one hosted report
through a **real** Foundry model backend) is still unmet, and fake/no-model
evidence cannot earn it. A real Azure Container App revision backed by a Foundry
model, and controlled publication/visual evidence, are still required before the
result can move beyond `not yet verified`.

## Origin

Accepted direction:

- [`../product/cd-release-gate.md`](../product/cd-release-gate.md)
- [`../product/release-risk-report.md`](../product/release-risk-report.md)
- [`../product/opt-in-repository-integration.md`](../product/opt-in-repository-integration.md)
- [`../product/azure-shadow-deployment.md`](../product/azure-shadow-deployment.md)

Decisive repository evidence:

- `src/domain/release/report.ts` binds repository, release range, policy, and
  evidence, but not artifact digest or target environment.
- `src/persistence/runs.ts` deduplicates release work by repository and candidate
  SHA, so two artifacts or environments for one candidate are not distinct
  authorization subjects.
- `scripts/release-review.ts` persists through whichever database the invoking
  job receives; the controlled lab used ephemeral storage rather than the hosted
  Azure database.
- `src/server/http.ts` exposes only webhook and health routes; there is no hosted
  release request, report retrieval, approval, or authorization protocol.
- `infra/azure/main.bicep` explicitly selects the fake model backend. A Foundry
  adapter exists, but its deployed authentication and dependency path are not
  yet proven.
- Controlled workflow runs `30649251016` and `30649693420` proved CD routing and
  protected-environment mechanics, including terminal envelope checks, but not
  hosted authority or a real deployment.

## Mission

Mature the boundary that receives one authenticated deployment envelope,
produces and retains its release evidence in the hosted service, and returns a
shadow authorization only after exact-envelope and human-exception checks have
been revalidated.

## Earned gain

**Exactly one gain:** For one controlled, opted-in GitHub repository, a hosted
Scruffy service can return one durable **shadow authorization** for an exact
candidate, artifact digest, target environment, and report; when the report
requires sign-off, that authorization additionally requires a durable
attestation whose responsibility accepter is the actual protected-environment
reviewer.

This gain does not authorize production publication or deployment. It earns an
inspectable authorization boundary that can later be considered for authority.

## Weak boundary

```text
GitHub Actions OIDC identity
+ immutable candidate and previous-release SHAs
+ artifact digest and target environment
+ hosted release evidence and service policy
+ protected-environment review when required
  -> authenticated hosted analysis, persistence, approval verification,
     and immediate terminal revalidation
  -> durable report + durable approval/authorization record for the exact
     envelope, or an explicit refusal
```

## Authority fence

### Campaign-level authority

The campaign may define and implement:

- a versioned deployment-envelope/report identity including artifact digest and
  target environment;
- additive PostgreSQL persistence for reports, approval attestations, and shadow
  authorization records;
- a narrow GitHub Actions OIDC-authenticated release API with service-owned
  repository, workflow, audience, and environment allowlists;
- GitHub approval-history lookup through a least-privileged App reader;
- exact-envelope approval and terminal authorization revalidation;
- Azure-hosted release execution using an explicitly configured real Foundry
  model backend;
- controlled reusable-workflow/client integration and disposable shadow proof.

### Worker-local authority

Workers may choose reversible module boundaries, internal table/query names,
route organization, token-validation library, and test fixtures that preserve
this contract. They may add migrations but may not rewrite or delete historical
migrations. They may not weaken OIDC claims or trust workflow-supplied reviewer
identity when GitHub can establish it independently.

### Human gates

Explicit human approval is required before:

- dispatching implementation;
- adding GitHub App `Actions: read` permission and accepting the updated App
  installation permission grant;
- creating or purchasing a Foundry model deployment, accepting Marketplace
  terms, assigning Azure roles, or activating Azure PIM;
- deploying a new Azure revision or changing Key Vault/configuration;
- disabling administrator bypass on the protected GitHub Environment;
- executing the final disposable live-shadow workflow;
- accepting the campaign as complete;
- granting publication or real deployment authority.

### Escalation conditions

Pause and return for human review or renewed deliberation if implementation
requires:

- a long-lived credential in the controlled repository or workflow;
- a custom human identity, role, administration, or generalized waiver system;
- trusting caller-supplied reviewer identity without verifying GitHub approval
  history;
- repository-controlled policy weakening or OIDC allowlist changes;
- exposing report contents publicly;
- giving an analysis/model process publication or deployment credentials;
- a release outcome outside `ship`, `sign-off-required`, `stop`, and
  `indeterminate`;
- a real publication or production deployment.

## Invariants

1. The canonical report identity includes repository, previous-release SHA,
   candidate SHA, artifact digest, target environment, policy/report versions,
   provenance, evidence, and decision.
2. Replacing any envelope field invalidates report, approval, and authorization.
3. Distinct artifacts or target environments for one candidate remain distinct
   durable subjects; candidate-only deduplication cannot collapse them.
4. Hosted report, approval, and authorization reads parse untrusted stored data
   through versioned runtime schemas.
5. OIDC validation verifies signature, issuer, fixed audience, lifetime,
   repository identity, workflow identity/ref, run identity, and configured
   environment posture. Unknown or missing claims fail closed.
6. The workflow supplies rationale and explicit responsibility acceptance, but
   GitHub approval history establishes the actual Environment reviewer.
7. A sign-off attestation is valid only when the OIDC actor, responsibility
   accepter, and actual reviewer are the same GitHub identity and rationale is
   non-empty.
8. `stop` and `indeterminate` can never acquire an ordinary authorization.
9. `ship` requires no human approval; `sign-off-required` always requires the
   exact matching attestation.
10. Terminal authorization re-reads durable state and revalidates the complete
    envelope immediately before returning success.
11. The real model remains untrusted evidence: provider failure, malformed
    output, or truncation creates a gap and cannot silently ship.
12. The campaign remains shadow-only and holds no publication/deployment
    credential.

## Pressure cases

### Accepted behavior

- A valid allowlisted OIDC caller requests a report for an exact full envelope;
  hosted PostgreSQL retains and retrieves the schema-valid report.
- Two requests sharing a candidate SHA but differing in artifact digest or target
  environment produce distinct report identities and durable subjects.
- A complete `ship` report can produce a shadow authorization without approval
  after terminal envelope equality is revalidated.
- A `sign-off-required` report can produce a shadow authorization only after a
  non-empty rationale, explicit acceptance, and equality among OIDC actor,
  responsibility accepter, and actual GitHub Environment reviewer.
- An idempotent retry returns the same durable report, attestation, or
  authorization rather than duplicating authority records.

### Ambiguous behavior

- A valid token from the correct repository but an unapproved workflow ref is
  rejected rather than downgraded to anonymous/manual operation.
- GitHub approval history unavailable or ambiguous keeps sign-off unverified and
  returns no authorization.
- Foundry timeout, truncation, malformed output, or unavailable deployment
  becomes visible incomplete evidence and cannot produce a clean `ship`.

### Rejected behavior

- An expired token, wrong audience, wrong repository, wrong workflow ref, wrong
  run, or wrong approval environment is rejected before release work is driven.
- A digest, environment, candidate, report, actor, reviewer, or rationale
  mismatch returns no authorization.
- Caller-supplied reviewer text cannot substitute for GitHub approval history.
- A successor report cannot reuse an earlier report's attestation.

### Failure behavior

- Failure to persist or re-read a trustworthy report/attestation/authorization
  fails closed and records no successful authorization.
- Failure to verify GitHub OIDC or approval history exposes a generic caller
  error and retains detailed diagnostics only in controlled logs.
- Hosted analysis failure produces `indeterminate` or an explicit evidence gap,
  never a fabricated clean report.

## Ordered delivery slices

### 1. Bind and persist the complete deployment envelope

Version the report subject/identity to include artifact digest and target
environment. Remove candidate-only collapse from release persistence while
preserving historical report readability. Add typed stores for exact report
retrieval and future approval/authorization records.

This slice owns the schema and persistence contract consumed by every later
slice.

### 2. Add the authenticated hosted release protocol

Validate GitHub Actions OIDC against fixed service-owned trust rules. Add narrow
hosted operations to request/retrieve a release report, verify and persist a
protected-environment attestation, and request terminal shadow authorization.
Read actual reviewers from GitHub's workflow-run approval history through an
`Actions: read` App port. Keep report contents non-public and return no real
publication/deployment capability.

This slice depends on the complete-envelope persistence contract.

### 3. Prove the hosted path with a real model and disposable CD client

Replace the Azure shadow deployment's forced fake backend with an explicitly
configured, keyless Foundry deployment and least-privileged managed identity.
Add a controlled Actions OIDC client/reusable-workflow seam, deployment
configuration, and operator runbook. After separate human approvals, deploy and
exercise both `ship` and `sign-off-required` against a disposable repository,
with administrator bypass disabled and no real publication/deployment.

This slice depends on the hosted protocol. Marketplace acceptance, Azure role
changes, GitHub permission changes, environment configuration, deployment, and
live execution remain human-gated operations.

## Exit evidence

The gain is earned only when all of the following changed-reality evidence
exists:

1. Identity tests prove that changing candidate, previous release, artifact
   digest, target environment, policy, provenance, evidence, or decision changes
   the report identity, while an exact replay remains idempotent.
2. A database-backed test persists distinct reports for the same candidate with
   different artifacts/environments and retrieves each exact schema-valid
   envelope without collision.
3. OIDC pressure tests verify valid signature/issuer/audience/lifetime and reject
   wrong repository, workflow ref, run identity, environment posture, expired
   token, and unknown signing key.
4. Database-backed approval tests prove non-empty rationale, explicit acceptance,
   verified GitHub reviewer identity, actor/accepter/reviewer equality,
   successor-report invalidation, atomic persistence, and idempotency.
5. Authorization pressure tests prove exact terminal revalidation; every mutated
   envelope field fails, `ship` needs no approval, `sign-off-required` needs the
   exact attestation, and `stop`/`indeterminate` never authorize.
6. The Azure-hosted service produces and retrieves at least one report through a
   real Foundry model backend; provider identity is recorded and failure or
   truncation remains fail-closed.
7. One disposable `ship` run and one disposable human-exception run use OIDC,
   hosted PostgreSQL, the exact artifact/environment report identity, durable
   attestation, actual reviewer lookup, and terminal shadow authorization.
8. The protected Environment has administrator bypass disabled during live
   proof, both runs emit zero publication/deployment effects, and no Scruffy
   authority credential enters repository-controlled code.
9. Validation records full test, typecheck, lint, formatting, relevant corpus,
   database-backed, infrastructure plan, OIDC pressure, and live-shadow commands;
   commands not run or environment-blocked are listed separately.

An unsafe authorization, publicly exposed report, unverified reviewer, static
workflow secret, or real deployment falsifies the gain. Delivery without the
real-model and two terminal live-shadow paths is `not yet verified`, not
complete.

## Non-goals

- Publishing a GitHub Release, package, image, or deployment.
- Granting production authority or making a release gate required.
- A custom approval UI, user database, role system, policy UI, or generalized
  waiver engine.
- Supporting non-GitHub identity providers or Azure DevOps.
- Implementing all future visual, migration, deployment, or rollback evidence
  lanes.
- Storing long-lived release credentials in controlled repositories.
- Letting a model approve, sign off, publish, deploy, or weaken policy.

## Results

### Local implementation

- Report schema v2 and release-run persistence bind artifact digest and target
  environment and preserve explicit read compatibility for historical v1 rows.
- Additive migration `0012_release_envelope_authority.sql` separates release
  idempotency from poison/nightly and adds durable attestation/authorization
  records.
- The hosted service exposes OIDC-authenticated report request/retrieval,
  protected-Environment attestation, and terminal `shadowOnly` authorization
  operations.
- OIDC verification checks GitHub issuer/JWKS, fixed audience, lifetime,
  repository/name ID, pinned `job_workflow_ref`, run/attempt, actor, and required
  Environment posture.
- The App approval reader parses GitHub's documented workflow-run review-history
  shape faithfully — `approved`, `rejected`, and `pending` states with no review
  timestamp (GitHub exposes none) — and fails closed on malformed data.
- Ordering is service-owned, not inferred from a provider timestamp. The
  pre-approval report-request job durably records a runtime-schema-valid
  request observation binding the exact report and envelope to the pinned
  workflow ref, run id, and run attempt before the report is returned; exact
  retries are idempotent and conflicts fail closed. A report request carrying a
  protected-Environment claim is rejected as the wrong posture.
- Attestation (schema v2) requires that same-attempt request observation plus a
  non-empty rationale and equality among actor, accepter, and the sole actual
  `approved` reviewer stable identities, and records an honest service-owned
  approval-verification time and verification provenance rather than a
  GitHub-supplied review time. Historical v1 attestations remain audit-readable
  but are ineligible for new terminal authorization.
- Terminal persistence re-reads the latest exact report, the matching request
  observation, and the exact same-run v2 attestation in the authorization
  transaction; mutation, supersession, removal, wrong run/attempt, or an old
  attestation version refuses without partial state.
- Additive migration `0013_report_request_ordering.sql` adds the request-observation
  table and attestation versioning after `0012` without rewriting history.
- The Azure backend uses the official Foundry SDK and managed-identity Entra
  scope `https://ai.azure.com/.default`; Bicep parameterizes an existing
  same-resource-group Foundry account/deployment and the read-only OIDC client
  carries one envelope through the protocol.

### Validation run locally

- All 13 parser-checked contract facts passed.
- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm run build` passed.
- `npm test -- --reporter=dot` passed: 77 files, 723 tests.
- A fresh disposable PostgreSQL database applied all 13 migrations through
  `0012_release_envelope_authority.sql` successfully.
- `az bicep build --file infra/azure/main.bicep --stdout` passed offline.
- Prettier check over every changed/new supported file passed.
- `npm audit --omit=dev` reported zero production vulnerabilities.
- Repository-wide `npm run format:check` remains unusable as an acceptance fact:
  it reports many pre-existing unformatted files outside this change. No waiver
  was used; changed/new files were checked directly.

### Explicitly not run

This list reflects the state at the end of the local-implementation slice. Items
tagged _(later exercised against the fake/no-model backend)_ were subsequently
run in the
[Hosted disposable-OIDC shadow proof](#hosted-disposable-oidc-shadow-proof--2026-08-01)
below; those runs do **not** earn the real-model criterion. The items marked
**still not run** are the genuine live gaps that keep the campaign
`not yet verified`.

- GitHub App `Actions: read` permission change or installation acceptance
  _(later exercised against the fake/no-model backend: the sign-off proof read
  GitHub's approval history to record reviewer `esbenwiberg`)_.
- Foundry Marketplace/model deployment creation or any live model call — **still
  not run**; no real Foundry resource or model deployment exists.
- Azure PIM activation, RBAC assignment, what-if against live resources, or a
  Container App revision backed by a real model — **still not run** (only the
  fake/no-model shadow revision `scruffy-shadow--0000004` was deployed).
- Administrator-bypass removal or protected-Environment reconfiguration _(later
  exercised: administrator bypass was disabled with `esbenwiberg` as the sole
  required reviewer)_.
- Disposable OIDC `ship` and human-exception workflows _(later exercised against
  the fake/no-model backend — see the proof below)_.
- Any publication or real product deployment — **still not run**.

### Hosted disposable-OIDC shadow proof — 2026-08-01

Two disposable-caller runs exercised the hosted OIDC release-authority protocol
end to end against the pinned reusable workflow
`esbenwiberg/scruffy/.github/workflows/release-authority-shadow.yml@fa9ad8620d150ba638ba4d6ec7a601243c0afa66`
and hosted revision `scruffy-shadow--0000004`, which runs the **fake / no-model
backend**. The protected Environment `scruffy-production-signoff` had
administrator bypass **disabled**, with `esbenwiberg` as the sole required
reviewer. This is **successful partial fake/no-model evidence** for the hosted
OIDC mechanics and the authorization boundary; it does **not** earn the
real-model exit criterion.

**Automatic `ship` run**
[`30719559408`](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/actions/runs/30719559408):
the non-Environment review job validated the envelope, drove report
`rr_2442a53e806a5986d6078452b464b77d21db3def8e434d8f06964b599a20d70b` (bound by
request observation
`rrq_8d23e419ac590ce466f4d6713354870509692ac146b575c081074da0c2cc6b8a` to the
pinned workflow ref, run, and attempt 1), and posted terminal authorization
`auth_45659cb156c05e98e61486b044122adb8cc19153763ccfdbfd0cce876eaf2edc` with
outcome `ship`, `attestationId: null`, and `shadowOnly: true`. This job declared
no Environment, so GitHub created no deployment metadata for it.

**Protected sign-off run**
[`30719740050`](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/actions/runs/30719740050):
a deterministic `TLS.REJECT_UNAUTHORIZED_FALSE` finding at
`src/legacy-client.ts:10` (complete coverage, candidate CI passed) produced
`sign-off-required` report
`rr_9e541a6fb0ee34ae56362ee60d28246a03daf3e764fbbdad50df5849967bbd20` with
request observation
`rrq_612518f1f7b5f3e21cb34c056ab9f20ad83c5fc80a819f749217da275870011d`. The
protected Environment paused for a real GitHub reviewer; approval-history lookup
recorded reviewer/responsibility accepter `esbenwiberg` (id `32299026`), matching
the OIDC actor. Attestation
`ra_4198fa4d3cb88484730f99481115567dbe50daf17abe3b1c5683a7bb7832e24f` (version 2)
and terminal authorization
`auth_7c7eac823172e916e0abf6d9cd4010fc3124021c08776d4635ef200de5029e77` (outcome
`sign-off-required`, exact report/envelope/workflow/run/attempt binding,
`shadowOnly: true`) were both posted inside that one protected Environment job.

**Deployment-metadata nuance.** Because the sign-off job declared the protected
Environment, GitHub itself automatically created an Environment deployment audit
metadata record `5708556980` plus waiting/queued/in_progress/success statuses for
that job. That record is GitHub's own platform bookkeeping. No application,
package, image, release, infrastructure, or other product deployment or
publication occurred: the reusable workflow holds no `deployments` write
permission and invokes no deployment/status API or CLI command. The previously
absolute "creates no deployment/status/SCM effect" phrasing in the workflow
comments and runbooks was corrected to this precise authority fence.

An earlier disposable run
[`30716954315`](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/actions/runs/30716954315)
demonstrated the protocol failing closed before these two successful runs.

**Why this is still partial.** Both runs used the fake / no-model backend, so
exit-evidence criterion 6 (at least one hosted report through a real Foundry
model backend) remains unmet. Fake/no-model evidence cannot earn the real-model
criterion, and the campaign result stays `not yet verified` until a real Foundry
model deployment produces and retrieves at least one report and the remaining
live gaps are closed.

## Reflection

The complete envelope is a viable durable subject: removing candidate-only
collapse did not require a parallel release authority or a change to the decision
kernel. GitHub OIDC can identify the calling workflow, but it does not establish
the human reviewer; independent approval-history lookup remains necessary and
justifies the narrowly added `Actions: read` permission. Managed identity keeps
a Foundry API key out of the service, but model purchase, role assignment, and
live evidence remain consequential human gates. Until those changed-reality
checks pass, the honest result is `not yet verified`, not authority.
