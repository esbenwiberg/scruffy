# Azure persistent shadow deployment

## Status and authority

This runbook deploys Scruffy as a persistent, **shadow-only** GitHub App service.
The deployment has a stable public HTTPS endpoint, one always-on Container App,
and a private PostgreSQL Flexible Server. It does not make any Scruffy check
required, publish releases, deploy application artifacts, or run repository-
controlled code. The hosted nightly scheduler runs daily over the App
installation; a shorter cadence may be used only during a controlled live test.
A real Foundry backend and the hosted OIDC release protocol are now configurable,
but neither is enabled or live-verified merely by merging the code.

The initial repository is `esbenwiberg/capsule`. Install the GitHub App only on
that repository until the outward webhook and check-run path has been observed.

## Azure shape

The deployment creates tagged `scruffy-shadow-*` resources in the existing
`ewi-sandboxes` resource group in Sweden Central. This shared resource-group
placement reflects the operator's current Azure scope; Scruffy's resources remain
independently named and tagged for inventory and cleanup. They include:

- a VNet with dedicated Container Apps and PostgreSQL subnets;
- a private PostgreSQL Flexible Server and `scruffy` database;
- an Azure Container Apps environment with Log Analytics;
- one externally reachable Container App with one minimum and maximum replica;
- a dedicated user-assigned identity for Key Vault access plus the existing
  pull-only `autopod-sandbox-acr-pull` identity for ACR access;
- a Key Vault holding the database URL, GitHub App private key, webhook secret,
  and PostgreSQL administrator password.

The image is built by the existing `ewiautopodacr` registry and tagged with the
full Git commit SHA. The shared sandbox pull identity already has only `AcrPull`
on that registry; Scruffy's dedicated identity reads only its Key Vault secrets.
PostgreSQL has no public endpoint. The App private key and database credential
are never copied into the image or committed to the repository.

PostgreSQL and the always-on replica incur continuing Azure cost. The one-replica
floor is deliberate: Scruffy acknowledges a webhook after durable ingestion and
continues reconciliation in the background. Scaling to zero could leave accepted
work dormant until another HTTP request happened to wake the service.

## 1. Create and install the GitHub App

The webhook URL is not known until Azure has deployed. During initial GitHub App
creation, leave **Webhook → Active** unchecked. It can be enabled afterward.

Use the permissions and event subscription from
[`github-app-setup.md`](github-app-setup.md):

- Checks: read and write
- Contents: read and write
- Pull requests: read and write
- Issues: read and write
- Metadata: read-only
- Subscribe only to **Pull request**

Generate a private key and store it outside the repository, for example:

```bash
mkdir -p ~/.secrets
mv ~/Downloads/*.private-key.pem ~/.secrets/scruffy-shadow.pem
chmod 600 ~/.secrets/scruffy-shadow.pem
```

Install the App on **only** `esbenwiberg/capsule`. Record the numeric App ID and
installation ID. The installation ID is the final number in
`https://github.com/settings/installations/<id>`.

## 2. Prepare deployment secrets

Generate a webhook HMAC secret and retain it in the current shell until the
Azure deployment completes and the same value has been pasted into GitHub:

```bash
export SCRUFFY_WEBHOOK_SECRET="$(openssl rand -hex 32)"
export SCRUFFY_GH_APP_ID='<numeric app id>'
export SCRUFFY_GH_APP_INSTALLATION_ID='<numeric installation id>'
export SCRUFFY_GH_APP_PRIVATE_KEY_FILE="$HOME/.secrets/scruffy-shadow.pem"
```

Do not place these values in a repository `.env` file. The deployment script
writes a permission-restricted temporary ARM parameter file and removes it on
exit. Secure Bicep parameters flow into Key Vault secrets.

