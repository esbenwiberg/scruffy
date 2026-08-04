---
title: "Expose repository prerequisite routing in the reusable release workflow"
touches:
  - .github/workflows/release-authority-shadow.yml
  - docs/product/cd-release-gate.md
  - docs/product/opt-in-repository-integration.md
  - docs/product/github-app-setup.md
  - docs/product/azure-shadow-deployment.md
  - README.md
  - test/
does_not_touch:
  - src/gates/release/decision.ts
  - src/providers/models/
  - infra/azure/main.bicep
---

## Task

Complete the caller and human-facing integration for repository-owned workflow prerequisites.

Update the reusable shadow release-authority workflow to handle hosted readiness semantics safely. Pending prerequisites may be retried with a bounded backoff or fail explicitly with a retry instruction; they must never enter the protected Environment. Invalid, absent, or unverifiable prerequisites fail closed. Terminal workflow failure and release-authority change route through the existing protected sign-off job with exact report binding.

Render bounded, non-secret job summaries showing candidate/artifact/report identity, every required workflow's path, run URL, run ID/attempt and conclusion, failed workflows prominently, authority-change paths, old/new required workflow sets, and why sign-off is requested. Never print OIDC tokens, authorization headers, unrestricted report JSON, or sensitive findings.

Document `.github/scruffy-release.yml`, first-adoption baseline sign-off, incremental workflow adoption, failure exception behavior, pending/missing distinctions, rerun invalidation, CODEOWNERS/branch-protection recommendations, and explicit administrator opt-out. Preserve the reusable workflow's fixed endpoint/audience and least permissions.

Add deterministic workflow/client tests or shell fixtures for green, failed-approved, pending, invalid/missing, authority-changed, and rerun/stale paths. Do not execute live GitHub Actions or Azure deployment.

## Constraints

- Repository workflow paths come from the exact candidate configuration read by Scruffy, not new caller inputs.
- Keep `contents: read` and `id-token: write` as the reusable workflow's only permissions.
- No publication/deployment/status/check/issue/PR write operation.
- Protected sign-off remains available only for exact `sign-off-required` reports.
- Bounded retry must terminate and fail closed.
- Follow all parent and dependent brief contracts.

## Test expectations

Create focused tests named:

- `"reusable prerequisite routing"`: green, failed, pending, missing/invalid, changed authority, and stale evidence route correctly.
- `"prerequisite release summary redaction"`: required workflow evidence is visible while tokens, headers, full reports, and sensitive findings are absent.
- `"repository prerequisite adoption docs"`: examples use the narrow schema and accurately describe baseline, sign-off, pending, rerun, and opt-out behavior.

The obvious broken workflow treats every non-green state as sign-off; pending/missing fixtures must fail it.

## Wrap-up

Run focused and full validation, inspect the workflow permission/effect diff manually, update product documentation, and commit. Do not update a disposable caller, App permission, Environment, or Azure revision.
