---
artifact_type: research-dossier
contract_version: 1
id: scruffy-three-gate-review
title: Scruffy three-gate autonomous review architecture
scope: project
status: active
created: 2026-07-15
review_after: 2026-09-15
tags: [ai-code-review, github, security, release-gating, autonomous-fixes]
verdict: shape
confidence: medium
---

# Executive summary

Scruffy is a proposed internal review service for organization-owned repositories. It separates assurance into three time horizons:

1. A fast per-PR poison gate that blocks only high-confidence exploitable security defects and silent data loss or corruption.
2. A nightly deep review over the day's merged changes, with adversarial validation and narrowly scoped fix PRs.
3. A release gate over the changes since the previous release, including visual QA where applicable and exception-driven human sign-off.

The decomposition is technically feasible on GitHub and worth shaping. Current evidence does not, however, justify treating an uncalibrated model as an autonomous correctness oracle. The poison gate must be narrow and abstaining, use deterministic evidence where possible, and first prove itself through historical replay and shadow operation.

Repositories retain ownership of builds, tests, runtime matrices, and application-specific CI. Scruffy owns gate policy, evidence requirements, release and visual policy, analyzers, calibration, exceptions, and interpretation. Those controls live outside reviewed repositories and cannot be modified by review or fix agents.

# Thesis and decision

## Testable thesis

A three-gate, AI-assisted review service can remove routine human per-PR review while maintaining acceptable security, data-integrity, and release-quality risk without making CI latency or operating cost prohibitive.

## Decision

Determine whether to discard, park, or shape the architecture and identify the trust boundaries, initial language scope, rollout sequence, and measurements needed before any gate becomes authoritative.

# Decision and kill criteria

## Success criteria

- Poison checks complete below 120 seconds p95 and $1 marginal cost p95 for representative PRs.
- The lower 95% confidence bound for blocker precision is at least 95%.
- Fewer than 0.5% of adjudicated-clean PRs are falsely blocked.
- Historically catastrophic defect classes are detected or covered by an independent deterministic control.
- Nightly review finds incremental severe defects without increasing total reviewer effort.
- Generated fixes are narrow PRs validated by repository-owned CI and are not initially auto-merged.
- Release review runs before publication through a controlled draft-release, tag, package, or deployment workflow.
- GitHub-specific mechanics remain isolated behind an SCM/release adapter.
- AI workers cannot modify policy, waive findings, weaken thresholds, or access production credentials.

## Kill criteria

Kill or redesign the affected gate if:

- Representative poison checks exceed either latency or cost bounds.
- The poison blocker cannot meet its pre-registered precision and false-block thresholds.
- Universal builds, tests, or broad agent swarms are required on the per-PR critical path.
- Nightly operation adds review burden without incremental severe findings.
- Generated fixes cause regressions despite passing available tests.
- Repository input can expose credentials, alter policy, induce unauthorized writes, or escape isolation.
- Visual QA cannot reach an acceptable seeded-regression recall and false-alarm rate.
- Release confidence reduces to an opaque model score rather than executable evidence.

# Findings

## Three gates are a useful risk decomposition

The fast synchronous gate and slower asynchronous gates should have different authority and evidence:

| Gate | Scope | Evidence | Authority |
|---|---|---|---|
| Poison | PR or merge-group candidate | Diff, selected context, service-owned analyzers, existing checks | Block or allow; abstention passes to deeper review |
| Nightly | Day's merged range | Repository context, cross-change reasoning, existing CI, adversarial validation | Open finding or fix PR |
| Release | Previous release through candidate | Aggregate changes, release checks, optional controlled visual QA | Permit, stop, or escalate release |

This is a sound architectural inference, not independently validated proof that routine human review can already be removed safely.

## Repository and service ownership must remain separate

Repositories own application source, builds, tests, runtime/toolchain matrices, application environments, and normal CI artifacts. Scruffy consumes those results by commit SHA or PR rather than inventing a second build system.

Scruffy centrally owns:

- protected paths and risk categories;
- enabled gates and thresholds;
- release semantics and visual requirements;
- supported-language analysis policy;
- model, prompt, and analyzer versions;
- tool and network permissions;
- calibration, exceptions, waivers, and sign-off requirements.

Repository content may provide untrusted hints, but cannot weaken effective policy. AI workers receive policy read-only. Administrative policy changes require a separate identity, immutable versions, actor/reason audit records, and preferably second-party approval when protection is weakened.

## Initial language scope should be explicit

The architecture can remain language-extensible while v1 supports:

- JavaScript and TypeScript on Node.js;
- Python;
- C#/.NET;
- Go.

