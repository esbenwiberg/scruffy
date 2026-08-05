---
title: "Enforce prerequisite readiness and freshness in hosted release authority"
touches:
  - src/app/release-authority.ts
  - src/domain/release/authority.ts
  - src/persistence/release-authority.ts
  - src/server/http.ts
  - src/server/main.ts
  - src/providers/scm/factory.ts
  - test/server/
  - test/persistence/
does_not_touch:
  - src/providers/models/
  - infra/azure/
  - .github/workflows/release-authority-shadow.yml
---

## Task

Wire repository-owned prerequisite assessment into the authenticated hosted release protocol and terminal authority boundary.

Before returning an approvable report, read candidate configuration, authority changes, and current exact workflow evidence. Pending prerequisites return an explicit retryable not-ready response. Missing/invalid configuration, absent workflow runs, identity mismatch, and unverifiable provider evidence fail closed and cannot enter the protected Environment. Terminal workflow failure and authority change may produce `sign-off-required` reports under brief 03's rules.

Immediately before automatic or exception authorization, re-fetch candidate configuration and every current workflow run/attempt. Canonicalize the fresh snapshot and require exact equality with the report snapshot/evidence digest. A newer attempt, pending rerun, changed conclusion, changed authority file, mismatch, or provider failure refuses authorization and requires a fresh report. Keep the latest-report PostgreSQL fence as the final durable authority check.

Persist sufficient prerequisite identity in report-request observations, attestations, and authorizations to audit which evidence snapshot was authorized. Preserve existing actor/accepter/reviewer equality and exact report/envelope binding.

## Constraints

- Never treat pending, absent, invalid, or unverifiable evidence as terminal workflow failure.
- Never allow protected sign-off to override a deterministic stop.
- Provider revalidation must happen for both `ship` and `sign-off-required` immediately before persistence.
- No caller-supplied workflow conclusion or run identity is authoritative.
- Preserve OIDC, endpoint, environment, and least-privilege boundaries.
- Do not publish or deploy.
- Follow parent design and briefs 01–03.

## Test expectations

Create focused tests named:

- `"hosted prerequisite readiness"`: green reaches analysis; terminal failure/change reaches sign-off; pending is retryable; invalid/absent/unverifiable never enters approval.
- `"authorization workflow freshness"`: exact unchanged evidence authorizes; newer attempt, pending rerun, changed conclusion, authority mutation, mismatch, and provider failure refuse both paths.
- `"prerequisite-bound attestation"`: sign-off and responsibility bind the exact prerequisite-aware report and cannot carry to a successor.
- `"terminal prerequisite authority atomicity"`: forced persistence races cannot authorize a report superseded by fresh workflow evidence.

The obvious broken implementation checks workflows only at report creation; mutation between report/approval and authorization must fail it.

## Wrap-up

Run focused and full validation. Record HTTP status/retry semantics and external calls. Commit without live GitHub/Azure changes.
