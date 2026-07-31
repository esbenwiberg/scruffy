# C001: Release risk report authority

## Status

`paused`

Implementation was explicitly approved and dispatched as Autopod series
`release-risk-report-authority`. The root pod is paused by provider capacity;
this still does not authorize an authoritative release workflow.

## Origin

Accepted direction:

- [`../product/release-risk-report.md`](../product/release-risk-report.md)
- [`../product/vision.md`](../product/vision.md)
- [`../product/opt-in-repository-integration.md`](../product/opt-in-repository-integration.md)

Decisive repository evidence:

- `src/gates/release/analyze.ts` already reviews the immutable release range,
  but returns findings and aggregate coverage rather than a first-class report.
- `src/providers/analyzers/model-analyzer.ts` is a bounded, line-level semantic
  defect analyzer, not a range-level release-risk analyst.
- `src/gates/release/decision.ts` already prevents incomplete coverage from
  producing `ship` and prevents model-only evidence from producing `stop`.
- `src/effects/check-run.ts` deliberately emits an advisory, terse release
  summary and cannot yet serve as the authoritative report.
- `migrations/0004_release.sql` persists an aggregate decision but has no
  report identity or evidence-lane manifest.

## Mission

Mature the boundary that turns an immutable release candidate and its required
evidence into one complete, inspectable, SHA-bound release risk report and
honest advisory outcome.

## Earned gain

**Exactly one gain:** For one controlled, opted-in GitHub repository, every
shadow release candidate receives a persisted SHA-bound report that can produce
`ship` only when all policy-required evidence is complete and no unresolved
release risk remains.

This gain is about the trustworthiness and inspectability of the report
boundary. It does not claim general defect detection, production calibration,
or authority to publish automatically.

## Weak boundary

```text
immutable previous-release and candidate SHAs
+ service-owned release policy
+ declared deterministic, LLM, and candidate-CI evidence
  -> range-level analysis, evidence manifest, validation, and decision kernel
  -> persisted release risk report + congruent advisory GitHub summary
```

Today this boundary loses important information between analysis and the
human-facing check: there is no first-class report identity, no declared
per-lane completeness, no range-level LLM risk assessment, and no proof that a
visible clean result represents every required evidence lane.

## Authority fence

### Campaign-level authority

The campaign may define and implement:

- the versioned release-report schema and persistence shape;
- policy-declared evidence-lane applicability and completeness;
- a structured, cited, range-level LLM risk analyst;
- report assembly and derivation of the existing release outcomes;
- a human-facing advisory report and GitHub summary derived from the same
  persisted evidence;
- bounded corpus, harness, persistence, and shadow validation for this boundary.

### Worker-local authority

Workers may choose reversible module boundaries, internal names, query shapes,
and test organization that preserve this contract and existing provider
boundaries. They may add migrations but may not rewrite or delete historical
migrations.

### Human gates

Explicit human approval is required before:

- dispatching implementation;
- changing the campaign mission, earned gain, evidence standard, or invariants;
- enabling a required release check or automatic publication;
- accepting a model-only release stop;
- weakening a required evidence lane or treating a failed lane as clean;
- waiving failed validation or accepting the campaign as complete.

### Escalation conditions

Pause and return for human review or renewed deliberation if implementation
requires:

- a new administrative control plane;
- repository-controlled weakening of service policy;
- production credentials in analyzed repository code or workflows;
- a generalized waiver system;
- a release outcome outside `ship`, `sign-off-required`, `stop`, and
  `indeterminate`;
- a claim that the initial corpus establishes general production accuracy.

## Invariants

1. Reports and evidence are bound to immutable previous-release and candidate
   SHAs.
2. `ship` requires every policy-required evidence lane to be complete or
   policy-declared not applicable.
3. No findings is not equivalent to complete review.
4. LLM output is untrusted, schema-validated, cited to real evidence, and never
   self-promoted to deterministic trust.
5. Model-only risk may escalate but cannot manufacture `stop`.
6. A confirmed deterministic stop cannot be softened by missing evidence in
   another lane.
7. Missing, stale, failed, unsupported, or truncated required evidence cannot
   auto-ship.
8. The persisted report, decision, and GitHub summary are derived from the same
   evidence and cannot disagree about outcome or coverage.
9. Report generation and replay are idempotent for the same candidate, previous
   release, and policy version.
10. The campaign remains shadow-only; it does not publish a release.

## Pressure cases

### Accepted behavior

- A candidate with complete required deterministic, LLM, and candidate-CI
  evidence and no unresolved risks produces a clean report and advisory
  `ship`.
- A policy-declared non-applicable lane is visible and does not prevent `ship`.
- Re-evaluating the same immutable range and policy produces the same report
  identity or an auditable, explicitly versioned successor without duplicate
  effects.

### Ambiguous behavior

