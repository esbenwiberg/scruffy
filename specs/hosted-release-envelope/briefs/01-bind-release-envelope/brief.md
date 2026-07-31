---
title: "Bind release reports and persistence to the complete deployment envelope"
touches:
  - src/domain/release/report.ts
  - src/domain/release/signoff.ts
  - src/gates/release/service.ts
  - src/app/scruffy.ts
  - src/persistence/runs.ts
  - migrations/
  - scripts/release-review.ts
  - src/gates/release/report.test.ts
  - test/harness/release.test.ts
  - test/persistence/
does_not_touch:
  - src/server/http.ts
  - src/server/main.ts
  - src/providers/models/
  - infra/azure/
---

## Task

Make the complete deployment envelope the release report's canonical subject and
durable identity. Add artifact digest and target environment to the release input,
report schema/content digest, responsibility wording, persistence columns/query
shape, command outputs, and all construction paths. Preserve historical report
readability through explicit versioning, but make historical reports structurally
ineligible for full-envelope authorization.

Remove the existing candidate-only collision. Two release requests may share
repository, previous-release SHA, candidate SHA, and policy while carrying
different artifact digests or target environments; both must be independently
persistable and retrievable. Exact retries remain idempotent. Choose a reversible
internal run/lineage representation, but do not mutate historical migrations or
silently overwrite one envelope with another.

Add typed persistence/application seams for exact report lookup and for the
attestation/authorization records brief 02 will own. The store contract must make
atomic, idempotent writes possible and must parse untrusted JSON through runtime
schemas at reads. It is acceptable for brief 01 to define the typed records and
persistence tables while leaving OIDC/GitHub verification and hosted routes to
brief 02.

Keep the existing release decision kernel and outcomes unchanged. Keep
`publishReleaseCheck: false` behavior and zero SCM effects in CD mode.

## Governing constraints

Read and preserve:

- the campaign gain, authority fence, invariants, pressure behavior, and non-goals reproduced in this series' `purpose.md` and `design.md`;
- existing additive-migration and lease-fencing patterns in `src/persistence/`.

In particular:

- Require a canonical `sha256:<64 lowercase hex>` artifact digest and a bounded,
  non-empty target environment at the inbound boundary.
- Candidate, previous release, artifact, environment, report content, policy,
  and provenance all participate in report identity.
- Any envelope mutation invalidates responsibility wording and future authority.
- Do not invent a public endpoint, approval protocol, model configuration, or
  real deployment in this brief.
- Preserve poison/nightly behavior and stored historical data.

## Expected implementation surface

- Versioned release subject/report runtime schemas and canonical identity.
- Updated `ReleaseInput` / `Scruffy.runRelease` input threading.
- Additive migration(s) and release persistence methods that support multiple
  full envelopes for one candidate.
- Exact lookup by report ID and complete envelope.
- Runtime-schema types/store scaffolding for approval attestations and shadow
  authorizations, without pretending unverified records are valid.
- Updated manual CD command arguments/outputs/report rendering.
- Unit and real-PostgreSQL pressure tests.

## Test expectations

Name focused test groups so contract commands select only their intended facts:

- `"release envelope identity"`: exact replay keeps the same report ID; changing
  candidate, previous release, artifact digest, target environment, policy,
  provenance/evidence, or decision changes it; malformed digests/environments
  fail schema parsing.
- `"release envelope persistence"`: same candidate with two artifacts and two
  environments produces distinct durable reports, exact retries dedupe, and
  exact lookups never return a neighboring envelope.
- `"historical release report compatibility"`: a stored v1 report remains
  inspectable through its historical parser/migration path but is explicitly not
  a full-envelope authorization subject.
- Existing release harness and script tests continue to prove report-only CD
  behavior and zero SCM effects.

The obvious broken implementation for the identity fact is adding fields to
rendering but excluding them from `computeReportId`; the mutation assertions
must fail against it. The obvious broken persistence implementation is retaining
`(repository, candidate, kind)` as the only idempotency key; the same-candidate
multi-envelope database test must fail against it.

## Wrap-up

1. Run the focused required facts.
2. Run full repository validation required by the profile.
3. Record migration/backward-compatibility decisions in the completion summary.
4. Commit and push; do not perform cloud or GitHub configuration changes.
