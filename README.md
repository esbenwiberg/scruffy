# Scruffy

Service-controlled three-gate review system for organization repositories. See
`docs/product/vision.md` for the product thesis and `docs/decisions/` for the
accepted trust, language, and stack ADRs.

This repository currently contains the **walking skeleton**: one poison-gate
defect class driven end-to-end through the real durable path, with the trust
edges (GitHub, model) faked so the whole thing runs deterministically and
offline.

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

## What is NOT built yet

Honest gaps against ADR 0003's acceptance list:

- **Real GitHub adapter** (Octokit check runs) and **real model adapters**
  (Claude/Codex CLI locally, Azure AI Foundry deployed). Only fakes today.
- **Hostile-execution runner** (validation #5) — separate trust boundary,
  its own spike.
- **Merge-group / merge-queue** handling, nightly and release gates.
- A statistically meaningful corpus — the synthetic set is a machinery smoke
  test only (small-n; the Wilson lower bound is honest about that).
- Dev-toolchain audit advisories (vitest/vite/esbuild) — fix via a vitest v4
  bump.

## Layout

`src/domain` typed evidence/policy/evaluation contracts · `src/gates/poison`
decision kernel + analysis orchestration · `src/providers` SCM/model/analyzer/
validator ports and fakes · `src/persistence` Postgres, migrations, runs,
outbox · `src/effects` idempotent SCM writes · `src/ingest` webhook verify +
parse · `src/app` wiring · `test/harness` end-to-end boot.
