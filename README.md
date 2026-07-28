# Scruffy

Scruffy is an experimental review service for GitHub repositories. It reviews
changes at three points—pull request, nightly, and release—and applies a
different decision policy at each point.

The project is currently a **walking skeleton**, not a production service. The
core workflows run end to end through Postgres and the transactional outbox, but
all GitHub checks should remain non-required while the system is evaluated in
shadow mode.

## How Scruffy works

| Gate        | Runs over                        | Purpose                                                            | Possible result                     |
| ----------- | -------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| **Poison**  | One pull request                 | Catch only high-confidence security defects or silent data loss    | `allow`, `block`, `indeterminate`   |
| **Nightly** | Changes since a branch watermark | Perform a deeper review and optionally propose a narrow fix        | `suppress`, `report`, `propose_fix` |
| **Release** | Previous release to candidate    | Decide whether the candidate is safe to publish or needs attention | `ship`, `sign-off-required`, `stop` |

The gates deliberately have different authority:

- Poison may make a blocking decision, but abstains when evidence is weak.
- Nightly never blocks. It reports findings or proposes fix PRs.
- Release produces one aggregate decision. Uncertainty requires sign-off rather
  than being treated as safe.

Scruffy currently detects three deterministic defect classes:

- leaked credentials;
- destructive database migrations that can silently lose data;
- disabled TLS certificate verification.

Each deterministic finding is checked by an adversarial validator before it can
influence a decision. Model-backed analysis exists for experimentation, but it
is not part of the deterministic poison path and cannot independently create a
block.

For the product rationale and intended ownership model, read
[`docs/product/vision.md`](docs/product/vision.md).

## Current status

What works today:

- all three gates run through the real domain, persistence, and effects layers;
- run state and decisions are stored in Postgres;
- decisions and outbound effects are committed atomically;
- retries, leases, reconciliation, idempotency, and dead-lettering are covered;
- GitHub can be accessed through an authenticated `gh` session or a GitHub App;
- the hosted webhook server accepts signed pull-request events for the poison
  gate;
- deterministic harnesses and labeled corpus replays run offline.

Important limitations:

- GitHub checks are still intended for shadow use and must remain non-required;
- the first real GitHub App installation and outward check-run are operator
  steps that have not been completed;
- the webhook server handles `pull_request` events, not merge queues;
- nightly and release have manual entry points but no production scheduler or
  release integration yet;
- the included corpora are small synthetic validation sets, not evidence of
  production accuracy;
- the local hostile-code runner uses Docker, which is not accepted as the final
  production isolation boundary;
- unsupported-language coverage is not yet labeled in results.

