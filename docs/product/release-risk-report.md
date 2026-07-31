# Release risk report contract

## Status

Accepted product direction. The contract describes the target behavior; the
current walking skeleton implements only part of it. Bounded maturation of the
report authority boundary is designed in
[`../campaigns/C001-release-risk-report-authority.md`](../campaigns/C001-release-risk-report-authority.md).

## Purpose

Before publication, Scruffy produces one release risk report for the immutable
range `(previous release, candidate]`. The report explains what changed, what
required evidence was reviewed, which risks remain, and why the release outcome
is `ship`, `sign-off-required`, `stop`, or `indeterminate`.

A complete, clean report permits automatic publication. Routine human approval
is not required. Human attention is reserved for unresolved consequential risk
and incomplete evidence.

The report is an evidence-backed decision record, not a transfer of
responsibility to a reviewer. Scruffy remains responsible for applying its
service-owned policy honestly. A human approving an exception is responsible
for that explicit exception decision, which is recorded against the exact
candidate and report.

## Authority

Scruffy's service-owned policy defines:

- risk categories and release relevance;
- required evidence lanes and applicability rules;
- stop and sign-off conditions;
- requirements for deterministic corroboration;
- acceptable coverage and freshness;
- exception and waiver authority.

An LLM may assess changes against that policy. It must not invent policy, weaken
requirements, grant waivers, or independently decide that incomplete evidence
is safe.

The pure release decision kernel remains the final decision authority.

## Unit of review

Every report is bound to:

- repository identity;
- previous-release commit SHA, or an explicit first-release marker;
- candidate commit SHA;
- policy version;
- analyzer, validator, model, and prompt versions;
- a stable report identifier or digest.

Publication must use the same candidate SHA. A moved tag, branch, rebuilt
artifact from another revision, or changed candidate invalidates the report and
requires a new evaluation.

The release range is the primary unit, not a collection of independent PR
approvals. Analysis must consider interactions among changes accumulated since
the previous release.

## Evidence lanes

Policy declares each lane required, optional, or not applicable for a release.
The report records every declared lane even when it produced no findings.

Initial target lanes are:

1. deterministic source and configuration analysis;
2. LLM release-risk analysis;
3. repository CI evidence for the candidate SHA;
4. relevant poison and nightly history, rerun or reconciled against the
   candidate where policy requires it;
5. release-specific checks, including visual evidence for applicable
   applications;
6. deployment, migration, dependency, and rollback evidence required by policy.

Each lane records:

- applicability and whether it is required;
- status: `complete`, `partial`, `failed`, or `not-applicable`;
- immutable subject and provenance;
- evidence freshness;
- findings and contradictions;
- coverage gaps, truncation, unsupported areas, and unavailable context.

`not-applicable` is clean only when service-owned policy—not repository content
or the LLM—establishes that the lane does not apply.

## LLM release-risk analysis

A dedicated release-risk analyst reviews `(previous release, candidate]` and
produces structured, cited risk hypotheses. It is distinct from a line-level
semantic-defect analyzer.

The analyst should assess:

- security, authentication, authorization, and trust-boundary changes;
- data models, migrations, retention, integrity, and compatibility;
- APIs, events, schemas, packages, and consumer compatibility;
- dependencies, configuration, feature flags, and infrastructure;
- deployment sequencing, operability, observability, and rollback;
- user-visible behavior and applicable visual changes;
- interactions among changes in the release range;
- blast radius, reversibility, detectability, and missing context.

Every risk hypothesis must include:

- a stable category and concise scenario;
- concrete citations to changed files, lines, artifacts, or evidence;
- affected assets, users, or systems when known;
- potential impact and failure mode;
- reversibility, detectability, and rollback considerations;
- supporting and contradicting evidence;
- explicit uncertainty and missing context;
- a policy-defined recommended effect: escalate, request corroboration, or
  treat as not release-relevant.

The model must not assign itself deterministic trust. Unsupported prose,
uncited claims, output outside the schema, prompt failure, context truncation,
or provider failure creates a coverage gap rather than a clean result.

Numerical likelihood or aggregate risk scores must not control release outcomes
unless they are prospectively calibrated and separately adopted into policy.

## Clean-report invariant

A report is clean and may produce `ship` only when all of the following hold:

1. the report is bound to the immutable candidate being published;
2. every policy-required evidence lane is complete or policy-declared
   not-applicable;
3. required evidence is current for the candidate SHA;
4. no confirmed stop-class finding remains;
5. no unresolved sign-off-class finding or LLM risk hypothesis remains;
6. all surfaced risks are refuted, cleared, or not release-relevant under
   recorded reasons;
7. no analyzer, model, validator, input, or output coverage gap is hidden;
8. the decision and human-facing report are derived from the same persisted
   evidence.

"No findings" is not synonymous with clean. A blind, failed, stale, truncated,
or unsupported review cannot auto-ship.

## Outcome rules

### `ship`

The clean-report invariant holds. The controlled workflow may publish without
routine human sign-off.

### `sign-off-required`

No confirmed stop controls the outcome, but at least one consequential risk or
coverage gap remains unresolved. The report must say exactly what requires the
human decision.

A protected GitHub Environment requests an authorized reviewer. Approval is
bound to the candidate SHA and report identifier and records the approver,
timestamp, and stated exception rationale. Because GitHub Environment review
comments are optional, the controlled workflow must separately require the
exact candidate SHA, report identifier, a non-empty rationale, and an explicit
responsibility acknowledgement before entering the environment gate.

