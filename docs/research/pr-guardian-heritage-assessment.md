---
artifact_type: research-dossier
contract_version: 1
id: scruffy-pr-guardian-heritage-assessment
title: PR Guardian heritage assessment for Scruffy
scope: project
status: active
created: 2026-07-15
review_after: 2026-09-15
tags: [pr-guardian, architecture, audit, evidence, autonomous-review]
verdict: shape
confidence: medium
---

# Executive summary

PR Guardian's prior product and engineering work materially improves Scruffy's direction. Its three-gate product model, central-policy boundary, durable orchestration, evidence discipline, finding lifecycle, and production retrospectives should influence Scruffy.

The correct approach is selective heritage rather than a port. PR Guardian mixes implemented mechanisms, production lessons, draft architecture, internal observational evidence, and external analogies with different levels of support.

The accompanying 30-day audit is backed by a substantial local corpus: 159 PR records, raw PR and thread snapshots, stored diffs, comment classifications, 157 review records, 22 retained finding instances, and report-generation code. It provides strong evidence that formal approval was not reliably preventing defects in the observed cohort. It does not yet establish autonomous blocker safety, critic accuracy, or defect recall.

Scruffy should preserve Guardian as an executable reference and source of evaluation fixtures while rebuilding the core around Scruffy's accepted ownership and trust model:

- repositories own builds and tests;
- Scruffy owns policy and gate authority outside reviewed repositories;
- agents cannot modify policy or hold administrative credentials;
- all decisions operate on immutable revisions, versioned policy, and attributable evidence.

# Thesis and decision

## Thesis

PR Guardian's validated behavior and production lessons can accelerate Scruffy without importing its original human-review assumptions, implementation coupling, or unsupported assurance claims.

## Decision

Determine which Guardian mechanisms should be carried forward, rebuilt with stronger semantics, retained only as testable hypotheses, or rejected.

# Decision and kill criteria

## Adoption criteria

Carry a mechanism forward when at least one condition holds:

- it is implemented and covered by meaningful tests;
- it addresses an observed production failure;
- it matches a mature external engineering pattern;
- it strengthens an accepted Scruffy trust boundary;
- its behavior can be independently evaluated.

## Rejection criteria

Do not inherit a mechanism when:

- assurance depends on model self-reporting;
- absent findings are treated as proof of a fix;
- infrastructure failure is converted into a code-quality verdict;
- reviewed repository content can weaken policy;
- an authoritative baseline is mutable or ambiguous;
- distributed-system complexity precedes a measured need;
- compliance rationale is not supported by the cited standard;
- empirical claims cannot be reproduced or adjudicated.

# Findings

## The three-gate product model should be inherited

Guardian's strongest product insight is that the gates have different jobs:

| Gate | Job | Scruffy authority |
|---|---|---|
| Poison | Prevent immediately exploitable or irreversible harm entering `main` | Block, allow, or report an operationally indeterminate run |
| Nightly | Keep `main` healthy by finding and proposing fixes | Report, ticket, or open a fix PR |
| Release | Decide whether an immutable candidate should ship | Ship, stop, or require sign-off |

The poison-versus-blemish framing is more useful than severity alone:

- silent and irreversible or immediately exploitable harm belongs in the poison gate;
- visible and recoverable defects can wait for nightly analysis;
- aggregate product, intent, and release uncertainty belongs at the release gate.

Release must rerun authoritative analysis over the immutable candidate range. Nightly results are early-warning evidence, not a substitute for evaluating the release candidate.

**Assessment: carry forward.**

## The 30-day audit is meaningful internal evidence

The audit corpus contains:

- 159 completed PR records across 7 repositories;
- 159 stored diff files;
- 157 review records after excluding two trivial or empty cases;
- raw PR and discussion-thread snapshots;
- 36 extracted human-comment instances;
- 31 distinct classified human comments after repeated text is collapsed;
- 297 reported candidate findings;
- 275 reported validator removals;
- 22 retained finding instances across 18 PR records;
- 8 high- and 14 medium-severity retained instances.

This corrects the earlier conclusion that no supporting artifact existed. The deck is backed by source material rather than being only an unsupported presentation.

