# Scruffy

Service-controlled three-gate review system for organization repositories. See
`docs/product/vision.md` for the product thesis and `docs/decisions/` for the
ADRs: trust boundaries (ADR-0001) and language scope (ADR-0002) are **Accepted**;
the implementation/deployment stack (ADR-0003) is still **Proposed** (its
acceptance criteria are not all met — see "What is NOT built yet").

This repository is a **walking skeleton**. All three gates — **poison** (blocking),
**nightly** (proposes fixes), and **release** (ship / sign-off / stop) — are wired
end-to-end through the real durable path, with the trust edges (GitHub, model)
faked so the whole thing runs deterministically and offline. The deterministic
defect classes are `leaked-credential`, `destructive-schema-change` (silent data
loss), and `disabled-tls-verification` (exploitable security), each with an
adversarial validator; a model-backed analyzer adds semantic classes off the
deterministic critical path.

## Run it

Requires Docker (for Postgres) and Node ≥ 22.

```bash
npm install
npm run db:up        # start Postgres (docker compose) and wait for it
npm run db:migrate   # apply migrations
npm run harness      # boot Scruffy, feed seeded PRs, print outcomes
npm run corpus       # replay the labeled poison corpus, print metrics (no DB)
npm test             # unit + persistence + end-to-end suite
npm run typecheck
```

`npm run db:down` tears the database down.

Other corpus replays (all DB-free): `npm run corpus:nightly`, `npm run
corpus:release`, `npm run corpus:grounded`, and `npm run corpus:all` — the
cross-gate sweep that fails loudly on any false-block, unsafe ship, or
regression. `npm run corpus:grounded:live` runs the grounded detection targets
against a real model backend.

### Run the poison gate against a real PR (shadow)

`scruffy:review` runs the poison gate against a real GitHub PR and posts a
**shadow commit status** on its head commit. It reuses your authenticated `gh`
CLI session (no token in config) for both reading the diff and posting the status.

```bash
gh auth status                                   # must be logged in with push access
npm run db:up && npm run db:migrate              # Postgres for durable runs
npm run scruffy:review -- <owner/repo> <pr-number>
```

It resolves the PR's base (via the commit's associated **open** PR), reads the
diff (`gh api compare/base...head`, falling back to the head commit's own file
list when no open PR is associated), runs the deterministic poison analysis, and
posts a `scruffy/poison` commit status: `success` (allow), `failure`
(block), or `pending` (abstained). If the diff cannot be read completely (a `gh`
failure, the 300-file cap, or a file too large to diff) it abstains rather than
scanning a partial diff as clean. **Shadow by construction** — a commit status
only blocks a merge if a repo admin marks its context a *required* check, so
scruffy posts the honest state and never blocks on its own. It also prints the
decision and the PR URL.

Why a status and not a check-run: creating check-runs requires a GitHub App
(`checks:write`); a user token (which `gh` holds) can't. Commit statuses need only
push access. The richer check-run object is a later GitHub-App slice. Point it at a
**test repo you control**, never a customer repo — a status is a visible write.

## What the skeleton proves

The inbound path runs on real code with faked edges:

```
signed webhook → verify + parse → ensureRun (idempotent)
  → guarded pending→analyzing (fenced lease) → analyze (deterministic analyzers)
  → adversarial validate → atomic { terminal transition + decision + outbox effect }
  → effects dispatcher (per-effect isolation, dead-letter) → idempotent check-run upsert
```

- **Pure decision kernel** (`src/gates/poison/decision.ts`): `block | allow |
  indeterminate` over typed evidence + policy. Abstains rather than inventing
  confidence; infra failure never becomes a clean allow; model-only signals
  cannot block.
- **Durable runs + transactional outbox** (`src/persistence/`): guarded
  transitions (no double-apply), atomic decision+effect commit, at-least-once
  idempotent dispatch.
- **Leases + reconciliation** (`src/app/reconciler.ts`): crashed mid-analysis
  runs (expired lease) and stuck `pending` runs are recovered independently of
  webhook delivery; commits are fenced on a per-claim lease token so a zombie
  worker cannot overwrite a live one; bounded retry then abstain. This covers
  validation #4's lease-expiry, duplicate-webhook, retry, and reconciliation
  elements; **supersession** is modeled as a run state but not yet exercised.