The script generates a URL-safe PostgreSQL password on the first deployment. On
later deployments it reuses the value from Key Vault. To provide a controlled
value instead, set `SCRUFFY_DB_ADMIN_PASSWORD` to at least 16 characters from
`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, or `-`.

## 3. Validate and deploy

The signed-in identity needs permission to deploy resources in `ewi-sandboxes`.
Activate an eligible Azure Contributor or Owner role first when the current
identity does not hold those actions. The deployment reuses the sandbox's
existing pull-only ACR identity and creates no role assignment.

Compile and inspect the Azure change set:

```bash
./scripts/deploy-azure-shadow.sh plan
```

Deploy after the plan is acceptable:

```bash
./scripts/deploy-azure-shadow.sh deploy
```

The deployment performs these steps in order:

1. validates the Bicep template and verifies the target resource group;
2. verifies the GitHub App installation through the read-only App doctor;
3. builds `ewiautopodacr.azurecr.io/scruffy:<full-git-sha>` remotely in ACR;
4. provisions the private platform and managed identity;
5. attaches the existing pull-only ACR identity and Scruffy's secret-reading
   identity to the Container App;
6. deploys the Container App with Key Vault references;
7. waits for `GET /healthz` to return `{"ok":true}`;
8. prints the stable health and webhook URLs.

Defaults can be overridden without editing the template:

```bash
export AZURE_LOCATION=swedencentral
export AZURE_RESOURCE_GROUP=ewi-sandboxes
export AZURE_ACR_RESOURCE_GROUP=ewi-sandboxes
export AZURE_ACR_NAME=ewiautopodacr
export AZURE_ACR_PULL_IDENTITY=autopod-sandbox-acr-pull
export SCRUFFY_POSTGRES_SKU=Standard_B1ms
export SCRUFFY_NIGHTLY_CADENCE_MS=86400000
export SCRUFFY_NIGHTLY_TICK_MS=300000
```

### Optional real-model and hosted-release configuration

These settings consume an **existing**, separately approved Foundry resource and
Claude deployment in `ewi-sandboxes`; the deployment script does not purchase a
Marketplace offer or create a model deployment:

```bash
export SCRUFFY_MODEL_BACKEND=azure
export AZURE_FOUNDRY_RESOURCE='<existing-foundry-resource>'
export AZURE_FOUNDRY_DEPLOYMENT='<existing-claude-deployment>'

export SCRUFFY_RELEASE_OIDC_AUDIENCE='scruffy-release'
export SCRUFFY_RELEASE_OIDC_REPOSITORY='owner/disposable-repository'
export SCRUFFY_RELEASE_OIDC_REPOSITORY_ID='<numeric-repository-id>'
export SCRUFFY_RELEASE_OIDC_WORKFLOW_REF='owner/control/.github/workflows/release.yml@<full-40-character-commit-sha>'
export SCRUFFY_RELEASE_TARGET_ENVIRONMENT='shadow-production'
export SCRUFFY_RELEASE_APPROVAL_ENVIRONMENT='scruffy-production-signoff'
```

The Container App's dedicated identity receives `Cognitive Services User` on
that same-resource-group Foundry account and requests Entra tokens for
`https://ai.azure.com/.default`. No Foundry API key is created or stored. The
GitHub App separately needs `Actions: read` to retrieve workflow-run approval
history. Both RBAC and App permission changes are human gates.

## 4. Enable and verify the webhook

The deployment prints an endpoint shaped like:

```text
https://scruffy-shadow.<environment-id>.swedencentral.azurecontainerapps.io/webhook
```

Open the GitHub App settings and configure:

- **Active:** checked
- **Webhook URL:** the exact printed `/webhook` URL
- **Secret:** the exact `SCRUFFY_WEBHOOK_SECRET` used during deployment

Save the App settings. Open a harmless pull request in `esbenwiberg/capsule` or
push a commit to one. In the App's **Advanced → Recent Deliveries**, verify that
the pull-request delivery receives `202`. On the PR, verify that the native
`scruffy/poison` check appears.

Keep `scruffy/poison` non-required. A `401` delivery means the GitHub and Azure
webhook secrets differ. A missing check with a `202` delivery should be diagnosed
from Container App logs and the persisted outbox rather than by redelivering
repeatedly.

## First live evidence — 2026-07-31