- A cited, consequential model risk without deterministic corroboration
  produces `sign-off-required` and explains the unresolved scenario.
- A required analyzer or LLM lane that is partial, truncated, unavailable, or
  unparseable produces `sign-off-required`, not a clean report.
- Required candidate-CI evidence that is missing or stale produces
  `sign-off-required`.

### Rejected behavior

- A deterministically confirmed leaked credential or destructive data change
  produces `stop`; model disagreement or another incomplete lane cannot soften
  it.
- An uncited or out-of-schema LLM claim cannot become a persisted risk finding.
- A report for one candidate SHA cannot authorize or describe another SHA.

### Failure behavior

- Failure to resolve or read the immutable range, assemble the report, or
  persist a trustworthy decision produces `indeterminate` and no clean report.
- Report/check disagreement fails validation and cannot be presented as a
  successful campaign result.

## Ordered delivery slices

### 1. Establish the executable report boundary

Define a versioned report schema, evidence-lane manifest, stable report
identity, and persistence path. Derive outcome and the advisory summary from
that report without changing current shadow authority.

This slice is first because every later analyzer and evidence source needs one
place to express provenance, applicability, completeness, risks, and gaps.

### 2. Add range-level LLM release-risk analysis

Add a dedicated analyst that assesses interactions across the immutable release
range under the fixed service-owned risk vocabulary. Require structured risk
scenarios, real citations, explicit unknowns, and coverage reporting.
Preserve the existing line-level model analyzer unless evidence justifies
replacement.

This slice depends on the report schema so model output cannot create an
untyped parallel report.

### 3. Make required evidence explicit

Represent deterministic analysis, range-level LLM analysis, and candidate-CI
as policy-declared lanes for the controlled repository. Preserve extension
points for prior-gate, visual, deployment, migration, and rollback evidence,
but permit `not-applicable` only through service policy.

This campaign need not implement every future evidence provider. It must prove
that an absent required provider cannot disappear from the report or yield
`ship`.

### 4. Produce the congruent human-facing report

Render coverage before finding counts, show holding and cleared risks, expose
missing evidence and provenance, and make the available action unambiguous.
Post a concise advisory GitHub check derived from the persisted report, with a
way for the operator to inspect the complete report.

### 5. Apply integrated shadow pressure

Replay the accepted, ambiguous, rejected, and failure cases through the durable
path. Run the report against a controlled GitHub release candidate without
making the check required. Record mismatches, unsafe ships, false sign-off load,
coverage behavior, cost, and latency honestly.

## Exit evidence

The campaign earns its gain only when all of the following changed-reality
evidence exists:

1. An integrated durable-path test demonstrates every pressure case above,
   including candidate binding, report/check congruence, and failure behavior.
2. The accepted campaign corpus records zero `ship` outcomes for truth-labeled
   `sign-off-required` or `stop` cases. Any unsafe ship falsifies the gain.
3. Every report in the integrated corpus contains all policy-declared evidence
   lanes; deleting, failing, truncating, or staling a required lane changes a
   would-be `ship` to `sign-off-required` or `indeterminate`.
4. Model risks retained in reports cite real changed evidence; malformed,
   uncited, or hallucinated references are rejected or become explicit coverage
   gaps.
5. A database-backed replay proves report, decision, findings, and outbox effect
   commit atomically and idempotently.
6. At least one controlled GitHub shadow candidate produces a persisted report
   and a matching advisory `scruffy/release` summary for the same immutable SHA.
7. Validation records the full test, typecheck, lint, formatting, relevant
   corpus, database-backed, and live-shadow commands that ran; commands not run
   or environment-blocked are listed separately.

Passing these criteria supports only the stated controlled-repository report
gain. It does not by itself authorize automatic publication. Missing the live
shadow evidence leaves the campaign `not yet verified`; an unsafe ship leaves it
`failed` or `narrowed`, not complete.

## Non-goals

- Automatic release publication or a protected-environment approval workflow.
- Making `scruffy/release` required on a production repository.
- A custom approval, identity, role, policy-administration, or waiver UI.
- Implementing every future evidence provider, including universal visual or
  deployment analysis.
- Numeric model risk scores as release authority.
- General production-accuracy claims from synthetic or single-repository data.
- Auto-merging nightly fixes or changing poison-gate authority.
- Replacing repository CI or executing repository-controlled release code with
  Scruffy credentials.

## Results

Autopod series `release-risk-report-authority` was dispatched as four dependent
pods in single-PR mode with full validation. Root pod `brainy-puma` failed before
reading or changing code because the configured Claude account reported its
session limit, resetting at 12:30 UTC on 2026-07-28. The three dependent pods
remain queued. No implementation, validation, token usage, or cost was recorded,
so the campaign is `paused` rather than failed.

## Reflection

Not yet available. Complete this section from integrated evidence before final
human acceptance or proposing downstream publication authority.