The audit strongly supports these cohort-specific observations:

- all 159 PR records had a positive vote from a non-author reviewer;
- 141 of 159 had no genuine human text comment;
- all 18 PR records with retained findings also had a positive non-author vote;
- formal approval did not prevent the retained issues from merging;
- most visible review comments came from automated systems;
- a generous first-pass agent produced too much output to use without a suppression stage;
- the retained findings were concentrated in frontend/component repositories.

The accurate framing is therefore not "nobody looked." It is:

> Every observed PR received formal non-author approval, but 89% received no visible human review comment, and every retained defect instance passed that approval process.

Silent review may still have occurred. Approval and comment data cannot establish how carefully a reviewer inspected a diff.

**Assessment: preserve as an internal observational study and pilot-selection input.**

## The audit needs deduplication and stronger labels

The audit counts PR records, not independent code changes:

- 157 reviewed PR records contain only 111 distinct patch hashes;
- 46 reviewed records duplicate another record's exact patch content;
- the 18 PR records with retained findings contain 16 distinct patch hashes.

Some retained rows describe the same root cause in paired PR records with identical patches. Exact deduplication alone reduces the 22 retained rows to no more than approximately 19 unique root causes; additional semantic deduplication may reduce the count further.

Future reporting must distinguish:

- PR-process observations;
- unique patch observations;
- finding instances;
- unique defect root causes.

Use "22 retained finding instances across 18 PR records" until root-cause adjudication is complete. Do not call them 22 unique defects.

The reported cull arithmetic also needs correction:

```text
275 / 297 = 92.6% culled
22 / 297 = 7.4% retained
```

The preserved corpus contains the 22 retained findings but not the original 297 candidates or 275 validator dispositions. The aggregate cull count is documented, but its correctness cannot be recomputed from the available files.

A cull rate is not a false-positive rate. Establishing validator quality requires labels for both retained and removed samples, including:

- blinded adjudication;
- inter-rater disagreement;
- retained-finding precision;
- removed-finding false-dismissal rate;
- confusion matrices by language and defect class;
- confidence intervals;
- an untouched evaluation set.

**Assessment: retain the audit, correct its terminology, and reconstruct missing intermediate evidence if possible.**

## Frontend-first is justified as a pilot, not as a language safety conclusion

All retained findings occurred in the frontend/component repositories in this cohort. That is useful for choosing an initial high-yield pilot and for visual-QA experiments.

It does not establish that .NET is intrinsically safer or needs thinner coverage. The sample is small, the patch records are duplicated, repository workloads differ, and the audit does not provide a known-defect ground truth for the repositories with zero retained findings.

Scruffy should retain its accepted v1 scope:

- JavaScript and TypeScript on Node.js;
- Python;
- C#/.NET;
- Go.

Frontend repositories can be the first shadow cohort without narrowing the product architecture to PCF or TypeScript.

**Assessment: use frontend-first for sequencing; reject language-level safety inference.**

## Evidence completeness should replace Guardian's certainty terminology

Guardian structurally downgrades agent certainty by counting signals such as:

- pattern match;
- concrete suggestion;
- full-context claim;
- cross-reference count.

This mechanism is implemented and tested, but those fields are largely asserted by the generating agent. They do not establish calibrated correctness. A model can claim it saw full context or provide a concrete but incorrect suggestion.

Scruffy should treat these as evidence-completeness features rather than confidence:

- missing required evidence makes a finding ineligible for blocking;
- complete evidence permits further validation;
- completeness does not imply correctness or a numeric probability.

A stronger finding schema should record:

- stable rule or defect-class identity;
- immutable source revision;
- primary code region and quoted evidence;
- relevant symbol and call/data-flow claims;
- supporting deterministic results;
- contradicting evidence;
- context coverage and truncation;
- model, prompt, tool, and analyzer versions;
- validator outcomes.

Confidence thresholds must be derived from labeled prospective results by language, defect class, evidence pattern, and analyzer bundle.

**Assessment: carry the downgrade principle; rebuild its semantics and schema.**

## Adversarial validation is a noise filter, not independent proof

