---
title: "Bind reports and persistence to workflow prerequisite snapshots"
touches:
  - src/domain/release/report.ts
  - src/domain/policy/types.ts
  - src/gates/release/
  - src/app/scruffy.ts
  - src/persistence/runs.ts
  - src/persistence/release-authority.ts
  - migrations/
  - test/persistence/
  - src/gates/release/*.test.ts
does_not_touch:
  - src/server/http.ts
  - src/providers/identity/
  - .github/workflows/release-authority-shadow.yml
---

## Task

Introduce the versioned release-report and persistence changes needed to make repository configuration, authority-change assessment, and exact required-workflow evidence authoritative report content.

Add a typed prerequisite snapshot to a new report schema version. Include canonical config identity, baseline/change facts, every exact workflow run/attempt, classified state, aggregate state, and a canonical evidence digest in report identity. Historical reports remain inspectable but cannot satisfy the new prerequisite authority contract.

Integrate terminal prerequisite results into the release decision: all passed leaves the normal decision unchanged; terminal workflow failure, first baseline, or authority change forces `sign-off-required`; confirmed deterministic `stop` still dominates. Pending, absent, invalid, and unverifiable prerequisites must not become approvable reports.

Change release-run idempotency so the same deployment envelope and policy can produce a successor report when the canonical prerequisite snapshot changes. Exact unchanged retries dedupe. A successor must become latest for the existing envelope authority fence, making previous reports and attestations ineligible without mutating history.

## Constraints

- Use additive migrations only; never edit historical migrations.
- Preserve the deployment envelope as the release subject; prerequisite snapshots are identity-bearing evidence, not caller-controlled envelope fields.
- Keep stable, runtime-validated schemas and canonical hashes.
- Do not silently rewrite an existing report when workflow evidence changes.
- Preserve local/corpus context-based candidate-CI compatibility until separately retired.
- Do not add hosted HTTP behavior or live provider revalidation in this brief.
- Follow all parent design invariants and prior brief contracts.

## Test expectations

Create focused tests named:

- `"workflow prerequisite report identity"`: every config, authority, workflow identity, attempt, status, and conclusion mutation changes report ID; exact replay does not.
- `"workflow prerequisite decision routing"`: green is normal, terminal failure/baseline/change sign off, pending/absent/unverifiable are ineligible, and deterministic stop wins.
- `"workflow evidence successor persistence"`: real PostgreSQL exact retries dedupe; changed evidence creates a successor; latest-envelope lookup rejects the old report.
- `"historical prerequisite report compatibility"`: older reports remain readable but cannot authorize under the new contract.

The obvious broken implementation mutates one report or keeps release-run uniqueness independent of evidence; the successor database fact must fail it.

## Wrap-up

Run focused facts and full validation, record migration and report-version decisions, and commit. Do not alter hosted workflows or external settings.
