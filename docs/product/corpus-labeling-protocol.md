# Corpus and labeling protocol

Scruffy's gates are only as trustworthy as the evidence that they behave
correctly. The research dossiers are explicit that a validator cull rate is not
a false-positive rate: turning "the validator removed 92% of candidates" into a
defensible precision/recall claim requires a **labeled** corpus and blinded
adjudication. This document defines how that corpus is built and used.

## Hard privacy rule

The real PR Guardian 30-day audit corpus contains personal and internal
information. It is **not** copied into this repository. Corpus cases here are:

- **synthetic** — hand-authored, no real credentials or customer data; or
- **seeded-mutation** — deliberate defects injected into synthetic or cleared
  code; or
- **sanitized-historical** — derived from history only after PII/secret
  scrubbing and explicit review, recorded as such in provenance.

Every case records `provenance.source` so its origin is auditable. The
`src/corpus` schema (`LabeledCase`) enforces the shape; a case without
provenance does not load.

## What a case labels

Ground truth is the pair `truthPoison` (is this change genuinely
poison-worthy?) and `truthDefectClass`. Distinct from ground truth is the
optional `expectedOutcome` regression pin — a legitimate **abstain** on a poison
case is correct behavior, not a catch, so truth and expected outcome are
tracked separately.

Follow the heritage assessment's four-level distinction and never collapse them:

1. process observations (PRs, approvals, comments);
2. unique patch observations (dedupe identical diffs);
3. finding instances;
4. unique defect root causes (after semantic dedup).

## Scoring

`replayCorpus` produces a confusion matrix over six buckets — `true_block`,
`false_block`, `missed`, `true_allow`, `abstain_on_poison`, `abstain_on_clean` —
and derives:

- **block precision** with a Wilson 95% lower bound (the pre-registerable
  quantity: the dossier's target is a lower bound ≥ 95%);
- **false-block rate** over clean cases (target < 0.5%);
- **severe-case recall** over poison cases;
- **abstain rate**.

Abstention is its own bucket, never counted as a false block.

## Before any gate becomes authoritative

The synthetic corpus in `src/corpus/synthetic.ts` is a machinery smoke test, not
a statistically meaningful set. Authoritative blocking requires, per the
research revisit triggers:

- a much larger sanitized/seeded corpus per defect class and language;
- blinded adjudication with inter-rater disagreement recorded;
- confidence intervals, not point estimates;
- an untouched held-out evaluation set;
- prospective shadow-mode measurement before thresholds are trusted.
