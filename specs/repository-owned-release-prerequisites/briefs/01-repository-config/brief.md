---
title: "Parse repository-owned release prerequisites and detect authority changes"
touches:
  - src/domain/release/
  - src/gates/release/
  - src/providers/scm/port.ts
  - src/providers/scm/fake.ts
  - test/domain/
  - test/gates/
does_not_touch:
  - src/providers/scm/github-app-reader.ts
  - src/persistence/
  - src/server/
  - .github/workflows/release-authority-shadow.yml
---

## Task

Implement the pure and provider-neutral foundation for `.github/scruffy-release.yml` described in the series design.

Add a strict version-1 YAML parser whose only repository-controlled choice is a non-empty, unique list of canonical workflow paths below `.github/workflows/`. Reject unknown keys/versions, duplicate keys, aliases, unsafe tags, empty lists, malformed paths, and the Scruffy release workflow as a self-prerequisite. Treat raw repository content as untrusted at every boundary.

Add release-authority baseline assessment over the immutable `(previousReleaseSha, candidateSha]` range. Read candidate configuration at the exact candidate SHA and previous configuration when a previous release exists. Detect first adoption and changes under `.github/scruffy-release.yml`, `.github/workflows/**`, or `.github/actions/**`. Produce a typed, deterministic assessment consumed by later briefs; do not yet add GitHub Actions run queries, report v3 persistence, or hosted routing.

Configuration changes and authority-path changes are exception reasons, not hard stops. Missing, malformed, or empty candidate configuration is ineligible rather than an approvable exception. A first release or first readable configuration establishes a baseline through mandatory sign-off.

## Constraints

- Preserve service-owned outcome semantics; repository YAML selects paths only.
- Do not add branch, event, endpoint, environment, waiver, or result-mapping fields.
- Compare canonical parsed configuration for semantic changes while also recording exact changed authority paths.
- Keep first-release and absent-previous-config behavior explicit and deterministic.
- Existing poison, nightly, local release, and corpus behavior must remain compatible.
- Follow the full purpose/design invariants in the parent folder.

## Test expectations

Create focused tests named:

- `"repository release config parsing"`: accepts the minimal valid schema and rejects every malformed/weakening shape.
- `"release authority change detection"`: unchanged config/authority is clean; first adoption and changes to config, workflows, and local actions require sign-off; unrelated source changes do not.
- `"invalid repository release config"`: missing, malformed, empty, or self-referential candidate configuration is authorization-ineligible.

The obvious broken implementation uses a permissive YAML object or allows an empty workflow list; mutation cases must fail it. The obvious broken change detector checks only the configured top-level workflow and misses a changed local reusable workflow/action; broad path cases must fail it.

## Wrap-up

Run focused facts and full repository validation, document parser safety decisions, and commit. Do not change live GitHub/Azure configuration.