See [Known gaps](#known-gaps) for the related design documents.

## Prerequisites

- Node.js 22 or newer
- npm
- Docker with Docker Compose
- GitHub CLI (`gh`) only when running a manual review against GitHub

## Quick start

Install dependencies and start the local Postgres instance:

```bash
npm install
npm run db:up
npm run db:migrate
```

Run the deterministic end-to-end harness:

```bash
npm run harness
```

Run the normal development checks:

```bash
npm run typecheck
npm run lint
npm test
npm run format:check
```

Stop Postgres when finished:

```bash
npm run db:down
```

The default local database URL is:

```text
postgres://scruffy:scruffy@localhost:5433/scruffy
```

Set `DATABASE_URL` to use a different Postgres instance.

### Test behavior without Postgres

`npm test` always runs the pure unit tests. Database-backed persistence and
end-to-end suites run only when Postgres is reachable; otherwise Vitest skips
them with a notice. Start the database first when you need the complete suite:

```bash
npm run db:up
npm run db:migrate
npm test
```

## Useful development commands

| Command                  | Description                                       |
| ------------------------ | ------------------------------------------------- |
| `npm test`               | Run the Vitest suite                              |
| `npm run test:watch`     | Run Vitest in watch mode                          |
| `npm run typecheck`      | Type-check without emitting JavaScript            |
| `npm run lint`           | Run ESLint                                        |
| `npm run format:check`   | Check Prettier formatting                         |
| `npm run build`          | Compile the deployable `dist/` tree               |
| `npm run harness`        | Exercise the poison gate through the durable path |
| `npm run corpus`         | Replay the poison corpus                          |
| `npm run corpus:all`     | Replay all deterministic gate corpora             |
| `npm run test:isolation` | Run the Docker runner's escape-attempt suite      |
| `npm run ops:measure`    | Build and collect local operational measurements  |

Additional corpus commands are `corpus:nightly`, `corpus:release`,
`corpus:grounded`, and `corpus:grounded:live`.

## Run a shadow review against GitHub

The manual commands below read a real GitHub diff and write a visible status or
check. Use a test repository you control. Confirm that the Scruffy check context
is **not required** by branch protection.

By default, these commands use your authenticated `gh` session for both reads
and writes:

```bash
gh auth status
npm run db:up
npm run db:migrate
```

### Review a pull request

```bash
npm run scruffy:review -- <owner/repo> <pr-number>
```

This runs the poison gate and posts `scruffy/poison` on the PR's head commit.
The result is `success` for allow, `failure` for block, or `pending` for an
abstention when using the default commit-status writer.

### Review a branch with the nightly gate

```bash
npm run scruffy:nightly -- <owner/repo> <branch> [head-sha]
```

The nightly gate reviews the range after the branch's stored watermark. Running
it again at the same head is an idempotent no-op.

The default `gh-cli` writer can publish the nightly summary, but it cannot open
fix PRs. If the gate chooses `propose_fix`, that effect dead-letters and the
command exits non-zero with a warning. Opening fix PRs requires the GitHub App
writer.

### Review a release candidate

```bash
npm run scruffy:release -- <owner/repo> <candidate-ref> [previous-release-ref]
```

This reviews `(previous release, candidate]` and publishes the advisory
`scruffy/release` result. If the previous release is omitted, Scruffy treats the
candidate as the first release.

## Run the webhook server

The hosted entry point serves:

- `POST /webhook` — verify a GitHub signature, record a poison run durably, and
  return `202` before analysis completes;
- `GET /healthz` — verify that the process can reach Postgres.

Start it locally with:

```bash
export SCRUFFY_WEBHOOK_SECRET=<github-webhook-hmac-secret>
npm run db:up
npm run serve
```

The server listens on port `8080` by default. `PORT` overrides it.

The webhook handler is intentionally not the work authority. It records the run
and prompts processing; the reconcile loop claims pending work, recovers expired
leases, and flushes outbound effects. This means an accepted webhook promises
durable work, not immediate completion.

### SCM backends

Reader and writer credentials are selected independently:

| Variable             | Values                 | Default  |
| -------------------- | ---------------------- | -------- |
| `SCRUFFY_SCM_READER` | `gh-cli`, `github-app` | `gh-cli` |
| `SCRUFFY_SCM_WRITER` | `gh-cli`, `github-app` | `gh-cli` |

The `gh-cli` backend is convenient for local shadow testing. A hosted App-only
configuration uses:

```bash
export SCRUFFY_GH_APP_ID=<app-id>
export SCRUFFY_GH_APP_INSTALLATION_ID=<installation-id>
export SCRUFFY_GH_APP_PRIVATE_KEY_FILE=~/.secrets/scruffy-app.pem
export SCRUFFY_WEBHOOK_SECRET=<webhook-secret>
export SCRUFFY_SCM_READER=github-app
export SCRUFFY_SCM_WRITER=github-app

npm run app:doctor
npm run serve
```

`SCRUFFY_GH_APP_PRIVATE_KEY` can be used instead of the file variable. Never
store either the private key or webhook secret in this repository.

`npm run app:doctor` is read-only: it authenticates as the installation and
lists every repository in scope. The complete registration, permissions,
webhook, verification, and rollback procedure is in
[`docs/product/github-app-setup.md`](docs/product/github-app-setup.md).

### Server configuration

| Variable                        | Purpose                                      | Default                |
| ------------------------------- | -------------------------------------------- | ---------------------- |
| `DATABASE_URL`                  | Postgres connection string                   | Local Compose database |
| `SCRUFFY_WEBHOOK_SECRET`        | HMAC secret used to verify GitHub deliveries | Required               |
| `PORT`                          | HTTP listen port                             | `8080`                 |
| `SCRUFFY_RECONCILE_INTERVAL_MS` | Reconcile and outbox flush interval          | `10000`                |
| `SCRUFFY_SCM_READER`            | GitHub read adapter                          | `gh-cli`               |
| `SCRUFFY_SCM_WRITER`            | GitHub write adapter                         | `gh-cli`               |

Unknown backend values and malformed positive-integer settings fail at startup
instead of silently falling back.

## Architecture

A gate run follows this path:

```text
GitHub webhook or manual command
  -> verify and parse input
  -> create or find an idempotent run in Postgres
  -> claim the run with a fenced lease
  -> read the complete GitHub diff
  -> analyze and adversarially validate findings
  -> apply the gate's pure decision policy
  -> atomically store the decision and an outbox effect
  -> dispatch an idempotent status, check-run, or fix PR
```

Key properties:

- **Fail closed without false confidence:** incomplete diffs and infrastructure
  failures do not become clean allows.
- **Pure decisions:** gate policy is separated from I/O under
  `src/gates/*/decision.ts`.
- **Durable execution:** runs, leases, decisions, and effects live in Postgres.
- **Atomic effects:** a terminal decision and its outbound effect are committed
  in one transaction.
- **Crash recovery:** reconciliation retries pending or expired work; lease
  fencing prevents a stale worker from overwriting a live one.
- **Idempotent writes:** repeated delivery or dispatch does not intentionally
  create duplicate runs, checks, or fix PRs.
- **Separate trust edges:** SCM reads and writes can use separate adapters and
  credentials.

## Repository map

```text
src/app/           application wiring, reconciliation, and lease heartbeats
src/domain/        evidence, policy, finding, validation, and fix contracts
src/gates/         poison, nightly, and release analysis + decision services
src/ingest/        GitHub webhook verification and parsing
src/persistence/   Postgres runs, migrations, leases, decisions, and outbox
src/effects/       idempotent check-run and pull-request dispatch
src/providers/     SCM, analyzer, validator, fixer, and model adapters
src/corpus/        labeled examples, replay logic, and metrics
src/execution/     hostile-code runner experiment
src/server/        HTTP server and hosted process entry point
scripts/           manual GitHub reviews, doctor, smoke, and measurement tools
test/              unit, persistence, harness, and end-to-end tests
migrations/        ordered Postgres schema migrations
```

Built-in analyzers, validators, fixers, and class-to-gate policy are registered
in [`src/providers/registry.ts`](src/providers/registry.ts). When adding a new
deterministic blockable class, add both an analyzer and a validator and cover it
in the relevant gate tests and corpus. A blockable class without validation must
abstain rather than block.

## Model backends

The model provider abstraction supports `fake`, `claude-cli`, `anthropic`, and
`azure` through `SCRUFFY_MODEL_BACKEND`. The fake backend is the safe default,
and tests, harnesses, and deterministic corpus runs do not make network model
calls.

Use an explicit smoke command when testing a live provider, for example:

```bash
SCRUFFY_MODEL_BACKEND=claude-cli npm run llm-smoke
```

A model verdict is supporting evidence only. It cannot independently block a
poison run.

## Known gaps

The repository records design choices and unfinished validation explicitly:

- [Product vision](docs/product/vision.md)
- [Ownership and trust boundaries](docs/decisions/0001-ownership-and-trust-boundaries.md)
- [Initial language scope](docs/decisions/0002-initial-language-scope.md)
- [Implementation and deployment shape](docs/decisions/0003-implementation-stack-and-deployment-shape.md)
- [Opt-in repository integration](docs/product/opt-in-repository-integration.md)
- [GitHub App setup and first webhook test](docs/product/github-app-setup.md)
- [Corpus labeling protocol](docs/product/corpus-labeling-protocol.md)
- [Hostile runner spike](docs/product/hostile-runner-spike.md)
- [Operational measurements](docs/product/ops-measurement.md)

The implementation/deployment ADR remains proposed until its validation criteria
are satisfied. Do not interpret the walking skeleton or synthetic corpus as
approval to make Scruffy authoritative on a repository.
