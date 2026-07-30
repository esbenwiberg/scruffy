# First GitHub App installation and webhook test

## Status

Operator runbook for Scruffy's **first** App-only installation and end-to-end
webhook test. The initial target repository is **`esbenwiberg/scruffy`**.

This is a **shadow** experiment: `scruffy/poison` stays a **non-required** check
throughout. A shadow check is visible on the PR but never blocks a merge — that
is the whole point of the first run. Do **not** mark `scruffy/poison` as a
required check in branch protection during this test (see
[opt-in-repository-integration.md](./opt-in-repository-integration.md)). The
second target, `scruffy/poison`'s own repository, likewise stays shadow.

Everything below is a one-time human step (register the App, hold the secrets,
expose the endpoint); Scruffy's code is App-ready and contract-tested offline.
Non-goals for this runbook: making the check required, enabling model analysis,
merge-queue handling, and nightly/release automation.

## Prerequisites

- Admin on the target repository (`esbenwiberg/scruffy`) so you can install a
  GitHub App on it.
- A place to run the service that GitHub can reach over HTTPS (the webhook
  endpoint) and a Postgres database. A local machine behind a tunnel (e.g. a
  reverse proxy or an `*.ngrok`-style forwarder) is fine for the first test.
- Node ≥ 22 and Docker (for local Postgres), per the README.
- A secret store OUTSIDE this repository for the App private key and webhook
  secret. Nothing secret is ever committed (the no-secrets rule).

## 1. Register the GitHub App

Create the App under the account that should own it
(Settings → Developer settings → **GitHub Apps** → **New GitHub App**), or via
`https://github.com/settings/apps/new`.

- **Name / homepage**: anything identifying (e.g. `scruffy-shadow`).
- **Webhook**: **Active**. **Webhook URL** must be your public endpoint with the
  path `/webhook` (the server only accepts webhooks on that path), e.g.
  `https://scruffy.example.com/webhook`.
- **Webhook secret**: generate a **strong, random** secret and paste it here.
  This is the HMAC secret Scruffy verifies every delivery against. It MUST be
  **distinct from the App private key** — different secret, different purpose.
  Generate one with, e.g.:

  ```bash
  openssl rand -hex 32
  ```

  Keep it; you will set it as `SCRUFFY_WEBHOOK_SECRET`.

### Repository permissions (least privilege)

Grant exactly these, and nothing more:

| Permission        | Access       | Why                                                        |
| ----------------- | ------------ | ---------------------------------------------------------- |
| **Checks**        | Read & write | post the native `scruffy/poison` check-run                 |
| **Contents**      | Read & write | read the diff; commit fix branches (nightly)               |
| **Pull requests** | Read & write | resolve the associated PR; open fix PRs                    |
| **Issues**        | Read & write | publish the nightly parent issue and its child sub-issues  |
| **Metadata**      | Read-only    | mandatory baseline (repo listing, refs)                    |

Leave everything else at **No access**.

#### Why `Issues: Read & write` is required

Nightly review produces a **work graph**: one parent issue per reviewed range,
with a **native child (sub-)issue** for every surviving finding and for every
required coverage gap. Publishing that graph needs all three halves of the Issues
permission, which GitHub bundles into one scope:

- **write** to create the parent issue and each child issue, and to update the
  parent as children are filed (`POST`/`PATCH /repos/{owner}/{repo}/issues`);
- **write** to attach each child under the parent through GitHub's native
  sub-issue endpoint
  (`POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues`), which
  installation tokens gate behind `Issues: write`;
- **read** for the idempotency that keeps a crash from duplicating work. GitHub
  issues have no `external_id` field, so Scruffy embeds a hidden marker comment in
  every issue body and **lists** the repository's Scruffy-labelled issues to find
  it again. If the process dies between GitHub creating an issue and Scruffy
  storing its number, the retry re-reads that list, recognises the marker, and
  updates the existing issue instead of opening a second one. (The list endpoint
  is used deliberately rather than the search API, whose index lags a write by up
  to minutes — exactly the window a crash-resume lands in.)

Without `Issues: write` the nightly gate still reviews and still posts its check,
but every issue effect fails: it is retried, then dead-lettered with an explicit
reason, and the nightly check reports that the work graph **could not be
published**. Nothing is silently dropped and nothing claims success it did not
have — but no human gets a tracked work item, which defeats the point of the
nightly loop.