Every approval surface must state:

> By approving this exception, you personally accept responsibility for
> releasing the exact candidate despite the unresolved risks and evidence gaps
> recorded in the exact report. Scruffy has not certified this release as safe.
> The approval applies only to that candidate and report.

A changed candidate or successor report requires a new approval. Ordinary
sign-off cannot override `stop` or `indeterminate`.

### `stop`

Policy-defined deterministic evidence confirms a stop-class defect. A model-only
claim can never manufacture `stop`.

The initial contract provides no ordinary sign-off path that converts `stop`
into `ship`. Any future waiver mechanism must be separately designed,
authorized, and audited.

### `indeterminate`

Scruffy cannot produce or persist a trustworthy decision—for example, it cannot
resolve or read the immutable candidate or the analysis machinery fails before
a report can be completed. Automatic publication is forbidden.

A completed report with a localized analyzer or model coverage gap normally
uses `sign-off-required`; failure to produce a trustworthy report at all uses
`indeterminate`.

## Human-facing report

The report presentation must make the following visible without implying that
absence of displayed findings means complete review:

1. candidate and previous-release SHAs;
2. outcome and stable reason codes;
3. coverage status before finding counts;
4. required, complete, partial, failed, and not-applicable evidence lanes;
5. release change summary;
6. confirmed blockers and unresolved risks;
7. cleared or contradicted risks with their reasons;
8. unsupported areas and missing evidence;
9. policy and analysis provenance;
10. outstanding work, separated from release authority:
    - open issues carrying the exact `bug` label;
    - an optional collapsed count/link for unrelated open pull requests;
    - merged pull requests included in the release range, when that provenance is available;
    - unresolved Scruffy nightly findings, child issues, fix PRs, delivery
      failures, CI/merge state, and awaiting-verification work;
11. the exact action available: publish, review exception, or stop;
12. for `sign-off-required`, the exact SHA/report-bound human responsibility
    statement.

Repository bug backlog and unrelated open pull requests are context only. Their
presence or volume cannot change the release outcome unless separately
corroborated by a policy-authoritative evidence lane. Snapshot truncation or
read failure must be visible rather than rendered as an empty backlog.

The full presentation belongs to the GitHub Actions deployment job summary and
a durable hosted report, not to a pull-request check. PR checks stay lean: normal
CI and fast poison/security findings only. The CD summary's outcome, coverage,
and holding risks must agree with the persisted report and must never title a
partial review as clean.

## Controlled publication protocol

The authoritative release workflow must:

1. resolve an immutable candidate SHA;
2. request or retrieve the report for that SHA and previous-release SHA;
3. verify the report identity, policy, freshness, and outcome;
4. continue automatically only for `ship`;
5. route `sign-off-required` through protected-environment approval;
6. fail for `stop` and `indeterminate`;
7. verify immediately before publication that the candidate is unchanged;
8. publish artifacts traceable to that same candidate;
9. record the report identity and any approval identity in release audit data.

## Required behavioral examples

- Complete required evidence and no unresolved risk produces `ship`.
- Zero findings with truncated LLM input produces `sign-off-required`, not
  `ship`.
- A cited but model-only consequential risk produces `sign-off-required`, not
  `stop`.
- A deterministically confirmed leaked credential or destructive data change
  produces `stop` even when other lanes are incomplete.
- Failure to create a trustworthy report produces `indeterminate`.
- Approval for one candidate or report cannot authorize a different candidate.
- A report cannot claim clean while omitting a required evidence lane.

## Current implementation gap

The walking skeleton already:

- reviews the source range `(previous release, candidate]`;
- records a persisted, content-bound report and evidence-lane manifest;
- evaluates candidate-SHA CI against service-owned required contexts;
- runs a dedicated, citation-anchored range-level LLM analyst when an explicit
  real model backend is configured;
- presents scenario, affected surface, blast radius, impact, detectability,
  reversibility, rollback, uncertainty, and supporting/contradicting evidence;
- records context-only open `bug` issues, all open PRs, and durable Scruffy
  nightly work without giving that context decision authority;
- makes provider failure and model truncation explicit rather than silently
  clean;
- prevents model-only evidence from manufacturing a release stop;
- emits deterministic SHA/report-bound human-responsibility wording for
  `sign-off-required`;
- supports a CD-native mode that persists the report, writes deployment-job
  summary/routing outputs, and emits no commit status or check.

The local code now also includes a v2 identity bound to artifact digest and
target environment, GitHub Actions OIDC authentication, hosted report retrieval,
durable approval attestations based on actual Environment approval history, and
terminal `shadowOnly` authorization revalidation. The Azure template can select
a keyless managed-identity Foundry backend and the controlled client carries one
exact envelope through the protocol.

It does not yet provide production authority. In particular, it still lacks:

- deployed and live-verified hosted report/approval/authorization operation;
- an approved Foundry deployment and observed real-model call from the Container
  App;
- policy-authoritative prior-gate, visual, deployment, and migration evidence;
- administrator-bypass removal and two fresh disposable OIDC terminal paths;
- any separately authorized publication or real deployment integration.

Until those gaps are validated in shadow operation, release reports and
`shadowOnly` authorization records remain advisory deployment evidence and must
not authorize automatic publication. They must not be posted onto pull requests.
