---
title: "Add the OIDC-authenticated hosted release and shadow-authorization protocol"
touches:
  - src/server/http.ts
  - src/server/main.ts
  - src/app/
  - src/domain/release/
  - src/persistence/
  - src/providers/scm/
  - migrations/
  - test/server/
  - test/persistence/
  - test/providers/
  - docs/product/github-app-setup.md
  - docs/product/cd-release-gate.md
does_not_touch:
  - src/gates/release/decision.ts
  - src/providers/models/
  - infra/azure/
  - scripts/deploy-azure-shadow.sh
---

## Task

Build the narrow hosted protocol in `design.md` on top of brief 01's complete-
envelope report and persistence seam:

1. authenticate controlled GitHub Actions callers with short-lived OIDC tokens;
2. request and retrieve one durable hosted release report;
3. verify and persist one exact protected-environment exception attestation;
4. terminally re-read and revalidate durable state before persisting/returning a
   shadow authorization.

Use the accepted OIDC protocol. Validate GitHub's issuer/signature/JWKS, fixed
Scruffy audience, lifetime, repository name and stable ID, `job_workflow_ref`,
run ID/attempt, actor name and stable ID, and configured Environment posture.
Trust configuration is service-owned and fail-fast at boot. Do not accept
request-supplied allowlists or silently downgrade failed verification.

Add a provider-neutral workflow-approval reader and GitHub App implementation
for `GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals`. The App requires
read-only Actions permission; document that human-gated permission expansion.
The request may supply rationale, explicit responsibility acceptance, and the
expected accepter, but never authoritative reviewer identity. Persist an
attestation only when GitHub records an approval for the configured protected
Environment and OIDC actor, accepter, and actual reviewer stable identities are
equal.

Authorization must return only a typed `shadowOnly: true` record/reference. It
must not publish, deploy, post a check, emit an SCM effect, or return a
credential. `ship` requires no attestation; `sign-off-required` requires the
exact matching attestation; `stop` and `indeterminate` are ineligible. Re-read
the report and attestation and compare every envelope field immediately before
committing authorization.

## Hosted API boundary

Implement the four semantics from `design.md` with versioned JSON schemas and
bounded request bodies. Exact route names may be adjusted consistently, but keep
report request/retrieval, attestation, and terminal authorization distinct.

- Require `Authorization: Bearer <GitHub OIDC JWT>` on every release/report
  route. Existing `/healthz` and GitHub webhook behavior remain unchanged.
- Return explicit 400/401/403/404/409 classes for caller-correctable failures and
  generic 500 errors for internal faults. Do not leak JWTs, report contents, or
  internal diagnostics to logs/responses.
- Do not hold the HTTP request open across unbounded reconciliation. A hosted
  request may drive bounded work synchronously if the existing service contract
  permits it, or expose an honest accepted/poll flow; either way retries must be
  idempotent and terminal retrieval deterministic.
- Report retrieval is authenticated; no public report page/capability URL.

## Constraints

- Preserve every campaign invariant and pressure case reproduced in the series `purpose.md` and `design.md`.
- Use a vetted JWT/JWK implementation rather than handwritten cryptography.
- Tests must not call live GitHub or the public OIDC issuer. Use locally signed
  JWTs and a deterministic discovery/JWKS fixture, including key rotation.
- Bound discovery/JWKS timeouts and cache; unknown `kid` or stale/unavailable keys
  fail closed.
- App permission expands only to `Actions: read`; do not add workflow,
  deployment, environment, contents-write, or administration authority.
- The GitHub approval reader is independently injectable and testable.
- Persist report, attestation, authorization, and idempotency facts atomically
  where authority could otherwise split.
- Keep the decision kernel and four outcomes unchanged.
- Do not add Azure model/deployment configuration in this brief.

## Test expectations

Create focused tests named:

- `"GitHub Actions OIDC trust pressure"`: valid token succeeds; wrong issuer,
  audience, signature/key, expiry/not-before, repository name/ID, workflow ref,
  run, actor, or environment posture fails before the release service is called;
  safe key rotation is covered.
- `"hosted release report protocol"`: valid authenticated request persists one
  complete-envelope report and authenticated retrieval returns the parsed exact
  report; retries dedupe; neighboring envelopes do not collide; no SCM effect.
- `"protected environment attestation"`: non-empty rationale, explicit
  acceptance, and actual GitHub approval are required; actor/accepter/reviewer
  equality uses stable IDs; unavailable, rejected, ambiguous, different-user,
  different-run/environment/report/envelope cases persist nothing.
- `"terminal shadow authorization"`: `ship` authorizes without attestation,
  `sign-off-required` only with the exact verified attestation, and `stop` /
  `indeterminate` never authorize; mutation of any envelope/report/workflow
  field between report/attestation and terminal call fails.
- `"authority idempotency and atomicity"`: real PostgreSQL retries produce one
  attestation/authorization and forced transaction failures leave no partial
  authority record.

The obvious broken OIDC implementation checks only signature/issuer; the claim-
mutation matrix must fail it. The obvious broken attestation trusts a supplied
reviewer; the fake GitHub approval mismatch must fail it. The obvious broken
authorization trusts the prior request body; mutating durable envelope fields
before terminal authorization must fail it.

## Wrap-up

1. Run every focused required fact and full profile validation.
2. Record the exact App permission and service-owned trust configuration.
3. Keep all external permission/deployment/live actions listed as not run.
4. Commit and push; do not change the live App, Environment, or Azure service.
