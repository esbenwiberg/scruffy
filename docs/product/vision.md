# Scruffy product vision

## Thesis

Scruffy is an internal, service-controlled review system for organization repositories. It aims to remove routine human per-PR review while preserving human attention for consequential release decisions and genuine uncertainty.

It does this through three gates that escalate in depth and decrease in frequency.

## Gate 1: Poison check

Runs for every PR and merge-group candidate on the critical path.

- Target: below two minutes p95 and below $1 marginal cost p95.
- Blocks only high-confidence exploitable security defects and silent data loss or corruption.
- Uses service-owned policy and analyzers, selected code context, and existing evidence.
- Abstains rather than blocking when evidence is insufficient.
- Does not run repository builds or tests.
- Makes a binary GitHub block/allow decision without routine human intervention.

The gate must prove its precision, severe-case coverage, latency, and cost in shadow mode before becoming authoritative.

## Gate 2: Nightly deep review and fix

Runs over the day's merged changes.

- Uses broader repository context and multiple analysis strategies.
- Attempts to falsify findings through adversarial validation.
- Deduplicates and ranks surviving findings.
- Opens narrowly scoped fix PRs when evidence and policy permit.
- Lets each repository's normal CI build and test generated fixes.
- Does not initially auto-merge fixes.

Its value is measured by incremental severe findings and net reviewer time saved—not by finding or comment volume.

## Gate 3: Release gate

Runs before a controlled release candidate is published.

- Reviews the range from the previous release through the candidate revision.
- Aggregates poison, nightly, repository-CI, and release-specific evidence.
- Runs service-controlled visual QA for applicable applications.
- Stops or escalates releases when evidence or policy requires it.
- Requests human sign-off only for defined exceptions or uncertainty.

GitHub Releases are the initial release integration. The design must later permit Azure DevOps and distinguish release publication, package publication, and deployment.

## Ownership model

### Repositories own

- Application source and architecture
- Builds and tests
- Toolchain and runtime versions
- Dependency and service setup
- Test matrices
- Normal CI workflows and artifacts

### Scruffy owns

- Gate and escalation policy
- Protected paths and risk categories
- Evidence requirements and interpretation
- Release and visual policy
- Analyzer, model, and prompt versions
- Confidence calibration
- Exceptions and waivers
- Sandbox and tool permissions
- Audit history

Review and fix agents can read policy but cannot modify it.

## Initial scope

- SCM and code hosting: GitHub
- Initial release trigger: controlled GitHub Release flow
- Initial languages: JavaScript/TypeScript, Python, C#/.NET, and Go
- Future integration: Azure DevOps through provider adapters

## Product principles

1. **Protect only what can justify blocking.** Noise is not safety.
2. **Abstention is legitimate.** Uncertainty moves to a deeper gate rather than becoming invented confidence.
3. **Policy is outside reviewed repositories.** The subject cannot redefine its judge.
4. **Repository CI stays repository-owned.** Scruffy consumes evidence instead of becoming a universal build service.
5. **Agents do not hold authority credentials.** Writes and administration use separate minimal-permission components.
6. **Evidence beats scores.** Every decision records provenance, policy, analyzer, and immutable revision.
7. **Coverage is explicit.** Unsupported languages or missing evidence are visible.
8. **Autonomy is earned prospectively.** Shadow operation precedes blocking; proposed fixes precede auto-merge.
9. **Human attention is exception-based.** Escalate consequential uncertainty, not every change.
10. **Measure outcomes, not activity.** Severe-defect coverage, false blocks, regressions, cost, latency, and reviewer time are the key measures.

## Initial experiment

1. Select representative repositories across the four initial ecosystems.
2. Assemble at least 200 historical PRs, known severe incidents, and blinded seeded mutations.
3. Run the poison gate in shadow mode and measure latency, marginal cost, blocker precision, severe-case recall, false blocks, and risk coverage.
4. Run nightly review for four weeks without auto-merge and measure incremental valid findings, fix acceptance, regressions, and reviewer effort.
5. Exercise release review on controlled draft candidates, including visual regression seeding where applicable.
6. Pre-register thresholds before deciding whether any gate receives more authority.

## Initial non-goals

- Supporting every language semantically in v1
- Replacing repository build or test systems
- Automatically merging generated fixes
- Letting model self-confidence independently block changes
- Storing authoritative policy in reviewed repositories
- Treating a published GitHub Release event as a pre-release gate
- Claiming all defects or vulnerabilities can be detected