Scruffy never closes an issue on a human's behalf, never auto-merges a fix PR, and
never changes branch protection. Issues it creates are advisory work items; a
human retains merge and dismissal authority.

Note the **development** adapter (`SCRUFFY_SCM_WRITER=gh-cli`, a developer's own
`gh` session) deliberately **refuses** issue writes rather than performing them
under a human identity: issue publication requires
`SCRUFFY_SCM_WRITER=github-app`.

### Event subscriptions

Under **Subscribe to events**, check **only**:

- **Pull request**

That single subscription delivers the `opened`, `synchronize`, `reopened`, and
`ready_for_review` actions the poison path triggers on. Do not subscribe to
other events for this test (no `push`, no `check_run`, no merge-group).

### Installation scope

- **Where can this GitHub App be installed?** — **Only on this account** is
  sufficient for the first test.

Create the App.

## 2. Generate and store the private key

On the App's page, under **Private keys**, click **Generate a private key**.
GitHub downloads a `.pem` file **once**.

- Store the `.pem` **outside this repository** — a secret store, or a path like
  `~/.secrets/scruffy-app.pem` with `chmod 600`. Never commit it, never place it
  under the repo working tree.
- If you must pass the key inline (e.g. a container secret), keep the PEM's
  newlines; the config loader also accepts literal `\n` escapes and restores
  them.

## 3. Find the App ID and installation ID

- **App ID**: shown on the App's settings page ("App ID: …"). This is
  `SCRUFFY_GH_APP_ID`.
- **Install the App**: from the App page → **Install App** → choose the account
  → **Only select repositories** → select **`esbenwiberg/scruffy`** (and only
  it for the first test) → **Install**.
- **Installation ID**: after installing, the browser URL is
  `https://github.com/settings/installations/<INSTALLATION_ID>`. The trailing
  number is `SCRUFFY_GH_APP_INSTALLATION_ID`. (You can also read it back later
  with the doctor in step 5.)

## 4. Configure the environment

Set these in the environment where the server runs — never in a committed file:

```bash
export SCRUFFY_GH_APP_ID=<app id>
export SCRUFFY_GH_APP_INSTALLATION_ID=<installation id>
export SCRUFFY_GH_APP_PRIVATE_KEY_FILE=~/.secrets/scruffy-app.pem  # or SCRUFFY_GH_APP_PRIVATE_KEY with the inline PEM
export SCRUFFY_WEBHOOK_SECRET=<the webhook secret from step 1>

# App-only operation — no gh login, no GH_TOKEN needed:
export SCRUFFY_SCM_READER=github-app
export SCRUFFY_SCM_WRITER=github-app
```

### Nightly schedule (optional, off by default)

`SCRUFFY_NIGHTLY_CADENCE_MS` is the only switch. Unset, the server runs no
schedule at all and nightly reviews come from the manual `scruffy:nightly`
command. Set, the server reviews **every repository in the App installation**, at
each repository's **resolved default branch head**:

```bash
export SCRUFFY_NIGHTLY_CADENCE_MS=86400000   # once per repository per 24h
export SCRUFFY_NIGHTLY_TICK_MS=300000        # optional: poll the schedule (default 5min)
export SCRUFFY_NIGHTLY_LEASE_MS=1800000      # optional: attempt lease (default 30min)
export SCRUFFY_NIGHTLY_BATCH_SIZE=20         # optional: repositories per tick (default 20)
export SCRUFFY_NIGHTLY_OWNER=scruffy-prod-1  # optional: recorded lease owner (default pid)
```

- The **installation is the repository list**. A repository nobody installed the
  App on is never scheduled, and uninstalling stops new work for it.
- The **default branch comes from GitHub** per repository, never from `main` as a
  constant, so `master`/`develop`/`trunk` repositories work unchanged.
- The cadence is **per repository/branch**, not a wall-clock hour: a repository is
  owed a review once its last attempt is a cadence old. `TICK_MS` only decides how
  promptly an owed repository is picked up, so it must be shorter than the cadence
  (the server refuses to start otherwise).
- The schedule requires `SCRUFFY_SCM_READER=github-app`. With the `gh-cli` reader
  there is no installation to enumerate, so a configured cadence **fails startup**
  rather than quietly reviewing nothing every night.
- Each attempt takes a **lease** on the repository/branch, so overlapping ticks and
  a second process cannot double-review or double-file. A crashed attempt becomes
  owed again as soon as its lease expires — it does not wait for the next cadence
  window.