Guardian's validator is implemented and tested. It can keep, dismiss, downgrade, and merge findings. It receives a compact diff and the generated descriptions, then defaults to retaining the original findings if validation is disabled, skipped, malformed, or fails.

Targeted validation of Guardian's decision, validator, readiness, lifecycle, fix-inference, and range-review code produced 116 passing tests.

Limitations remain:

- validator context is truncated;
- it does not receive all structured evidence fields;
- missing validation entries preserve findings;
- parser, timeout, and provider failures preserve findings;
- a similar model and context create correlated failures;
- temperature zero does not guarantee deterministic output.

This is safe for conservative advisory comment suppression. It is not sufficient assurance for autonomous blocking.

Scruffy should model validation explicitly:

```text
not_requested | pending | validated | refuted | indeterminate | failed
```

A poison block requires affirmative validation against independent evidence. Validator failure must not be recorded as successful validation. Infrastructure failure should become an operationally indeterminate run with bounded retry and an audited enforcement policy.

The critic should be equipped to disprove reachability and impact using source context, deterministic analyzer traces, repository history, and executable counterexamples where available.

**Assessment: carry the generator/critic shape; rebuild evidence access and failure semantics.**

## Do not lift Guardian's decision engine verbatim

Guardian proves that a deterministic, IO-free decision boundary is valuable. Its current engine nevertheless carries Guardian-specific assumptions:

- human-review verdicts and trust tiers;
- direct dependency on the large Guardian configuration model;
- manually selected severity, certainty, and agent weights;
- agent-name coupling;
- Archmap and branch behavior;
- auto-approval terminology;
- mutation of caller-owned lists.

Scruffy should carry the design property, not the code:

```text
evaluate_poison(evidence, policy)
  -> block | allow | indeterminate

evaluate_nightly(findings, policy)
  -> suppress | report | propose_fix

evaluate_release(evidence, policy)
  -> ship | signoff_required | stop | indeterminate
```

Each evaluation should be a pure function over immutable typed inputs and return a new result containing reason codes and evidence references.

Guardian should serve as an executable reference for differential tests where behavior is intentionally preserved.

**Assessment: port concepts and tests, not implementation.**

## Durable candidates and reconciliation are genuine crown jewels

Guardian's durable readiness state machine addresses delayed checks, missed and out-of-order webhooks, moved heads, retries, deployments, and duplicate execution. This matches mature controller and transactional-outbox patterns.

Scruffy should generalize readiness into durable evaluation runs:

```text
EvaluationRun
  id
  kind
  repository
  immutable subject revision or range
  merge-group SHA where applicable
  policy version
  analyzer bundle
  state and attempt
  evidence completeness
  transition history
```

Candidate states should distinguish success, failure, indeterminate analysis, and supersession. All event handlers must be idempotent, and reconciliation must recover work independently of webhook delivery.

**Assessment: strongly carry forward.**

## Finding lifecycle should use semantic fingerprints

Guardian's lifecycle distinction among open, dismissed, fixed, verified, and regressed findings is valuable and auditable.

Its current `file::category::agent` identity is too fragile for Scruffy. It can mistake agent renames, file moves, partial analysis, or model nondeterminism for fixes.

Scruffy should use SARIF-compatible identity concepts:

- stable rule ID;
- stable analyzer or agent ID distinct from display name;
- semantic primary location;
- normalized code-region fingerprint;
- relevant symbol or flow identity;
- analyzer-version provenance;
- partial fingerprints for matching across movement.

Critically:

> Not observed is not equivalent to fixed.

A transition to fixed requires equivalent or stronger coverage of the relevant source region and, preferably, targeted deterministic or executable verification.

**Assessment: carry lifecycle behavior; rebuild identity and fix inference.**

## Central service-owned policy exactly matches Scruffy's accepted boundary

Guardian already learned that repository-root policy allows the reviewed subject to influence its own judge. Its centrally owned Profiles and explicit repository enrollment align with Scruffy ADR 0001.

Carry forward:

- reusable central policy profiles;
- exact repository enrollment;
- immutable policy versions;
- policy snapshots on every run;
- separate credentials from policy;
- audited administrative changes;
- no repository-local authority over gates or thresholds.