Adapters should perform language detection, symbol-aware context selection, dependency and call-site discovery, language-specific security analysis, persistence/migration heuristics, test association, and patch construction. Unsupported languages receive clearly labeled reduced coverage rather than an implication of universal support.

## The poison gate must be selective

Evidence does not support comprehensive semantic vulnerability or silent-data-loss detection across arbitrary repositories. The gate should block only when evidence satisfies a narrowly defined catastrophic-risk policy. Insufficient evidence means abstention, not an invented high-confidence decision.

Raw model self-confidence is not a safety boundary. Calibration requires representative labels, held-out evaluation, reliability measurements, and risk-versus-coverage reporting. Model confidence cannot override failing deterministic checks.

## GitHub provides the necessary control-plane mechanics

A GitHub App can receive PR, check, merge-group, and release events; write check runs; become a required status check; and open fix PRs. Required checks must evaluate the merge-group SHA when merge queues are used. Webhook signatures must be verified and deliveries processed idempotently.

A `release.published` event occurs too late to be a release gate. Enforcement requires a controlled draft-to-publish protocol, protected tag/package workflow, deployment protection rule, or equivalent pre-publication control.

Provider neutrality belongs above the integration layer. GitHub Apps, Checks, rulesets, releases, and merge queues remain GitHub-specific adapters. Evaluation, policy, evidence, and sandbox interfaces should not depend on them.

## Nightly fixes should initially remain proposals

Passing tests does not prove semantic correctness. Nightly review should independently generate findings, attempt to falsify them, deduplicate survivors, generate narrow patches, open PRs, and wait for the repository's normal CI. It should not initially auto-merge.

Adversarial validation must seek independent evidence rather than asking the same model to repeat its judgment.

## Visual evidence needs a stronger trust boundary than repository CI

Repository-owned visual workflows can be influenced by the change under review. Scruffy should control Playwright/browser versions, comparison policy, thresholds, baseline selection, and evidence retention. A repository can provide application-specific startup or navigation inputs, but those are untrusted.

Screenshot comparisons require pinned environments, stable fonts and browsers, animation handling, and measured false-alarm rates. Visual findings should begin as advisory.

## Repository content is hostile input

Source, comments, test output, generated artifacts, dependency metadata, and rendered pages can carry indirect prompt injection. Evaluation requires ephemeral, least-privileged workers; no production credentials; read-only policy; constrained filesystem access; controlled egress; resource limits; and a separate minimal-permission component for GitHub writes.

## Existing products provide components, not proof of this operating model

GitHub Copilot Code Review, CodeQL Autofix, Snyk DeepCode AI, CodeRabbit, Greptile, Qodo, Semgrep, and GitLab provide adjacent review, scanning, and remediation capabilities. Their product documentation does not independently establish calibrated production sensitivity and specificity, sub-$1 end-to-end operation, or regression-free autonomous fixes for this use case.

Scruffy's defensible differentiation is organization-specific policy, evidence aggregation, calibration, and cross-tool orchestration—not an unsupported claim that no competitor has three layers.

# Counter-evidence and alternatives

## Counter-evidence

- LLM vulnerability judgments remain inconsistent across prompts and datasets.
- Diff-only review misses schemas, callers, runtime state, deployment topology, and cross-service contracts.
- Generated tests can reinforce a model's mistaken interpretation.
- Multiple agents may have correlated failures.
- Repository content introduces prompt-injection and workflow-compromise paths.
- Visual comparisons are noisy unless execution is tightly controlled.
- Current vendor guidance generally recommends validating AI review and fixes.
- No independent evidence located establishes the desired universal poison-gate guarantees.

## Alternatives

1. Compose existing analyzers and reviewers without building Scruffy.
2. Build Scruffy only as orchestration, policy, evidence, and measurement infrastructure.
3. Launch nightly and release review before introducing an authoritative poison gate.
4. Remove routine human review only for low-risk repositories or change categories.
5. Restrict poison blocking to approved deterministic findings and use AI asynchronously.

The preferred starting point combines options 2 and 3 while shadow-testing the poison gate.

# Unknowns

- Organization-wide repository, language, framework, and monorepo distribution.
- Existing CI latency and security coverage.
- Available historical severe incidents and suitable seeded mutations.
- Operational definitions for exploitable, silent data loss, high confidence, and exception.
- Acceptable recall-versus-false-block trade-off.
- Model-provider privacy, retention, and hosting requirements.
- Exact meanings of release across GitHub Releases, packages, and deployments.
- Real model/analyzer failure correlation.
- Prospective exception and escalation rates.
- Whether application-specific visual startup can be accepted without weakening the evidence boundary.