Startup states the resolved schedule, e.g.:

```
scruffy listening on :8080 (reader: github-app, writer: github-app, model: none, reconcile every 10000ms, nightly cadence 86400000ms, polled every 300000ms, 20 repos/tick)
```

With no cadence configured it says `nightly schedule: off (manual scruffy:nightly
only)`.

With both backends set to `github-app`, the server reads diffs and writes the
check-run entirely through the App installation. `gh` and `GH_TOKEN` are **not**
required. (Leaving either unset keeps the default `gh-cli` shadow mode, which is
unchanged.)

`SCRUFFY_GH_APP_PRIVATE_KEY_FILE` wins if both it and the inline key are set.

## 5. Preflight: database, startup, health, and doctor

```bash
npm install
npm run db:up            # start Postgres (docker compose) and wait for it
npm run db:migrate       # apply migrations

# Read-only App preflight — authenticates as the installation and lists the
# repositories in scope WITHOUT any write. Expect to see only esbenwiberg/scruffy.
npm run app:doctor
```

`app:doctor` fails loudly (non-zero exit, clear message) if a credential is
missing or malformed, if authentication fails, or if the installation cannot be
read. A healthy run prints the App id, installation id, and the repository list
— confirm `esbenwiberg/scruffy` appears and nothing unexpected does.

Then boot the server:

```bash
npm run serve            # listens on :8080 (PORT overrides)
```

Startup logs the resolved backends, e.g.:

```
scruffy listening on :8080 (reader: github-app, writer: github-app, reconcile every 10000ms)
```

Confirm both say `github-app`. Health check (through your public URL or locally):

```bash
curl -fsS http://localhost:8080/healthz     # {"ok":true} — probes the DB
```

Make sure your public endpoint forwards HTTPS traffic to this port so GitHub can
reach `https://<your-endpoint>/webhook`.

## 6. Trigger the first review

On `esbenwiberg/scruffy`, do any one of these to emit a `pull_request` event:

- **opened** — open a new PR;
- **synchronize** — push a new commit to an existing PR's head;
- **reopened** — reopen a closed PR;
- **ready_for_review** — mark a draft PR ready.

Each delivers a `pull_request` webhook. Scruffy verifies the signature, durably
records the run, acks `202`, reads the diff through the App, runs the
deterministic poison analysis, and upserts the `scruffy/poison` check-run.

## 7. Verify the delivery and the check-run

- **Webhook deliveries**: App settings → **Advanced** → **Recent Deliveries**.
  The delivery should show a `2xx` response (`202` for an accepted `pull_request`
  action, `200` for an ignored action). A `401` means the webhook secret does
  not match `SCRUFFY_WEBHOOK_SECRET`; a non-2xx delivery can be **Redelivered**
  from this page once fixed.
- **The check-run**: on the PR's **Checks** tab (and the status line at the
  bottom of the PR), a native **`scruffy/poison`** check-run appears with a
  conclusion — `success` (allow), `failure` (block), or `neutral` (abstained).
  Because it is **not** a required check, it never blocks the merge; it only
  reports Scruffy's honest outcome. This is the intended shadow behavior.

If the check-run does not appear, check the server log and the delivery response,
then redeliver.

## 8. Rollback / uninstall

Scruffy makes no destructive changes, so rollback is clean:

- **Stop reviewing**: stop the server. No further check-runs are posted.
- **Revert to shadow gh-cli mode**: unset `SCRUFFY_SCM_READER` /
  `SCRUFFY_SCM_WRITER` (or set them back to `gh-cli`) — the default developer-
  session shadow path, unchanged.
- **Remove the App from the repo**: the installation's **Configure** page →
  deselect `esbenwiberg/scruffy` (or **Uninstall** the App entirely). Once GitHub
  reports the App uninstalled, no more deliveries arrive.
- **Rotate secrets if needed**: delete the private key from the App page and the
  webhook secret; generate fresh ones for the next attempt.
- Any `scruffy/poison` check-runs already posted are advisory and can be left in
  place; they never gated a merge.

Historical runs remain in Scruffy's Postgres as audit records.

## Reminder

Keep `scruffy/poison` **non-required** for the entire shadow experiment. Making
it authoritative is a later, deliberate step taken only after the shadow
evidence meets the product thresholds — not part of this first test.
