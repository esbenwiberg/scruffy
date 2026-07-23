# Scruffy

Service-controlled three-gate review system for organization repositories. See
`docs/product/vision.md` for the product thesis and `docs/decisions/` for the
accepted trust, language, and stack ADRs.

This repository currently contains the **walking skeleton**: the poison gate
driven end-to-end through the real durable path, with the trust edges (GitHub,
model) faked so the whole thing runs deterministically and offline. Three
deterministic defect classes are wired — `leaked-credential`,
`destructive-schema-change` (silent data loss), and `disabled-tls-verification`
(exploitable security) — each with an adversarial validator.

## Run it

Requires Docker (for Postgres) and Node ≥ 22.

```bash
npm install
npm run db:up        # start Postgres (docker compose) and wait for it
npm run db:migrate   # apply migrations
npm run harness      # boot Scruffy, feed seeded PRs, print outcomes
npm run corpus       # replay the labeled corpus, print metrics (no DB)
npm test             # unit + persistence + end-to-end suite
npm run typecheck
```

`npm run db:down` tears the database down.

### Run the poison gate against a real PR (shadow)

`scruffy:review` runs the poison gate against a real GitHub PR and posts a
**shadow commit status** on its head commit. It reuses your authenticated `gh`
CLI session (no token in config) for both reading the diff and posting the status.

```bash
gh auth status                                   # must be logged in with push access
npm run db:up && npm run db:migrate              # Postgres for durable runs
npm run scruffy:review -- <owner/repo> <pr-number>
```

It reads the PR diff (`gh api compare/base...head`), runs the deterministic poison
analysis, and posts a `scruffy/poison` commit status: `success` (allow), `failure`
(block), or `pending` (abstained). **Shadow by construction** — a commit status
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
  → guarded pending→analyzing → analyze (secret scan) → adversarial validate
  → atomic { terminal transition + decision + outbox effect }
  → effects dispatcher → idempotent check-run upsert
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
  webhook delivery; bounded retry then abstain. Closes validation #4.
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
- **Hostile-execution runner** (validation #5) — separate trust boundary,
  its own spike.
- **Merge-group / merge-queue** handling, nightly and release gates.
- A statistically meaningful corpus — the synthetic set is a machinery smoke
  test only (small-n; the Wilson lower bound is honest about that).
- Dev-toolchain audit advisories (vitest/vite/esbuild) — fix via a vitest v4
  bump.

## Layout

`src/domain` typed evidence/policy/evaluation/validation contracts ·
`src/gates/poison` decision kernel + analysis orchestration · `src/providers`
SCM/model/analyzer/validator ports, deterministic analyzers, and the registry
that binds analyzers ↔ validators ↔ blockable classes · `src/persistence`
Postgres, migrations, runs, outbox · `src/effects` idempotent SCM writes ·
`src/ingest` webhook verify + parse · `src/corpus` labeled corpus + replay
metrics · `src/app` wiring + reconciler · `test/` unit, persistence, e2e.

New deterministic defect classes plug in via `src/providers/registry.ts`: add an
analyzer, a validator for its class, and the class name — the registry keeps
harness, corpus, and production wiring in sync, and any blockable class without a
validator abstains rather than blocking.