# Verdict and rationale

**Verdict: shape — medium confidence.**

Shape a bounded experiment rather than the complete autonomy promise. The architecture is implementable and its temporal separation is compelling. The first increment should establish the GitHub adapter, service-owned policy control plane, hostile-input sandbox, initial language adapters, historical replay, shadow poison evaluation, nightly findings/fix PRs, and draft-release evidence.

It must exclude auto-merging generated fixes, AI confidence as the sole blocker, mutable in-repository gate policy, claims of universal language coverage, and organization-wide removal of human review before prospective measurement.

# Revisit trigger

Reassess by 2026-09-15 or after all of the following:

- at least 200 representative historical PRs have been replayed;
- all available severe historical incidents and blinded seeded mutations have been evaluated;
- the poison gate has run prospectively in shadow mode;
- nightly review has operated for four weeks on a representative cohort;
- several controlled release candidates have exercised functional and visual evidence collection.

Move toward authoritative blocking only if pre-registered precision, false-block, latency, cost, sandbox-security, and reviewer-effort thresholds are met.

# Sources

- GitHub, “REST API endpoints for check runs,” continuously updated, accessed 2026-07-15. https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28 — check-run mechanics and annotation limits.
- GitHub, “Managing a merge queue,” continuously updated, accessed 2026-07-15. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue — merge-group evaluation and availability.
- GitHub, “Webhook events and payloads,” continuously updated, accessed 2026-07-15. https://docs.github.com/en/webhooks/webhook-events-and-payloads — integration triggers.
- GitHub, “REST API endpoints for releases,” continuously updated, accessed 2026-07-15. https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28 — draft and published release mechanics.
- GitHub, “Secure use reference,” continuously updated, accessed 2026-07-15. https://docs.github.com/en/actions/security-for-github-actions/security-guides/secure-use-reference — hostile-input and least-privilege requirements.
- GitHub, “Responsible use of Copilot code review,” accessed 2026-07-15. https://docs.github.com/en/copilot/responsible-use/copilot-code-review — limitations of AI review.
- GitHub, “About Autofix for CodeQL code scanning,” accessed 2026-07-15. https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-autofix-for-codeql-code-scanning — adjacent remediation capability and scope.
- Debenedetti et al., “AgentDojo,” NeurIPS 2024, accessed 2026-07-15. https://arxiv.org/abs/2406.13352 — indirect prompt-injection risk.
- OWASP, “LLM01:2025 Prompt Injection,” 2025, accessed 2026-07-15. https://genai.owasp.org/llmrisk/llm01-prompt-injection/ — hostile external-content model.
- Ullah et al., “LLMs Cannot Reliably Identify and Reason About Security Vulnerabilities (Yet?),” 2023, accessed 2026-07-15. https://arxiv.org/abs/2312.12575 — semantic vulnerability limitations.
- Steenhoek et al., “Vulnerability Detection with Code Language Models: How Far Are We?” 2024, accessed 2026-07-15. https://arxiv.org/abs/2403.18624 — reliability and dataset concerns.
- Yang et al., “Are ‘Solved Issues’ in SWE-bench Really Solved Correctly?” 2025, accessed 2026-07-15. https://arxiv.org/abs/2503.15223 — passing tests versus patch correctness.
- Guo et al., “On Calibration of Modern Neural Networks,” 2017, accessed 2026-07-15. https://proceedings.mlr.press/v70/guo17a.html — confidence calibration.
- Geifman and El-Yaniv, “Selective Classification for Deep Neural Networks,” 2017, accessed 2026-07-15. https://arxiv.org/abs/1705.08500 — abstention and risk coverage.
- Microsoft, “Visual comparisons,” Playwright documentation, accessed 2026-07-15. https://playwright.dev/docs/test-snapshots — screenshot-environment constraints.
- Microsoft, “Docker,” Playwright documentation, accessed 2026-07-15. https://playwright.dev/docs/docker — non-root browser isolation.
- NIST, *Artificial Intelligence Risk Management Framework: Generative AI Profile*, 2024, accessed 2026-07-15. https://doi.org/10.6028/NIST.AI.600-1 — accountability and monitoring.

# Agent-use notes

- Four independent research agents examined landscape, supporting evidence, counter-evidence, and implementation feasibility.
- A source-auditor checked critical claims against primary GitHub, Playwright, OWASP, and research sources.
- Child processes could not access the configured Brave key and relied partly on direct retrieval of known primary sources; this weakens confidence in market-uniqueness claims.
- Vendor pages were treated as product-capability evidence, not independent safety or accuracy evidence.
- This document is curated synthesis rather than a conversation transcript.