The first outward shadow run completed against
[`esbenwiberg/capsule#1`](https://github.com/esbenwiberg/capsule/pull/1):

- GitHub delivered `pull_request/synchronize` for candidate
  `669d0680505a6d10f0791b47b66dd00b6c368222`;
- the webhook returned `202` without redelivery;
- the durable hosted path published native check `scruffy/poison`;
- the check completed `success` for the harmless documentation-only change;
- the deployment health endpoint returned `{"ok":true}`;
- the check remained non-required and the smoke PR was not merged.

This proves the first App-authenticated GitHub read and outward check-run path. It
does not establish accuracy, authority, nightly live behavior, or release
publication safety.

## First live nightly lifecycle — 2026-07-31

The hosted scheduler was temporarily configured with a two-minute cadence and a
30-second poll over the two-repository App installation. The complete lifecycle
was exercised in
[`esbenwiberg/esbenwiberg-scruffy-todo-lab`](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab):

1. A clean baseline at `988876cf61a11c5f1f8ab7e391e4a1a401c7fe9f`
   produced neutral `scruffy/nightly`, complete coverage, no issues, and no fix
   PR.
2. Controlled mutation PR
   [#1](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/pull/1)
   added `rejectUnauthorized: false`. Repository CI passed while
   `scruffy/poison` correctly failed. The non-required poison result was
   deliberately overridden only in this disposable lab.
3. Nightly reviewed immutable range `988876c..a867b7e`, reported complete
   coverage, and created parent issue
   [#2](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/issues/2),
   native child issue
   [#3](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/issues/3),
   and ready fix PR
   [#4](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/pull/4).
4. The deterministic patch changed only `rejectUnauthorized: false` to `true`.
   `ci/build`, `ci/test`, and `scruffy/poison` all passed on exact fix head
   `dd6a74735d177fc83057eb11c5b6da5809e3e7cd`.
5. Scruffy stopped at the human boundary. After a human merged the fix, Scruffy
   verified the corrected text at post-merge head
   `bfc41c62e6bd26cfb670c30cc8811951dfe8ceba`, marked the finding resolved, and
   closed both child and parent issues.
6. The Azure schedule was restored to a 24-hour cadence with a five-minute poll.

This earns evidence for one controlled deterministic nightly remediation loop.
It does not prove model remediation, broad accuracy, or authority to auto-merge.

## First live release presentation — 2026-07-31

The manual release entry point exercised two immutable candidates through the
real App reader/writer and candidate-CI lane:

- Clean range `988876c..9063186` produced report
  `rr_bd9644003006ef4a23c6e2a9b7b5fe3073d3a18df2f7989329f12c6ba45d7c6d`
  with outcome `ship`. Required source analysis and `ci/build` plus `ci/test`
  were complete. The advisory GitHub check is
  [Release gate: ship (clean)](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/runs/91142281876).
- Controlled candidate `c39c314163509603a572124780daa4c8f47d6912`
  reintroduced disabled TLS verification. CI passed, deterministic source
  analysis confirmed one sign-off-class finding, and report
  `rr_66b2f5684ce27800278347953dddeb948a49af983cfb60da3d49d02d38aef332`
  produced `sign-off-required`. The advisory GitHub check is
  [Release gate: sign-off required](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/runs/91142485679).

Both checks were derived from their persisted reports and passed the command's
report/check congruence assertion. They remained neutral and non-required.

A subsequent local report run explicitly selected the authenticated
`claude-cli` backend over the same immutable risky range. It produced report
`rr_3ca2faefa34409f0dea788b97d9b164955680e861ecc884e00392d139bbf744c`
and updated the same idempotent native check. The model lane was complete and
retained one citation-anchored security risk. The report and GitHub summary made
its scenario, affected surface, blast radius, impact, detectability,
reversibility, rollback, uncertainty, and citations visible. They also displayed
the exact SHA/report-bound human-responsibility statement and recorded open PR
[#5](https://github.com/esbenwiberg/esbenwiberg-scruffy-todo-lab/pull/5) only as
context-only backlog metadata. There were no open `bug`-labelled issues.

That check-on-PR-head presentation was a disposable experiment and is now
superseded. Check run `91142485679` was reduced to a concise superseded notice.
Full release analysis belongs after merge and artifact creation in CD. The
CD-native command emits its report to the deployment job summary and routing
outputs and creates no commit status or check, keeping PRs lean. Disposable PR
#5 was then closed without merge and its branch deleted.

That run used an isolated local report database, so it honestly recorded that no
durable nightly reports were available there; it did not pretend the separate
Azure nightly database was empty. Local code now implements full-envelope report
v2, hosted OIDC report retrieval, durable mandatory-rationale attestations,
actual reviewer lookup, terminal shadow authorization, and keyless Foundry
configuration. Remaining evidence gaps are deployment of those paths, one real
hosted model report, cross-database elimination in a live workflow, administrator-
bypass removal, two disposable OIDC terminal runs, controlled publication, and
visual/deployment evidence.

## Operations

Check health:

```bash
curl -fsS "$(az containerapp show -g ewi-sandboxes -n scruffy-shadow --query properties.configuration.ingress.fqdn -o tsv | sed 's#^#https://#')/healthz"
```

Follow logs:

```bash
az containerapp logs show -g ewi-sandboxes -n scruffy-shadow --follow
```

Show revisions:

```bash
az containerapp revision list -g ewi-sandboxes -n scruffy-shadow -o table
```

Deploy a later commit by exporting the same GitHub values and rerunning:

```bash
./scripts/deploy-azure-shadow.sh plan
./scripts/deploy-azure-shadow.sh deploy
```

The image tag changes with the Git SHA. Migrations run idempotently at startup
under a PostgreSQL advisory lock. The Container App remains single-revision and
single-replica during shadow evaluation. The normal nightly cadence is 24 hours;
the poll interval is five minutes. A controlled test may temporarily deploy a
two-minute cadence and 30-second poll, then must restore the daily values.

## Rollback and removal

A failed new revision can be inspected and replaced by redeploying a known Git
commit. Removing the GitHub App from `capsule` stops new enrolled work without
deleting Azure audit state.

The deployment shares `ewi-sandboxes` with unrelated infrastructure. **Never
delete that resource group to remove Scruffy.** Scruffy's top-level resources are
tagged `deployment=scruffy-shadow`; inspect that inventory before any explicit,
ordered cleanup:

```bash
az resource list -g ewi-sandboxes --tag deployment=scruffy-shadow -o table
```

Removing those resources permanently removes the service, database, logs, and
Key Vault. Do not remove them when historical Scruffy state must be retained.
