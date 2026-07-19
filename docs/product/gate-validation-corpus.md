---
artifact_type: product-playbook
contract_version: 1
id: scruffy-gate-validation-corpus
title: Validating the gates against real, sanitized history
scope: project
status: active
created: 2026-07-16
review_after: 2026-10-16
tags: [corpus, validation, poison-gate, nightly-gate, release-gate, seed-data]
---

# Purpose

Every gate so far has been exercised against **synthetic** fixtures we wrote
ourselves. That is a smoke test, not evidence: cases authored to match our own
analyzers cannot tell us the false-block rate on code we did *not* anticipate.
The heritage assessment is blunt about this — *"a cull rate is not a
false-positive rate"* — and the three-gate dossier's kill criteria are all
stated in terms of measured performance on **real, representative history**
(block precision lower bound, false-block rate, incremental severe findings,
regression-free fixes).

This playbook turns real pull requests and change ranges from our own repos into
**sanitized, labeled corpus cases**, so we can replay the gates and read honest
metrics **before** any gate touches live traffic or becomes authoritative.

Drive it autonomously with the built-in `/goal` command, whose argument is an
inline completion condition (not a file) evaluated against the conversation
transcript. A worked condition that encodes the phases and the data-safety
preflight below:

> `/goal` Validate the poison and nightly gates against real, sanitized seed
> data, with all evidence printed to this conversation. Complete when ALL are
> shown in the transcript: (1) a poison `LabeledCase` from a real PR mixing a
> critical security defect with nitpicks — sanitized, provenance
> `sanitized-historical` — is committed and `npm run corpus` output shows it
> blocking correctly with zero false blocks; (2) a nightly range-corpus +
> range-replay harness is built and committed with tests shown passing, and a
> real sanitized change-range case is replayed with disposition + fix results
> printed; (3) a release fixture *shape* is authored and committed, marked
> no-runner. HARD PRECONDITION: state the data-safety preflight as passed before
> fetching any real repo data; never commit or echo raw data. Stop after 40
> turns if not complete.

# Data-safety preflight — the first hard gate

This is not optional and it overrides convenience. Real diffs are exposed to the
AI the instant they are fetched, so the rules apply *before* the first fetch:

1. **In-scope work repos only.** Target repositories must belong to an approved
   organization (Context& / Delegate / Projectum / Consit / Sulava) and be work,
   not a personal project. If the repo is outside those, **stop** and confirm
   with DISCO, or use the Anthropic Enterprise license instead.
2. **No customer data, no PII.** A case may not carry personal or customer data
   at rest. If a candidate diff contains either and cannot be cleanly sanitized,
   **drop the case** — do not "mostly" sanitize it.
3. **This repo is PUBLIC → structure-grounded, not sanitize-in-place (default).**
   The corpus lives in a public repo, so the safe default is *not* to sanitize
   real bytes and commit them — AI sanitization is error-prone (one missed
   internal identifier leaks forever). Instead, read a real merged defect's
   **shape** (its class, why review missed it, its rough structure), then rebuild
   the case from scratch with **100% invented identifiers**. Stamp it
   `source: seeded-mutation` with `grounding: real-merged-defect` and an auditable
   `sourceRepo` + `sourceRef` — the lineage is recorded without any real bytes
   crossing over. Reserve `source: sanitized-historical` for a **private** corpus
   destination only; if a case truly needs real (sanitized) bytes, keep it out of
   this public repo.
4. **No customer data, no PII — and never credential-scan the source.** A case may
   not carry personal or customer data. Read defect *shapes* from normal file
   history; do not grep the source repo for secrets (AKIA/ghp_/sk-…) to seed a
   public corpus.
5. **If in doubt, escalate.** Ambiguous data provenance → DISCO / Enterprise,
   not a judgment call in the pipeline.

A case that cannot pass this preflight never enters the corpus. Silent
truncation of the rule is the failure mode to avoid.