Rejecting generic built-in path globs does not prohibit centrally administered repository-specific protected paths. The rejected behavior is pretending names such as `services/**` or `config/**` have universal semantic meaning.

**Assessment: strongly carry forward.**

## Reusable workflows are not the primary architecture

Guardian's reusable workflows simplify distribution but are not a security boundary. They execute with delegated repository context and credentials, can be referenced through mutable tags, and require consumer configuration.

Scruffy's core gates should be driven by its GitHub App and durable scheduler. Repositories continue to own their normal build and test workflows.

Reusable workflows can remain optional evidence adapters for application-specific bootstrap or artifact production. When used, they must be pinned to full commit SHAs, receive minimal permissions, hold no policy/model credentials, and produce repository-owned evidence rather than authoritative decisions.

**Assessment: reject as primary packaging; retain as an optional adapter.**

## Nightly state must not rely on a mutable tag

Guardian's example nightly workflow uses a force-moved baseline tag and falls back to the latest commit's parent on first execution. That is acceptable as a prototype but not as authoritative state.

Scruffy should store a service-owned durable watermark with:

- repository and branch/ref;
- last successfully reviewed immutable head;
- next candidate head;
- merge base and exact range semantics;
- policy and analyzer versions;
- evaluation-run identity.

Advance the watermark transactionally only after the run reaches its policy-defined terminal state. Detect non-ancestor transitions explicitly.

**Assessment: carry range review; reject mutable tags as authority.**

## Before/after visual evidence is valuable but requires real isolation

Guardian's strongest visual insight is to drive the same change-scoped flows against the previous release and candidate rather than judging one screenshot in isolation.

Carry forward:

- before/after comparison;
- deterministic seeded data;
- pinned browser and environment;
- screenshots plus behavioral traces;
- change-to-flow mapping;
- advisory or sign-off-trigger behavior rather than autonomous visual blocking.

Running an application still executes hostile repository code. The browser worker must use disposable strong isolation, non-root execution, browser sandboxing and seccomp, no production or SCM credentials, metadata-service denial, restricted egress, resource limits, and destruction after each run.

**Assessment: carry visual evidence; rebuild the execution boundary.**

## Begin with a modular control plane and isolated worker classes

The three tiers have different latency and resource profiles, but that does not justify three domain services on day one.

Start with:

- one control-plane/API deployment;
- one durable Postgres database;
- one durable queue or database-backed work queue;
- separate worker classes for fast analysis, deep analysis, fix generation, and hostile-code/browser execution.

Maintain module and message boundaries that permit later extraction. Physically isolate hostile execution immediately because it is a trust boundary; extract other services only after scaling, ownership, or release-cadence evidence justifies it.

**Assessment: reject premature service decomposition; preserve worker boundaries.**

## Python is the incumbent candidate, not a settled axiom

Guardian demonstrates that Python, FastAPI, Pydantic, and existing provider libraries can support the review brain and enable rapid behavioral reuse.

The Scruffy stack decision must still consider type/schema safety, durable work dispatch, operational familiarity, concurrency, sandbox orchestration, and team ownership. Python should receive incumbent advantage because it minimizes re-derivation, not because the old charter labels alternatives a hard no.

**Assessment: keep Python as the leading candidate pending an explicit architecture comparison.**

## Production scars should become requirements

Carry these lessons into Scruffy from day one:

- one migration/schema authority;
- migration tests against Postgres, not only SQLite;
- unbounded text storage for model-generated output;
- loud persistence failure rather than fake completion;
- no blanket bypass for bot authors;
- one final-effect path posting to the current immutable subject;
- stable internal agent IDs distinct from display names;
- deterministic fake providers for offline tests;
- CI-enforced dependency boundaries;
- isolated side effects and platform adapters;
- idempotent cross-replica event handling;
- explicit once-only background-work coordination;
- resource, connection, and timeout limits.

**Assessment: strongly carry forward as acceptance tests and architecture constraints.**

## Compliance claims must remain organization-specific

The prior material overstates external requirements:

- SOX Section 404 requires management assessment of internal controls but does not directly mandate non-author approval for each flagged release.
- SOC 2 CC8.1 covers authorization, testing, approval, implementation, and control of changes but does not prescribe one universal per-release sign-off design.
- PCI DSS 6.2.3 permits custom-code review by qualified individuals other than the author or by automated tools before production release.

Scruffy should provide configurable and auditable segregation-of-duties controls. Whether those controls satisfy a framework depends on the organization's scoped control design and auditor interpretation.

**Assessment: reject categorical compliance claims.**

# Counter-evidence and alternatives

## Counter-evidence

- Guardian's tested decision engine may contain subtle behavior that a clean rewrite could lose.
- The missing candidate/validator records may still exist in the originating agent session.
- A same-model critic can provide substantial practical noise reduction even without independent assurance.
- Exact finding identity is simple and explainable despite its blind spots.
- Multiple deployments may become appropriate quickly if security and scaling boundaries diverge.
- Repository workflows may be operationally convenient for a small cohort.
- The audit's detailed retained findings are persuasive even without independent labels.

## Alternatives

### Port Guardian's core

This is the fastest route to working review behavior but imports human-review semantics, arbitrary weights, config coupling, and implementation scars.

### Rebuild without using Guardian

This gives maximum conceptual cleanliness but risks discarding hard-earned behavior and repeating production incidents.

### Behavioral reimplementation with differential tests

Preferred approach:

1. Preserve a sanitized, labeled audit corpus.
2. Record Guardian outputs for representative fixtures.
3. Identify intentionally preserved and intentionally changed behaviors.
4. Implement Scruffy's domain kernel independently.
5. Differentially test preserved behavior.
6. Require explicit rationale for divergences.
7. Prospectively validate Scruffy in shadow mode.

# Unknowns

- Whether the original 297 candidate findings and 275 validator decisions can be recovered.
- Whether retained findings were independently reproduced or adjudicated after the audit.
- The final number of unique defect root causes after semantic deduplication.
- Which models and prompts generated and refuted audit candidates.
- Guardian's observed latency, cost, outage, and reconciliation telemetry.
- Whether weighted scores improved outcomes over simpler policy rules.
- Which repositories are governed by formal internal controls.
- Expected Scruffy repository count and throughput.
- Team preference and operational capability for the implementation stack.
- Safe standardization of application startup for visual QA.
- Existing deterministic analyzer coverage in the four initial ecosystems.
- Required handling of release branches and non-linear histories.

# Verdict and rationale

**Verdict: shape — medium confidence.**

The Guardian heritage and audit provide a materially stronger basis for Scruffy than external research alone. They justify proceeding with a frontend-first shadow pilot and preserving several production-derived mechanisms.

They do not justify porting Guardian wholesale or immediately making an AI gate authoritative. Scruffy should behaviorally reimplement validated principles under stronger evidence, policy, identity, and sandbox boundaries.

The first execution boundary should include:

1. A sanitized, deduplicated audit corpus and labeling protocol.
2. Scruffy's typed evidence and decision contracts.
3. Centrally versioned policy.
4. Durable evaluation runs and reconciliation.
5. A pure poison-policy kernel.
6. Fake providers and deterministic replay.
7. GitHub shadow integration.
8. One language and one poison defect class end-to-end.
9. Differential comparison with Guardian and blinded labels.

It should exclude auto-merging fixes, mutable repository policy, raw model confidence as authority, mutable tag baselines, and premature multi-service decomposition.

# Revisit trigger

Reassess by 2026-09-15 or when:

- the 297 candidate findings and 275 validation decisions are recovered or declared unavailable;
- retained and removed samples receive independent labels;
- root-cause deduplication is complete;
- Scruffy's evidence and decision contracts exist;
- the implementation stack has been explicitly compared;
- one end-to-end poison slice has run prospectively in shadow mode.

Increase confidence only after the audit metrics can be recomputed and Scruffy's decision behavior is evaluated on an untouched prospective cohort.

# Sources

## Local sources

