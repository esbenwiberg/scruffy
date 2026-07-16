# Goal: validate a gate against a real, sanitized case

Turn one real pull request or change range from an in-scope repo into a
sanitized, labeled corpus case, then replay the relevant gate and report honest
metrics. Companion reference: `gate-validation-corpus.md`. Work one case at a
time; a case either passes every gate below or it does not enter the corpus.

## Inputs

- `repo`: `owner/name` of a work repo in an approved org.
- `gate`: `poison` | `nightly` | `release`.
- `ref`: for poison, a PR number or head sha; for nightly/release, a
  `base..head` range (or "the last day of merges", resolved via `gh`/`git`).

If any input is missing, ask for it before fetching anything.

## Step 0 — data-safety preflight (HARD GATE, do this first)

Do not run `gh`/`git` against the repo until all of these hold. If any fails,
**stop and report** — do not proceed, do not partially sanitize.

1. `repo` belongs to Context& / Delegate / Projectum / Consit / Sulava and is
   work, not a personal project. Otherwise: stop, tell the user to confirm with
   DISCO or use the Anthropic Enterprise license.
2. The user has confirmed the target contains **no customer data and no PII**,
   OR agrees every fetched artifact is treated as sanitize-required and any case
   that cannot be cleanly sanitized is dropped.
3. Nothing raw (unsanitized diffs, secrets, identifiers) will be echoed into
   responses or committed — only the sanitized result lands.

State explicitly that the preflight passed (and on what basis) before Step 1.

## Step 1 — fetch (read-only)

- poison: `gh pr view <n> --json title,files,headRefOid` and
  `gh pr diff <n>` (or resolve the head sha and diff it).
- nightly / release: resolve the range, then `gh api .../compare/<base>...<head>`
  or `git diff <base>..<head>` for the changed files.

Read-only only. Never write to the source repo.

## Step 2 — sanitize

Transform the real diff into a safe equivalent that **preserves the defect
semantics**:

- real secrets/tokens/keys → obviously-fake, correctly-shaped placeholders;
- PII, customer names, internal hostnames, account ids → neutral stand-ins;
- keep the vulnerable/benign structure intact so the case still tests what it
  claims (a sanitized secret must still look like a secret to the analyzer; a
  nitpick must stay a nitpick).

Keep a short, auditable note of what was replaced. If the diff cannot be
sanitized without destroying the thing under test, **drop it** and say so.

## Step 3 — label ground truth

The human-meaningful judgment (the signal everything downstream depends on):

- poison: `truthPoison` (bool), `truthDefectClass` (or null), and the
  `expectedOutcome` pin (`block | allow | indeterminate`). For a mixed
  critical+nitpick PR, the expectation is: block on the critical, and the
  nitpicks must not cause a false block.
- nightly: per expected finding — `defectClass`, expected disposition
  (`report | propose_fix | suppress`), and whether a generated fix would be
  acceptable (correct + narrow).
- release: the ship / sign-off-required / stop decision (structure only until
  the gate exists — see Step 4c).

When ground truth is genuinely ambiguous, record it as such rather than forcing
a label.

## Step 4 — add + replay, per gate

### 4a. poison (ready)

1. Append a `LabeledCase` to the synthetic corpus set with
   `provenance.source = "sanitized-historical"`, an author, and today's date
   (passed in, never read from the clock).
2. `npm run corpus` (or `replayCorpus`). Read the confusion matrix, block
   precision with Wilson-95 lower bound, false-block rate, severe recall,
   abstain rate.
3. Report where this case landed (true_block / false_block / abstain / …) and
   whether it moved any headline metric. A false block or a missed severe case
   is a finding, not a footnote.

### 4b. nightly (build harness first)

If no range-corpus + range-replay harness exists yet, build it before seeding
(mirror the poison corpus + `replayCorpus`: a labeled `(base, head]` range,
per-finding disposition ground truth, fix-acceptability flag; a replay that runs
`runNightlyAnalysis` + `generateFixes` and scores dispositions + fix quality).
Then add the sanitized range case and replay it. Report disposition
accuracy and fix acceptance.

### 4c. release (deferred)

Author the fixture **shape** only (range prev-release→candidate + expected
decision), clearly marked as having **no runner** until `gates/release` exists.
Do not report any release "result" — there is nothing to replay against yet.

## Step 5 — report

Summarize: what the case was (sanitized description, never raw), where it landed,
what it revealed about the gate, and whether any kill-criterion metric is now at
risk. Commit the sanitized case + any harness on a branch and open a PR (same
flow as the rest of the repo); never commit raw data.

## Stop conditions

- Preflight fails → stop, escalate to DISCO / Enterprise.
- Diff cannot be sanitized cleanly → drop the case, note why.
- Asked to run the release gate → explain it is not built; author fixture shape
  only.