## Grounded corpus — real defect shapes, all three gates

Structure-grounded cases live in `src/corpus/grounded.ts`
(`npm run corpus:grounded`) — real merged defects, rebuilt with invented
identifiers. Each is a *semantic* defect the deterministic analyzers cannot see,
so they are scored with a deterministic, **offline fake model** wired in, and each
change is run through all three gates. So far:

- **fail-open ownership guard** → `missing-authorization`, grounded in
  `context-and/portfolio-simulation` `d745dcf`.
- **null-gated row mapper** → `silent-data-loss` (a mapper returns null on a
  legitimately-optional field and the loader filters nulls, so rows silently
  vanish), grounded in `context-and/resource-planner` `bffd1b5`.

Both are model classes, so both map to: poison **allows** (out of blocking scope,
no false-block), nightly **reports** (model-asserted, not auto-fixed), release
requires **sign-off** (no silent ship, no fabricated stop). That uniformity is an
honest finding — the source repos merge *semantic* defects (authorization,
data-loss), not the deterministic-catastrophic classes (leaked secret, dropped
table), so the grounded set naturally lands in the model-asserted lane. The trust
posture is enforced by the kernels: a model-asserted finding can never manufacture
a poison block or a release stop.

## Grounded corpus, LIVE — a real model instead of the seeded fake

`npm run corpus:grounded:live` (`src/corpus/grounded-live-run.ts`) replays the
same grounded cases with a **real model** wired into the model analyzer —
defaults to the `claude` CLI backend; `SCRUFFY_MODEL_BACKEND=anthropic|azure`
overrides, `SCRUFFY_CLAUDE_CLI_MODEL` pins the CLI model. It first scores raw
model-analyzer recall against each case's seeded truth (match key: class +
path), then replays all three gates with the same responses memoized (one model
call per case). It is a manually-run probe, not a CI gate: a live model is
non-deterministic, so the nightly exact-count summary pins are dropped and
extra findings are reported rather than failed. It exits non-zero when the
thesis fails: a seeded defect missed, a poison false-block, an unsafe release
ship, or a gate-outcome regression.

First live results (2026-07-19, `claude` CLI; default model and `opus` both):

- **fail-open ownership guard → CAUGHT** by both models. The default model
  anchored the seeded line exactly; opus instead reported a *different, also
  real* `missing-authorization` defect in the same seeded guard (`update()`
  authorizes against the caller-supplied `doc.ownerId` without fetching the
  stored record). Nightly matches on (class, path), so both count — and the
  second defect is a finding about the seeded code itself.
- **null-gated row mapper → MISSED** by both models (clean `[]`). The ground
  truth ("ownerId is legitimately optional") is domain knowledge that is *not
  visible in the added lines* — the diff's own comment says the null-gate skips
  "malformed rows". With the defect missed, nightly surfaces nothing and the
  release gate ships: measured evidence that the added-lines-only prompt bounds
  what the model analyzer can catch, and that context-dependent semantic
  defects escape all three gates. Widening analyzer context (surrounding file
  content, referenced types) is the concrete next lever this measures.

## One cross-gate sweep

`npm run corpus:all` runs **every** corpus through its gate in one command — a
deterministic lane (synthetic + seeded) and a grounded lane (model-backed) per
gate — and prints one line per (gate, lane) plus an overall verdict. It exits
non-zero on any false-block, unsafe release ship, or regression. The per-gate
scripts (`corpus`, `corpus:nightly`, `corpus:release`, `corpus:grounded`) remain
for the full confusion matrices.

# What a "case" is, per gate

## Poison — ready today

The corpus schema (`src/corpus/types.ts` `LabeledCase`) and replay harness
(`src/corpus/replay.ts` `replayCorpus`, `npm run corpus`) already exist and are
fed only synthetic cases. A poison case is a single subject revision:

- `files`: the changed files (sanitized patches, GitHub's shape).
- `truthPoison` / `truthDefectClass`: ground truth — is this genuinely
  poison-worthy, and of what class.
- `expectedOutcome` (optional regression pin): `block | allow | indeterminate`.
  Note this is distinct from truth — a legitimate abstain on a poison case is
  correct behavior even though it is not a catch.

**The gold-standard case is a PR with both a critical security defect and
nitpicks** (formatting, renames, a benign refactor). It tests the two things
that matter at once: the gate **blocks** on the real defect, and does **not**
false-block on the noise. One realistic mixed PR is worth ten single-purpose
synthetic ones.

## Nightly — needs a small build first

Poison has a corpus + replay harness; **nightly has neither.** It is currently
tested only through e2e fixtures. Before nightly seed data has anywhere to land,
build the analog of the poison harness:

- a **range corpus** schema: a labeled `(base, head]` range with per-finding
  ground truth — for each expected finding, its `defectClass` and the
  disposition we expect (`report | propose_fix | suppress`), plus whether a
  generated fix would be **acceptable** (the patch is correct and narrow).
- a **range replay** that runs `runNightlyAnalysis` + `generateFixes` over the
  range and scores dispositions and fix quality against ground truth.

A nightly case is naturally *"take a range of changes"* from a repo: a day's
worth of merges is the real unit the gate reviews. Ground truth is the harder
part — it needs a human call on which findings are real and which proposed fixes
are actually good.

## Release — deferred (gate not built)

There is no `gates/release` yet, so there is nothing to replay a release case
against. Per the chosen scope we still **author the fixture shape now** so it is
ready the day the gate lands, but this is structure-ahead-of-runner and must be
labeled as such — do not imply coverage that does not exist. A release case is a
range from the previous release to a candidate, with ground truth for the
ship / sign-off-required / stop decision (and, later, visual evidence). Until
the gate exists, these fixtures have **no runner** and prove nothing.

# The workflow

For each candidate (all steps gated by the preflight above):

1. **Fetch (read-only).** `gh pr view <n> --json ...` / `gh pr diff <n>` for a
   poison case; `gh api` compare or `git log/diff <base>..<head>` for a range.
2. **Sanitize.** Replace secrets with fake-but-shaped placeholders, scrub PII /
   customer identifiers / internal hostnames, keep the defect intact. Record
   what was changed so the sanitization is auditable.
3. **Label ground truth.** The human-meaningful judgment: is there a real
   defect, of what class, and what *should* each gate do. This is the load-
   bearing signal — get it wrong and every metric downstream is wrong.
4. **Add to the corpus** with `sanitized-historical` provenance + author + date.
5. **Replay & read metrics** (below). Regressions in `expectedOutcome` pins fail
   loudly.

# What "good" looks like (dossier kill criteria)

- **Poison:** block precision **Wilson-95 lower bound ≥ 95%**, false-block rate
  **< 0.5%** of adjudicated-clean PRs, historically-catastrophic classes caught
  or covered by a deterministic control. `replayCorpus` already reports the
  confusion matrix, precision with Wilson bound, false-block rate, severe
  recall, and abstain rate.
- **Nightly:** incremental **severe** findings surfaced without inflating
  reviewer effort; proposed fixes narrow and correct (no regressions once repo
  CI runs them). Requires the range-replay harness to measure.
- **Release:** deferred with the gate.

The synthetic corpus stays as a fast regression smoke test; the sanitized-
historical cases are what turn "the validator culled 92% of candidates" into an
actual precision/recall.

# Readiness & phase order

| Phase | Gate | State | Blocking prerequisite |
|---|---|---|---|
| 1 | Poison | **Ready** | none — fetch, sanitize, label, `npm run corpus` |
| 2 | Nightly | Build first | range-corpus schema + range-replay harness |
| 3 | Release | Deferred | the release gate itself (`gates/release`) |

Work the phases in order. Do not let release fixtures (phase 3) imply the
release gate is validated — it is not built.