- PR Guardian, `TIERED_AUTONOMOUS_REVIEW_DESIGN.md`, working draft dated 2026-07-14 to 2026-07-15. Supports the product thesis, three-gate model, audit claims, open forks, and packaging ideas.
- PR Guardian, `GREENFIELD_KICKOFF.md`, founding draft dated 2026-07-15. Supports the heritage list, poison-check design, visual-QA concept, production scars, and proposed stack.
- PR Guardian, `ARCHITECTURE.md`, accessed 2026-07-15. Supports the implemented pipeline and architectural invariants.
- PR Guardian decision engine, validator, finding models, readiness implementation, ADRs 003/004/007/008/011/012, and nightly workflow, inspected 2026-07-15. Support implementation-level findings.
- PR Guardian targeted test run, 2026-07-15: 116 tests passed across decision, validation, structural escalation, readiness, lifecycle, fix inference, and range review.
- Internal 30-day audit scratchpad, inspected 2026-07-15. Contained a 159-record manifest, raw PR/thread material, 159 diff files, 157 review records, comment classifications, 22 retained findings, and report-generation code. Raw material was not copied because it contains personal and internal information.
- Scruffy, `docs/decisions/0001-ownership-and-trust-boundaries.md`, 2026-07-15. Supports accepted ownership and policy boundaries.
- Scruffy, `docs/decisions/0002-initial-language-scope.md`, 2026-07-15. Supports accepted v1 language scope.

## External sources

- OASIS, *SARIF Version 2.1.0*, 2020, accessed 2026-07-15. https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html — finding fingerprints and baseline concepts.
- GitHub, “SARIF support for code scanning,” accessed 2026-07-15. https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning — alert identity and lifecycle integration.
- Kubernetes, “Controllers,” accessed 2026-07-15. https://kubernetes.io/docs/concepts/architecture/controller/ — durable reconciliation pattern.
- AWS, “Transactional outbox pattern,” accessed 2026-07-15. https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html — durable event processing and idempotency.
- Guo et al., “On Calibration of Modern Neural Networks,” 2017, accessed 2026-07-15. https://arxiv.org/abs/1706.04599 — confidence calibration.
- Huang et al., “Large Language Models Cannot Self-Correct Reasoning Yet,” 2023, accessed 2026-07-15. https://arxiv.org/abs/2310.01798 — limits of intrinsic model self-correction.
- GitHub, “Secure use reference,” accessed 2026-07-15. https://docs.github.com/en/actions/security-for-github-actions/security-guides/secure-use-reference — immutable references and workflow security.
- Microsoft Playwright, “Docker,” accessed 2026-07-15. https://playwright.dev/docs/docker — isolation requirements for untrusted browser execution.
- Semgrep, “Add Semgrep to CI,” accessed 2026-07-15. https://semgrep.dev/docs/deployment/add-semgrep-to-ci — differential and full-scan behavior.
- Google, ClusterFuzzLite, accessed 2026-07-15. https://github.com/google/clusterfuzzlite — PR and longer-running fuzzing analogy.
- Argo Rollouts, “Analysis and progressive delivery,” accessed 2026-07-15. https://argo-rollouts.readthedocs.io/en/stable/features/analysis/ — inconclusive rollout analysis and intervention.
- U.S. Congress, Sarbanes-Oxley Act Section 404, accessed 2026-07-15. https://www.law.cornell.edu/uscode/text/15/7262 — internal-control requirements.
- AICPA, *Trust Services Criteria*, revised points of focus 2022, accessed 2026-07-15. https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022 — change-control criteria.
- PCI SSC, *PCI DSS v4.0.1*, June 2024, accessed 2026-07-15. https://docs-prv.pcisecuritystandards.org/PCI%20DSS/Standard/PCI-DSS-v4_0_1.pdf — custom-code review options.

# Agent-use notes

- PR Guardian's founding documents, implementation, ADRs, workflows, architecture, and targeted tests were inspected locally.
- Four independent research tracks examined supporting evidence, counter-evidence, feasibility, and source accuracy.
- The internal audit deck and its source corpus were subsequently inspected, correcting the initial conclusion that the audit lacked artifacts.
- Raw audit material was treated as sensitive and was not copied into Scruffy.
- External market completeness remains limited because child research could not access the configured Brave key and relied partly on known primary sources.