- **Measurement** (`src/corpus/`): labeled corpus + replay → confusion matrix,
  block precision with Wilson 95% lower bound, false-block rate, severe-case
  recall, abstain rate. See `docs/product/corpus-labeling-protocol.md`.
- **Deterministic edges** (`src/providers/*/`, `test/fixtures/`): FixedClock +
  SeededIdGenerator, fake SCM/model, seeded PR fixtures.

## Model backends

Analysis/validation model calls go through one `ModelProvider` port
(`src/providers/models/`). `SCRUFFY_MODEL_BACKEND` selects the implementation:

- `fake` (default) — deterministic, no network. Tests, harness, and corpus
  always use this; nothing fires a live model unless explicitly asked.
- `claude-cli` — local dev, reuses the authenticated `claude` CLI session (no API
  key in config).
- `anthropic` — local dev via the Anthropic SDK (`ant` profile / `ANTHROPIC_API_KEY`).
- `azure` — deployed service via Azure AI Foundry.

The `ModelValidator` (`src/providers/validation/model-validator.ts`) is the
adversarial critic: it asks the model to **refute** a deterministic finding.
Even a `validated` verdict still requires deterministic supporting evidence for
the poison kernel to block, and any provider/parse failure becomes `failed`
(abstain) — so the model can never manufacture a block. Fire it against synthetic
findings:

```bash
SCRUFFY_MODEL_BACKEND=claude-cli npm run llm-smoke
```

## What is NOT built yet

Honest gaps against ADR 0003's acceptance list:

- **Real GitHub writes beyond a shadow status.** A `gh`-backed adapter now reads
  real PRs and posts a shadow commit status (`npm run scruffy:review`), but the
  richer **check-run** object and **fix-PR writes** need a GitHub App (deferred),
  and there is no hosted webhook server yet (the verify path exists; the trigger
  is manual). Model adapters exist (`claude-cli`/`anthropic`/`azure`) but are off
  the deterministic critical path.
- **ADR deviations to reconcile.** ADR-0003 specifies GitHub I/O through Octokit;
  the walking skeleton shells out to the `gh` CLI instead (see the shadow-status
  section for why). ADR-0001 wants writes to go through a *separately, narrowly
  privileged* component; today a single `gh` user session serves both read and
  write. The effects dispatcher is the sole write path (the architectural half of
  that decision), but the separate credential is not yet real. Neither ADR has
  been amended.
- **Coverage labeling** (ADR-0002): unsupported-language results are meant to be
  labeled with their reduced coverage; no such labeling exists yet.
- **Hostile-execution runner** (validation #5) — separate trust boundary,
  its own spike. Also unmet: cold-start/latency/ops measurement (#6) and the
  cross-language capability comparison (#7). These are why ADR-0003 is still
  Proposed.
- **Merge-group / merge-queue** handling — the webhook path parses only
  `pull_request` events; `merge_group_sha` is always null.
- A statistically meaningful corpus — the synthetic set is a machinery smoke
  test only (small-n; the Wilson lower bound is honest about that).

## Layout

`src/domain` typed evidence/policy/evaluation/validation contracts ·
`src/gates/{poison,nightly,release}` each gate's decision kernel + analysis
orchestration + durable service · `src/providers` SCM/model/analyzer/validator/
fixer ports, deterministic analyzers, and the registry that binds analyzers ↔
validators ↔ classes · `src/persistence` Postgres, migrations, runs, outbox ·
`src/effects` idempotent SCM writes · `src/ingest` webhook verify + parse ·
`src/corpus` labeled corpora (poison/nightly/release/grounded) + replay metrics ·
`src/app` wiring + reconciler · `test/` unit, persistence, e2e.

New deterministic defect classes plug in via `src/providers/registry.ts`: add an
analyzer, a validator for its class, and the class name — the registry keeps
harness, corpus, and production wiring in sync, and any blockable class without a
validator abstains rather than blocking.
